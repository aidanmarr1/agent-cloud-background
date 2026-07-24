import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const agentLoopSource = await readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8')

assert.match(
  agentLoopSource,
  /acceptedSiblingResults[\s\S]*buildToolResultMessages\(acceptedSiblingResults, state\)/,
  'malformed recovery must preserve valid sibling results in provider history',
)
assert.match(
  agentLoopSource,
  /toolJsonRecoveryCount \+= 1[\s\S]*toolJsonRecoveryCount === 1[\s\S]*suppressedResearchToolName/,
  'malformed recovery must allow only one same-route repair before forcing another route',
)
assert.doesNotMatch(
  agentLoopSource.match(/if \(malformedToolResults\.length > 0\)[\s\S]*?if \(lastToolResults\.length > 0 && lastToolResults\.every\(isDisplayContractRepairResult\)\)/)?.[0] || '',
  /recentTool(?:Calls|Sequence) = \[\]/,
  'malformed recovery must retain loop memory instead of erasing repetition evidence',
)
assert.match(
  agentLoopSource,
  /acceptedToolCall \|\|=[\s\S]*result\.acceptedForExecution === true && result\.cached !== true/,
  'cached duplicates must not reset the paid-turn no-progress fence',
)

const workDir = await mkdtemp(join(root, 'scripts/.malformed-tool-stream-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { StreamProcessor } from ${JSON.stringify(join(root, 'src/lib/agent/StreamProcessor.ts'))}
import { ToolCache } from ${JSON.stringify(join(root, 'src/lib/agent/ToolCache.ts'))}
import {
  ToolPipeline,
  repairTruncatedFlatToolArguments,
} from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}

const query = 'AI agent latency official sources'
const recoverable = '{"action_label":"Check official latency facts","plan_step_index":1,"query":"' + query + '"'
const repaired = repairTruncatedFlatToolArguments('web_search', recoverable)
assert.ok(repaired, 'a flat web_search object missing only its final brace should be recoverable')
assert.deepEqual(JSON.parse(repaired!), {
  action_label: 'Check official latency facts',
  plan_step_index: 1,
  query,
})
assert.equal(
  repairTruncatedFlatToolArguments('web_search', '{"query":"' + query + '"'),
  JSON.stringify({ query }),
  'display-only fields may be filled later from deterministic runtime state',
)
assert.equal(
  repairTruncatedFlatToolArguments('web_search', '{"query":"AI agent latency'),
  null,
  'an unterminated query must remain rejected rather than guessed',
)
assert.equal(
  repairTruncatedFlatToolArguments('web_search', '{"query":"' + query + '","unknown":"value"'),
  null,
  'unknown fields must not be silently accepted by recovery',
)
assert.equal(
  repairTruncatedFlatToolArguments('web_search', '{"query":"first","query":"second"'),
  null,
  'duplicate query fields must remain rejected as ambiguous',
)
assert.equal(
  repairTruncatedFlatToolArguments('web_search', '{"query":"' + query + '",'),
  null,
  'a trailing comma requires guessing and must remain rejected',
)
assert.equal(
  repairTruncatedFlatToolArguments('browser_navigate', '{"url":"https://example.com/report"'),
  null,
  'the narrow repair must not apply to other tools',
)

const source = 'https://example.com/official-latency-report'
const recoverableRead = '{"action_label":"Extract official latency report","plan_step_index":1,"url":"' + source + '"'
const repairedRead = repairTruncatedFlatToolArguments('read_document', recoverableRead, 1)
assert.ok(repairedRead, 'read_document missing only its final brace should be recoverable')
assert.deepEqual(JSON.parse(repairedRead!), {
  action_label: 'Extract official latency report',
  plan_step_index: 1,
  url: source,
})
assert.equal(
  repairTruncatedFlatToolArguments('read_document', '{"action_label":"Extract official latency report","plan_step_index":1,"url":"https://example.com/report', 1),
  null,
  'an unterminated read_document URL must remain rejected rather than guessed',
)
assert.equal(
  repairTruncatedFlatToolArguments('read_document', '{"action_label":"Extract official latency report","plan_step_index":1,"url":"' + source + '","source":"' + source + '"', 1),
  null,
  'read_document legacy aliases outside the native model schema must remain rejected',
)
assert.equal(
  repairTruncatedFlatToolArguments('read_document', '{"action_label":"Extract official latency report","plan_step_index":1,"url":"first","url":"second"', 1),
  null,
  'duplicate read_document URL fields must remain rejected as ambiguous',
)
assert.equal(
  repairTruncatedFlatToolArguments('read_document', '{"plan_step_index":1,"url":"' + source + '"', 1),
  null,
  'read_document recovery requires a strict visible action envelope',
)
assert.equal(
  repairTruncatedFlatToolArguments('read_document', recoverableRead, 2),
  null,
  'read_document recovery must not cross the active plan-step boundary',
)

function makeEmitter() {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    textDelta(content: string) { events.push({ type: 'text_delta', content }) },
    progressUpdate(content: string) { events.push({ type: 'progress_update', content }) },
    reasoningDelta() {}, reasoningDone() {},
    toolStart(id: string, name: string, args: Record<string, unknown>) { events.push({ type: 'tool_start', id, name, args }) },
    toolResult(id: string, name: string, result: unknown) { events.push({ type: 'tool_result', id, name, result }) },
    terminalOutput() {}, fileContentStart() {}, fileContentDelta() {}, plan() {},
    artifactCreated() {}, stepAdvance() {}, done() {}, error() {}, close() {},
    get isClosed() { return false },
  }
}

