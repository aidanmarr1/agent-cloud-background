import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.source-access-reliability-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { parsePublicReaderDocument } from ${JSON.stringify(join(root, 'src/lib/document.ts'))}

const source = 'https://example.com/research/full-report'
const parsed = parsePublicReaderDocument(
  'Title: Complete research report\\nURL Source: ' + source + '\\nPublished Time: 2026-08-30\\n\\nMarkdown Content:\\n# Complete research report\\n\\nThe first section contains exact evidence and context.\\n\\n## Findings\\n\\nThe final section contains the conclusive details and limitations.',
  source,
  'Fallback title',
)
assert.ok(parsed)
assert.equal(parsed.title, 'Complete research report')
assert.equal(parsed.source, source)
assert.match(parsed.content, /^# Complete research report/)
assert.match(parsed.content, /final section contains the conclusive details/)
assert.doesNotMatch(parsed.content, /URL Source|Markdown Content/)

assert.equal(
  parsePublicReaderDocument('AbuseAlleviationError: anonymous access temporarily blocked', source, 'Fallback'),
  null,
  'reader provider errors must not be mistaken for page evidence',
)
assert.equal(
  parsePublicReaderDocument('Title: Empty\\n\\nMarkdown Content:\\nNo text', source, 'Fallback'),
  null,
  'tiny reader responses must not be treated as usable evidence',
)
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
  console.log('Source access reliability smoke passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
