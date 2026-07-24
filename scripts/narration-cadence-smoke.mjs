import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [dispatcher, prompts, taskGroupView, actionFeed, taskSlice, globals, computerPanel, uiStore, policyEngine, streamProcessor, config, toolPipeline, agentLoop, cleaners, agentState, narrationMemory] = await Promise.all([
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
    readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/ActionFeed.tsx'), 'utf8'),
    readFile(join(root, 'src/store/chat/taskSlice.ts'), 'utf8'),
    readFile(join(root, 'src/app/globals.css'), 'utf8'),
    readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
    readFile(join(root, 'src/store/ui.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/cleaners.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/NarrationMemory.ts'), 'utf8'),
  ])

  assert.match(dispatcher, /MIN_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*3/, 'narration must not flush before 3 visible actions')
  assert.match(dispatcher, /MAX_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*4/, 'narration must not wait past 4 visible actions')
  assert.doesNotMatch(dispatcher, /IMMEDIATE_SOURCE_NARRATION_TOOLS/, 'source-result narration must not bypass the 3-4 action cadence')
  assert.doesNotMatch(dispatcher, /shouldFlushModelNarrationImmediately/, 'web-search narration must not flush early')
  assert.doesNotMatch(dispatcher, /generateAutoNarration/, 'client must not invent narration from tool results')
  assert.match(dispatcher, /targetNarrations\.some\(narration => narration\.position === safePosition\)/, 'client must reject multiple narration blocks in the same action gap')
  assert.match(dispatcher, /addGroupNarration\(this\.conversationId,\s*groupIdx,\s*narrationText,\s*safePosition\)/, 'dispatcher must persist the exact captured-frontier narration position')
  assert.match(taskSlice, /addGroupNarration: \(convId: string, groupIndex: number, text: string, position\?: number\)/, 'store action must accept the dispatcher-computed narration position')
  assert.match(taskSlice, /const subtasks = taskSubtasks\(g\)[\s\S]*Math\.max\(0,\s*Math\.min\(subtasks\.length,\s*position \?\? subtasks\.length\)\)/, 'store must clamp narration positions to the current frontier')
  assert.match(taskGroupView, /\.sort\(\(a, b\) => a\.position - b\.position\)/, 'main task view must render narrations in position order')
  assert.match(actionFeed, /orderedGroups\.map[\s\S]*<TaskGroupView/, 'action feed must delegate each group to the narration-aware task view')
  assert.match(dispatcher, /if \(this\.toolsSinceLastNarration >= TOOLS_BETWEEN_NARRATION_FLUSHES\)/, 'narration flushing must follow the global visible-action count')
  assert.match(dispatcher, /narrationInsertionPosition/, 'client must calculate the exact 3-4 action narration insertion boundary')
  assert.match(dispatcher, /Never insert it between completed/, 'late narration recovery must attach at the current frontier, not inside old history')
  assert.match(dispatcher, /discardNarrationBuffer/, 'early narration buffers must be discarded instead of carried into later tool gaps')
  assert.doesNotMatch(dispatcher, /lastPosition \+ MAX_TOOLS_BETWEEN_NARRATION_FLUSHES/, 'late narration must never be backfilled at an old fourth-action boundary')
  assert.match(dispatcher, /if \(!force && !this\.isNarrationCadenceReady\(\)\) return false[\s\S]*?const text = this\.narrationBuf\.flush\(\)/, 'client must keep buffered model narration until the 3-action cadence is ready')
  assert.match(dispatcher, /handleStepAdvance[\s\S]{0,180}this\.flushNarration\(true\)/, 'step transitions must flush required phase-end model narration even before the normal 3-action cadence')
  assert.doesNotMatch(dispatcher, /handleStepAdvance[\s\S]{0,180}this\.toolsSinceLastNarration = 0/, 'normal step transitions must not reset the global narration cadence')
  assert.match(dispatcher, /setComputerPanelActiveItemId\(panelFocusIdForTool\(event\.name,\s*event\.id\)\)/, 'new tool starts must focus their live computer panel item')
  assert.match(computerPanel, /computerPanelActiveItemId/, 'computer panel must follow the explicit active item pointer')
  assert.match(uiStore, /setComputerPanelActiveItemId/, 'UI store must expose the active computer item pointer')
  assert.match(policyEngine, /acceptProgressNarration/, 'backend policy must use centralized narration acceptance')
  assert.match(policyEngine, /Narration is observational UI feedback, never a phase transition gate/, 'phase transitions must fail open when narration is absent')
  assert.doesNotMatch(policyEngine, /NARRATION CADENCE RECOVERY|NARRATION CADENCE MISSED|PHASE-END NARRATION REQUIRED/, 'policy must not create narration-only recovery turns')
  assert.doesNotMatch(policyEngine, /rewriteInvalidForcedNarrationAction|forcedNarrationBeforeToolAction/, 'invalid or duplicate narration must not enter repair loops')
  assert.match(narrationMemory, /reviewProgressNarration/, 'narration acceptance must validate novelty against recent updates')
  assert.match(narrationMemory, /narrationSimilarity/, 'narration acceptance must reject close paraphrases, not only exact strings')
  assert.doesNotMatch(narrationMemory, /deterministicCadenceFallback|completedWorkLogNarration/, 'cadence narration must never be synthesized by a local fallback')
  assert.match(narrationMemory, /minLength:\s*1/, 'the cadence schema must require non-empty model-authored text')
  assert.match(narrationMemory, /visibleToolActionsSinceLastNarration \+ 1/, 'a missed cadence attempt at action 3 must retry at action 4')
  assert.match(narrationMemory, /retryNarrationCadenceAttemptWithoutNewAction/, 'a failed cadence stream must keep narration due at the same completed-action frontier')
  assert.match(narrationMemory, /retryNarrationCadenceAfterNoProgress[\s\S]*acceptedNarration[\s\S]*acceptedVisibleAction/, 'a successful cadence stream must only consume cadence after accepted narration or an accepted visible action')
  assert.match(agentLoop, /phaseEndNarrationPending/, 'agent loop must track phase-end narration separately from ordinary progress narration')
  assert.match(agentLoop, /goalCheck\.allMet[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'goal-complete auto-advance must offer phase-end narration without letting it deadlock advancement')
  assert.match(agentLoop, /put <next_step\/> on its own final line/, 'compact phase-end narration must include the next_step marker instruction')
  assert.match(agentState, /phaseNarrationEmittedThisStep: boolean/, 'agent state must track whether the active phase has an accepted LLM narration')
  assert.match(agentState, /needsPhaseNarrationBeforeAdvance/, 'agent state must expose the per-phase narration invariant')
  assert.match(policyEngine, /function hasStalledResearchEvidence/, 'research narration cadence must not turn same-source loops into endless status turns')
  assert.match(policyEngine, /advanceStalledResearchWithGap/, 'stalled research with real evidence must move on with a recorded gap')
  assert.doesNotMatch(agentState, /tool === 'browser_screenshot' \|\| tool === 'browser_get_content'/, 'browser_get_content must not be exempt from loop detection')
  assert.match(agentLoop, /function shouldUseNaturalCadenceNarration[\s\S]*visibleToolActionsSinceLastNarration < state\.narrationNextAttemptAt[\s\S]*return true/, 'runtime must open the deterministic cadence window')
  assert.match(agentLoop, /const launchNarrationSidecarIfDue[\s\S]*beginNarrationCadenceAttempt\(state\)[\s\S]*createCompletion\(/, 'cadence must use its own compact LLM lane')
  assert.match(agentLoop, /lastToolResults = await toolPipeline\.executeAll\([\s\S]*launchNarrationSidecarIfDue\(\)/, 'narration must launch after completed actions without delaying tool execution')
  assert.match(agentLoop, /narrationSidecarPromise[\s\S]*if \(narrationSidecarPromise\) return/, 'only one asynchronous narration request may run at a time')
  assert.match(agentLoop, /reasoning:\s*NO_THINKING_REASONING[\s\S]*requestTimeoutMs:\s*NARRATION_SIDECAR_REQUEST_TIMEOUT_MS[\s\S]*retryMaxAttempts:\s*0/, 'the narration lane must be a fast bounded non-thinking request')
  assert.match(agentLoop, /remainingVisibleActions[\s\S]*visibleToolActionsSinceLastNarration - visibleActionFrontier[\s\S]*resetCadence:\s*true/, 'actions completed during narration generation must remain in the next cadence window')
  assert.match(agentLoop, /workLogFrontier[\s\S]*recordStepIdx[\s\S]*recordIteration/, 'asynchronous narration must retain its captured evidence frontier')
  assert.match(agentLoop, /this\.emitter\.progressUpdate\(review\.text,\s*\{[\s\S]*stepIndex:\s*recordStepIdx,[\s\S]*afterToolId,[\s\S]*remainingVisibleActions,[\s\S]*\}\)/, 'accepted LLM narration must carry its captured action frontier in the explicit progress event')
  assert.match(agentLoop, /catch \(error\)[\s\S]*retryNarrationCadenceAttemptWithoutNewAction\(state\)[\s\S]*without blocking task actions/, 'a failed narration request must remain due without blocking work')
  assert.match(agentLoop, /const cadenceNarrationInMainTurn = false/, 'ordinary action calls must not depend on a provider-specific narration tool field')
  assert.match(agentLoop, /Lead with the genuinely new result or progress/, 'sidecar narration must lead with the newest completed result')
  assert.doesNotMatch(agentLoop, /Distinct upcoming focus/, 'sidecar narration must not be seeded with a broad next-plan-phase cue')
  assert.match(agentLoop, /this narration-only request has no selected next action[\s\S]*Keep it result-only[\s\S]*do not use "Next"/, 'sidecar narration must stay result-only when no immediate action is actually beginning')
  assert.match(agentLoop, /the most recent update already used a forward transition[\s\S]*keep this update result-only/, 'sidecar narration must avoid repetitive consecutive Next transitions')
  assert.match(agentLoop, /asynchronous narration-only request has no selected next action[\s\S]*keep it result-only/, 'sidecar system instruction must not invent a future transition')
  assert.match(narrationMemory, /A second sentence beginning "Next, \.\.\." is optional, never required, and never a template[\s\S]*after the completed finding[\s\S]*exact concrete action this same tool-call response is beginning immediately/, 'native cadence schema must preserve natural optional Next phrasing for the action beginning in the same response')
  assert.match(agentLoop, /const settleNarrationSidecar = async[\s\S]*await settleNarrationSidecar\(\)[\s\S]*const totalUsage/, 'terminal completion must not race an already-running narration debit/event')
  assert.match(agentLoop, /narrationIntentEpoch \+= 1[\s\S]*narrationSidecarAbortController\?\.abort/, 'a newer live directive must supersede an obsolete in-flight narration')
  assert.match(dispatcher, /case 'progress_update':[\s\S]*handleProgressUpdate\(event\)/, 'client must route the complete explicit progress event with placement metadata')
  assert.match(dispatcher, /handleProgressUpdate[\s\S]*requireSignal:\s*false[\s\S]*progressUpdateGroupIndex\(event\.stepIndex\)[\s\S]*afterToolId[\s\S]*addNarrationAt\(targetGroupIdx,\s*narrationText,\s*targetPosition\)[\s\S]*reconcileNarrationCadence\(remainingVisibleActions\)/, 'server-accepted progress must render at its captured plan-step and action frontier')
  assert.match(dispatcher, /const safePosition = Math\.max[\s\S]*addGroupNarration\(this\.conversationId,\s*groupIdx,\s*narrationText,\s*safePosition\)/, 'client narration insertion must clamp the captured position before storing it')
  assert.match(streamProcessor, /this\.emitter\.progressUpdate\(text\)/, 'legacy structured cadence updates must share the explicit event transport')
  assert.doesNotMatch(policyEngine, /visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT/, 'ordinary assistant prose must not be remembered when the client may discard it')
  assert.doesNotMatch(agentLoop, /Retry one concise completed-result progress paragraph now/, 'stream recovery must never retry narration instead of work')
  assert.doesNotMatch(toolPipeline, /acceptProgressNarration/, 'ordinary assistant prose beside a tool must not reset or postpone structured narration cadence')
  assert.match(toolPipeline, /only the structured progress_update accepted after the billed stream[\s\S]*return null/, 'tool execution must leave cadence accounting to the committed structured progress lane')
  assert.doesNotMatch(toolPipeline, /visibleToolActionsSinceLastNarration\+\+[\s\S]{0,160}state\.forceTextNextIteration = true/, 'visible actions must schedule cadence without disabling tools')
  assert.match(config, /NARRATION_THRESHOLD_DEFAULT\s*=\s*3/, 'default narration threshold must open the 3-4 action narration window')
  assert.match(config, /NARRATION_THRESHOLD_BROWSER\s*=\s*3/, 'browser-heavy tasks must enter the 3-4 narration window after 3 visible actions')
  assert.match(streamProcessor, /recordVisibleToolStartForNarration/, 'provisional file/code tool starts must count toward the same visible narration cadence as executed tools')
  assert.match(streamProcessor, /fail open for the concrete action[\s\S]*return true/, 'missing display narration must fail open for valid work')
  assert.match(streamProcessor, /Suppress invalid\/duplicate display text[\s\S]*return allowMissing/, 'invalid or repeated narration must stay invisible without suppressing the action')
  assert.match(streamProcessor, /cadenceProgressViolation && toolCalls\.size === 0/, 'only a cadence turn with no executable action may enter bounded no-progress recovery')
  assert.doesNotMatch(streamProcessor, /visibleToolActionsSinceLastNarration\+\+[\s\S]{0,160}state\.forceTextNextIteration = true/, 'provisional visible actions must not disable same-turn tools')
  assert.match(streamProcessor, /contentDelta:\s*\{[\s\S]*break contentDelta[\s\S]*if \(delta\.tool_calls\)/, 'text overflow must still preserve tool calls from the same provider chunk')
  assert.doesNotMatch(streamProcessor, /function addProvisionalFileActionLabel[\s\S]*args\.action_label/, 'runtime code must not invent a visible label for file actions')
  assert.match(streamProcessor, /addDisplayContractArgs[\s\S]*parsed\.action_label[\s\S]*extractStringArg\(rawArgs,\s*'action_label'\)/, 'visible provisional labels must come from the model-authored tool arguments')
  assert.doesNotMatch(streamProcessor, /function addProvisionalRuntimeDisplayContract[\s\S]{0,500}args\.action_label\s*=/, 'provisional runtime repair may align the active step but must not generate action-label wording')
  assert.match(streamProcessor, /lastVisibleActivityTime/, 'stream processor must track user-visible activity separately from invisible reasoning chunks')
  assert.match(streamProcessor, /visibleInactivityExpired = now - lastVisibleActivityTime > effectiveIterationMs/, 'invisible-only streams must use the bounded iteration deadline without cutting an actively streaming tool envelope')
  assert.match(streamProcessor, /PROGRESS_NARRATION_TEXT_STREAM_CAP\s*=\s*420/, 'progress narration should still have a short visible text cap')
  assert.doesNotMatch(streamProcessor, /progressNarrationTextCap !== null[\s\S]{0,240}abortStreamingResponse\(\)/, 'clipped progress narration must keep draining so usage and same-turn tool calls can arrive')
  assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 3_000/, 'API inactivity timeout must tolerate normal provider jitter while the iteration watchdog bounds frozen turns')
  assert.match(config, /checkIntervalMs:\s*150/, 'stream inactivity checks should run quickly enough to keep thinking state honest')
  assert.match(prompts, /Do not narrate with fewer than 3 new visible actions, and never go past 4 visible actions/, 'agent prompt must enforce the exact 3-4 action narration window')
  assert.match(prompts, /never fewer than 15 words/, 'agent prompt must forbid too-short progress narration')
  assert.match(prompts, /1-2 complete sentences/, 'agent prompt must define short paragraph cadence')
  assert.match(prompts, /optional, never required, and never a template/, 'agent prompt must make Next natural and optional without a frequency quota')
  assert.match(prompts, /result-first/, 'agent prompt must request result-first evidence narration')
  assert.match(prompts, /progressive evidence trace/, 'agent prompt must advance the newest evidence instead of paraphrasing a running summary')
  assert.match(prompts, /new evidence followed by its implication/, 'agent prompt must provide multiple evidence-shaped rhetorical forms')
  assert.match(prompts, /Vary the grammatical subject, voice, rhythm, and sentence count/, 'agent prompt must vary structure rather than only swapping opening verbs')
  assert.doesNotMatch(prompts, /minority case|uncommon/, 'agent prompt must not impose a frequency quota on natural Next transitions')
  assert.match(prompts, /place it after a completed finding/, 'agent prompt must place an optional Next sentence after concrete progress')
  assert.match(prompts, /same response immediately begins the exact concrete action it names/, 'agent prompt must give Next its immediate-in-the-moment meaning')
  assert.match(prompts, /Never use it for a broader phase, a general shift in analysis, planned later work/, 'agent prompt must reject broad phase-transition Next narration')
  assert.match(prompts, /At exactly 3 visible actions, start the next response/, 'agent prompt must make narration happen before the next action')
  assert.match(prompts, /standing cadence for every phase/, 'agent prompt must frame narration as a per-phase cadence, not only research narration')
  assert.match(prompts, /narration is the default first visible text/, 'agent prompt must make narration the preferred first visible text at the 3-action window')
  assert.match(prompts, /before <next_step\/> if the current phase is complete/, 'agent prompt must allow narration at the end of a phase before next_step')
  assert.match(prompts, /Phase-end narration is allowed and expected/, 'agent prompt must not wait for an extra tool call at phase end')
  assert.match(prompts, /Never ask permission to continue an active task/, 'agent prompt must ban lazy opt-in handoffs during active tasks')
  assert.match(agentLoop, /NARRATION_STRUCTURAL_FORMS/, 'compact narration must select among evidence-matched structural forms')
  assert.match(agentLoop, /Preferred structural form for this update/, 'sidecar context must carry the selected rhetorical preference')
  assert.match(agentLoop, /newest delta, not the cumulative task conclusion/, 'sidecar must reject repetitive cumulative summaries')
  assert.match(agentLoop, /temperature:\s*0\.55/, 'fast narration sidecar must retain enough variation to avoid one repeated template')
  assert.match(cleaners, /PERMISSION_TO_CONTINUE_PATTERN/, 'narration cleaners must reject permission-to-continue handoff text')
  assert.match(taskGroupView, /task-thread-body/, 'task group view must render a subtle timeline body')
  assert.match(taskGroupView, /InlineThinkingIndicator/, 'task group view must show inline thinking while the model is deciding after visible actions')
  assert.match(taskGroupView, /streamingStatus === 'thinking'/, 'inline thinking must be tied to the real streaming thinking state')
  assert.match(taskGroupView, /!hasRunningVisibleSubtask/, 'inline thinking must not show while a tool/action pill is actively running')
  assert.match(taskGroupView, /task-inline-thinking-row/, 'inline thinking must render outside the timeline body so it does not extend the phase rail')
  assert.match(taskGroupView, /className="task-thread-body[\s\S]*?\n\s*<\/div>\n\n\s*\{showInlineThinking/, 'inline thinking must be placed after task-thread-body, not inside the timeline rail')
  assert.match(globals, /\.task-thread-body::before/, 'timeline body styling must be present')
}

async function assertNarrationRuntime() {
  const workDir = await mkdtemp(join(root, 'scripts/.narration-cadence-smoke-runner-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { cleanThinkingTags, sanitizeNarrationText, stripNarrationArtifacts, stripToolActionNarration } from ${JSON.stringify(join(root, 'src/lib/stream/cleaners.ts'))}
import { strictActionLabelFromArgs } from ${JSON.stringify(join(root, 'src/lib/stream/ActivityDescriber.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { acceptProgressNarration, beginNarrationCadenceAttempt, deferNarrationCadenceAttempt, extractCadenceProgressUpdate, finishNarrationCadenceAttempt, narrationStructureSignature, retryNarrationCadenceAfterNoProgress, retryNarrationCadenceAttemptWithoutNewAction, reviewProgressNarration, stripCadenceProgressUpdateFromArguments, visibleNarrationActionHeadroom, withCadenceProgressUpdateSchemas, workLogSinceAcceptedNarration } from ${JSON.stringify(join(root, 'src/lib/agent/NarrationMemory.ts'))}

export function runNarrationSmoke() {
  const registryTool = {
    type: 'function',
    function: {
      name: 'web_search',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  }
  const ordinarySchemas = withCadenceProgressUpdateSchemas([registryTool], false)
  assert.equal((ordinarySchemas[0].function.parameters.properties as any).progress_update, undefined, 'ordinary action turns must not carry the cadence field')
  const cadenceSchemas = withCadenceProgressUpdateSchemas([registryTool], true)
  assert.equal((cadenceSchemas[0].function.parameters.properties as any).progress_update.type, 'string')
  assert.equal((cadenceSchemas[0].function.parameters.properties as any).progress_update.minLength, 1)
  assert.deepEqual(cadenceSchemas[0].function.parameters.required, ['progress_update', 'query'])
  assert.equal((registryTool.function.parameters.properties as any).progress_update, undefined, 'model schema injection must not mutate the registered tool definition')
  const cadenceSchemaWithoutParameters = withCadenceProgressUpdateSchemas([{
    type: 'function',
    function: { name: 'parameterless_tool' },
  }], true)
  assert.equal(
    (cadenceSchemaWithoutParameters[0].function.parameters.properties as any).progress_update.minLength,
    1,
    'every native function tool must receive the required cadence field even when its registry schema omitted parameters',
  )
  assert.deepEqual(cadenceSchemaWithoutParameters[0].function.parameters.required, ['progress_update'])
  const carriedArgs = '{"progress_update":"Found the official benchmark reports a 2.1-second median startup.","query":"agent startup benchmark"}'
  assert.match(extractCadenceProgressUpdate(carriedArgs) || '', /2\.1-second median startup/)
  assert.deepEqual(JSON.parse(stripCadenceProgressUpdateFromArguments(carriedArgs)), { query: 'agent startup benchmark' })

  const state = createInitialState(false, {
    iterationTimeoutMs: 10_000,
    inactivityTimeoutMs: 1_000,
    contentOnlyTimeoutMs: 1_000,
    contentOnlyMinChars: 80,
    checkIntervalMs: 100,
  })
  state.currentPlanItems = ['Research', 'Deliver']
  state.workLog.push('[1] Confirmed DevRev funding')
  state.visibleToolActionsSinceLastNarration = 3
  assert.equal(visibleNarrationActionHeadroom(state), 1)
  assert.equal(beginNarrationCadenceAttempt(state), true)
  assert.equal(beginNarrationCadenceAttempt(state), false, 'only one cadence attempt may be in flight')
  finishNarrationCadenceAttempt(state)
  assert.equal(state.narrationNextAttemptAt, 4, 'a missed action-3 update retries at action 4')
  assert.equal(beginNarrationCadenceAttempt(state), false)
  state.visibleToolActionsSinceLastNarration = 4
  assert.equal(beginNarrationCadenceAttempt(state), true)
  finishNarrationCadenceAttempt(state)
  deferNarrationCadenceAttempt(state)
  assert.equal(state.visibleToolActionsSinceLastNarration, 4, 'rejection must not reset completed-action cadence')

  const timeoutRetryState = createInitialState(false, state.tierTimeouts)
  timeoutRetryState.currentPlanItems = ['Research', 'Deliver']
  timeoutRetryState.visibleToolActionsSinceLastNarration = 4
  assert.equal(beginNarrationCadenceAttempt(timeoutRetryState), true)
  retryNarrationCadenceAttemptWithoutNewAction(timeoutRetryState)
  assert.equal(timeoutRetryState.narrationNextAttemptAt, 4, 'a timed-out cadence turn must remain due without another visible action')
  assert.equal(timeoutRetryState.forceTextNextIteration, false, 'cadence retry must remain an ordinary action-selection turn')
  assert.equal(beginNarrationCadenceAttempt(timeoutRetryState), true, 'the same action frontier must reopen cadence on the immediate retry')
  finishNarrationCadenceAttempt(timeoutRetryState)

  const successfulEmptyMalformedTurn = createInitialState(false, state.tierTimeouts)
  successfulEmptyMalformedTurn.currentPlanItems = ['Research', 'Deliver']
  successfulEmptyMalformedTurn.iterations = 2
  successfulEmptyMalformedTurn.visibleToolActionsSinceLastNarration = 5
  assert.equal(beginNarrationCadenceAttempt(successfulEmptyMalformedTurn), true)
  finishNarrationCadenceAttempt(successfulEmptyMalformedTurn)
  assert.equal(successfulEmptyMalformedTurn.narrationNextAttemptAt, 6)
  assert.equal(
    reviewProgressNarration(successfulEmptyMalformedTurn, 'Read the Anthropic engineering blog; it likely contains implementation details about agent orchestration and tool dispatch.', { requireSignal: false }).status,
    'invalid',
  )
  assert.equal(
    retryNarrationCadenceAfterNoProgress(successfulEmptyMalformedTurn, {
      attemptIteration: 2,
      visibleActionFrontier: 5,
      acceptedVisibleAction: false,
    }),
    true,
    'a successful stream with empty/invalid narration plus a rejected malformed tool must keep cadence due',
  )
  assert.equal(successfulEmptyMalformedTurn.narrationNextAttemptAt, 5)
  assert.equal(beginNarrationCadenceAttempt(successfulEmptyMalformedTurn), true, 'the next ordinary retry must reopen cadence at frontier 5')
  finishNarrationCadenceAttempt(successfulEmptyMalformedTurn)

  const acceptedActionTurn = createInitialState(false, state.tierTimeouts)
  acceptedActionTurn.currentPlanItems = ['Research', 'Deliver']
  acceptedActionTurn.iterations = 3
  acceptedActionTurn.visibleToolActionsSinceLastNarration = 5
  assert.equal(beginNarrationCadenceAttempt(acceptedActionTurn), true)
  finishNarrationCadenceAttempt(acceptedActionTurn)
  acceptedActionTurn.visibleToolActionsSinceLastNarration = 6
  assert.equal(
    retryNarrationCadenceAfterNoProgress(acceptedActionTurn, {
      attemptIteration: 3,
      visibleActionFrontier: 5,
      acceptedVisibleAction: true,
    }),
    false,
    'an accepted visible action must advance normally without gating tools',
  )
  assert.equal(acceptedActionTurn.narrationNextAttemptAt, 6)

  const firstNarration = "DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals."
  assert.equal(acceptProgressNarration(state, firstNarration, { requireSignal: true }).status, 'accepted')
  assert.equal(state.visibleToolActionsSinceLastNarration, 4, 'ordinary early prose may be remembered but must not reset the structured 3-4 action cadence')
  assert.equal(reviewProgressNarration(state, firstNarration, { requireSignal: true }).status, 'duplicate')
  assert.equal(
    reviewProgressNarration(state, "DevRev confirmed a $100M Series A in late 2025 and a $1.2B valuation. Next, I'll compare its culture signals.", { requireSignal: true }).status,
    'duplicate',
  )
  state.workLog.push('[2] Found 2026 employee retention figures')
  assert.deepEqual(workLogSinceAcceptedNarration(state), ['[2] Found 2026 employee retention figures'])
  assert.equal(
    reviewProgressNarration(state, "DevRev's 2026 employee data adds a 91% retention figure to the funding evidence. Next, I'll compare role patterns.", { requireSignal: true }).status,
    'accepted',
  )
  assert.equal(
    reviewProgressNarration(state, 'Read the Anthropic engineering blog; it likely contains implementation details about agent orchestration and tool dispatch.', { requireSignal: false }).status,
    'invalid',
    'a future action fragment must never count as completed-result narration',
  )
  assert.equal(
    reviewProgressNarration(state, 'The Anthropic engineering blog likely contains implementation details about agent orchestration and fast tool dispatch.', { requireSignal: false }).status,
    'invalid',
    'speculation about an unread source must never count as completed-result narration',
  )
  assert.equal(
    reviewProgressNarration(state, 'The Anthropic engineering blog reports that its agent runtime uses parallel tool dispatch to reduce user-visible latency.', { requireSignal: false }).status,
    'accepted',
    'a concrete completed-source result must remain valid narration',
  )

  const structureState = createInitialState(false, state.tierTimeouts)
  const evidenceTransitionOne = "NASA measurements confirmed Mars surface radiation remains the dominant long-duration habitat risk for crews. Next, I'll compare shielding requirements."
  const evidenceTransitionTwo = "Kilopower trials confirmed reactor output remains stable throughout the most severe simulated dust storms. Next, I'll compare long-duration energy storage."
  const evidenceTransitionThree = "Crew studies confirmed prolonged isolation compounds medical risk across multiyear interplanetary missions. Next, I'll assess autonomous care systems."
  assert.equal(narrationStructureSignature(evidenceTransitionOne), narrationStructureSignature(evidenceTransitionTwo))
  assert.equal(narrationStructureSignature(evidenceTransitionTwo), narrationStructureSignature(evidenceTransitionThree))
  assert.equal(acceptProgressNarration(structureState, evidenceTransitionOne, { requireSignal: false }).status, 'accepted')
  assert.equal(acceptProgressNarration(structureState, evidenceTransitionTwo, { requireSignal: false }).status, 'accepted')
  assert.equal(
    reviewProgressNarration(structureState, evidenceTransitionThree, { requireSignal: false }).status,
    'duplicate',
    'a third consecutive narration with the same rhetorical skeleton must be rejected even when its facts differ',
  )

  assert.equal(sanitizeNarrationText('Click the "Update" button to confirm the prompt.'), null)
  assert.equal(sanitizeNarrationText('This indicates that the action was ineffective.'), null)
  assert.equal(sanitizeNarrationText('Synthesize these findings to explain why Manus AI is distinct from standard LLM assistants.'), null)
  assert.equal(sanitizeNarrationText("I will now synthesize these findings into a comparative report on Manus AI's differentiation."), null)
  assert.equal(sanitizeNarrationText('Navigate to any official government publications or reputable legal analysis sites detailing these amendments.'), null)
  assert.equal(sanitizeNarrationText('state/territory). This decision suggests a stance of not weakening existing copyright protections for creators.'), null)
  assert.equal(sanitizeNarrationText('or reputable legal analysis sites detailing these amendments. state actions and the status of legal reviews.'), null)
  assert.equal(sanitizeNarrationText('Compile findings into a comprehensive report.'), null)
  assert.equal(sanitizeNarrationText('artificialanalysis.ai shows for more details including relating to our methodology, see our FAQs.'), null)
  assert.equal(sanitizeNarrationText('I have sufficient evidence for Step 1.'), null)
  assert.equal(sanitizeNarrationText('I have examined the Australian Framework for Generative AI in Schools, which establishes a national approach to the ethical and responsible The framework emphasises that AI should be used to benefit students.'), null)
  assert.equal(sanitizeNarrationText('If you want, I can continue with the next layer on capabilities and pricing.', { requireSignal: true }), null)
  assert.equal(stripToolActionNarration('Manus AI is positioned as a hands-on agent for business deliverables. If you want, I can continue with capabilities and pricing.'), 'Manus AI is positioned as a hands-on agent for business deliverables.')
  assert.equal(sanitizeNarrationText('Review the College Board I have identified significant institutional and educator concerns regarding AI in high schools.'), null)
  assert.equal(sanitizeNarrationText('Access the Frontiers systematic review to I have identified key socio-ethical risks associated with AI in education.'), null)
  assert.equal(sanitizeNarrationText('gather evidence on those issues.'), null)
  assert.equal(sanitizeNarrationText("gather more details from the page to confirm the movie she plays in.The embedded media page appears to be a short clip featuring a woman, but I couldn't extract its title or description.", { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText("review what we've gathered so far and identify the key evidence gaps for this phase on limitations, risks, and ethical concerns.", { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText('Confirm café option selected and move to Location 3.', { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText('Confirmed café option selected.', { requireSignal: true }), null)
  assert.equal(
    sanitizeNarrationText('Three bird images downloaded, but the tool result truncated the full download confirmation.', { requireSignal: true }),
    null,
    'narration must never expose tool-result truncation mechanics',
  )
  assert.equal(
    sanitizeNarrationText('The download confirmation was truncated mid-string, leaving an incomplete record for the hummingbird image.', { requireSignal: true }),
    null,
    'narration must never expose parser or payload corruption mechanics',
  )
  assert.equal(
    sanitizeNarrationText('Only the eagle image was fully verified, so the other cards must rely on placeholder paths.', { requireSignal: true }),
    null,
    'narration must not describe backend verification or placeholder-path fallbacks',
  )
  assert.equal(
    stripNarrationArtifacts('Found the embedded media page did not expose a title or description from that URL.The source still confirms it was a media page.'),
    'Found the embedded media page did not expose a title or description from that URL. The source still confirms it was a media page.',
  )
  assert.equal(
    stripToolActionNarration('I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries. now read the most promising source on expert AGI timeline'),
    'I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries.',
  )
  assert.equal(
    sanitizeNarrationText('I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries. now read the most promising source on expert AGI timeline', { requireSignal: true }),
    'I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries.',
  )
  assert.equal(
    sanitizeNarrationText("The The analysis of Apple's ecosystem lock-in shows that 90% of iPhone users remain loyal because iCloud and App Store integration reduce switching.", { requireSignal: true }),
    "The analysis of Apple's ecosystem lock-in shows that 90% of iPhone users remain loyal because iCloud and App Store integration reduce switching.",
  )
  const dsmlToolText = '<｜｜DSML｜｜tool_calls>\\n<｜｜DSML｜｜invoke name="web_search">\\n<｜｜DSML｜｜parameter name="query" string="true">DevRev AI funding</｜｜DSML｜｜parameter>\\n</｜｜DSML｜｜invoke>\\n</｜｜DSML｜｜tool_calls>'
  assert.equal(cleanThinkingTags(dsmlToolText).trim(), '')
  assert.equal(stripToolActionNarration(dsmlToolText).trim(), '')
  assert.equal(cleanThinkingTags('**FINAL ANSWER REQUIRED:** Do not write another progress update.\\n\\n# DevRev AI Report').trim(), '# DevRev AI Report')
  assert.equal(stripToolActionNarration('Deliverable step: write the report in chat\\n\\nDevRev unifies product and support data.').trim(), 'DevRev unifies product and support data.')
  assert.equal(strictActionLabelFromArgs({ action_label: 'Researching AI tools for essay planning' }), null)
  assert.equal(strictActionLabelFromArgs({ action_label: 'search expert predictions 2025 agentic ai shift.' }), 'Search expert predictions 2025 agentic ai shift')
  assert.equal(strictActionLabelFromArgs({ action_label: 'Compare student AI writing tools' }), 'Compare student AI writing tools')
  assert.equal(
    strictActionLabelFromArgs({
      action_label: 'Track latest technical breakthroughs in AI',
      query: 'latest technical breakthroughs in AI',
    }),
    'Track latest technical breakthroughs in AI',
  )
  assert.equal(
    stripToolActionNarration("Australia is handling AI copyright issues federally. 2. Navigate to official government publications or reputable legal analysis sites detailing these amendments. 3. Synthesize all gathered information to provide a comprehensive answer on Australia’s response to AI copyright issues, including national vs. state actions and the status of legal reviews. 4. Compile findings into a comprehensive report. The Australian federal government is actively addressing copyright issues related to generative AI."),
    "Australia is handling AI copyright issues federally. The Australian federal government is actively addressing copyright issues related to generative AI.",
  )
  assert.equal(
    sanitizeNarrationText("DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.", { requireSignal: true }),
    "DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.",
  )
  assert.equal(
    sanitizeNarrationText('Generated and verified eight visualizations for the report, including market growth and adoption gap charts.', { requireSignal: true }),
    'Generated and verified eight visualizations for the report, including market growth and adoption gap charts.',
  )
  assert.equal(
    sanitizeNarrationText('Gathered12 deduped rumor candidates from4 source angles, including the latest MacRumors roundup on iPhone17 expected features and release timeline.', { requireSignal: true }),
    'Gathered 12 deduped rumor candidates from 4 source angles, including the latest MacRumors roundup on iPhone 17 expected features and release timeline.',
  )
  assert.equal(
    sanitizeNarrationText("I've gathered initial I have several promising leads including a deep learning chapter, a step-by-step transformer explanation, and a Medium article on multi-head attention.", { requireSignal: true }),
    "I've found several promising leads including a deep learning chapter, a step-by-step transformer explanation, and a Medium article on multi-head attention.",
  )
  assert.equal(
    sanitizeNarrationText('Since the last narration, I completed 4 targeted searches covering AI alignment challenges, hallucination mitigation I now have a solid evidence base across all sub-topics in this phase.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Since the last progress paragraph, I've completed searches on AI model benchmarks, major company funding rounds, and AI market size forecasts.", { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Completed 5 web searches covering AI's GDP contribution, productivity gains, industry transformation, and economic impact statistics.", { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Completed 4 web searches covering bird migration and feeding ecology, and read the Wikipedia Bird page.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('All five searches for bird conservation statistics failed with unknown errors, so the phase moved on to preserve the remaining plan budget.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Synthesized key 2026 breakthroughs in agentic reasoning and multimodal memory architectures from recent technical reports and industry analysis.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Confirmed light to moderate rain around 5:30-6:15 PM in Ryde, NSW via Zoom Earth. Will verify other sources like BOM and Weatherzone for consolidated forecast.", { requireSignal: true }),
    "Confirmed light to moderate rain around 5:30-6:15 PM in Ryde, NSW via Zoom Earth. Will verify other sources like BOM and Weatherzone for consolidated forecast.",
  )
  assert.equal(
    sanitizeNarrationText("Discovered parrotlets are highly intelligent, feisty, and affectionate, with unique color variations, long lifespan up to 30 years, and quiet, playful personalities suitable for small spaces. Next, I'll gather visual assets.", { requireSignal: true }),
    "Discovered parrotlets are highly intelligent, feisty, and affectionate, with unique color variations, long lifespan up to 30 years, and quiet, playful personalities suitable for small spaces. Next, I'll gather visual assets.",
  )
  assert.equal(
    sanitizeNarrationText("Found that crossing 1.5°C warming triggers irreversible climate tipping points, like ice sheet collapse and coral reef dieback, significantly increasing global risks. Will synthesize detailed projections next.", { requireSignal: true }),
    "Found that crossing 1.5°C warming triggers irreversible climate tipping points, like ice sheet collapse and coral reef dieback, significantly increasing global risks. Will synthesize detailed projections next.",
  )
  assert.equal(
    sanitizeNarrationText("Successfully selected \\"Cafe operation\\" via custom autocomplete. Will proceed with entering details on the website to access licensing info for NSW cafes.", { requireSignal: true }),
    "Successfully selected \\"Cafe operation\\" via custom autocomplete. Will proceed with entering details on the website to access licensing info for NSW cafes.",
  )
  assert.equal(
    sanitizeNarrationText("Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.", { requireSignal: true }),
    "Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.",
  )
  assert.equal(
    sanitizeNarrationText("I've gathered and saved high-quality images of colorful parrotlets, including adults and babies, to enhance the visual appeal of the presentation on their traits and diversity. Next, I'll outline the slide content.", { requireSignal: true }),
    "I've gathered and saved high-quality images of colorful parrotlets, including adults and babies, to enhance the visual appeal of the presentation on their traits and diversity. Next, I'll outline the slide content.",
  )
}
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

    const { runNarrationSmoke } = await import(pathToFileURL(bundlePath).href)
    runNarrationSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await assertSourceContracts()
await assertNarrationRuntime()
console.log('narration cadence smoke checks passed')
