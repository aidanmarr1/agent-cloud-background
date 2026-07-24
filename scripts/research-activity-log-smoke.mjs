import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function runSourceContracts() {
  const { readFile } = await import('node:fs/promises')
  const [
    researchLog,
    toolPipeline,
    agentLoop,
    agentState,
    chatRoute,
    chatTaskRunner,
    taskJobs,
    prompts,
    planManager,
  ] = await Promise.all([
    readFile(join(root, 'src/lib/agent/ResearchActivityLog.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
    readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
  ])

  assert.match(researchLog, /create table if not exists task_research_activity/, 'hidden research activity must be DB-backed')
  assert.match(researchLog, /not agent memory and must not\s*\n\/\/ be used across fresh tasks/, 'research activity log must be documented as task-local runtime state only')
  assert.match(researchLog, /conversation_id text not null/, 'research log rows must attach to the task conversation')
  assert.match(researchLog, /searchLoopBlockReason/, 'research log must expose advisory search duplicate checks')
  assert.match(researchLog, /navigationLoopBlockReason/, 'research log must expose advisory navigation duplicate checks')
  assert.match(researchLog, /clearResearchActivityForTask/, 'fresh tasks must be able to clear hidden research logs')
  assert.match(toolPipeline, /recordResearchActivity/, 'ToolPipeline must record hidden research activity')
  assert.match(toolPipeline, /advisory memory, not a hard gate/, 'ToolPipeline must keep research activity advisory instead of hard-blocking tool calls')
  assert.match(toolPipeline, /appendResearchActivityEntry/, 'ToolPipeline must persist hidden research activity')
  assert.match(toolPipeline, /this\.trackInflightOperation\(persistence, 'research_activity_persistence', \{\}\)/, 'research telemetry writes must join the task execution drain')
  assert.doesNotMatch(toolPipeline, /await this\.recordResearchActivity/, 'tool execution must not await hidden research telemetry')
  assert.match(toolPipeline, /same execution drain used by the task's pre-terminal\/cancellation fence/, 'deferred telemetry must document its terminal ownership fence')
  const activityRepeatIndex = toolPipeline.indexOf('const activityRepeatReason')
  const cacheCheckIndex = toolPipeline.indexOf('// --- Check cache before execution ---')
  assert.ok(activityRepeatIndex >= 0 && cacheCheckIndex > activityRepeatIndex, 'ToolPipeline must compute research activity metadata before cache checks')
  const preExecutionActivityWrites = [
    ...toolPipeline.slice(activityRepeatIndex, cacheCheckIndex)
      .matchAll(/this\.recordResearchActivity\(state,\s*\{([\s\S]*?)\n\s*\}\)/g),
  ]
  for (const write of preExecutionActivityWrites) {
    assert.match(
      write[1],
      /success:\s*false/,
      'ToolPipeline must only persist blocked/failure activity before cache lookup or actual tool execution',
    )
  }
  assert.match(agentLoop, /loadResearchActivityEntries/, 'AgentLoop must hydrate hidden research activity')
  assert.match(agentLoop, /shouldInjectResearchActivityContext/, 'AgentLoop must gate hidden research context injection')
  assert.match(
    agentLoop,
    /const exhaustedKnownCandidateUrls = hasKnownCandidateUrls && !hasUnopenedCandidateUrls[\s\S]*const needsAlternateSourceRoute =[\s\S]*exhaustedKnownCandidateUrls/,
    'compact research must reopen alternate discovery routes after every known search result has been opened',
  )
  assert.match(agentLoop, /state\.currentPhase === 'research'/, 'AgentLoop must keep hidden research context during research phases')
  assert.doesNotMatch(agentLoop, /hasActivePlanStep && !state\.forceTextNextIteration\s*\?\s*researchActivityContext/, 'AgentLoop must not inject hidden research context into every active plan step')
  assert.match(agentState, /researchActivity: createResearchActivityIndex/, 'AgentState must mirror the hidden research activity log')
  assert.doesNotMatch(agentState, /researchActivityContext/, 'work summaries must not duplicate the hidden research log injected by AgentLoop')
  assert.match(chatTaskRunner, /clearResearchActivityForTask/, 'fresh isolated tasks must start with an empty hidden research log in the shared runner')
  assert.match(taskJobs, /runLocalPreTerminalBarrier[\s\S]*inflightToolDrain\(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS\)/, 'in-process completion and cancellation must drain deferred research telemetry')
  assert.match(taskJobs, /establishTerminalExecutionFence[\s\S]*drainInflightTools\(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS\)/, 'worker completion and cancellation must drain deferred research telemetry inside the ownership fence')
  assert.match(prompts, /hidden task research log is attached to this task in the database/i, 'system prompt must attach the hidden research log')
  assert.match(prompts, /Use the injected summary as compact memory/i, 'system prompt must treat the hidden research log as advisory compact memory')
  assert.match(planManager, /Use the hidden task research log as compact memory/i, 'per-step research rules must use the hidden log without hard preflight blocks')
}

async function runFunctionalChecks() {
  const workDir = await mkdtemp(join(root, 'scripts/.research-log-smoke-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'bundle.mjs')
  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  addResearchActivityToIndex,
  createResearchActivityIndex,
  deliberateRepeatReason,
  makeResearchActivityEntry,
  navigationLoopBlockReason,
  researchSearchCandidateCoverage,
  searchLoopBlockReason,
} from ${JSON.stringify(join(root, 'src/lib/agent/ResearchActivityLog.ts'))}
import { createInitialState, getWorkSummary } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { ToolCache } from ${JSON.stringify(join(root, 'src/lib/agent/ToolCache.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}

export async function runSmoke() {
  const taskA = createResearchActivityIndex()
  const taskB = createResearchActivityIndex()
  const base = {
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    stepTitle: 'Research risks',
    tool: 'web_search',
    kind: 'search',
    query: 'AI in education risks',
    normalizedQuery: 'ai in education risks',
    success: true,
  }
  addResearchActivityToIndex(taskA, makeResearchActivityEntry(base))

  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'AI in education risks' }), null, 'exact same-step search must remain advisory instead of hard-blocked')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'risks of AI in education' }), null, 'near-duplicate same-step search must remain advisory instead of hard-blocked')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 1, query: 'AI in education risks' }), null, 'new step may search the same topic again')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'AI in education risks', allowRepeatReason: 'explicit revisit' }), null, 'explicit repeat intent must allow repeat search')
  assert.equal(searchLoopBlockReason({ index: taskB, stepIdx: 0, query: 'AI in education risks' }), null, 'separate task index must start empty')

  addResearchActivityToIndex(taskA, makeResearchActivityEntry({
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    stepTitle: 'Research risks',
    tool: 'browser_navigate',
    kind: 'visit',
    url: 'https://example.com/report?utm_source=x#section',
    normalizedUrl: 'https://example.com/report',
    domain: 'example.com',
    success: true,
  }))
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report#other', domain: 'example.com' }), null, 'same URL revisit must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report', domain: 'example.com', allowRepeatReason: 'current step explicitly names this domain' }), null, 'domain-specific repeats must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report', domain: 'example.com', allowRepeatReason: 'explicit revisit' }), null, 'explicit revisit must allow same URL')

  addResearchActivityToIndex(taskA, makeResearchActivityEntry({
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    tool: 'browser_navigate',
    kind: 'failure',
    url: 'https://blocked.example.com/page',
    normalizedUrl: 'https://blocked.example.com/page',
    domain: 'blocked.example.com',
    success: false,
    error: 'navigation failed',
  }))
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://blocked.example.com/page', domain: 'blocked.example.com' }), null, 'failed routes must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://blocked.example.com/page', domain: 'blocked.example.com', allowRepeatReason: 'current step explicitly names this domain' }), null, 'domain-specific failed-route repeats must remain advisory instead of hard-blocked')

  assert.equal(deliberateRepeatReason({ objectiveText: 'Go back and revisit the same site', domain: 'example.com' }), 'explicit revisit/refresh instruction')

  const searchResults = [
    { stepIdx: 0, url: 'https://source-a.example/report?utm_source=search' },
    { stepIdx: 0, url: 'https://source-b.example/report' },
    { stepIdx: 1, url: 'https://later-step.example/report' },
  ]
  const partialCoverage = researchSearchCandidateCoverage({
    stepIdx: 0,
    searchResults,
    visitedUrls: ['https://source-a.example/report'],
  })
  assert.deepEqual(partialCoverage, {
    knownCandidateCount: 2,
    unopenedCandidateCount: 1,
  }, 'tracking params and other-step results must not hide the remaining source candidate')
  const exhaustedCoverage = researchSearchCandidateCoverage({
    stepIdx: 0,
    searchResults,
    visitedUrls: [
      'https://source-a.example/report',
      'https://source-b.example/report#section',
    ],
  })
  assert.deepEqual(exhaustedCoverage, {
    knownCandidateCount: 2,
    unopenedCandidateCount: 0,
  }, 'once every known result is opened, compact research must be able to search for new evidence')

  const routeState = createInitialState(false, {
    iterationTimeoutMs: 30_000,
    inactivityTimeoutMs: 30_000,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 100,
  })
  routeState.workLedger.searchResults = searchResults.map((result, index) => ({
    ...result,
    query: 'agent latency evidence',
    domain: new URL(result.url).hostname,
    title: 'Candidate ' + String(index + 1),
    createdAt: index,
  }))
  routeState.stepVisitedUrls.add('https://source-a.example/report')
  const routeSummary = getWorkSummary(routeState)
  assert.match(routeSummary, /Unopened search result routes:/, 'compact memory must prioritize source candidates not opened yet')
  assert.match(routeSummary, /https:\\/\\/source-b\\.example\\/report/, 'compact memory must preserve an actionable candidate URL for read_document')
  assert.doesNotMatch(routeSummary, /source-a\.example/, 'compact memory must not steer the model back to an already opened result')

  const timeouts = {
    iterationTimeoutMs: 30_000,
    inactivityTimeoutMs: 30_000,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 100,
  }
  const emitter = {
    toolStart() {}, toolResult() {}, terminalOutput() {}, artifactCreated() {},
    fileContentStart() {}, fileContentDelta() {}, flush: async () => {},
  }
  const cache = new ToolCache()
  const sourceArgs = {
    url: 'https://example.com/official-report',
    action_label: 'Read official report',
    plan_step_index: 1,
  }
  cache.set('read_document', sourceArgs, {
    title: 'Official report',
    content: 'Primary-source evidence for the deferred telemetry smoke.',
  })

  let releasePersistence = () => {}
  const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve })
  let persistenceStarted = 0
  let registeredDrain: ((timeoutMs: number) => Promise<{ settled: boolean; pendingCount: number; pendingToolNames: string[] }>) | null = null
  const pipeline = new ToolPipeline(emitter as any, 'deferred-research-activity-smoke', {
    cache,
    userId: 'user-1',
    creditRunId: 'run-1',
    researchActivityAppender: async () => {
      persistenceStarted += 1
      await persistenceGate
    },
    registerInflightToolDrain: (drain) => { registeredDrain = drain },
  })
  const state = createInitialState(false, timeouts)
  const execution = pipeline.executeAll(new Map([[0, {
    id: 'cached-source',
    name: 'read_document',
    arguments: JSON.stringify(sourceArgs),
  }]]), state)
  const executionRace = await Promise.race([
    execution.then((result) => ({ result })),
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
  ])
  assert.equal('timeout' in executionRace, false, 'tool execution must return before deferred Turso telemetry settles')
  assert.equal(persistenceStarted, 1, 'the hidden activity write must still start in the background')
  assert.ok(registeredDrain, 'ToolPipeline must register the shared execution/telemetry drain')
  assert.equal(state.suppressedResearchToolName, 'read_document', 'a cached source replay must suppress the repeated source route')
  assert.equal(state.stepLoopDetections, 1, 'a cached source replay must immediately enter loop recovery')
  assert.deepEqual(
    state.lastLoopSignal,
    { type: 'cross_tool_cycle', tool: 'read_document' },
    'cached source recovery must expose an alternate-route loop signal to the next paid turn',
  )

  let drainSettled = false
  const terminalOrCancellationDrain = registeredDrain!(1_000).then((result) => {
    drainSettled = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(drainSettled, false, 'terminal/cancellation drain must wait for deferred telemetry durability')
  releasePersistence()
  const drained = await terminalOrCancellationDrain
  assert.equal(drained.settled, true, 'terminal/cancellation drain must settle after telemetry persists')
  assert.equal(drained.pendingCount, 0)

  const warnings: string[] = []
  let failureDrain: typeof registeredDrain = null
  const failedPipeline = new ToolPipeline(emitter as any, 'failed-research-activity-smoke', {
    cache,
    userId: 'user-1',
    creditRunId: 'run-2',
    logger: {
      warn(message: string) { warnings.push(message) },
      info() {}, debug() {}, error() {},
    } as any,
    researchActivityAppender: async () => { throw new Error('telemetry unavailable') },
    registerInflightToolDrain: (drain) => { failureDrain = drain },
  })
  const failedExecution = await failedPipeline.executeAll(new Map([[0, {
    id: 'cached-source-with-telemetry-outage',
    name: 'read_document',
    arguments: JSON.stringify(sourceArgs),
  }]]), createInitialState(false, timeouts))
  assert.equal(failedExecution[0]?.isError, false, 'telemetry failure must never fail the tool or task')
  const failedDrainResult = await failureDrain!(1_000)
  assert.equal(failedDrainResult.settled, true, 'caught telemetry failures must leave no work outside the task fence')
  assert.equal(warnings.length, 1, 'telemetry failure must remain an operational warning')
}
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

    const { runSmoke } = await import(pathToFileURL(bundlePath).href)
    await runSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await runSourceContracts()
await runFunctionalChecks()
console.log('research activity log smoke checks passed')
