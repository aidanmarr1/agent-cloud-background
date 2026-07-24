import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const [loopSource, pipelineSource] = await Promise.all([
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
])

const streamingCase = loopSource.slice(
  loopSource.indexOf("case 'STREAMING':"),
  loopSource.indexOf("case 'EXECUTING_TOOLS':"),
)
assert.ok(
  streamingCase.indexOf('decidePaidModelTurnProgress(') < streamingCase.indexOf('state.iterations++'),
  'the no-progress decision must run before another paid model iteration starts',
)
assert.ok(
  streamingCase.indexOf('state.iterations++') < streamingCase.indexOf('this.callLLMWithRetry('),
  'the guarded iteration must remain the only path to another model call',
)
assert.match(
  streamingCase,
  /A cadence violation is only possible when the turn supplied no[\s\S]*executable tool call[\s\S]*if \(lastStreamResult\.cadenceProgressViolation\)/,
  'display narration must never turn a valid tool call into a paid no-progress retry',
)
assert.match(
  loopSource,
  /lastToolResults = await toolPipeline\.executeAll\([\s\S]*currentPaidTurnProgress\.acceptedToolCall \|\|= lastToolResults\.some\([\s\S]*acceptedForExecution === true/,
  'AgentLoop must use ToolPipeline admission rather than syntactic tool-call presence',
)
assert.doesNotMatch(
  loopSource,
  /acceptedAsyncNarrationSequence|acceptedProgressUpdate/,
  'asynchronous display narration must never clear concrete-action no-progress debt',
)
assert.match(
  loopSource,
  /const actionInstruction = compactResearchEvidenceComplete\(state\)[\s\S]*This phase still needs evidence[\s\S]*Make one concrete native research tool call now[\s\S]*Do not write progress prose, a final answer, or <next_step\/>/,
  'compact research must not invite a text-only phase advance while runtime evidence still requires a tool action',
)
assert.match(
  pipelineSource,
  /const actionLabelReason[\s\S]*return preflightResult\(errorResult\)/,
  'display-contract blocks must remain preflight results',
)
assert.match(
  loopSource,
  /const malformedToolResults = lastToolResults\.filter\(isMalformedToolArgumentsRecovery\)[\s\S]*currentPaidTurnProgress\.internalRecoveryScheduled = 'malformed_tool_arguments'/,
  'malformed streamed arguments must mark their explicit retry before re-entering the paid model loop',
)
assert.match(
  loopSource,
  /lastToolResults\.every\(isDisplayContractRepairResult\)[\s\S]{0,260}internalRecoveryScheduled = 'display_contract'/,
  'display and plan-step preflight repairs must mark their explicit retry before re-entering the paid model loop',
)

const workDir = await mkdtemp(join(root, 'scripts/.paid-model-turn-progress-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}
import {
  decidePaidModelTurnProgress,
  paidModelTurnMadeProgress,
  type PaidModelTurnProgressSnapshot,
} from ${JSON.stringify(join(root, 'src/lib/agent/PaidModelTurnProgress.ts'))}

const emptyTurn: PaidModelTurnProgressSnapshot = {
  iteration: 1,
  stepIdxBefore: 0,
  visibleText: false,
  acceptedToolCall: false,
}

const firstEmpty = decidePaidModelTurnProgress(emptyTurn, 0, 0)
assert.deepEqual(firstEmpty, {
  kind: 'allow_recovery',
  consecutiveNoProgressTurns: 1,
  consecutiveInternalRecoveryTurns: 0,
})
let paidCalls = 2 // initial empty call plus the one allowed recovery call
const secondEmpty = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 2 },
  0,
  firstEmpty.consecutiveNoProgressTurns,
  firstEmpty.consecutiveInternalRecoveryTurns,
)
assert.deepEqual(secondEmpty, {
  kind: 'stop',
  consecutiveNoProgressTurns: 1,
  consecutiveInternalRecoveryTurns: 0,
  reason: 'generic_no_progress',
})
if (secondEmpty.kind !== 'stop') paidCalls += 1
assert.equal(paidCalls, 2, 'a second empty result must stop before a third paid model call')

// Exact regression for run 47e9c42c-136c-4d51-9c1d-8545e498a0f9:
// turn 1 scheduled malformed web_search JSON repair, turn 2 scheduled a
// display/plan_step preflight repair. Neither is generic unexplained
// no-progress, so the corrected third action turn must be admitted.
const malformedRecovery = decidePaidModelTurnProgress(
  { ...emptyTurn, internalRecoveryScheduled: 'malformed_tool_arguments' },
  0,
  0,
  0,
)
assert.deepEqual(malformedRecovery, {
  kind: 'allow_internal_recovery',
  consecutiveNoProgressTurns: 0,
  consecutiveInternalRecoveryTurns: 1,
})
const displayRecovery = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 2, internalRecoveryScheduled: 'display_contract' },
  0,
  malformedRecovery.consecutiveNoProgressTurns,
  malformedRecovery.consecutiveInternalRecoveryTurns,
)
assert.deepEqual(displayRecovery, {
  kind: 'allow_internal_recovery',
  consecutiveNoProgressTurns: 0,
  consecutiveInternalRecoveryTurns: 2,
})
const correctedThirdTurn = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 3, acceptedToolCall: true },
  0,
  displayRecovery.consecutiveNoProgressTurns,
  displayRecovery.consecutiveInternalRecoveryTurns,
)
assert.deepEqual(correctedThirdTurn, {
  kind: 'progress',
  consecutiveNoProgressTurns: 0,
  consecutiveInternalRecoveryTurns: 0,
})
const thirdInternalRepair = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 3, internalRecoveryScheduled: 'malformed_tool_arguments' },
  0,
  displayRecovery.consecutiveNoProgressTurns,
  displayRecovery.consecutiveInternalRecoveryTurns,
)
assert.deepEqual(thirdInternalRepair, {
  kind: 'stop',
  consecutiveNoProgressTurns: 0,
  consecutiveInternalRecoveryTurns: 2,
  reason: 'internal_recovery_cap',
}, 'a third consecutive internal repair must stop rather than loop indefinitely')

