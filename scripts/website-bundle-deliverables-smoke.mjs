import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.website-bundle-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  createWebsiteBundleInSandbox,
  destroySandbox,
  packageFilesInSandbox,
  readFileInSandbox,
  readSandboxFileBytes,
} from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}

const conversationId = 'website-bundle-smoke-' + Date.now()

try {
  const website = await createWebsiteBundleInSandbox(
    conversationId,
    'index.html',
    '<!doctype html><html><head><meta charset="utf-8"><title>Bundle test</title></head><body><main><h1>Bundle test</h1><button id="go">Go</button></main></body></html>',
    'html { color-scheme: dark; } body { margin: 0; font-family: system-ui; background: #111; color: #fff; } main { padding: 2rem; } button { padding: .75rem 1rem; }',
    'document.querySelector("#go")?.addEventListener("click", () => document.body.dataset.clicked = "true");',
  )

  assert.equal(website.path, 'index.html')
  assert.equal(website.files?.length, 4)
  assert.ok((website.size || 0) > 300)

  const bundled = await readFileInSandbox(conversationId, 'index.html')
  assert.match(bundled.content || '', /<style>[\\s\\S]*color-scheme: dark/)
  assert.match(bundled.content || '', /<script>[\\s\\S]*dataset\\.clicked/)
  assert.doesNotMatch(bundled.content || '', /href="styles\\.css"/)

  const editable = await readFileInSandbox(conversationId, 'website-src/index.html')
  assert.match(editable.content || '', /href="styles\\.css"/)
  assert.match(editable.content || '', /src="script\\.js"/)

  const archive = await packageFilesInSandbox(
    conversationId,
    'website-source.zip',
    ['website-src/index.html', 'website-src/styles.css', 'website-src/script.js', 'index.html'],
  )
  assert.equal(archive.path, 'website-source.zip')
  assert.ok((archive.size || 0) > (website.size || 0))
  const bytes = await readSandboxFileBytes(conversationId, 'website-source.zip')
  assert.equal(bytes.ok, true)
  if (bytes.ok) {
    assert.deepEqual([...bytes.body.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    assert.match(new TextDecoder().decode(bytes.body), /website-src\\/styles\\.css/)
  }
} finally {
  await destroySandbox(conversationId)
}
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  console.log('website bundle and deliverable smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
