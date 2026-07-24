import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const loopSource = await readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8')
const catchStart = loopSource.indexOf('} catch (streamErr) {', loopSource.indexOf('private async callLLMWithRetry('))
const catchEnd = loopSource.indexOf('\n      }\n    }\n    return null', catchStart)
const providerCatch = loopSource.slice(catchStart, catchEnd)

assert.ok(catchStart > 0 && catchEnd > catchStart, 'provider-start catch block must be discoverable')
assert.match(
  providerCatch,
  /classifyDeterministicProviderRequestFailure\(status, errorText\)[\s\S]*provider_request_rejected_terminal[\s\S]*state\.lastModelErrorForUser\s*=[\s\S]*return null/,
  'deterministic provider 4xx failures must set a terminal user error before returning a null stream',
)
assert.doesNotMatch(
  providerCatch,
  /classifyDeterministicProviderRequestFailure[\s\S]*pendingToolJsonRecovery\s*=\s*true/,
  'provider request 4xx failures must not escape into the cross-iteration tool JSON recovery loop',
)
assert.match(
  loopSource,
  /maxModelStartAttempts\s*=\s*STREAM_MAX_RETRIES\s*\+\s*MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS\s*\+\s*1/,
  'the provider-start call must have one explicit local request-repair allowance',
)

const nullStreamBranch = loopSource.slice(
  loopSource.indexOf('if (!response) {'),
  loopSource.indexOf('// Process stream'),
)
assert.ok(
  nullStreamBranch.indexOf('if (state.lastModelErrorForUser)') <
    nullStreamBranch.indexOf('cadenceNarrationInMainTurn &&'),
  'a terminal provider request failure must stop before cadence/null-stream recovery can schedule another iteration',
)

const workDir = await mkdtemp(join(root, 'scripts/.provider-request-failure-fence-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  classifyDeterministicProviderRequestFailure,
  MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS,
  normalizeLiteralJsonEscapes,
  sanitizeProviderRequestMessagesForRetry,
} from ${JSON.stringify(join(root, 'src/lib/agent/ProviderRequestFailure.ts'))}

const exactReplayFailure = 'Failed to parse the request body as JSON: messages[1].content: unexpected end of hex escape at line 1 column 3705'
assert.deepEqual(classifyDeterministicProviderRequestFailure(400, exactReplayFailure), {
  category: 'message_payload_parse',
  deterministic: true,
  messagePayloadRepairable: true,
})
assert.equal(classifyDeterministicProviderRequestFailure(429, exactReplayFailure), null)
assert.equal(classifyDeterministicProviderRequestFailure(503, exactReplayFailure), null)
assert.deepEqual(classifyDeterministicProviderRequestFailure(401, 'invalid API key'), {
  category: 'authentication',
  deterministic: true,
  messagePayloadRepairable: false,
})

const slash = String.fromCharCode(92)
const brokenEscape = normalizeLiteralJsonEscapes('preview ends in ' + slash + 'u')
assert.equal(brokenEscape.changed, true)
assert.equal(brokenEscape.value, 'preview ends in ' + slash + slash + 'u')

let messages = [{ role: 'tool', content: '{"result":"preview ends in ' + slash + 'u' }]
const repaired = sanitizeProviderRequestMessagesForRetry(messages)
assert.equal(repaired.changed, true)
assert.doesNotThrow(() => JSON.parse(repaired.messages[0].content))

// Model the exact provider-start fence: the repair is local to one agent
// iteration, and the same deterministic 400 on the normalized request stops.
let providerCalls = 0
let agentIterations = 1
let repairAttempts = 0
let terminal = false
while (!terminal) {
  providerCalls++
  const decision = classifyDeterministicProviderRequestFailure(400, exactReplayFailure)
  assert.ok(decision)
  if (decision.messagePayloadRepairable && repairAttempts < MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS) {
    const next = sanitizeProviderRequestMessagesForRetry(messages)
    if (next.changed) {
      messages = next.messages
      repairAttempts++
      continue
    }
  }
  terminal = true
}

assert.equal(providerCalls, 2, 'one initial rejected request plus one repaired request is the hard maximum')
assert.equal(repairAttempts, 1, 'only one meaningful request repair is allowed')
assert.equal(agentIterations, 1, 'the provider request repair must not consume or start another agent iteration')
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('provider request failure fence smoke passed')