async function* stableDelayedChunks() {
  yield { choices: [{ delta: { tool_calls: [{
    index: 0,
    id: 'stable-delayed-search',
    function: {
      name: 'web_search',
      arguments: '{\\"action_label\\":\\"Check official latency facts\\",\\"plan_step_index\\":1,\\"query\\":\\"',
    },
  }] } }] }
  await new Promise(resolve => setTimeout(resolve, 90))
  yield { choices: [{ delta: { tool_calls: [{
    index: 0,
    function: { arguments: query + '\\"' },
  }] } }] }
  yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.0001 } }
}

async function* hiddenDelayedChunks() {
  yield { choices: [{ delta: { tool_calls: [{
    index: 0,
    id: 'hidden-delayed-search',
    function: { name: 'web_search', arguments: '{\\"query\\":\\"' },
  }] } }] }
  await new Promise(resolve => setTimeout(resolve, 90))
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: query + '\\"' } }] } }] }
}

async function* stableDelayedReadChunks() {
  yield { choices: [{ delta: { tool_calls: [{
    index: 0,
    id: 'stable-delayed-read',
    function: {
      name: 'read_document',
      arguments: '{\\"action_label\\":\\"Extract official latency report\\",\\"plan_step_index\\":1,\\"url\\":\\"',
    },
  }] } }] }
  await new Promise(resolve => setTimeout(resolve, 90))
  yield { choices: [{ delta: { tool_calls: [{
    index: 0,
    function: { arguments: source + '\\"' },
  }] } }] }
}

async function* validAndMalformedReadChunks() {
  yield { choices: [{ delta: { tool_calls: [
    {
      index: 0,
      id: 'cached-valid-sibling',
      function: {
        name: 'read_document',
        arguments: JSON.stringify({
          action_label: 'Extract cached official report',
          plan_step_index: 1,
          url: source,
        }),
      },
    },
    {
      index: 1,
      id: 'malformed-sibling',
      function: {
        name: 'read_document',
        arguments: '{\\"action_label\\":\\"Extract broken report\\",\\"plan_step_index\\":1,\\"url\\":\\"https://broken.example.com/report',
      },
    },
  ] } }] }
}

const shortTimeouts = {
  iterationTimeoutMs: 45,
  inactivityTimeoutMs: 35,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 10,
}

const stableEmitter = makeEmitter()
const stableState = createInitialState(false, shortTimeouts)
stableState.currentPlanItems = ['Gather official latency evidence']
stableState.currentStepIdx = 0
const stableResult = await new StreamProcessor(stableEmitter as any, shortTimeouts)
  .processStream(stableDelayedChunks() as any, stableState)
assert.equal(stableResult.timedOut, false, 'a valid display/step envelope should protect a short provider pause')
assert.equal(stableResult.toolCalls.get(0)?.arguments, recoverable)
assert.equal(
  repairTruncatedFlatToolArguments('web_search', stableResult.toolCalls.get(0)?.arguments || ''),
  repaired,
  'the post-pause call should reach the conservative missing-brace repair intact',
)

const hiddenEmitter = makeEmitter()
const hiddenState = createInitialState(false, shortTimeouts)
hiddenState.currentPlanItems = ['Gather official latency evidence']
hiddenState.currentStepIdx = 0
const hiddenStartedAt = Date.now()
const hiddenResult = await new StreamProcessor(hiddenEmitter as any, shortTimeouts)
  .processStream(hiddenDelayedChunks() as any, hiddenState)
assert.equal(hiddenResult.timedOut, true, 'an incomplete hidden prefix must still fail forward promptly')
assert.ok(Date.now() - hiddenStartedAt < 85, 'the stable-envelope window must not protect an unlabelled partial call')
assert.equal(
  repairTruncatedFlatToolArguments('web_search', hiddenResult.toolCalls.get(0)?.arguments || ''),
  null,
  'the truncated hidden query must remain rejected',
)

const stableReadEmitter = makeEmitter()
const stableReadState = createInitialState(false, shortTimeouts)
stableReadState.currentPlanItems = ['Gather official latency evidence']
stableReadState.currentStepIdx = 0
const stableReadResult = await new StreamProcessor(stableReadEmitter as any, shortTimeouts)
  .processStream(stableDelayedReadChunks() as any, stableReadState)