assert.equal(paidModelTurnMadeProgress({ ...emptyTurn, visibleText: true }, 0), true, 'visible narration is progress')
assert.equal(
  paidModelTurnMadeProgress({ ...emptyTurn, visibleText: true, acceptedToolCall: true }, 0),
  true,
  'same-turn narration plus an admitted tool is one progressing turn',
)
assert.equal(paidModelTurnMadeProgress({ ...emptyTurn, acceptedToolCall: true }, 0), true, 'an admitted tool is progress')
assert.equal(paidModelTurnMadeProgress(emptyTurn, 1), true, 'an accepted step transition is progress')
assert.equal(paidModelTurnMadeProgress({ ...emptyTurn, terminalAction: true }, 0), true, 'a terminal action is progress')
assert.equal(paidModelTurnMadeProgress(emptyTurn, 0), false, 'a malformed or blocked call without admission is not progress')

// A visible narration-only turn is real user-visible progress and resets any
// earlier recovery debt. The next malformed native call gets the normal single
// recovery opportunity instead of terminating immediately.
const visibleNarration = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 3, visibleText: true },
  0,
  firstEmpty.consecutiveNoProgressTurns,
)
assert.deepEqual(visibleNarration, {
  kind: 'progress',
  consecutiveNoProgressTurns: 0,
  consecutiveInternalRecoveryTurns: 0,
})
const malformedAfterNarration = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 5 },
  0,
  visibleNarration.consecutiveNoProgressTurns,
  visibleNarration.consecutiveInternalRecoveryTurns,
)

// A sidecar is display-only. Even if it emits between these two snapshots, the
// next cached/empty action turn must retain the existing no-progress debt.
const emptyAfterAsynchronousNarration = decidePaidModelTurnProgress(
  { ...emptyTurn, iteration: 7 },
  0,
  firstEmpty.consecutiveNoProgressTurns,
  firstEmpty.consecutiveInternalRecoveryTurns,
)
assert.deepEqual(emptyAfterAsynchronousNarration, {
  kind: 'stop',
  consecutiveNoProgressTurns: 1,
  consecutiveInternalRecoveryTurns: 0,
  reason: 'generic_no_progress',
}, 'one accepted narration must not permit an infinite narration-only loop')
assert.deepEqual(
  malformedAfterNarration,
  {
    kind: 'allow_recovery',
    consecutiveNoProgressTurns: 1,
    consecutiveInternalRecoveryTurns: 0,
  },
  'a malformed recovery after visible narration must not immediately hit the paid-turn cap',
)

const timeouts = {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function makeEmitter() {
  return {
    toolStart() {}, toolResult() {}, terminalOutput() {}, artifactCreated() {},
    fileContentStart() {}, fileContentDelta() {}, flush: async () => {},
  }
}

async function execute(
  pipeline: ToolPipeline,
  state: ReturnType<typeof createInitialState>,
  id: string,
  name: string,
  rawArguments: string,
) {
  const results = await pipeline.executeAll(new Map([[0, { id, name, arguments: rawArguments }]]), state)
  assert.equal(results.length, 1)
  return results[0]
}

const conversationId = \`paid-model-turn-progress-\${Date.now()}\`
const state = createInitialState(false, timeouts)
state.currentPlanItems = ['Inspect the workspace file']
state.currentStepIdx = 0
const pipeline = new ToolPipeline(makeEmitter() as any, conversationId)

try {
  const malformed = await execute(pipeline, state, 'malformed', 'web_search', '{"query":')
  assert.equal(Boolean(malformed.acceptedForExecution), false, 'malformed arguments must not count as an admitted tool')

  const displayContractRepaired = await execute(pipeline, state, 'wrong-step', 'read_file', JSON.stringify({
    path: 'missing.txt',
    action_label: 'Inspect missing workspace file',
    plan_step_index: 2,
  }))
  assert.equal(displayContractRepaired.acceptedForExecution, true, 'a valid current action must not fail merely because the model supplied a stale visible step index')
  assert.equal(JSON.parse(displayContractRepaired.tc.arguments).plan_step_index, 1, 'the stale visible step index must be normalized to the active step')

  const admittedError = await execute(pipeline, state, 'handler-error', 'read_file', JSON.stringify({
    path: 'missing.txt',
    action_label: 'Inspect missing workspace file',
    plan_step_index: 1,
  }))
  assert.equal(admittedError.acceptedForExecution, true, 'a valid handler call must count even when its result is an error')
} finally {
  await rm(getSandboxDirPath(conversationId), { recursive: true, force: true })
}
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
  console.log('paid model turn progress smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
