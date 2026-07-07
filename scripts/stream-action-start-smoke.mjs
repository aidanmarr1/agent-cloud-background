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

  const searchEmitter = makeEmitter()
  const searchState = createInitialState(false, timeouts)
  searchState.currentPlanItems = ['Gather current evidence']
  searchState.currentStepIdx = 0
  const searchProcessor = new StreamProcessor(searchEmitter as any, timeouts)
  const searchResult = await searchProcessor.processStream(missingDisplaySearchChunks() as any, searchState)
  const searchStarts = searchEmitter.events.filter(e => e.type === 'tool_start')
  assert.equal(searchResult.toolCalls.size, 1, 'tool call without display metadata should still be captured')
  assert.equal(searchStarts.length, 1, 'missing display metadata must be repaired into a visible search pill')
  assert.equal((searchStarts[0].args as any).plan_step_index, 1)
  assert.match(String((searchStarts[0].args as any).action_label), /^Search AI agent startup latency benchmark/i)

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
  assert.equal(failedSourceSearchEmitter.events.filter(e => e.type === 'tool_start').length, 1, 'after repeated source extraction failures, a new search for a better source should show normally')

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
