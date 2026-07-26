import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const loopSource = await readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8')
const paidProgressBranch = loopSource.slice(
  loopSource.indexOf("if (progressDecision.kind === 'stop')"),
  loopSource.indexOf("console.warn('[AgentDiagnostics] Recovered from paid no-progress cap by changing route") + 500,
)

assert.ok(
  paidProgressBranch.indexOf('canAdvanceResearchAfterPaidNoProgress(state)') >= 0,
  'the paid no-progress boundary must attempt deterministic research recovery',
)
assert.ok(
  paidProgressBranch.indexOf('canAdvanceResearchAfterPaidNoProgress(state)') <
    paidProgressBranch.indexOf("type: 'autonomous_route_change'"),
  'credible research recovery must run before the broader autonomous route change',
)
assert.match(
  paidProgressBranch,
  /planManager\.handleStepAdvance\(state\)[\s\S]*paid_no_progress_research_advance/,
  'paid no-progress recovery must use the normal plan transition and emit diagnostics',
)
assert.match(
  loopSource,
  /state\.autonomousRecoveryEscalations \+= 1[\s\S]*pendingActionSelectionRepairPrompt[\s\S]*phase = 'STREAMING'/,
  'paid internal/no-progress exhaustion must change route and keep the task streaming',
)
assert.doesNotMatch(
  paidProgressBranch,
  /state\.lastModelErrorForUser\s*=[\s\S]*phase = 'ERROR'/,
  'paid internal recovery exhaustion must not surface a retry-task error',
)
assert.match(
  loopSource,
  /singleAuthoritativeClaimsPacket[\s\S]*\\bextract\\b[\s\S]*stepResearchCallCount >= 2[\s\S]*stepVisitedUrls\.size >= 1/,
  'a bounded first-party claims extraction phase must advance after one authoritative page is opened and read',
)
assert.ok(
  loopSource.indexOf('singleAuthoritativeClaimsPacket') < loopSource.indexOf("if (depth.label === 'deep' || depth.label === 'wide') return false"),
  'task-wide deep research must not block completion of a bounded first-party claims extraction phase',
)
assert.match(
  loopSource,
  /exhaustedLaterPhaseDiscoveryPacket[\s\S]*depth\.label !== 'wide'[\s\S]*stepResearchCallCount >= 4[\s\S]*stepToolCallCount >= 6[\s\S]*stepSearchQueries\.size >= 4[\s\S]*stepSourceDomainCounts\.size >= 3/,
  'a later non-wide phase with prior opened evidence must survive an exhausted multi-domain discovery packet',
)
assert.match(
  loopSource,
  /const multiSourcePacket[\s\S]*state\.stepResearchCallCount >= 4[\s\S]*state\.stepToolCallCount >= 6[\s\S]*state\.stepVisitedUrls\.size >= 1[\s\S]*stepOpenedSourceDomains\(state\)\.size >= 1[\s\S]*state\.stepSourceDomainCounts\.size >= 2[\s\S]*state\.stepFailureCount >= 1/,
  'ordinary paid no-progress recovery must preserve one authoritative opened source after a broad mixed success/failure packet',
)
assert.match(
  loopSource,
  /const hasPriorOpenedEvidence[\s\S]*state\.currentStepIdx > 0[\s\S]*state\.visitedUrls\.size > state\.stepVisitedUrls\.size[\s\S]*state\.stepResearchCallCount >= 1[\s\S]*state\.stepToolCallCount >= 2[\s\S]*state\.stepSearchQueries\.size >= 1[\s\S]*state\.stepSourceDomainCounts\.size >= 2/,
  'later ordinary research phases must carry prior opened evidence through a bounded current multi-domain packet',
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

const bounded = makeResearchState()
bounded.originalUserRequest = 'Research about iphone 16'
bounded.planItems = [
  'Gather technical specifications and new features',
  'Analyze pricing and release details',
  'Synthesize findings and compile report',
]
bounded.currentPlanItems = [...bounded.planItems]
bounded.planScopes = [
  'Find specifications and features.',
  'Find pricing and availability.',
  'Write the report.',
]
bounded.currentPlanScopes = [...bounded.planScopes]
bounded.currentStepIdx = 1
bounded.taskComplexity = 3
bounded.stepResearchCallCount = 6
bounded.stepToolCallCount = 10
bounded.stepSearchQueries.add('iphone 16 pricing release availability')
bounded.visitedUrls.add('https://www.apple.com/iphone-16/specs/')
trackSourceDomain(bounded, [
  { url: 'https://www.apple.com/shop/buy-iphone/iphone-16' },
  { url: 'https://www.macworld.com/article/iphone-16-price-release-date.html' },
  { url: 'https://www.gsmarena.com/apple_iphone_16-13317.php' },
])
for (const url of [
  'https://www.apple.com/shop/buy-iphone/iphone-16',
  'https://www.macworld.com/article/iphone-16-price-release-date.html',
]) {
  bounded.stepVisitedUrls.add(url)
  bounded.visitedUrls.add(url)
  trackVisitedSourceDomain(bounded, url)
}
const boundedActions = policy.evaluate(
  bounded,
  new Map([[0, {
    id: 'bounded-source-read',
    name: 'read_document',
    arguments: JSON.stringify({ url: 'https://www.macworld.com/article/iphone-16-price-release-date.html' }),
  }]]),
  '',
  false,
  40,
)
assert.equal(bounded.currentStepIdx, 2, 'the exact later production phase must advance once its paid action budget has a useful evidence packet')
assert.ok(boundedActions.some(action => action.type === 'step_advance'), 'bounded evidence recovery must emit a step advance')
assert.ok(!boundedActions.some(action => action.type === 'terminate'), 'bounded evidence recovery must preserve the final synthesis step')

const blockedSources = makeResearchState()
blockedSources.originalUserRequest = 'Research about iphone 16'
blockedSources.planItems = [...bounded.planItems]
blockedSources.currentPlanItems = [...bounded.planItems]
blockedSources.planScopes = [...bounded.planScopes]
blockedSources.currentPlanScopes = [...bounded.planScopes]
blockedSources.currentStepIdx = 1
blockedSources.taskComplexity = 3
blockedSources.stepResearchCallCount = 1
blockedSources.stepToolCallCount = 10
blockedSources.stepSearchQueries.add('iphone 16 pricing release availability')
blockedSources.visitedUrls.add('https://www.apple.com/iphone-16/specs/')
trackSourceDomain(blockedSources, [
  { url: 'https://www.apple.com/shop/buy-iphone/iphone-16' },
  { url: 'https://www.macworld.com/article/iphone-16-price-release-date.html' },
  { url: 'https://www.gsmarena.com/apple_iphone_16-13317.php' },
])
blockedSources.stepFailureCount = 2
blockedSources.stepFailedSourceTargets.add('https://www.apple.com/shop/buy-iphone/iphone-16')
blockedSources.stepFailedSourceTargets.add('https://www.macworld.com/article/iphone-16-price-release-date.html')
const blockedActions = policy.evaluate(
  blockedSources,
  new Map([[0, {
    id: 'blocked-source-read',
    name: 'read_document',
    arguments: JSON.stringify({ url: 'https://www.macworld.com/article/iphone-16-price-release-date.html' }),
  }]]),
  '',
  false,
  40,
)
assert.equal(blockedSources.currentStepIdx, 1, 'search snippets plus two blocked sources must not count as opened evidence')
assert.ok(!blockedActions.some(action => action.type === 'step_advance'), 'the action budget must not synthesize from snippets-only current-phase evidence')

const underBudget = makeResearchState()
underBudget.originalUserRequest = 'Research about iphone 16'
underBudget.planItems = [...bounded.planItems]
underBudget.currentPlanItems = [...bounded.planItems]
underBudget.planScopes = [...bounded.planScopes]
underBudget.currentPlanScopes = [...bounded.planScopes]
underBudget.currentStepIdx = 1
underBudget.taskComplexity = 3
underBudget.stepResearchCallCount = 2
underBudget.stepToolCallCount = 3
underBudget.stepSearchQueries.add('iphone 16 pricing release availability')
trackSourceDomain(underBudget, [
  { url: 'https://www.apple.com/shop/buy-iphone/iphone-16' },
  { url: 'https://www.macworld.com/article/iphone-16-price-release-date.html' },
])
const underBudgetActions = policy.evaluate(
  underBudget,
  new Map([[0, {
    id: 'early-source-read',
    name: 'read_document',
    arguments: JSON.stringify({ url: 'https://www.apple.com/shop/buy-iphone/iphone-16' }),
  }]]),
  '',
  false,
  40,
)
assert.equal(underBudget.currentStepIdx, 1, 'a thin early packet must remain in the active research phase')
assert.ok(!underBudgetActions.some(action => action.type === 'step_advance'), 'the action budget must not cut ordinary research off early')

const oneDomain = makeResearchState()
oneDomain.originalUserRequest = 'Research about iphone 16'
oneDomain.planItems = [...bounded.planItems]
oneDomain.currentPlanItems = [...bounded.planItems]
oneDomain.planScopes = [...bounded.planScopes]
oneDomain.currentPlanScopes = [...bounded.planScopes]
oneDomain.currentStepIdx = 1
oneDomain.taskComplexity = 3
oneDomain.stepResearchCallCount = 6
oneDomain.stepToolCallCount = 10
oneDomain.stepSearchQueries.add('iphone 16 pricing release availability')
trackSourceDomain(oneDomain, [
  { url: 'https://www.apple.com/shop/buy-iphone/iphone-16' },
  { url: 'https://support.apple.com/en-au/121029' },
])
for (const url of [
  'https://www.apple.com/shop/buy-iphone/iphone-16',
  'https://www.apple.com/iphone-16/specs/',
]) {
  oneDomain.stepVisitedUrls.add(url)
  oneDomain.visitedUrls.add(url)
  trackVisitedSourceDomain(oneDomain, url)
}
const oneDomainActions = policy.evaluate(
  oneDomain,
  new Map([[0, {
    id: 'same-domain-read',
    name: 'browser_find_text',
    arguments: JSON.stringify({ query: 'price' }),
  }]]),
  '',
  false,
  40,
)
assert.equal(oneDomain.currentStepIdx, 1, 'a standard phase must not auto-advance from repeated work on one opened domain')
assert.ok(!oneDomainActions.some(action => action.type === 'step_advance'), 'standard action budgeting must retain the two-domain cross-source floor')

function makeEvidenceFloorState(request, title, scope) {
  const state = makeResearchState()
  state.originalUserRequest = request
  state.planItems = ['Gather background evidence', title, 'Write the final report']
  state.currentPlanItems = [...state.planItems]
  state.planScopes = ['Open initial sources', scope, 'Synthesize the evidence']
  state.currentPlanScopes = [...state.planScopes]
  state.currentStepIdx = 1
  state.taskComplexity = 3
  state.stepToolCallCount = 22
  state.stepResearchCallCount = 1
  state.stepSearchQueries.add('targeted evidence query')
  trackSourceDomain(state, [
    { url: 'https://source-a.example/article' },
    { url: 'https://source-b.example/article' },
    { url: 'https://source-c.example/article' },
    { url: 'https://source-d.example/article' },
  ])
  state.stepFailureCount = 2
  state.stepFailedSourceTargets.add('https://source-a.example/article')
  state.stepFailedSourceTargets.add('https://source-b.example/article')
  return state
}

const deepFloor = makeEvidenceFloorState(
  'Conduct deep, comprehensive research and write a cited report.',
  'Investigate the remaining evidence',
  'Open authoritative sources and evaluate contradictions.',
)
const deepFloorActions = policy.evaluate(
  deepFloor,
  new Map([[0, {
    id: 'deep-floor-read',
    name: 'read_document',
    arguments: JSON.stringify({ url: 'https://source-b.example/article' }),
  }]]),
  '',
  false,
  60,
)
assert.equal(deepFloor.currentStepIdx, 1, 'deep research must never use the ordinary action-budget shortcut')
assert.ok(!deepFloorActions.some(action => action.type === 'step_advance'), 'deep research must preserve its user-authored evidence floor')

for (const request of [
  'Compare at least five credible sources and save a cited Markdown report.',
  'Research the topic using six independent sources and write a report.',
]) {
  const explicitFloor = makeEvidenceFloorState(
    request,
    'Gather the remaining independent sources',
    'Open each requested source before synthesis.',
  )
  explicitFloor.stepToolCallCount = 10
  explicitFloor.stepResearchCallCount = 5
  for (const url of [
    'https://source-a.example/article',
    'https://source-b.example/article',
  ]) {
    explicitFloor.stepVisitedUrls.add(url)
    explicitFloor.visitedUrls.add(url)
    trackVisitedSourceDomain(explicitFloor, url)
  }
  explicitFloor.stepFailureCount = 0
  explicitFloor.stepFailedSourceTargets.clear()
  const explicitActions = policy.evaluate(
    explicitFloor,
    new Map([[0, {
      id: 'explicit-floor-read',
      name: 'read_document',
      arguments: JSON.stringify({ url: 'https://source-b.example/article' }),
    }]]),
    '',
    false,
    60,
  )
  assert.equal(explicitFloor.currentStepIdx, 1, 'explicit source-count requests must not advance below their source floor: ' + request)
  assert.ok(!explicitActions.some(action => action.type === 'step_advance'), 'explicit source-count evidence floors must bypass ordinary action budgeting: ' + request)
}

const fixedSearchFloor = makeEvidenceFloorState(
  'Research the topic with exactly five web searches, then write a report.',
  'Run exactly five web searches',
  'Use the five result sets before moving to synthesis.',
)
fixedSearchFloor.stepToolCallCount = 10
fixedSearchFloor.stepResearchCallCount = 1
fixedSearchFloor.stepFailureCount = 0
fixedSearchFloor.stepFailedSourceTargets.clear()
const fixedSearchActions = policy.evaluate(
  fixedSearchFloor,
  new Map([[0, {
    id: 'fixed-search',
    name: 'web_search',
    arguments: JSON.stringify({ query: 'second required search' }),
  }]]),
  '',
  false,
  60,
)
assert.equal(fixedSearchFloor.currentStepIdx, 1, 'fixed multi-search phases must stay active until their exact count is met')
assert.ok(!fixedSearchActions.some(action => action.type === 'step_advance'), 'all fixed-search-count tasks must bypass ordinary action budgeting')
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
