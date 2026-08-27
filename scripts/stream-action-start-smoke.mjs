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
import { carriedCadenceActionCount, StreamProcessor } from ${JSON.stringify(join(root, 'src/lib/agent/StreamProcessor.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { acceptProgressNarration, beginNarrationCadenceAttempt, reviewProgressNarration } from ${JSON.stringify(join(root, 'src/lib/agent/NarrationMemory.ts'))}
import { sanitizeAgentEventEmitter } from ${JSON.stringify(join(root, 'src/lib/agent/SSEEmitter.ts'))}

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
    progressUpdate(content: string, placement?: Record<string, unknown>) { events.push({ type: 'progress_update', content, placement }) },
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

async function* missingDisplayFileChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_missing_file_label', function: { name: 'create_file', arguments: '{\\"plan_step_index\\":1,\\"path\\":\\"deliverables/report.md\\",\\"content\\":\\"# Report\\\\n\\\\n' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'The opening section is already visible while the report body continues streaming.\\"}' } }] } }] }
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

async function* recoveredTextSavedDeliverableChunks(gate: Promise<void>) {
  yield { choices: [{ delta: { content: '# Immediate live output\\n\\n- The first real provider chunk is visible now.\\n' } }] }
  await gate
  yield { choices: [{ delta: { content: '- Later provider chunks continue in the same real file.\\n' } }] }
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

async function* internalProviderRecoveryChunks() {
  yield { choices: [{ delta: { content: 'The free Serper API ' } }] }
  yield { choices: [{ delta: { content: "blocked the Apple search query, so I navigated directly to Apple's iPhone store page instead." } }] }
}

async function* validCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_valid_cadence', function: { name: 'web_search', arguments: '{"action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark","progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay."}' } }] } }] }
}

async function* bufferedSearchThenThrowChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_buffered_search_failure', function: { name: 'web_search', arguments: '{"action_label":"Verify buffered search rollback behavior","plan_step_index":1,"query":"buffered search rollback behavior"}' } }] } }] }
  throw new Error('simulated provider stream failure after provisional search start')
}

async function* deferredCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_deferred_cadence', function: { name: 'read_document', arguments: '{"action_label":"Extract official benchmark latency and initialization evidence","plan_step_index":1,"url":"https://benchmarks.example/startup","progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay."}' } }] } }] }
}

async function* liveFileCadenceToolChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_live_file_cadence', function: { name: 'create_file', arguments: '{"progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay.","action_label":"Write the source-backed benchmark report","plan_step_index":1,"path":"deliverables/benchmark.md","content":"# Benchmark\\n\\n' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'The verified median is 2.1 seconds."}' } }] } }] }
}

async function* liveFileCadenceThenThrowChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_live_file_cadence_failure', function: { name: 'create_file', arguments: '{"progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay.","action_label":"Write the interrupted benchmark report","plan_step_index":1,"path":"deliverables/interrupted-benchmark.md","content":"# Interrupted benchmark\\n\\nThis preview begins before the simulated provider failure."}' } }] } }] }
  throw new Error('simulated provider stream failure after live cadence file start')
}

async function* cadenceToolUpsertChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cadence_upsert', function: { name: 'web_search', arguments: '{"action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark","count":5,"progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay."' } }] } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }
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
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ordinary_cadence', function: { name: 'web_search', arguments: '{"action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark","progress_update":"The official benchmark identifies cold initialization as the main source of startup delay."}' } }] } }] }
}

