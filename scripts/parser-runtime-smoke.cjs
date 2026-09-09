// Run with --no-experimental-require-module to match production's CJS loader.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const root = process.argv[2] || process.cwd()
const load = createRequire(resolve(root, 'package.json'))
const { JSDOM } = load('jsdom')
const { Readability } = load('@mozilla/readability')
const expected = require('../package.json').dependencies.jsdom
assert.equal(load('jsdom/package.json').version, expected, 'test the exact production parser version')
const paragraph = 'Review the agenda, collect the relevant documents, and prepare clear questions before the meeting. '
const dom = new JSDOM(`<html><head><title>Meeting preparation</title></head><body><main><h1>Meeting preparation</h1><p>${paragraph.repeat(8)}</p></main></body></html>`, { url: 'https://example.test/meeting' })
assert.equal(dom.window.document.querySelector('h1').textContent, 'Meeting preparation')
const article = new Readability(dom.window.document).parse()
assert.ok(article.textContent.includes(paragraph.trim()))
dom.window.close()
console.log('Production CommonJS parser loading and readable article extraction passed.')
