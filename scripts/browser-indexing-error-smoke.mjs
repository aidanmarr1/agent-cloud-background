import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.browser-indexing-error-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { buildLocalWebsiteLaunch, stopLocalWebsiteServer } from ${JSON.stringify(join(root, 'src/lib/localWebsiteServer.ts'))}
import { browserActionPreflight, browserNavigate, destroyBrowserSession } from ${JSON.stringify(join(root, 'src/lib/browser.ts'))}
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

async function writePage(conversationId: string, path: string, body: string) {
  const html = \`<!doctype html>
<html>
  <head><title>Browser Indexing Smoke</title></head>
  <body><main>\${body}</main></body>
</html>\`
  await createFileInSandbox(conversationId, path, html)
  return buildLocalWebsiteLaunch(conversationId, path)
}

async function call(pipeline: ToolPipeline, state: ReturnType<typeof createInitialState>, id: string, name: string, args: Record<string, unknown>) {
  const calls = new Map([[0, {
    id,
    name,
    arguments: JSON.stringify({ action_label: 'Use visible page control', plan_step_index: 1, ...args }),
  }]])
  const results = await pipeline.executeAll(calls, state)
  assert.equal(results.length, 1)
  return results[0]
}

export async function runSmoke() {
  const conversationId = \`browser-indexing-error-smoke-\${Date.now()}\`
  const state = createInitialState(false, timeouts)
  state.taskStrategy = 'browse'
  state.originalUserRequest = 'Add the item to cart, use the menu, checkout, and avoid error pages'
  state.currentPlanItems = ['Interact with the page', 'Report result']
  const pipeline = new ToolPipeline(makeEmitter() as any, conversationId)

  try {
    const launch = await writePage(conversationId, 'index.html', \`
      <button data-action="add-to-cart"><span>Add to Cart</span></button>
      <button aria-label="Open menu"><svg aria-hidden="true"><title>Menu icon</title><circle cx="5" cy="5" r="5"></circle></svg></button>
      <form><input type="submit" value="Checkout" /></form>
      <label role="radio" aria-checked="true" class="option-card" style="display:inline-flex; padding:12px; border:1px solid #333">
        <input type="radio" name="color" checked style="position:absolute; opacity:0; width:1px; height:1px" />
        Silver
      </label>
    \`)

    const nav = await browserNavigate(conversationId, launch.url)
    assert.equal(nav.success, true, 'expected normal page navigation to succeed')
    const snapshot = await browserActionPreflight(conversationId)
    const add = snapshot.elements.find(element => /add to cart/i.test(element.label + ' ' + element.primary))
    const menu = snapshot.elements.find(element => /open menu/i.test(element.label + ' ' + element.primary))
    const checkout = snapshot.elements.find(element => /checkout/i.test(element.label + ' ' + element.primary))
    const silver = snapshot.elements.find(element => /silver/i.test(element.label + ' ' + element.primary))

    assert.ok(add, 'expected add-to-cart control, saw ' + JSON.stringify(snapshot.elements))
    assert.equal(add.primary, 'button[data-action="add-to-cart"]')
    assert.ok(menu, 'expected aria-label icon button')
    assert.equal(menu.label, 'Open menu')
    assert.ok(checkout, 'expected submit input value to be indexed as Checkout')
    assert.equal(checkout.role, 'button')
    assert.ok(silver, 'expected custom label/radio option card')
    assert.equal(silver.role, 'radio')
    assert.equal(silver.checked || silver.selected, true)

    const hiddenCaptchaLaunch = await writePage(conversationId, 'hidden-captcha.html', \`
      <iframe src="/recaptcha-anchor" style="display:none; width:0; height:0"></iframe>
      <textarea name="g-recaptcha-response" hidden></textarea>
      <p>This page mentions captcha documentation, but it is not a verification challenge.</p>
      <button id="continue" type="button">Continue</button>
    \`)
    const hiddenCaptchaNav = await browserNavigate(conversationId, hiddenCaptchaLaunch.url)
    assert.equal(hiddenCaptchaNav.success, true, 'hidden/invisible captcha plumbing must not block normal navigation')
    const hiddenCaptchaSnapshot = await browserActionPreflight(conversationId)
    assert.equal(hiddenCaptchaSnapshot.pageBlocker, null, 'normal pages mentioning captcha must not poison pageBlocker')
    assert.ok(hiddenCaptchaSnapshot.elements.find(element => /continue/i.test(element.label + ' ' + element.primary)))

    const embeddedCaptchaLaunch = await writePage(conversationId, 'embedded-captcha.html', \`
      <h1>Research encyclopedia</h1>
      <p>This normal content-rich page remains usable while a small anti-spam widget is embedded beside a form.</p>
      <p>Parrotlets are small parrots with multiple species, habitats, behaviors, conservation notes, and care references. This paragraph gives the page enough readable article content that a small captcha widget cannot be mistaken for a full-page blocker.</p>
      <p>More article text explains range, taxonomy, diet, nesting, social behavior, and source citations for readers. The page should remain navigable and actionable.</p>
      <iframe title="reCAPTCHA challenge" src="/recaptcha-anchor" style="display:block; width:304px; height:78px; border:0"></iframe>
      <button id="read-more" type="button">Read more</button>
    \`)
    const embeddedCaptchaNav = await browserNavigate(conversationId, embeddedCaptchaLaunch.url)
    assert.equal(embeddedCaptchaNav.success, true, 'embedded captcha widgets on otherwise usable pages must not block navigation')
    const embeddedCaptchaSnapshot = await browserActionPreflight(conversationId)
    assert.equal(embeddedCaptchaSnapshot.pageBlocker, null, 'embedded captcha widgets must not poison a healthy pageBlocker')
    assert.ok(embeddedCaptchaSnapshot.elements.find(element => /read more/i.test(element.label + ' ' + element.primary)))

    const badGuessNav = await browserNavigate(conversationId, 'https://parrotlets.have/')
    assert.equal(badGuessNav.success, false, 'unresolvable guessed URL should fail')
    assert.match(String(badGuessNav.error), /does not resolve|network error/i)
    assert.doesNotMatch(String(badGuessNav.error), /page\.goto|ERR_NAME_NOT_RESOLVED/i)
    assert.match(String(badGuessNav.content), /recoverable navigation failure/)
    assert.doesNotMatch(String(badGuessNav.content), /different real URL|web_search|Do not retry/i)
    assert.doesNotMatch(String(badGuessNav.content), /CAPTCHA|bot\s+protection|hard\s+site\s+block/i)
    const repeatedBadGuess = await browserNavigate(conversationId, 'https://parrotlets.have/')
    assert.equal(repeatedBadGuess.success, false, 'same network miss should remain retryable instead of poisoning the session')
    assert.doesNotMatch(String(repeatedBadGuess.error), /already tried this URL earlier/)

    const challengeLaunch = await writePage(conversationId, 'challenge.html', \`
      <h1>Verify you are human</h1>
      <p>Complete the security challenge to continue.</p>
      <form id="challenge-form" style="display:block; padding:12px"><button type="button">Verify</button></form>
    \`)
    const challengeNav = await browserNavigate(conversationId, challengeLaunch.url)
    assert.equal(challengeNav.success, false, 'visible human-verification challenge should remain a blocker')
    assert.match(String(challengeNav.error), /CAPTCHA \\/ human-verification challenge/)

    const errorLaunch = await writePage(conversationId, 'error.html', \`
      <h1>Page not found</h1>
      <p>Sorry, this page doesn't exist.</p>
      <button id="trap" type="button">Click trap</button>
    \`)
    const errorNav = await browserNavigate(conversationId, errorLaunch.url)
    assert.equal(errorNav.success, false)
    assert.match(String(errorNav.error), /ERROR PAGE DETECTED|Page body contains error message|Page title/i)

    const errorSnapshot = await browserActionPreflight(conversationId)
    assert.ok(errorSnapshot.pageBlocker, 'expected failed page blocker state')
    const trap = errorSnapshot.elements.find(element => /click trap/i.test(element.label + ' ' + element.primary))
    assert.ok(trap, 'expected trap button to be indexed for evidence')

    const clickTrap = await call(pipeline, state, 'trap1', 'browser_click_at', { index: trap.index })
    assert.equal(clickTrap.isError, true)
    assert.match(String((clickTrap.result as any).error), new RegExp('marked as a failed/blocking page'))
    assert.doesNotMatch(String((clickTrap.result as any).content || ''), /TARGET HINTS/)

    const recoverAfter404 = await call(pipeline, state, 'nav-after-404', 'browser_navigate', { url: launch.url })
    assert.equal(recoverAfter404.isError, false, 'an exact 404 URL must not poison the whole domain')
    assert.equal((recoverAfter404.result as any).success, true, 'same-domain navigation after a 404 should still work')
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
  console.log('browser indexing/error smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