async function* schemaThenOrdinaryCadenceChunks() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_schema_first', function: { name: 'web_search', arguments: '{"action_label":"Verify agent startup benchmarks","plan_step_index":1,"query":"official agent startup benchmark","progress_update":"The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay' } }] } }] }
  yield { choices: [{ delta: { content: 'A second provider narration must not be shown.' } }] }
  yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '."}' } }] } }] }
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
  const rawDedupEmitter = makeEmitter()
  const dedupEmitter = sanitizeAgentEventEmitter(rawDedupEmitter as any)
  dedupEmitter.toolStart('same-file-write', 'append_file', {
    action_label: 'Append final section',
    plan_step_index: 2,
    path: 'deliverables/report.md',
  }, { provisional: true })
  dedupEmitter.toolStart('same-file-write', 'append_file', {
    action_label: 'Append final section',
    plan_step_index: 2,
    path: 'deliverables/report.md',
  })
  assert.equal(
    rawDedupEmitter.events.filter(event => event.type === 'tool_start').length,
    1,
    'a provisional file-write start and its finalized replay must persist as one visible action',
  )

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

  const missingDisplayEmitter = makeEmitter()
  const missingDisplayState = createInitialState(true, timeouts)
  missingDisplayState.currentPlanItems = ['Write the report']
  missingDisplayState.currentStepIdx = 0
  const missingDisplayResult = await new StreamProcessor(missingDisplayEmitter as any, timeouts)
    .processStream(missingDisplayFileChunks() as any, missingDisplayState)
  assert.equal(missingDisplayResult.toolCalls.size, 1)
  const missingDisplayStart = missingDisplayEmitter.events.find(e => e.type === 'tool_start')
  assert.equal((missingDisplayStart?.args as any)?.action_label, 'Create report.md', 'file starts should get a concise path-derived label when the provider omits display metadata')
  assert.ok(missingDisplayEmitter.events.findIndex(e => e.type === 'tool_start') < missingDisplayEmitter.events.findIndex(e => e.type === 'file_content_delta'), 'a missing-label file action must still appear before content is written')

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

  let releaseRecoveredText: () => void = () => {}
  const recoveredTextGate = new Promise<void>(resolve => {
    releaseRecoveredText = resolve
  })
  const recoveredTextEmitter = makeEmitter()
  const recoveredTextState = createInitialState(true, timeouts)
  recoveredTextState.currentPlanItems = ['Gather evidence', 'Write concise note']
  recoveredTextState.currentStepIdx = 1
  const recoveredTextTarget: { id: string; path: string; started?: boolean } = {
    id: 'autosave_recovered_text',
    path: 'deliverables/live-recovery.md',
  }
  const recoveredTextProcessor = new StreamProcessor(recoveredTextEmitter as any, timeouts)
  recoveredTextProcessor.beginBufferedEmission()
  let recoveredTextSettled = false
  const recoveredTextProcessing = recoveredTextProcessor.processStream(
    recoveredTextSavedDeliverableChunks(recoveredTextGate) as any,
    recoveredTextState,
    false,
    undefined,
    {
      allowParallelSourceExtractionCalls: false,
      maxParallelSourceExtractionCalls: 1,
      textSavedDeliverable: recoveredTextTarget,
    },
  ).finally(() => {
    recoveredTextSettled = true
  })

  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(recoveredTextSettled, false, 'the text-save recovery stream must still be generating when its file appears')
  assert.equal(recoveredTextTarget.started, true, 'the target must record that its live file lane was opened')
  assert.deepEqual(
    recoveredTextEmitter.events.slice(0, 3).map(event => event.type),
    ['tool_start', 'file_content_start', 'file_content_delta'],
    'the first real recovery content chunk must immediately open and update the actual file lane',
  )
  assert.equal(
    recoveredTextEmitter.events.filter(event => event.type === 'text_delta').length,
    0,
    'saved deliverable recovery content must not leak into the ordinary chat lane',
  )
  assert.match(
    recoveredTextEmitter.events
      .filter(event => event.type === 'file_content_delta')
      .map(event => event.content)
      .join(''),
    /first real provider chunk is visible now/,
    'the live preview must contain actual provider output before generation completes',
  )

  releaseRecoveredText()
  const recoveredTextResult = await recoveredTextProcessing
  recoveredTextProcessor.commitBufferedEmission()
  assert.match(recoveredTextResult.assistantContent, /Later provider chunks continue/)
  assert.equal(
    recoveredTextEmitter.events.filter(event => event.type === 'tool_start').length,
    1,
    'completing a recovery stream must keep one stable real file action',
  )
  assert.match(
    recoveredTextEmitter.events
      .filter(event => event.type === 'file_content_delta')
      .map(event => event.content)
      .join(''),
    /Later provider chunks continue in the same real file/,
    'every later provider chunk must continue through the same live file lane',
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

  const providerRecoveryEmitter = makeEmitter()
  const providerRecoveryState = createInitialState(false, timeouts)
  providerRecoveryState.currentPlanItems = ['Verify the current Apple configuration']
  providerRecoveryState.currentStepIdx = 0
  const providerRecoveryResult = await new StreamProcessor(providerRecoveryEmitter as any, timeouts)
    .processStream(internalProviderRecoveryChunks() as any, providerRecoveryState)
  assert.equal(
    providerRecoveryEmitter.events.filter(event => event.type === 'text_delta').length,
    0,
    'fragmented provider/API recovery mechanics must be held and removed before reaching the UI',
  )
  assert.equal(
    providerRecoveryResult.assistantContent.trim(),
    '',
    'internal provider/API recovery prose must not count as user-visible model progress',
  )

  const cadenceText = 'The official benchmark reports a 2.1-second median startup and identifies cold initialization as the main delay.'
  assert.equal(
    reviewProgressNarration(
      'The free Serper API blocked the Apple search query, so I navigated directly to the store page instead.',
      { requireSignal: false },
    ).status,
    'invalid',
    'provider/API recovery details must never become visible narration',
  )
  const bufferedFailureEmitter = makeEmitter()
  const bufferedFailureState = createInitialState(false, timeouts)
  bufferedFailureState.currentPlanItems = ['Verify buffered search rollback behavior']
  bufferedFailureState.currentStepIdx = 0
  bufferedFailureState.visibleToolActionsSinceLastNarration = 2
  const bufferedFailureProcessor = new StreamProcessor(bufferedFailureEmitter as any, timeouts)
  bufferedFailureProcessor.beginBufferedEmission()
  await assert.rejects(
    () => bufferedFailureProcessor.processStream(bufferedSearchThenThrowChunks() as any, bufferedFailureState),
    /simulated provider stream failure/,
  )
  assert.equal(bufferedFailureState.visibleToolActionsSinceLastNarration, 3, 'a queued provisional search is counted on the server while the stream remains viable')
  assert.equal(bufferedFailureState.visibleNarrationToolStartIds.has('call_buffered_search_failure'), true)
  assert.equal(bufferedFailureEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'a buffered provisional search must not reach the client before commit')
  bufferedFailureProcessor.discardBufferedEmission()
  assert.equal(bufferedFailureState.visibleToolActionsSinceLastNarration, 2, 'discarding a never-exposed provisional search must restore the server cadence frontier')
  assert.equal(bufferedFailureState.visibleNarrationToolStartIds.has('call_buffered_search_failure'), false)
  assert.equal(bufferedFailureEmitter.events.filter(event => event.type === 'tool_result').length, 0, 'a never-exposed provisional search needs no client settlement event')

  const validCadenceEmitter = makeEmitter()
  const validCadenceState = createInitialState(false, timeouts)
  validCadenceState.currentPlanItems = ['Verify current latency evidence']
  validCadenceState.currentStepIdx = 0
  validCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(validCadenceState), true)
  const validCadenceProcessor = new StreamProcessor(validCadenceEmitter as any, timeouts)
  validCadenceProcessor.beginBufferedEmission()
  let bufferedEarlyReleases = 0
  const validCadenceResult = await validCadenceProcessor.processStream(
    validCadenceToolChunks() as any,
    validCadenceState,
    true,
    undefined,
    undefined,
    () => { bufferedEarlyReleases++ },
  )
  assert.equal(bufferedEarlyReleases, 0, 'ordinary actions must keep cadence narration in the charge-first release lane')
  assert.equal(validCadenceEmitter.events.length, 0, 'ordinary narration and action events must remain buffered before the usage debit')
  assert.equal(validCadenceResult.cadenceProgressUpdate, cadenceText)
  assert.equal(validCadenceResult.cadenceProgressToolCallId, 'call_valid_cadence')
  assert.doesNotMatch(validCadenceResult.toolCalls.get(0)?.arguments || '', /progress_update/, 'display-only narration must never reach execution arguments')
  assert.equal(validCadenceState.recentNarrations.length, 0, 'speculative stream parsing must not reset cadence before billing commits')
  assert.equal(carriedCadenceActionCount(validCadenceResult), 1, 'a provisionally staged search must carry exactly one action through the narration reset')
  const billedCadenceNarration = acceptProgressNarration(validCadenceState, validCadenceResult.cadenceProgressUpdate || '', { requireSignal: false, remainingVisibleActions: carriedCadenceActionCount(validCadenceResult), resetCadence: true })
  assert.equal(billedCadenceNarration.status, 'accepted')
  if (billedCadenceNarration.status === 'accepted') {
    validCadenceEmitter.progressUpdate(billedCadenceNarration.text, {
      beforeToolId: validCadenceResult.cadenceProgressToolCallId,
      remainingVisibleActions: 0,
    })
  }
  validCadenceProcessor.commitBufferedEmission()
  const cadenceNarrationIndex = validCadenceEmitter.events.findIndex(event => event.type === 'progress_update')
  const cadenceToolIndex = validCadenceEmitter.events.findIndex(event => event.type === 'tool_start')
  assert.ok(cadenceNarrationIndex >= 0 && cadenceNarrationIndex < cadenceToolIndex, 'after charging, ordinary narration must render immediately before its buffered next action')
  assert.equal((validCadenceEmitter.events[cadenceToolIndex].args as any).progress_update, undefined, 'display-only narration must never leak into persisted tool_start args')
  assert.equal(validCadenceState.visibleToolActionsSinceLastNarration, 1, 'the buffered next action becomes action one of the new cadence window')

  const deferredCadenceEmitter = makeEmitter()
  const deferredCadenceState = createInitialState(false, timeouts)
  deferredCadenceState.currentPlanItems = ['Verify current latency evidence']
  deferredCadenceState.currentStepIdx = 0
  deferredCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(deferredCadenceState), true)
  const deferredCadenceResult = await new StreamProcessor(deferredCadenceEmitter as any, timeouts).processStream(deferredCadenceToolChunks() as any, deferredCadenceState, true)
  assert.equal(deferredCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'read_document must remain deferred until execution preflight')
  assert.equal(deferredCadenceResult.cadenceProgressToolCallId, 'call_deferred_cadence')
  assert.equal(carriedCadenceActionCount(deferredCadenceResult), 0, 'a deferred tool must not be ghost-counted before ToolPipeline admits it')
  assert.equal(acceptProgressNarration(deferredCadenceState, deferredCadenceResult.cadenceProgressUpdate || '', { requireSignal: false, remainingVisibleActions: carriedCadenceActionCount(deferredCadenceResult), resetCadence: true }).status, 'accepted')
  assert.equal(deferredCadenceState.visibleToolActionsSinceLastNarration, 0, 'the deferred action is counted later only if execution preflight succeeds')

  const liveFileCadenceEmitter = makeEmitter()
  const liveFileCadenceState = createInitialState(false, timeouts)
  liveFileCadenceState.currentPlanItems = ['Write the source-backed benchmark report']
  liveFileCadenceState.currentStepIdx = 0
  liveFileCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(liveFileCadenceState), true)
  const liveFileCadenceProcessor = new StreamProcessor(liveFileCadenceEmitter as any, timeouts)
  liveFileCadenceProcessor.beginBufferedEmission()
  const liveFileCadenceResult = await liveFileCadenceProcessor.processStream(
    liveFileCadenceToolChunks() as any,
    liveFileCadenceState,
    true,
    undefined,
    undefined,
    (text, toolCallId) => {
      const acceptedNarration = acceptProgressNarration(liveFileCadenceState, text, {
        requireSignal: false,
        remainingVisibleActions: 0,
        resetCadence: true,
      })
      assert.equal(acceptedNarration.status, 'accepted')
      if (acceptedNarration.status !== 'accepted') return
      liveFileCadenceEmitter.progressUpdate(acceptedNarration.text, {
        stepIndex: liveFileCadenceState.currentStepIdx,
        beforeToolId: toolCallId,
        remainingVisibleActions: 0,
      })
    },
  )
  const liveFileNarrationIndex = liveFileCadenceEmitter.events.findIndex(event => event.type === 'progress_update')
  const liveFileToolIndex = liveFileCadenceEmitter.events.findIndex(event => event.type === 'tool_start')
  const liveFileDeltaIndex = liveFileCadenceEmitter.events.findIndex(event => event.type === 'file_content_delta')
  assert.ok(liveFileNarrationIndex >= 0, 'validated cadence narration must be visible before a live file begins')
  assert.ok(liveFileNarrationIndex < liveFileToolIndex, 'live file narration must precede its action pill')
  assert.ok(liveFileToolIndex < liveFileDeltaIndex, 'the live action pill must precede its streamed file content')
  assert.equal((liveFileCadenceEmitter.events[liveFileNarrationIndex].placement as any)?.beforeToolId, 'call_live_file_cadence')
  assert.equal(liveFileCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 1, 'cadence file action must remain visible while its content streams')
  assert.ok(liveFileCadenceEmitter.events.some(event => event.type === 'file_content_delta'), 'cadence file content must stream before the billed model-turn buffer commits')
  assert.equal(carriedCadenceActionCount(liveFileCadenceResult), 1, 'the exposed cadence file remains one carried server action')
  assert.equal(liveFileCadenceResult.toolCalls.get(0)?.provisionalStartExposed, true, 'the live file action must be marked as already exposed for discard recovery')
  assert.equal(liveFileCadenceState.visibleToolActionsSinceLastNarration, 1, 'the provisional live file becomes action one after its preceding narration')
  assert.equal(liveFileCadenceState.visibleNarrationToolStartIds.has('call_live_file_cadence'), true)
  liveFileCadenceProcessor.discardBufferedEmission()
  assert.equal(liveFileCadenceState.visibleToolActionsSinceLastNarration, 0, 'discarding an exposed live file must restore the post-narration server frontier')
  assert.equal(liveFileCadenceState.visibleNarrationToolStartIds.has('call_live_file_cadence'), false, 'discarding an exposed live file must clear its narration action ID')
  assert.ok(liveFileCadenceEmitter.events.some(event => event.type === 'tool_result' && (event.result as any)?.discarded === true), 'discard must visibly settle the optimistic live file action')

  const wrongStepCadenceEmitter = makeEmitter()
  const wrongStepCadenceState = createInitialState(false, timeouts)
  wrongStepCadenceState.currentPlanItems = ['Gather benchmark evidence', 'Write the source-backed benchmark report']
  wrongStepCadenceState.currentStepIdx = 1
  wrongStepCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(wrongStepCadenceState), true)
  let wrongStepEarlyReleases = 0
  const wrongStepCadenceResult = await new StreamProcessor(wrongStepCadenceEmitter as any, timeouts).processStream(
    liveFileCadenceToolChunks() as any,
    wrongStepCadenceState,
    true,
    undefined,
    undefined,
    () => { wrongStepEarlyReleases++ },
  )
  assert.equal(wrongStepEarlyReleases, 0, 'a wrong-step file call must not release narration through the live-preview exception')
  assert.equal(wrongStepCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'a wrong-step file call must not expose an optimistic action')
  assert.equal(wrongStepCadenceState.visibleToolActionsSinceLastNarration, 3, 'a non-previewable file call must retain the charge-first cadence frontier')
  assert.equal(wrongStepCadenceResult.cadenceProgressUpdate, cadenceText, 'the staged update remains available for the normal charge-first release')

  const failedLiveCadenceEmitter = makeEmitter()
  const failedLiveCadenceState = createInitialState(false, timeouts)
  failedLiveCadenceState.currentPlanItems = ['Write the interrupted benchmark report']
  failedLiveCadenceState.currentStepIdx = 0
  failedLiveCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(failedLiveCadenceState), true)
  const failedLiveCadenceProcessor = new StreamProcessor(failedLiveCadenceEmitter as any, timeouts)
  failedLiveCadenceProcessor.beginBufferedEmission()
  await assert.rejects(
    () => failedLiveCadenceProcessor.processStream(
      liveFileCadenceThenThrowChunks() as any,
      failedLiveCadenceState,
      true,
      undefined,
      undefined,
      (text, toolCallId) => {
        const acceptedNarration = acceptProgressNarration(failedLiveCadenceState, text, {
          requireSignal: false,
          remainingVisibleActions: 0,
          resetCadence: true,
        })
        assert.equal(acceptedNarration.status, 'accepted')
        if (acceptedNarration.status !== 'accepted') return
        failedLiveCadenceEmitter.progressUpdate(acceptedNarration.text, {
          beforeToolId: toolCallId,
          remainingVisibleActions: 0,
        })
      },
    ),
    /simulated provider stream failure after live cadence file start/,
  )
  assert.equal(failedLiveCadenceState.visibleToolActionsSinceLastNarration, 1, 'the failed live file is action one until optimistic rollback')
  assert.equal(failedLiveCadenceEmitter.events[0]?.type, 'progress_update', 'the truthful prior-work update remains visible even when the pending file stream fails')
  assert.equal(failedLiveCadenceEmitter.events[1]?.type, 'tool_start', 'the failed live file starts only after its narration')
  failedLiveCadenceProcessor.discardBufferedEmission()
  assert.equal(failedLiveCadenceState.visibleToolActionsSinceLastNarration, 0, 'failed live file rollback must keep the already-rendered narration reset')
  assert.equal(failedLiveCadenceState.narrationCadenceInFlight, false, 'a rendered update must not leave cadence armed for a retry field the next schema will not expose')

  const upsertCadenceEmitter = makeEmitter()
  const upsertCadenceState = createInitialState(false, timeouts)
  upsertCadenceState.currentPlanItems = ['Verify current latency evidence']
  upsertCadenceState.currentStepIdx = 0
  upsertCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(upsertCadenceState), true)
  const upsertCadenceResult = await new StreamProcessor(upsertCadenceEmitter as any, timeouts).processStream(cadenceToolUpsertChunks() as any, upsertCadenceState, true)
  assert.equal(upsertCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 1, 'one streamed tool-call ID must create exactly one visible action')
  assert.equal(upsertCadenceResult.cadenceProgressToolCallId, 'call_cadence_upsert', 'the staged narration must stay bound to one exact action ID')
  assert.equal(acceptProgressNarration(upsertCadenceState, upsertCadenceResult.cadenceProgressUpdate || '', { requireSignal: false, remainingVisibleActions: carriedCadenceActionCount(upsertCadenceResult), resetCadence: true }).status, 'accepted')
  assert.equal(upsertCadenceState.visibleToolActionsSinceLastNarration, 1, 'pre-action narration must carry the buffered next action into the new cadence window')

  const invalidCadenceEmitter = makeEmitter()
  const invalidCadenceState = createInitialState(false, timeouts)
  invalidCadenceState.currentPlanItems = ['Verify current latency evidence']
  invalidCadenceState.currentStepIdx = 0
  invalidCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(invalidCadenceState), true)
  const invalidCadenceResult = await new StreamProcessor(invalidCadenceEmitter as any, timeouts).processStream(invalidCadenceToolChunks() as any, invalidCadenceState, true)
  assert.equal(invalidCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'future-only schema text must not emit')
  assert.equal(invalidCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'invalid display text must hold the fourth action at the hard pre-action boundary')
  assert.equal(invalidCadenceResult.cadenceProgressUpdate, undefined)
  assert.equal(invalidCadenceResult.toolCalls.size, 0, 'invalid display narration must repair before the next action executes')
  assert.equal(invalidCadenceResult.cadenceProgressViolation?.code, 'invalid_progress_update')
  assert.equal(invalidCadenceState.narrationNextAttemptAt, 4, 'failed attempt bookkeeping remains provisional until the agent retry restores the same frontier')

  const missingCadenceEmitter = makeEmitter()
  const missingCadenceState = createInitialState(false, timeouts)
  missingCadenceState.currentPlanItems = ['Verify current latency evidence']
  missingCadenceState.currentStepIdx = 0
  missingCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(missingCadenceState), true)
  const missingCadenceResult = await new StreamProcessor(missingCadenceEmitter as any, timeouts).processStream(missingCadenceToolChunks() as any, missingCadenceState, true)
  assert.equal(missingCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0)
  assert.equal(missingCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'a missing display field must hold the fourth action')
  assert.equal(missingCadenceResult.toolCalls.size, 0, 'a missing display field must be repaired before execution')
  assert.equal(missingCadenceResult.cadenceProgressViolation?.code, 'missing_progress_update')
  assert.equal(missingCadenceState.narrationNextAttemptAt, 4)

  const emptyCadenceEmitter = makeEmitter()
  const emptyCadenceState = createInitialState(false, timeouts)
  emptyCadenceState.currentPlanItems = ['Verify current latency evidence']
  emptyCadenceState.currentStepIdx = 0
  emptyCadenceState.visibleToolActionsSinceLastNarration = 3
  assert.equal(beginNarrationCadenceAttempt(emptyCadenceState), true)
  const emptyCadenceResult = await new StreamProcessor(emptyCadenceEmitter as any, timeouts).processStream(emptyCadenceToolChunks() as any, emptyCadenceState, true)
  assert.equal(emptyCadenceEmitter.events.filter(event => event.type === 'progress_update').length, 0, 'an empty required cadence field must remain invisible')
  assert.equal(emptyCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'an empty display field must hold the fourth action')
  assert.equal(emptyCadenceResult.toolCalls.size, 0, 'an empty display field must be repaired before execution')
  assert.equal(emptyCadenceResult.cadenceProgressViolation?.code, 'invalid_progress_update')

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
  maxGapViolationState.visibleToolActionsSinceLastNarration = 3
  maxGapViolationState.workLog.push('[1] Read document: official agent startup benchmark')
  assert.equal(beginNarrationCadenceAttempt(maxGapViolationState), true)
  const maxGapViolationResult = await new StreamProcessor(maxGapViolationEmitter as any, timeouts).processStream(missingCadenceToolChunks() as any, maxGapViolationState, true)
  assert.equal(maxGapViolationEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'the runtime must not invent max-gap narration')
  assert.equal(maxGapViolationEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'the hard fourth-action boundary must hold an action whose narration contract is missing')
  assert.equal(maxGapViolationResult.toolCalls.size, 0)
  assert.equal(maxGapViolationResult.cadenceProgressViolation?.code, 'missing_progress_update')

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
  assert.equal(duplicateCadenceEmitter.events.filter(event => event.type === 'tool_start').length, 0, 'duplicate display text must hold the fourth action until the update is new')
  assert.equal(duplicateResult.cadenceProgressUpdate, undefined)
  assert.equal(duplicateResult.toolCalls.size, 0, 'duplicate narration must be repaired before the native action executes')
  assert.equal(duplicateResult.cadenceProgressViolation?.code, 'duplicate_progress_update')
  assert.equal(duplicateCadenceState.recentNarrations.length, 1, 'duplicate schema text must not reset or extend accepted narration memory')
  assert.equal(duplicateCadenceState.narrationNextAttemptAt, 4, 'duplicate attempt bookkeeping remains provisional until retry recovery')

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
  assert.equal(ordinaryCadenceEmitter.events.filter(event => event.type === 'progress_update').length, 0, 'structured narration must remain staged for pre-action release')
  assert.equal(ordinaryCadenceEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'cadence narration must use its explicit event lane')
  assert.match(ordinaryCadenceResult.cadenceProgressUpdate || '', /cold initialization as the main source/, 'only the required evidence-bearing schema lane may satisfy cadence')
  assert.doesNotMatch(ordinaryCadenceResult.assistantContent, /2\.1-second median/, 'ordinary prose outside progress_update must be ignored on cadence turns')
  assert.doesNotMatch(ordinaryCadenceResult.toolCalls.get(0)?.arguments || '', /progress_update/, 'the accepted schema field must still be stripped before execution and history')

  const schemaFirstEmitter = makeEmitter()
  const schemaFirstState = createInitialState(false, timeouts)
  schemaFirstState.currentPlanItems = ['Verify current latency evidence']
  schemaFirstState.currentStepIdx = 0
  const schemaFirstResult = await new StreamProcessor(schemaFirstEmitter as any, timeouts).processStream(schemaThenOrdinaryCadenceChunks() as any, schemaFirstState, true)
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'progress_update').length, 0, 'accepted schema narration must remain staged for pre-action release')
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'text_delta').length, 0, 'accepted cadence updates must not reuse generic assistant text')
  assert.equal(schemaFirstEmitter.events.filter(event => event.type === 'tool_start').length, 1)
  assert.match(schemaFirstResult.cadenceProgressUpdate || '', /cold initialization as the main delay/)

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
