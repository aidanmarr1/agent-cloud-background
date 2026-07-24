import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.plan-step-zero-index-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}
import { toolDefinitions } from ${JSON.stringify(join(root, 'src/lib/tools.ts'))}

const timeouts = {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

const emitter = {
  toolStart() {}, toolResult() {}, terminalOutput() {}, artifactCreated() {},
  fileContentStart() {}, fileContentDelta() {}, flush: async () => {},
}

assert.ok(toolDefinitions.length > 0)
for (const tool of toolDefinitions) {
  const parameters = tool.function.parameters as {
    properties?: { plan_step_index?: { minimum?: number } }
  }
  assert.equal(
    parameters.properties?.plan_step_index?.minimum,
    1,
    \`\${tool.function.name} must constrain generated plan indexes to one-based values\`,
  )
}

async function execute(
  pipeline: ToolPipeline,
  state: ReturnType<typeof createInitialState>,
  id: string,
  planStepIndex: number,
) {
  const results = await pipeline.executeAll(new Map([[0, {
    id,
    name: 'read_file',
    arguments: JSON.stringify({
      path: 'missing.txt',
      action_label: 'Inspect workspace file',
      plan_step_index: planStepIndex,
    }),
  }]]), state)
  assert.equal(results.length, 1)
  return results[0]
}

const conversationId = \`plan-step-zero-index-recovery-\${Date.now()}\`
const state = createInitialState(false, timeouts)
state.currentPlanItems = ['Inspect the workspace file', 'Summarize the findings']
const pipeline = new ToolPipeline(emitter as any, conversationId)

try {
  state.currentStepIdx = 0
  const firstStep = await execute(pipeline, state, 'zero-based-first-step', 0)
  assert.equal(
    firstStep.acceptedForExecution,
    true,
    'an unambiguous zero-based first-step index must reach the tool handler',
  )
  assert.equal(
    JSON.parse(firstStep.tc.arguments).plan_step_index,
    1,
    'the admitted first-step call must be normalized to the runtime one-based index',
  )

  state.currentStepIdx = 1
  const ambiguousLaterStep = await execute(pipeline, state, 'ambiguous-later-step', 1)
  assert.equal(
    Boolean(ambiguousLaterStep.acceptedForExecution),
    false,
    'a later off-by-one index is ambiguous and must remain blocked',
  )
  assert.match(
    String((ambiguousLaterStep.result as { error?: string }).error),
    /declared plan_step_index 1 .*active step is 2/,
    'the later mismatch must still be rejected by the strict phase-safety guard',
  )
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
  console.log('plan step zero-index recovery smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
