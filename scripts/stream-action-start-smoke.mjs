import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.stream-action-start-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { StreamProcessor } from ${JSON.stringify(join(root, 'src/lib/agent/StreamProcessor.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { acceptProgressNarration, beginNarrationCadenceAttempt } from ${JSON.stringify(join(root, 'src/lib/agent/NarrationMemory.ts'))}

const timeouts = {
  iterationTimeoutMs: 30000,
  inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function makeEmitter() {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    textDelta(content: string) { events.push({ type: 'text_delta', content }) },
    progressUpdate(content: string) { events.push({ type: 'progress_update', content }) },
    reasoningDelta(content: string) { events.push({ type: 'reasoning_delta', content }) },
    reasoningDone() { events.push({ type: 'reasoning_done' }) },
    toolStart(id: string, name: string, args: Record<string, unknown>) { events.push({ type: 'tool_start', id, name, args }) },
    toolResult(id: string, name: string, result: unknown) { events.push({ type: 'tool_result', id, name, result }) },
    terminalOutput() {},
    fileContentStart(id: string, path: string, toolName?: string) { events.push({ type: 'file_content_start', id, path, toolName }) },
    fileContentDelta(id: string, content: string) { events.push({ type: 'file_content_delta', id, content }) },
    plan() {},
    artifactCreated() {},
    stepAdvance() {},
    done() {},
    error() {},
    close() {},
    get isClosed() { return false },
  }
}

async function* chunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_file', function: { name: 'create_file', arguments: '{\\"action_label\\":\\"Write Next page component\\",\\"plan_step_index\\":1,\\"path\\":\\"app/page.tsx\\",\\"content\\":\\"' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'export default function Page() {\\\\n' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '  return <main>Hello</main>\\\\n' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}\\\"}' } }] } }] }
}

async function* bufferedFinalReportChunks(gate: Promise<void>) {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_final_report', function: { name: 'create_file', arguments: '{\\"action_label\\":\\"Write final research report\\",\\"plan_step_index\\":2,\\"path\\":\\"deliverables/final-report.md\\",\\"content\\":\\"# Final report\\\\n\\\\nThe evidence from three independent sources now supports the opening conclusion and makes this preview visibly live.\\\\n' } }] } }] }
  await gate
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'The final comparison remains thorough and evidence-led.\\\"}' } }] } }] }
}

async function* failedBufferedFinalReportChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_failed_final_report', function: { name: 'create_file', arguments: '{\\"action_label\\":\\"Write interrupted final report\\",\\"plan_step_index\\":2,\\"path\\":\\"deliverables/interrupted-report.md\\",\\"content\\":\\"# Interrupted report\\\\n\\\\nThis substantial opening is visible before the simulated provider failure interrupts the write.\\\\n' } }] } }] }
  throw new Error('simulated provider stream failure')
}

async function* editChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_edit', function: { name: 'edit_file', arguments: '{\\"action_label\\":\\"Replace app page headline copy\\",\\"plan_step_index\\":1,\\"path\\":\\"app/page.tsx\\",\\"old_string\\":\\"Hello\\",\\"new_string\\":\\"' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Updated copy\\\\n' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'with another line\\\"}' } }] } }] }
}

async function* wrongStepFileChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_wrong_step', function: { name: 'create_file', arguments: '{\\"action_label\\":\\"Write final report draft\\",\\"plan_step_index\\":1,\\"path\\":\\"deliverables/report.md\\",\\"content\\":\\"' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '# Report\\\\n\\\\nThis stale-step write should not be visible.\\\"}' } }] } }] }
}

async function* missingDisplaySearchChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_search', function: { name: 'web_search', arguments: '{\\"query\\":\\"AI agent startup latency benchmark 2026\\"}' } }] } }] }
}

async function* slowHiddenSearchChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_slow_search', function: { name: 'web_search', arguments: '{\\"query\\":\\"' } }] } }] }
  await new Promise(resolve => setTimeout(resolve, 90))
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'AI agent startup latency benchmark 2026\\"}' } }] } }] }
}

async function* iterationCappedToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_iteration_capped_search', function: { name: 'web_search', arguments: '{\\"action_label\\":\\"Search Manus AI company background\\",\\"plan_step_index\\":1,\\"query\\":\\"' } }] } }] }
  await new Promise(resolve => setTimeout(resolve, 80))
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Manus AI company background capabilities' } }] } }] }
}

async function* longTextThenUsageChunks() {
  yield { choices: [{ delta: { content: 'x'.repeat(500) } }] }
  yield { choices: [{ delta: { content: 'x'.repeat(500) } }] }
  yield { choices: [{ delta: { content: 'this overflow should be drained but not emitted' } }] }
  yield {
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      cost: 0.00012,
    },
  }
}

async function* overflowThenMixedToolChunk() {
  yield { choices: [{ delta: { content: 'n'.repeat(1000) } }] }
  yield { choices: [{ delta: {
    content: 'this overflow stays hidden',
    tool_calls: [{
      index: 0,
      id: 'call_after_overflow',
      function: {
        name: 'web_search',
        arguments: '{"action_label":"Verify narration overflow recovery","plan_step_index":1,"query":"narration overflow recovery"}',
      },
    }],
  } }] }
}

