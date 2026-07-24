import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const [attachmentsSource, chatRouteSource, emitterSource, loopSource] = await Promise.all([
  readFile(join(root, 'src/lib/attachments.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/SSEEmitter.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
])

assert.match(
  attachmentsSource,
  /attachments\.some\(\(attachment\) => !attachment\.id\?\.trim\(\)\)[\s\S]*ATTACHMENT_NOT_PERSISTED/,
  'inline/no-id attachments must be rejected instead of bypassing canonical storage',
)
assert.match(
  attachmentsSource,
  /getAttachmentForUser\(userId, attachmentId\)[\s\S]*AttachmentReferenceError\(\[attachmentId\]\)/,
  'persisted attachment ids must be resolved under the authenticated owner',
)
assert.match(
  chatRouteSource,
  /assertMessageAttachmentAccessForUser\(safeRawMessages, userId\)/,
  'attachment validation must cover the complete request before conversation persistence or queueing',
)
assert.match(
  loopSource,
  /this\.emitter = sanitizeAgentEventEmitter\(emitter\)/,
  'every AgentLoop tool event path must pass through the sanitizer boundary',
)
assert.match(
  emitterSource,
  /toolStart\(id, name, args\)[\s\S]*sanitizeToolStartArgs\(name, args\)[\s\S]*toolResult\(id, name, result\)[\s\S]*sanitizeToolResultForEvent\(name, result\)/,
  'the emitter wrapper must sanitize direct and recovery tool events',
)

const workDir = await mkdtemp(join(root, 'scripts/.agent-security-boundary-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  sanitizeToolEventValue,
  sanitizeToolResultForEvent,
  sanitizeToolStartArgs,
} from ${JSON.stringify(join(root, 'src/lib/agent/toolEventSanitizer.ts'))}
import { isNonIdempotentToolCall } from ${JSON.stringify(join(root, 'src/lib/agent/toolSafety.ts'))}

const secrets = [
  'correct-horse-battery-staple',
  'private@example.com',
  'signed-secret-value',
  'session-cookie-value',
  'opaque-access-token',
  'typed-sequence-secret',
  'Bearer-secret-value',
]

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

function assertNoSecrets(value: unknown, label: string): void {
  const output = serialized(value)
  for (const secret of secrets) {
    assert.equal(output.includes(secret), false, label + ' leaked ' + secret)
  }
}

const httpStart = sanitizeToolStartArgs('http_request', {
  method: 'POST',
  url: 'https://api.example.test/token?X-Amz-Signature=signed-secret-value&view=compact',
  headers: {
    Authorization: 'Bearer Bearer-secret-value',
    Cookie: 'session=session-cookie-value',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ password: 'correct-horse-battery-staple' }),
})
assert.equal(httpStart.method, 'POST')
assert.equal(Number(httpStart.bodyCharCount) > 0, true)
assert.deepEqual(httpStart.headerNames, ['Authorization', 'Cookie', 'Content-Type'])
assertNoSecrets(httpStart, 'HTTP tool start')

const replayedHttpStart = sanitizeToolStartArgs('http_request', httpStart)
assert.equal(replayedHttpStart.method, 'POST')
assert.equal(isNonIdempotentToolCall('http_request', replayedHttpStart), true)
assertNoSecrets(replayedHttpStart, 'replayed HTTP tool start')

const browserStart = sanitizeToolStartArgs('browser_fill_form', {
  fields: [
    { index: 1, label: 'Email', value: 'private@example.com' },
    { index: 2, label: 'Password', value: 'correct-horse-battery-staple' },
  ],
  submit: true,
})
assert.equal(browserStart.submit, true)
assert.equal((browserStart.fields as Array<Record<string, unknown>>)[0].valueCharCount, 'private@example.com'.length)
assertNoSecrets(browserStart, 'browser form start')
assertNoSecrets(sanitizeToolStartArgs('browser_fill_form', browserStart), 'replayed browser form start')

const browserSequence = sanitizeToolStartArgs('browser_action_sequence', {
  actions: [
    { action: 'type', args: { index: 1, text: 'typed-sequence-secret' } },
    { action: 'select', args: { selector: '[value="private@example.com"]', value: 'private@example.com' } },
  ],
})
assert.equal((browserSequence.actions as Array<Record<string, unknown>>)[0].textCharCount, 'typed-sequence-secret'.length)
assert.equal((browserSequence.actions as Array<Record<string, unknown>>)[1].selectorPresent, true)
assertNoSecrets(browserSequence, 'browser action sequence')

const navigateStart = sanitizeToolStartArgs('browser_navigate', {
  url: 'https://example.test/preview?sig=signed-secret-value',
  previewBuild: true,
})
const replayedNavigateStart = sanitizeToolStartArgs('browser_navigate', navigateStart)
assert.equal(replayedNavigateStart.previewBuild, true)
assert.equal(isNonIdempotentToolCall('browser_navigate', replayedNavigateStart), true)
assertNoSecrets(replayedNavigateStart, 'replayed browser navigation')

const httpResult = sanitizeToolResultForEvent('http_request', {
  status: 200,
  statusText: 'OK',
  headers: {
    'content-type': 'application/json',
    'set-cookie': 'session=session-cookie-value; HttpOnly',
    authorization: 'Bearer Bearer-secret-value',
  },
  body: JSON.stringify({ access_token: 'opaque-access-token' }),
  durationMs: 20,
}) as Record<string, unknown>
assert.equal('body' in httpResult, false)
assert.equal('headers' in httpResult, false)
assert.equal(Number(httpResult.bodyCharCount) > 0, true)
assertNoSecrets(httpResult, 'HTTP result')
assertNoSecrets(sanitizeToolResultForEvent('http_request', httpResult), 'replayed HTTP result')

const browserResult = sanitizeToolResultForEvent('browser_fill_form', {
  success: false,
  recoverable: true,
  url: 'https://checkout.example.test/confirm?token=opaque-access-token',
  title: 'Checkout',
  action: 'Failed form fill',
  error: 'password=correct-horse-battery-staple',
  content: 'Email private@example.com and the complete private page DOM',
  targetHints: [{ label: 'private@example.com' }],
  screenshotBase64: 'private-image-payload',
}) as Record<string, unknown>
assert.equal('content' in browserResult, false)
assert.equal('targetHints' in browserResult, false)
assert.equal('screenshotBase64' in browserResult, false)
assert.equal(Number(browserResult.contentCharCount) > 0, true)
assertNoSecrets(browserResult, 'browser result')

const genericResult = sanitizeToolEventValue({
  response: {
    headers: {
      Authorization: 'Bearer Bearer-secret-value',
      'Set-Cookie': 'session=session-cookie-value',
    },
    body: '{"access_token":"opaque-access-token"}',
    links: ['https://example.test/download?Signature=signed-secret-value'],
  },
  form: {
    fields: [{ label: 'Email', value: 'private@example.com' }],
  },
  account: { password: 'correct-horse-battery-staple', displayName: 'Safe name' },
})
assert.equal((genericResult as any).form.fields[0].value, '[REDACTED]')
assert.equal((genericResult as any).account.displayName, 'Safe name')
assertNoSecrets(genericResult, 'deep generic result')

const circular: Record<string, unknown> = { safe: true }
circular.self = circular
assert.equal((sanitizeToolEventValue(circular) as Record<string, unknown>).self, '[CIRCULAR]')
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('agent security boundary smoke passed')