assert.equal(stableReadResult.timedOut, false, 'a valid read_document display/step envelope should protect a short provider pause')
assert.equal(stableReadResult.toolCalls.get(0)?.arguments, recoverableRead)
assert.equal(
  repairTruncatedFlatToolArguments('read_document', stableReadResult.toolCalls.get(0)?.arguments || '', 1),
  repairedRead,
  'the delayed read_document call should reach the conservative missing-brace repair intact',
)

const pipelineEmitter = makeEmitter()
const pipelineState = createInitialState(false, {
  ...shortTimeouts,
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
})
pipelineState.taskStrategy = 'research'
pipelineState.currentPhase = 'research'
pipelineState.currentPlanItems = ['Gather official latency evidence', 'Write final answer']
pipelineState.currentStepIdx = 0
pipelineState.stepSearchQueries.add(query.toLowerCase())
const pipeline = new ToolPipeline(pipelineEmitter as any, 'malformed-tool-stream-smoke')
const [pipelineResult] = await pipeline.executeAll(new Map([[0, {
  id: 'repair-integration',
  name: 'web_search',
  arguments: recoverable,
}]]), pipelineState)
assert.equal(pipelineResult?.internalRecovery, undefined, 'a conservatively repaired object must enter normal preflight')
assert.deepEqual(JSON.parse(pipelineResult!.tc.arguments), JSON.parse(repaired!))
assert.match(
  JSON.stringify(pipelineResult?.result || {}),
  /no opened or extracted source pages yet/i,
  'the repaired call must continue through ordinary research preflight rather than malformed recovery',
)

const readPipelineEmitter = makeEmitter()
const readPipelineState = createInitialState(false, {
  ...shortTimeouts,
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
})
readPipelineState.taskStrategy = 'research'
readPipelineState.currentPhase = 'research'
readPipelineState.currentPlanItems = ['Gather official latency evidence', 'Write final answer']
readPipelineState.currentStepIdx = 0
readPipelineState.stepVisitedUrls.add(source)
const readPipeline = new ToolPipeline(readPipelineEmitter as any, 'malformed-read-stream-smoke')
const [readPipelineResult] = await readPipeline.executeAll(new Map([[0, {
  id: 'read-repair-integration',
  name: 'read_document',
  arguments: recoverableRead,
}]]), readPipelineState)
assert.equal(readPipelineResult?.internalRecovery, undefined, 'a conservatively repaired read_document object must enter normal preflight')
assert.deepEqual(JSON.parse(readPipelineResult!.tc.arguments), JSON.parse(repairedRead!))
assert.match(
  JSON.stringify(readPipelineResult?.result || {}),
  /already read in this phase/i,
  'the repaired read_document call must continue through duplicate-source safety instead of malformed recovery',
)

const mixedEmitter = makeEmitter()
const mixedState = createInitialState(false, {
  ...shortTimeouts,
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
})
mixedState.taskStrategy = 'research'
mixedState.currentPhase = 'research'
mixedState.currentPlanItems = ['Gather official latency evidence', 'Write final answer']
mixedState.currentStepIdx = 0
mixedState.stepVisitedUrls.add(source)
const mixedStream = await new StreamProcessor(mixedEmitter as any, shortTimeouts).processStream(
  validAndMalformedReadChunks() as any,
  mixedState,
  false,
  undefined,
  { allowParallelSourceExtractionCalls: true, maxParallelSourceExtractionCalls: 3 },
)
assert.equal(mixedStream.toolCalls.size, 2, 'safe source-only parallel calls must survive stream assembly')

const validArgs = {
  action_label: 'Extract cached official report',
  plan_step_index: 1,
  url: source,
}
const cache = new ToolCache()
cache.set('read_document', validArgs, {
  title: 'Official latency report',
  url: source,
  text: 'The official report contains credible latency evidence.',
})
const mixedPipeline = new ToolPipeline(mixedEmitter as any, 'mixed-malformed-stream-smoke', { cache })
const mixedResults = await mixedPipeline.executeAll(mixedStream.toolCalls, mixedState)
assert.equal(mixedResults.length, 2)
assert.equal(mixedResults[0]?.acceptedForExecution, true, 'the well-formed sibling must remain admitted')
assert.equal(mixedResults[0]?.cached, true, 'the repeated valid sibling should resolve from cache')
assert.equal(
  mixedResults[1]?.internalRecovery,
  'malformed_tool_arguments',
  'the incomplete sibling must be rejected without guessing its source',
)
assert.equal(
  mixedState.stepResearchCallCount,
  0,
  'a cached duplicate must not inflate research progress or conceal the loop',
)
assert.ok(
  mixedState.recentToolCalls.some(call => call.name === 'read_document'),
  'the valid sibling must remain in recent loop memory',
)

console.log('malformed tool stream smoke checks passed')
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['@sparticuz/chromium', 'playwright'],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
