import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const loopSource = await readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8')
const paidProgressBranch = loopSource.slice(
  loopSource.indexOf("if (progressDecision.kind === 'stop')"),
  loopSource.indexOf("terminalReason = 'paid_no_progress_cap'") + "terminalReason = 'paid_no_progress_cap'".length,
)

assert.ok(
  paidProgressBranch.indexOf('canAdvanceResearchAfterPaidNoProgress(state)') >= 0,
  'the paid no-progress boundary must attempt deterministic research recovery',
)
assert.ok(
  paidProgressBranch.indexOf('canAdvanceResearchAfterPaidNoProgress(state)') <
    paidProgressBranch.indexOf("terminalReason = 'paid_no_progress_cap'"),
  'credible research recovery must run before the paid no-progress terminal error',
)
assert.match(
  paidProgressBranch,
  /planManager\.handleStepAdvance\(state\)[\s\S]*paid_no_progress_research_advance/,
  'paid no-progress recovery must use the normal plan transition and emit diagnostics',
)

const workDir = await mkdtemp(join(root, 'scripts/.research-loop-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  createInitialState,
  trackSourceDomain,
  trackToolCall,
  trackVisitedSourceDomain,
} from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { PolicyEngine } from ${JSON.stringify(join(root, 'src/lib/agent/PolicyEngine.ts'))}
import {
  hasCredibleResearchRecoveryPacket,
  researchDepthProfileForState,
} from ${JSON.stringify(join(root, 'src/lib/agent/ResearchDepth.ts'))}

const timeouts = {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function makeResearchState() {
  const state = createInitialState(false, timeouts)
  state.originalUserRequest = 'Research the current benefits and risks of multiple mobile sign-in methods in depth, then provide a concise answer.'
  state.planItems = [
    'Research current sign-in conversion, retention, and security evidence',
    'Synthesize a concise answer',
  ]
  state.currentPlanItems = [...state.planItems]
  state.planScopes = [
    'Open and compare current sources about Apple, Google, and email sign-in.',
    'Answer from the gathered evidence.',
  ]
  state.currentPlanScopes = [...state.planScopes]
  state.planEmitted = true
  state.currentStepIdx = 0
  state.currentPhase = 'research'
  state.taskStrategy = 'research'
  state.taskComplexity = 2
  state.dynamicIterationLimit = 40
  state.perStepBudget = 18
  state.deliverableStepBudget = 12
  state.iterations = 4
  return state
}

function makeLiveRerunState() {
  const state = makeResearchState()
  state.originalUserRequest = 'Explain why mobile apps should offer multiple sign-in methods such as Apple, Google, and email, with a concise summary of their impact on conversion, retention, and security.'
  state.planItems = [
    'Research user friction and drop-off from single sign-in',
    'Research conversion and retention evidence',
    'Research security and account recovery benefits',
    'Synthesize a concise answer',
  ]
  state.currentPlanItems = [...state.planItems]
  state.planScopes = [
    'Open evidence about sign-in friction.',
    'Open evidence about conversion and retention.',
    'Open evidence about security and recovery.',
    'Answer from the gathered evidence.',
  ]
  state.currentPlanScopes = [...state.planScopes]
  return state
}

function credibleTargets(state) {
  const profile = researchDepthProfileForState(state)
  const requiredOpenedPages = Math.min(
    profile.requiredSourceBreadth,
    Math.max(1, Math.ceil(profile.requiredCalls / 3)),
  )
  return {
    profile,
    calls: Math.min(profile.requiredCalls, Math.max(5, Math.ceil(profile.requiredCalls * 0.4))),
    pages: Math.min(requiredOpenedPages, Math.max(3, Math.ceil(requiredOpenedPages * 0.6))),
    domains: Math.min(
      profile.requiredSourceBreadth,
      Math.max(3, Math.ceil(profile.requiredSourceBreadth * 0.6)),
    ),
  }
}

function addCredibleOpenedEvidence(state) {
  const target = credibleTargets(state)
  state.stepResearchCallCount = target.calls
  state.stepToolCallCount = target.calls
  const sourceCount = Math.max(target.pages, target.domains)
  for (let i = 0; i < sourceCount; i++) {
    const url = \`https://source-\${i}.example/article\`
    if (i < target.pages) state.stepVisitedUrls.add(url)
    if (i < target.domains) trackVisitedSourceDomain(state, url)
  }
  return target
}

function addRepeatedRead(state) {
  const args = JSON.stringify({ url: 'https://source-0.example/article' })
  trackToolCall(state, 'read_document', args)
  trackToolCall(state, 'read_document', args)
  trackToolCall(state, 'read_document', args)
  return new Map([[0, { id: 'cached-repeat', name: 'read_document', arguments: args }]])
}

const credible = makeResearchState()
const target = addCredibleOpenedEvidence(credible)
assert.equal(
  hasCredibleResearchRecoveryPacket(credible),
  true,
  'several opened, distinct sources must form a credible recovery packet',
)
assert.ok(
  target.calls < target.profile.requiredCalls || target.domains < target.profile.requiredSourceBreadth,
  'the recovery packet must remain a partial-depth fallback, not ordinary depth completion',
)

const policy = new PolicyEngine()
const actions = policy.evaluate(credible, addRepeatedRead(credible), '', false, 40)
assert.equal(credible.currentStepIdx, 1, 'the first proven repeat must advance when credible evidence already exists')
assert.ok(actions.some(action => action.type === 'step_advance'), 'the recovery must emit a step advance')
assert.ok(!actions.some(action => action.type === 'terminate'), 'a recoverable cached-read loop must not terminate the run')

// Exact live failure shape: auto-extraction opened four distinct URLs across
// three domains, but recorded four research calls against a five-call floor.
const liveRerun = makeLiveRerunState()
const liveTarget = credibleTargets(liveRerun)
assert.equal(liveTarget.calls, 5, 'the fixture must preserve the live five-call recovery floor')
assert.equal(liveTarget.pages, 3, 'the fixture must preserve the live opened-page floor')
assert.equal(liveTarget.domains, 3, 'the fixture must preserve the live domain floor')
liveRerun.stepResearchCallCount = 4
liveRerun.stepToolCallCount = 4
for (const url of [
  'https://source-a.example/first',
  'https://source-b.example/second',
  'https://source-c.example/third',
  'https://source-a.example/fourth',
]) {
  liveRerun.stepVisitedUrls.add(url)
  trackVisitedSourceDomain(liveRerun, url)
}
assert.equal(
  hasCredibleResearchRecoveryPacket(liveRerun),
  true,
  'four opened pages across three domains must compensate for the one missing research action',
)
const liveActions = policy.evaluate(liveRerun, addRepeatedRead(liveRerun), '', false, 40)
assert.equal(liveRerun.currentStepIdx, 1, 'the exact live cached-read loop must advance deterministically')
assert.ok(liveActions.some(action => action.type === 'step_advance'), 'the live recovery must emit a step advance')
assert.ok(!liveActions.some(action => action.type === 'terminate'), 'the live recovery must not terminate the run')

const weak = makeResearchState()
const weakTarget = credibleTargets(weak)
weak.stepResearchCallCount = weakTarget.calls
weak.stepToolCallCount = weakTarget.calls
trackSourceDomain(weak, Array.from({ length: Math.max(weakTarget.pages, weakTarget.domains) }, (_, i) => ({
  url: \`https://candidate-\${i}.example/article\`,
})))
assert.equal(
  hasCredibleResearchRecoveryPacket(weak),
  false,
  'search-result candidates without opened pages must never qualify as credible recovery evidence',
)

const weakActions = policy.evaluate(weak, addRepeatedRead(weak), '', false, 40)
assert.equal(weak.currentStepIdx, 0, 'a repeated read without opened evidence must stay in the research phase')
assert.ok(!weakActions.some(action => action.type === 'step_advance'), 'weak evidence must not advance the plan')
assert.ok(!weakActions.some(action => action.type === 'terminate'), 'the first weak-evidence loop must redirect rather than terminate')
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['@sparticuz/chromium', 'playwright'],
    logLevel: 'silent',
  })

  await import(pathToFileURL(bundlePath).href)
  console.log('research loop recovery smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
