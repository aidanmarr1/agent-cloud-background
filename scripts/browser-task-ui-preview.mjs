import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Local-only fixture using real components and the production CSS. Inspect it
// with the browser UI tool; it never reads or writes production conversations.
const root = resolve(import.meta.dirname, '..')
const styles = (await readdir(join(root, '.next/static/css'))).filter(file => file.endsWith('.css'))
const css = (await Promise.all(styles.map(file => readFile(join(root, '.next/static/css', file), 'utf8')))).join('\n')
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: String.raw`
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { MarkdownLite } from './src/components/chat/MarkdownLite';
      import { TaskGroupView } from './src/components/chat/TaskGroupView';
      import { sanitizeNarrationText } from './src/lib/stream/cleaners';
      const finding = 'Confirmed Widget Pro 256GB Silver at A$1,999.00 total (A$83.29/mo. via Afterpay), with GST included in the listed price.';
      const source = location.origin + '/source/widget_pro/silver_256gb';
      const codeMark = String.fromCharCode(96);
      function App() {
        const [mobile, setMobile] = useState(false);
        const group = { id: 'fixture-phase', title: 'Verify the requested configuration', index: 0, status: 'done', subtasks: [], synthesis: '', narrations: [{ id: 'finding', text: finding, position: 0 }] };
        return <>
          <header className="p-4 text-text-secondary">
            <h1>Browser task regression preview</h1>
            <button className="mr-4" onClick={() => setMobile(false)}>Desktop width</button>
            <button onClick={() => setMobile(true)}>Mobile width</button>
          </header>
          <main style={{ width: mobile ? 390 : '100%', maxWidth: 860, padding: 24, margin: '24px auto' }}>
            <TaskGroupView group={group} />
            <section aria-label="Final answer" className="markdown-content chat-reading-text text-text-primary">
              <MarkdownLite>{'Widget Pro in Silver with 256GB is listed at **A$1,999 including GST**. Delivery charges are not confirmed.\n\nSource: ' + source + '.\n\n[Named product source](' + source + ')\n\nLiteral code: ' + codeMark + 'https://example.test/not-a-link' + codeMark}</MarkdownLite>
            </section>
            <p role="status">{sanitizeNarrationText('via Afterpay), with GST approx A$182.00 included; the selected variant satisfies the requested Silver colour and 256GB storage.') === null ? 'Fragment rejected; no broken progress text displayed.' : 'ERROR: fragment accepted'}</p>
          </main>
        </>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `,
    resolveDir: root, loader: 'tsx',
  },
  bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
})
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path === '/app.js') {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    response.end(bundle.outputFiles[0].contents)
  } else if (path === '/app.css') {
    response.setHeader('Content-Type', 'text/css; charset=utf-8')
    response.end(css)
  } else if (path.startsWith('/_next/static/media/')) {
    try { response.end(await readFile(join(root, '.next/static/media', path.split('/').pop()))) }
    catch { response.writeHead(404).end() }
  } else if (path === '/source/widget_pro/silver_256gb') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Verified local source</title><h1>Verified local source</h1><p>Widget Pro — Silver — 256GB — A$1,999 including GST.</p>')
  } else if (path === '/favicon.ico') {
    response.writeHead(204).end()
  } else if (path === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html lang="en" class="dark"><head><title>Browser task regression preview</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-bg-primary text-text-primary"><div id="root"></div><script src="/app.js"></script></body></html>')
  } else response.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => console.log(`Local browser task UI preview: http://127.0.0.1:${server.address().port}`))
