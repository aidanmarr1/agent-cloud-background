import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const planManagerSource = await readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8')
const promptsSource = await readFile(join(root, 'src/lib/prompts.ts'), 'utf8')

assert.doesNotMatch(
  planManagerSource,
  /compactPlanPhasesForTask|compactAdjacentSourceEvidencePhases|compactAdjacentArtifactLifecyclePhases/,
  'runtime planning must not deterministically merge or reshape model-authored phases',
)
assert.match(
  planManagerSource,
  /usePrecomputedPlan[\s\S]*applyCustomInstructionPlanRequirements\(titles, alignedScopes\)/,
  'route-precomputed plans must preserve the authored phase shape',
)
assert.match(
  planManagerSource,
  /emitParsedPlan[\s\S]*applyCustomInstructionPlanRequirements\(enforcedTitles, alignedScopes\)/,
  'model-authored plans must preserve the authored phase shape',
)
assert.match(
  promptsSource,
  /planning model owns the visible plan's wording, step count, boundaries, and order/i,
  'planner prompts must explicitly grant model control over the visible plan',
)
assert.doesNotMatch(
  promptsSource,
  /Research plans split by ANGLE|5-15 words|10-22 words|before a separate final synthesis/,
  'planner prompts must not force the old research template, word ranges, or separate synthesis phase',
)

console.log('model-authored plan autonomy smoke checks passed')
