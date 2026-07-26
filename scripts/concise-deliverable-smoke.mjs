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
console.log('concise deliverable smoke checks passed')
