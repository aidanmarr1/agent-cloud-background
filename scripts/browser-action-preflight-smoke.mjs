import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.browser-preflight-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import {
  browserActionPreflight,
  browserClickAt,
  browserNavigate,
  browserType,
  destroyBrowserSession,
} from ${JSON.stringify(join(root, 'src/lib/browser.ts'))}
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { buildLocalWebsiteLaunch, stopLocalWebsiteServer } from ${JSON.stringify(join(root, 'src/lib/localWebsiteServer.ts'))}

const html = String.raw\`<!doctype html>
<html>
  <head><title>Browser Preflight Smoke</title></head>
  <body>
    <main>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" />
      <button id="save" type="button" onclick="document.body.dataset.saved = 'true'">Save</button>
    </main>
  </body>
</html>\`

export async function runSmoke() {
  const conversationId = \`browser-preflight-smoke-\${Date.now()}\`

  try {
    await createFileInSandbox(conversationId, 'index.html', html)
    const launch = await buildLocalWebsiteLaunch(conversationId, 'index.html')
    const nav = await browserNavigate(conversationId, launch.url)
    assert.equal(nav.success, true)
    assert.match(nav.content || '', /Interactive elements/)

    const snapshot = await browserActionPreflight(conversationId)
    assert.equal(snapshot.hasSession, true)
    assert.equal(snapshot.indexedCount >= 2, true)

    const button = snapshot.elements.find(element => element.role === 'button' && /save/i.test(element.label || element.primary))
    const input = snapshot.elements.find(element => element.role === 'text-input' && /email/i.test(element.label || element.primary))
    assert.ok(button, 'expected Save button to be indexed')
    assert.ok(input, 'expected Email input to be indexed')

    const stale = await browserClickAt(conversationId, undefined, undefined, snapshot.maxIndex + 99)
    assert.equal(stale.success, false)
    assert.match(stale.error || '', /out of range|current elements list|highest valid index/i)
    assert.match(stale.content || '', /Interactive elements/)

    const wrongType = await browserType(conversationId, undefined, 'hello@example.com', false, button.index)
    assert.equal(wrongType.success, false)
    assert.match(wrongType.error || '', /NOT a text input/i)

    const malformedSelector = await browserType(conversationId, 'button[', 'hello@example.com', false)
    assert.equal(malformedSelector.success, false)
    assert.equal(malformedSelector.recoverable, true)
    assert.match(malformedSelector.content || '', /Interactive elements/)
    assert.ok(malformedSelector.screenshotBase64 || malformedSelector.screenshotPath || malformedSelector.screenshotUrl, 'automation failures should return a fresh visual frame')

    const typed = await browserType(conversationId, undefined, 'hello@example.com', false, input.index)
    assert.equal(typed.success, true)
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
  console.log('browser action preflight smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
