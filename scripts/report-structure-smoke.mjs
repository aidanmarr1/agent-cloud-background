#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.report-structure-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  duplicateNumberedMarkdownH2Sections,
  markdownAppendStructureConflict,
  markdownTerminalSectionOrderingIssues,
} from ${JSON.stringify(join(root, 'src/lib/fileAppend.ts'))}
import { OutputVerifier } from ${JSON.stringify(join(root, 'src/lib/agent/OutputVerifier.ts'))}
import {
  appendFileInSandbox,
  createFileInSandbox,
  destroySandbox,
  readFileInSandbox,
} from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}

const paragraph = 'This section provides concrete evidence, architectural context, enterprise implications, limitations, and a clear interpretation of why the finding matters to decision makers. It is deliberately substantive so report verification can focus on structural corruption rather than minimum-length failures.'
const corruptedReport = [
  '# Comprehensive Research Report',
  '## Executive Summary',
  paragraph,
  '## 1. Evolution',
  paragraph,
  '## 2. Machine Learning Frameworks',
  paragraph,
  '## 3. Competitive Impact',
  paragraph,
  '## 4. Enterprise Impact',
  paragraph,
  '## 5. Conclusions',
  paragraph,
  '## 2. Architecture and Silicon Evolution',
  paragraph,
  '## References',
  '[1] https://example.com/source-one',
  '[2] https://example.org/source-two',
  '[3] https://example.net/source-three',
  '[4] https://example.edu/source-four',
  '[5] https://example.io/source-five',
  '## 3. Machine Learning Framework Architecture',
  paragraph,
].join('\\n\\n')

assert.deepEqual(
  duplicateNumberedMarkdownH2Sections(corruptedReport),
  ['2', '3'],
  'the completed-report regression must expose both restarted numbered sections',
)
assert.deepEqual(
  markdownTerminalSectionOrderingIssues(corruptedReport).map(issue => issue.laterHeading),
  ['2. Architecture and Silicon Evolution', '3. Machine Learning Framework Architecture'],
  'conclusions and references must both reject later substantive report sections',
)

const verifier = new OutputVerifier()
const verification = verifier.verify(
  corruptedReport,
  'deliverables/compile-comprehensive-research-report.md',
  'Create a comprehensive research report about architecture, evolution, and enterprise impact.',
  'research',
  null,
  3,
)
assert.equal(verification.passed, false)
assert.ok(
  verification.failures.some(failure => /duplicate numbered level-2 section headings: 2, 3/i.test(failure)),
  'final verification must reject duplicate numbered H2 sections',
)
assert.ok(
  verification.failures.some(failure => /restarts after its ending/i.test(failure)),
  'final verification must reject body sections appended after conclusions or references',
)
assert.ok(
  verification.suggestions.some(suggestion => /edit_file.*merge or remove repeated numbered sections/i.test(suggestion)),
  'recovery must direct a targeted edit instead of another append',
)

const completeReport = [
  '# Comprehensive Research Report',
  '## Executive Summary',
  paragraph,
  '## 1. Evolution',
  paragraph,
  '## 2. Frameworks',
  paragraph,
  '## Conclusion',
  paragraph,
  '## References',
  '[1] https://example.com/source',
].join('\\n\\n')

assert.match(
  markdownAppendStructureConflict(completeReport, '# A restarted report\\n\\nNew content') || '',
  /top-level report title/i,
)
assert.match(
  markdownAppendStructureConflict(completeReport, '## 2. Silicon Architecture\\n\\nNew content') || '',
  /numbered level-2 section 2 already exists/i,
)
assert.match(
  markdownAppendStructureConflict(completeReport, '## Sources\\n\\nhttps://example.org/duplicate') || '',
  /references\\/sources section already exists/i,
)
assert.match(
  markdownAppendStructureConflict(completeReport, '## Conclusions\\n\\nA second ending') || '',
  /conclusion section already exists/i,
)
assert.match(
  markdownAppendStructureConflict(completeReport, '## 6. Restarted Analysis\\n\\nNew content') || '',
  /cannot follow terminal section/i,
)
assert.equal(
  markdownAppendStructureConflict(completeReport, '\\nA final clarifying sentence in the existing references section.'),
  null,
  'paragraph-only continuation of the current section must remain valid',
)
assert.equal(
  markdownAppendStructureConflict(completeReport, '## Appendix\\n\\nSupporting material.'),
  null,
  'an appendix may follow the report references',
)
const ordinaryManuscript = [
  '# Chapter One',
  '## Reflection',
  'The first chapter closes with a reflection.',
].join('\\n\\n')
assert.equal(
  markdownAppendStructureConflict(
    ordinaryManuscript,
    '# Chapter Two\\n\\n## Reflection\\n\\nA new chapter may reuse a local subsection label.',
  ),
  null,
  'ordinary Markdown manuscripts may append a distinct chapter and reuse chapter-local H2 labels',
)
assert.match(
  markdownAppendStructureConflict(ordinaryManuscript, '# Chapter One\\n\\nA restarted copy.') || '',
  /top-level title.*already exists/i,
  'an exact repeated top-level title must still be rejected',
)
assert.deepEqual(
  duplicateNumberedMarkdownH2Sections([
    '# Markdown parser fixture',
    '## 1. Real section',
    '~~~md',
    '## 1. Example heading inside a code fence',
    '~~~',
  ].join('\\n')),
  [],
  'Markdown examples inside fenced code must not create false duplicate sections',
)

const conversationId = \`report-structure-smoke-\${Date.now()}\`
try {
  await createFileInSandbox(conversationId, 'deliverables/report.md', completeReport)
  const blockedAppend = await appendFileInSandbox(
    conversationId,
    'deliverables/report.md',
    '\\n\\n## 2. Architecture Restart\\n\\nThis must never reach the saved report.',
  )
  assert.match(String(blockedAppend.error || ''), /would corrupt the Markdown report structure/i)
  const afterBlockedAppend = await readFileInSandbox(conversationId, 'deliverables/report.md')
  assert.equal(afterBlockedAppend.content, completeReport, 'a structurally invalid append must leave the report byte-for-byte unchanged')

  const validAppend = await appendFileInSandbox(
    conversationId,
    'deliverables/report.md',
    '\\nA final source annotation that does not restart report structure.',
  )
  assert.equal(validAppend.error, undefined)
  const afterValidAppend = await readFileInSandbox(conversationId, 'deliverables/report.md')
  assert.match(String(afterValidAppend.content || ''), /final source annotation/)
} finally {
  await destroySandbox(conversationId)
}
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    external: ['@sparticuz/chromium', 'playwright'],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
  console.log('Report structure smoke checks passed.')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
