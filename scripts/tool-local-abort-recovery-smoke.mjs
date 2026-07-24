import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.tool-local-abort-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const toolsStubPath = join(workDir, 'tools-stub.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(toolsStubPath, `
export interface ToolContext { signal?: AbortSignal }

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const target = String(args.query || args.url || args.source || '')
  if (target.includes('outer-abort')) {
    ;(globalThis as any).__abortOuterTask?.()
    throw new DOMException('This operation was aborted', 'AbortError')
  }
  if (target.includes('local-abort')) {
    throw new DOMException('This operation was aborted', 'AbortError')
  }
  return { ok: true, name }
}
`, 'utf8')

  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}

const timeouts = {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 20,
}

function emitter() {
  return {
    toolStart() {}, toolResult() {}, browserFrame() {}, terminalOutput() {},
    fileContentStart() {}, fileContentDelta() {}, plan() {}, artifactCreated() {},
    creditEvent() {}, stepAdvance() {}, textDelta() {}, progressUpdate() {}, reasoningDelta() {},
    reasoningDone() {}, heartbeat() {}, done() {}, error() {}, close() {},
    async flush() {},
  }
}

function state() {
  const value = createInitialState(false, timeouts)
  value.taskStrategy = 'research'
  value.currentPhase = 'research'
  value.currentPlanItems = ['Gather official evidence', 'Write the answer']
  value.currentStepIdx = 0
  return value
}

function toolCall(id: string, name: string, target: string) {
  const args = {
    action_label: 'Gather official source evidence',
    plan_step_index: 1,
    ...(name === 'read_document' ? { url: target } : { query: target }),
  }
  return new Map([[0, { id, name, arguments: JSON.stringify(args) }]])
}

for (const name of ['web_search', 'image_search', 'read_document']) {
  const pipeline = new ToolPipeline(emitter() as any, undefined)
  const [result] = await pipeline.executeAll(
    toolCall('local-' + name, name, name === 'read_document' ? 'https://local-abort.example/report.pdf' : 'local-abort'),
    state(),
  )
  assert.equal(result.acceptedForExecution, true, name + ' local AbortError must remain an admitted tool attempt')
  assert.equal(result.isError, true, name + ' local AbortError must become a bounded error result')
  assert.match(JSON.stringify(result.result), /INTERNAL_RECOVERY/i, name + ' local AbortError must give the model a recovery result')
}

const outerController = new AbortController()
;(globalThis as any).__abortOuterTask = () => outerController.abort()
const outerPipeline = new ToolPipeline(emitter() as any, undefined, { signal: outerController.signal })
await assert.rejects(
  outerPipeline.executeAll(toolCall('outer-web-search', 'web_search', 'outer-abort'), state()),
  (error: any) => outerController.signal.aborted && /abort/i.test(String(error?.message || error)),
  'an outer task cancellation must still unwind instead of becoming a tool recovery result',
)

console.log('tool-local abort recovery smoke checks passed')
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['@sparticuz/chromium', 'playwright', 'fsevents'],
    plugins: [{
      name: 'tool-local-abort-stub',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\/lib\/tools$/ }, () => ({ path: toolsStubPath }))
      },
    }],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  delete globalThis.__abortOuterTask
  await rm(workDir, { recursive: true, force: true })
}
