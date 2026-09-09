import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'agent-progress-'))
try {
  const outfile = join(dir, 'watchdog.mjs')
  await build({ stdin: { contents: "export * from './src/lib/agent/TaskProgressWatchdog'; export * from './src/lib/agent/DeliverableContract'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm' })
  const { TaskProgressWatchdog, requestedFinalArtifactFormat } = await import(pathToFileURL(outfile).href)
  assert.deepEqual(requestedFinalArtifactFormat({ originalUserRequest: 'make a word doc' }), { label: 'Word document', extensions: ['.docx'] })
  const result = (name, content, extras = {}) => ({ tc: { name }, result: content, isError: false, acceptedForExecution: true, ...extras })
  const turn = (guard, results = []) => { guard.startTurn(); guard.record(results); return guard.boundary() }

  // File reads interleaved with narration, failed commands, and cache replays
  // used to reset local recovery limits. None can renew this task-wide budget.
  let guard = new TaskProgressWatchdog()
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft' })]), 'continue')
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft' }, { cached: true })]), 'continue')
  assert.equal(turn(guard), 'continue') // narration only
  assert.equal(turn(guard, [result('execute_command', { error: 'failed' }, { isError: true })]), 'redirect')
  guard = new TaskProgressWatchdog(JSON.parse(JSON.stringify(guard.snapshot())))
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft' })]), 'continue') // cache expiry/restart
  assert.equal(turn(guard, [result('read_file', { path: 'draft.md', content: 'Draft', timestamp: 999 })]), 'continue')
  assert.equal(turn(guard), 'stop')
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
  for (let i = 1; i <= 6; i++) {
    assert.equal(turn(failed, [result('run_code', { error: `different failure ${i}` }, { isError: true })]), i === 3 ? 'redirect' : i === 6 ? 'stop' : 'continue')
  }
  const cycle = new TaskProgressWatchdog()
  for (const name of ['read_file', 'list_files', 'browser_get_content']) turn(cycle, [result(name, { content: name })])
  for (let i = 1; i <= 6; i++) {
    const name = ['read_file', 'list_files', 'browser_get_content'][(i - 1) % 3]
    assert.equal(turn(cycle, [result(name, { content: name })]), i === 3 ? 'redirect' : i === 6 ? 'stop' : 'continue')
  }
  const source = await readFile('src/lib/agent/AgentLoop.ts', 'utf8')
  assert.ok(source.indexOf('taskProgressWatchdog.boundary()') < source.indexOf('decidePaidModelTurnProgress('), 'global fence must precede all local recovery resets')
  assert.match(source, /const shouldRequireToolCall =\s*!allowPhaseDecision/, 'a completed action must allow a phase decision instead of forcing another read')
  assert.match(source, /const allowPhaseDecision = state\.stepToolCallCount > state\.stepFailureCount[\s\S]*?!state\.exactExtractionGuardPending/, 'phase decisions must require successful evidence and respect mandatory verification')
  assert.match(source, /taskProgressWatchdog\.record\(lastToolResults\)/)
  assert.match(source, /progressWatchdog: taskProgressWatchdog\.snapshot\(\)/)
  assert.match(source, /new TaskProgressWatchdog\(recoveredCheckpoint\?\.progressWatchdog\)/)
  assert.match(source, /taskProgressDecision === 'stop'[\s\S]*?phase = 'ERROR'/)
  console.log('Task progress watchdog smoke passed: repeated reads, cross-tool cycles, failed actions, narration, restart, new evidence, edits, and changed-file reads.')
} finally { await rm(dir, { recursive: true, force: true }) }