async function* futureActionFragmentThenStallChunks() {
  yield { choices: [{ delta: { content: 'Read the ' } }] }
  yield { choices: [{ delta: { content: 'Anthropic engineering blog; it likely contains implementation details' } }] }
  await new Promise(resolve => setTimeout(resolve, 90))
}

async function* speculativeUnreadSourceChunks() {
  yield { choices: [{ delta: { content: 'The Anthropic engineering ' } }] }
  yield { choices: [{ delta: { content: 'blog likely contains implementation details about agent orchestration and fast tool dispatch.' } }] }
}

async function* completedSourceResultChunks() {
  yield { choices: [{ delta: { content: 'The Anthropic engineering ' } }] }
  yield { choices: [{ delta: { content: 'blog reports that its agent runtime uses parallel tool dispatch to reduce user-visible latency.' } }] }
}

async function* validCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_valid_cadence', function: { name: 'web_search', arguments: '{"progress_update":"The official benchmark reports a 2.1-second median agent startup, establishing a concrete latency baseline.","action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark"}' } }] } }] }
}

async function* cadenceToolUpsertChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cadence_upsert', function: { name: 'web_search', arguments: '{"progress_update":"The official benchmark reports a 2.1-second median agent startup, establishing a concrete latency baseline.","action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark"' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"count":5}' } }] } }] }
}

async function* invalidCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_invalid_cadence', function: { name: 'web_search', arguments: '{"progress_update":"Search for official Meta or Microsoft agent throughput benchmarks.","action_label":"Find agent throughput benchmarks","plan_step_index":1,"query":"official agent throughput benchmarks"}' } }] } }] }
}

async function* missingCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_missing_cadence', function: { name: 'web_search', arguments: '{"action_label":"Find agent throughput benchmarks","plan_step_index":1,"query":"official agent throughput benchmarks"}' } }] } }] }
}

async function* emptyCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_empty_cadence', function: { name: 'web_search', arguments: '{"progress_update":"","action_label":"Find agent throughput benchmarks","plan_step_index":1,"query":"official agent throughput benchmarks"}' } }] } }] }
}

async function* cadenceProseOnlyChunks() {
  yield { choices: [{ delta: { content: 'The official benchmark reports a 2.1-second median agent startup.' } }] }
}

async function* leakedBenchmarkCommandChunks() {
  yield { choices: [{ delta: { content: ' search for official Meta or Microsoft agent throughput benchmarks.' } }] }
}

async function* ordinaryAndSchemaCadenceChunks() {
  yield { choices: [{ delta: { content: 'The official benchmark reports a 2.1-second median agent startup.' } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ordinary_cadence', function: { name: 'web_search', arguments: '{"progress_update":"The official benchmark reports a 95th-percentile startup under five seconds, establishing a second latency bound.","action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark"}' } }] } }] }
}

async function* schemaThenOrdinaryCadenceChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_schema_first', function: { name: 'web_search', arguments: '{"progress_update":"The official benchmark reports a 2.1-second median agent startup, establishing a concrete latency baseline.","action_label":"' } }] } }] }
  yield { choices: [{ delta: { content: 'A second provider narration must not be shown.' } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark"}' } }] } }] }
}

async function* parallelSourceChunks() {
  yield { choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_source_0', function: { name: 'read_document', arguments: '{"action_label":"Read official source one","plan_step_index":1,"url":"https://one.example/report"}' } },
    { index: 2, id: 'call_source_2', function: { name: 'read_document', arguments: '{"action_label":"Read official source three","plan_step_index":1,"url":"https://three.example/report"}' } },
  ] } }] }
  yield { choices: [{ delta: { tool_calls: [
    { index: 1, id: 'call_source_1', function: { name: 'http_request', arguments: '{"action_label":"Read official source two","plan_step_index":1,"method":"GET","url":"https://two.example/data"}' } },
    { index: 3, id: 'call_source_3', function: { name: 'read_document', arguments: '{"action_label":"Read capped source four","plan_step_index":1,"url":"https://four.example/report"}' } },
  ] } }] }
}

async function* mixedParallelToolChunks() {
  yield { choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_safe_primary', function: { name: 'read_document', arguments: '{"action_label":"Read retained source","plan_step_index":1,"url":"https://safe.example/report"}' } },
    { index: 1, id: 'call_unsafe_secondary', function: { name: 'create_file', arguments: '{"action_label":"Write unsafe secondary","plan_step_index":1,"path":"unsafe.md","content":"must not run"}' } },
    { index: 2, id: 'call_safe_secondary', function: { name: 'http_request', arguments: '{"action_label":"Read discarded source","plan_step_index":1,"method":"GET","url":"https://discarded.example/data"}' } },
  ] } }] }
}

