import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.full-page-extraction-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { MAX_READABLE_PAGE_CHARS, parseReadableHtml, truncateReadablePageContent } from ${JSON.stringify(join(root, 'src/lib/browse.ts'))}
import { truncateResult } from ${JSON.stringify(join(root, 'src/lib/conversationSerialization.ts'))}

const sections = Array.from({ length: 24 }, (_, index) => {
  const number = index + 1
  const prose = ('Section ' + number + ' explains concrete product behavior, eligibility, permissions, workflows, limits, and operational details in complete sentences. ').repeat(6)
  return '<section><h2>Capabilities section ' + number + '</h2><p>' + prose + '</p><ul><li>Evidence point ' + number + 'A</li><li>Evidence point ' + number + 'B</li></ul></section>'
}).join('')

const html = '<!doctype html><html><head><title>Complete product guide</title><meta name="description" content="A detailed official guide to product capabilities and availability."></head><body>' +
  '<nav>Navigation chrome secret Pricing Products Sign in</nav>' +
  '<article class="promo"><p>Tiny promotional teaser that must not replace the real article.</p></article>' +
  '<main><article><h1>Complete product guide</h1>' + sections + '<p>FINAL_DEEP_ARTICLE_MARKER confirms the final readable section survived extraction.</p></article></main>' +
  '<aside>Unrelated recommendations and advertisements</aside>' +
  '<form><label>Newsletter chrome secret</label><input></form>' +
  '<footer>Footer chrome secret Cookie preferences</footer></body></html>'

const extracted = parseReadableHtml(html, 'https://example.com/help/complete-guide')
assert.equal(extracted.title, 'Complete product guide')
assert.ok(extracted.content.length > 12_000, 'the full long-form article must survive beyond the former 6,000-character cap')
assert.match(extracted.content, /## Capabilities section 24/, 'deep headings must retain readable structure')
assert.match(extracted.content, /- Evidence point 24B/, 'deep list items must retain readable structure')
assert.match(extracted.content, /FINAL_DEEP_ARTICLE_MARKER/, 'the end of an ordinary long article must be present')
assert.doesNotMatch(extracted.content, /Navigation chrome secret|Footer chrome secret|Newsletter chrome secret/, 'navigation, footer, and form chrome must be excluded')
assert.doesNotMatch(extracted.content, /Tiny promotional teaser/, 'a leading teaser article must not displace the substantive page')

const persisted = truncateResult({ title: extracted.title, content: extracted.content, url: extracted.url }) as { content: string }
assert.equal(persisted.content, extracted.content, 'ordinary long extracted pages must remain complete after persistence')

const renderedText = ('Rendered page section with exact current details and visible values. ').repeat(230) + 'FINAL_RENDERED_TEXT_MARKER'
const boundedRenderedText = truncateReadablePageContent(renderedText)
assert.ok(boundedRenderedText.length > 12_000, 'an explicit rendered-page content read must survive beyond the former 8,000-character cap')
assert.match(boundedRenderedText, /FINAL_RENDERED_TEXT_MARKER/, 'the end of an ordinary rendered page must remain available')

const oversizedHtml = '<html><head><title>Oversized guide</title></head><body><main><article><h1>Oversized guide</h1><p>' +
  'Bounded readable evidence sentence. '.repeat(2_400) +
  '</p></article></main></body></html>'
const oversized = parseReadableHtml(oversizedHtml, 'https://example.com/help/oversized')
assert.ok(oversized.content.length <= MAX_READABLE_PAGE_CHARS + 80, 'extraction must retain a hard bounded payload')
assert.match(oversized.content, /Truncated from \\d+ characters/, 'bounded extraction must disclose truncation')

const persistedOversized = truncateResult({ content: 'x'.repeat(60_000), url: 'https://example.com/too-long' }) as { content: string }
assert.ok(persistedOversized.content.length <= 40_020, 'persisted page content must keep the same safe upper bound')
assert.match(persistedOversized.content, /\\[truncated\\]$/, 'persisted over-limit pages must disclose truncation')

console.log(JSON.stringify({
  ok: true,
  extractedCharacters: extracted.content.length,
  preservedFinalHeading: true,
  preservedRenderedPageTail: true,
  chromeFiltered: true,
  maxReadablePageCharacters: MAX_READABLE_PAGE_CHARS,
}))
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
