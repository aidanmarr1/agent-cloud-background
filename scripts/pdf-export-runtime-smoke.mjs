import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.pdf-export-runtime-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { exportPdfFromSandbox } from ${JSON.stringify(join(root, 'src/lib/pdfExport.ts'))}
import { destroyBrowserSession } from ${JSON.stringify(join(root, 'src/lib/browser.ts'))}

process.env.AGENT_SANDBOX_PROVIDER = 'local'
const conversationId = 'pdf-export-smoke-' + Date.now()
const sandboxDir = getSandboxDirPath(conversationId)

try {
  const source = await createFileInSandbox(
    conversationId,
    'cover.html',
    '<!doctype html><html><head><title>Runtime PDF Smoke</title></head><body><main><h1>Runtime PDF Smoke</h1><p>This must become a native PDF document.</p></main></body></html>',
  )
  assert.doesNotMatch(String(source.content || ''), /^Error:/)

  const exported = await exportPdfFromSandbox(
    conversationId,
    'cover.html',
    'deliverables/cover.pdf',
    'Runtime PDF Smoke',
  )
  assert.equal(exported.error, undefined, JSON.stringify(exported))
  assert.equal(exported.path, 'deliverables/cover.pdf')
  assert.ok(Number(exported.size) > 512)
  assert.equal(exported.validated, true)
  assert.equal(exported.renderValidation?.previewNonBlank, true)
  assert.equal(exported.renderValidation?.horizontalOverflow, false)
  assert.match(String(exported.renderValidation?.bodyBackground || ''), /(?:255|fff)/i)

  const bytes = await readFile(join(sandboxDir, 'deliverables/cover.pdf'))
  assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-')

  const markdown = await createFileInSandbox(
    conversationId,
    'report.md',
    [
      '# Evidence report',
      '',
      'This finding is supported by the [primary source](https://example.com/research).',
      '',
      '| Measure | Result |',
      '| --- | ---: |',
      '| Completion | 42% |',
      '',
      '1. Review the evidence.',
      '2. Verify the conclusion.',
    ].join('\\n'),
  )
  assert.doesNotMatch(String(markdown.content || ''), /^Error:/)

  const markdownExport = await exportPdfFromSandbox(
    conversationId,
    'report.md',
    'deliverables/report.pdf',
    'Evidence report',
  )
  assert.equal(markdownExport.error, undefined, JSON.stringify(markdownExport))
  assert.equal(markdownExport.validated, true)
  assert.equal(markdownExport.renderValidation?.previewNonBlank, true)
  assert.equal(markdownExport.renderValidation?.horizontalOverflow, false)
  assert.ok(Number(markdownExport.renderValidation?.headingCount) >= 1)
  assert.ok(Number(markdownExport.renderValidation?.linkCount) >= 1)
  assert.ok(Number(markdownExport.renderValidation?.tableCount) >= 1)

  const markdownBytes = await readFile(join(sandboxDir, 'deliverables/report.pdf'))
  assert.equal(markdownBytes.subarray(0, 5).toString('ascii'), '%PDF-')
  console.log('PDF export runtime smoke checks passed')
} finally {
  await destroyBrowserSession(conversationId)
  await rm(sandboxDir, { recursive: true, force: true })
}
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    packages: 'external',
    logLevel: 'silent',
  })

  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
