import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.partial-file-recovery-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { getSandboxDirPath, readFileInSandbox } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}

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
    toolStart(id: string, name: string, args: Record<string, unknown>) { events.push({ type: 'tool_start', id, name, args }) },
    toolResult(id: string, name: string, result: unknown) { events.push({ type: 'tool_result', id, name, result }) },
    terminalOutput() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
  }
}

async function call(pipeline: ToolPipeline, state: ReturnType<typeof createInitialState>, id: string, name: string, rawArgs: string) {
  const calls = new Map([[0, { id, name, arguments: rawArgs }]])
  const results = await pipeline.executeAll(calls, state)
  assert.equal(results.length, 1)
  return results[0]
}

export async function runSmoke() {
  const conversationId = \`partial-file-recovery-smoke-\${Date.now()}\`
  const emitter = makeEmitter()
  const state = createInitialState(true, timeouts)
  state.currentPlanItems = ['Write the deliverable']
  state.currentStepIdx = 0
  const pipeline = new ToolPipeline(emitter as any, conversationId)

  try {
    const partialContent = '# Draft\\\\nThis is the first recovered section.\\\\nIt is intentionally incomplete but substantive enough to save.\\\\n'
    const recovered = await call(
      pipeline,
      state,
      'partial1',
      'create_file',
      '{\\"path\\":\\"draft.md\\",\\"content\\":\\"' + partialContent,
    )
    assert.equal(recovered.isError, false, 'partial write should be recovered')
    assert.equal((recovered.result as any).recoveredFromPartial, true)
    assert.equal((recovered.result as any).partialWriteIncomplete, true)
    assert.equal(state.partialFileWriteRecoveryPending?.path, 'draft.md')
    assert.ok(state.partialFileWriteRecoveryPending.lines >= 3)

    const readRecovered = await readFileInSandbox(conversationId, 'draft.md')
    assert.match(String(readRecovered.content || ''), /first recovered section/)

    const visibleStartsBeforeBadContinuation = emitter.events.filter(event => event.type === 'tool_start').length
    const recreate = await call(
      pipeline,
      state,
      'create-again',
      'create_file',
      JSON.stringify({
        path: 'draft.md',
        content: '# Draft\\\\nThis would restart the file from the top and should be blocked because recovery is pending.',
        action_label: 'Continue recovered draft safely',
        plan_step_index: 1,
      }),
    )
    assert.equal(recreate.isError, true)
    assert.match(String((recreate.result as any).error), /recovered partial write/)
    assert.equal(
      emitter.events.filter(event => event.type === 'tool_start').length,
      visibleStartsBeforeBadContinuation,
      'blocked same-path recreate must not emit a visible tool_start pill',
    )

    const recreateElsewhere = await call(
      pipeline,
      state,
      'create-elsewhere',
      'create_file',
      JSON.stringify({
        path: 'draft-copy.md',
        content: '# Draft Copy\\\\nThis would dodge the partial recovery by starting a second deliverable path, so it must be blocked before it appears.',
        action_label: 'Restart recovered draft elsewhere',
        plan_step_index: 1,
      }),
    )
    assert.equal(recreateElsewhere.isError, true)
    assert.match(String((recreateElsewhere.result as any).error), /append_file call to "draft\.md"/)
    assert.equal(
      emitter.events.filter(event => event.type === 'tool_start').length,
      visibleStartsBeforeBadContinuation,
      'blocked different-path create must not emit a visible tool_start pill',
    )

    const editPending = await call(
      pipeline,
      state,
      'edit-pending',
      'edit_file',
      JSON.stringify({
        path: 'draft.md',
        old_string: 'first recovered section',
        new_string: 'first recovered section edited too early',
        action_label: 'Edit recovered draft too early',
        plan_step_index: 1,
      }),
    )
    assert.equal(editPending.isError, true)
    assert.match(String((editPending.result as any).error), /Do not call edit_file yet/)
    assert.equal(
      emitter.events.filter(event => event.type === 'tool_start').length,
      visibleStartsBeforeBadContinuation,
      'blocked edit during partial recovery must not emit a visible tool_start pill',
    )

    const appendElsewhere = await call(
      pipeline,
      state,
      'append-elsewhere',
      'append_file',
      JSON.stringify({
        path: 'other.md',
        content: '\\\\nThis continuation supplied the wrong path, but recovery should route it back to the saved draft file.',
        action_label: 'Append recovered draft elsewhere',
        plan_step_index: 1,
      }),
    )
    assert.equal(appendElsewhere.isError, false)
    assert.equal(state.partialFileWriteRecoveryPending, null)
    const readAfterRepairedAppend = await readFileInSandbox(conversationId, 'draft.md')
    assert.match(String(readAfterRepairedAppend.content || ''), /recovery should route it back to the saved draft file/)
  } finally {
    await rm(getSandboxDirPath(conversationId), { recursive: true, force: true })
  }
}
`, 'utf-8')

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

  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  await runSmoke()
  console.log('partial file recovery smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
