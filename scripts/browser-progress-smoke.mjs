import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.browser-progress-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { buildLocalWebsiteLaunch, stopLocalWebsiteServer } from ${JSON.stringify(join(root, 'src/lib/localWebsiteServer.ts'))}
import { browserActionPreflight, destroyBrowserSession } from ${JSON.stringify(join(root, 'src/lib/browser.ts'))}
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
  const results: Array<{ id: string; name: string; result: unknown }> = []
  return {
    results,
    toolStart() {},
    toolResult(id: string, name: string, result: unknown) { results.push({ id, name, result }) },
    terminalOutput() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
  }
}

async function call(
  pipeline: ToolPipeline,
  state: ReturnType<typeof createInitialState>,
  id: string,
  name: string,
  args: Record<string, unknown>,
  assistantContent = '',
) {
  const actionLabel = name === 'browser_navigate'
    ? 'Open smoke test page'
    : name === 'browser_action_sequence'
      ? 'Run smoke control sequence'
      : 'Activate smoke test control'
  const calls = new Map([[0, {
    id,
    name,
    arguments: JSON.stringify({
      action_label: actionLabel,
      plan_step_index: state.currentStepIdx + 1,
      ...args,
    }),
  }]])
  const results = await pipeline.executeAll(calls, state, assistantContent)
  assert.equal(results.length, 1)
  return results[0]
}

async function writePage(conversationId: string, path: string, body: string) {
  const html = \`<!doctype html>
<html>
  <head><title>Browser Progress Smoke</title></head>
  <body><main>\${body}</main></body>
</html>\`
  await createFileInSandbox(conversationId, path, html)
  return buildLocalWebsiteLaunch(conversationId, path)
}

export async function runSmoke() {
  const conversationId = \`browser-progress-smoke-\${Date.now()}\`
  const emitter = makeEmitter()
  const state = createInitialState(false, timeouts)
  state.taskStrategy = 'browse'
  state.originalUserRequest = 'Click the no-op once, recover, then click the next control'
  state.currentPlanItems = ['Interact with the smoke test website', 'Report result']
  state.currentPlanScopes = ['Use live browser controls only', 'Summarize']

  const pipeline = new ToolPipeline(emitter as any, conversationId)

  try {
    const launch = await writePage(conversationId, 'index.html', \`
      <button id="noop" type="button">No-op</button>
      <button id="next" type="button" onclick="document.body.dataset.next = 'yes'; document.querySelector('main').insertAdjacentHTML('beforeend', '<button id=&quot;done&quot; type=&quot;button&quot;>Done</button>')">Next</button>
    \`)

    const nav1 = await call(pipeline, state, 'nav1', 'browser_navigate', { url: launch.url })
    assert.equal(nav1.isError, false, 'navigation failed: ' + JSON.stringify(nav1.result))
    const firstSnapshot = await browserActionPreflight(conversationId)
    const noop = firstSnapshot.elements.find(element => /no-?op|noop/i.test(String(element.label || '') + ' ' + String(element.primary || '')))
    const next = firstSnapshot.elements.find(element => /next/i.test(element.label || element.primary))
    assert.ok(noop, 'expected no-op button, saw ' + JSON.stringify(firstSnapshot.elements))
    assert.ok(next, 'expected next button, saw ' + JSON.stringify(firstSnapshot.elements))

    const firstNoop = await call(pipeline, state, 'noop1', 'browser_click_at', { index: noop.index })
    assert.equal(firstNoop.isError, false)
    assert.equal(state.browserRecoveryRequired, true)
    assert.match(String((firstNoop.result as any).browserProgress?.kind), /no_progress/)

    const repeatedNoop = await call(pipeline, state, 'noop2', 'browser_click_at', { index: noop.index })
    assert.equal(repeatedNoop.isError, true)
    assert.match(String((repeatedNoop.result as any).error), /Repeated no-progress target blocked/)
    assert.match(String((repeatedNoop.result as any).content), /TARGET HINTS/)

    const recovery = await call(pipeline, state, 'shot1', 'browser_screenshot', {})
    assert.equal(recovery.isError, false)
    assert.equal(state.browserRecoveryRequired, false, 'screenshot recovery should clear repeat block')

    const allowedAfterRecovery = await call(pipeline, state, 'noop3', 'browser_click_at', { index: noop.index })
    assert.equal(allowedAfterRecovery.isError, false)
    assert.equal(state.browserRecoveryRequired, true)

    const differentTarget = await call(
      pipeline,
      state,
      'next1',
      'browser_click_at',
      { index: next.index },
      'Confirmed the smoke test state stayed unchanged after the first inspection of the local page. Next, I will verify the alternate path for visible progress.',
    )
    assert.equal(differentTarget.isError, false, 'different target failed: ' + JSON.stringify(differentTarget.result))
    assert.equal(state.browserRecoveryRequired, false, 'different target progress should clear repeat block')
    assert.equal((differentTarget.result as any).browserProgress?.kind, 'progress')

    const sequenceLaunch = await writePage(conversationId, 'sequence.html', \`
      <button id="open" type="button" onclick="document.querySelector('main').insertAdjacentHTML('beforeend', '<input id=&quot;late&quot; aria-label=&quot;Late field&quot; />')">Open panel</button>
    \`)
    await call(pipeline, state, 'nav2', 'browser_navigate', { url: sequenceLaunch.url })
    const sequenceSnapshot = await browserActionPreflight(conversationId)
    const open = sequenceSnapshot.elements.find(element => /open panel/i.test(element.label || element.primary))
    assert.ok(open, 'expected open panel button')

    const sequence = await call(pipeline, state, 'seq1', 'browser_action_sequence', {
      actions: [
        { action: 'click_at', args: { index: open.index } },
        { action: 'click_at', args: { index: open.index } },
      ],
    })
    assert.equal(sequence.isError, false)
    assert.match(String((sequence.result as any).content), /Sequence stopped early/)
  } finally {
    await destroyBrowserSession(conversationId)
    await stopLocalWebsiteServer(conversationId)
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
  console.log('browser progress smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
