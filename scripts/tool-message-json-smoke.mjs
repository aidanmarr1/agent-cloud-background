import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.tool-message-json-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { ContextManager } from ${JSON.stringify(join(root, 'src/lib/agent/ContextManager.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}
import {
  compactToolMessageContent,
  ensureJsonToolMessageContent,
  serializeToolMessageContent,
  unicodeSafeSlice,
} from ${JSON.stringify(join(root, 'src/lib/agent/ToolMessageSerialization.ts'))}

function assertJsonContent(content: unknown, maxChars: number, label: string) {
  assert.equal(typeof content, 'string', label + ' must emit string content')
  assert.ok(content.length <= maxChars, label + ' exceeded the model content cap')
  assert.doesNotThrow(() => JSON.parse(content), label + ' must be one complete JSON value')
}

const emoji = '😀'
const oneCodeUnit = unicodeSafeSlice(emoji + 'after', 1)
assert.equal(oneCodeUnit, '', 'a slice must not leave the high half of a surrogate pair')
assert.equal(unicodeSafeSlice(emoji + 'after', 2), emoji)

// Reproduce the paid replay class: serialized source results well beyond the
// 1,800-character boundary, with quotes, backslashes, control escapes, emoji,
// and an unpaired surrogate located around potential cut points.
const pathological = {
  source: 'https://example.com/official',
  content: ('facts "quoted" C:\\\\temp\\\\u12 ' + String.fromCharCode(1) + ' ' + emoji + ' ').repeat(220),
  loneHighSurrogate: '\\ud83d',
}
const serialized = serializeToolMessageContent(pathological, {
  maxChars: 1800,
  truncated: true,
  note: 'Result compacted to the model context limit.',
})
assertJsonContent(serialized, 1800, 'generic oversized result')
const sanitizedLoneSurrogate = JSON.parse(serializeToolMessageContent(
  { loneHighSurrogate: '\\ud83d' },
  { maxChars: 1800 },
))
assert.equal(sanitizedLoneSurrogate.loneHighSurrogate, '\\ufffd', 'lone surrogates must be sanitized before emission')

for (let maxChars = 96; maxChars <= 360; maxChars++) {
  const boundary = serializeToolMessageContent({
    value: 'x'.repeat(maxChars) + String.fromCharCode(2) + '\\\\u12' + emoji,
  }, { maxChars, truncated: true, note: 'boundary regression' })
  assertJsonContent(boundary, maxChars, 'boundary ' + maxChars)
}

const legacyBroken = JSON.stringify(pathological).slice(0, 1800) + '...[truncated]'
assert.throws(() => JSON.parse(legacyBroken), 'fixture must reproduce the old malformed raw slice')
assertJsonContent(
  compactToolMessageContent(legacyBroken, 900, 'Legacy result repaired.'),
  900,
  'legacy malformed result repair',
)
const legitimateHistorical = JSON.stringify({ ok: true, content: 'unchanged' })
assert.equal(
  ensureJsonToolMessageContent(legitimateHistorical),
  legitimateHistorical,
  'provider defense must leave legitimate historical JSON byte-for-byte unchanged',
)
assertJsonContent(
  ensureJsonToolMessageContent(legacyBroken),
  1800,
  'provider-boundary historical repair',
)

const pipeline = new ToolPipeline({} as never, undefined)
const cases = [
  { name: 'read_document', result: pathological },
  { name: 'browser_get_content', result: { success: true, url: 'https://example.com', content: pathological.content } },
  { name: 'execute_command', result: { exitCode: 0, stdout: pathological.content, stderr: '' } },
  { name: 'web_search', result: Array.from({ length: 8 }, (_, index) => ({ title: 'Result ' + index, url: 'https://example.com/' + index, snippet: pathological.content.slice(0, 900) })) },
]

for (const [index, entry] of cases.entries()) {
  const messages = pipeline.buildToolResultMessages([{
    tc: { id: 'tool-' + index, name: entry.name, arguments: '{}' },
    result: entry.result,
    isError: false,
  }])
  assert.equal(messages.length, 1, entry.name + ' should emit one tool message')
  assert.equal(messages[0].role, 'tool')
  assertJsonContent(messages[0].content, 1800, entry.name)
}

for (const exactLength of [6184, 6324]) {
  const emptyEnvelopeLength = JSON.stringify({ content: '' }).length
  const exactReplayShape = { content: 'x'.repeat(exactLength - emptyEnvelopeLength) }
  assert.equal(JSON.stringify(exactReplayShape).length, exactLength)
  const oldReplaySlice = JSON.stringify(exactReplayShape).slice(0, 1800) + '...[truncated]'
  assert.throws(() => JSON.parse(oldReplaySlice), 'the paid replay fixture must reproduce malformed raw slicing')

  const [message] = pipeline.buildToolResultMessages([{
    tc: { id: 'paid-replay-' + exactLength, name: 'read_document', arguments: '{}' },
    result: exactReplayShape,
    isError: false,
  }])
  assertJsonContent(message.content, 1800, 'paid replay length ' + exactLength)
}

// Context compaction used to re-break a valid tool payload with text.slice().
const context = new ContextManager({ maxMessages: 20 })
context.initialize(
  { role: 'system', content: 'system' },
  [{ role: 'user', content: 'task' }, { role: 'user', content: 'context' }],
)
context.push({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'context-tool', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ url: 'https://example.com', action_label: 'Read source', plan_step_index: 1 }) } }],
})
context.push({ role: 'tool', tool_call_id: 'context-tool', content: JSON.stringify(pathological) })
context.compactForModelCall({} as never)
const compactedTool = context.getMessages().find(message => message.role === 'tool')
assert.ok(compactedTool)
assertJsonContent(compactedTool!.content, 900, 'context-compacted tool result')

console.log(JSON.stringify({
  ok: true,
  branches: cases.map(entry => entry.name),
  boundaryCapsChecked: 265,
  paidReplayLengthsChecked: [6184, 6324],
  contextCompactionJsonSafe: true,
}))
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
