import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const planManagerSource = await readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8')

assert.match(
  planManagerSource,
  /usePrecomputedPlan[\s\S]*compactSourceEvidencePhasesForTask\(titles, alignedScopes, state\.taskStrategy\)/,
  'route-precomputed plans must pass through source-evidence phase compaction',
)
assert.match(
  planManagerSource,
  /emitParsedPlan[\s\S]*compactSourceEvidencePhasesForTask\(enforcedTitles, alignedScopes, mappedTaskType\)/,
  'model-authored plans must pass through source-evidence phase compaction',
)
assert.match(
  planManagerSource,
  /fixedVisibleCount !== null \|\| explicitlySeparateSourcePhases/,
  'explicit visible counts and explicitly separate source phases must remain binding',
)

const workDir = await mkdtemp(join(root, 'scripts/.plan-phase-compaction-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { compactAdjacentSourceEvidencePhases } from ${JSON.stringify(join(root, 'src/lib/agent/PlanNormalization.ts'))}

const exactLivePlan = compactAdjacentSourceEvidencePhases(
  [
    'Find official source 1 on AI agent execution speed',
    'Find official source 2 on AI agent execution speed',
    'Find official source 3 on AI agent execution speed',
    'Compare the facts and answer in four concise bullets',
  ],
  [
    'Locate a current official primary source about AI agent execution speed and capture one comparable fact.',
    'Locate a current official primary source about AI agent execution speed and capture one comparable fact.',
    'Locate a current official primary source about AI agent execution speed and capture one comparable fact.',
    'Compare the gathered evidence and write the linked answer.',
  ],
)
assert.deepEqual(
  exactLivePlan.titles,
  [
    'Find three official sources on AI agent execution speed',
    'Compare the facts and answer in four concise bullets',
  ],
  'the exact live numbered-source plan must become one evidence-gathering phase',
)
assert.match(exactLivePlan.scopes[0] || '', /Gather the numbered sources in one evidence-gathering phase/)
assert.match(exactLivePlan.scopes[0] || '', /official primary source about AI agent execution speed/i)
assert.equal(exactLivePlan.scopes[1], 'Compare the gathered evidence and write the linked answer.')

const discoveryThenExtraction = compactAdjacentSourceEvidencePhases(
  ['Find three official sources', 'Extract one key fact per source', 'Write the answer'],
  [null, null, null],
)
assert.deepEqual(
  discoveryThenExtraction.titles,
  ['Find three official sources and extract one key fact per source', 'Write the answer'],
  'the original discovery-then-extraction compaction must remain intact',
)

const unrelatedTopics = compactAdjacentSourceEvidencePhases(
  [
    'Find official sources on model execution latency',
    'Extract security guidance from official deployment documentation',
    'Write the final assessment',
  ],
  [null, null, null],
)
assert.equal(unrelatedTopics.titles.length, 3, 'independent research topics must remain separate')

const unrelatedNumberedTopics = compactAdjacentSourceEvidencePhases(
  [
    'Find official source 1 on API latency',
    'Find official source 2 on deployment security',
    'Find official source 3 on model pricing',
    'Write the assessment',
  ],
  [null, null, null, null],
)
assert.equal(unrelatedNumberedTopics.titles.length, 4, 'numbered sources on unrelated topics must remain separate')

const comparisonPhase = compactAdjacentSourceEvidencePhases(
  [
    'Find three official sources',
    'Compare those sources and synthesize the answer',
  ],
  [null, null],
)
assert.equal(comparisonPhase.titles.length, 2, 'comparison/synthesis must remain its own phase')

const secondDiscovery = compactAdjacentSourceEvidencePhases(
  [
    'Find official sources on API latency',
    'Search for and read additional official sources',
  ],
  [null, 'Discover a second source set before extracting evidence.'],
)
assert.equal(secondDiscovery.titles.length, 2, 'a new source-discovery topic must not be folded into the first phase')

const fixedVisibleCount = compactAdjacentSourceEvidencePhases(
  [
    'Find official source 1 on API latency',
    'Find official source 2 on API latency',
    'Find official source 3 on API latency',
    'Write the answer',
  ],
  [null, null, null, null],
  { preserveVisibleStepCount: true },
)
assert.deepEqual(
  fixedVisibleCount.titles,
  [
    'Find official source 1 on API latency',
    'Find official source 2 on API latency',
    'Find official source 3 on API latency',
    'Write the answer',
  ],
  'an explicitly fixed visible phase count must be preserved exactly',
)

console.log('plan phase compaction smoke checks passed')
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
