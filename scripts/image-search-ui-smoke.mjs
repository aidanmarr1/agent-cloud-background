import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import sharp from 'sharp'

// Exercise the real component and app CSS without authenticating or mutating
// production conversations. Run the app build first to generate its styles.
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'agent-image-panel-qa-'))
const cssFiles = (await readdir(join(root, '.next/static/css'))).filter(file => file.endsWith('.css'))
assert.ok(cssFiles.length, 'Run the production build before this UI check.')
const css = (await Promise.all(cssFiles.map(file => readFile(join(root, '.next/static/css', file), 'utf8')))).join('\n')
const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#53796f' } }).png().toBuffer()
const bundled = await build({
  absWorkingDir: root,
  stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ImageSearchResults } from './src/components/computer/ImageSearchResults';
      const root = createRoot(document.getElementById('root'));
      window.showResult = (results, streaming = false) => root.render(
        <ImageSearchResults results={results} streaming={streaming} title="Image results: birds" />
      );
      window.showResult([], true);`,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/app.js') {
    response.setHeader('Content-Type', 'application/javascript')
    response.end(bundled.outputFiles[0].contents)
  } else if (path === '/app.css') {
    response.setHeader('Content-Type', 'text/css')
    response.end(css)
  } else if (path === '/bird.png') {
    response.setHeader('Content-Type', 'image/png')
    response.end(image)
  } else if (path.startsWith('/_next/static/media/')) {
    const file = path.slice('/_next/static/media/'.length)
    try {
      response.end(await readFile(join(root, '.next/static/media', file.replace(/[^a-zA-Z0-9_.-]/g, ''))))
    } catch {
      response.writeHead(404).end()
    }
  } else if (path === '/') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><html lang="en" class="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><body class="bg-bg-primary text-text-primary"><main id="root" class="mx-auto max-w-2xl min-h-screen"></main><script src="/app.js"></script></body></html>')
  } else {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ headless: true })
  const address = `http://127.0.0.1:${server.address().port}`
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(address)
    await page.getByRole('status', { name: 'Searching for images' }).waitFor()
    assert.equal(await page.getByText('No images found', { exact: true }).count(), 0)
    const saved = { title: 'Saved bird', thumbnailUrl: `${address}/bird.png`, localUrl: '/bird.png', sourceUrl: 'https://example.com/bird', saved: true }
    await page.evaluate(result => window.showResult(result), { images: [saved], warning: '1 of 2 downloaded images were saved. Use the saved image or retry the other source.' })
    await page.getByAltText('Saved bird').waitFor()
    await page.waitForFunction(() => document.querySelector('img')?.naturalWidth === 256)
    assert.equal(await page.getByRole('status', { name: 'Searching for images' }).count(), 0)
    await page.getByText('1 of 2 downloaded images were saved.', { exact: false }).waitFor()
    await page.screenshot({ path: join(temporary, `${name}-partial.png`), fullPage: true })
    await page.evaluate(result => window.showResult(result), { images: [{ ...saved, localUrl: '', saved: false }], warning: 'The source image has not been saved.' })
    await page.getByText('Source preview · not saved', { exact: true }).waitFor()
    await page.evaluate(() => window.showResult([], true))
    await page.getByRole('status', { name: 'Searching for images' }).waitFor()
    await page.evaluate(() => window.showResult({ images: [], error: 'Image provider temporarily unavailable.' }))
    await page.getByText('Image search unavailable', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'Image provider temporarily unavailable.' }).waitFor()
    assert.equal(await page.getByText('No images found', { exact: true }).count(), 0)
    await page.screenshot({ path: join(temporary, `${name}-error.png`), fullPage: true })
    await page.evaluate(() => window.showResult({ images: [] }))
    await page.getByText('No images found', { exact: true }).waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'No horizontal overflow')
    assert.deepEqual(errors, [], 'No browser errors')
    await page.close()
  }
  console.log(`Image panel loading, partial success, source previews, failures, and true empty states passed on desktop and mobile. Screenshots: ${temporary}`)
} catch (error) {
  await rm(temporary, { recursive: true, force: true })
  throw error
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