export async function runSmoke() {
  const emitter = makeEmitter()
  const state = createInitialState(true, timeouts)
  state.currentPlanItems = ['Write code']
  state.currentStepIdx = 0
  const processor = new StreamProcessor(emitter as any, timeouts)
  const result = await processor.processStream(chunks() as any, state)

  assert.equal(result.toolCalls.size, 1)
  const firstToolStart = emitter.events.findIndex(e => e.type === 'tool_start')
  const firstFileStart = emitter.events.findIndex(e => e.type === 'file_content_start')
  const firstFileDelta = emitter.events.findIndex(e => e.type === 'file_content_delta')
  assert.ok(firstToolStart >= 0, 'file-write tool_start must stream as soon as the strict action label and path are available')
  assert.ok(firstFileStart >= 0, 'file_content_start must stream as soon as the target file path is available')
  assert.ok(firstToolStart < firstFileDelta, 'visible file-write pill must appear before file content streams')
  assert.ok(firstFileStart < firstFileDelta, 'file preview must be initialized before file content deltas stream')

  const starts = emitter.events.filter(e => e.type === 'tool_start')
  assert.equal(starts.length, 1, 'stream parser must create one stable provisional visible file-write pill')
  assert.equal((starts[0].args as any).action_label, 'Write Next page component')
  assert.equal((starts[0].args as any).path, 'app/page.tsx')
  assert.ok(starts.every(e => typeof (e.args as any)?.content !== 'string'), 'tool_start must not carry full file content')
  assert.equal(
    emitter.events
      .filter(e => e.type === 'file_content_delta')
      .map(e => e.content)
      .join(''),
    'export default function Page() {\\n  return <main>Hello</main>\\n}',
    'file content deltas must stream the generated file body incrementally',
  )

  let releaseFinalReport: () => void = () => {}
  const finalReportGate = new Promise<void>(resolve => {
    releaseFinalReport = resolve
  })
  const finalReportEmitter = makeEmitter()
  const finalReportState = createInitialState(true, timeouts)
  finalReportState.currentPlanItems = ['Gather evidence', 'Write final report']
  finalReportState.currentStepIdx = 1
  const finalReportProcessor = new StreamProcessor(finalReportEmitter as any, timeouts)
  finalReportProcessor.beginBufferedEmission()
  let finalReportSettled = false
  const finalReportProcessing = finalReportProcessor
    .processStream(bufferedFinalReportChunks(finalReportGate) as any, finalReportState)
    .finally(() => {
      finalReportSettled = true
    })

  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(finalReportSettled, false, 'the provider stream must still be generating when live file events appear')
  assert.equal(
    finalReportEmitter.events.filter(e => e.type === 'tool_start').length,
    1,
    'a validated final-report write must bypass the model-turn buffer and immediately show its active action',
  )
  assert.equal(
    finalReportEmitter.events.filter(e => e.type === 'file_content_start').length,
    1,
    'the Computer file preview must open before the final report finishes generating',
  )
  assert.match(
    finalReportEmitter.events
      .filter(e => e.type === 'file_content_delta')
      .map(e => e.content)
      .join(''),
    /three independent sources/,
    'the Computer preview must receive report content while tool arguments are still streaming',
  )

  releaseFinalReport()
  await finalReportProcessing
  finalReportProcessor.commitBufferedEmission()

  assert.equal(
    finalReportEmitter.events.filter(e => e.type === 'tool_start').length,
    1,
    'committing the remaining model-turn buffer must not duplicate the live final-report action',
  )
  assert.equal(
    finalReportEmitter.events.filter(e => e.type === 'file_content_start').length,
    1,
    'committing the remaining model-turn buffer must not reopen the same live file preview',
  )
  assert.match(
    finalReportEmitter.events
      .filter(e => e.type === 'file_content_delta')
      .map(e => e.content)
      .join(''),
    /final comparison remains thorough and evidence-led/,
    'the live preview must finish with the complete streamed report body',
  )

  const discardedReportEmitter = makeEmitter()
  const discardedReportState = createInitialState(true, timeouts)
  discardedReportState.currentPlanItems = ['Gather evidence', 'Write final report']
  discardedReportState.currentStepIdx = 1
  const discardedReportProcessor = new StreamProcessor(discardedReportEmitter as any, timeouts)
  discardedReportProcessor.beginBufferedEmission()
  await assert.rejects(
    discardedReportProcessor.processStream(
      failedBufferedFinalReportChunks() as any,
      discardedReportState,
    ),
    /simulated provider stream failure/,
  )
  assert.equal(
    discardedReportEmitter.events.filter(e => e.type === 'tool_start').length,
    1,
    'a current-step file action may be visible before a provider failure',
  )
  assert.equal(
    discardedReportEmitter.events.filter(e => e.type === 'tool_result').length,
    0,
    'the optimistic action remains active until its enclosing buffered turn is discarded',
  )
  discardedReportProcessor.discardBufferedEmission()
  const discardedResults = discardedReportEmitter.events.filter(e => e.type === 'tool_result')
  assert.equal(
    discardedResults.length,
    1,
    'discarding a turn must settle every immediately exposed file action exactly once',
  )
  assert.match(
    String((discardedResults[0].result as any)?.error || ''),
    /^INTERNAL_RECOVERY:/,
    'the discard settlement must use the internal recovery lane',
  )
  discardedReportProcessor.discardBufferedEmission()
  assert.equal(
    discardedReportEmitter.events.filter(e => e.type === 'tool_result').length,
    1,
    'discard cleanup must be idempotent and never duplicate the closing result',
  )

  const searchEmitter = makeEmitter()
  const searchState = createInitialState(false, timeouts)
  searchState.currentPlanItems = ['Gather current evidence']
  searchState.currentStepIdx = 0
  const searchProcessor = new StreamProcessor(searchEmitter as any, timeouts)
  const searchResult = await searchProcessor.processStream(missingDisplaySearchChunks() as any, searchState)
  const searchStarts = searchEmitter.events.filter(e => e.type === 'tool_start')
  assert.equal(searchResult.toolCalls.size, 1, 'tool call without display metadata should still be captured')
  assert.equal(searchStarts.length, 0, 'missing model-authored display metadata must not create a deterministic search pill')

  const blockedSearchEmitter = makeEmitter()
  const blockedSearchState = createInitialState(false, timeouts)
  blockedSearchState.currentPlanItems = ['Read evidence before searching again']
  blockedSearchState.currentStepIdx = 0
  blockedSearchState.taskStrategy = 'research'
  blockedSearchState.currentPhase = 'research'
  blockedSearchState.stepSearchQueries.add('ai agent startup latency benchmark 2026')
  blockedSearchState.stepToolTypeCounts.set('web_search', 1)
  const blockedSearchProcessor = new StreamProcessor(blockedSearchEmitter as any, timeouts)
  await blockedSearchProcessor.processStream(missingDisplaySearchChunks() as any, blockedSearchState)
  assert.equal(blockedSearchEmitter.events.filter(e => e.type === 'tool_start').length, 0, 'searches known to be preflight-blocked must not flash a provisional pill')

  const failedSourceSearchEmitter = makeEmitter()
  const failedSourceSearchState = createInitialState(false, timeouts)
  failedSourceSearchState.currentPlanItems = ['Find extractable evidence']
  failedSourceSearchState.currentStepIdx = 0
  failedSourceSearchState.taskStrategy = 'research'
  failedSourceSearchState.currentPhase = 'research'
  failedSourceSearchState.stepSearchQueries.add('pet bird vegetable nutrition')
  failedSourceSearchState.stepToolTypeCounts.set('web_search', 1)
  failedSourceSearchState.stepFailureCount = 2
  const failedSourceSearchProcessor = new StreamProcessor(failedSourceSearchEmitter as any, timeouts)
  await failedSourceSearchProcessor.processStream(missingDisplaySearchChunks() as any, failedSourceSearchState)
  assert.equal(failedSourceSearchEmitter.events.filter(e => e.type === 'tool_start').length, 0, 'runtime recovery state must not manufacture a label that the model omitted')

  const slowEmitter = makeEmitter()
  const slowState = createInitialState(false, {
    iterationTimeoutMs: 200,
    inactivityTimeoutMs: 35,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 10,
  })
  slowState.currentPlanItems = ['Gather current evidence']
  slowState.currentStepIdx = 0
  const slowProcessor = new StreamProcessor(slowEmitter as any, slowState.tierTimeouts)
  const slowStarted = Date.now()
  const slowResult = await slowProcessor.processStream(slowHiddenSearchChunks() as any, slowState)
  assert.ok(Date.now() - slowStarted < 85, 'hidden tool-argument streaming must not reset visible inactivity forever')
  assert.equal(slowResult.toolCalls.size, 1, 'partial hidden tool call should be returned for policy recovery')
  assert.equal(slowEmitter.events.filter(e => e.type === 'tool_start').length, 0, 'no visible pill should be invented before usable args exist')

  const cappedEmitter = makeEmitter()
  const cappedState = createInitialState(false, {
    iterationTimeoutMs: 45,
    inactivityTimeoutMs: 500,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 10,
  })
  cappedState.currentPlanItems = ['Identify Manus AI company background']
  cappedState.currentStepIdx = 0
  const cappedProcessor = new StreamProcessor(cappedEmitter as any, cappedState.tierTimeouts)
  const cappedResult = await cappedProcessor.processStream(iterationCappedToolChunks() as any, cappedState)
  assert.equal(cappedResult.toolCalls.size, 1, 'iteration-capped tool calls must return partial args for recovery instead of throwing')
  assert.match(
    cappedResult.toolCalls.get(0)?.arguments || '',
    /Search Manus AI company background/,
    'partial streamed tool args must be preserved for malformed-tool recovery',
  )

  const editEmitter = makeEmitter()
  const editState = createInitialState(true, timeouts)
  editState.currentPlanItems = ['Revise code']
  editState.currentStepIdx = 0
  const editProcessor = new StreamProcessor(editEmitter as any, timeouts)
  await editProcessor.processStream(editChunks() as any, editState)

  const editToolStart = editEmitter.events.findIndex(e => e.type === 'tool_start')
  const editFileStart = editEmitter.events.findIndex(e => e.type === 'file_content_start')
  const editFileDelta = editEmitter.events.findIndex(e => e.type === 'file_content_delta')
  assert.ok(editToolStart >= 0, 'edit_file tool_start must stream as soon as the strict action label and path are available')
  assert.ok(editFileStart >= 0, 'edit_file preview must initialize while the replacement text streams')
  assert.ok(editToolStart < editFileDelta, 'visible edit pill must appear before replacement text streams')
  assert.equal(editEmitter.events.filter(e => e.type === 'tool_start').length, 1, 'edit_file replacement streaming must not recreate the action pill as new_string grows')
  assert.equal((editEmitter.events[editFileStart] as any).toolName, 'edit_file')
  assert.equal(
    editEmitter.events
      .filter(e => e.type === 'file_content_delta')
      .map(e => e.content)
      .join(''),
    'Updated copy\\nwith another line',
    'edit_file deltas must stream the replacement text incrementally',
  )

  const wrongStepEmitter = makeEmitter()
  const wrongStepState = createInitialState(true, timeouts)
  wrongStepState.currentPlanItems = ['Research sources', 'Write final report']
  wrongStepState.currentStepIdx = 1
  const wrongStepProcessor = new StreamProcessor(wrongStepEmitter as any, timeouts)
  const wrongStepResult = await wrongStepProcessor.processStream(wrongStepFileChunks() as any, wrongStepState)

  assert.equal(wrongStepResult.toolCalls.size, 1, 'stale-step tool call should still be captured for policy recovery')
  assert.equal(wrongStepEmitter.events.filter(e => e.type === 'tool_start').length, 0, 'stale-step streamed file write must not show a visible action pill')
  assert.equal(wrongStepEmitter.events.filter(e => e.type === 'file_content_start').length, 0, 'stale-step streamed file write must not start a visible file preview')
  assert.equal(wrongStepEmitter.events.filter(e => e.type === 'file_content_delta').length, 0, 'stale-step streamed file write must not leak invisible rejected content')

  const textEmitter = makeEmitter()
  const textState = createInitialState(true, timeouts)
  const textProcessor = new StreamProcessor(textEmitter as any, timeouts)
  const textResult = await textProcessor.processStream(longTextThenUsageChunks() as any, textState)

  assert.deepEqual(textResult.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46, cost: 0.00012 })
  assert.ok(textResult.assistantContent.length > 800, 'text cap should trip after the initial visible content')
  assert.doesNotMatch(textResult.assistantContent, /overflow should be drained/, 'overflow text should not leak after the cap')

  const mixedEmitter = makeEmitter()
  const mixedState = createInitialState(false, timeouts)
  mixedState.currentPlanItems = ['Verify mixed stream parsing']
  mixedState.currentStepIdx = 0
  const mixedProcessor = new StreamProcessor(mixedEmitter as any, timeouts)
  const mixedResult = await mixedProcessor.processStream(overflowThenMixedToolChunk() as any, mixedState)
  assert.equal(mixedResult.toolCalls.size, 1, 'same-chunk tool calls must survive suppressed narration overflow')
  assert.equal(mixedResult.toolCalls.get(0)?.name, 'web_search')
  assert.match(mixedResult.toolCalls.get(0)?.arguments || '', /narration overflow recovery/)
  assert.equal(mixedEmitter.events.filter(e => e.type === 'tool_start').length, 1, 'valid same-chunk tools must still emit their action pill')

  const futureEmitter = makeEmitter()
  const futureState = createInitialState(false, {
    iterationTimeoutMs: 200,
    inactivityTimeoutMs: 35,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 10,
  })
  futureState.currentPlanItems = ['Continue source research']
  futureState.currentStepIdx = 0
  const futureProcessor = new StreamProcessor(futureEmitter as any, futureState.tierTimeouts)
  await assert.rejects(
    futureProcessor.processStream(futureActionFragmentThenStallChunks() as any, futureState),
    error => error instanceof Error && error.name === 'InactivityTimeoutError',
    'a cadence action fragment that stalls must take the normal inactivity recovery path',
  )
  assert.equal(
    futureEmitter.events.filter(e => e.type === 'text_delta').length,
    0,
    'a streamed future action fragment must never leak as completed-result narration before timeout',
  )

  const speculativeEmitter = makeEmitter()
  const speculativeState = createInitialState(false, timeouts)
  speculativeState.currentPlanItems = ['Continue source research']
  speculativeState.currentStepIdx = 0
  const speculativeProcessor = new StreamProcessor(speculativeEmitter as any, timeouts)
  const speculativeResult = await speculativeProcessor.processStream(speculativeUnreadSourceChunks() as any, speculativeState)
  assert.equal(speculativeResult.assistantContent.trim(), '', 'speculation about an unread source must not become assistant narration')
  assert.equal(
    speculativeEmitter.events.filter(e => e.type === 'text_delta').length,
    0,
    'speculative unread-source text must never reach the visible event stream: ' + JSON.stringify(speculativeEmitter.events),
  )

  const completedResultEmitter = makeEmitter()
  const completedResultState = createInitialState(false, timeouts)
  completedResultState.currentPlanItems = ['Continue source research']
  completedResultState.currentStepIdx = 0
  const completedResultProcessor = new StreamProcessor(completedResultEmitter as any, timeouts)
  const completedResult = await completedResultProcessor.processStream(completedSourceResultChunks() as any, completedResultState)
  assert.match(completedResult.assistantContent, /blog reports that its agent runtime uses parallel tool dispatch/)
  assert.equal(completedResultEmitter.events.filter(e => e.type === 'text_delta').length, 1, 'a concrete completed-source result must remain visible')

  const cadenceText = 'The official benchmark reports a 2.1-second median agent startup, establishing a concrete latency baseline.'
  const validCadenceEmitter = makeEmitter()
  const validCadenceState = createInitialState(false, timeouts)
  validCadenceState.currentPlanItems = ['Verify current latency evidence']
  validCadenceState.currentStepIdx = 0
  validCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(validCadenceState), true)
  const validCadenceProcessor = new StreamProcessor(validCadenceEmitter as any, timeouts)
  const validCadenceResult = await validCadenceProcessor.processStream(validCadenceToolChunks() as any, validCadenceState, true)
  const cadenceTextIndex = validCadenceEmitter.events.findIndex(event => event.type === 'progress_update')
  const cadenceToolIndex = validCadenceEmitter.events.findIndex(event => event.type === 'tool_start')
  assert.equal(validCadenceEmitter.events[cadenceTextIndex]?.content, cadenceText)
  assert.equal(cadenceToolIndex, cadenceTextIndex + 1, 'accepted schema narration must emit immediately before the provisional tool_start')
  assert.equal(validCadenceResult.cadenceProgressUpdate, cadenceText)
  assert.equal(validCadenceResult.cadenceProgressVisibleActionsAfter, 1)
  assert.doesNotMatch(validCadenceResult.toolCalls.get(0)?.arguments || '', /progress_update/, 'display-only narration must never reach execution arguments')
  assert.equal((validCadenceEmitter.events[cadenceToolIndex].args as any).progress_update, undefined, 'display-only narration must never leak into persisted tool_start args')
  assert.equal(validCadenceState.recentNarrations.length, 0, 'speculative stream parsing must not reset cadence before billing commits')
  assert.equal(acceptProgressNarration(validCadenceState, validCadenceResult.cadenceProgressUpdate || '', { requireSignal: false, remainingVisibleActions: validCadenceResult.cadenceProgressVisibleActionsAfter, resetCadence: true }).status, 'accepted')
  assert.equal(validCadenceState.visibleToolActionsSinceLastNarration, 1)

  const upsertCadenceEmitter = makeEmitter()
  const upsertCadenceState = createInitialState(false, timeouts)
  upsertCadenceState.currentPlanItems = ['Verify current latency evidence']
  upsertCadenceState.currentStepIdx = 0
  upsertCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(upsertCadenceState), true)
  const upsertCadenceResult = await new StreamProcessor(upsertCadenceEmitter as any, timeouts).processStream(cadenceToolUpsertChunks() as any, upsertCadenceState, true)
  assert.ok(upsertCadenceEmitter.events.filter(event => event.type === 'tool_start').length >= 1)
  assert.equal(upsertCadenceResult.cadenceProgressVisibleActionsAfter, 1, 'provisional upserts for one tool ID must consume exactly one cadence action')
  assert.equal(acceptProgressNarration(upsertCadenceState, upsertCadenceResult.cadenceProgressUpdate || '', { requireSignal: false, remainingVisibleActions: upsertCadenceResult.cadenceProgressVisibleActionsAfter, resetCadence: true }).status, 'accepted')
  assert.equal(upsertCadenceState.visibleToolActionsSinceLastNarration, 1, 'a same-tool upsert must not make the next narration arrive early')

  const invalidCadenceEmitter = makeEmitter()
  const invalidCadenceState = createInitialState(false, timeouts)
  invalidCadenceState.currentPlanItems = ['Verify current latency evidence']
  invalidCadenceState.currentStepIdx = 0
  invalidCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(invalidCadenceState), true)
  const invalidCadenceResult = await new StreamProcessor(invalidCadenceEmitter as any, timeouts).processStream(invalidCadenceToolChunks() as any, invalidCadenceState, true)
  assert.equal(invalidCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'future-only schema text must not emit')
  assert.equal(invalidCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'invalid schema text may keep only the provisional preview hidden')
  assert.equal(invalidCadenceResult.cadenceProgressUpdate, undefined)
  assert.equal(invalidCadenceResult.toolCalls.size, 1, 'invalid display narration must never discard a valid native action')
  assert.equal(invalidCadenceResult.cadenceProgressViolation, undefined)
  assert.equal(invalidCadenceState.narrationNextAttemptAt, 4, 'invalid schema text must keep cadence due at the next action frontier')

  const missingCadenceEmitter = makeEmitter()
  const missingCadenceState = createInitialState(false, timeouts)
  missingCadenceState.currentPlanItems = ['Verify current latency evidence']
  missingCadenceState.currentStepIdx = 0
  missingCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(missingCadenceState), true)
  const missingCadenceResult = await new StreamProcessor(missingCadenceEmitter as any, timeouts).processStream(missingCadenceToolChunks() as any, missingCadenceState, true)
  assert.equal(missingCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0)
  assert.equal(missingCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 1, 'a missing display field must still reveal the valid action')
  assert.equal(missingCadenceResult.toolCalls.size, 1, 'a missing display field must not block execution')
  assert.equal(missingCadenceResult.cadenceProgressViolation, undefined)
  assert.equal(missingCadenceState.narrationNextAttemptAt, 4)

  const emptyCadenceEmitter = makeEmitter()
  const emptyCadenceState = createInitialState(false, timeouts)
  emptyCadenceState.currentPlanItems = ['Verify current latency evidence']
  emptyCadenceState.currentStepIdx = 0
  emptyCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(emptyCadenceState), true)
  const emptyCadenceResult = await new StreamProcessor(emptyCadenceEmitter as any, timeouts).processStream(emptyCadenceToolChunks() as any, emptyCadenceState, true)
  assert.equal(emptyCadenceEmitter.events.length, 0, 'an empty required cadence field must remain invisible')
  assert.equal(emptyCadenceResult.toolCalls.size, 1, 'an empty display field must not discard useful work')
  assert.equal(emptyCadenceResult.cadenceProgressViolation, undefined)

  const proseOnlyCadenceEmitter = makeEmitter()
  const proseOnlyCadenceState = createInitialState(false, timeouts)
  proseOnlyCadenceState.currentPlanItems = ['Verify current latency evidence']
  proseOnlyCadenceState.currentStepIdx = 0
  proseOnlyCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(proseOnlyCadenceState), true)
  const proseOnlyCadenceResult = await new StreamProcessor(proseOnlyCadenceEmitter as any, timeouts).processStream(cadenceProseOnlyChunks() as any, proseOnlyCadenceState, true)
  assert.equal(proseOnlyCadenceEmitter.events.length, 0, 'ordinary prose cannot substitute for same-action schema narration')
  assert.equal(proseOnlyCadenceResult.assistantContent, '')
  assert.equal(proseOnlyCadenceResult.toolCalls.size, 0)
  assert.equal(proseOnlyCadenceResult.cadenceProgressViolation?.code, 'missing_tool_call')

  const maxGapViolationEmitter = makeEmitter()
  const maxGapViolationState = createInitialState(false, timeouts)
  maxGapViolationState.currentPlanItems = ['Verify current latency evidence']
  maxGapViolationState.currentStepIdx = 0
  maxGapViolationState.visibleToolActionsSinceLastNarration = 4
  maxGapViolationState.workLog.push('[1] Read document: official agent startup benchmark')
  assert.equal(beginNarrationCadenceAttempt(maxGapViolationState), true)
  const maxGapViolationResult = await new StreamProcessor(maxGapViolationEmitter as any, timeouts).processStream(missingCadenceToolChunks() as any, maxGapViolationState, true)
  assert.equal(maxGapViolationEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'the runtime must not invent max-gap narration')
  assert.equal(maxGapViolationEmitter.events.filter(event => event.type === 'tool_start').length, 1, 'even a max-gap narration miss must not stall the real action')
  assert.equal(maxGapViolationResult.toolCalls.size, 1)
  assert.equal(maxGapViolationResult.cadenceProgressViolation, undefined)

  const duplicateCadenceEmitter = makeEmitter()
  const duplicateCadenceState = createInitialState(false, timeouts)
  duplicateCadenceState.currentPlanItems = ['Verify current latency evidence']
  duplicateCadenceState.currentStepIdx = 0
  duplicateCadenceState.iterations = 1
  assert.equal(acceptProgressNarration(duplicateCadenceState, cadenceText, { requireSignal: false, remainingVisibleActions: 0 }).status, 'accepted')
  duplicateCadenceState.iterations = 2
  duplicateCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(duplicateCadenceState), true)
  const duplicateResult = await new StreamProcessor(duplicateCadenceEmitter as any, timeouts).processStream(validCadenceToolChunks() as any, duplicateCadenceState, true)
  assert.equal(duplicateCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'duplicate schema text must not emit')
  assert.equal(duplicateCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'duplicate schema text may keep only the provisional preview hidden')
  assert.equal(duplicateResult.cadenceProgressUpdate, undefined)
  assert.equal(duplicateResult.toolCalls.size, 1, 'duplicate narration must not suppress the native action')
  assert.equal(duplicateResult.cadenceProgressViolation, undefined)
  assert.equal(duplicateCadenceState.recentNarrations.length, 1, 'duplicate schema text must not reset or extend accepted narration memory')
  assert.equal(duplicateCadenceState.narrationNextAttemptAt, 4, 'duplicate schema text must keep cadence due')

  const leakedCommandEmitter = makeEmitter()
  const leakedCommandState = createInitialState(false, timeouts)
  const leakedCommandResult = await new StreamProcessor(leakedCommandEmitter as any, timeouts).processStream(leakedBenchmarkCommandChunks() as any, leakedCommandState)
  assert.equal(leakedCommandResult.assistantContent.trim(), '', 'operational benchmark command fragments must not survive stream cleaning')
  assert.equal(leakedCommandEmitter.events.filter(event => event.type === 'text_delta').length, 0)

  const ordinaryCadenceEmitter = makeEmitter()
  const ordinaryCadenceState = createInitialState(false, timeouts)
  ordinaryCadenceState.currentPlanItems = ['Verify current latency evidence']
  ordinaryCadenceState.currentStepIdx = 0
  ordinaryCadenceState.visibleToolActionsSinceLastNarration = 3
  const ordinaryCadenceResult = await new StreamProcessor(ordinaryCadenceEmitter as any, timeouts).processStream(ordinaryAndSchemaCadenceChunks() as any, ordinaryCadenceState, true)
  assert.equal(ordinaryCadenceEmitter.events.filter(event => event.type === 'progress_update').length, 1, 'ordinary same-turn narration and progress_update must never double-emit')
  assert.equal(ordinaryCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'cadence narration must use its explicit event lane')
  assert.match(ordinaryCadenceResult.cadenceProgressUpdate || '', /95th-percentile startup/, 'only the required schema lane may satisfy cadence')
  assert.doesNotMatch(ordinaryCadenceResult.assistantContent, /2\.1-second median/, 'ordinary prose outside progress_update must be ignored on cadence turns')
  assert.doesNotMatch(ordinaryCadenceResult.toolCalls.get(0)?.arguments || '', /progress_update/, 'the accepted schema field must still be stripped before execution and history')

  const schemaFirstEmitter = makeEmitter()
  const schemaFirstState = createInitialState(false, timeouts)
  schemaFirstState.currentPlanItems = ['Verify current latency evidence']
  schemaFirstState.currentStepIdx = 0
  const schemaFirstResult = await new StreamProcessor(schemaFirstEmitter as any, timeouts).processStream(schemaThenOrdinaryCadenceChunks() as any, schemaFirstState, true)
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'progress_update').length, 1, 'ordinary prose arriving after an accepted schema update must be suppressed')
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'accepted cadence updates must not reuse generic assistant text')
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'tool_start').length, 1)
  assert.match(schemaFirstResult.cadenceProgressUpdate || '', /2\.1-second median agent startup/)

  const defaultParallelEmitter = makeEmitter()
  const defaultParallelState = createInitialState(false, timeouts)
  defaultParallelState.currentPlanItems = ['Read official sources']
  defaultParallelState.currentStepIdx = 0
  const defaultParallelResult = await new StreamProcessor(defaultParallelEmitter as any, timeouts).processStream(
    parallelSourceChunks() as any,
    defaultParallelState,
  )
  assert.deepEqual([...defaultParallelResult.toolCalls.keys()], [0], 'parallel streamed calls must remain disabled unless the request explicitly enabled them')

  const parallelEmitter = makeEmitter()
  const parallelState = createInitialState(false, timeouts)
  parallelState.currentPlanItems = ['Read official sources']
  parallelState.currentStepIdx = 0
  const parallelResult = await new StreamProcessor(parallelEmitter as any, timeouts).processStream(
    parallelSourceChunks() as any,
    parallelState,
    false,
    undefined,
    { allowParallelSourceExtractionCalls: true, maxParallelSourceExtractionCalls: 3 },
  )
  assert.deepEqual([...parallelResult.toolCalls.keys()], [0, 1, 2], 'safe source calls must retain provider index order and respect the three-call cap')
  assert.deepEqual(
    [...parallelResult.toolCalls.values()].map(call => call.name),
    ['read_document', 'http_request', 'read_document'],
    'only the three bounded source-extraction calls should survive stream processing',
  )
  assert.equal(parallelEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'streamed source reads must wait for committed execution before becoming visible actions')

  const mixedParallelEmitter = makeEmitter()
  const mixedParallelState = createInitialState(false, timeouts)
  mixedParallelState.currentPlanItems = ['Read official sources']
  mixedParallelState.currentStepIdx = 0
  const mixedParallelResult = await new StreamProcessor(mixedParallelEmitter as any, timeouts).processStream(
    mixedParallelToolChunks() as any,
    mixedParallelState,
    false,
    undefined,
    { allowParallelSourceExtractionCalls: true, maxParallelSourceExtractionCalls: 3 },
  )
  assert.deepEqual([...mixedParallelResult.toolCalls.keys()], [0], 'a mixed or unsafe parallel batch must fall back to the first streamed call')
  assert.equal(mixedParallelResult.toolCalls.get(0)?.id, 'call_safe_primary')
  assert.equal(mixedParallelEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'a rejected unsafe secondary must never flash a provisional action')
  assert.equal(mixedParallelState.visibleToolActionsSinceLastNarration, 0, 'rejected secondary calls must not consume narration cadence headroom')
}
`, 'utf-8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    logLevel: 'silent',
  })

  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  await runSmoke()
  console.log('stream action-start smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
