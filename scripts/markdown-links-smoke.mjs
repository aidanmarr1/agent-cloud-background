import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(root, 'scripts/.markdown-links-smoke-'))
try {
  const bundle = join(temporary, 'runner.mjs')
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        import assert from 'node:assert/strict';
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { MarkdownLite } from './src/components/chat/MarkdownLite';
        const render = text => renderToStaticMarkup(<MarkdownLite>{text}</MarkdownLite>);
        const links = html => [...html.matchAll(/<a\\s[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
        assert.deepEqual(links(render('Source: https://shop.example.test/widget_pro/silver_256gb.')), ['https://shop.example.test/widget_pro/silver_256gb']);
        assert.deepEqual(links(render('See (https://example.test/articles/Widget_(device)).')), ['https://example.test/articles/Widget_(device)']);
        assert.deepEqual(links(render('<https://example.test/guide?q=birds&sort=new>')), ['https://example.test/guide?q=birds&amp;sort=new']);
        assert.deepEqual(links(render('[https://example.test/source](https://example.test/target)')), ['https://example.test/target'], 'link labels must not create nested anchors');
        assert.deepEqual(links(render('**Source https://example.test/item**')), ['https://example.test/item']);
        assert.deepEqual(links(render('\\x60https://example.test/code\\x60')), [], 'inline code must remain literal');
        assert.deepEqual(links(render('\\x60\\x60\\x60text\\nhttps://example.test/code\\n\\x60\\x60\\x60')), [], 'code blocks must remain literal');
        assert.deepEqual(links(render('[bad](javascript:alert) [bad](data:text/html,payload) [bad](//evil.test)')), [], 'unsafe schemes must remain inert');
        assert.deepEqual(links(render('[local](/chat/demo)')), ['/chat/demo']);
        const external = render('https://example.test/source');
        assert.match(external, /target="_blank"/);
        assert.match(external, /rel="noopener noreferrer"/);
        assert.doesNotMatch(render('<script>alert(1)</script>'), /<script>/, 'raw HTML must stay escaped');
        console.log('Markdown source links, punctuation, code, nested labels, and URL safety passed');
      `,
      resolveDir: root, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', outfile: bundle,
  })
  await import(pathToFileURL(bundle).href)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
