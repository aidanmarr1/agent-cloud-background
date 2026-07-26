import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const [loopSource, pipelineSource, progressSource] = await Promise.all([
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/PaidModelTurnProgress.ts'), 'utf8'),
])

assert.match(
  pipelineSource,
  /schedulesRouteRecovery[\s\S]*internalRecovery:\s*'preflight_rejection'[\s\S]*preflightRejection:[\s\S]*code:/,
  'source-balance preflight rejections must retain a structured reason code',
)
assert.match(
  pipelineSource,
  /schedulesRouteRecovery = rejectionCode === 'research_source_balance'/,
  'unrelated preflight guards must retain their normal provider-history repair path',
)
assert.doesNotMatch(
  pipelineSource,
  /createHash|preflightRejection:[\s\S]{0,120}signature:/,
  'diagnostics must not persist a dictionary-attackable hash of raw tool arguments',
)
assert.match(
  pipelineSource,
  /researchSourceBalanceReason[\s\S]*preflightResult\(errorResult,\s*true,\s*'research_source_balance'\)/,
  'source-balance rejections must be classified instead of becoming invisible no-progress turns',
)
assert.match(
  pipelineSource,
  /state\.stepFailedSourceTargets\.clear\(\)/,
  'an executed search must start a fresh source-failure pool',
)
assert.match(
  loopSource,
  /lastToolResults\.every\(isPreflightRejectionRecovery\)[\s\S]*internalRecoveryScheduled = 'preflight_rejection'[\s\S]*type: 'action_rejected'/,
  'the agent loop must schedule bounded route recovery and diagnostics for rejected actions',
)
assert.match(
  loopSource,
  /const mustKeepSourceOnlyMenu[\s\S]*hasSearchCandidatesAwaitingOpen[\s\S]*state\.suppressedResearchToolName[\s\S]*\\? \[\]/,
  'an empty safe source menu must not fall back to the original unfiltered menu',
)
assert.match(
  loopSource,
  /activeTools = filtered\.length > 0[\s\S]*loopRecoveryToolForState\(state, filtered\)[\s\S]*:\s*\[\]/,
  'a fully suppressed recovery menu must stay empty instead of restoring the rejected tool',
)
assert.match(
  progressSource,
  /internalRecoveryScheduled\?:[\s\S]*'preflight_rejection'/,
  'paid-turn accounting must distinguish a handled preflight rejection from generic no progress',
)

const workDir = await mkdtemp(join(root, 'scripts/.research-preflight-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import {
  applyResearchPreflightRouteRecovery,
  releaseSearchAfterDistinctSourceFailures,
  researchSourceBalanceBlockReason,
} from ${JSON.stringify(join(root, 'src/lib/agent/ResearchPreflightRecovery.ts'))}

const state = createInitialState(false, {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
})
state.originalUserRequest = 'Research about iphone 16'
state.currentPlanItems = [
  'Gather technical specifications and new features',
  'Review pricing and market availability',
  'Compile findings into a markdown report',
]
state.currentPlanScopes = [
  'Find current specifications and features.',
  'Find current pricing and availability.',
  'Write the report.',
]
state.currentStepIdx = 0
state.currentPhase = 'research'
state.taskStrategy = 'research'
state.stepResearchCallCount = 1
state.stepToolCallCount = 2
state.stepSearchQueries.add('iphone 16 specifications features')
state.stepToolTypeCounts.set('web_search', 1)
state.stepSourceDomainCounts.set('apple.com', 1)
state.stepSourceDomainCounts.set('appleinsider.com', 1)
state.stepFailureCount = 1
state.workLedger.searchResults.push({
  stepIdx: 0,
  query: 'iphone 16 specifications features',
  domain: 'apple.com',
  url: 'https://www.apple.com/iphone-16/specs/',
  createdAt: Date.now(),
})

assert.match(
  researchSourceBalanceBlockReason('web_search', state) || '',
  /no opened or extracted source pages/,
  'the exact live route must reject another search while surfaced sources still need opening',
)

const emptySearchState = createInitialState(false, state.tierTimeouts)
emptySearchState.currentPlanItems = ['Research current availability', 'Answer']
emptySearchState.currentStepIdx = 0
emptySearchState.currentPhase = 'research'
emptySearchState.taskStrategy = 'research'
emptySearchState.stepSearchQueries.add('query with no results')
emptySearchState.stepToolTypeCounts.set('web_search', 1)
assert.equal(
  researchSourceBalanceBlockReason('web_search', emptySearchState),
  null,
  'a search with no concrete candidate URLs must not force an impossible source read',
)

applyResearchPreflightRouteRecovery(state, 'web_search', 'research_source_balance')
assert.equal(state.suppressedResearchToolName, 'web_search')
assert.equal(state.stepLoopDetections, 1)

releaseSearchAfterDistinctSourceFailures(
  state,
  'read_document',
  'https://www.apple.com/iphone-16/specs/?utm_source=test',
)
assert.equal(
  state.suppressedResearchToolName,
  'web_search',
  'one failed source must not reopen discovery',
)
releaseSearchAfterDistinctSourceFailures(
  state,
  'http_request',
  'https://www.apple.com/iphone-16/specs/#same-source',
)
assert.equal(
  state.suppressedResearchToolName,
  'web_search',
  'repeating the same normalized source through another tool must not count twice',
)
releaseSearchAfterDistinctSourceFailures(
  state,
  'browser_navigate',
  'https://support.apple.com/en-au/121029',
)
assert.equal(
  state.suppressedResearchToolName,
  null,
  'two distinct source-opening failures must release one fresh discovery search',
)
assert.equal(
  researchSourceBalanceBlockReason('web_search', state),
  null,
  'the single bounded fresh-search escape must be executable',
)

state.stepFailedSourceTargets.clear()
state.stepSearchQueries.add('iphone 16 official specifications')
state.stepToolTypeCounts.set('web_search', 2)
state.workLedger.searchResults.push({
  stepIdx: 0,
  query: 'iphone 16 official specifications',
  domain: 'support.apple.com',
  url: 'https://support.apple.com/en-au/121029',
  createdAt: Date.now(),
})
assert.match(
  researchSourceBalanceBlockReason('web_search', state) || '',
  /no opened or extracted source pages/,
  'after the fresh result set, source opening must become mandatory again',
)
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  })
  await import(`${bundlePath}?t=${Date.now()}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('Research preflight rejection recovery smoke passed.')
