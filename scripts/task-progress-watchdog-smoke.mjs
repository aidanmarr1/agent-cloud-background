import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'agent-progress-'))
try {
  const outfile = join(dir, 'watchdog.mjs')
  await build({ stdin: { contents: "export * from './src/lib/agent/TaskProgressWatchdog'; export * from './src/lib/agent/DeliverableContract'; export * from './src/lib/agent/ToolCache'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm' })
  const { TaskProgressWatchdog, requestedFinalArtifactFormat, ToolCache } = await import(pathToFileURL(outfile).href)
  assert.deepEqual(requestedFinalArtifactFormat({ originalUserRequest: 'make a word doc' }), { label: 'Word document', extensions: ['.docx'] })
  const result = (name, content, extras = {}) => ({ tc: { name }, result: content, isError: false, acceptedForExecution: true, ...extras })
  const turn = (guard, results = []) => { guard.startTurn(); guard.record(results); return guard.boundary() }

  // File reads interleaved with narration, failed commands, and cache replays
  // used to reset local recovery limits. None can renew this task-wide budget.
  let guard = new TaskProgressWatchdog()
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft' })]), 'continue')
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft' }, { cached: true })]), 'continue')
  assert.equal(turn(guard), 'redirect') // narration only
  assert.equal(turn(guard, [result('execute_command', { error: 'failed' }, { isError: true })]), 'continue')
  guard = new TaskProgressWatchdog(JSON.parse(JSON.stringify(guard.snapshot())))
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft', timestamp: 999, elapsedMs: 10, requestId: 'new-id' })]), 'stop') // cache expiry/restart
  assert.equal(guard.boundary(), 'continue', 'one boundary consumes a turn only once')

  guard.reset()
  for (let i = 0; i < 20; i++) {
    assert.equal(turn(guard, [result('read_document', { text: `Distinct source evidence ${i}` })]), 'continue')
  }
  for (let i = 0; i < 10; i++) {
    assert.equal(turn(guard, [result('edit_file', { success: true }, {
      tc: { name: 'edit_file', arguments: JSON.stringify({ path: 'draft.md', replacement: `Revision ${i}` }) },
    })]), 'continue', 'distinct edits remain progress even with identical success envelopes')
    assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: `Revision ${i}` })]), 'continue')
  }
  const failed = new TaskProgressWatchdog()
  for (let i = 1; i <= 4; i++) {
    assert.equal(turn(failed, [result('run_code', { error: `different failure ${i}` }, { isError: true })]), i === 2 ? 'redirect' : i === 4 ? 'stop' : 'continue')
  }
  const cycle = new TaskProgressWatchdog()
  for (const name of ['read_file', 'list_files', 'browser_get_content']) turn(cycle, [result(name, { content: name })])
  for (let i = 1; i <= 4; i++) {
    const name = ['read_file', 'list_files', 'browser_get_content'][(i - 1) % 3]
    assert.equal(turn(cycle, [result(name, { content: name })]), i === 2 ? 'redirect' : i === 4 ? 'stop' : 'continue')
  }
  // A little novelty between repeated failures must not renew a whole run.
  let intermittent = new TaskProgressWatchdog()
  const outcomes = []
  for (let i = 0; i < 8; i++) {
    outcomes.push(turn(intermittent, i === 2 || i === 5
      ? [result('read_document', { content: `new evidence ${i}` })] : []))
    if (i === 4) intermittent = new TaskProgressWatchdog(JSON.parse(JSON.stringify(intermittent.snapshot())))
  }
  assert.equal(outcomes[7], 'stop', 'six unproductive turns in eight must stop across checkpoint recovery')
  assert.equal(outcomes.filter(value => value === 'redirect').length, 1, 'a repeating cycle gets one redirect rather than repeated plan prompts')
  intermittent.reset()
  assert.equal(turn(intermittent, [result('read_document', { content: 'new user instruction' })]), 'continue')

  const metadata = new TaskProgressWatchdog()
  turn(metadata, [result('execute_command', { stdout: 'unchanged', elapsedMs: 1 }, {
    tc: { name: 'execute_command', arguments: JSON.stringify({ command: 'pwd', progress_update: 'Checking location' }) },
  })])
  for (let i = 1; i <= 4; i++) {
    assert.equal(turn(metadata, [result('execute_command', { stdout: 'unchanged', elapsedMs: i + 1 }, {
      tc: { name: 'execute_command', arguments: JSON.stringify({ command: 'pwd', progress_update: `Another label ${i}` }) },
    })]), i === 2 ? 'redirect' : i === 4 ? 'stop' : 'continue')
  }
  const reopened = new TaskProgressWatchdog()
  reopened.startTurn()
  reopened.record([result('read_file', { content: 'new' })])
  reopened.startTurn()
  assert.equal(reopened.boundary(), 'continue', 'stream reopen cannot discard recorded evidence')
  assert.equal(reopened.snapshot().stalledTurns, 0)

  const cache = new ToolCache()
  const evidence = [{ url: 'https://example.com/report', title: 'Useful source' }]
  cache.set('web_search', { query: ' Useful  sources ', action_label: 'Find sources', progress_update: 'First update' }, evidence)
  assert.equal(cache.get('web_search', { query: 'useful sources', action_label: 'New label', progress_update: 'Second update', plan_step_index: 4 }), evidence,
    'display text, phase changes and whitespace must not charge for the same search again')
  cache.set('read_file', { path: 'draft.md', progress_update: 'Inspect draft' }, { content: 'old draft' })
  assert.deepEqual(cache.get('read_file', { path: './draft.md', progress_update: 'Read it again' }), { content: 'old draft' })
  cache.invalidateForFile('draft.md')
  assert.equal(cache.get('read_file', { path: 'draft.md' }), undefined, 'actual edits invalidate stale cached reads')
  cache.set('execute_command', { command: 'touch output.txt' }, { success: true })
  assert.equal(cache.get('execute_command', { command: 'touch output.txt' }), undefined, 'side effects are never cached')
  const source = await readFile('src/lib/agent/AgentLoop.ts', 'utf8')
  assert.ok(source.indexOf('taskProgressWatchdog.boundary()') < source.indexOf('decidePaidModelTurnProgress('), 'global fence must precede all local recovery resets')
  assert.match(source, /const shouldRequireToolCall =\s*!allowPhaseDecision/, 'a completed action must allow a phase decision instead of forcing another read')
  assert.match(source, /const allowPhaseDecision = state\.stepToolCallCount > state\.stepFailureCount[\s\S]*?!state\.exactExtractionGuardPending/, 'phase decisions must require successful evidence and respect mandatory verification')
  assert.match(source, /taskProgressWatchdog\.startTurn\(\)[\s\S]*const response = await this\.callLLMWithRetry\(/, 'failed model starts must consume the task-wide allowance')
  assert.equal((source.match(/taskProgressWatchdog\.startTurn\(\)/g) || []).length, 1, 'one model attempt must open one watchdog turn')
  assert.match(source, /taskProgressWatchdog\.record\(lastToolResults\)/)
  assert.match(source, /progressWatchdog: taskProgressWatchdog\.snapshot\(\)/)
  assert.match(source, /new TaskProgressWatchdog\(recoveredCheckpoint\?\.progressWatchdog\)/)
  assert.match(source, /taskProgressDecision === 'stop'[\s\S]*?phase = 'ERROR'/)
  console.log('Task progress watchdog smoke passed: repeated reads, cross-tool cycles, failed actions, narration, restart, new evidence, edits, and changed-file reads.')
} finally { await rm(dir, { recursive: true, force: true }) }
