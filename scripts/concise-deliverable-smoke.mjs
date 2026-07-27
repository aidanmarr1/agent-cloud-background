import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createJiti } from 'jiti'

const root = process.cwd()
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': resolve(root, 'src'),
  },
})
const { OutputVerifier } = await jiti.import(resolve(root, 'src/lib/agent/OutputVerifier.ts'))

const request =
  'Create a concise Markdown note with a heading and three bullet points explaining immediate live task-stream updates.'
const content = `# Benefits of Immediate Live Task-Stream Updates

- Real-time visibility gives stakeholders immediate progress without manual checks.
- Early issue detection exposes errors and bottlenecks before they grow.
- Shared live context keeps collaborators aligned on the current task state.

This focused note captures why genuine streamed updates make autonomous work easier to trust.`

const result = new OutputVerifier().verify(
  content,
  'deliverables/live-stream-verification.md',
  request,
  'unknown',
  null,
  1,
)

assert.equal(result.passed, true, `a complete concise note must not trigger an unnecessary append: ${result.failures.join('; ')}`)

const compactBrowserResult = new OutputVerifier().verify(
  `# Live Check Report

## Page Details

**Source URL:** https://example.com
**Page Title:** Example Domain`,
  'live-check.md',
  'Open https://example.com, read its current page title, then create live-check.md with the title and source URL. Keep the final response brief.',
  'browse',
  null,
  1,
)

assert.equal(
  compactBrowserResult.passed,
  true,
  `a concise structured browser result must not be expanded into an action report: ${compactBrowserResult.failures.join('; ')}`,
)

const handoffBriefBrowserReport = new OutputVerifier().verify(
  `# Live Check Report

## Page Details

**Source URL:** https://example.com
**Page Title:** Example Domain`,
  'source-report.md',
  'Open https://example.com and create a substantive report in source-report.md with the title and source URL. Keep the final response brief.',
  'browse',
  null,
  3,
)

assert.equal(
  handoffBriefBrowserReport.passed,
  false,
  'brief final handoff wording must not weaken verification for the saved report itself',
)
console.log('concise deliverable smoke checks passed')
