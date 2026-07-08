import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [
    planManager,
    toolPipeline,
    browser,
    documentReader,
    streamConstants,
    eventDispatcher,
    artifactSlice,
    searchResults,
    artifacts,
    webSearchSource,
    agentLoop,
    llm,
    contextManager,
    policyEngine,
    agentState,
    creditPolicy,
    serverCredits,
    activeTasks,
    taskJobs,
    chatTaskRunner,
    taskText,
    taskWorker,
    e2bSandbox,
    taskQueue,
    agentIdentity,
    researchActivityLog,
    activeTaskConstants,
    taskConstraints,
    dynamicKnowledge,
    conversationContext,
    taskStrategy,
    browserIntelligence,
    goalTracker,
    workingMemory,
    streamCleaners,
    serverSanitization,
    errorMessages,
    prompts,
    globalsCss,
    browserView,
    browseView,
    computerPanel,
    panelHeader,
    uiStore,
    useAgentStream,
    liveDirectives,
    inputLimits,
    validationSchemas,
    chatDirectiveRoute,
    directChatRouting,
    messageSlice,
    chatInput,
    messageList,
    agentMessage,
    typingIndicator,
    userMessage,
    appLayout,
    authSessionProvider,
    authGate,
    homePage,
    chatPage,
    chatLoading,
    chatRoute,
    activeChatRoute,
    titleRoute,
    tools,
    toolRegistry,
    attachments,
    agentToolRegistry,
    activityDescriber,
    streamProcessor,
    agentConfig,
    toolLimits,
    toolRetry,
    toolCache,
    outputVerifier,
    completionAudit,
    sandbox,
    stepMessages,
    taskMessageContent,
    chatStoreIndex,
    chatPersistence,
    chatServerSync,
    conversationsLib,
    conversationsRoute,
    chatStoreSync,
    useHydration,
    settingsDataTab,
    rootOverlays,
    appFrame,
    mainContent,
    sidebar,
    modal,
    activeTaskConflictModal,
    actionFeed,
  ] = await Promise.all([
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/browser.ts'), 'utf8'),
    readFile(join(root, 'src/lib/document.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/constants.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/artifactSlice.ts'), 'utf8'),
    readFile(join(root, 'src/components/computer/SearchResults.tsx'), 'utf8'),
    readFile(join(root, 'src/types/artifacts.ts'), 'utf8'),
    readFile(join(root, 'src/lib/search.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/llm.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ContextManager.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
    readFile(join(root, 'src/lib/creditPolicy.ts'), 'utf8'),
    readFile(join(root, 'src/lib/serverCredits.ts'), 'utf8'),
    readFile(join(root, 'src/lib/activeTasks.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskText.ts'), 'utf8'),
    readFile(join(root, 'src/worker/taskWorker.ts'), 'utf8'),
    readFile(join(root, 'src/lib/e2bSandbox.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskQueue.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agentIdentity.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ResearchActivityLog.ts'), 'utf8'),
    readFile(join(root, 'src/lib/activeTaskConstants.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskConstraints.ts'), 'utf8'),
    readFile(join(root, 'src/lib/dynamicKnowledge.ts'), 'utf8'),
    readFile(join(root, 'src/lib/conversationContext.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/TaskStrategy.ts'), 'utf8'),
    readFile(join(root, 'src/lib/browserIntelligence.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/GoalTracker.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/WorkingMemory.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/cleaners.ts'), 'utf8'),
    readFile(join(root, 'src/agent/guards/sanitization.ts'), 'utf8'),
    readFile(join(root, 'src/lib/errorMessages.ts'), 'utf8'),
    readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
    readFile(join(root, 'src/app/globals.css'), 'utf8'),
    readFile(join(root, 'src/components/computer/BrowserView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/computer/BrowseView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
    readFile(join(root, 'src/components/computer/PanelHeader.tsx'), 'utf8'),
    readFile(join(root, 'src/store/ui.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
    readFile(join(root, 'src/lib/liveDirectives.ts'), 'utf8'),
    readFile(join(root, 'src/lib/inputLimits.ts'), 'utf8'),
    readFile(join(root, 'src/lib/validation/schemas.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/directive/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/directChatRouting.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/messageSlice.ts'), 'utf8'),
    readFile(join(root, 'src/components/chat/ChatInput.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/MessageList.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/AgentMessage.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/TypingIndicator.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/UserMessage.tsx'), 'utf8'),
    readFile(join(root, 'src/app/layout.tsx'), 'utf8'),
    readFile(join(root, 'src/components/auth/AuthSessionProvider.tsx'), 'utf8'),
    readFile(join(root, 'src/components/auth/AuthGate.tsx'), 'utf8'),
    readFile(join(root, 'src/app/page.tsx'), 'utf8'),
    readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
    readFile(join(root, 'src/app/chat/[id]/loading.tsx'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/active/route.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/title/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/tools.ts'), 'utf8'),
    readFile(join(root, 'src/lib/toolRegistry.ts'), 'utf8'),
    readFile(join(root, 'src/lib/attachments.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolRegistry.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/ActivityDescriber.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolLimits.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolRetry.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolCache.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/OutputVerifier.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/CompletionAudit.ts'), 'utf8'),
    readFile(join(root, 'src/lib/sandbox.ts'), 'utf8'),
    readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/taskMessageContent.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/index.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/persistence.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/serverSync.ts'), 'utf8'),
    readFile(join(root, 'src/lib/conversations.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/conversations/route.ts'), 'utf8'),
    readFile(join(root, 'src/components/chat/ChatStoreSync.tsx'), 'utf8'),
    readFile(join(root, 'src/lib/useHydration.ts'), 'utf8'),
    readFile(join(root, 'src/components/modals/settings/DataTab.tsx'), 'utf8'),
    readFile(join(root, 'src/components/layout/RootOverlays.tsx'), 'utf8'),
    readFile(join(root, 'src/components/layout/AppFrame.tsx'), 'utf8'),
    readFile(join(root, 'src/components/layout/MainContent.tsx'), 'utf8'),
    readFile(join(root, 'src/components/layout/Sidebar.tsx'), 'utf8'),
    readFile(join(root, 'src/components/modals/Modal.tsx'), 'utf8'),
    readFile(join(root, 'src/components/modals/ActiveTaskConflictModal.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/ActionFeed.tsx'), 'utf8'),
  ])
  const creditPillSource = await readFile(join(root, 'src/components/ui/CreditPill.tsx'), 'utf8')
  const homeSubmitStart = homePage.indexOf('const handleSubmit = async')
  const homeSubmitEnd = homePage.indexOf('const handleQuickAction')
  assert.notEqual(homeSubmitStart, -1, 'home page must expose a task submit handler')
  assert.notEqual(homeSubmitEnd, -1, 'home page submit handler must remain isolated before quick actions')
  const homeSubmit = homePage.slice(homeSubmitStart, homeSubmitEnd)
  const homeRoutePushIndex = homeSubmit.indexOf('router.push(`/chat/${id}`)')
  const homeAttachmentBindIndex = homeSubmit.indexOf('bindAttachmentsToTask')
  const homeServerFlushIndex = homeSubmit.indexOf('flushChatServerSync')
  assert.notEqual(homeRoutePushIndex, -1, 'new home tasks must route to the created chat immediately')
  assert.ok(
    homeAttachmentBindIndex === -1 || homeRoutePushIndex < homeAttachmentBindIndex,
    'new home tasks must not wait for attachment binding before routing',
  )
  assert.ok(
    homeServerFlushIndex === -1 || homeRoutePushIndex < homeServerFlushIndex,
    'new home tasks must not wait for server sync before routing',
  )
  assert.doesNotMatch(
    homeSubmit,
    /deleteConversation\(id\)/,
    'post-navigation sync failures must not delete the visible local task',
  )

  assert.match(prompts, /Custom Instruction Compliance/, 'custom instructions must be elevated to active runtime constraints')
  assert.match(prompts, /Default work standard: do not skim or do the bare minimum/, 'runtime prompt must counter shallow minimum-effort behavior')
  assert.match(prompts, /getPlanningPrompt\(customInstructions\?: string\)/, 'planner prompt must accept custom instructions')
  assert.match(prompts, /Custom Instructions That Apply To This Plan/, 'planning prompt must include custom instruction guidance')
  assert.match(prompts, /Custom instructions supersede.*including the visible number of plan phases\/steps.*except for safety, permissions, sandbox\/tool availability, and core runtime rules/s, 'custom instructions must supersede defaults including visible phase count except safety/core rules')
  assert.match(prompts, /They do NOT supersede safety, permissions, sandbox\/tool availability, or core runtime rules/, 'planner prompt must preserve safety/core constraints above custom instructions')
  assert.match(prompts, /fixed number of visible phases, honor that count/, 'planner prompt must honor custom visible phase-count instructions')
  assert.match(planManager, /PLANNER_ACK_MAX_TOKENS = 96/, 'planner acknowledgements must stay bounded for a fast direct paragraph')
  assert.match(planManager, /PLANNER_SIMPLE_JSON_MAX_TOKENS = 420/, 'simple planner JSON calls must stay compact for fast task startup')
  assert.match(planManager, /PLANNER_MEDIUM_JSON_MAX_TOKENS = 560/, 'medium planner JSON calls must stay compact for fast task startup')
  assert.match(planManager, /PLANNER_JSON_MAX_TOKENS = 640/, 'complex planner JSON calls must stay compact without reducing task quality')
  assert.match(planManager, /plannerJsonMaxTokens/, 'planner calls must use a task-sized token budget instead of one slow blanket cap')
  assert.match(planManager, /REPLAN_JSON_MAX_TOKENS = 520/, 'replanning JSON calls must use a compact output cap')
  assert.match(planManager, /PLANNER_ACK_STREAM_TIMEOUT_MS = 2_000/, 'startup acknowledgement must stay inside a 2s no-thinking window')
  assert.doesNotMatch(planManager, /PLANNER_ACK_THOUGHTFUL_MIN_MS|waitForThoughtfulAcknowledgementWindow/, 'startup acknowledgement must show as soon as usable model text is available')
  assert.match(prompts, /getFastPlanningPrompt/, 'planner must expose a compact first-pass planning prompt')
  assert.match(planManager, /PLANNER_FAST_JSON_MAX_TOKENS = 360/, 'fast planner should use a small output cap')
  assert.match(planManager, /PLANNER_FAST_JSON_REQUEST_TIMEOUT_MS = 2_000/, 'fast planner must not sit past a 2s startup window')
  assert.match(planManager, /PLANNER_JSON_REQUEST_TIMEOUT_MS = 2_000/, 'strict planner JSON calls must stay inside the 2s startup window')
  assert.match(planManager, /PLANNER_RELAXED_JSON_REQUEST_TIMEOUT_MS = 2_000/, 'planner startup fallback calls must stay inside the 2s startup window')
  assert.match(planManager, /PLANNER_REPAIR_REQUEST_TIMEOUT_MS = 2_000/, 'planner repair calls must stay inside the 2s startup window')
  assert.match(planManager, /PLANNER_OVERALL_DEADLINE_MS = 6_000/, 'planner startup must have a tight overall bound across deadline-bounded retries')
  assert.match(planManager, /PLANNER_TIMEOUT_RECOVERY_RETRIES = 2/, 'planner startup timeouts should get a deadline-bounded strict recovery before giving up')
  assert.match(planManager, /continueAfterPlannerTimeout[\s\S]*continuing without surfacing provider timeout[\s\S]*state\.planEmitted = true/, 'planner startup timeout exhaustion must continue internally instead of surfacing the raw provider timeout')
  {
    const timeoutStart = planManager.indexOf('private continueAfterPlannerTimeout')
    const timeoutEnd = planManager.indexOf('private async emitModelGeneratedAcknowledgement', timeoutStart)
    const timeoutBody = planManager.slice(timeoutStart, timeoutEnd)
    assert.match(planManager, /private timeoutFallbackPlan/, 'planner timeout recovery must create a real fallback plan')
    assert.match(timeoutBody, /const fallback = this\.timeoutFallbackPlan\(state\)/, 'planner timeout recovery must use the fallback plan builder')
    assert.match(timeoutBody, /this\.emitter\.plan\(fallback\.titles\)/, 'planner timeout recovery must emit visible plan steps')
    assert.match(timeoutBody, /state\.planItems = fallback\.titles[\s\S]*state\.currentPlanItems = fallback\.titles/, 'planner timeout recovery must keep planItems and currentPlanItems non-empty')
    assert.doesNotMatch(timeoutBody, /state\.planItems = \[\]|state\.currentPlanItems = null/, 'planner timeout recovery must not mark an empty or null plan as emitted')
  }
  assert.match(planManager, /function plannerTaskMessages[\s\S]*effectiveTaskRequest\(messages\)\.slice\(0,\s*6000\)/, 'planner must use the compact effective task request instead of replaying full chat history')
  assert.match(planManager, /fastPlannerMode[\s\S]*getFastPlanningPrompt\(this\.customInstructions\)[\s\S]*getPlanningPrompt\(this\.customInstructions\)/, 'initial planner call must use the compact prompt before the full strict prompt')
  assert.match(planManager, /requestTimeoutMs:\s*this\.plannerRequestTimeoutMs\(fastPlannerMode[\s\S]*PLANNER_FAST_JSON_REQUEST_TIMEOUT_MS[\s\S]*PLANNER_RELAXED_JSON_REQUEST_TIMEOUT_MS[\s\S]*PLANNER_JSON_REQUEST_TIMEOUT_MS/, 'initial planner calls must pass the fast bounded planner timeout and lean fallback timeouts')
  assert.match(planManager, /this\.planPromise = start[\s\S]*\.then\(\(\) => this\.attemptPlanCall\(0,\s*true\)\)[\s\S]*\.finally\(\(\) => clearTimeout\(deadlineTimer\)\)/, 'planner startup must begin with the faster model-owned planning path under the overall startup deadline')
  assert.match(planManager, /isPlannerRequestTimeout[\s\S]*this\.attemptPlanCall\(attempt \+ 1,\s*false\)/, 'planner startup timeouts must retry with strict JSON planning instead of ending before the plan appears')
  assert.match(planManager, /void this\.recordUsage\?\.\(normalized,[\s\S]*?\.catch/, 'planner usage recording must not block acknowledgement, plan emission, or first tool startup')
  assert.match(prompts, /Research starts with normal targeted web_search calls/, 'planner prompt must direct research startup toward targeted web_search, not broad sweep actions')
  assert.doesNotMatch(prompts, /initialAction[\s\S]*source_sweep/, 'planner prompt must not request a source_sweep initial action')
  assert.doesNotMatch(planManager, /initialToolCallFromPlannerAction|consumeInitialToolCall/, 'PlanManager must not inject planner-authored source_sweep actions ahead of normal agent turns')
  assert.doesNotMatch(agentLoop, /Executing planner-authored initial tool action/, 'AgentLoop must not execute hidden planner-authored source_sweep actions before the first model action turn')
  assert.doesNotMatch(planManager, /max_tokens: 2048/, 'planner calls must not keep the old overlarge 2048-token cap')
  assert.ok((planManager.match(/includeTemporalContext:\s*false/g) || []).length >= 5, 'planner, ack, and replan calls should not pay for automatic temporal context')
  assert.match(prompts, /Do not default to 3 or 4 steps/, 'planner prompt must keep step count flexible by task complexity')
  assert.match(prompts, /do not use fixed ranges/, 'planner prompt must not steer the model into fixed 1\/2\/3-style phase counts')
  assert.match(prompts, /Avoid repair loops/, 'planner prompt must directly request runtime-valid plan shapes to avoid extra repair calls')
  assert.doesNotMatch(prompts, /Minimum 3 steps except/, 'planner prompt must not impose a blanket 3-step minimum')
  assert.match(planManager, /if \(arrays\.titles\.length === 0\)[\s\S]*mappedTaskType !== 'general'[\s\S]*return false/, 'planner must not accept zero-step plans for tool/research/build tasks')
  assert.match(planManager, /getPlanningPrompt\(this\.customInstructions\)/, 'PlanManager must pass custom instructions into planning')
  assert.match(planManager, /CUSTOM INSTRUCTIONS TO APPLY IN THIS STEP/, 'per-step guidance must preserve custom instruction compliance without duplicating the full saved text')
  assert.match(planManager, /root system prompt and current plan/, 'per-step custom guidance should reference the root custom instructions instead of repeating them every turn')
  assert.match(planManager, /CUSTOM INSTRUCTIONS STILL APPLY/, 'custom instructions must be preserved during replanning')
  assert.match(planManager, /visible step count/, 'planner repair must preserve custom visible step-count instructions')
  assert.match(planManager, /do not supersede safety, permissions, sandbox\/tool availability, or core runtime rules/, 'planner repair must not let custom instructions override safety or core runtime constraints')
  assert.match(planManager, /Do not let saved custom instructions override safety, permissions, sandbox\/tool availability, or core runtime rules/, 'per-step custom guidance must preserve safety and core runtime constraints')
  assert.match(planManager, /fixed number of steps\/phases.*binding for the visible plan/s, 'per-step custom guidance must treat custom phase count as binding')
  assert.match(planManager, /parseVisibleStepCountInstruction/, 'PlanManager must detect custom visible step-count instructions')
  assert.match(planManager, /The LLM owns the plan shape/, 'planner must let the model own step count and phase shape')
  assert.match(planManager, /return steps/, 'step expansion must leave model-authored steps intact')
  assert.match(planManager, /applyCustomInstructionPlanRequirements/, 'planner must convert custom instruction requirements into concrete plan steps')
  assert.match(planManager, /planAwareIterationFloor/, 'plan sizing must raise the global iteration cap for multi-phase tasks')
  assert.match(planManager, /state\.dynamicIterationLimit = boundedPlanFloor/, 'plan-aware iteration floors must update the live dynamic cap before work starts')
  assert.match(planManager, /Math\.min\(planFloor,\s*MAX_ITERATIONS\)/, 'plan-aware iteration floors must be capped to prevent runaway cost')
  assert.doesNotMatch(planManager, /emitFastStartPlan|fastStartPlannerSteps|fastStartAck/, 'planner must not emit local canned acknowledgement or plan fallbacks')
  assert.match(planManager, /repairPlannerResponse/, 'invalid planner output must be repaired by the planner model instead of local visible fallback steps')
  assert.doesNotMatch(agentLoop, /function shouldRunStartupResearchSearch|runStartupResearchSearch|STARTUP SEARCH COMPLETE|IMMEDIATE SOURCE SEARCH COMPLETE|firstReadableSearchResultUrl/, 'research startup must not use local bootstrap/source-search shortcuts')
  assert.match(agentLoop, /const compactResearchNeedsTool = useCompactResearchTurn && compactResearchNeedsToolAction\(state\)[\s\S]*const requiredToolIntent = shouldRequireToolCall && !narrationWindowOpen/, 'research phases must keep a model-selected tool-action intent instead of local source actions')
  assert.match(agentLoop, /function supportsProviderRequiredToolChoice\(\): boolean \{[\s\S]*ASSISTANT_PROVIDER !== 'openrouter'[\s\S]*\}/, 'OpenRouter routes must avoid provider-forced tool choice because Gemini Flash Lite can timeout invisibly on required tool starts')
  assert.match(agentLoop, /const useRequiredToolCall = requiredToolIntent[\s\S]*supportsProviderRequiredToolChoice\(\)/, 'provider-forced tool choice must be gated separately from the agent tool-action intent')
  assert.match(agentLoop, /compactResearchToolRequiredMessage[\s\S]*Choose the most useful source\/search\/browser\/document action/, 'research repairs must nudge the model to choose the evidence tool itself')
  assert.match(agentLoop, /COMPACT_RESEARCH_RECOVERY_RUNTIME_TOOLS[\s\S]*web_search[\s\S]*read_document/, 'compact research recovery must narrow to source-focused model-selected tools after a miss')
  assert.doesNotMatch(agentLoop, /COMPACT_RESEARCH_RECOVERY_RUNTIME_TOOLS[\s\S]*source_sweep/, 'compact research recovery must not reintroduce broad source_sweep actions')
  assert.match(agentLoop, /needsAlternateSourceRoute[\s\S]*state\.stepLoopDetections > 0[\s\S]*new Set\(COMPACT_RESEARCH_SOURCE_RUNTIME_TOOLS\)/, 'compact research opened-source recovery must reopen search/browser routes after repeated read loops')
  assert.match(agentLoop, /COMPACT_RESEARCH_PRIMARY_SOURCE_RUNTIME_TOOLS[\s\S]*web_search[\s\S]*read_document[\s\S]*browser_navigate/, 'compact research must define primary source routes separately from contextual scroll-only browser controls')
  assert.match(agentLoop, /compactResearchSourceRecoveryToolsForState[\s\S]*hasPrimarySourceRoute[\s\S]*sourceRecoveryPool[\s\S]*Restored compact research source tools/, 'compact research recovery must restore source tools from the full registry when active tools collapse to scroll-only controls')
  assert.match(taskStrategy, /toolPriority:\s*\['web_search', 'read_document', 'browser_navigate', 'create_file'\]/, 'research tools must prioritize document extraction before full browser navigation')
  assert.match(agentConfig, /BASE_ITERATIONS\s*=\s*48/, 'long tasks need a larger base iteration budget')
  assert.match(agentConfig, /MAX_ITERATIONS\s*=\s*180/, 'long tasks need a higher global iteration ceiling')
  assert.match(agentConfig, /COMPLEXITY_ITERATION_BONUS\s*=\s*\{\s*1:\s*0,\s*2:\s*40,\s*3:\s*96\s*\}/, 'complex research tasks need expanded but not runaway iteration bonus')
  assert.match(agentConfig, /MIN_RESEARCH_CALLS_BY_COMPLEXITY\s*=\s*\{\s*1:\s*4,\s*2:\s*10,\s*3:\s*18\s*\}/, 'complex research phases need a serious evidence-call floor without overworking quick tasks')
  assert.match(agentConfig, /MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY\s*=\s*\{\s*1:\s*2,\s*2:\s*6,\s*3:\s*8\s*\}/, 'complex research phases need source diversity without forcing excessive quick-task breadth')
  assert.match(agentConfig, /COMPLEXITY_BUDGET_MULTIPLIERS\s*=\s*\{\s*1:\s*0\.85,[\s\S]*2:\s*1\.45,[\s\S]*3:\s*2\.05,/, 'task effort should preserve quality headroom while speed fixes remove stalls instead of reducing depth')
  assert.match(prompts, /const toolOrArtifactWork =[\s\S]*current\s*\|latest[\s\S]*build[\s\S]*deploy[\s\S]*return 3/, 'normal tool, artifact, current, and deployment work must start with high default effort')
  assert.match(agentLoop, /CREDIT_PREFLIGHT_CACHE_MS\s*=\s*60_000/, 'credit runway checks must be cached briefly so startup and action turns do not stall on repeated account reads')
  assert.match(agentLoop, /lastCreditRunwayCheckAt = Date\.now\(\)/, 'newly accepted tasks should treat the route-level credit check as fresh for startup control calls')
  assert.match(agentLoop, /assertServerCreditRunwayCached/, 'agent loop must use cached credit runway checks before model calls')
  assert.match(agentLoop, /const assertPlannerCreditRunway = async \(\) => this\.assertServerCreditRunwayCached\(\)/, 'planner control calls must share the cached credit runway instead of rechecking credits before acknowledgement')
  assert.match(agentLoop, /new PlanManager\(this\.emitter,\s*planningMessages,\s*complexity,\s*requiredFirstSteps,\s*effectiveCustomInstructions,\s*recordPlannerUsage,\s*assertPlannerCreditRunway,\s*this\.options\.skipStartupAcknowledgement === true\)/, 'AgentLoop must wire effective custom instructions, credit usage, credit preflight, and startup acknowledgement control into PlanManager')
  assert.match(agentLoop, /shouldHydrateResearchActivity[\s\S]*this\.options\.startFreshSandbox !== true[\s\S]*loadResearchActivityEntries/, 'fresh tasks must not block startup acknowledgement on an already-cleared research activity read')
  assert.match(chatTaskRunner, /const startupTasks: Array<Promise<unknown>> = \[\][\s\S]*void clearResearchActivityForTask\(userId,\s*conversationId,\s*staleResearchCutoff\)[\s\S]*resetLocalSandboxDir[\s\S]*taskStartCreditPromise = chargeServerTaskStart[\s\S]*await Promise\.all\(startupTasks\)/, 'background task startup must keep sandbox reset parallel and move stale research cleanup plus task-start billing off the acknowledgement critical path')
  assert.doesNotMatch(chatTaskRunner, /startupTasks\.push\(\s*chargeServerTaskStart/, 'task-start credit charging must not block first acknowledgement startup')
  assert.match(researchActivityLog, /created_at < \?/, 'async stale research cleanup must be timestamp-bounded so it cannot delete new task activity written after startup')
  assert.match(agentLoop, /latestUserMessage = \[\.\.\.messages\]\.reverse\(\)\.find\(m => m\.role === 'user'\)/, 'prompt-injection checks must only inspect the latest user turn')
  assert.doesNotMatch(agentLoop, /messages\.some\(\s*\n\s*m => m\.role === 'user' && isPromptInjection/, 'old user messages must not poison later unrelated tasks')
  assert.match(planManager, /Boot local preview/, 'website plans must still require local visual QA')
  assert.doesNotMatch(planManager, /deterministic|Deterministic|shouldUseDeterministic|Used deterministic/, 'planner must not use deterministic shortcut planning paths')
  assert.doesNotMatch(planManager, /browserActionPlanTemplate|websiteBuildPlanTemplate|codePlanTemplate|longWritingPlanTemplate|simpleFilePlanTemplate/, 'planner must not fabricate hard-coded plan templates')
  assert.match(planManager, /Read selected skill file/, 'skill/file plans must keep an explicit read phase')
  assert.match(planManager, /Use visual screenshot state plus fresh indexed controls/, 'browser action plans must require visual + indexed control verification')
  assert.match(planManager, /Do not use a canned generic plan/, 'planner repair prompt must reject canned generic plans')
  assert.match(planManager, /Every title and scope must mention or clearly reflect the user's concrete topic/, 'planner repair prompt must require topic-specific steps')
  assert.match(planManager, /function containsPromptInstructionLeak/, 'planner must detect leaked prompt instruction text in visible acknowledgement and plan labels')
  assert.match(planManager, /accepting model-authored plan instead of blocking startup/, 'planner text quality warnings must not block model-authored plans')
  const enforceMinStepsContract = planManager.match(/private enforceMinSteps[\s\S]*?\n  \}/)?.[0] || ''
  assert.doesNotMatch(enforceMinStepsContract, /PLANNER_QUALITY_ERROR|throw new Error|steps\.length\s*[<>=!]/, 'planner must not veto model-authored step counts or phase shapes')
  assert.match(planManager, /Do NOT browse, scroll, read pages\/documents, or run extra searches/, 'single-search plans must prohibit compensating browser reads')
  assert.match(agentLoop, /INTERRUPTION UPDATE/, 'agent loop must treat short follow-ups as task corrections, not standalone answers')
  assert.match(agentLoop, /state\.originalUserRequest = effectiveTaskRequest\(messages\)/, 'agent loop must preserve the prior task in original request state')
  assert.match(agentLoop, /Plan for the combined effective request/, 'planner must receive explicit interruption context')
  assert.match(useAgentStream, /\/api\/chat\/directive/, 'mid-task user messages must be sent to the live directive queue')
  assert.match(useAgentStream, /existingController && !isAutoSend/, 'active-stream user messages must take the live directive path')
  assert.match(useAgentStream, /addLiveDirectiveExchange/, 'live directives must split the visible assistant turn without starting a new run')
  assert.match(useAgentStream, /isFirstTaskAutoStart = conversation\.messages\.length === 1 && conversation\.messages\[0\]\?\.role === 'user'/, 'first prompt auto-starts must still use the fresh task startup path')
  assert.match(useAgentStream, /startFreshSandbox = isFirstTaskAutoStart \|\| \(!isAutoSend && !isContextualTaskUpdateText\(latestUserContent\)\)/, 'auto-send must not skip initializing/creating-plan status for the first task')
  assert.match(useAgentStream, /setStreamingStatus\(startFreshSandbox \? 'startup' : 'thinking'\)/, 'setup status must only show for fresh task sandbox startup, not every prompt')
  assert.match(eventDispatcher, /getTerminalErrorMessage\(\)/, 'dispatcher must expose terminal error details to the client')
  assert.match(errorMessages, /OBJECT_STRING\s*=\s*'\[object Object\]'/, 'shared error helper must explicitly reject object-string leaks')
  assert.match(errorMessages, /export function userErrorMessage/, 'shared error helper must expose safe user-facing error normalization')
  assert.match(useAgentStream, /userErrorMessage\(errorBody\?\.error \?\? errorBody/, 'stream startup errors must normalize object-shaped API payloads')
  assert.match(eventDispatcher, /userErrorMessage\(event\.message/, 'SSE error events must be normalized before reaching streamError')
  assert.match(chatRoute, /const message = userErrorMessage\(error/, 'chat route must normalize unknown backend errors before emitting them')
  assert.match(agentLoop, /const message = userErrorMessage\(error/, 'agent loop must normalize unknown runtime errors before emitting them')
  assert.match(chatPage, /const message = userErrorMessage\(error/, 'chat error banner must defend against object-string errors')
  assert.match(eventDispatcher, /handlePlan[\s\S]*setStreamingStatus\('thinking'\)/, 'planned task threads must show thinking after setup completes')
  assert.match(eventDispatcher, /handleToolResult[\s\S]*setStreamingStatus\('thinking'\)/, 'tool results must return the visible state to thinking while the model decides the next action')
  assert.match(eventDispatcher, /isIncompleteStartupAcknowledgment/, 'startup acknowledgement capture must reject partial fragments like "I’ll"')
  assert.match(eventDispatcher, /selectBestStartupAcknowledgment/, 'completion rewrite must choose the best current acknowledgement instead of blindly using an early cached fragment')
  assert.doesNotMatch(eventDispatcher, /if \(this\.startupAcknowledgment\) return/, 'startup acknowledgement capture must not permanently lock onto the first partial fragment')
  assert.match(eventDispatcher, /const currentAck = this\.cleanAcknowledgmentCandidate\(currentContent\)/, 'completion must compare against the current full message acknowledgement')
  assert.match(useAgentStream, /dispatcher\.getTerminalStatus\(\) === 'error'[\s\S]*?dispatcher\.getTerminalErrorMessage\(\)/, 'empty error streams must preserve the backend error instead of showing a generic no-response message')
  assert.match(eventDispatcher, /isHiddenInternalToolResult/, 'internal skipped tool results must be hidden by the stream dispatcher')
  assert.match(eventDispatcher, /removeComputerPanelItem\(this\.conversationId,\s*panelFocusIdForTool\(event\.name,\s*event\.id\)\)/, 'hidden skipped tools must remove their streaming computer-panel placeholder')
  assert.match(artifactSlice, /removeComputerPanelItem/, 'chat store must support removing stale computer panel placeholders')
  assert.match(useAgentStream, /removeComputerPanelItem/, 'stream dispatcher must receive the remove-computer-panel action')
  assert.doesNotMatch(searchResults, /choosing another route/, 'search panel must not show a skipped-search fallback message')
  assert.match(liveDirectives, /enqueueLiveDirective/, 'live directive queue must expose enqueue semantics')
  assert.match(liveDirectives, /drainLiveDirectives/, 'live directive queue must expose drain semantics for the running agent loop')
  assert.match(inputLimits, /MAX_TASK_INPUT_CHARS\s*=\s*1000/, 'task input must be capped at exactly 1000 characters')
  assert.match(inputLimits, /clampTaskInput/, 'shared task input limit helper must expose deterministic clamping')
  assert.match(chatInput, /maxLength=\{MAX_TASK_INPUT_CHARS\}/, 'main composer textarea must set a native 1000-character maxLength')
  assert.match(chatInput, /clampTaskInput/, 'main composer must clamp programmatic inserts, drafts, paste, and voice input')
  assert.match(chatInput, /taskInputLimitMessage/, 'main composer must show a consistent limit message when overflow is attempted')
  assert.match(chatInput, /\{value\.length\.toLocaleString\(\)\} \/ \{MAX_TASK_INPUT_CHARS\.toLocaleString\(\)\}/, 'main composer must show the 1000-character cap in its counter')
  assert.match(chatInput, /optimisticTaskStarting = submitPending && !isStreaming && !isProcessingFiles/, 'composer must show a running state immediately after task submit before global stream state flushes')
  assert.match(chatInput, /showStopButton = \(isStreaming \|\| optimisticTaskStarting\)/, 'composer send button must switch to stop/running state during optimistic task startup')
  assert.doesNotMatch(userMessage, /onEditMessage|setEditing|editValue|Save & Send|MAX_TASK_INPUT_CHARS|clampTaskInput/, 'user messages must not expose an edit-and-resend path')
  assert.doesNotMatch(messageList, /onEditMessage/, 'message list must not pass edit handlers into user messages')
  assert.doesNotMatch(chatPage, /handleEditMessage|onEditMessage/, 'chat page must not wire any user-message edit handler')
  assert.match(useAgentStream, /boundedContent = clampTaskInput\(content\)/, 'stream sender must clamp oversized user task content before starting a task')
  assert.match(useAgentStream, /content: m\.role === 'user' \? clampTaskInput\(m\.content\) : m\.content/, 'stream sender must normalize prior user messages before sending chat requests')
  assert.match(useAgentStream, /taskInputLimitMessage\(\)/, 'stream sender must use the shared input-limit message when it clamps overflow')
  assert.match(validationSchemas, /message\.role === 'user'[\s\S]*clampTaskInput\(message\.content\)/, 'chat request schema must normalize user messages to the task input cap')
  assert.match(liveDirectives, /MAX_LIVE_DIRECTIVE_CHARS = MAX_TASK_INPUT_CHARS/, 'live directives must share the 1000-character task cap')
  assert.match(chatDirectiveRoute, /content: z\.string\(\)\.trim\(\)\.min\(1\)\.transform\(\(value\) => clampTaskInput\(value\)\)/, 'live directive API must clamp overflow before enqueueing')
  assert.match(chatDirectiveRoute, /assertTaskAccess\(request,\s*conversationId,\s*\{ userId \}\)/, 'live directive route must require access to the existing task')
  assert.match(chatDirectiveRoute, /enqueueLiveDirective/, 'live directive route must enqueue instead of starting a replacement chat run')
  assert.match(agentLoop, /drainLiveDirectives/, 'agent loop must consume live user directives')
  assert.match(agentLoop, /superseded pending tool calls/, 'live directives must stop stale queued tool calls before execution')
  assert.match(messageSlice, /addLiveDirectiveExchange/, 'chat store must support inserting live user directives into an active task')
  assert.match(messageSlice, /messages\.splice\(i \+ 1,\s*0,\s*boundedUserMessage,\s*continuation\)/, 'live directive messages must keep the continuing assistant turn after the clamped user redirect')
  assert.match(chatInput, /Send live instruction/, 'composer copy must describe live task redirection instead of interruption')
  assert.match(chatRoute, /export const maxDuration = 300/, 'agent chat route must stay within the deployed Hobby plan duration cap')
  assert.match(agentConfig, /AGENT_RUN_MAX_DURATION_MS\s*=\s*270_000/, 'agent runtime must stay below the production route wall-clock budget')
  assert.match(agentConfig, /AGENT_DEADLINE_FINALIZATION_BUFFER_MS\s*=\s*150_000/, 'agent runtime must reserve a substantial final synthesis window before platform termination')
  assert.match(agentConfig, /AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS\s*=\s*20_000/, 'deadline model turns must be capped during finalization')
  assert.match(agentConfig, /AGENT_DEADLINE_HARD_STOP_BUFFER_MS\s*=\s*18_000/, 'agent runtime must keep a hard stop buffer before route termination')
  assert.match(agentConfig, /AGENT_WORKER_RUN_MAX_DURATION_MS\s*=\s*900_000/, 'background workers must have a longer quality window than serverless routes')
  assert.match(agentConfig, /AGENT_WORKER_DEADLINE_FINALIZATION_BUFFER_MS\s*=\s*120_000/, 'background workers must not enter deadline synthesis after only a short research window')
  assert.match(agentConfig, /AGENT_WORKER_DEADLINE_MODEL_TURN_TIMEOUT_MS\s*=\s*12_000/, 'background workers must fail forward quickly instead of waiting near 30 seconds on stalled model turns')
  assert.match(chatTaskRunner, /runMaxDurationMs:\s*AGENT_WORKER_RUN_MAX_DURATION_MS/, 'background workers must pass their longer runtime window into AgentLoop')
  assert.match(chatTaskRunner, /deadlineFinalizationBufferMs:\s*AGENT_WORKER_DEADLINE_FINALIZATION_BUFFER_MS/, 'background workers must pass their deadline buffer into AgentLoop')
  assert.match(agentState, /runStartedAtMs/, 'agent state must track wall-clock start time for long task deadline handling')
  assert.match(agentState, /deadlineFinalizationStarted/, 'agent state must ensure deadline finalization is entered only once')
  assert.match(agentLoop, /maybeStartDeadlineFinalization/, 'agent loop must force final synthesis before a platform timeout can kill the stream')
  assert.match(agentLoop, /currentStepIdx < state\.currentPlanItems\.length - 1\) return false/, 'deadline finalization must not start before the final phase')
  assert.doesNotMatch(agentLoop, /while \(state\.currentStepIdx < state\.currentPlanItems\.length - 1\)/, 'deadline finalization must not fast-forward unfinished phases')
  assert.match(agentLoop, /RUNTIME FINALIZATION DEADLINE/, 'deadline finalization prompt must stop new research and create the deliverable')
  assert.match(agentLoop, /deadlineFinalTools/, 'deadline finalization must expose only deliverable tools, not more research tools')
  assert.match(agentLoop, /agentRunRemainingMs\(state\) - \(state\.deadlineHardStopBufferMs \|\| AGENT_DEADLINE_HARD_STOP_BUFFER_MS\)/, 'deadline finalization model calls must stay below the remaining platform time')
  assert.match(messageList, /lastAssistantMsg/, 'stream autoscroll must follow the active assistant even after a live user message')
  assert.match(messageList, /FOLLOW_BOTTOM_THRESHOLD_PX/, 'chat autoscroll must use a distance-from-bottom threshold instead of forcing every stream update')
  assert.match(messageList, /shouldForceForUserTurn/, 'new user turns may force-scroll to the bottom')
  assert.match(messageList, /shouldFollowStream = !userScrolledUp\.current/, 'agent stream updates must only autoscroll while the user remains pinned to bottom')
  assert.doesNotMatch(messageList, /scrollingUp && distanceFromBottom/, 'chat autoscroll must not depend on brittle upward-motion detection')
  assert.match(agentMessage, /allPlannedGroupsDone = hasGroups && taskGroups\.every\(\(g\) => g\.status === 'done'\)/, 'completion banner must require every planned task group to be done')
  assert.match(agentMessage, /completedSteps=\{taskGroups\.filter\(\(g\) => g\.status === 'done'\)\.length\}/, 'completion details must count all planned groups, not just started groups')
  assert.doesNotMatch(agentMessage, /const allGroupsDone = hasGroups && activeGroups\.every/, 'completion must not ignore pending unstarted plan groups')
  assert.match(chatPage, /setStreamingStatus\('thinking'\)/, 'route restore for active streams must not re-show fresh sandbox setup')
  assert.match(appLayout, /const session = await auth\(\)\.catch\(\(\) => null\)/, 'root layout must resolve the server session before hydrating the client provider')
  assert.match(appLayout, /<AuthSessionProvider session=\{session\}>/, 'root layout must pass the resolved session into SessionProvider')
  assert.match(authSessionProvider, /<SessionProvider session=\{session\}>/, 'SessionProvider must receive initial session state to avoid a permanent loading gate')
  assert.match(appFrame, /import \{ MainContent \} from '@\/components\/layout\/MainContent'/, 'main route wrapper must be a normal import so route children do not disappear during navigation')
  assert.doesNotMatch(appFrame, /const MainContent = dynamic/, 'main route wrapper must not use ssr:false dynamic import around route children')
  assert.match(uiStore, /routeHandoffPending: boolean/, 'ui store must expose a transient route handoff flag')
  assert.match(uiStore, /setRouteHandoffPending: \(pending: boolean\) => void/, 'ui store must expose a setter for route handoff state')
  assert.match(useAgentStream, /export async function startInitialAgentTask\(conversationId: string\)/, 'agent stream module must expose an imperative first-task starter')
  assert.match(homePage, /import \{ startInitialAgentTask \} from '@\/stream\/client\/useAgentStream'/, 'home page must use the immediate first-task starter')
  assert.match(homeSubmit, /setStreamingStatus\('startup'\)[\s\S]*startInitialAgentTask\(id\)[\s\S]*router\.push\(`\/chat\/\$\{id\}`\)/, 'home submit must open the task stream before routing to the chat page')
  assert.match(homeSubmit, /Failed to bind attachments after navigation[\s\S]*attachment syncing is still having trouble/, 'home submit should only show the sync warning for attachment binding failures')
  assert.match(homeSubmit, /Failed to sync new task after navigation[\s\S]*window\.setTimeout[\s\S]*Retried task history sync failed/, 'home submit should retry task-history sync quietly instead of showing a false catching-up toast')
  assert.match(chatPage, /if \(hasActiveAgentStream\(id\)\) \{[\s\S]*hasSentRef\.current = true[\s\S]*return[\s\S]*\}/, 'chat page auto-send must not duplicate an immediate home-launched stream')
  assert.match(chatPage, /if \(!hydrated\) return[\s\S]*setRouteHandoffPending\(false\)/, 'chat page must not clear route handoff until the task route has hydrated')
  assert.match(sidebar, /setRouteHandoffPending\(true\)[\s\S]*router\.push\(`\/chat\/\$\{id\}`\)/, 'sidebar task opens must show the route handoff skeleton before pushing chat routes')
  assert.match(sidebar, /setRouteHandoffPending\(false\)[\s\S]*router\.push\('\/'\)/, 'starting a new task from the sidebar must clear pending chat handoff state')
  assert.match(mainContent, /routeHandoffPending = useUIStore/, 'main content must subscribe to route handoff state')
  assert.match(mainContent, /!\s*authRoute && routeHandoffPending && \(/, 'main content must show a placeholder during pending non-auth route handoffs')
  assert.match(mainContent, /\{children\}/, 'main content must keep route children mounted so chat pages can clear pending handoff state')
  assert.match(mainContent, /data-chat-route-placeholder/, 'chat route handoff must render a placeholder instead of an empty main')
  assert.match(mainContent, /<ChatSkeleton \/>/, 'chat route placeholder must use the established chat skeleton')
  assert.match(authGate, /const \{ data: session, status \} = useSession\(\)/, 'auth gate must read the preloaded session object, not only the status flag')
  assert.match(authGate, /const hasSession = !!session\?\.user\?\.id/, 'auth gate must track session data separately from the status flag')
  assert.match(authGate, /if \(status === 'loading'\) \{\s*return <>\{children\}<\/>\s*\}/, 'auth gate loading state must keep routed children visible instead of blanking the app shell')
  assert.match(authGate, /status === 'unauthenticated' && !hasSession/, 'auth gate must not hide children when the status flag is stale but session data exists')
  assert.match(appLayout, /<ChatStoreSync \/>/, 'root layout must mount authenticated DB task-history sync')
  assert.match(globalsCss, /--accent-blue:\s*var\(--text-secondary\)/, 'general accent-blue must preserve the existing muted app accent')
  assert.match(globalsCss, /--status-live:\s*#0081f2/, 'light theme must expose a dedicated blue live-status token')
  assert.match(globalsCss, /--status-live:\s*#2f8cff/, 'dark theme must expose a dedicated blue live-status token')
  assert.match(globalsCss, /--color-status-live:\s*var\(--status-live\)/, 'Tailwind must expose the dedicated live-status token')
  assert.doesNotMatch(agentMessage, /Agent<\/span>[\s\S]{0,180}animate-live-pulse/, 'agent message header must not show a blinking live dot next to the Agent label')
  assert.doesNotMatch(chatPage, /conversation\.title[\s\S]{0,220}animate-live-pulse/, 'chat top bar must not show a blue live dot next to the task title')
  assert.doesNotMatch(panelHeader, /animate-live-pulse|bg-status-live/, 'computer panel header must show status text without a live dot')
  assert.match(panelHeader, /startup:\s*'Initializing computer'/, 'computer panel startup copy must align with the inline boot status')
  assert.match(typingIndicator, /Initializing computer/, 'startup indicator must begin with computer initialization copy')
  assert.match(typingIndicator, /Creating plan/, 'startup indicator must smoothly advance to creating-plan copy before thinking')
  assert.match(typingIndicator, /status === 'startup'[\s\S]*elapsedMs < 750/, 'startup indicator must time the initialising-to-planning transition locally')
  assert.match(typingIndicator, /bg-status-live" style=\{\{ animation: 'pulse-dot 1\.8s ease-in-out infinite' \}\}/, 'startup indicator must use the same blue pulse-dot animation as in-task thinking')
  assert.doesNotMatch(typingIndicator, /animate-live-pulse/, 'startup indicator must not use the ring-style live pulse animation')
  assert.doesNotMatch(typingIndicator, /rounded-2xl border border-border-primary bg-bg-secondary px-3 py-2\.5/, 'startup indicator must not render the old large boxed card')
  assert.doesNotMatch(typingIndicator, /Planning the next action|Computer ready|Task context/, 'startup indicator must not show the old card detail rows')
  assert.match(useAgentStream, /setStreaming\(true\)[\s\S]*?fetch\('\/api\/chat'/, 'new tasks must enter visible running state and reach the server without waiting on cached client credit preflight')
  assert.doesNotMatch(useAgentStream, /await useCreditStore\.getState\(\)\.syncFromServer\(\)[\s\S]*?fetch\('\/api\/chat'/, 'cached client credit sync must not block new task startup before the authoritative server check')
  assert.match(useAgentStream, /let existingController = activeControllers\.get\(conversationId\) \?\? abortRef\.current/, 'follow-up sends must treat controllers as mutable so stale aborted streams can be cleared')
  assert.match(useAgentStream, /if \(existingController\?\.signal\.aborted\) \{[\s\S]*activeControllers\.delete\(conversationId\)[\s\S]*existingController = null[\s\S]*\}/, 'follow-up sends must clear stale aborted controllers before deciding between directive and fresh-task routing')
  assert.match(useAgentStream, /if \(!existingController && storedActiveRun && !isAutoSend\) \{[\s\S]*fetchServerActiveRun\(conversationId\)[\s\S]*clearStoredActiveRun\(conversationId, storedActiveRun\.runId\)[\s\S]*storedActiveRun = null[\s\S]*\}/, 'follow-up sends must verify stored active runs with the server before routing text to live directives')
  assert.match(activeChatRoute, /if \(shouldUseExternalTaskWorker\(\)\) \{[\s\S]*return Response\.json\(\{ active: false \}\)[\s\S]*\}/, 'external-worker active-run discovery must not expose orphan active-task leases as live jobs')
  assert.match(chatDirectiveRoute, /const activeJob = await findActiveTaskJobForConversation\(userId,\s*conversationId\)[\s\S]*if \(!activeJob\) \{[\s\S]*NO_ACTIVE_TASK_FOR_DIRECTIVE/, 'live directives must be rejected when no queued or running job can consume them')
  assert.doesNotMatch(rootOverlays, /MobileUnsupportedGate|Desktop required|not mobile optimized/, 'root overlays must not block authenticated mobile app routes')
  assert.match(appFrame, /flex-1 min-w-0 w-full min-h-screen/, 'app frame must let mobile route content shrink to the viewport width')
  assert.match(mainContent, /flex-1 min-w-0 w-full min-h-screen/, 'main content must prevent protected app routes from causing horizontal mobile overflow')
  assert.match(chatPage, /h-\[100dvh\] min-h-\[100dvh\]/, 'chat route must use dynamic viewport height on mobile')
  assert.match(chatPage, /overflow-visible pl-14 pr-2/, 'chat top bar must keep dropdown menus visible while preserving small mobile padding')
  assert.match(computerPanel, /z-\[130\][\s\S]*h-\[100dvh\]/, 'computer panel must render as a full-screen mobile sheet above the chat')
  assert.match(computerPanel, /overflow-x-auto scrollbar-none/, 'computer panel tabs must be horizontally scrollable on mobile')
  assert.match(chatInput, /bottom-\[calc\(5\.25rem\+env\(safe-area-inset-bottom\)\)\]/, 'attachment menu must stay inside the mobile viewport above the composer')
  assert.match(userMessage, /max-w-\[calc\(100vw-2rem\)\][\s\S]*break-words/, 'user message bubbles must wrap safely on narrow mobile screens')
  assert.match(chatStoreSync, /useSession/, 'chat history sync must wait for the authenticated account')
  assert.match(chatStoreSync, /initializeChatStoreSync\(userId\)/, 'chat history sync must start with the authenticated user id')
  assert.doesNotMatch(chatStoreIndex, /persist\(/, 'chat/task history must not use browser-local Zustand persistence as the source of truth')
  assert.doesNotMatch(chatStoreIndex, /debouncedIdbStorage|TASK_STORE_KEY/, 'chat store must not hydrate task history from IndexedDB storage')
  assert.match(chatStoreIndex, /initializeChatStoreServerSync\(userId,\s*useChatStore\)/, 'chat store must initialize account-scoped server persistence')
  assert.doesNotMatch(chatPersistence, /createJSONStorage|createDebouncedStorage|StateStorage/, 'legacy chat persistence must not provide runtime local storage persistence')
  assert.match(chatPersistence, /readLegacyChatPersistedState/, 'legacy local chat state should only be available for one-time DB migration')
  assert.match(chatPersistence, /clearLegacyChatPersistence/, 'legacy local chat state must be clearable after DB migration')
  assert.doesNotMatch(useHydration, /setTimeout/, 'task UI hydration must not time out into browser-local task state')
  assert.match(chatServerSync, /fetch\('\/api\/conversations'/, 'client task sync must load and save through the account DB API')
  assert.match(chatServerSync, /readLegacyChatPersistedState/, 'client task sync must import old local history only during migration')
  assert.match(chatServerSync, /getChangedConversations/, 'client task sync must upsert changed conversations instead of overwriting the whole account store')
  assert.match(chatServerSync, /getDeletedIds/, 'client task sync must send explicit deletes for account task rows')
  assert.match(chatServerSync, /REFRESH_INTERVAL_MS/, 'client task sync must refresh open browsers from server state')
  assert.match(chatServerSync, /SAVE_DEBOUNCE_MS\s*=\s*250/, 'new and changed tasks must be queued for DB save almost immediately')
  assert.match(chatServerSync, /REFRESH_INTERVAL_MS\s*=\s*5_000/, 'other browser sessions must refresh account tasks within seconds')
  assert.match(chatServerSync, /REFRESH_THROTTLE_MS\s*=\s*1_500/, 'manual focus refreshes must not be throttled for multiple seconds')
  assert.match(chatServerSync, /SYNC_MANAGER_READY_WAIT_MS\s*=\s*4_000[\s\S]*waitForSyncManagerReady[\s\S]*flushChatServerSync\(\): Promise<void> \{[\s\S]*await waitForSyncManagerReady\(\)/, 'first-task history flush must wait briefly for account sync to mount before deciding it has nothing to save')
  assert.match(chatServerSync, /serverSummary/, 'client sync must mark account task index rows as metadata-only summaries')
  assert.match(chatServerSync, /if \(isServerSummaryConversation\(existing\)\) \{[\s\S]*byId\.set\(conversation\.id, conversation\)[\s\S]*const \{ serverSummary: _serverSummary, \.\.\.existingBody \} = existing/, 'metadata-only refreshes must not turn an already loaded task body back into a loading-only server summary')
  assert.match(chatServerSync, /!isServerSummaryConversation\(conversation\)[\s\S]*lastSavedUpdatedAt/, 'metadata-only task summaries must never be posted back as full task bodies')
  assert.match(chatServerSync, /loadConversationFromServer/, 'client sync must expose lazy full-body task loading')
  assert.match(chatStoreIndex, /loadConversationFromServer/, 'chat store must export lazy full-body task loading for opened DB tasks')
  assert.match(chatPage, /loadConversationFromServer\(id\)/, 'chat routes must lazy-load the full DB task body when a summary task is opened')
  assert.match(chatLoading, /<ChatSkeleton \/>/, 'chat route transitions must show the chat skeleton instead of an empty main while the route child resolves')
  assert.match(chatServerSync, /visibilitychange/, 'client task sync must refresh or flush on browser visibility changes')
  assert.match(conversationsLib, /create table if not exists conversations/, 'server must create a DB conversations table')
  assert.match(conversationsLib, /primary key \(user_id, id\)/, 'conversation rows must be account-scoped by user id and task id')
  assert.match(conversationsLib, /export async function getUserConversationIndex/, 'server must expose a lightweight account task index')
  assert.match(conversationsLib, /select id, title, starred, folder, created_at_ms, updated_at_ms/, 'task index queries must not pull every body_json during initial hydration')
  assert.match(conversationsLib, /export async function getUserConversationById/, 'server must expose one-task full body loading')
  assert.match(conversationsLib, /tursoTransaction\('write'/, 'conversation sync writes must be DB transactions')
  assert.match(conversationsLib, /on conflict\(user_id, id\) do update/, 'conversation sync must upsert individual task rows')
  assert.match(conversationsLib, /excluded\.updated_at_ms >= conversations\.updated_at_ms/, 'older browser saves must not overwrite newer task rows')
  assert.match(conversationsLib, /excluded\.updated_at_ms >= coalesce\(conversations\.deleted_at_ms, 0\)/, 'older browser saves must not resurrect later-deleted task rows')
  assert.match(conversationsLib, /deleted_at_ms/, 'conversation deletes must be persisted as server tombstones')
  assert.match(conversationsRoute, /auth\(\)/, 'conversation API must require the authenticated account')
  assert.match(conversationsRoute, /assertSameOriginRequest/, 'conversation write API must enforce same-origin requests')
  assert.match(conversationsRoute, /getUserConversationIndex/, 'conversation API GET must load DB-backed account task history as a fast index')
  assert.match(conversationsRoute, /getUserConversationById/, 'conversation API GET must support one-task body loading by id')
  assert.match(conversationsRoute, /searchParams\.get\('id'\)/, 'conversation API must branch between index loading and full task loading')
  assert.match(conversationsRoute, /partial: true/, 'conversation API task index responses must be identified as partial summaries')
  assert.match(conversationsRoute, /syncUserConversations/, 'conversation API POST must save DB-backed account task history')
  assert.match(conversationsRoute, /clearUserConversations/, 'conversation API DELETE must clear DB-backed account task history')
  assert.match(settingsDataTab, /clearServerConversations/, 'settings clear tasks must clear server account task history')
  assert.match(settingsDataTab, /group-hover:bg-bg-secondary group-hover:text-text-primary/, 'profile photo upload badge must use the darker hoverable control surface')
  assert.doesNotMatch(settingsDataTab, /bg-bg-elevated text-text-secondary shadow-sm/, 'profile photo upload badge must not use the lighter elevated surface')
  assert.doesNotMatch(creditPillSource, /Monthly balance|Paid credits|Available this month|Renews on/, 'compact credit pill dropdown must not show the monthly balance card')
  assert.doesNotMatch(creditPillSource, />\s*Monthly\s*</, 'compact credit pill dropdown must not show the inactive Monthly badge')
  assert.doesNotMatch(creditPillSource, /Live task/, 'compact credit pill dropdown must not show a live-task badge while tasks run')
  assert.match(chatPage, /hasComputerPanelContent = computerPanelData\.length > 0 \|\| webIdeMode/, 'chat layout must know when computer content actually exists')
  assert.match(chatPage, /showComputerPanel = computerPanelOpen && hasComputerPanelContent/, 'chat layout must not reserve computer-panel space until content is ready')
  assert.match(chatPage, /\{showComputerPanel && \([\s\S]*?<ComputerPanel items=\{computerPanelData\}/, 'computer panel should render only when the open panel has real content')
  assert.match(computerPanel, /function isLivePanelItem/, 'computer panel must classify live activity generically, not only browser frames')
  assert.match(computerPanel, /item\.streaming/, 'streaming file/search/terminal/browser items must count as live')
  assert.match(computerPanel, /aria-label="Jump to live activity"/, 'timeline footer must expose a jump-to-live affordance when viewing a stale item')
  assert.doesNotMatch(computerPanel, /isAtLatest && isBrowserActive/, 'live footer must not be limited to the latest browser item only')
  assert.match(searchResults, /Search result is unavailable/, 'search panel must render a visible fallback for error-shaped search results instead of going blank')
  assert.doesNotMatch(searchResults, /'error' in results[\s\S]{0,160}return null/, 'search panel must not hide provider-error payloads after an action appears')
  assert.match(browseView, /No extracted text was returned for this source/, 'browse panel must render a fallback body when a page extraction returns no text')
  assert.match(computerPanel, /focusedVisibleIndex[\s\S]*setComputerPanelActiveItemId\(null\)/, 'computer panel must clear stale focused item ids instead of staying on an empty activity view')
  assert.doesNotMatch(toolPipeline, new RegExp(['blocked', 'Domains', 'Has'].join('') + '|was previously marked\\s+blocked|hard\\s+navigation\\s+block'), 'browser navigation must not short-circuit based on site-level block heuristics')
  assert.match(toolPipeline, /recordWorkLedgerFailure/, 'tool failures must be recorded in the work ledger')
  assert.match(toolPipeline, /recordWorkLedgerVerification/, 'verified outputs must be recorded in the work ledger')
  assert.match(toolPipeline, /singleWebSearchLimitBlockReason/, 'tool pipeline must block extra web actions after an explicit one-search limit')
  assert.match(toolPipeline, /a second web_search was skipped/, 'tool pipeline must block repeated web_search calls for one-search tasks')
  assert.match(toolPipeline, /not browsing or additional page reading/, 'tool pipeline must block browser reads for one-search tasks')
  assert.match(toolPipeline, /deliverable:\s*purpose === 'deliverable'[\s\S]*?purpose,/, 'file artifacts must carry dynamic explicit purpose')
  assert.match(toolPipeline, /deliverable:\s*purpose === 'deliverable'/, 'artifact UI visibility must follow artifact purpose')
  assert.match(toolPipeline, /purpose\s*=\s*deliverable \? 'deliverable' : 'support'/, 'support images must not become final deliverables by default')
  assert.match(toolPipeline, /kind:\s*'browser-final-state'/, 'browser task completion must satisfy final browser verification')
  assert.match(toolPipeline, /kind:\s*'browser-hard-blocker'/, 'concrete browser hard blockers must satisfy final browser verification')
  assert.match(toolPipeline, /browserCompletionObjectiveText\(state\)/, 'browser completion detection must use the current step objective, not the whole user request')
  assert.match(toolPipeline, /Complete runnable website files created/, 'complete website file sets must satisfy structure requirements')
  assert.match(browser, /POST_BROWSER_ACTION_SETTLE_MS/, 'browser actions must settle before screenshot capture')
  assert.match(browser, /BROWSER VISUAL SNAPSHOT|TEXT SEARCH RESULT: No visible text nodes matched/, 'text lookup failure must provide visual context')
  assert.match(browser, /sanitizeBrowserAutomationError/, 'browser tool errors must hide raw Playwright call logs')
  assert.match(browser, /selectDropdownOption/, 'dropdown selection must validate enabled options before Playwright selectOption')
  assert.match(browser, /options: element\.options/, 'fresh element snapshots must expose dropdown option hints')
  assert.match(browser, /Option "\$\{value\}" is not an enabled choice/, 'dropdown failures must return actionable option guidance')
  assert.match(browser, /pageAppearsHealthyForActions/, 'stale page blockers must be cleared when the live page is actionable')
  assert.match(browser, /session\.pageBlocker = null/, 'browser preflight must be able to clear stale page-level blockers')
  assert.match(browser, /challengeElementSignal/, 'captcha detection must distinguish embedded widgets from blocking challenge screens')
  assert.doesNotMatch(browser, /let captchaDetected = false/, 'navigation must not use a broad hidden iframe captcha precheck')
  assert.match(browser, /healthyDespiteChallenge/, 'content-rich usable pages must not be downgraded to bot blocks because of embedded challenge-like widgets')
  assert.match(browser, /describeNetworkNavigationError/, 'network navigation failures must be sanitized before being shown')
  assert.match(browser, /recoverable navigation failure/, 'network navigation failures must remain recoverable for the requested site')
  assert.doesNotMatch(browser, /Use a different real URL or web_search instead of retrying this exact URL/, 'network navigation failures must not force alternate-source fallback wording')
  assert.doesNotMatch(browser, /session\.failedNavigations\.set\(normUrl,\s*networkError\.failureReason\)/, 'transient network failures must not poison the requested URL for the whole session')
  assert.match(browser, /about:blank/, 'network navigation failures must reset away from chrome error pages before recovery')
  assert.match(browser, /unsupportedBrowserFinalProtocol/, 'browser navigation must distinguish non-HTTP app/deep-link redirects from unsafe HTTP redirects')
  assert.match(browser, /Navigation redirected outside a normal web page/, 'non-HTTP browser redirects must be recoverable instead of freezing the task as unsafe')
  assert.match(browser, /recoverable:\s*true[\s\S]*Redirected outside browser from/, 'non-HTTP final redirects must return a recoverable browser result')
  assert.match(browser, /normalizeBrowserScrollArgs/, 'browser scroll args must be normalized instead of requiring brittle exact shape')
  assert.match(tools, /Scroll page; default direction down/, 'browser_scroll tool schema must advertise its default direction')
  assert.doesNotMatch(tools, /browser_scroll[\s\S]{0,500}required:\s*\['direction'\]/, 'browser_scroll direction must not be schema-required')
  assert.doesNotMatch(toolRegistry, /Missing required argument: direction \(up or down\)/, 'browser_scroll must not fail when direction is omitted')
  assert.match(prompts, /grouped form fields such as Birthday/, 'runtime prompt must guide multi-part form fields by sub-control')
  assert.match(prompts, /one concrete target per step/, 'action plans must stay target-by-target instead of using generic substitutes')
  assert.match(planManager, /one concrete item, field, or choice at a time/, 'website action runtime rules must keep flows target-by-target')
  assert.match(streamConstants, /INTERNAL_ACTIVITY_TOOLS\s*=\s*\['browser_screenshot', 'browser_resize'\]/, 'browser screenshots and stale viewport resizes must be internal activity')
  assert.match(eventDispatcher, /if \(isHiddenActivity\) \{[\s\S]*?return[\s\S]*?\}/, 'internal screenshots must not create visible task pills')
  assert.match(eventDispatcher, /isHiddenInternalToolResult\(event\.name,\s*event\.result\)/, 'internal screenshot and recovery results must stay out of visible panels')
  assert.match(eventDispatcher, /isStaleFutureWorkAck/, 'stale future-tense acknowledgments must be removed from final answers')
  assert.match(eventDispatcher, /extractTaskAcknowledgment/, 'completed tasks must preserve the full streamed startup acknowledgement')
  assert.match(eventDispatcher, /private startupAcknowledgment = ''/, 'dispatcher must cache the startup acknowledgement before task chrome mutates message content')
  assert.match(eventDispatcher, /captureStartupAcknowledgment/, 'dispatcher must capture the startup acknowledgement at plan or first tool boundary')
  assert.match(eventDispatcher, /selectBestStartupAcknowledgment\(this\.startupAcknowledgment,\s*currentAck\)/, 'completion must prefer the best complete acknowledgement instead of an early cached fragment')
  assert.doesNotMatch(eventDispatcher, /const firstBreak = currentContent\.indexOf\('\\n\\n'\)/, 'completion must not truncate acknowledgements at the first blank line')
  assert.match(eventDispatcher, /function cleanStartupAcknowledgmentText/, 'startup acknowledgement capture must use a dedicated cleaner')
  assert.doesNotMatch(eventDispatcher, /cleanAcknowledgmentCandidate[\s\S]{0,240}stripToolActionNarration/, 'startup acknowledgement capture must not erase valid "I will search/check/research" opening paragraphs as tool chatter')
  assert.match(eventDispatcher, /if \(finalContent\.trim\(\)\) \{[\s\S]*setLastMessageContent\(this\.conversationId,\s*finalContent\)[\s\S]*else if \(cleanedExistingContent\)/, 'completion must not blank the assistant message when acknowledgement recovery fails')
  assert.match(agentMessage, /splitTaskMessageContent\(cleanedContent,\s*hasGroups \|\| hasSteps\)/, 'task message rendering must use the shared acknowledgement splitter')
  assert.match(agentMessage, /cleanThinkingTokens\(message\.content\)/, 'rendered assistant messages must clean already-persisted raw tool metadata leaks')
  assert.match(taskMessageContent, /shouldMergeAcknowledgmentParagraph/, 'acknowledgement splitting must merge provider-inserted paragraph breaks')
  assert.match(taskMessageContent, /FINAL_CONTENT_START_PATTERN/, 'acknowledgement splitting must keep final summaries out of the header acknowledgement')
  assert.match(streamCleaners, /stripDisplayToolArgJsonLeaks/, 'stream cleaners must strip raw JSON display-argument leaks')
  assert.match(streamCleaners, /JSON_CHANNEL_MARKER_PATTERN/, 'stream cleaners must strip provider JSON-channel markers')
  assert.match(eventDispatcher, /purpose:\s*'deliverable'/, 'recovered artifacts must carry deliverable purpose')
  assert.match(artifacts, /ArtifactPurpose = 'deliverable' \| 'support' \| 'internal'/, 'artifacts must have purpose metadata')
  assert.match(agentLoop, /ASSISTANT_SUPPORTS_IMAGE_INPUT[\s\S]*image_url:\s*\{ url: att\.content!, detail: 'high' \}/, 'image attachments must reach the model as image_url parts only on multimodal routes')
  assert.match(llm, /textOnlyMessages[\s\S]*Image payload omitted/, 'text-only model routes must strip image_url payloads before provider requests')
  assert.match(agentLoop, /visualImageUploadedAttachments/, 'agent loop must distinguish visual image attachments from text attachments')
  assert.match(agentLoop, /Visually inspect uploaded image/, 'image attachment preflight must be framed as visual inspection')
  assert.match(agentLoop, /direct image inspection is unavailable on this route/, 'planner image context must be honest on text-only routes')
  assert.match(agentLoop, /state\.uploadedImageAttachmentAvailable = ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments/, 'agent state must record uploaded image visual input availability only on multimodal routes')
  assert.match(planManager, /visualInput\?: boolean/, 'required preloaded steps must be able to mark image visual input')
  assert.match(planManager, /Load uploaded image visual input/, 'preloaded image attachment event must render as visual input loading')
  assert.match(agentLoop, /Read this skill first/, 'skill attachments must be loaded before the agent starts work')
  assert.match(agentLoop, /attachmentContextForPlanning/, 'uploaded attachment text must be included in bounded planner context')
  assert.match(agentLoop, /hasUploadedAttachments[\s\S]*attachmentSummaryForContext\(m,\s*false\)/, 'runtime model context must include uploaded attachment metadata even when extraction failed')
  assert.match(agentLoop, /sandbox path: \$\{attachment\.sandboxPath\}/, 'runtime model context must include uploaded attachment sandbox paths when available')
  assert.match(agentLoop, /Do not say no file was attached/, 'metadata-only attachments must prevent false "no file attached" replies')
  assert.match(agentLoop, /Use the listed sandbox path with document or terminal tools/, 'metadata-only sandboxed uploads must direct the agent toward the uploaded sandbox file')
  assert.match(agentLoop, /requiredAttachmentPlanSteps/, 'uploaded attachments must get a preloaded read step before runtime work')
  assert.match(attachments, /withMessageAttachmentSandboxPaths/, 'uploaded attachments must be annotated with sandbox paths before planning')
  assert.match(attachments, /materializeMessageAttachmentsToSandbox/, 'uploaded attachments must be copied into the task sandbox before tool execution')
  assert.match(chatTaskRunner, /withMessageAttachmentSandboxPaths\(agentMessages\)/, 'background tasks must expose uploaded file sandbox paths to AgentLoop')
  assert.match(chatTaskRunner, /materializeMessageAttachmentsToSandbox\(agentMessages,\s*userId,\s*conversationId\)/, 'background tasks must materialize uploaded files into the active sandbox before tools run')
  assert.match(agentLoop, /Do not plan web_search for an uploaded filename\/title/, 'planner attachment context must forbid filename web searches')
  assert.match(agentState, /uploadedAttachmentContextAvailable/, 'agent state must track whether uploaded attachment context exists')
  assert.match(agentState, /uploadedAttachmentContentAvailable/, 'agent state must track whether uploaded attachment content was extracted')
  assert.match(agentState, /uploadedImageAttachmentAvailable/, 'agent state must track whether uploaded image visual input exists')
  assert.match(toolPipeline, /uploadedAttachmentToolBlockReason[\s\S]*?this\.emitter\.toolStart/, 'attachment misuse guard must run before visible tool_start emission')
  assert.match(toolPipeline, /UPLOADED_IMAGE_DIRECT_CONTEXT_BLOCKED_TOOLS/, 'tool preflight must block browser/search/open tools for direct uploaded-image inspection')
  assert.match(toolPipeline, /isUploadedImageDirectInspectionTask/, 'tool preflight must scope uploaded-image blocking to inspection tasks')
  assert.match(toolPipeline, /Do not use browser\/current-view\/open\/read_file\/web_search tools for image inspection/, 'tool preflight must tell the model to answer from attached visual input')
  assert.match(toolPipeline, /Do not web_search uploaded attachment filenames or titles/, 'tool preflight must block attachment filename searches')
  assert.match(toolPipeline, /Do not use read_file for uploaded attachment names/, 'tool preflight must block reading uploaded attachments as workspace files')
  assert.match(policyEngine, /UPLOADED ATTACHMENT CONTEXT AVAILABLE/, 'policy recovery must not force web_search/read_file for uploaded attachments')
  assert.match(prompts, /Uploaded user attachments are already supplied in the message context/, 'runtime prompt must define uploaded attachment handling')
  assert.match(prompts, /Do not plan web_search for an attachment filename\/title/, 'planning prompt must prevent attachment filename searches')
  assert.match(validationSchemas, /contentEncoding:\s*z\.enum\(\['text',\s*'data-url'\]\)/, 'chat validation must preserve attachment contentEncoding')
  assert.match(streamConstants, /read_attachment:\s*'read_file'/, 'client must render read_attachment as a file-style subtask')
  assert.doesNotMatch(agentLoop, /buildTaskStartAcknowledgement|I'll open the site, check what loads/, 'agent startup acknowledgement must not use a hardcoded generic sentence')
  assert.match(planManager, /createStreamingCompletion[\s\S]*streamingChunkText[\s\S]*this\.emitter\.textDelta\(content\)/, 'task acknowledgement should stream from the planner/model before the full response finishes')
  assert.match(planManager, /PLANNER_ACK_DISPLAY_WAIT_MS = 150/, 'planner must not let a slow acknowledgement stream block the visible plan once planning has caught up')
  assert.match(planManager, /PLANNER_ACK_FIRST_FLUSH_CHARS = 48/, 'planner acknowledgement must flush a complete model-written sentence instead of an incomplete fragment')
  assert.match(planManager, /pendingVisibleAck[\s\S]*flushPendingVisibleAck/, 'planner acknowledgement follow-up text must be buffered instead of dribbling tiny deltas after first paint')
  assert.match(planManager, /suppressFurtherAcknowledgementDeltas[\s\S]*Promise\.race\(\[[\s\S]*this\.acknowledgementDisplayPromise[\s\S]*PLANNER_ACK_DISPLAY_WAIT_MS[\s\S]*this\.acknowledgementEmitted \|\| displayed/, 'planner must race displayed startup acknowledgement text and stop duplicate/interleaved ack deltas once the plan can show')
  assert.doesNotMatch(planManager, /max_tokens:\s*80/, 'acknowledgement calls must not use a tiny token cap that high reasoning can consume before visible text')
  assert.match(planManager, /max_tokens:\s*PLANNER_ACK_MAX_TOKENS/, 'acknowledgement calls should stay bounded while leaving room for a task-specific paragraph')
  assert.match(planManager, /sentences\.length < 1 \|\| sentences\.length > 2/, 'startup acknowledgements must be compact direct paragraphs, not long defaults')
  assert.match(prompts, /one or two short sentences and 12-38 words/, 'planner prompt must request a fast very brief direct acknowledgement paragraph')
  assert.doesNotMatch(chatRoute, /words\.length < 10|sanitizeStartupAcknowledgement|startupAcknowledgementIsUsable/, 'route startup acknowledgement sanitizer must not return because worker-owned ack is the only startup ack path')
  assert.match(planManager, /PLANNER_CONTROL_REASONING = \{ enabled: false as const, exclude: true \}/, 'planner JSON control calls must disable thinking before emitting structured plans')
  assert.match(planManager, /PLANNER_ACK_REASONING = \{ enabled: false as const, exclude: true \}/, 'startup acknowledgement must disable thinking before visible text')
  assert.match(planManager, /reasoning:\s*PLANNER_ACK_REASONING/, 'planner startup acknowledgement must use the acknowledgement-specific reasoning setting')
  assert.ok((planManager.match(/reasoning:\s*PLANNER_CONTROL_REASONING/g) || []).length >= 4, 'initial plan, repair, and replan calls should use planner control reasoning')
  assert.match(agentLoop, /const maxNormalOutputTokens = 8192/, 'normal stream iterations should have enough room for substantial answers')
  assert.match(agentLoop, /const maxDeliverableOutputTokens = 24_576/, 'deliverable and deadline turns should use bounded chunks instead of one huge silent output budget')
  const attemptPlanCallContract = planManager.match(/private async attemptPlanCall[\s\S]*?\n  \/\*\*/)?.[0] || ''
  assert.match(planManager, /PLANNER_REPAIR_EXHAUSTED_ERROR/, 'planner quality failures must surface only through a sanitized terminal error after model repair is exhausted')
  assert.match(planManager, /PLANNER_QUALITY_REPAIR_ATTEMPTS = 1/, 'planner repair must stay bounded so startup does not wait behind repeated repair loops')
  assert.match(planManager, /emitParsedPlanWithModelRepair/, 'planner quality failures must be repaired through the model before the task can fail')
  assert.doesNotMatch(planManager, /emitSyntheticPlan/, 'planner must not emit synthetic backup plans when model planning fails')
  assert.doesNotMatch(planManager, /buildEmergencyPlannerResponse|emergencyPlan|emergencyPlanner/, 'planner must not use local emergency fallback plans when model planning fails')
  assert.match(planManager, /repairPlannerResponse/, 'invalid planner JSON must be repaired before failing the task')
  assert.match(planManager, /isPlannerQualityError/, 'planner quality failures must be classified for model repair')
  assert.match(planManager, /QUALITY FAILURE TO FIX/, 'planner repair must include quality-gate failure context')
  assert.doesNotMatch(attemptPlanCallContract, /throw new Error\(PLANNER_QUALITY_ERROR\)/, 'the exact planner quality validator text must not escape from the planner call path')
  assert.match(planManager, /repairPlannerResponse\(nextRepairInput,\s*qualityIssue\)/, 'parseable but low-quality planner output must go through bounded model repair before failing')
  assert.match(agentLoop, /compactResearchToolState[\s\S]*currentPhase: 'research'[\s\S]*getActiveDefinitions\(compactResearchToolState\)[\s\S]*pruneToolsForCurrentStep\(compactResearchToolState/, 'compact research recovery must request source tools through the research phase filter before pruning')
  assert.match(planManager, /INVALID ACK TO REPLACE/, 'invalid generated acknowledgements must get one model-authored retry')
  assert.match(planManager, /response_format:\s*\{\s*type:\s*'json_object'\s*\}/, 'planner calls should request strict JSON when the provider supports it')
  assert.match(prompts, /Treat command wrappers such as "research about"/, 'planner prompt must extract the real topic instead of using command wrappers as the subject')
  assert.doesNotMatch(chatRoute, /Do not echo command wrappers|Treat command wrappers such as "research about"/, 'route startup acknowledgement prompt must not return now that worker-owned ack is the only startup ack path')
  assert.match(planManager, /requestedTargetLabel/, 'short-plan expansion must be grounded in the user request')
  assert.doesNotMatch(planManager, /Research the core facts and definitions/, 'planner must not use the generic three-step research scaffold')
  assert.match(prompts, /Every tool call MUST include:[\s\S]*action_label:[\s\S]*plan_step_index:/, 'runtime prompt must require model-authored action pill labels and active step indexes')
  assert.match(prompts, /saved custom instructions explicitly require a support\/tracking file such as todo\.md/, 'runtime prompt must allow custom-instruction tracking files')
  assert.match(tools, /action_label:[\s\S]*TOOL_ACTION_LABEL_PARAMETER[\s\S]*plan_step_index:[\s\S]*TOOL_PLAN_STEP_INDEX_PARAMETER/, 'tool schemas must require display labels and active step indexes')
  assert.match(tools, /properties:\s*\{[\s\S]*?action_label:\s*TOOL_ACTION_LABEL_PARAMETER,[\s\S]*?plan_step_index:\s*TOOL_PLAN_STEP_INDEX_PARAMETER,[\s\S]*?\.\.\.\(schema\.properties \|\| \{\}\)/, 'display contract fields must be ordered before large tool payload fields for live action pills')
  assert.match(tools, /required:\s*\[\.\.\.new Set\(\['action_label',\s*'plan_step_index',\s*\.\.\.required\]\)\]/, 'display contract fields must be required before regular payload fields')
  assert.doesNotMatch(tools, /Include action_label and plan_step_index/, 'tool descriptions must not repeat display-contract text on every schema')
  assert.match(agentLoop, /compactToolDefinitionsForModel/, 'model-call tool schemas should trim repeated display-only descriptions')
  assert.match(agentLoop, /description: _description/, 'tool schema compaction should remove display-only descriptions while preserving required fields')
  assert.match(toolPipeline, /planStepIndexBlockReason/, 'tool pipeline must block calls declared for the wrong plan step')
  assert.match(activityDescriber, /runtimeVisibleActionLabel/, 'runtime must provide deterministic visible labels when the model omits display-only metadata')
  assert.match(toolPipeline, /runtimeDisplayActionLabel/, 'tool pipeline must repair missing visible labels instead of burning model turns on display-only retries')
  assert.match(toolPipeline, /phaseSemanticBlockReason/, 'tool pipeline must block future-phase semantic drift before executing tools')
  assert.match(toolPipeline, /appears to continue previous step/, 'tool pipeline must block previous-phase semantic drift before executing tools')
  assert.match(toolPipeline, /synthesisPhaseResearchBlockReason/, 'tool pipeline must block research tools inside synthesis/write/deliverable phases')
  assert.match(toolPipeline, /is for synthesizing, writing, or delivering from existing work/, 'synthesis-phase recovery must tell the model to use existing work instead of gathering new sources')
  assert.match(toolPipeline, /researchSourceBalanceBlockReason/, 'research phases must balance search discovery with opened or extracted source pages')
  assert.match(toolPipeline, /search result sets but no opened or extracted source pages yet/, 'research source balance must stop search-only chains before more searches')
  assert.match(agentLoop, /researchSearchNeedsOpenedSourceBeforeMoreSearch[\s\S]*completedSearches >= 1 && openedSourceReads === 0/, 'hot-path source tools must mirror the search/source balance guard')
  assert.match(agentLoop, /fastSourceActionToolsForState[\s\S]*needsOpenedSourceBeforeMoreSearch[\s\S]*new Set\(SOURCE_OPENING_RUNTIME_TOOLS\)/, 'hot-path source turns must remove web_search when an opened source is required next')
  assert.match(agentLoop, /hasSearchCandidatesAwaitingOpen[\s\S]*allowed\.delete\('web_search'\)/, 'compact source-opening recovery must remove web_search while known result URLs are still unopened')
  assert.match(agentLoop, /Do not call web_search again while known result URLs are still unopened/, 'source-opening recovery prompt must forbid another search when known candidate URLs need opening')
  assert.match(agentLoop, /SOURCE_OPENING_RUNTIME_TOOLS[\s\S]*read_document[\s\S]*http_request[\s\S]*youtube_transcript/, 'source-opening turns must expose parallel extraction tools')
  assert.match(prompts, /After one or two good searches, read or extract the strongest result pages before searching more/, 'runtime prompt must frame web search as source discovery before extraction')
  assert.match(stepMessages, /Use web_search to discover candidates, then read\/extract the strongest source pages before searching more/, 'per-step research prompt must require source extraction after search discovery')
  assert.match(toolPipeline, /Previous-step "next" notes are closed/, 'previous phase bleed recovery must tell the model to ignore stale prior next-notes')
  assert.match(stepMessages, /PHASE SWITCH: Previous steps are closed/, 'step injections must explicitly close the previous phase on step advance')
  assert.match(stepMessages, /FINAL PHASE SWITCH: Previous research\/build\/browser steps are closed/, 'final step injections must explicitly close prior phases before synthesis')
  assert.match(stepMessages, /Start synthesis now/, 'final synthesis instructions must require immediate deliverable work')
  assert.match(stepMessages, /must not continue prior research/, 'final synthesis instructions must forbid slow carryover from the previous phase')
  assert.match(toolPipeline, /finalSynthesisCarryoverBlockReason/, 'tool pipeline must block research/browser carryover on final synthesis steps')
  assert.match(toolPipeline, /final synthesis\/deliverable phase, not a continuation of the previous research phase/, 'final synthesis carryover recovery must redirect to deliverable tools')
  assert.match(policyEngine, /FINAL SYNTHESIS TOOL REQUIRED/, 'final deliverable steps must force an immediate saved-output tool call after text-only drift')
  assert.doesNotMatch(policyEngine, /Continue working\. If you are writing your deliverable/, 'final deliverable steps must not allow several vague text-only warm-up turns')
  assert.match(toolPipeline, /fileWritePreflightBlockReason\(tc\.name,\s*args,\s*state\)/, 'blocked file-write calls must be stopped before visible tool_start pills')
  assert.match(toolPipeline, /isTaskTrackingMarkdownPath/, 'task-tracking markdown files must be recognized centrally')
  assert.match(toolPipeline, /currentStepAllowsTaskTrackingMarkdown/, 'custom-instruction tracking files must be allowed when present in current step scope')
  assert.doesNotMatch(toolPipeline, /state\.stepResearchCallCount < 2 && !currentStepAllowsTaskTrackingMarkdown/, 'custom-instruction tracking files must not require prior research calls')
  assert.match(eventDispatcher, /strictActionLabel \|\| runtimeVisibleActionLabel\(event\.name,\s*event\.args\)/, 'client action pills must use runtime-repaired labels instead of dropping valid tool starts')
  assert.match(eventDispatcher, /toolStartsById[\s\S]*startedEvent[\s\S]*runtimeVisibleActionLabel\(event\.name,\s*startedEvent\.args\)/, 'tool results must still create a visible completed pill when the start was missed')
  assert.match(eventDispatcher, /function shouldPreserveVisibleInternalToolResult/, 'visible recovery results must be eligible to finish existing action pills')
  assert.match(eventDispatcher, /visibleStartedRecovery[\s\S]*isHiddenInternalToolResult\(event\.name,\s*event\.result\) && visibleStartedRecovery[\s\S]*status: 'done'[\s\S]*removeComputerPanelItem[\s\S]*return[\s\S]*if \(isHiddenInternalToolResult\(event\.name,\s*event\.result\)\)/, 'internal recovery results must complete already-visible action pills instead of removing them')
  assert.match(eventDispatcher, /labelSource:\s*strictActionLabel \? 'model' : 'system'/, 'visible task pills must distinguish model labels from runtime-repaired labels')
  assert.doesNotMatch(eventDispatcher, /describeActivity\(event\.name,\s*event\.args\)/, 'visible task pills must not use locally generated action text')
  assert.doesNotMatch(actionFeed, /describeActivity\(/, 'rendered action pills must only show stored model-authored labels')
  assert.match(useAgentStream, /isContextualTaskUpdateText/, 'client must only preserve sandbox state for contextual task updates')
  assert.match(useAgentStream, /isFirstTaskAutoStart \|\| \(!isAutoSend && !isContextualTaskUpdateText\(latestUserContent\)\)/, 'new user tasks and first-prompt auto-starts should start with an isolated sandbox')
  assert.match(chatRoute, /startIsolatedTaskSandbox/, 'server must enforce per-task sandbox isolation')
  assert.match(chatRoute, /resetLocalSandboxDir\(conversationId\)/, 'isolated tasks must reset local task state before visible startup acknowledgement')
  assert.match(chatRoute, /resetE2BSandbox\(conversationId\)/, 'isolated E2B tasks must still reset the remote sandbox before tool execution')
  assert.match(chatRoute, /isTruncatedFinishReason/, 'direct chat must detect provider length stops before displaying a response')
  assert.match(chatRoute, /isLikelyIncompleteDirectAnswer/, 'direct chat must detect mid-sentence answers even when the provider reports success')
  assert.match(chatRoute, /Continue exactly from the next word/, 'direct chat must request a continuation instead of showing cut-off text')
  assert.match(chatRoute, /chargeServerTokenUsage\(userId,\s*conversationId,\s*creditRunId,\s*creditUsage,\s*`direct:\$\{attempt \+ 1\}`\)/, 'direct chat continuation calls must be charged with distinct server ledger ids')
  assert.match(chatRoute, /DIRECT_CHAT_MAX_TOKENS = 1536/, 'direct chat should keep concise answers on a smaller completion cap')
  assert.doesNotMatch(chatRoute, /isBareResearchOverviewRequest\(request\)[\s\S]*`Research \$\{topic\} basics`[\s\S]*`Summarize \$\{topic\} clearly`/, 'route startup plans must not collapse broad research into a canned two-step plan')
  assert.doesNotMatch(chatRoute, /createFastStartupPlan|chooseFastStartupPlan|fastStartupPlanSubject/, 'route must not fabricate deterministic visible startup plans')
  assert.doesNotMatch(chatRoute, /`Map \$\{subject\} angles`|`Read current \$\{subject\} sources`|`Synthesize the \$\{subject\} answer`|Frame the key questions|Gather current evidence|Open a few strong sources|Give the concise synthesis/, 'route startup must not emit stale generic research placeholders')
  assert.doesNotMatch(agentLoop, /customInstructionsForTask|Fast-lane override for this latest request|FAST-LANE RESEARCH OVERRIDE/, 'broad research prompts must not bypass normal custom instructions or depth logic')
  assert.match(agentLoop, /FINAL_SAVED_DELIVERABLE_MODEL_START_TIMEOUT_CAP\s*=\s*2/, 'final saved deliverable model-start recovery must be capped')
  assert.match(agentLoop, /hasSavedFinalDeliverableCandidate\(state\)[\s\S]*state\.consecutiveNullStreams >= FINAL_SAVED_DELIVERABLE_MODEL_START_TIMEOUT_CAP[\s\S]*terminalReason = 'saved_deliverable_model_start_timeout'/, 'saved deliverable final revision timeouts must complete with the existing artifact instead of looping forever')
  assert.match(agentLoop, /maybeStartIterationCapFinalWrite[\s\S]*taskNeedsSavedFinalArtifact[\s\S]*hasSavedFinalDeliverableCandidate\(state\)\) return false[\s\S]*state\.dynamicIterationLimit = Math\.max\(state\.dynamicIterationLimit, state\.iterations \+ 8\)/, 'iteration cap must grant a bounded final-write rescue instead of erroring before saving a required artifact')
  assert.match(agentLoop, /credibleEvidencePacket[\s\S]*repeatedResearchLoop[\s\S]*state\.consecutiveNoToolCalls >= 3 \|\| repeatedResearchLoop[\s\S]*return true/, 'compact research must advance after credible direct evidence instead of looping on repeated no-tool/tool-loop replies')
  assert.match(chatRoute, /DIRECT_CHAT_CONTINUATION_MAX_TOKENS = 768/, 'direct chat continuations should stay compact')
  assert.match(chatRoute, /directChatNeedsConversationContext/, 'direct chat should avoid paying for history on standalone questions')
  assert.match(chatRoute, /return cleanMessages\.slice\(-1\)/, 'standalone direct chat should send only the latest user message')
  assert.match(chatRoute, /DIRECT_CHAT_CONTEXT_REFERENCE_PATTERN/, 'context-dependent direct-chat follow-ups must still preserve history')
  assert.match(chatRoute, /directChatNeedsTemporalContext/, 'direct chat should only pay for temporal context on date/time questions')
  assert.match(chatRoute, /includeTemporalContext:\s*directChatNeedsTemporalContext\(messages\)/, 'direct chat temporal context must be gated by the latest user request')
  assert.doesNotMatch(chatRoute, /deterministic|Deterministic|DIRECT_CHAT_EXACT_|DIRECT_CHAT_GREETING_PATTERN|DIRECT_CHAT_THANKS_PATTERN|DIRECT_CHAT_ACK_PATTERN|preHydrationDeterministicReply/, 'chat route must not use deterministic no-model reply paths')
  assert.match(agentIdentity, /AGENT_IDENTITY_SYSTEM_INSTRUCTION[\s\S]*general AI agent[\s\S]*do not disclose[\s\S]*Answer naturally instead of using one fixed canned response/, 'identity disclosure must be prompt-driven, not a fixed canned response')
  assert.match(directChatRouting, /isAgentIdentityDisclosureQuestion\(content\)[\s\S]*return true/, 'identity disclosure questions must route to direct chat instead of agent tools')
  assert.match(chatRoute, /You are Agent, a general AI agent[\s\S]*AGENT_IDENTITY_SYSTEM_INSTRUCTION/, 'direct chat must identify as a general AI agent and apply identity guidance')
  assert.match(prompts, /You are Agent, a general AI agent and autonomous task agent[\s\S]*AGENT_IDENTITY_SYSTEM_INSTRUCTION/, 'agent runtime prompt must identify as a general AI agent and apply identity guidance')
  assert.doesNotMatch(chatRoute, /latestUserAskedAgentIdentityDisclosure\(messages\)[\s\S]*emitter\.textDelta|AGENT_IDENTITY_DISCLOSURE_RESPONSE/, 'direct chat must not bypass provider generation with a fixed identity answer')
  assert.doesNotMatch(agentLoop, /latestUserAskedAgentIdentityDisclosure|emitAgentIdentityDisclosureAnswer|isAgentIdentityDisclosureQuestion/, 'agent loop must not hard-stop identity questions before normal model handling')
  assert.doesNotMatch(directChatRouting, /EXACT_LOCAL_TEMPORAL_PATTERN|EXACT_SIMPLE_ARITHMETIC_PATTERN/, 'direct chat routing must not force exact-match temporal or arithmetic shortcut paths')
  assert.match(directChatRouting, /good\\s\+\(\?:morning\|afternoon\|evening\)/, 'router should keep common greeting variants out of the full agent path')
  assert.match(directChatRouting, /thank you\|thx/, 'router should keep compact thanks variants out of the full agent path')
  assert.match(directChatRouting, /got it\|sounds good\|sure\|alright/, 'router should keep common acknowledgement variants out of the full agent path')
  assert.match(chatRoute, /const rawMessages = validation\.data\.messages[\s\S]*const directChat = shouldUseDirectChat\(rawMessages\)[\s\S]*const messagesPromise = directChat \|\| !hasUnhydratedAttachments\(rawMessages\)[\s\S]*hydrateMessageAttachmentsForUser\(rawMessages,\s*userId\)[\s\S]*const creditsPromise = assertServerCreditsAvailable\(userId\)[\s\S]*const accessPromise = conversationId[\s\S]*const workerAvailabilityPromise = timedRoutePromise/, 'chat route should route before attachment hydration and start access/worker checks in parallel without deterministic bypasses')
  assert.match(chatRoute, /persistConversationAfterResponse[\s\S]*after\(\(\) => ensureUserConversationForTaskStart/, 'conversation placeholder persistence must run after the task stream is opened')
  assert.doesNotMatch(chatRoute, /await ensureUserConversationForTaskStart\(userId,\s*\{[\s\S]*await enqueueTaskJob/, 'chat route must not block task stream opening on conversation placeholder persistence')
  assert.doesNotMatch(chatRoute, /findActiveTaskJobForUser\(userId\)/, 'chat route must not block new tasks because another task is active for the same account')
  assert.match(chatRoute, /if \(conversationId\) \{[\s\S]*chargeServerTaskStart/, 'chat route should use one metering path without deterministic task-start bypasses')
  assert.match(chatRoute, /meteredTaskStarted[\s\S]*chargeActiveCredit/, 'active-time credit charging should only finalize for metered task starts')
  assert.match(titleRoute, /includeTemporalContext:\s*false/, 'title generation should not pay for temporal context')
  assert.doesNotMatch(titleRoute, /heuristicTitleFromMessage|deterministicDirectTitleFromMessage|TITLE_HEURISTIC|TITLE_EXACT|TITLE_GREETING|TITLE_DOMAIN|Quick Calculation|Exact Reply|Help Request|Agent Identity/, 'title route must not use local deterministic title paths')
  assert.match(titleRoute, /await assertServerCreditsAvailable\(userId\)[\s\S]*createCompletion/, 'title route should always use provider title generation after credit check')
  assert.match(llm, /DEFAULT_OPENROUTER_MODEL/, 'runtime must route through the centralized default OpenRouter model')
  assert.match(llm, /function trimmedEnv\(value: string \| undefined\)/, 'runtime must expose shared env trimming for provider settings')
  assert.match(llm, /modelEnvForProvider\(ASSISTANT_PROVIDER\) \|\| defaultModelForProvider\(ASSISTANT_PROVIDER\)/, 'provider model IDs must be trimmed before request routing')
  assert.match(llm, /ASSISTANT_PROVIDER === 'deepseek' \? 'high' : 'minimal'/, 'reasoning must default to high effort on DeepSeek and minimal on OpenRouter')
  assert.match(llm, /'xhigh'/, 'runtime must preserve xhigh reasoning instead of normalizing it down when explicitly configured')
  assert.match(llm, /DEFAULT_REASONING_EXCLUDE = booleanEnv\(process\.env\.OPENROUTER_REASONING_EXCLUDE,\s*true\)/, 'reasoning exclude flag must tolerate whitespace-padded Vercel env values')
  assert.match(llm, /getAssistantApiKey[\s\S]*trimmedEnv\(process\.env\.DEEPSEEK_API_KEY\)[\s\S]*trimmedEnv\(process\.env\.OPENROUTER_API_KEY\)/, 'provider credentials must be trimmed before request headers are built')
  assert.match(llm, /reasoning_effort: deepSeekReasoningEffort\(effort\)/, 'DeepSeek calls must include the configured thinking effort by default')
  assert.match(llm, /effort: DEFAULT_REASONING_EFFORT/, 'OpenRouter calls must include the configured reasoning effort by default')
  assert.match(llm, /exclude: DEFAULT_REASONING_EXCLUDE/, 'internal reasoning should be excluded from user-visible responses by default')
  assert.match(llm, /usage:\s*\{\s*include:\s*true\s*\}/, 'OpenRouter calls must explicitly request usage data for compatibility')
  assert.match(llm, /estimateUsageCost/, 'DeepSeek token usage must be normalized into billable provider cost')
  assert.match(streamProcessor, /reasoningContent \+= String\(delta\.reasoning_content\)/, 'thinking-mode tool calls must preserve reasoning content internally for provider history')
  assert.match(llm, /ASSISTANT_LOG_LABEL\s*=\s*'Agent'/, 'provider/runtime internals must be redacted from logs')
  assert.match(llm, /temporalContextCache/, 'temporal context should be cached instead of rebuilt on every model call')
  assert.match(llm, /Now: \$\{localDateTime\}; UTC \$\{utcMinute\}/, 'temporal context should stay concise while preserving local and UTC time')
  assert.match(llm, /first\?\.role === 'system' && typeof first\.content === 'string'/, 'temporal context should merge into an existing first system message')
  assert.match(llm, /content: `\$\{first\.content\}\\n\\n\$\{temporalContext\}`/, 'merged temporal context must preserve existing system instructions')
  assert.match(llm, /const contextualMessages = includeTemporalContext === false[\s\S]*\? messages[\s\S]*: withCurrentTemporalContext\(messages\)/, 'internal calls must be able to opt out of temporal context')
  assert.doesNotMatch(llm, /Current date\/time:/, 'temporal context should not use the old verbose per-call wording')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.inputUsdPer1M/, 'credit policy must use the current default model input price')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.outputUsdPer1M/, 'credit policy must use the current default model output price')
  assert.match(creditPolicy, /SERPER_SEARCH_USD_PER_1K_REQUESTS\s*=\s*0\.30/, 'Serper search pricing must match provider public pricing')
  assert.match(webSearchSource, /SERPER_API_KEY/, 'web_search must use Serper credentials')
  assert.match(webSearchSource, /SERPER_BASE_URL/, 'web_search must use the configured Serper endpoint')
  assert.match(webSearchSource, /WEB_SEARCH_RESULT_COUNT\s*=\s*15/, 'web_search must request and display at most 15 results')
  assert.match(webSearchSource, /num:\s*WEB_SEARCH_RESULT_COUNT/, 'Serper web_search request size must use the shared 15-result count')
  assert.match(webSearchSource, /serperPost<SerperSearchResponse>\('search'/, 'web_search must call Serper search directly')
  assert.match(webSearchSource, /resultFromOrganic\(item,\s*'serper-organic'\)/, 'web_search results must label Serper organic results')
  assert.match(webSearchSource, /scoreResultForQuery/, 'search results must be ranked by query relevance before display')
  assert.match(webSearchSource, /dedupeResults/, 'search results must be deduped and filtered before display')
  assert.doesNotMatch(webSearchSource, /SearXNG|DuckDuckGo|BRAVE_SEARCH|WEB_SEARCH_PROVIDER_ORDER|direct-search-page/, 'web_search must not retain the old free-provider routing')
  assert.match(llm, /SERPER_API_KEY[\s\S]*redacted-search-key/, 'Serper API credentials must be redacted from assistant-service errors')
  assert.match(creditPolicy, /E2B_VCPU_USD_PER_SECOND\s*=\s*0\.000014/, 'E2B CPU credit cost must be anchored to E2B public pricing')
  assert.match(creditPolicy, /E2B_MEMORY_GIB_USD_PER_SECOND\s*=\s*0\.0000045/, 'E2B memory credit cost must be anchored to E2B public pricing')
  assert.match(creditPolicy, /e2bSandboxRuntimeCreditCharge/, 'E2B runtime must be charged through central credit policy')
  assert.match(creditPolicy, /TASK_START_CREDITS\s*=\s*0/, 'task starts must not create a fixed upfront debit')
  assert.match(creditPolicy, /LOCAL_BROWSER_USD_PER_STEP\s*=\s*0/, 'local browser tools must not use Browser Use Cloud pricing')
  assert.match(creditPolicy, /ACTIVE_CREDITS_PER_MINUTE\s*=\s*0/, 'idle wall-clock runtime must not drain credits')
  assert.match(serverCredits, /TASK_START_CREDITS <= 0\) return null/, 'task starts must be server no-ops when there is no real cost')
  assert.match(serverCredits, /chargeServerActiveTime/, 'active-time ledger function must remain as a no-op compatible contract')
  assert.match(serverCredits, /chargeServerE2BRuntime/, 'external E2B sandbox runtime must be charged through the server ledger')
  assert.match(serverCredits, /chargeServerTool/, 'tool usage must be charged through the server ledger')
  assert.match(serverCredits, /chargeServerTokenUsage/, 'token usage must be charged through the server ledger')
  assert.match(serverCredits, /tursoTransaction\('write'/, 'server credit ledger writes must be transactional')
  assert.match(serverCredits, /where user_id = \? and id = \?/, 'server credit ledger must dedupe by idempotency key')
  assert.match(toolPipeline, /emitServerToolCharge\(tc\.id,\s*tc\.name\)/, 'tool execution must emit server-side credit events after preflight checks')
  assert.match(eventDispatcher, /SERVER_CREDIT_ACCOUNTING\s*=\s*true/, 'client must mirror server credit events instead of being the charging authority')
  assert.match(eventDispatcher, /MIN_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*3/, 'client narration must not flush before 3 visible actions')
  assert.match(eventDispatcher, /MAX_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*4/, 'client narration must not wait past 4 visible actions')
  assert.doesNotMatch(eventDispatcher, /IMMEDIATE_SOURCE_NARRATION_TOOLS/, 'source-result narration must not bypass the 3-4 action cadence')
  assert.doesNotMatch(eventDispatcher, /shouldFlushModelNarrationImmediately/, 'source-result model narration must not flush early')
  assert.doesNotMatch(eventDispatcher, /generateAutoNarration/, 'client must not invent narration from tool results')
  assert.match(eventDispatcher, /narration\.position === currentPosition/, 'client must reject multiple narration blocks in the same action gap')
  assert.match(eventDispatcher, /if \(this\.toolsSinceLastNarration >= TOOLS_BETWEEN_NARRATION_FLUSHES\)/, 'client narration flushes must be driven by the global visible-action count')
  assert.doesNotMatch(eventDispatcher, /handleStepAdvance[\s\S]{0,180}this\.toolsSinceLastNarration = 0/, 'normal step transitions must not reset the global narration cadence')
  assert.match(eventDispatcher, /panelFocusIdForTool/, 'tool starts must resolve the active computer panel item id')
  assert.match(eventDispatcher, /setComputerPanelActiveItemId\(panelFocusIdForTool\(event\.name,\s*event\.id\)\)/, 'tool starts must focus their live computer panel item')
  assert.match(eventDispatcher, /completedSearchPanelTitle/, 'completed search panel items must preserve the query-specific streaming title')
  assert.match(eventDispatcher, /concisePanelSubject\(event\.args\.query\)/, 'search panel placeholders must include the query that is being searched')
  assert.match(computerPanel, /computerPanelActiveItemId/, 'computer panel must honor explicit active item focus')
  assert.match(computerPanel, /setActiveIndex\(Math\.max\(0,\s*searchCount - 1\)\)/, 'search filter must open the newest search result, not the oldest')
  assert.match(searchResults, /SearchContextHeader/, 'search results must render a query context header when available')
  assert.match(searchResults, /title\?: string/, 'search results must accept the active panel title for query context')
  assert.match(uiStore, /setComputerPanelActiveItemId/, 'UI store must expose active computer item focus')
  assert.match(policyEngine, /rewriteInvalidForcedNarrationAction/, 'invalid forced narration must be repaired before no-tool handling')
  assert.match(eventDispatcher, /applyServerCreditEvent\(entry\)/, 'client store must apply server credit events for visible balance updates')
  assert.match(agentLoop, /`tokens:\$\{state\.iterations\}`/, 'agent sessions must charge tokens per iteration for immediate credit cutoff')
  assert.match(serverCredits, /did not return billable usage/, 'agent sessions must fail closed when provider billing cost is missing')
  assert.match(agentLoop, /recordPlannerUsage/, 'planner LLM calls must be charged through the server ledger')
  assert.match(agentLoop, /Failed to record planner token usage; continuing task/, 'planner token ledger write failures must not fail the task')
  assert.match(agentLoop, /Failed to record iteration token usage; continuing task/, 'iteration token ledger write failures must not fail a completed model turn')
  assert.match(agentLoop, /function isTransientAssistantStreamError[\s\S]*fetch failed/, 'transient assistant stream fetch failures must be classified for recovery')
  assert.match(agentLoop, /MODEL STREAM NETWORK RECOVERY[\s\S]*return 'STREAMING'/, 'transient assistant stream failures must retry the active turn instead of terminating')
  assert.match(planManager, /recordCompletionUsage\(res\.usage/, 'planner completion responses must record provider billing cost')
  assert.doesNotMatch(agentLoop, /chargeServerTokenUsage\(this\.options\.userId,\s*this\.options\.conversationId,\s*this\.options\.creditRunId,\s*totalUsage\)/, 'agent sessions must not double-charge final cumulative token usage')
  assert.match(agentLoop, /this\.emitter\.done\(totalUsage\)/, 'completed sessions must still send token usage metadata to the stream')
  assert.match(agentLoop, /FIXED_WEB_SEARCH_RUNTIME_TOOLS = new Set\(\['web_search'\]\)/, 'fixed-search tasks must not send the full tool schema to small model routes')
  assert.match(agentLoop, /explicitWebSearchLimitFromText\(state\.originalUserRequest \|\| ''\) !== null[\s\S]*filterToolDefinitions\(stepTools,\s*FIXED_WEB_SEARCH_RUNTIME_TOOLS\)/, 'fixed-search research phases must expose only web_search')
  assert.match(agentLoop, /category:\s*'provider_token_or_credit_limit'/, 'provider 402 token or credit limits must be categorized explicitly')
  assert.match(agentLoop, /status === 402[\s\S]*state\.lastModelErrorForUser = 'Agent could not start the next action because the assistant service token or credit limit was exceeded\.'/, 'provider 402 errors must fail fast instead of retrying until iteration cap')
  assert.match(agentLoop, /BROWSER_STEP_START_RUNTIME_TOOLS/, 'browser action steps must have a narrow first-action tool set')
  assert.match(agentLoop, /state\.stepToolCallCount === 0[\s\S]{0,180}BROWSER_STEP_START_RUNTIME_TOOLS/, 'first browser-step calls must expose only page-state tools before interaction tools')
  assert.match(agentLoop, /BROWSER_NONFINAL_RUNTIME_TOOLS/, 'browser action steps must expand to the full browser tool set after page state exists')
  assert.match(agentLoop, /browserStepAllowsDocumentTool/, 'browser action steps should avoid exposing read_document unless document intent or recovery makes it useful')
  assert.match(agentLoop, /tool\.function\?\.name !== 'read_document'/, 'ordinary browser action turns should trim the read_document schema to reduce prompt cost')
  assert.ok(!tools.includes("name: 'browser_click',"), 'legacy selector browser_click must not be exposed in model tool schemas')
  assert.doesNotMatch(tools, /Arguments — same shape as the corresponding single tool/, 'browser action sequence schema must stay compact')
  assert.doesNotMatch(tools, /e\.g\. \{index: 5\}/, 'tool schemas must not repeat long examples already covered by runtime prompts')
  assert.match(tools, /Batch 2-8 stable same-screen actions/, 'browser action sequence should be positioned as the cost-saving same-screen batch tool')
  assert.match(tools, /stop before submit\/navigation\/modal changes/, 'browser action sequence must preserve safety boundaries around page-state changes')
  assert.match(tools, /Args for action; use indexes for controls\./, 'browser action sequence schema must keep concise indexed-control guidance')
  assert.ok(!/name:\s*'browser_type'(?:(?!name:\s*').)*selector:/s.test(tools), 'browser_type schema must expose indexed typing instead of selector fallback')
  assert.ok(!/name:\s*'browser_select'(?:(?!name:\s*').)*selector:/s.test(tools), 'browser_select schema must expose indexed selecting instead of selector fallback')
  assert.ok(!/name:\s*'browser_hover'(?:(?!name:\s*').)*selector:/s.test(tools), 'browser_hover schema must expose indexed hovering instead of selector fallback')
  assert.match(toolRegistry, /register\('browser_type'[\s\S]*args\.selector/, 'runtime must keep selector compatibility for stale browser_type calls')
  assert.match(toolRegistry, /register\('browser_select'[\s\S]*args\.selector/, 'runtime must keep selector compatibility for stale browser_select calls')
  assert.match(toolRegistry, /register\('browser_hover'[\s\S]*args\.selector/, 'runtime must keep selector compatibility for stale browser_hover calls')
  assert.ok(!agentLoop.includes("'browser_click',"), 'browser action tool pruning must expose browser_click_at, not legacy browser_click')
  assert.ok(!toolRegistry.includes("'browser_navigate', 'browser_click',"), 'browse strategy registry should not re-enable legacy browser_click schemas')
  assert.match(agentLoop, /BROWSER_ADVANCED_POINTER_TOOLS = new Set\(\['browser_click_and_hold', 'browser_drag', 'browser_hover'\]\)/, 'advanced browser pointer tools must be explicitly gated')
  assert.match(agentLoop, /browserStepAllowsAdvancedPointerTools/, 'advanced drag/hold tools must only be exposed for relevant browse steps or recovery')
  assert.match(agentLoop, /state\.browserRecoveryRequired \|\| state\.stepFailureCount >= 2/, 'advanced pointer tools must return during browser recovery')
  assert.match(agentLoop, /drag\|drop\|drag\[- \]\?and\[- \]\?drop/, 'advanced pointer tool gate must recognize drag/drop intent')
  assert.match(agentLoop, /hover\|tooltip\|flyout\|sub\[- \]\?menu\|menu/, 'advanced pointer tool gate must recognize hover/menu intent')
  assert.match(agentLoop, /RESEARCH_FILE_WRITE_RUNTIME_TOOLS/, 'ordinary research turns should not pay for file-write schemas')
  assert.match(agentLoop, /RESEARCH_OPTIONAL_RUNTIME_TOOLS = new Set\(\['image_search'\]\)/, 'ordinary text research turns should not pay for image_search schemas')
  assert.match(agentLoop, /researchStepAllowsSupportFileTools/, 'research file-write tools must stay available when notes or markdown are explicitly requested')
  assert.match(agentLoop, /researchStepAllowsImageSearch/, 'research image_search must stay available when images/assets are requested')
  assert.match(agentLoop, /if \(!allowSupportFiles && RESEARCH_FILE_WRITE_RUNTIME_TOOLS\.has\(name\)\) return false/, 'research pruning must remove write tools unless support files are requested')
  assert.match(agentLoop, /if \(!allowImageSearch && RESEARCH_OPTIONAL_RUNTIME_TOOLS\.has\(name\)\) return false/, 'research pruning must remove image_search unless image assets are requested')
  assert.match(agentLoop, /BUILD_OPTIONAL_RUNTIME_TOOLS/, 'pure build/code turns should not pay for optional image/browser/PDF/delete schemas')
  assert.match(agentLoop, /buildStepAllowsOptionalTool/, 'optional build tools must be restored when the step or QA state requires them')
  assert.match(agentLoop, /state\.currentPhase === 'build'[\s\S]{0,220}BUILD_OPTIONAL_RUNTIME_TOOLS/, 'build pruning must remove optional tool schemas unless relevant')
  assert.match(toolPipeline, /compactBrowserContentForModel/, 'browser tool results must be semantically compacted instead of raw string-sliced')
  assert.match(toolPipeline, /TARGET HINTS[\s\S]*TASK COMPLETION[\s\S]*Interactive elements/, 'browser result compaction must preserve actionable controls, target hints, and completion signals')
  assert.match(toolPipeline, /BROWSER_RESULT_TOOLS\.has\(tc\.name\)[\s\S]*compactBrowserResultForModel/, 'browser result messages must use the compact browser result helper')
  assert.match(toolPipeline, /function compactCommandResultForModel/, 'command/code results must use a semantic compact helper instead of raw head slicing')
  assert.match(toolPipeline, /hasErrorOutput[\s\S]*stderr[\s\S]*stdout/, 'command result compaction must prioritize stderr on failing runs while preserving bounded stdout context')
  assert.match(toolPipeline, /compactCommandText[\s\S]*chars omitted/, 'command result compaction must preserve head/tail evidence with an omission marker')
  assert.doesNotMatch(toolPipeline, /const cleanResult = \{ \.\.\.obj, stdout: stdoutTruncated, stderr: stderrTruncated \}/, 'command result compaction must not build giant intermediate stdout/stderr JSON before slicing')
  assert.match(serverCredits, /OutOfCreditsError/, 'server credit exhaustion must be typed')
  assert.match(serverCredits, /MINIMUM_PROVIDER_CALL_CREDITS\s*=\s*0/, 'server credit availability must allow positive balances to continue until a billable call drains them')
  assert.match(serverCredits, /minimumCredits = MINIMUM_PROVIDER_CALL_CREDITS/, 'server credit availability must default to provider-call runway checks')
  assert.match(serverCredits, /Math\.min\(requestedAmount,\s*currentBalance\)/, 'server credit charges must cap the collected debit at the remaining balance')
  assert.match(serverCredits, /set monthly_balance = 0/, 'over-budget charges must clamp the account to zero')
  assert.doesNotMatch(serverCredits, /currentBalance - amount/, 'server credit charges must never compute a negative balance')
  assert.match(serverCredits, /requestedAmount > currentBalance/, 'server credit charges must detect over-budget billable calls')
  assert.match(serverCredits, /where user_id = \? and monthly_balance >= \?/, 'server credit charges must use an atomic DB non-overdraw condition')
  assert.match(serverCredits, /credit_accounts_nonnegative_insert/, 'credit account rows must have a non-negative insert trigger')
  assert.match(serverCredits, /credit_accounts_nonnegative_update/, 'credit account rows must have a non-negative update trigger')
  assert.match(serverCredits, /credit_ledger_balance_after_nonnegative_insert/, 'credit ledger rows must not store negative balance_after values')
  assert.doesNotMatch(activeTaskConstants, /Finish or stop|already running|one task can run/i, 'shared active-task text must not expose the removed one-task-per-account limit')
  assert.match(activeTasks, /create table if not exists user_active_task_leases/, 'server must create an account-scoped active-task lease table')
  assert.match(activeTasks, /primary key \(queue_name, user_id\)/, 'legacy active-task lease rows must remain queue-scoped for resume/cancel compatibility')
  assert.match(activeTasks, /conversation_id text not null/, 'active-task leases must identify the running conversation for cross-browser routing')
  assert.match(activeTasks, /insert or ignore into user_active_task_leases/, 'legacy active-task acquisition helper must stay atomic for compatibility callers')
  assert.match(activeTasks, /delete from user_active_task_leases where expires_at_ms <= \? or updated_at_ms <= \?/, 'expired active-task leases must be cleared before acquisition')
  assert.match(activeTasks, /export async function refreshActiveTaskLease/, 'legacy active-task lease refresh helper must stay available for compatibility callers')
  assert.match(activeTasks, /where queue_name = \? and user_id = \? and run_id = \?/, 'active-task release must only clear the matching running task in the current queue')
  assert.match(activeTasks, /export async function getActiveTaskLeaseForUser/, 'server must expose the current active task lease for reopen/resume discovery')
  assert.match(taskQueue, /AGENT_TASK_QUEUE_NAME/, 'task queue namespace must be configurable per deployment')
  assert.match(taskJobs, /export async function findActiveTaskJobForConversation/, 'server must discover active queued or running jobs from durable task state')
  assert.match(taskJobs, /export async function findActiveTaskJobForConversation/, 'server must discover active jobs by conversation for reopened clients')
  assert.match(taskJobs, /queue_name text not null default 'default'/, 'durable task jobs must store the deployment queue namespace')
  assert.match(taskJobs, /and queue_name = \?/, 'durable task job queries must be scoped to the current queue namespace')
  assert.match(taskJobs, /where user_id = \? and run_id = \? and queue_name = \?/, 'durable task cancellation must be scoped to the current queue namespace')
  assert.match(taskJobs, /where run_id = \? and queue_name = \?/, 'durable invalid-payload handling must be scoped to the current queue namespace')
  assert.match(taskJobs, /status in \('queued', 'running'\)/, 'active job discovery must include queued jobs that have not been claimed yet')
  assert.match(taskJobs, /cancel_requested = 0/, 'active job discovery must exclude cancelled jobs')
  assert.match(taskJobs, /TASK_JOB_DB_POLL_MS = 100/, 'persisted task event replay must poll fast enough for early acknowledgement')
  assert.match(taskJobs, /let pollInFlight = false[\s\S]*if \(closed \|\| pollInFlight\) return[\s\S]*pollInFlight = true[\s\S]*finally\(\(\) => \{[\s\S]*pollInFlight = false/, 'persisted task event replay must not overlap Turso polls and duplicate the same seq events')
  assert.match(taskJobs, /loadPersistedTaskEvents\(input\.runId, lastSeq\)/, 'persisted task event replay hot loop must avoid a job-row read on every poll')
  assert.match(taskJobs, /TASK_JOB_STATUS_POLL_MS = 2_000/, 'persisted task event replay must keep slower status polling as a terminal fallback')
  assert.match(taskJobs, /TASK_JOB_STARTUP_PLAN_READ_TIMEOUT_MS = 250/, 'worker startup plan handoff must not block first tool work behind a slow Turso read')
  assert.match(taskJobs, /Promise\.race\(\[[\s\S]*loadPersistedTaskPayload\(runId\)[\s\S]*STARTUP_PLAN_READ_TIMEOUT/, 'worker startup plan handoff must bound each persisted payload read')
  assert.match(taskJobs, /payload === STARTUP_PLAN_READ_TIMEOUT[\s\S]*Date\.now\(\) > deadlineMs[\s\S]*TASK_JOB_STARTUP_PLAN_POLL_MS[\s\S]*continue/, 'worker startup plan handoff must keep polling after a bounded Turso read timeout until the route-plan deadline')
  assert.match(taskJobs, /startupPlanExpected: false[\s\S]*normalized \? \{ startupPlan: normalized \} : \{\}/, 'route startup-plan handoff must clear the worker wait even when the route planner times out')
  assert.match(taskJobs, /chatPayload\?\.startupPlanExpected === false\) break/, 'worker startup-plan wait must stop as soon as the route reports no plan is coming')
  assert.match(taskJobs, /ensureTaskWorkerHeartbeatSchema/, 'stale worker-lease recovery must be able to consult the worker heartbeat table')
  assert.match(taskJobs, /agent_task_workers\.current_run_id = agent_task_jobs\.run_id[\s\S]*agent_task_workers\.last_seen_at_ms >= \?/, 'stale worker-lease recovery must not steal a job from a heartbeat-live worker running that exact task')
  assert.match(taskJobs, /job\.conversationId !== input\.conversationId/, 'in-memory task event replay must reject run ids from a different conversation')
  assert.match(taskJobs, /snapshot\.conversationId !== input\.conversationId/, 'persisted task event replay must reject run ids from a different conversation')
  assert.match(useAgentStream, /let highestDispatchedSeq = 0[\s\S]*if \(seq <= highestDispatchedSeq\) continue[\s\S]*highestDispatchedSeq = seq/, 'client stream consumer must ignore duplicate persisted seq events before dispatch')
  assert.match(taskWorker, /DEFAULT_WORKER_POLL_MS = 100/, 'cloud worker must poll the queue quickly enough for sub-second claim latency')
  assert.match(taskWorker, /console\.log\('\[TaskWorker\] Started'[\s\S]*void ensureAgentRuntimePreloaded\(\)\.catch/, 'worker must preload the agent runtime at startup instead of making the first task pay import latency')
  assert.match(taskWorker, /envBoolDefault\('AGENT_E2B_WARM_POOL_ENABLED', false\)/, 'worker must not prewarm unowned E2B runtime unless explicitly enabled')
  assert.match(taskWorker, /prewarmE2BSandbox\('worker-startup'\)/, 'worker must still support explicit prewarmed E2B sandbox startup')
  assert.match(e2bSandbox, /warmSandboxPromise/, 'E2B runtime must track an in-process warm sandbox promise')
  assert.match(e2bSandbox, /adoptWarmE2BSandbox/, 'E2B runtime must adopt a prewarmed sandbox for the next task')
  assert.match(e2bSandbox, /billingStartedAtMs/, 'E2B runtime must preserve the actual sandbox billing start time for credit charging')
  assert.match(chatTaskRunner, /getE2BSandboxBillingStartedAtMs\(conversationId\) \?\? billing\.startedAtMs/, 'E2B runtime charge must use the actual sandbox billing start when available')
  assert.match(e2bSandbox, /DEFAULT_E2B_WARM_POOL_MAX_AGE_MS[\s\S]*warmPoolMaxAgeMs[\s\S]*Discarded stale warm sandbox/, 'E2B warm pool must discard stale sandboxes instead of adopting broken old browser state')
  assert.match(e2bSandbox, /ensureE2BRemoteBrowser\(warmId\)/, 'E2B warm pool must start Chromium before warm sandbox adoption')
  assert.match(e2bSandbox, /cat \$\{shellQuote\(tempPath\)\} >> \$\{shellQuote\(target\.absolutePath\)\}/, 'E2B append_file must append inside the VM instead of reading and rewriting the whole remote file')
  assert.match(e2bSandbox, /appendLocalMirror/, 'E2B append_file must update the local mirror by appending instead of rewriting the whole file')
  assert.match(chatTaskRunner, /remoteSandboxReadyPromise[\s\S]*ensureE2BRemoteBrowser\(conversationId\)/, 'worker must warm E2B asynchronously without blocking model acknowledgement/planning')
  assert.match(chatTaskRunner, /resetLocalSandboxDir\(conversationId\)[\s\S]*resetE2BSandbox\(conversationId\)/, 'worker must split fast local reset from slower remote E2B reset')
  assert.doesNotMatch(taskText, /Cloud sandbox and browser are ready/, 'startup acknowledgement must keep cloud readiness internal')
  assert.doesNotMatch(taskText, /sandboxReadyAcknowledgementForTask|I'll research \$\{subject\}|diverse source mix/, 'startup acknowledgement must be model-generated instead of canned taskText copy')
  assert.match(planManager, /this\.acknowledgementPromise = this\.emitModelGeneratedAcknowledgement\('task'\)[\s\S]*this\.planPromise = start[\s\S]*\.then\(\(\) => this\.attemptPlanCall\(0,\s*true\)\)/, 'model acknowledgement and planner generation must start in parallel so the plan appears quickly after the acknowledgement')
  assert.doesNotMatch(planManager, /ackPriority|PLANNER_ACK_PRIORITY_WINDOW_MS/, 'planner startup must not wait behind an acknowledgement priority gate')
  assert.match(taskText, /cleaned\.length > maxLength/, 'topic cleanup must not drop the final word from short subjects like "new iPhones"')
  assert.match(taskText, /iPhones/, 'topic cleanup should preserve iPhone casing without title-casing the whole phrase')
  assert.doesNotMatch(agentLoop, /startupSearchDisplayTopic|startupSearchActionLabel/, 'startup search label helpers must not return as local task-driving behavior')
  assert.match(taskText, /function cleanTaskSubjectText/, 'task subject extraction must strip instruction lead-ins before visible labels are generated')
  assert.match(taskText, /extremely\|really\|very\|super/, 'task subject extraction must strip intensity modifiers such as "extremely deep research"')
  assert.match(taskText, /conduct\|do\|perform\|run\|carry\\s\+out/, 'task subject extraction must strip command lead-ins such as "conduct the deepest possible research on"')
  assert.match(taskText, /and\|then[\s\S]*produce\|create\|write\|draft\|deliver\|make\|prepare/, 'task subject extraction must stop before output instructions such as "and produce a report"')
  assert.doesNotMatch(planManager, /Map \$\{compact\} foundations and source angles|Gather authoritative \$\{compact\} sources|Write the sourced \$\{compact\} deep summary/, 'planner must not keep local canned fast research plan templates')
  assert.doesNotMatch(chatRoute, /createRouteStartupAcknowledgement|routeStartupAcknowledgementPromise|routeAckReadyMs|routeStartupAcknowledgementAbort/, 'external-worker startup acknowledgement must be owned by the worker, not a route-side best-effort request that can time out')
  assert.match(chatRoute, /const useExternalWorker = shouldUseExternalTaskWorker\(\)/, 'chat route must compute the external-worker branch once for startup ordering')
  assert.match(chatRoute, /if \(useExternalWorker\) \{[\s\S]*;\[, messages\] = await Promise\.all\(\[[\s\S]*creditsPromise,[\s\S]*messagesPromise,[\s\S]*\]\)[\s\S]*access = null[\s\S]*\} else \{[\s\S]*accessPromise/, 'external task streams must open after credits and messages, without waiting on task access or worker heartbeat')
  assert.doesNotMatch(chatRoute, /;\[, messages, access, unavailableWorker\] = await Promise\.all/, 'worker readiness must stay off the first-paint Promise.all')
  assert.match(chatRoute, /void accessPromise\.then\(async \(accessResult\)[\s\S]*taskAccessDenied = true[\s\S]*cancelTaskJob\(userId, creditRunId\)/, 'task access must still cancel the prefaced task if ownership validation fails')
  assert.doesNotMatch(chatRoute, /taskStartPromise = workerStartupPlanPromise\.then|workerStartupPlanPromise[\s\S]*enqueueTaskJob/, 'external-worker route must not use the old post-queue startup-plan patch race')
  assert.doesNotMatch(chatRoute, /createFastStartupPlan|chooseFastStartupPlan|fastStartupPlanSubject/, 'external-worker route must not create deterministic local plans')
  assert.match(chatRoute, /const initialEvents:\s*SSEEvent\[\]\s*=\s*\[heartbeatEvent\]/, 'external-worker route must persist only heartbeat before the worker-owned plan')
  assert.match(chatRoute, /taskStartPromise = Promise\.resolve\(\)\.then\(\(\) => \{[\s\S]*startupPlanExpected: false[\s\S]*payload: queuedTaskPayload/, 'external-worker route must enqueue immediately and let the worker planner own visible steps')
  assert.doesNotMatch(chatRoute, /startupPlanExpected:\s*!directChat && useExternalWorker/, 'worker must not wait behind route-owned startup planning after claiming a queued job')
  assert.doesNotMatch(chatRoute, /taskStartPromise = (?:accessPromise|Promise\.all\()[\s\S]*enqueueTaskJob/, 'access and worker readiness checks must not hold the durable job out of the worker queue after first paint')
  assert.match(chatRoute, /ackPrefaceSettled[\s\S]*ackPrefaceExpired[\s\S]*ROUTE_STARTUP_ACK_PREFACE_WAIT_MS[\s\S]*await input\.taskStartPromise/, 'task replay may wait briefly for ack-first ordering, but not for the slower startup plan')
  assert.match(chatRoute, /if \(raced\.index === 0\)[\s\S]*if \(!ackPrefaceExpired\) emitEvents\(raced\.events\)[\s\S]*await input\.taskStartPromise/, 'chat route must emit acknowledgement first, then release persisted job events without waiting for plan generation')
  assert.match(chatTaskRunner, /waitForTaskJobStartupPlan\(creditRunId/, 'worker task runner must briefly wait for the route-owned plan before starting a duplicate planner')
  assert.match(agentLoop, /usePrecomputedPlan\(state,\s*this\.options\.startupPlan,\s*\{ emitPlan: false \}\)/, 'agent loop must use the persisted startup plan without emitting a duplicate plan event')
  assert.match(chatRoute, /skipStartupAcknowledgement:\s*false/, 'external workers must keep their own startup acknowledgement enabled so every task shows an ack before visible plan/action work')
  assert.doesNotMatch(chatRoute, /ROUTE_STARTUP_ACK_THOUGHTFUL_MIN_MS|waitForRouteStartupAcknowledgementWindow/, 'route startup acknowledgement must not wait behind a timed reveal gate')
  assert.doesNotMatch(chatRoute, /ROUTE_STARTUP_ACK_REASONING|ROUTE_STARTUP_ACK_MAX_TOKENS|ROUTE_STARTUP_ACK_TIMEOUT_MS/, 'route startup acknowledgement tuning must not return; route-side ack failures caused tasks with no visible ack')
  assert.match(chatTaskRunner, /skipStartupAcknowledgement:\s*skipStartupAcknowledgement === true/, 'worker must skip startup acknowledgement only when a future payload explicitly requests it')
  const usePrecomputedPlanContract = planManager.match(/usePrecomputedPlan\([\s\S]*?\n  private settleAcknowledgementFirstVisible/)?.[0] || ''
  assert.doesNotMatch(usePrecomputedPlanContract, /this\.acknowledgementEmitted = true|settleAcknowledgementFirstVisible\(true\)|settleAcknowledgementDisplay\(true\)/, 'using a precomputed route plan must not pretend the visible acknowledgement already painted')
  assert.match(planManager, /if \(this\.acknowledgementEmitted && !ownsVisibleAcknowledgement\) return/, 'late acknowledgement streams must not duplicate the planner acknowledgement that already became visible')
  assert.match(planManager, /if \(this\.skipAcknowledgement\) return[\s\S]*if \(this\.acknowledgementEmitted\) \{[\s\S]*suppressFurtherAcknowledgementDeltas = true[\s\S]*if \(this\.acknowledgementDisplayPromise\)/, 'planner must avoid duplicate acknowledgement text while still letting the planner acknowledgement win the startup race')
  assert.doesNotMatch(chatRoute, /acquireActiveTaskLease\(userId,\s*conversationId,\s*creditRunId\)/, 'chat route must not acquire an account-wide active-task lease before starting a new task')
  assert.doesNotMatch(chatRoute, /if \(!activeTask\.acquired\)|ACTIVE_TASK_CONFLICT_MESSAGE|ACTIVE_TASK_CONFLICT_CODE/, 'chat route must not reject new starts through the removed account-wide active-task conflict path')
  assert.doesNotMatch(chatRoute, /status:\s*409/, 'second concurrent task starts must not return a start-conflict response')
  assert.doesNotMatch(chatRoute, /refreshActiveTaskLease\(userId,\s*creditRunId\)|releaseActiveTaskLease\(userId,\s*creditRunId\)/, 'chat route must not maintain the removed account-wide start lease during task execution')
  assert.match(chatRoute, /conversationId:\s*authenticated\.conversationId/, 'resume stream requests must bind run replay to the requested conversation')
  assert.match(chatRoute, /conversationId,\s*\n\s*afterSeq: 0/, 'initial stream requests must bind run replay to the created conversation')
  assert.match(activeChatRoute, /assertSameOriginRequest/, 'active-run discovery route must enforce same-origin requests')
  assert.doesNotMatch(activeChatRoute, /assertInviteAccessApproved|invite access/i, 'active-run discovery route must not enforce invite access')
  assert.match(activeChatRoute, /assertTaskAccess/, 'active-run discovery route must enforce task ownership before returning a run id')
  assert.match(activeChatRoute, /findActiveTaskJobForConversation/, 'active-run discovery route must prefer durable job state over expiring active-task leases')
  assert.match(activeChatRoute, /getActiveTaskLeaseForUser/, 'active-run discovery route must read the active lease from the server')
  assert.match(activeChatRoute, /lease\.conversationId !== conversationId/, 'active-run discovery route must not return another task run id')
  assert.doesNotMatch(useAgentStream, /ACTIVE_TASK_CONFLICT_CODE|showActiveTaskConflict|pendingIds/, 'client stream must not intercept starts through the removed active-task conflict modal path')
  assert.match(useAgentStream, /fetchServerActiveRun/, 'client stream must query the server for active run ids when localStorage has no resume record')
  assert.match(useAgentStream, /getStoredActiveRun\(conversationId\) \|\| await fetchServerActiveRun\(conversationId,\s*options\)/, 'resume must query server active-run discovery before giving up')
  assert.doesNotMatch(uiStore, /A task is already running|Finish or stop|Only one task can run/i, 'UI store must not preserve the removed one-task-per-account message')
  assert.doesNotMatch(rootOverlays, /Task already running|Only one task can run/i, 'root overlays must not expose removed one-task-per-account copy')
  for (const [name, source] of Object.entries({
    modal,
    chatInput,
    userMessage,
    imagePreview: await readFile(join(root, 'src/components/chat/ImagePreview.tsx'), 'utf8'),
    conversationSearch: await readFile(join(root, 'src/components/chat/ConversationSearch.tsx'), 'utf8'),
    shortcutsPanel: await readFile(join(root, 'src/components/modals/ShortcutsPanel.tsx'), 'utf8'),
    commandPalette: await readFile(join(root, 'src/components/ui/CommandPalette.tsx'), 'utf8'),
    customSelect: await readFile(join(root, 'src/components/ui/CustomSelect.tsx'), 'utf8'),
  })) {
    assert.doesNotMatch(source, /\bautoFocus\b|\bautofocus\b|\.focus\s*\(/, `${name} must not move browser focus automatically`)
  }
  assert.doesNotMatch(activeTaskConflictModal, /Task already running|Only one task can run per account/i, 'active-task modal must not expose the removed one-task-per-account rule')
  assert.match(chatRoute, /for \(let attempt = 0; attempt <= DIRECT_CHAT_MAX_CONTINUATIONS; attempt\+\+\) \{[\s\S]*await assertServerCreditsAvailable\(userId\)[\s\S]*createCompletion/, 'direct chat must preflight credit runway before every provider call')
  assert.match(agentLoop, /await assertServerCreditsAvailable\(this\.options\.userId\)[\s\S]*createStreamingCompletion/, 'agent loop must preflight credit runway before every streaming provider call')
  assert.match(planManager, /preflightCredit/, 'planner must support credit preflight before provider calls')
  assert.match(planManager, /await this\.assertCreditRunway\('ack'\)[\s\S]*createCompletion/, 'planner acknowledgements must preflight before provider calls')
  assert.match(planManager, /await this\.assertCreditRunway\('initial'\)[\s\S]*createCompletion/, 'initial planning must preflight before provider calls')
  assert.match(policyEngine, /function websiteQaStatus/, 'website deliverables must have a dedicated QA completion gate')
  assert.match(policyEngine, /Fixed-search constraint satisfied/, 'research policy must recognize explicit fixed-search completion')
  assert.match(policyEngine, /Research notes are useful when explicitly requested[\s\S]{0,420}return false/, 'ordinary research phases must not require hidden note-file detours')
  assert.match(policyEngine, /WEBSITE STRUCTURE CHECK/, 'website QA must reject incomplete file structures')
  assert.match(policyEngine, /LOCAL VISUAL QA REQUIRED/, 'website QA must require local visual preview')
  assert.match(policyEngine, /LOCAL VISUAL QA REQUIRED/, 'website QA must require fixed-viewport visual checks')
  assert.doesNotMatch(tools, /name:\s*'browser_resize'|"browser_resize"/, 'browser_resize must not be exposed to the model')
  assert.match(toolPipeline, /browser_resize is disabled because autonomous viewport\/ratio changes are blocked/, 'stale browser_resize calls must be blocked before execution')
  assert.match(policyEngine, /Research phase complete/, 'completed research depth must auto-advance instead of waiting for optional notes')
  assert.doesNotMatch(policyEngine, /state\.taskStrategy === 'research' &&\s*\(state\.taskComplexity/, 'research note requirement must not be limited to pure research tasks')
  assert.match(policyEngine, /FINAL DELIVERABLE REQUIRED/, 'support files must not satisfy final deliverable requirements')
  assert.match(policyEngine, /hasFinalDeliverableCandidate/, 'final completion must check deliverable-purpose artifacts')
  assert.match(policyEngine, /FUTURE-TENSE STATUS BLOCKED/, 'future-tense narration after progress must be blocked')
  assert.match(policyEngine, /live browser state does not prove the step is complete/, 'browser <next_step/> must be rejected without exact live-state evidence')
  assert.match(policyEngine, /state\.browserTaskCompleted/, 'browser step advancement must be gated on verified task completion')
  assert.match(policyEngine, /RESEARCH STEP HAS ZERO TOOL CALLS/, 'zero-tool research steps must recover with a tool-only prompt instead of terminating')
  assert.match(policyEngine, /FALSE LIVE-ACCESS BLOCKER/, 'false no-live-access narration must be rejected during active research/browser phases')
  assert.match(policyEngine, /do not advance from snippets alone/, 'new research phases should require credible source evidence before advancing')
  assert.doesNotMatch(taskStrategy, /5-8 tool calls per step/, 'research strategy guidance must not push arbitrary high tool-count quotas')
  assert.match(taskStrategy, /researchBudgetMultiplier:\s*0\.75/, 'research strategy should reserve more budget for synthesis instead of near-full per-phase tool loops')
  assert.match(taskStrategy, /Use strong sources, not snippet-only coverage[\s\S]*opened primary\/academic\/specialist pages/, 'research strategy should scale source depth by evidence need')
  assert.match(policyEngine, /if \(state\.taskComplexity >= 2\) return false/, 'research auto-advance must not let moderate or complex phases leave before depth checks pass')
  assert.match(prompts, /do not stop at page titles, snippets, generic positioning copy, Wikipedia-only context, one-source summaries, placeholder UI, first-draft code, or thin prose/, 'runtime prompt must counter skim behavior across task types')
  assert.match(prompts, /mechanism\/why, concrete evidence, example or comparison, limitation or counterpoint, and implication/, 'runtime prompt must define the human-style unpacking shape for explanatory work')
  assert.match(prompts, /Do not over-collect sources after that shape is satisfied/, 'runtime prompt must prevent ambition from becoming endless source gathering')
  assert.match(prompts, /const quickOnly =[\s\S]*quickly\|quick\|brief\|briefly\|short[\s\S]*if \(quickOnly\) \{[\s\S]*return 1/, 'complexity pre-estimate must keep explicitly lightweight requests lightweight')
  assert.match(prompts, /const quickOnly =[\s\S]*!\/\\b\(\?:deep\|comprehensive[\s\S]*report\|current\|latest\|build/, 'quick handling must not downgrade research, report, current, build, or artifact work')
  assert.match(planManager, /Extract concrete evidence from pages you open/, 'research step guidance must require extraction beyond snippets')
  assert.match(planManager, /Unpack the angle before advancing/, 'research step guidance must ask the model to fill missing analytical gaps before advancing')
  assert.match(taskStrategy, /real evidence packet[\s\S]*targeted searches[\s\S]*concrete extracted details/, 'research strategy guidance must operationalize depth beyond source count')
  assert.match(goalTracker, /requiredOpenedSourcesForDepth/, 'goal completion must require stronger opened-source depth for moderate explanatory research')
  assert.match(goalTracker, /isExactSingleSourceLookup/, 'goal completion must preserve one-source behavior for exact official lookups')
  assert.doesNotMatch(prompts, /1500\+|1500-word|Minimum 1500/, 'research reports must not have a blanket 1500-word requirement')
  assert.match(prompts, /Report length must match the user's request and task complexity/, 'deliverable length must be complexity-driven')
  assert.match(prompts, /Executive Summary[\s\S]*numbered thematic sections[\s\S]*Conclusion[\s\S]*References/, 'research report deliverables must default to the clean report structure')
  assert.match(prompts, /inline bracket citations such as \[1\]/, 'research report deliverables must prefer inline numbered citations')
  assert.match(prompts, /Reports, research findings, and substantial write-ups default to a saved Markdown file unless the user explicitly asks for inline chat\/no file/, 'runtime prompt must default report and findings tasks to saved markdown')
  assert.match(prompts, /Reports, research findings, and substantial write-ups use \.md by default unless the user explicitly asks for inline chat/, 'planner must default report and findings tasks to saved markdown')
  assert.match(agentLoop, /taskDefaultsToMarkdownDeliverable\(text\)/, 'final deliverable routing must treat report and findings tasks as saved markdown by default')
  assert.match(agentLoop, /For reports, research findings, and substantial write-ups, create a \.md file under deliverables\//, 'final saved-deliverable prompt must require markdown report files')
  assert.match(stepMessages, /taskDefaultsToMarkdownDeliverable\(text\)/, 'step messaging must keep final report steps on saved deliverable path')
  assert.match(eventDispatcher, /looksLikeDuplicatedSavedReport/, 'completion rendering must suppress duplicated full report text when a saved file exists')
  assert.match(taskStrategy, /specific title, compact metadata[\s\S]*Executive Summary[\s\S]*numbered thematic findings[\s\S]*numbered References/, 'research strategy must preserve clean report-style final output guidance')
  assert.match(await readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'), /# specific title[\s\S]*## Executive Summary[\s\S]*numbered thematic sections[\s\S]*## Conclusion[\s\S]*## References/, 'final research step guidance must enforce the clean Markdown report skeleton')
  assert.match(prompts, /Length follows the user's request and task complexity/, 'planner research deliverables must not default to fixed report length')
  assert.doesNotMatch(await readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'), /1500\+|1500-word/, 'step messages must not force fixed-length research reports')
  assert.match(agentConfig, /RESEARCH_MIN_WORDS_BY_COMPLEXITY/, 'research output verification must use complexity-aware word thresholds')
  assert.doesNotMatch(agentConfig, /RESEARCH_MIN_WORDS\s*=/, 'research output verification must not use a single fixed word minimum')
  assert.match(outputVerifier, /researchMinimumWords\(originalRequest,\s*taskComplexity,\s*filePath\)/, 'research verifier must calculate length from request, complexity and saved-file type')
  assert.match(outputVerifier, /Content appears cut off or unfinished at the end/, 'research verifier must reject visibly truncated markdown reports')
  assert.match(outputVerifier, /savedResearchReport[\s\S]*taskDefaultsToMarkdownDeliverable\(originalRequest\)/, 'brief saved markdown reports must not use tiny inline-answer word floors')
  assert.match(outputVerifier, /brief\|quick\|short\|concise/, 'research verifier must respect explicitly concise report requests')
  assert.match(agentLoop, /recoveringFinalSavedDeliverable[\s\S]*state\.forceTextNextIteration = !recoveringFinalSavedDeliverable && state\.taskStrategy !== 'browse'/, 'tool-call recovery must keep browser tools enabled and keep final deliverables out of narration-only mode')
  assert.match(goalTracker, /state\.taskStrategy === 'browse'[\s\S]*?state\.browserTaskCompleted/, 'browser goals must not complete from generic tool evidence')
  assert.match(goalTracker, /MAX_RENDERED_GOALS = 8/, 'goal context should be bounded for long plans')
  assert.match(goalTracker, /visibleGoalsForContext/, 'goal tracker must compact long goal lists around the active goal')
  assert.match(goalTracker, /done, \$\{this\.goals\.filter\(g => g\.status === 'blocked'\)\.length\} blocked, \$\{this\.goals\.length\} total/, 'compact goal context should preserve plan-level counts')
  assert.match(browserIntelligence, /extractRequestedSearchTerms/, 'browser completion must extract requested search terms')
  assert.match(browserIntelligence, /looksLikeSearchListing/, 'browser completion must identify search-result/listing pages')
  assert.match(browserIntelligence, /looksLikeOpenedResultPage/, 'browser completion must distinguish opened result pages from listing pages')
  assert.match(browserIntelligence, /isNamedAiConversationObjective/, 'browser completion must detect named AI chat/debate objectives')
  assert.match(browserIntelligence, /The named AI chat page shows a response/, 'browser completion must treat visible AI replies as named-chat completion evidence')
  assert.match(toolPipeline, /recordWorkLedgerFailure\(state,\s*\{\s*tool: tc\.name,[\s\S]*?error: errorResult\.error/, 'blocked preflight calls must be recorded in the ledger')
  assert.match(toolPipeline, /researchFileDetourBlockReason/, 'live research phases must block file-note/artifact detours before source evidence')
  assert.match(toolPipeline, /Do not create\/read research notes, inspect existing artifacts, or log inability/, 'research detour recovery must force source tools instead of note/log work')
  assert.match(toolPipeline, /isBrowserPreflightActionBlock/, 'preflight action blocks must be classified separately from page failures')
  assert.match(toolPipeline, /useFreshSnapshotForCompletion/, 'fresh snapshots from preflight blocks must still be able to prove browser task completion')
  assert.match(toolPipeline, /sameSourceDomain\(visitedUrl,\s*userUrl\)/, 'explicit URL search guard must treat www/naked-domain navigation as an attempted direct navigation')
  assert.match(toolPipeline, /directNavigationBeforeSearchTarget/, 'explicit URL tasks must detect the direct navigation target before allowing search')
  assert.match(toolPipeline, /Rerouted web_search to direct navigation/, 'explicit URL web_search attempts must be auto-rerouted to browser navigation without another model turn')
  assert.match(toolPipeline, /plan_step_index:\s*state\.currentStepIdx \+ 1/, 'auto-rerouted direct navigation must keep the one-based visible plan step index')
  assert.doesNotMatch(toolPipeline, /maybeAutoOpenSearchResult|Source evidence details|chooseSearchResultToAutoOpen|explicitQuickInlineScope|bareResearchRenderedBrowserBlockReason|AUTO_OPEN_TRUSTED_SOURCE_DOMAIN_HINTS/, 'research speed must not come from backend-forced source-opening or canned source-detail pills')
  assert.match(agentLoop, /function savedDeliverableChunkEndsCleanly/, 'saved markdown deliverables must check clean chunk boundaries before accepting completion')
  assert.match(agentLoop, /FINAL_SAVED_DELIVERABLE_INITIAL_MAX_TOKENS = 1_600/, 'initial markdown deliverable writes need enough budget to avoid clipped reports')
  assert.doesNotMatch(toolPipeline, /BLOCKED: the user's request contains an explicit URL\/domain/, 'explicit URL search guard must not expose raw BLOCKED text')
  assert.match(toolPipeline, /function isBrowseFailureResult/, 'browse failure tracking must count failures without poisoning whole domains')
  assert.match(toolPipeline, /chrome-error:/, 'browser chrome-error pages must count as failed browser evidence, not successful research')
  assert.match(toolPipeline, /function isInternalRecoveryResult/, 'internal extraction recovery results must be classified centrally')
  assert.match(toolPipeline, /function isToolExecutionErrorResult[\s\S]*isInternalRecoveryResult/, 'internal extraction recovery must count as a failed evidence action')
  assert.match(policyEngine, /shouldAdvanceResearchForPlanBudget/, 'research phases must preserve runway for remaining plan steps and final synthesis')
  assert.match(policyEngine, /deliverableReserve[\s\S]*MIN_DELIVERABLE_BUDGET \+ 8/, 'global budget protection must reserve usable final-synthesis runway')
  assert.match(agentLoop, /FAST_SOURCE_ACTION_REQUEST_TIMEOUT_MS = 2_000/, 'source-action starts must stay inside a 2s fast window')
  assert.match(agentLoop, /FAST_ACTION_REQUEST_TIMEOUT_MS = 2_000/, 'non-source action starts must stay inside a 2s fast window')
  assert.match(agentLoop, /FAST_ACTION_RETRY_REQUEST_TIMEOUT_MS = 2_000/, 'hot action retries must stay inside a 2s fast window')
  assert.match(agentLoop, /function isFastActionToolTurn/, 'agent loop must classify fast between-tool action turns centrally')
  assert.match(agentLoop, /const fastActionTurn = activeTools\.length > 0 &&[\s\S]*!isPostCompletion &&[\s\S]*isFastActionToolTurn\(state,\s*this\.options\.messages\)/, 'active tool-selection turns must enter the fast minimal-thinking lane by default')
  assert.match(agentLoop, /HOT PATH ACTION TURN:[\s\S]*make exactly one native tool call[\s\S]*speed comes from choosing the next action quickly, not from doing less work/, 'fast action turns must explicitly ask lightweight models for immediate tool selection without reducing depth')
  assert.match(agentLoop, /HOT PATH SOURCE ACTION TURN:[\s\S]*up to 4 parallel source extraction calls[\s\S]*read_document, http_request, or youtube_transcript/, 'source-action turns must allow small parallel stateless source extraction batches')
  assert.match(agentLoop, /parallel_tool_calls:\s*fastSourceActionTurn/, 'model parallel tool calls must be enabled only for source-action turns')
  assert.match(toolPipeline, /MAX_PARALLEL_SOURCE_EXTRACTIONS = 4/, 'source extraction parallelism must be capped at four calls')
  assert.match(toolPipeline, /PARALLEL_SOURCE_EXTRACTION_TOOLS[\s\S]*read_document[\s\S]*http_request[\s\S]*youtube_transcript/, 'only stateless source extraction tools should be eligible for parallel execution')
  assert.match(toolPipeline, /parallelSourceExtractionBatch[\s\S]*allCalls\.every\(tc => PARALLEL_SOURCE_EXTRACTION_TOOLS\.has\(tc\.name\)\)[\s\S]*MAX_PARALLEL_SOURCE_EXTRACTIONS/, 'parallel execution must be restricted to source extraction batches')
  assert.match(toolPipeline, /Promise\.all\(executionBatch\.map[\s\S]*executeSingle\(tc,\s*state,\s*assistantContent\)/, 'parallel source extraction batches must execute concurrently')
  assert.match(toolPipeline, /autoSourceExtractionBatchFromSearch[\s\S]*currentStepWebSearchLimit\(state\) !== null \|\| hasSingleWebSearchLimit\(state\)[\s\S]*MAX_PARALLEL_SOURCE_EXTRACTIONS/, 'successful research searches must auto-build a bounded source extraction batch without violating fixed-search limits')
  assert.match(toolPipeline, /executeAutoSourceExtractionBatch[\s\S]*Auto-extracting \$\{batch\.length\} source result\(s\) immediately after web_search[\s\S]*Promise\.all\(batch\.map/, 'post-search source extraction must run immediately in the tool pipeline instead of waiting for another model turn')
  assert.match(toolPipeline, /this\.autoGeneratedToolCallIds\.has\(tc\.id\)[\s\S]*narrationCadenceBlockReason/, 'auto-generated parallel source pills must be allowed to fill the current action cluster before narration gates the next turn')
  assert.match(toolPipeline, /AUTO SOURCE EXTRACTION RESULTS[\s\S]*Do not call web_search again just because the visible action was a search[\s\S]*All automatic source extractions were blocked[\s\S]*Do not repeat the same web_search/, 'auto-extracted source results must be summarized for the next model turn without causing follow-up search loops')
  assert.match(agentLoop, /state\.iterations <= 2 && lastStreamResult\.toolCalls\.size === 0[\s\S]*await planManager\.awaitPlan\(state\)/, 'early planner waits must not block already-streamed tool calls')
  assert.match(agentLoop, /fastSourceActionTurn[\s\S]*FAST_SOURCE_ACTION_MAX_TOKENS/, 'source-action turns must use a compact max-token budget instead of a full synthesis budget')
  assert.match(agentLoop, /fastActionTurn[\s\S]*MINIMAL_THINKING_REASONING/, 'between-tool action turns must use the shared minimal-thinking fast lane')
  assert.match(agentLoop, /HOT ACTION START RETRY:[\s\S]*do not detour into progress narration/, 'hot action model-start timeouts must retry action selection without a narration detour')
  assert.doesNotMatch(agentLoop, /FAST_ACTION_NONSTREAM_REQUEST_TIMEOUT_MS|Fast action stream start timed out; using compact action completion/, 'between-tool timeouts must not wait again on a second non-streaming fast-action call')
  assert.match(agentLoop, /function shouldStartIterationBudgetFinalization[\s\S]*remainingIterations <= iterationBudgetFinalizationTriggerTurns/, 'iteration budget pressure must force finalization instead of ending with an unfinished plan')
  assert.match(agentLoop, /function budgetFinalizationWouldSkipRequiredResearch[\s\S]*compactResearchEvidenceComplete\(state\)[\s\S]*return true/, 'iteration budget finalization must not skip unfinished substantive research')
  assert.match(agentLoop, /shouldStartIterationBudgetFinalization[\s\S]*budgetFinalizationWouldSkipRequiredResearch\(state,\s*messages\)[\s\S]*return false/, 'deep/current research tasks must keep researching instead of being folded into finalization')
  assert.match(agentLoop, /state\.dynamicIterationLimit = Math\.min\([\s\S]*MAX_ITERATIONS[\s\S]*state\.iterations \+ finalizationTurns/, 'iteration budget finalization must reserve enough turns to save or emit the final output')
  assert.match(toolPipeline, /state\.pendingDeliverableRevision[\s\S]*Make exactly one append_file or edit_file call against/, 'failed final deliverable verification must constrain revisions to the existing file')
  assert.match(streamProcessor, /pendingDeliverableRevisionAllowsPreview[\s\S]*toolName !== 'append_file' && toolName !== 'edit_file'[\s\S]*return false/, 'blocked final-deliverable recreate attempts must not emit misleading provisional file previews')
  assert.match(agentLoop, /function compactResearchSourceOpeningExhausted[\s\S]*state\.stepLoopDetections >= 4[\s\S]*state\.stepToolCallCount >= Math\.max/, 'source-opening loops must be detected after repeated failed extraction/navigation attempts')
  assert.doesNotMatch(agentLoop, /compactResearchSourceOpeningExhausted\(state,\s*depth\)[\s\S]{0,120}return true/, 'source-opening exhaustion alone must not mark compact research evidence complete')
  assert.match(agentLoop, /SOURCE OPENING RECOVERY:[\s\S]*do not emit <next_step\/>[\s\S]*different source action now/, 'exhausted source-opening recovery must try a different concrete source route instead of advancing with failure narration')
  assert.match(agentLoop, /FORCED_NARRATION_REQUEST_TIMEOUT_MS = 2_000/, 'progress narration must stay inside a 2s no-thinking window')
  assert.match(agentLoop, /FORCED_NARRATION_INACTIVITY_TIMEOUT_MS = 900/, 'progress narration must recover quickly from short provider stalls')
  assert.match(streamProcessor, /throw new InactivityTimeoutError\(elapsed,\s*assistantContent \|\| ''\)/, 'stream polling inactivity must remain nudgeable instead of becoming a fatal generic error')
  assert.match(agentLoop, /function shouldPreferExtractionBeforeColdBrowser[\s\S]*stepResearchCallCount > 0[\s\S]*RESEARCH_COLD_BROWSER_RUNTIME_TOOLS/, 'source-like tasks must prefer search/document extraction before cold browser navigation')
  assert.match(agentLoop, /if \(shouldPreferExtractionBeforeColdBrowser\(state\)\)[\s\S]*RESEARCH_COLD_BROWSER_RUNTIME_TOOLS\.has\(tool\.function\?\.name/, 'tool pruning must remove cold browser opens from first source-like action turns')
  assert.match(streamProcessor, /contentOnlyStallMs[\s\S]*Math\.min\(5_000,\s*Math\.max\(150,\s*this\.tierTimeouts\.contentOnlyTimeoutMs\)\)/, 'content-only action stalls must respect tighter fast-action timeouts')
  assert.doesNotMatch(toolPipeline, new RegExp(['userProvided', 'Domain', 'IsBlocked'].join('') + '|' + ['is', 'Domain', 'Blocking', 'BrowseResult'].join('')), 'explicit URL and browse logic must not rely on site-level block state')
  assert.doesNotMatch(toolPipeline, /success === false && browseResult\.recoverable === true && \/\s*\\bnavigation failed/, 'recoverable 404/navigation misses must not be treated as domain bot blocks')
  assert.match(agentState, /satisfiedRequirements/, 'work ledger must track satisfied requirements')
  assert.doesNotMatch(agentState, new RegExp(['blocked', 'Domains'].join('')), 'agent state must not keep a site-wide browser blocklist')
  assert.match(agentState, /satisfyWorkLedgerRequirement/, 'work ledger must expose requirement satisfaction helper')
  assert.match(agentState, /Browser visual state inspected/, 'browser visual observations must satisfy visual-state requirements')
  assert.match(agentState, /Final browser state verified/, 'browser completion or hard blockers must satisfy final-state requirements')
  assert.match(agentState, /Satisfied requirements:/, 'work summary must expose satisfied requirements to the model')
  assert.match(agentState, /Support\/internal artifacts, not final deliverables:/, 'work summary must keep support artifacts separate from final deliverables')
  assert.match(planManager, /satisfyWorkLedgerRequirement\(state,\s*'Selected skill\/file loaded before work'/, 'preloaded skill steps must satisfy the skill-first requirement')
  assert.match(toolPipeline, /satisfyWorkLedgerRequirement\(state,\s*'Phase research notes saved'/, 'research note files must satisfy notes requirements')
  assert.match(toolPipeline, /satisfyWorkLedgerRequirement\(state,\s*'Input file\/document read'/, 'file/document reads must satisfy ingestion requirements')
  assert.match(taskConstraints, /SINGLE_WEB_SEARCH_PATTERNS/, 'single web search constraints must be parsed centrally')
  assert.match(taskConstraints, /requestsMarkdownDeliverable/, 'markdown deliverable detection must be part of one-search planning')
  assert.match(taskConstraints, /previousUserContent/, 'fixed-search follow-ups must be able to recover the prior topic')
  assert.match(dynamicKnowledge, /KNOWN_DYNAMIC_ENTITY_PATTERN/, 'dynamic AI/product questions must be detected centrally')
  assert.doesNotMatch(agentState, /researchActivityContext/, 'work summaries must not duplicate hidden research log context')
  assert.match(agentLoop, /function shouldInjectResearchActivityContext/, 'hidden research logs must be gated before context injection')
  assert.match(agentLoop, /state\.currentPhase === 'research'/, 'research log context must stay available during research phases')
  assert.match(agentLoop, /isNonFinalBrowserStep\(state\)/, 'research log context must stay available for non-final browser action turns')
  assert.doesNotMatch(agentLoop, /hasActivePlanStep && !state\.forceTextNextIteration\s*\?\s*researchActivityContext/, 'research log context must not be injected into every active plan step')
  assert.match(conversationContext, /CONTEXTUAL_UPDATE_PATTERN/, 'short correction messages must be detected centrally')
  assert.match(taskStrategy, /effectiveTaskRequest\(messages\)/, 'strategy selection must preserve prior task intent for interruptions')
  assert.match(streamCleaners, /stripRawToolCallMarkup/, 'client stream cleaners must strip raw text-mode tool calls')
  assert.match(streamCleaners, /sanitizeNarrationText/, 'task narrations must be sanitized before display')
  assert.match(streamCleaners, /DANGLING_NARRATION_END_PATTERN/, 'task narrations must reject incomplete sentence fragments')
  assert.match(streamCleaners, /MIN_PROGRESS_NARRATION_WORDS\s*=\s*15/, 'progress narration must reject too-short Manus-style updates')
  assert.match(streamCleaners, /isImperativeNarration/, 'progress narration must reject command-like status fragments')
  assert.match(streamCleaners, /isLikelyRawPageNarration/, 'raw browser/page chrome must be filtered from narration')
  assert.match(streamCleaners, /repairMissingSentenceBoundarySpaces/, 'task narrations must repair missing spaces after sentence punctuation')
  assert.match(streamCleaners, /\^gather\\b/, 'task narrations must reject lower-case command-fragment gathering text')
  assert.match(streamCleaners, /PHASE_LEAK_NARRATION_PATTERNS/, 'task narrations must reject leaked phase-transition instructions')
  assert.match(streamCleaners, /ENUMERATED_PLAN_ITEM_PATTERN/, 'final answers must strip leaked numbered planner instructions')
  assert.match(streamCleaners, /PLAN_LEAK_NARRATION_PATTERNS/, 'task narrations must reject leaked plan-scope fragments')
  assert.match(eventDispatcher, /cleanAcknowledgmentCandidate\(content: string\)/, 'final ACK text must be cleaned through the acknowledgement helper before it is kept')
  assert.match(serverSanitization, /stripRawToolCallMarkup/, 'server stream sanitization must strip raw text-mode tool calls')
  assert.match(eventDispatcher, /TOOLS_BETWEEN_NARRATION_FLUSHES = MIN_TOOLS_BETWEEN_NARRATION_FLUSHES/, 'client narration threshold must derive from the minimum exact cadence')
  assert.match(prompts, /Do not narrate with fewer than 3 new visible actions, and never go past 4 visible actions/, 'runtime prompt must enforce the exact 3-4 action narration window')
  assert.match(prompts, /never fewer than 15 words/, 'runtime prompt must forbid too-short progress paragraphs')
  assert.match(prompts, /<=34 words and <=240 characters/, 'runtime prompt must keep progress paragraphs concise')
  assert.match(prompts, /vary the opening verb and sentence shape/, 'runtime prompt must require varied progress narration openings')
  assert.match(prompts, /At exactly 3 visible actions, start the next response/, 'runtime prompt must make narration appear before the next action at the 3-action point')
  assert.match(prompts, /standing cadence for every phase/, 'runtime prompt must keep narration active across every phase')
  assert.match(prompts, /narration is the default first visible text/, 'runtime prompt must make narration the preferred first visible text when cadence is open')
  assert.match(prompts, /result-first/, 'runtime prompt must request result-first evidence narration')
  assert.match(prompts, /modern named AI products/, 'runtime prompt must force tool use for dynamic named AI/product comparisons')
  assert.match(prompts, /Named AI chat\/debate requests are ACTION tasks/, 'planner must route named AI chat/debate requests to browser action mode')
  assert.match(prompts, /debate, chat, talk, message, ask, or prompt a named AI service/, 'runtime prompt must force named AI chat requests through the live service UI')
  assert.match(prompts, /one concrete target per step/, 'action planner must avoid batching multiple known targets into one phase')
  assert.match(prompts, /use the prior user question as the topic/, 'planner prompt must preserve context for fixed-search follow-ups')
  assert.match(browserIntelligence, /detectSetupNavigationCompletion/, 'browser completion must auto-finish setup-only navigation phases once the site is usable')
  assert.match(browserIntelligence, /detectSearchFormReadyCompletion/, 'browser completion must auto-finish search/finder entry phases once the input form is ready')
  assert.match(browserIntelligence, /primaryObjectiveLine/, 'browser completion must isolate the current phase title from broader scope text')
  assert.match(eventDispatcher, /return toolName !== 'browser_screenshot' && toolName !== 'browser_resize'/, 'all visible tool actions must participate in model narration flush cadence')
  assert.match(agentState, /visibleToolActionsSinceLastNarration/, 'agent state must track visible action-pill count for narration cadence')
  assert.match(toolPipeline, /countVisibleToolActionForNarration/, 'tool execution must increment narration cadence from accepted visible tool starts')
  assert.match(policyEngine, /state\.visibleToolActionsSinceLastNarration >= threshold/, 'forced narration must be based on visible action pills, not raw iterations')
  assert.match(policyEngine, /visibleActionsAfterAcceptedNarration/, 'valid progress narration must preserve overflow action-pill cadence after late narration')
  assert.match(activityDescriber, /searching\|researching\|reviewing\|reading\|navigating\|scrolling\|clicking/, 'strict action labels must reject generic gerund tool wrappers')
  assert.match(activityDescriber, /reviewed\|completed\|found\|gathered\|confirmed/, 'strict action labels must reject past-tense progress narration as action pill text')
  assert.doesNotMatch(activityDescriber, /isTemplateShapedActionLabel|rawActionTarget/, 'strict action labels must not over-block safe model-authored labels just because they overlap the target')
  assert.match(activityDescriber, /runtimeVisibleActionLabel[\s\S]*Search \$\{queryTarget\}/, 'runtime search label repair must be grounded in the actual query')
  assert.match(toolPipeline, /runtimeVisibleActionLabel\(\s*'browser_navigate'/, 'search-to-navigation reroutes must repair the visible label to the real browser action')
  assert.doesNotMatch(activityDescriber, /Search for information on/, 'search pills must not use the old repeated generic wording')
  assert.doesNotMatch(toolPipeline, /Gather evidence on/, 'repaired search pills must not use the old repeated generic wording')
  assert.match(streamProcessor, /addDisplayContractArgs\(args,\s*parsed,\s*rawArgs\)/, 'stream parser must extract action labels before a tool call finishes streaming')
  assert.match(streamProcessor, /toolName === 'create_file' \|\| toolName === 'append_file'[\s\S]*?typeof args\.path === 'string'/, 'file writes must be eligible for provisional action starts once path exists')
  assert.match(streamProcessor, /toolName === 'edit_file'[\s\S]*?typeof args\.path === 'string'/, 'file edits must be eligible for provisional action starts once path exists')
  assert.match(streamProcessor, /function addProvisionalFileActionLabel[\s\S]*fileActionLabelFallback[\s\S]*args\.action_label/, 'file tools must show an early visible pill when path streams before action_label')
  assert.match(streamProcessor, /addStringMetrics\(args,\s*rawArgs,\s*'new_string'\)/, 'edit_file replacement text must expose live size metrics while streaming')
  assert.match(streamProcessor, /delete stableArgs\.new_stringCharCount[\s\S]*delete stableArgs\.new_stringLineCount/, 'edit_file metric changes must not recreate the live action pill while replacement text streams')
  assert.match(streamProcessor, /addProvisionalRuntimeDisplayContract\(earlyArgs,\s*toolCall\.name,\s*state\)/, 'live tool previews must repair display-only metadata before deciding whether to show the action pill')
  assert.match(streamProcessor, /this\.emitter\.fileContentStart\(toolCall\.id,\s*path,\s*toolCall\.name\)/, 'file write previews must initialize during tool argument streaming')
  assert.match(streamProcessor, /this\.emitter\.fileContentDelta\(toolCall\.id,\s*content\.slice\(preview\.emittedChars\)\)/, 'file write previews must stream incremental content deltas')
  assert.match(streamProcessor, /FILE_PREVIEW_MIN_DELTA_CHARS/, 'file write previews must batch tiny streamed deltas for cloud event persistence')
  assert.match(streamProcessor, /for \(const \[index, preview\] of filePreviewState\)/, 'file write preview batching must flush the final pending content before tool execution')
  assert.doesNotMatch(sandbox, /content:\s*'Error: old_string not found in file'/, 'edit_file old_string misses must not render raw errors as file contents')
  assert.match(sandbox, /INTERNAL_RECOVERY: edit_file did not apply because old_string did not match/, 'edit_file old_string misses must be internal retry signals')
  assert.match(streamCleaners, /to\\s\+i\\s\+\(\?:have\\s\+\)\?\(\?:found\|identified\|confirmed\|learned\|gathered\|examined\|reviewed/, 'narration sanitizer must reject malformed action-plus-finding fragments')
  assert.match(policyEngine, /Reflection prompts became a second planning loop/, 'mandatory reflection prompts must stay disabled because they cause text-only stalls')
  assert.doesNotMatch(policyEngine, /step_reflection_ignored/, 'reflection recovery must not surface a hard task-stopping step_reflection_ignored error')
  assert.match(policyEngine, /Do not force a separate per-step planning turn/, 'mandatory micro-plan prompts must stay disabled because they delay first tool calls')
  assert.match(policyEngine, /auto-advancing step/, 'atomic-step drift should move forward instead of blocking the task')
  assert.match(policyEngine, /Progress guard: do not write another text-only status reply/, 'no-tool progress handling should recover instead of hard-stopping ordinary steps')
  assert.match(toolPipeline, /duplicate guards were causing paid recovery loops/i, 'duplicate search guards should be advisory/cached instead of hard-blocking and adding cost')
  assert.match(toolCache, /DISPLAY_ONLY_ARG_KEYS = new Set\(\['action_label', 'plan_step_index'\]\)/, 'tool cache keys must ignore display-only metadata')
  assert.match(toolCache, /DISPLAY_ONLY_ARG_KEYS\.has\(key\)/, 'tool cache must strip action labels and plan indexes before keying results')
  assert.match(toolCache, /function normalizeCacheUrl/, 'tool cache should normalize read-only document/media URLs')
  assert.match(toolCache, /toolName === 'read_document'[\s\S]*normalizeCacheUrl\(sortedArgs\.source\)/, 'read_document cache keys should ignore URL tracking noise')
  assert.match(toolCache, /toolName === 'youtube_transcript'[\s\S]*normalizeCacheUrl\(sortedArgs\.url\)/, 'youtube transcript cache keys should ignore URL tracking noise')
  assert.match(toolCache, /function isCacheableHttpRequest/, 'ToolCache should cache only safe idempotent http_request calls')
  assert.match(toolCache, /function isCacheableHttpResponse/, 'ToolCache must avoid caching failed or explicitly uncacheable HTTP responses')
  assert.match(toolCache, /method !== 'GET' && method !== 'HEAD'/, 'http_request cache must be limited to GET/HEAD')
  assert.match(toolCache, /args\.body !== undefined && typeof args\.body !== 'string'/, 'non-string http_request bodies must not be cached')
  assert.match(toolCache, /status < 200 \|\| status >= 300/, 'failed http_request statuses must not be cached')
  assert.match(toolCache, /no-store\|no-cache\|private/, 'HTTP cache-control opt-outs must be honored')
  assert.match(toolCache, /key === 'authorization' \|\| key === 'cookie' \|\| key === 'proxy-authorization'/, 'credentialed http_request calls must not be cached')
  assert.match(toolCache, /toolName === 'http_request'\) return isCacheableHttpRequest\(args\)/, 'http_request cacheability must be argument-aware')
  assert.match(toolCache, /toolName === 'http_request'[\s\S]*normalizeCacheUrl\(sortedArgs\.url\)[\s\S]*delete sortedArgs\.body/, 'http_request cache keys should normalize URLs and omit empty bodies')
  assert.doesNotMatch(toolCache, /const UNCACHEABLE_TOOLS = new Set\(\[[\s\S]*'http_request'[\s\S]*\]\)/, 'http_request must not be globally uncached')
  assert.match(toolCache, /function normalizeSandboxCachePath/, 'tool cache should normalize safe sandbox file paths')
  assert.match(toolCache, /if \(parts\.length === 0\) return trimmed/, 'sandbox cache path normalization must not turn leading traversal into a valid path')
  assert.match(toolCache, /toolName === 'read_file'[\s\S]*normalizeSandboxCachePath\(sortedArgs\.path\)/, 'read_file cache keys should normalize equivalent sandbox paths')
  assert.match(toolCache, /toolName === 'list_files'[\s\S]*normalizeSandboxCachePath\(sortedArgs\.directory\)/, 'list_files cache keys should normalize equivalent sandbox directories')
  assert.match(toolCache, /normalizedFilePath[\s\S]*invalidateForTool\('list_files'\)/, 'file mutation invalidation should account for normalized cache paths and directory listings')
  assert.match(toolPipeline, /recordCachedToolProgress/, 'cached tool hits must update runtime progress state')
  assert.match(toolPipeline, /state\.stepToolTypeCounts\.set\(tc\.name/, 'cached tool hits must count toward per-step tool accounting')
  assert.match(agentConfig, /web_search:\s*28/, 'web_search baseline cap must stay high enough without becoming a target')
  assert.match(agentConfig, /read_document:\s*40/, 'read_document must have a useful cap plus loop guards, not an endless extraction runway')
  assert.match(toolLimits, /toolTypeRateLimitForState/, 'tool limits must be centralized so model menu and executor agree')
  assert.match(toolLimits, /researchDepthProfileForState[\s\S]*depth\.label === 'wide'[\s\S]*1\.65[\s\S]*depth\.label === 'deep'[\s\S]*1\.45/, 'research caps must scale up for deep and wide tasks without making default work too expensive')
  assert.match(toolLimits, /currentStepWebSearchLimit/, 'explicit user search-count limits must still override adaptive high caps')
  assert.match(agentLoop, /toolTypeRateLimitForState/, 'agent loop must use adaptive per-phase tool limits before offering tools to the model')
  assert.match(toolPipeline, /toolTypeRateLimitForState\(state,\s*tc\.name\)/, 'tool executor must enforce the same adaptive caps used in model selection')
  assert.match(planManager, /Tool caps are ceilings, never targets/, 'research planning must tell the agent high caps are not quotas')
  assert.match(agentLoop, /Tool caps are ceilings, never targets/, 'compact research turns must tell the model high caps are not quotas')
  assert.match(agentLoop, /toolStepRateLimitReached[\s\S]*state\.stepToolTypeCounts[\s\S]*pruneExhaustedStepToolsForCurrentTurn[\s\S]*toolStepRateLimitReached/, 'agent loop must remove exhausted per-phase tools before model selection')
  assert.match(agentLoop, /STEP TOOL LIMIT REACHED:[\s\S]*Do not request that tool[\s\S]*emit <next_step\/>/, 'model turns must be told when a tool is unavailable because its phase limit is exhausted')
  assert.match(toolPipeline, /Used cached search:[\s\S]*this\.memory\?\.extractFromSearch/, 'cached search hits must preserve evidence in working memory')
  assert.match(tools, /name:\s*'web_search'[\s\S]*Search the web/, 'research runtime must expose ordinary web_search for source discovery')
  assert.match(agentLoop, /Use targeted web_search for the next missing evidence gap/, 'compact research turns must ask for targeted web_search before source reads')
  assert.doesNotMatch(agentLoop, /researchStepAllowsSourceSweep|researchStepAllowsPlainWebSearch/, 'research tool pruning must not gate normal web_search behind source_sweep state')
  assert.doesNotMatch(agentConfig, /research:\s*\[[\s\S]*'source_sweep'/, 'source_sweep must not be available in active research phase tools')
  assert.match(agentConfig, /research:\s*\[[\s\S]*'web_search'[\s\S]*'read_document'/, 'active research phase tools must include web_search and read_document')
  assert.match(toolPipeline, /Used cached HTTP result[\s\S]*this\.memory\?\.extractFromBrowse\(url, body/, 'cached http_request hits must preserve response bodies in working memory')
  assert.match(toolPipeline, /tc\.name === 'http_request'[\s\S]*recordHttpRequestEvidence\(args, result, state, false\)[\s\S]*recordResearchActivity/, 'fresh http_request results must update evidence tracking before the next model turn')
  assert.match(toolPipeline, /recordHttpRequestEvidence[\s\S]*trackVisitedSourceDomain[\s\S]*recordWorkLedgerSource/, 'http_request evidence should be tracked as a source, not just raw tool output')
  assert.match(toolPipeline, /tc\.name === 'read_document'[\s\S]*recordDocumentReadEvidence\(args, result, state, false\)[\s\S]*recordResearchActivity/, 'fresh read_document results must update evidence tracking before the next model turn')
  assert.match(toolPipeline, /tc\.name === 'read_document'[\s\S]*if \(!isError\) \{[\s\S]*recordDocumentReadEvidence\(args, result, state, false\)/, 'failed read_document calls must not count as opened source evidence')
  assert.match(toolPipeline, /recordDocumentReadEvidence[\s\S]*state\.stepVisitedUrls\.add\(url\)[\s\S]*trackVisitedSourceDomain/, 'read_document must count as an opened/read source for research-depth completion')
  assert.match(toolPipeline, /function toolTargetFromArgs[\s\S]*args\.url,[\s\S]*args\.source,[\s\S]*args\.query,/, 'failed document extraction attempts must record the exact source URL so the agent does not retry the same blocked source')
  assert.match(toolPipeline, /function duplicateSourceOpenBlockReason[\s\S]*browser_navigate[\s\S]*already \$\{verb\} in this phase[\s\S]*failedRoutes[\s\S]*already attempted with \$\{toolName\}[\s\S]*duplicateSourceOpenBlockReason\(tc\.name, args, state\)/, 'same-step duplicate source URLs and failed same-URL retries must be blocked before visible tool_start')
  assert.match(toolPipeline, /function browserEvidenceLooksUsable[\s\S]*about:blank[\s\S]*404[\s\S]*browser_get_content[\s\S]*length >= 120/, 'blank, 404, and empty rendered pages must not satisfy opened-source research evidence')
  assert.match(toolPipeline, /usableBrowserEvidence[\s\S]*RESEARCH_TOOLS\.has\(tc\.name\)[\s\S]*!BROWSER_RESULT_TOOLS\.has\(tc\.name\) \|\| usableBrowserEvidence/, 'fresh browser reads must only count as research calls when the rendered page is usable')
  assert.match(toolPipeline, /usableCachedBrowserEvidence[\s\S]*RESEARCH_TOOLS\.has\(tc\.name\)[\s\S]*!BROWSER_RESULT_TOOLS\.has\(tc\.name\) \|\| usableCachedBrowserEvidence/, 'cached browser reads must only count as research calls when the rendered page is usable')
  assert.match(toolPipeline, /Used cached document[\s\S]*this\.memory\?\.extractFromBrowse\(url, content/, 'cached read_document hits must preserve document evidence in working memory')
  assert.match(agentState, /CIRCUIT_BREAKER_EXEMPT_TOOLS[\s\S]*'read_document'/, 'read_document source extraction misses must not disable the document reader globally')
  assert.match(agentState, /canTripCircuitBreaker = !CIRCUIT_BREAKER_EXEMPT_TOOLS\.has\(toolName\)[\s\S]*if \(canTripCircuitBreaker && health\.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD/, 'circuit breaker must ignore exempt per-source extraction tools')
  assert.match(documentReader, /INTERNAL_RECOVERY: direct text extraction was blocked for this URL/, 'blocked direct extraction must be returned as an internal recovery result')
  assert.match(documentReader, /Source needs browser rendering/, 'blocked direct extraction must use a neutral internal source title')
  assert.doesNotMatch(documentReader, /Direct text extraction was blocked for this URL\. Use browser_navigate\/browser_get_content/, 'blocked extraction must not carry the old user-facing recovery instruction')
  assert.match(eventDispatcher, /isHiddenInternalToolResult[\s\S]*INTERNAL_RECOVERY:/, 'internal extraction recovery results must be hidden from the Computer panel')
  assert.match(toolPipeline, /tc\.name === 'list_files'[\s\S]*recordFileListingEvidence\(args, cached, state, true\)/, 'cached list_files hits must leave a progress breadcrumb')
  assert.match(toolPipeline, /tc\.name === 'list_files'[\s\S]*recordFileListingEvidence\(args, result, state, false\)/, 'fresh list_files results must leave a progress breadcrumb')
  assert.match(toolPipeline, /Workspace files inspected[\s\S]*inspect existing files[\s\S]*list files/, 'file listing breadcrumbs should satisfy workspace inspection requirements')
  assert.match(toolPipeline, /Returning cached search result[\s\S]*recordCachedToolProgress/, 'duplicate cached searches must update progress before returning')
  assert.match(toolPipeline, /BROWSER_CONTENT_INVALIDATING_TOOLS/, 'browser read caches must be invalidated after page-state-changing browser actions')
  assert.match(toolPipeline, /invalidateForTool\('browser_get_content'\)/, 'stale browser_get_content cache entries must be cleared after navigation or interaction')
  assert.match(toolPipeline, /coalesceBrowserActionSequence/, 'compatible same-screen browser tool calls should be coalesced sequentially instead of discarded')
  assert.match(toolPipeline, /coalescing stable browser actions into browser_action_sequence/, 'browser action coalescing should be observable in logs')
  assert.match(toolPipeline, /BROWSER_SEQUENCE_ACTION_BY_TOOL[\s\S]*browser_click_at[\s\S]*browser_type[\s\S]*browser_select/, 'browser action coalescing must stay limited to existing sequence-compatible actions')
  assert.match(toolPipeline, /browser_type' && actionArgs\.submit === true && i < allCalls\.length - 1/, 'auto-coalescing must not continue after a mid-sequence submit')
  assert.match(agentLoop, /toolResults[\s\S]*\.map\(result => result\.tc\)[\s\S]*requestedIds\.has\(tc\.id\)/, 'provider history must preserve synthesized executed tool calls such as coalesced browser_action_sequence')
  assert.match(agentLoop, /executedCoalescedBrowserSequence[\s\S]*browser_action_sequence[\s\S]*!executedCoalescedBrowserSequence/, 'coalesced browser sequences must not be followed by a misleading discarded-tool note')
  assert.match(toolPipeline, /Model requested \$\{allCalls\.length\} tool calls; executing only the first one this turn/, 'unsafe mixed tool execution must stay single-action per turn')
  assert.match(toolPipeline, /Model requested \$\{allCalls\.length\} source extraction calls; executing \$\{parallelSourceBatch\.length\} in parallel/, 'parallel source extraction should be observable in logs')
  assert.doesNotMatch(toolPipeline, /Promise\.allSettled\(promises\)|PARALLEL_TOOL_MAX_CONCURRENCY/, 'old unbounded parallel execution path must stay removed from ToolPipeline')
  assert.doesNotMatch(`${contextManager}\n${toolPipeline}`, /websiteBrowserCheckPrompted/, 'website visual checks must use the typed websiteBrowserCheckAttempted state flag')
  assert.match(agentState, /stepCrossToolCycleDetections/, 'tool-cycle detections must be tracked per step')
  assert.match(agentState, /state\.lastLoopSignal = null/, 'step advancement must clear stale loop signals before the next phase')
  assert.match(agentState, /researchNoToolRecoveryAttempts/, 'research text-only recovery attempts must be tracked per step')
  assert.match(agentState, /state\.researchNoToolRecoveryAttempts = 0/, 'research text-only recovery attempts must reset on step advance')
  assert.match(agentState, /stepOpenedSourceDomainCounts/, 'opened/read source domains must be tracked separately from search-result domains')
  assert.match(agentState, /trackSourceDomain[\s\S]*stepSourceDomainCounts\.set/, 'web search result domains should be retained as candidates for source discovery')
  assert.match(agentState, /trackVisitedSourceDomain[\s\S]*stepOpenedSourceDomains\(state\)[\s\S]*openedDomains\.set/, 'opened/read source tracking must count toward research-depth completion')
  assert.match(policyEngine, /const domains = stepOpenedSourceDomains\(state\)\.size/, 'research depth must require opened/read source domains, not just search-result domains')
  assert.match(policyEngine, /function hasLoopLimitedResearchEvidence[\s\S]*depth\.complete[\s\S]*state\.stepLoopDetections >= 2 && \([\s\S]*hasStalledResearchEvidence\(state\)[\s\S]*hasFailureLimitedResearchEvidence\(state,\s*depth\)/, 'research loops may only advance after complete depth or substantial stalled evidence after repeated loop detection')
  assert.match(policyEngine, /function hasFailureLimitedResearchEvidence[\s\S]*state\.stepFailureCount < 2[\s\S]*calls < Math\.max\(4,[\s\S]*reportResearchNeedsSources/, 'blocked source reads should let a worked research phase move only after enough searches and source candidates')
  assert.match(agentState, /state\.stepFailureCount = 0/, 'step advancement must reset per-phase failure counts so blocked sources do not poison later phases')
  assert.doesNotMatch(policyEngine, /state\.stepLoopDetections = 1/, 'research loop recovery must not reset the per-step loop escalation and spin indefinitely')
  assert.match(agentLoop, /loopRecoveryToolForState[\s\S]*suppressed === 'web_search'[\s\S]*read_document[\s\S]*browser_navigate[\s\S]*return narrowed/, 'research loop recovery must expose alternate source-opening routes instead of boxing the agent into the same slow pattern')
  assert.match(policyEngine, /narrationOnlyResearchTurn[\s\S]*state\.visibleToolActionsSinceLastNarration = 0[\s\S]*return \[\]/, 'valid progress narration in research must clear the narration backlog so repeated text cannot spin forever')
  assert.match(policyEngine, /repeatedIncompleteResearchNoTool[\s\S]*shouldAdvanceResearchAtBudgetBoundary\(state,\s*researchDepth\)[\s\S]*Advanced from repeated text-only research/, 'repeated text-only research must advance with recorded evidence gaps once the phase has enough evidence')
  assert.match(agentConfig, /MIN_RESEARCH_CALLS_BY_COMPLEXITY = \{ 1: 4, 2: 10, 3: 18 \}/, 'research evidence thresholds must stay above shallow three-action phases while keeping quick tasks light')
  assert.match(agentConfig, /MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY = \{ 1: 2, 2: 6, 3: 8 \}/, 'substantive research phases must require source diversity without overcharging quick tasks')
  assert.match(await readFile(join(root, 'src/lib/agent/ResearchDepth.ts'), 'utf8'), /perPhaseDepthBudget[\s\S]*Math\.sqrt\(phases\)[\s\S]*label === 'deep'[\s\S]*\? 6/, 'research depth must stay ambitious per phase while keeping normal tasks moving')
  assert.match(policyEngine, /profile\.label === 'wide' \? 9 : profile\.label === 'deep' \? 7 : 4/, 'research saturation must not let deep phases shortcut after a shallow floor')
  assert.match(goalTracker, /shallow search snippets can tick off the plan/, 'goal completion must require opened source evidence for complex research phases')
  assert.match(policyEngine, /Build a real evidence packet inside this phase/, 'phase guidance must push more work inside each phase instead of adding more phases')
  assert.match(toolPipeline, /topicFamiliesFor/, 'phase semantic guard must detect future-topic family drift')
  assert.match(agentConfig, /MIN_ITERATION_DELAY_MS = 0/, 'agent loop should not add a sluggish fixed inter-iteration delay')
  assert.match(agentConfig, /PLAN_STARTUP_DELAY_MS = 0/, 'planner startup should not wait before requesting the task plan')
  assert.match(agentConfig, /iterationTimeoutMs:\s*IS_OLLAMA \? 600_000 : 12_000/, 'normal model turns should not create minute-scale frozen UI gaps')
  assert.match(agentConfig, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 1_500/, 'invisible model stalls should recover quickly instead of making the UI look frozen')
  assert.match(agentConfig, /checkIntervalMs:\s*150/, 'stream stall checks should poll quickly enough for live UI feedback')
  assert.match(agentConfig, /TOOL_RETRY_MAX = 0/, 'transient tool failures should fail forward instead of spending another turn on retry delay')
  assert.match(agentConfig, /TOOL_RETRY_BASE_MS = 120/, 'transient tool retries should be fast by default')
  assert.match(agentConfig, /TOOL_RETRY_MAX_DELAY_MS = 600/, 'tool retry backoff should not create long idle gaps')
  assert.match(toolRetry, /web_search:\s*\{ maxRetries: 0, baseDelayMs: 600 \}/, 'web-search retries must not hide long automatic retry stalls')
  assert.match(toolRetry, /browser_navigate:\s*\{ maxRetries: 0, baseDelayMs: 750 \}/, 'browser navigation retries must not hide long automatic retry stalls')
  assert.match(toolRetry, /read_document:\s*\{ maxRetries: 0, baseDelayMs: 500 \}/, 'document extraction retries must not hide long automatic retry stalls')
  assert.match(workingMemory, /render\(opts\?: WorkingMemoryRenderOptions\)/, 'working memory rendering must accept compact context limits')
  assert.match(workingMemory, /selectFactsForRender\(maxFacts,\s*opts\?\.stepIdx\)/, 'working memory should prioritize relevant current-step facts when compacting')
  assert.match(workingMemory, /getSummary\(\): string/, 'working memory must expose a compact summary for context injection')
  assert.match(policyEngine, /workingMemory\?\.render\(\{ stepIdx: state\.currentStepIdx, maxFacts: 8, maxChars: 1200 \}\)/, 'policy step guidance should use bounded working memory context')
  assert.match(contextManager, /workingMemory\?\.render\(\{ maxFacts: 8, maxChars: 1200 \}\)/, 'context summaries should use bounded working memory context')
  assert.match(contextManager, /assistant narration compacted|stale assistant narration compacted/, 'stale assistant prose should be compacted after tool evidence is captured')
  assert.doesNotMatch(eventDispatcher, /Done - I completed the task and prepared the deliverable/, 'completed task messages must not force a canned completion sentence')
  assert.doesNotMatch(eventDispatcher, /\*\*Deliverables\*\*[\s\S]*Below you can find:/, 'completed task messages must not force deliverables headings when artifact cards already exist')
  assert.match(eventDispatcher, /a short natural fallback only when the model did not provide/, 'client completion fallback must be natural and only used when needed')
  assert.match(policyEngine, /Write a natural final response/, 'backend final prompts must request a natural final response')
  assert.match(planManager, /Write a natural final response/, 'plan completion prompts must request a natural final response')
  assert.match(policyEngine, /Do not mention how many searches, browses, checks, tool calls, sources, steps, or phases you completed/, 'backend final prompts must not report process metrics in final answers')
  assert.match(planManager, /Do not mention how many searches, browses, checks, tool calls, sources, steps, or phases you completed/, 'plan completion prompts must not report process metrics in final answers')
  assert.match(taskMessageContent, /isProcessMetricCompletionLine/, 'final message display must suppress stale process-metric completion lines')
  assert.match(taskMessageContent, /grounded\\s\+it\\s\+with/, 'final message display must catch grounded-with-search-count lines')
  assert.match(await readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'), /Browser action step\. PRIORITY/, 'browse steps must not inherit research-step instructions')
  assert.match(browserView, /isBlockedBrowserAction\(error, action\)[\s\S]*return null/, 'browser panel must hide preflight block banners from the user')
  assert.match(browserView, /Browser state refreshed/, 'browser panel should show a neutral refreshed-state status for preflight blocks')
  assert.match(streamConstants, /Blocked browser_/, 'shared stream constants must classify blocked browser actions by action label as well as raw error text')
  assert.match(browserView, /hasPageError = !hasCurrentLiveEvidence && result\.success === false && isPageLevelBrowserError/, 'browser panel must not show stale page errors over live browser frames')
  assert.match(browserView, /The browser action could not complete\./, 'browser panel must hide raw automation errors')
  assert.match(browserView, /This page could not be opened\./, 'browser panel should describe navigation failures without fallback-route language')
  assert.doesNotMatch(browserView, /choosing another route/, 'browser panel must not show fallback-route narration')
  assert.doesNotMatch(eventDispatcher, /liveFrame:\s*!!screenshotBase64/, 'static browser result screenshots must not be mislabeled as live frames')
  assert.match(eventDispatcher, /success:\s*true,[\s\S]*recoverable:\s*undefined,[\s\S]*error:\s*undefined,[\s\S]*screenshotBase64:\s*frame/, 'fresh browser frames must clear stale navigation errors from the live browser panel')
  assert.match(eventDispatcher, /isBrowserPreflightBlockResult/, 'client dispatcher must classify browser preflight blocks before opening the computer panel')
  assert.match(eventDispatcher, /if \(!isBrowserPreflightBlock\)[\s\S]*setComputerPanelOpen\(true,\s*\{\s*source:\s*'auto'\s*\}\)/, 'browser preflight blocks must not force-open the computer panel')
  assert.match(policyEngine, /After enough completed visible action pills/, 'narration cadence must be based on visible user-facing action progress')
  assert.match(policyEngine, /const threshold = NARRATION_THRESHOLD_DEFAULT/, 'narration cadence must use the central visible-action threshold')
  assert.match(agentConfig, /NARRATION_THRESHOLD_DEFAULT\s*=\s*3/, 'default narration threshold must open the 3-4 action narration window')
  assert.match(agentConfig, /NARRATION_THRESHOLD_BROWSER\s*=\s*3/, 'browser-heavy tasks must enter the 3-4 narration window after 3 visible actions')
  assert.match(agentConfig, /NARRATION_MAX_VISIBLE_ACTION_GAP\s*=\s*4/, 'accepted late narration must preserve overflow from the 3-4 action window')
  assert.match(policyEngine, /NARRATION CADENCE RECOVERY/, 'backend cadence should recover missing narration with explicit progress copy')
  assert.match(policyEngine, /18-30 words preferred/, 'forced narration repair must keep updates in the desired short range')
  assert.match(policyEngine, /Default to one strong past-tense result sentence; add a short Next\/Will sentence only when it is specific and useful/, 'forced narration repair must not force every update to include a next sentence')
  assert.match(policyEngine, /hard cap 34 words/, 'forced narration repair must keep progress paragraphs concise')
  assert.match(policyEngine, /result-first Manus-style paragraph/, 'forced narration repair must request result-first finding narration')
  assert.match(policyEngine, /Vary the opening verb and sentence shape/, 'forced narration repair must discourage repetitive starters')
  assert.match(policyEngine, /forcedNarrationBeforeToolAction/, 'overdue narration must block tool-call turns until a progress paragraph is written')
  assert.match(policyEngine, /!isLastStep && state\.browserTaskCompleted[\s\S]*?advanceStep\(state,\s*finding\)/, 'browser completion evidence must advance before no-tool browser blocking')
  assert.match(policyEngine, /state\.visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT[\s\S]*?isValidProgressNarration/, 'valid narration at the cadence point must be accepted without being treated as no-tool laziness')
  assert.match(policyEngine, /if \(!stepAdvancedThisIteration\) return \[\]/, 'valid narration plus next_step must continue into step advancement instead of being swallowed')
  assert.match(policyEngine, /PHASE-END NARRATION REQUIRED/, 'legacy pending phase-end narration recovery should remain readable for old in-flight state')
  assert.match(agentState, /phaseEndNarrationPending/, 'state must remember when a forced narration turn is specifically a phase-end transition')
  assert.match(policyEngine, /function shouldRequestPhaseEndNarration\(state: AgentStateData, assistantContent = ''\)[\s\S]*?needsPhaseNarrationBeforeAdvance/, 'phase transitions must require an accepted LLM narration before advancing')
  assert.match(agentLoop, /function shouldPauseForPhaseEndNarrationBeforeAutoAdvance/, 'agent auto-advance paths must share a phase-end narration gate')
  assert.match(agentLoop, /pauseForPhaseEndNarrationBeforeAutoAdvance\([\s\S]*?state\.phaseEndNarrationPending = true[\s\S]*?state\.forceTextNextIteration = true/, 'phase-end auto-advance must force a compact LLM narration turn when the phase has not narrated')
  assert.match(agentLoop, /goalCheck\.allMet[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'goal-complete auto-advance should keep the required phase narration gate in the path')
  assert.match(agentLoop, /nonNoteFileCreated[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'file-created auto-advance should keep the required phase narration gate in the path')
  assert.match(agentLoop, /shouldAutoAdvanceBriefInlineResearchAfterTools[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'quick research auto-advance should keep the required phase narration gate in the path')
  assert.match(agentLoop, /compactResearchEvidenceComplete\(state\)[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance\([\s\S]*?The compact research phase has enough evidence[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'compact research evidence completion must pause for visible narration before advancing')
  assert.match(agentLoop, /PHASE-END NARRATION RETRY:[\s\S]*?Do not call tools and do not advance silently/, 'phase-end narration model-start timeouts must retry narration instead of silently releasing to tool work')
  assert.doesNotMatch(agentLoop, /if \(state\.phaseEndNarrationPending\) \{\s*markPhaseNarrationEmitted\(state\)/, 'phase-end narration timeouts must not fake an emitted narration')
  assert.match(policyEngine, /state\.phaseEndNarrationPending[\s\S]*?!stepAdvancedThisIteration[\s\S]*?advanceStep\(state,\s*narrationFinding\)/, 'valid phase-end narration must advance even when the model forgets the next_step marker')
  assert.match(policyEngine, /const narrationFinding = sanitizeNarrationText[\s\S]*if \(!narrationFinding\) \{[\s\S]*rewriteInvalidForcedNarrationAction/, 'invalid phase-end text must be rewritten instead of advancing invisibly')
  assert.match(agentLoop, /FAST PROGRESS NARRATION ONLY/, 'cadence narration must use the compact narration-only lane so it appears quickly after tool actions')
  assert.match(agentLoop, /This applies to the current phase regardless of task type/, 'cadence state must explicitly apply to all phases and task types')
  assert.match(agentLoop, /Write one natural Manus-style progress paragraph from the compact context only/, 'cadence state must make model-authored narration the first visible text')
  assert.match(agentLoop, /visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT/, 'cadence prompt overhead should start inside the allowed 3-4 action window')
  assert.match(toolPipeline, /visibleActionsBeforeTool >= NARRATION_THRESHOLD_DEFAULT[\s\S]*3 visible actions have completed without a valid progress narration/, 'visible action cadence must hard-gate tools at 3 actions, not wait for a fourth action')
  assert.doesNotMatch(agentLoop, /Then continue naturally in the same response:[\s\S]*call exactly one useful next tool[\s\S]*emit <next_step\/>/, 'ordinary cadence must not wait on same-turn tool selection before showing narration')
  assert.match(agentLoop, /compactForcedNarrationMessages/, 'forced narration turns must use a compact status-only prompt instead of the full task context')
  assert.match(agentLoop, /useCompactForcedNarration[\s\S]*\?\s*compactForcedNarrationMessages\(state, allMessages\)/, 'forced narration helper must be used as the actual model-call message set')
  assert.match(agentState, /function isSynthesisStepText[\s\S]*SYNTHESIS_STEP_PATTERN[\s\S]*!SOURCE_GATHERING_STEP_PATTERN/, 'synthesis-only plan steps must be distinguishable from research/source-gathering steps')
  assert.match(agentState, /isLastStep \|\| isSynthesisStepText\(stepText\)[\s\S]*state\.currentPhase = 'deliver'/, 'non-final synthesis/write steps must switch to deliver phase instead of compact research')
  assert.match(agentLoop, /shouldUseCompactResearchTurn[\s\S]*isSynthesisStepText\(currentStepText\(state\)\)[\s\S]*return false/, 'compact research turns must not run on synthesis-only steps')
  assert.match(agentLoop, /compactResearchTurnMessages[\s\S]*COMPACT RESEARCH TURN[\s\S]*shouldUseCompactResearchTurn[\s\S]*return true[\s\S]*useCompactResearchTurn/, 'non-final research turns should use compact task state instead of replaying raw tool history')
  assert.match(agentLoop, /compactResearchNeedsToolAction[\s\S]*!compactResearchEvidenceComplete\(state\)[\s\S]*compactResearchNeedsTool[\s\S]*shouldRequireToolCall/, 'compact research turns must keep using tools until the fast evidence floor is met')
  assert.match(agentLoop, /compactResearchPhaseCanAdvance[\s\S]*compactResearchEvidenceComplete\(state\)[\s\S]*PHASE EVIDENCE READY[\s\S]*Do not output only <next_step\/>/, 'compact research must close a phase with visible narration once the evidence floor is met instead of offering extra research tools')
  assert.match(agentLoop, /\(lastToolResults\.length === 0 \|\| state\.stepResearchCallCount === 0\)[\s\S]*compactResearchNeedsToolAction\(state\)/, 'compact research recovery must ignore stale prior-phase tool results when the current phase has zero research calls')
  assert.match(agentLoop, /needsOpenedSourceRoute[\s\S]*compactResearchNeedsOpenedSource\(state\)[\s\S]*state\.suppressedResearchToolName === 'read_document'[\s\S]*allowed\.delete\('browser_navigate'\)/, 'compact research recovery must keep browser navigation available when the next required move is opening a source')
  assert.match(agentState, /suppressedResearchToolName: string \| null/, 'agent state must track a temporarily suppressed research tool after loop detection')
  assert.match(agentState, /rawTool/, 'loop detection must expose the canonical internal tool name separately from the display label')
  assert.doesNotMatch(policyEngine, /sameTargetSourceReadLoop[\s\S]*state\.suppressedResearchToolName = sameTargetSourceReadLoop/, 'same-source read loops must not bypass research tool suppression and keep rereading the same source')
  assert.match(policyEngine, /state\.suppressedResearchToolName = loopCheck\.rawTool \|\| loopCheck\.tool/, 'research loop detection must suppress the canonical internal tool name, including same-source read_document loops')
  assert.match(agentLoop, /state\.suppressedResearchToolName[\s\S]*!compactResearchEvidenceComplete\(state\)[\s\S]*activeTools = loopRecoveryToolForState\(state,\s*filtered\)/, 'compact research recovery must remove the repeated tool and keep the model on a different evidence route while the evidence floor is still incomplete')
  assert.match(agentLoop, /compactResearchOpenedSourceToolsForState[\s\S]*state\.suppressedResearchToolName === 'read_document'[\s\S]*new Set\(COMPACT_RESEARCH_SOURCE_RUNTIME_TOOLS\)[\s\S]*allowed\.delete\(state\.suppressedResearchToolName\)/, 'opened-source narrowing must widen to alternate source routes when read_document is the looped tool')
  assert.match(agentLoop, /SOURCE_LOOP_WEB_SEARCH_ESCAPE_THRESHOLD\s*=\s*6/, 'source-opening loops must have a bounded escape threshold instead of alternating forever')
  assert.match(agentLoop, /state\.stepLoopDetections >= SOURCE_LOOP_WEB_SEARCH_ESCAPE_THRESHOLD[\s\S]*allowed\.clear\(\)[\s\S]*allowed\.add\('web_search'\)/, 'deep source-opening loops must force a materially different search route')
  assert.match(agentLoop, /state\.stepLoopDetections >= SOURCE_LOOP_WEB_SEARCH_ESCAPE_THRESHOLD[\s\S]*searchOnly = tools\.filter/, 'loop recovery must stop offering alternate open/read routes after repeated source cycling')
  assert.match(agentLoop, /SOURCE OPENING RECOVERY:[\s\S]*read_document is temporarily suppressed[\s\S]*Do not call web_search again while known result URLs are still unopened/, 'opened-source recovery must avoid search loops while known result URLs are still unopened')
  assert.match(toolPipeline, /state\.visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT[\s\S]*state\.forceTextNextIteration = true/, 'auto-extracted source clusters must arm the next compact narration turn once they cross the visible-action cadence window')
  assert.match(toolPipeline, /synthesisPhaseResearchReason[\s\S]*state\.stepFailureCount\+\+[\s\S]*state\.lastLoopSignal = \{ type: 'tool_rate_limit'/, 'synthesis-step research blocks must count as real failures instead of resetting compact research forever')
  assert.match(toolPipeline, /isFinalDeliverableStep[\s\S]*!DELIVERABLE_STEP_TOOLS\.has[\s\S]*trackToolCall\(state, tc\.name, JSON\.stringify\(args\)\)[\s\S]*state\.stepFailureCount\+\+/, 'final-step blocked external tools must enter loop history and failure accounting')
  assert.match(toolPipeline, /failure\.tool === toolName[\s\S]*state\.stepLoopDetections >= 2[\s\S]*Do not alternate source-opening tools on the same URL/, 'same-source failures must not alternate between read and browser-open routes indefinitely')
  assert.match(toolPipeline, /const usefulResearchProgress =[\s\S]*usableBrowserEvidence[\s\S]*if \(usefulResearchProgress\)[\s\S]*state\.stepResearchCallCount\+\+[\s\S]*usefulResearchProgress[\s\S]*state\.suppressedResearchToolName/, 'loop suppression must clear only after useful evidence, not a bare source-open attempt')
  assert.match(toolPipeline, /tc\.name !== state\.suppressedResearchToolName[\s\S]*RESEARCH_TOOLS\.has\(tc\.name\)[\s\S]*state\.suppressedResearchToolName = null/, 'successful different research tools must clear temporary loop suppression')
  assert.match(agentLoop, /NO_THINKING_REASONING = \{ enabled: false as const, exclude: true \}/, 'forced narration turns must disable thinking entirely')
  assert.match(agentLoop, /MINIMAL_THINKING_REASONING = \{ effort: 'minimal' as const, exclude: true \}/, 'non-narration agent turns must stay on minimal thinking')
  assert.match(agentLoop, /shouldIncludeTemporalContextForTurn/, 'agent turns should gate temporal context by task type and temporal wording')
  assert.match(agentLoop, /if \(state\.forceTextNextIteration\) return false/, 'forced narration-only turns should not pay for temporal context')
  assert.match(agentLoop, /includeTemporalContext:\s*shouldIncludeTemporalContextForTurn\(state\)/, 'streaming model calls should not include temporal context by default')
  assert.doesNotMatch(agentLoop, /if \(state\.forceTextNextIteration\) return 96/, 'forced narration turns must not truncate status or direct-answer recovery with a tiny output cap')
  assert.match(agentLoop, /function shouldUseNaturalCadenceNarration[\s\S]*visibleToolActionsSinceLastNarration < NARRATION_THRESHOLD_DEFAULT[\s\S]*finalSavedDeliverableTurn[\s\S]*return true/, '3-action cadence narration should open immediately after the visible action window')
  assert.match(agentLoop, /const useCompactCadenceNarration = !useCompactForcedNarration[\s\S]*shouldUseNaturalCadenceNarration/, 'ordinary cadence narration must enter the compact narration lane')
  assert.match(agentLoop, /const useCompactNarration = useCompactForcedNarration \|\| useCompactCadenceNarration/, 'ordinary cadence narration must use compact output caps and no tools')
  assert.match(agentLoop, /FORCED_NARRATION_REQUEST_TIMEOUT_MS = 2_000[\s\S]*FORCED_NARRATION_MAX_TOKENS = 48/, 'tiny progress narration turns must stay compact inside the 2s no-thinking window')
  assert.match(agentLoop, /processedCompactNarrationTurn[\s\S]*lastStreamResult\.toolCalls\.size === 0[\s\S]*lastStreamResult\.assistantContent\.trim\(\)[\s\S]*sanitizeNarrationText\(lastStreamResult\.assistantContent[\s\S]*visibleToolActionsSinceLastNarration = 0/, 'accepted compact narration turns must be sanitized before resetting cadence so invisible future-only text cannot pass')
  assert.doesNotMatch(agentLoop, /firstReadableSearchResultUrl|source_read_document[\s\S]*IMMEDIATE SOURCE SEARCH COMPLETE/, 'research source gathering must not be driven by local immediate-search shortcuts')
  assert.match(agentLoop, /MODEL START RECOVERY[\s\S]*Switching to compact progress recovery after empty stream/, 'a timed-out full model start must switch to compact narration recovery instead of retrying the same heavy turn')
  assert.match(agentLoop, /Compact research evidence complete; advanced immediately after text-only turn[\s\S]*Compact research no-tool response reissued model-selected tool requirement/, 'compact research prose loops must auto-advance or require a model-selected tool without local source actions')
  assert.match(agentLoop, /function compactResearchStalledSearchPacketComplete[\s\S]*state\.consecutiveNoToolCalls < 3[\s\S]*state\.stepSourceDomainCounts\.size[\s\S]*calls >= usefulCalls/, 'compact research must stop burning recovery turns once repeated prose follows a useful search-result packet')
  assert.match(agentLoop, /function compactResearchEvidenceComplete[\s\S]*compactResearchStalledSearchPacketComplete\(state, depth\)/, 'compact research completion must accept a stalled-but-useful search-result packet before demanding more opened pages')
  assert.match(agentLoop, /lastToolResults\.length === 0[\s\S]*Empty compact research tool turn reissued model-selected tool requirement/, 'empty or malformed compact research tool turns must require a model-selected tool')
  assert.match(agentLoop, /Model-start timeout advanced compact research phase from gathered evidence[\s\S]*Model-start timeout reissued model-selected research tool requirement/, 'compact research model-start timeouts must reissue model-selected tool requirements without deterministic source actions')
  assert.doesNotMatch(agentLoop, /Agent lost connection while starting the next action/, 'model-start timeouts must not surface the old lost-connection error')
  assert.match(agentLoop, /max_tokens:\s*maxTokens/, 'streaming model calls should pass the computed per-turn output cap')
  assert.match(agentLoop, /isFinalInlineAnswerTurn[\s\S]*?FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS/, 'final inline chat answers should use a shorter request timeout than tool/research turns')
  assert.match(agentState, /exactExtractionGuardPending/, 'state must track when exact extraction must happen before narration')
  assert.match(agentLoop, /EXACT EXTRACTION REQUIRED BEFORE NARRATION/, 'exact wording/date extraction risk must be handled before progress narration')
  assert.match(agentLoop, /function shouldUseNaturalCadenceNarration[\s\S]*state\.exactExtractionGuardPending\) return false/, 'exact extraction guard must be evaluated before compact cadence narration')
  assert.match(agentLoop, /EXACT_EXTRACTION_TOOLS[\s\S]*?browser_find_text[\s\S]*?browser_screenshot[\s\S]*?browser_get_content/, 'exact extraction guard must restrict the model to visual/text extraction tools')
  assert.match(agentLoop, /state\.exactExtractionGuardPending[\s\S]*const requiredToolIntent = shouldRequireToolCall && !narrationWindowOpen/, 'exact extraction guard must keep a concrete extraction tool intent')
  assert.match(agentLoop, /visibleToolActionsSinceLastNarration\s*=\s*0/, 'arming exact extraction must suppress the narration window for the next turn')
  assert.match(agentLoop, /tool_choice:\s*'required'/, 'provider-forced tool choice should remain available only when the active provider supports it')
  assert.match(agentLoop, /isLeanFinalSynthesisStep/, 'final research synthesis must use a lean deliverable-only tool set')
  assert.match(agentLoop, /allowedFinalTools/, 'lean final synthesis should reduce tool schema overhead without reducing deliverable quality')
  assert.match(agentLoop, /shouldAutosaveTextOnlyDraft\(\s*state:\s*AgentStateData,\s*content:\s*string,\s*messages:/, 'text-only autosave decisions must have access to the user task intent')
  assert.match(agentLoop, /const FINAL_AUTOSAVE_DRAFT_MIN_CHARS = 600/, 'final saved deliverables should save promptly once the model has produced usable content')
  assert.match(agentLoop, /if \(isLastStep\) \{[\s\S]*?text\.length >= FINAL_AUTOSAVE_DRAFT_MIN_CHARS && taskNeedsSavedFinalArtifact\(state, messages\)[\s\S]*?\}/, 'inline chat final answers must not be autosaved as deliverable files')
  assert.match(agentLoop, /FINAL INLINE ANSWER NOW/, 'final chat-answer turns must receive direct-answer guidance before no-tool repair loops')
  assert.match(agentLoop, /compactFinalInlineAnswerMessages/, 'final chat-answer turns must use compact answer-only context instead of noisy full runtime history')
  assert.match(agentLoop, /FINAL INLINE ANSWER ONLY/, 'compact final chat-answer context must forbid status/planning/tool chatter')
  assert.match(agentLoop, /function shouldCompleteFinalInlineAnswerTurn/, 'final inline answer turns must have a hard completion gate outside normal policy retry loops')
  assert.match(agentLoop, /final_inline_answer_complete/, 'substantial streamed final inline answers must terminate immediately instead of looping through more thinking')
  assert.match(completionAudit, /completedInlineAnswer[\s\S]*inline_answer_complete[\s\S]*!completedInlineAnswer && requiresFinalDeliverable/, 'completion audit must not require a saved artifact after a valid inline chat answer')
  assert.match(agentLoop, /function compactResearchBreadthSaturated[\s\S]*stepOpenedSourceDomains\(state\)\.size[\s\S]*distinctDomains >= depth\.requiredSourceBreadth/, 'compact research phases must require opened/read source breadth before saturation')
  assert.match(agentLoop, /function compactResearchNeedsOpenedSource[\s\S]*uniqueSearches >= 1[\s\S]*openedPages < usefulOpenedPages/, 'compact research must force a source read after one useful search packet')
  assert.match(agentLoop, /deep\|deeper\|deepest[\s\S]*return false[\s\S]*const brief = /, 'deep research with a concise final answer must not use the shallow brief-inline shortcut')
  assert.match(policyEngine, /deep\|deeper\|deepest[\s\S]*return false[\s\S]*const brief = /, 'policy brief-inline detection must not downgrade deep research because the final answer should be concise')
  assert.match(agentLoop, /SOURCE OPENING REQUIRED[\s\S]*Do not call web_search again[\s\S]*up to 4 parallel read_document\/http_request\/youtube_transcript calls/, 'source-saturated compact research turns must tell the model to extract existing source URLs instead of searching or browsing again')
  assert.match(agentLoop, /function hasRenderedBrowserContext[\s\S]*lastBrowserStateHash[\s\S]*signature !== '\|\|0'/, 'extracted/read source URLs must not count as an open rendered browser page')
  assert.match(agentLoop, /compactResearchOpenedSourceToolsForState[\s\S]*new Set\(SOURCE_OPENING_RUNTIME_TOOLS\)[\s\S]*!hasRenderedBrowserContext\(state\)[\s\S]*allowed\.delete\('browser_get_content'\)/, 'source-saturated compact research turns must prefer extraction tools and only expose browser content after a real browser page exists')
  assert.doesNotMatch(agentLoop, /function researchStepAllowsSourceSweep/, 'research phases should not use the broad source_sweep path')
  assert.doesNotMatch(tools, /source_sweep/, 'source_sweep must not be exposed in the model-visible tool schema')
  assert.doesNotMatch(toolRegistry, /source_sweep/, 'source_sweep must not have a registered executor')
  assert.doesNotMatch(agentToolRegistry, /source_sweep/, 'source_sweep must not appear in dynamic tool capability discovery')
  assert.doesNotMatch(toolPipeline, /source_sweep/, 'source_sweep must not have live progress or tracking branches')
  assert.match(policyEngine, /function hasBreadthSaturatedResearchEvidence[\s\S]*stepOpenedSourceDomains\(state\)\.size[\s\S]*distinctDomains >= profile\.requiredSourceBreadth/, 'policy recovery must also require opened/read source breadth')
  assert.match(policyEngine, /function hasLoopLimitedResearchEvidence[\s\S]*depth\.complete[\s\S]*state\.stepLoopDetections >= 2 && \([\s\S]*hasStalledResearchEvidence\(state\)[\s\S]*hasFailureLimitedResearchEvidence\(state,\s*depth\)/, 'deep research loop recovery must not advance until the phase is complete or substantially saturated after repeated loop detection')
  assert.doesNotMatch(agentConfig, /source_sweep:\s*2/, 'source_sweep should not have an active per-phase budget because it is no longer in the research menu')
  assert.match(agentLoop, /const FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS = 2_000/, 'final inline answers must not get a long silent startup window')
  assert.match(agentLoop, /const FINAL_SAVED_DELIVERABLE_MAX_TOKENS = 1_600/, 'saved final deliverables must use bounded section chunks with enough room to avoid clipped reports')
  assert.match(agentLoop, /const requestTimeoutMs = useCompactNarration[\s\S]*FORCED_NARRATION_REQUEST_TIMEOUT_MS[\s\S]*isFinalInlineAnswerTurn[\s\S]*FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS[\s\S]*isFinalSavedDeliverableTurn[\s\S]*FINAL_SAVED_DELIVERABLE_REQUEST_TIMEOUT_MS[\s\S]*state\.deadlineFinalizationStarted/, 'final-answer timeouts must stay short even when deadline finalization is active')
  assert.match(agentLoop, /function finalSavedDeliverableTurn/, 'saved final deliverables must have a dedicated fast path')
  assert.match(agentLoop, /compactFinalDeliverableMessages/, 'saved final deliverables must use compact context instead of replaying noisy runtime history')
  assert.match(agentLoop, /FINAL SAVED DELIVERABLE TOOL CALL ONLY/, 'saved final deliverables must push the model into an immediate file tool call')
  assert.match(agentLoop, /PARTIAL FILE CONTINUATION TOOL CALL ONLY[\s\S]*append_file[\s\S]*Do not call create_file/, 'partial final deliverables must force append-only continuation instead of restarting')
  assert.match(agentLoop, /useCompactFinalDeliverable[\s\S]*compactFinalDeliverableMessages\(state, allMessages\)/, 'final saved deliverable path must be wired into the actual model-call messages')
  assert.match(agentLoop, /function hasSavedFinalDeliverableCandidate[\s\S]*purpose === 'deliverable'/, 'support files must not count as completed final deliverables')
  assert.doesNotMatch(agentLoop, /skipReportVerifier/, 'saved report deliverables must not bypass output verification')
  assert.match(agentLoop, /recoverTextOnlyDraft[\s\S]*outputVerifier: OutputVerifier[\s\S]*shouldContinueSavedFinalDeliverableChunk[\s\S]*const verification = outputVerifier\.verify\(\s*content,\s*path/, 'text-only saved reports must continue and verify before completing')
  assert.match(agentLoop, /const requestedSavedReport = taskDefaultsToMarkdownDeliverable\(originalRequest\)[\s\S]*return requestedSavedReport \? 2_200 : 1_400/, 'brief saved reports need a larger minimum than brief inline answers')
  assert.match(agentLoop, /partialFileContinuationNeedsTool[\s\S]*activeTools = activeTools\.filter\(tool => tool\.function\?\.name === 'append_file'\)/, 'partial file recovery must narrow the model to append_file only')
  assert.match(toolPipeline, /function repairRequiredFileContinuationArgs[\s\S]*pendingPartial[\s\S]*args\.path = pendingPartial\.path/, 'partial file recovery must repair missing or wrong append_file paths instead of burning turns')
  assert.match(policyEngine, /partialFileWriteRecoveryPending[\s\S]*loopCheck\.rawTool === 'append_file'[\s\S]*return null/, 'generic loop recovery must not fight required append_file continuation chunks')
  assert.match(agentLoop, /finalSavedDeliverableNeedsTool[\s\S]*partialFileContinuationNeedsTool[\s\S]*!hasSavedFinalDeliverableCandidate\(state\)[\s\S]*requiredToolIntent/, 'saved final deliverables and partial continuation actions must keep a file-tool intent until a final file exists')
  assert.doesNotMatch(agentLoop, /finalSavedDeliverableNeedsTool[\s\S]{0,240}state\.stepToolCallCount === 0[\s\S]{0,240}!hasSavedFinalDeliverableCandidate\(state\)/, 'saved final deliverable retries must not stop forcing the file tool after the first failed attempt')
  assert.match(agentLoop, /FINAL_SAVED_DELIVERABLE_REQUEST_TIMEOUT_MS = 4_500/, 'saved final deliverables must have a bounded startup window that still tolerates provider variance')
  assert.match(agentLoop, /FINAL_SAVED_DELIVERABLE_ITERATION_TIMEOUT_MS = 6_500/, 'saved final deliverables must fail forward quickly while giving file-tool arguments room to finish clean chunks')
  assert.doesNotMatch(agentLoop, /FINAL_SAVED_DELIVERABLE_NONSTREAM_REQUEST_TIMEOUT_MS|Final saved deliverable stream start timed out; using compact final-write completion/, 'saved final deliverables must not spend an extra non-stream fallback wait before the next native tool attempt')
  assert.match(streamProcessor, /FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 14_000[\s\S]*isStreamingToolArgs[\s\S]*effectiveIterationMs[\s\S]*FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS/, 'file tool arguments must get a protected post-start window so reports do not break mid-write')
  assert.match(agentLoop, /End cleanly at a sentence or section boundary/, 'saved report chunks must be instructed to stop at clean section boundaries')
  assert.match(agentLoop, /FINAL SAVED DELIVERABLE TOOL CALL ONLY[\s\S]*Write the complete deliverable when it fits/, 'saved final deliverables must push a complete first file write')
  assert.match(agentLoop, /function existingFinalDeliverablePath[\s\S]*pendingFinalDeliverableRevisionPath\(state\) \|\| latestSavedFinalDeliverablePath\(state\)/, 'final deliverable revisions must target the already-saved file path')
  assert.match(agentLoop, /FINAL SAVED DELIVERABLE REVISION TOOL CALL ONLY[\s\S]*Do not call create_file/, 'existing saved deliverables must not offer create_file in compact revision prompts')
  assert.match(agentLoop, /const finalSavedDeliverableRevisionNeedsTool[\s\S]*existingFinalDeliverablePath\(state\)[\s\S]*!state\.deliverableVerificationDone[\s\S]*finalSavedDeliverableNeedsTool/, 'verification failures on existing saved deliverables must still force a file-tool turn')
  assert.match(agentLoop, /const allowedRevisionTools = finalDeliverableRevisionToolNames\(state, this\.options\.messages\)[\s\S]*Narrowed tools for final saved deliverable revision/, 'final saved deliverable revisions must narrow tools before the model can choose create_file again')
  assert.match(agentLoop, /const allowedFinalTools = existingFinalPath[\s\S]*finalDeliverableRevisionToolNames\(state, this\.options\.messages\)[\s\S]*'create_file'/, 'existing final deliverables must remove create_file from the active final-step tool set')
  assert.match(agentLoop, /function finalSavedDeliverableToolCallInstruction[\s\S]*Make exactly one native file tool call now/, 'saved final deliverable recovery must stay in the file-tool lane')
  assert.match(agentLoop, /recoveringFinalSavedDeliverable[\s\S]*state\.forceTextNextIteration = !recoveringFinalSavedDeliverable && state\.taskStrategy !== 'browse'/, 'final saved deliverable tool repair must not accidentally enter narration-only mode')
  assert.match(agentLoop, /Reissued final saved deliverable file-tool instruction after model-start timeout/, 'final saved deliverables must not route model-start timeouts through generic progress narration')
  assert.match(agentLoop, /FINAL SAVED DELIVERABLE TIME CHECK[\s\S]*final output turn stalled before saving the deliverable/, 'mid-stream final saved deliverable stalls must reissue a file-tool instruction')
  assert.match(agentLoop, /activeTools = activeTools\.filter\(tool => tool\.function\?\.name === 'create_file'\)[\s\S]*Narrowed tools for initial final saved deliverable/, 'initial final saved deliverables must expose only create_file when no final file exists yet')
  assert.match(agentLoop, /toolCallsNeedStartupReady\(lastStreamResult\.toolCalls\)/, 'source actions must not wait for sandbox startup when they do not need it')
  assert.match(toolPipeline, /state\.partialFileWriteRecoveryPending[\s\S]*FILE_WRITE_TOOLS\.has\(toolName\)[\s\S]*toolName === 'append_file' && requestedPath === pending\.path[\s\S]*INTERNAL_RECOVERY/, 'partial file recovery preflight must block recreate/wrong-path writes before visible tool_start')
  assert.match(tools, /Create a workspace file\. Put path before content; write the largest complete useful version that fits/, 'create_file schema must bias providers toward complete path-first visible file writes')
  assert.match(agentLoop, /Math\.min\(0\.35,\s*state\.strategyConfig\?\.temperature \?\? strategy\.temperature\)/, 'final chat-answer turns should use a calmer temperature to avoid status chatter')
  assert.match(agentLoop, /const requestReasoning = useCompactNarration[\s\S]*NO_THINKING_REASONING[\s\S]*isFinalInlineAnswerTurn[\s\S]*MINIMAL_THINKING_REASONING/, 'narration must use no-thinking while final chat-answer turns use minimal thinking')
  assert.match(agentLoop, /FINAL_OPTIONAL_RUNTIME_TOOLS/, 'final steps should not pay for optional image/browser/PDF/delete schemas unless relevant')
  assert.match(agentLoop, /finalStepAllowsOptionalTool/, 'final optional tools must be restored when task intent or QA state requires them')
  assert.match(agentLoop, /const finalWantsPdf = taskWantsPdfArtifact/, 'lean final synthesis should expose export_pdf only when PDF/export is requested')
  assert.match(agentLoop, /\.\.\.\(finalWantsPdf \? \['export_pdf'\] : \[\]\)/, 'export_pdf should be conditional in lean final synthesis')
  assert.doesNotMatch(agentLoop, /state\.visibleToolActionsSinceLastNarration >= 3[\s\S]{0,120}state\.forceTextNextIteration = true/, 'the loop must not use the old forced-narration repair flag for ordinary cadence turns')
  assert.match(toolPipeline, /validSameTurnNarration/, 'visible tool preflight must recognize same-turn narration')
  assert.match(toolPipeline, /The 3-action window is a hard gate/, 'visible tool preflight must hard-gate the fourth visible action until narration is accepted')
  assert.match(toolPipeline, /this visible tool call was skipped because 3 visible actions/, 'visible tool preflight must block the fourth visible action when narration is overdue')
  assert.match(toolPipeline, /function isRequiredSavedDeliverableWrite[\s\S]*pendingDeliverableRevision[\s\S]*partialFileWriteRecoveryPending[\s\S]*isRequiredSavedDeliverableWrite\(tc\.name,\s*args,\s*state\)/, 'required final report repair writes must bypass narration cadence instead of stalling after verification failure')
  assert.match(agentLoop, /else if \(useCompactNarration\) \{\s*activeTools = \[\]\s*\}/, 'compact narration turns must not offer tools to the model')
  assert.match(toolPipeline, /visibleActionsBeforeTool/, 'visible tool preflight must distinguish the already-rendered current tool from prior actions')
  assert.match(toolPipeline, /directNavigationBeforeSearchTarget[\s\S]*?return this\.executeSingle\(reroutedToolCall, state\)[\s\S]*?this\.emitter\.toolStart/, 'explicit URL search reroutes must happen before any misleading visible search pill is emitted')
  assert.match(eventDispatcher, /Never insert it between completed/, 'client must attach late narration recovery at the current frontier instead of inserting it between completed tools')
  assert.match(eventDispatcher, /discardNarrationBuffer/, 'client must drop early narration buffers instead of carrying them into later tool gaps')
  assert.match(streamProcessor, /recordVisibleToolStartForNarration/, 'provisional visible tool starts must count toward backend narration cadence')
  assert.match(streamProcessor, /strictActionLabelFromArgs\(args\)/, 'provisional visible tool starts must use a strict action label once available')
  assert.match(streamProcessor, /splitCleanVisibleAssistantText/, 'streamed user-visible text must be scrubbed before text_delta emission')
  assert.match(streamProcessor, /DISPLAY_FUTURE_ACTION_SENTENCE_RE/, 'streamed user-visible text must strip Let-me future action narration')
  assert.match(streamProcessor, /visibleTextBuffer/, 'streamed user-visible text must buffer partial future-action sentences across chunks')
  assert.match(streamProcessor, /DISPLAY_FUTURE_ACTION_TAIL_RE/, 'streamed user-visible text must hold incomplete future-action tails before emission')
  assert.match(streamProcessor, /DISPLAY_INTERNAL_TASK_REFLECTION_RE/, 'streamed user-visible text must strip internal task-planning reflections')
  assert.match(streamProcessor, /DISPLAY_OPERATIONAL_COMMAND_SENTENCE_RE/, 'streamed user-visible text must strip leftover imperative action fragments')
  assert.match(serverSanitization, /Plan step index\|Action label/, 'stream sanitization must strip echoed tool-planning labels')
  assert.match(toolPipeline, /visibleNarrationToolStartIds\.has\(toolCallId\)/, 'executed tool starts must not double-count provisional visible starts')
  assert.match(agentState, /visibleNarrationToolStartIds/, 'agent state must dedupe visible tool starts across provisional and execution events')
  assert.match(agentState, /Only exempt screenshots[\s\S]*tool === 'browser_screenshot'/, 'repeated browser_get_content must count as a loop because same-page rereads cause slow research stalls')
  assert.doesNotMatch(agentState, /tool === 'browser_screenshot' \|\| tool === 'browser_get_content'/, 'browser_get_content must not remain exempt from loop detection')
  assert.match(agentState, /ordered list of tool\/target signatures/, 'cross-tool cycle state must store target-aware signatures, not only tool names')
  assert.match(agentState, /call\.name === 'read_document'[\s\S]*read_document:\$\{String\(parsed\.source\)\.toLowerCase\(\)\.trim\(\)\}/, 'read_document loop detection must distinguish different source URLs')
  assert.match(toolPipeline, /function toolCycleEntry\(toolName: string, args: Record<string, unknown>\)/, 'tool cycle detection must use a target-aware signature helper')
  assert.match(toolPipeline, /toolName === 'read_document'[\s\S]*researchUrlFromToolCall\('read_document', args\)/, 'read_document cycle detection must distinguish different source URLs')
  assert.match(toolPipeline, /state\.recentToolSequence\.push\(toolCycleEntry\(tc\.name, args\)\)/, 'tool cycle detection must record tool-target signatures instead of raw tool names')
  assert.match(toolPipeline, /formatToolCycle\(cycle\)/, 'tool cycle logging/errors should display user-readable tool names from target-aware signatures')
  assert.match(toolPipeline, /INTERNAL_RECOVERY: Repeated same-target tool cycle blocked/, 'real repeated-target cycle blocks must be hidden from the user as internal recovery')
  assert.doesNotMatch(toolPipeline, /Repeated tool cycle blocked:/, 'old user-facing repeated tool cycle error must not come back')
  assert.match(policyEngine, /function hasStalledResearchEvidence/, 'research policy must distinguish stalled-but-real evidence from no evidence')
  assert.match(policyEngine, /function hasLoopLimitedResearchEvidence/, 'research policy must distinguish loop-limited evidence from open-ended research depth')
  assert.match(policyEngine, /function hasLoopLimitedResearchEvidence[\s\S]*depth\.complete[\s\S]*state\.stepLoopDetections >= 2 && \([\s\S]*hasStalledResearchEvidence\(state\)[\s\S]*hasFailureLimitedResearchEvidence\(state,\s*depth\)/, 'loop-limited research recovery must require completed depth or substantial stalled evidence after repeated loop detection before phase advancement')
  assert.doesNotMatch(policyEngine, /stepLoopDetections > 0 && hasStalledResearchEvidence\(state\)/, 'no-tool research recovery must not skip phases from stalled-but-incomplete evidence')
  assert.match(policyEngine, /Loop recovery:[\s\S]*Do not advance this phase yet/, 'internal repeated-tool recovery must redirect incomplete research instead of skipping the phase')
  assert.match(policyEngine, /function advanceStalledResearchWithGap/, 'completed research loops can still advance cleanly')
  assert.match(policyEngine, /function shouldAdvanceResearchAtBudgetBoundary/, 'research budget pressure must protect the global task budget instead of letting early phases consume it')
  assert.match(policyEngine, /This is extension \$\{state\.borrowedIterations\}\/2 before the phase must preserve budget for the rest of the plan/, 'research budget pressure must cap phase extensions before preserving budget for later phases')
  assert.match(policyEngine, /Moved on at research budget with recorded evidence gaps/, 'over-budget research with enough evidence must advance while recording the gap')
}

async function assertLedgerRuntime() {
  const workDir = await mkdtemp(join(root, 'scripts/.agent-ledger-smoke-runner-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  createInitialState,
  getWorkSummary,
  recordWorkLedgerDeliverable,
  recordWorkLedgerFailure,
  recordWorkLedgerSource,
  recordWorkLedgerVerification,
  recordWorkLedgerVisualObservation,
  isConcreteBuildStep,
  isResearchStepText,
  satisfyWorkLedgerRequirement,
  setWorkLedgerObjective,
  setWorkLedgerRequirements,
  trackBrowseResult,
  updatePhase,
} from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import {
  CREDIT_RATES,
  e2bSandboxRuntimeCreditCharge,
  roundCreditAmount,
  tokenUsageCreditCharge,
  toolCreditCharge,
} from ${JSON.stringify(join(root, 'src/lib/creditPolicy.ts'))}
import {
  cleanThinkingTags,
  cleanThinkingTokens,
  normalizeMarkdownForDisplay,
  sanitizeNarrationText,
  stripToolActionNarration,
} from ${JSON.stringify(join(root, 'src/lib/stream/cleaners.ts'))}
import {
  stripSpecialTokens,
  stripThinkingTags,
} from ${JSON.stringify(join(root, 'src/agent/guards/sanitization.ts'))}
import {
  isAtomicStep,
} from ${JSON.stringify(join(root, 'src/lib/agent/PlanManager.ts'))}
import {
  researchDepthProfileForState,
} from ${JSON.stringify(join(root, 'src/lib/agent/ResearchDepth.ts'))}
import {
  bareResearchOverviewTopic,
  explicitWebSearchLimitFromText,
  fixedWebSearchTopicFromMessages,
  isBareResearchOverviewRequest,
  isSingleWebSearchMarkdownTask,
  taskDefaultsToMarkdownDeliverable,
} from ${JSON.stringify(join(root, 'src/lib/agent/taskConstraints.ts'))}
import {
  isDynamicKnowledgeQuestion,
} from ${JSON.stringify(join(root, 'src/lib/dynamicKnowledge.ts'))}
import {
  effectiveTaskRequest,
  isContextualTaskUpdate,
} from ${JSON.stringify(join(root, 'src/lib/conversationContext.ts'))}
import {
  resolveStrategy,
} from ${JSON.stringify(join(root, 'src/lib/agent/TaskStrategy.ts'))}
import { ToolRegistry } from ${JSON.stringify(join(root, 'src/lib/agent/ToolRegistry.ts'))}
import {
  detectBrowserTaskCompletion,
} from ${JSON.stringify(join(root, 'src/lib/browserIntelligence.ts'))}
import { GoalTracker } from ${JSON.stringify(join(root, 'src/lib/agent/GoalTracker.ts'))}
import {
  buildStepMessage,
} from ${JSON.stringify(join(root, 'src/agent/guards/stepMessages.ts'))}
import {
  splitTaskMessageContent,
} from ${JSON.stringify(join(root, 'src/lib/stream/taskMessageContent.ts'))}
import {
  getPlanningPrompt,
  getSystemPrompt,
} from ${JSON.stringify(join(root, 'src/lib/prompts.ts'))}
import { PolicyEngine } from ${JSON.stringify(join(root, 'src/lib/agent/PolicyEngine.ts'))}
import { ToolCache } from ${JSON.stringify(join(root, 'src/lib/agent/ToolCache.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}

const timeouts = {
  iterationTimeoutMs: 30000,
  inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function markOpenedDomain(state, domain, count = 1) {
  state.stepSourceDomainCounts.set(domain, (state.stepSourceDomainCounts.get(domain) || 0) + count)
  state.stepOpenedSourceDomainCounts.set(domain, (state.stepOpenedSourceDomainCounts.get(domain) || 0) + count)
}

export async function runLedgerSmoke() {
  const registry = new ToolRegistry()
  for (const name of ['create_file', 'web_search', 'browser_navigate']) {
    registry.register({
      name,
      capabilities: [],
      description: name,
      riskLevel: 'low',
      sideEffects: false,
      definition: { type: 'function', function: { name } },
    })
  }
  const toolOrderState = createInitialState(false, timeouts)
  toolOrderState.currentPhase = 'research'
  toolOrderState.strategyConfig = {
    type: 'browse',
    temperature: 0,
    iterationTimeoutMs: 30000,
    narrationThreshold: 3,
    researchBudgetMultiplier: 1,
    deliverableBudgetFraction: 1,
    allowParallelTools: false,
    preferredPhaseOrder: ['build', 'deliver'],
    stepGuidance: { research: '', deliverable: '' },
    toolPriority: ['browser_navigate', 'web_search', 'create_file'],
  }
  assert.deepEqual(
    registry.getActiveDefinitions(toolOrderState).map(tool => tool.function.name),
    ['browser_navigate', 'web_search', 'create_file'],
    'active tool definitions should follow strategy toolPriority before fallback order',
  )

  const httpCache = new ToolCache({ ttlMs: 60_000 })
  const httpResult = { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: '{"rows":[1,2,3]}', durationMs: 12 }
  httpCache.set('http_request', {
    method: 'get',
    url: 'https://api.example.com/data?utm_source=ad&b=2&a=1#top',
    headers: { Accept: 'application/json' },
  }, httpResult)
  assert.equal(
    httpCache.get('http_request', {
      method: 'GET',
      url: 'https://api.example.com/data?a=1&b=2&utm_campaign=ignored',
      headers: { accept: 'application/json' },
    }),
    httpResult,
    'safe GET API requests should reuse normalized cache entries',
  )
  assert.equal(
    httpCache.get('http_request', { method: 'POST', url: 'https://api.example.com/data' }),
    undefined,
    'mutating http_request calls must not be cached',
  )
  httpCache.set('http_request', {
    method: 'GET',
    url: 'https://api.example.com/body',
    body: { invalid: true },
  }, httpResult)
  assert.equal(
    httpCache.get('http_request', {
      method: 'GET',
      url: 'https://api.example.com/body',
      body: { invalid: true },
    }),
    undefined,
    'non-string http_request bodies must not be cached',
  )
  httpCache.set('http_request', {
    method: 'GET',
    url: 'https://api.example.com/private',
    headers: { Authorization: 'Bearer secret' },
  }, httpResult)
  assert.equal(
    httpCache.get('http_request', {
      method: 'GET',
      url: 'https://api.example.com/private',
      headers: { authorization: 'Bearer secret' },
    }),
    undefined,
    'credentialed http_request calls must not be cached',
  )
  httpCache.set('http_request', {
    method: 'GET',
    url: 'https://api.example.com/missing',
  }, { status: 404, statusText: 'Not Found', headers: {}, body: '', durationMs: 5 })
  assert.equal(
    httpCache.get('http_request', {
      method: 'GET',
      url: 'https://api.example.com/missing',
    }),
    undefined,
    'failed http_request responses must not be cached',
  )
  httpCache.set('http_request', {
    method: 'GET',
    url: 'https://api.example.com/no-store',
  }, { status: 200, statusText: 'OK', headers: { 'cache-control': 'private, no-store' }, body: '{}', durationMs: 5 })
  assert.equal(
    httpCache.get('http_request', {
      method: 'GET',
      url: 'https://api.example.com/no-store',
    }),
    undefined,
    'HTTP cache-control opt-outs must prevent caching',
  )

  const splitShortAck = splitTaskMessageContent(
    "I'll do a quick 3-step\\n\\nresearch scan for the latest iPhone, then summarize the most useful buying details.\\n\\nDone - I completed the task.",
    true,
  )
  assert.equal(
    splitShortAck.acknowledgment,
    "I'll do a quick 3-step research scan for the latest iPhone, then summarize the most useful buying details.",
  )
  assert.equal(splitShortAck.finalContent, 'Done - I completed the task.')
  const splitCompleteAck = splitTaskMessageContent(
    "I'll research ChatGPT.\\n\\nChatGPT in 2026 has a different product lineup and a broader enterprise footprint.",
    true,
  )
  assert.equal(splitCompleteAck.acknowledgment, "I'll research ChatGPT.")
  assert.equal(
    splitCompleteAck.finalContent,
    'ChatGPT in 2026 has a different product lineup and a broader enterprise footprint.',
  )
  const splitFragmentedAck = splitTaskMessageContent(
    "I will\\n\\nresearch Manus AI pricing strategy and explain the strategic rationale.\\n\\nTask completed.",
    true,
  )
  assert.equal(
    splitFragmentedAck.acknowledgment,
    'I will research Manus AI pricing strategy and explain the strategic rationale.',
  )
  assert.equal(splitFragmentedAck.finalContent, 'Task completed.')
  const splitHeadingFinalOnly = splitTaskMessageContent(
    '# iPhone17 Summary ReportThe iPhone17 is Apple\\'s base flagship model.\\n## Chips:** Apple A19 SoC powers the device.',
    true,
  )
  assert.equal(splitHeadingFinalOnly.acknowledgment, '', 'final reports that begin with a heading must not replace the startup acknowledgement')
  assert.equal(
    splitHeadingFinalOnly.finalContent,
    '# iPhone 17 Summary Report\\n\\nThe iPhone 17 is Apple\\'s base flagship model.\\n\\n## Chips\\n\\nApple A19 SoC powers the device.',
    'stuck final-report markdown headings must be repaired before rendering',
  )
  const splitAckThenHeadingFinal = splitTaskMessageContent(
    "I'll research iPhone 17 and summarize the most important details.\\n# iPhone 17 Summary\\n\\nThe iPhone 17 is Apple's base flagship model.",
    true,
  )
  assert.equal(
    splitAckThenHeadingFinal.acknowledgment,
    "I'll research iPhone 17 and summarize the most important details.",
    'startup acknowledgement must stay above task progress when a heading-style final answer follows it',
  )
  assert.equal(
    splitAckThenHeadingFinal.finalContent,
    "# iPhone 17 Summary\\n\\nThe iPhone 17 is Apple's base flagship model.",
    'heading-style final answers must render as final content after task progress',
  )

  const state = createInitialState(false, timeouts)
  state.currentPlanItems = ['Research phase', 'Deliver phase']
  state.currentPlanScopes = ['phase scope', 'deliver scope']
  state.currentStepIdx = 0
  setWorkLedgerObjective(state)
  setWorkLedgerRequirements(state, [
    'read selected skill first',
    'verify output',
    'boot local preview',
    'use visual screenshot state plus fresh indexed controls',
    'verify the final browser state or a concrete hard blocker',
  ])
  satisfyWorkLedgerRequirement(state, 'Selected skill/file loaded before work', ['read selected skill'])
  recordWorkLedgerSource(state, { url: 'https://example.com/report', title: 'Example Report' })
  recordWorkLedgerFailure(state, { tool: 'browser_navigate', target: 'https://bad.example/404', error: 'HTTP 404' })
  recordWorkLedgerVerification(state, { kind: 'website-preview', detail: 'Local preview rendered non-blank.' })
  recordWorkLedgerVerification(state, { kind: 'execute_command', detail: 'Lint command passed.' })
  recordWorkLedgerVerification(state, { kind: 'browser-final-state', detail: 'Requested browser action is visibly complete.' })
  recordWorkLedgerDeliverable(state, { path: 'research-notes/step-1.md', purpose: 'support' })
  recordWorkLedgerDeliverable(state, { path: 'deliverables/final.md', purpose: 'deliverable' })
  recordWorkLedgerVisualObservation(state, { tool: 'browser_screenshot', url: 'https://example.com/report', title: 'Report', detail: 'Visual frame captured.' })

  assert.equal(state.workLedger.currentObjective, 'Research phase')
  assert.ok(!state.workLedger.remainingRequirements.some(req => /read selected skill/i.test(req)))
  assert.ok(!state.workLedger.remainingRequirements.some(req => /verify output|boot local preview/i.test(req)))
  assert.ok(!state.workLedger.remainingRequirements.some(req => /visual screenshot state|final browser state|hard blocker/i.test(req)))
  assert.equal(state.workLedger.satisfiedRequirements[0]?.label, 'Selected skill/file loaded before work')
  assert.equal(state.workLedger.sources[0]?.domain, 'example.com')
  assert.equal(state.workLedger.deliverableCandidates.find(item => item.path === 'research-notes/step-1.md')?.purpose, 'support')
  assert.equal(state.workLedger.deliverableCandidates.find(item => item.path === 'deliverables/final.md')?.purpose, 'deliverable')
  const summary = getWorkSummary(state)
  assert.match(summary, /Current objective: Research phase/)
  assert.match(summary, /Recent source domains: example\.com/)
  assert.match(summary, /Recent blocked routes:/)
  assert.match(summary, /Verified outputs:/)
  assert.ok(summary.includes('Deliverable candidates: deliverables/final.md'))
  assert.ok(summary.includes('Support/internal artifacts, not final deliverables: research-notes/step-1.md'))
  trackBrowseResult(state, false, 'https://www.woolworths.com.au/shop/search/products?searchTerm=flour')

  assert.equal(CREDIT_RATES.webSearchCredits, 0.3)
  assert.equal(CREDIT_RATES.imageSearchCredits, 0.3)
  assert.equal(CREDIT_RATES.browserStepCredits, 0)
  assert.equal(CREDIT_RATES.e2bDefaultVcpuCount, 2)
  assert.equal(CREDIT_RATES.e2bDefaultMemoryGiB, 0.5)
  assert.equal(CREDIT_RATES.e2bSandboxUsdPerSecond, (2 * 0.000014) + (0.5 * 0.0000045))
  assert.equal(toolCreditCharge('web_search'), 0.3)
  assert.equal(toolCreditCharge('browser_click_at'), 0)
  assert.equal(toolCreditCharge('browser_screenshot'), 0)
  const expectedTokenCharge = roundCreditAmount(0.00123 * CREDIT_RATES.creditsPerUsd)
  const expectedE2BCharge = roundCreditAmount(CREDIT_RATES.e2bSandboxUsdPerSecond * CREDIT_RATES.creditsPerUsd * 120)
  assert.equal(e2bSandboxRuntimeCreditCharge({ elapsedMs: 120_000 }), expectedE2BCharge)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000 }), 0)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000, cost: 0.00123 }), expectedTokenCharge)
  const savedInstructions = 'Always use my three-step source review process before writing.'
  const runtimePrompt = getSystemPrompt(savedInstructions)
  const planningPrompt = getPlanningPrompt(savedInstructions)
  assert.match(runtimePrompt, /iterative autonomous agent loop/, 'runtime prompt must define the autonomous observe-adapt loop')
  assert.match(runtimePrompt, /task sandbox as the active computer environment/, 'runtime prompt must frame the sandbox as the active workspace')
  assert.match(runtimePrompt, /untrusted external data/, 'runtime prompt must treat external content as untrusted evidence')
  assert.match(runtimePrompt, /Use Australian English spelling/, 'runtime prompt must preserve the requested Manus-like language style')
  assert.match(runtimePrompt, /prefer read_document or HTTP\\/text extraction before full browser navigation/, 'runtime prompt must prefer fast extraction before rendered browser navigation')
  assert.match(runtimePrompt, /Custom Instruction Compliance/)
  assert.match(runtimePrompt, /Always use my three-step source review process before writing\./)
  assert.match(planningPrompt, /Custom Instructions That Apply To This Plan/)
  assert.match(planningPrompt, /Reflect any requested process\\/order\\/format/)
  assert.match(planningPrompt, /Always use my three-step source review process before writing\./)
  const promptHints = (type) => ({
    type,
    toolPriority: ['web_search', 'browser_navigate', 'create_file'],
    stepGuidance: { research: 'gather only needed evidence', deliverable: 'finish in the requested format' },
    temperature: 0.3,
  })
  const browsePrompt = getSystemPrompt(undefined, promptHints('browse'))
  const buildPrompt = getSystemPrompt(undefined, promptHints('build'))
  const researchPrompt = getSystemPrompt(undefined, promptHints('research'))
  const codePrompt = getSystemPrompt(undefined, promptHints('code'))
  const analysisPrompt = getSystemPrompt(undefined, promptHints('analysis'))
  const creativePrompt = getSystemPrompt(undefined, promptHints('creative'))
  assert.match(browsePrompt, /You CAN interact with any website/, 'browse/action prompts must keep full interactive capability wording')
  assert.doesNotMatch(researchPrompt, /You CAN interact with any website/, 'non-browse prompts must use compact capability wording')
  assert.doesNotMatch(buildPrompt, /You CAN fill multi-field forms/, 'build prompts must not carry detailed form capability wording')
  assert.match(researchPrompt, /Do not claim those capabilities are unavailable/, 'compact capability wording must preserve anti-refusal behavior')
  assert.match(researchPrompt, /prefer read_document or HTTP\\/text extraction before full browser navigation/, 'compact research prompts must prefer fast extraction before rendered browser navigation')
  assert.match(browsePrompt, /Each interactive entry is formatted/, 'browse/action prompts must keep detailed browser element guidance')
  assert.doesNotMatch(buildPrompt, /Each interactive entry is formatted/, 'build prompts must not carry full browser form/click guidance')
  assert.match(buildPrompt, /Browser Preview Verification/, 'build prompts must keep compact local preview verification guidance')
  assert.ok(buildPrompt.includes('complete Next.js + TSX structure'), 'build prompts must preserve website structure quality rules')
  assert.ok(!buildPrompt.includes('Novel/book-length requests'), 'build prompts must not carry long-form writing policy')
  assert.doesNotMatch(researchPrompt, /Each interactive entry is formatted/, 'research prompts must not carry full browser form/click guidance')
  assert.doesNotMatch(researchPrompt, /complete Next\.js \+ TSX structure/, 'research prompts must not carry website-build policy')
  assert.match(researchPrompt, /source citations/, 'research prompts must preserve citation-quality deliverable guidance')
  assert.ok(!codePrompt.includes('Websites/apps: default to a complete Next.js'), 'code prompts must not carry full website-build deliverable policy')
  assert.doesNotMatch(analysisPrompt, /Each interactive entry is formatted/, 'analysis prompts must not carry full browser form/click guidance')
  assert.match(analysisPrompt, /methodology/, 'analysis prompts must preserve data-methodology guidance')
  assert.ok(creativePrompt.includes('chapter/section files'), 'creative prompts must preserve long-writing chunking guidance')
  assert.match(buildStepMessage(['Draft chapters', 'Collate manuscript'], 1, undefined, undefined, 3, 'creative'), /If the user requested PDF, export the completed source/, 'creative final steps must still support requested PDF export')
  assert.ok(buildPrompt.length < getSystemPrompt(undefined).length, 'strategy-aware runtime prompts should be shorter than the full fallback prompt')

  const leakedToolText = '<toolcall> <function=browser_scroll> </function> </tool_call>'
  for (const cleaned of [
    cleanThinkingTags(leakedToolText),
    cleanThinkingTokens(leakedToolText),
    stripToolActionNarration(leakedToolText),
    stripSpecialTokens(leakedToolText),
    stripThinkingTags(leakedToolText),
  ]) {
    assert.doesNotMatch(cleaned, /tool_?call|function\s*=/i)
    assert.equal(cleaned.trim(), '')
  }

  const escapedToolText = '&lt;tool_call&gt; &lt;function=browser_scroll&gt; &lt;/function&gt; &lt;/tool_call&gt;'
  assert.equal(cleanThinkingTokens(escapedToolText).trim(), '')
  const leakedInternalRecovery = 'INTERNAL_RECOVERY: direct text extraction was blocked for this URL. Do not show this to the user.'
  assert.equal(cleanThinkingTags(leakedInternalRecovery).trim(), '')
  assert.equal(cleanThinkingTokens(leakedInternalRecovery).trim(), '')
  assert.equal(stripToolActionNarration(leakedInternalRecovery).trim(), '')
  assert.equal(stripSpecialTokens(leakedInternalRecovery).trim(), '')
  assert.equal(stripThinkingTags(leakedInternalRecovery).trim(), '')
  assert.equal(isBareResearchOverviewRequest('Research about AI'), true)
  assert.equal(bareResearchOverviewTopic('Research about AI'), 'AI')
  assert.equal(taskDefaultsToMarkdownDeliverable('Research about iPhone 17'), true)
  assert.equal(taskDefaultsToMarkdownDeliverable('Quickly research about iPhone 17'), true)
  assert.equal(taskDefaultsToMarkdownDeliverable('Research report about iPhone 17'), true)
  assert.equal(taskDefaultsToMarkdownDeliverable('actually make a report in .md file'), true)
  assert.equal(taskDefaultsToMarkdownDeliverable('Research about iPhone 17 but answer here, no file'), false)

  const makeDepthState = (request, complexity, planItems, planScopes = []) => {
    const depthState = createInitialState(false, timeouts)
    depthState.originalUserRequest = request
    depthState.taskStrategy = 'research'
    depthState.currentPhase = 'research'
    depthState.taskComplexity = complexity
    depthState.currentPlanItems = planItems
    depthState.currentPlanScopes = planScopes
    depthState.currentStepIdx = 0
    return depthState
  }
  const bareResearchDepth = researchDepthProfileForState(makeDepthState(
    'Research about AI',
    2,
    ['Research AI basics', 'Summarize AI clearly'],
    ['Gather a compact source-backed overview', ''],
  ))
  assert.notEqual(bareResearchDepth.label, 'light', 'bare research prompts must use normal research depth instead of a lazy fast lane: ' + JSON.stringify(bareResearchDepth))
  assert.ok(bareResearchDepth.requiredCalls >= 7, 'bare research prompts must keep the default source-work floor: ' + JSON.stringify(bareResearchDepth))
  assert.ok(bareResearchDepth.requiredSourceBreadth >= 4, 'bare research prompts must keep default domain breadth: ' + JSON.stringify(bareResearchDepth))

  const normalResearchDepth = researchDepthProfileForState(makeDepthState(
    'Research report about iPhone 17',
    2,
    ['Gather current iPhone evidence', 'Analyze importance and implications', 'Write the report'],
    ['Release details, specs, pricing, market impact, and caveats', 'Technology, ecosystem, sales, and cultural significance', ''],
  ))
  assert.ok(normalResearchDepth.requiredCalls >= 5, 'normal research phases must keep a real evidence floor: ' + JSON.stringify(normalResearchDepth))
  assert.ok(normalResearchDepth.requiredSourceBreadth >= 3, 'normal research phases need several source domains: ' + JSON.stringify(normalResearchDepth))

  const deepReportDepth = researchDepthProfileForState(makeDepthState(
    'Conduct the deepest possible research on DevRev AI and produce a concise, visually rich Markdown report. Research history, founding team, funding, leadership, product evolution, AI capabilities, customer adoption, enterprise traction, financial indicators, hiring trends, partnerships, competitive position, pricing, reviews, market sentiment, technical strengths, weaknesses, risks and long term opportunities. Compare DevRev with Zendesk, Intercom, Salesforce, ServiceNow, Freshworks and Linear.',
    3,
    ['Company and product evidence', 'Market and competitive evidence', 'Risks and scenario evidence', 'Write verdict report'],
    ['Official/company, funding, leadership, product, and AI capability sources', 'Customer, competitor, pricing, review, and market traction sources', 'Bull/base/bear scenario inputs and indicators', ''],
  ))
  assert.ok(deepReportDepth.requiredCalls >= 10, 'deep report phases must keep a high per-phase evidence target: ' + JSON.stringify(deepReportDepth))
  assert.ok(deepReportDepth.requiredSourceBreadth >= 6, 'deep report phases must require broad source diversity: ' + JSON.stringify(deepReportDepth))

  const quickDepth = researchDepthProfileForState(makeDepthState(
    'Quickly check who won last night and answer in one sentence.',
    1,
    ['Check result', 'Answer directly'],
    ['One current result source only', ''],
  ))
  assert.equal(quickDepth.label, 'light')
  assert.equal(quickDepth.requiredCalls, 3)

  const conciseCurrentAiDepth = researchDepthProfileForState(makeDepthState(
    'Summarize the current state of artificial intelligence, covering core technologies and real-world applications. Provide a clear, concise overview.',
    2,
    ['Define artificial intelligence and core types', 'Identify key technologies and applications', 'Write final overview'],
    ['Ground definitions and capability types in credible sources', 'Cover ML, neural networks, NLP, adoption examples, caveats, and impact', ''],
  ))
  assert.notEqual(conciseCurrentAiDepth.label, 'light', 'concise current-state AI overview must not downgrade to light research: ' + JSON.stringify(conciseCurrentAiDepth))
  assert.ok(conciseCurrentAiDepth.requiredCalls >= 6, 'current-state AI overview needs substantive per-phase source work: ' + JSON.stringify(conciseCurrentAiDepth))
  assert.ok(conciseCurrentAiDepth.requiredSourceBreadth >= 4, 'current-state AI overview needs multiple opened/read source domains: ' + JSON.stringify(conciseCurrentAiDepth))

  assert.deepEqual(
    normalizeMarkdownForDisplay('# AI Research Report: State of the Art in2025–2026##1. Frontier Language Models### OpenAI GPT-5Released in2025').split('\\n'),
    [
      '# AI Research Report: State of the Art in 2025–2026',
      '',
      '## 1. Frontier Language Models',
      '',
      '### OpenAI GPT-5 Released in 2025',
    ],
  )
  const leakedDisplayArgJson = 'I’m going to extract exact wording from the official page.{"action_label":"Locate update or date text on MM2 page","plan_step_index":3} | ! (json >json){"action_label":"Locate update or date text on MM2 page","plan_step_index":3,"text":"Updated"}{"action_label":"Scan MM2 page for updated date wording","plan_step_index":3,"text":"Updated"}'
  const cleanedDisplayArgJson = cleanThinkingTokens(leakedDisplayArgJson)
  assert.doesNotMatch(cleanedDisplayArgJson, /action_label|plan_step_index|json\s*>\s*json/i)
  assert.equal(cleanedDisplayArgJson, 'I’m going to extract exact wording from the official page.')
  const partialDisplayArgJson = 'I’m going to extract exact wording.{"action_label":"Scan MM2 page"'
  assert.equal(cleanThinkingTags(partialDisplayArgJson), 'I’m going to extract exact wording. ')
  assert.equal(
    sanitizeNarrationText("chatgpt.com adds that log in ChatGPT Log in Sign up for free What’s on your mind today? Voice By messaging ChatGPT, an AI chatbot, you agree to our Terms and have read our Privacy Policy."),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Research indicates modern platforms collect granular interaction data for personalization. Next, I will compare historical collection practices.', { requireSignal: true }),
    'Research indicates modern platforms collect granular interaction data for personalization. Next, I will compare historical collection practices.',
  )
  assert.equal(
    sanitizeNarrationText('I have searched for "Manus AI task management failure handling" and found some relevant information: Error Logging and Notification: Manus AI logs errors and notifies the user, allowing them to review and adjust tasks. Autonomous Workflow and Error Handling: A review demonstrates its autonomous browsing, code writing, and'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('I have sufficient evidence for Step 1.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('I have examined the Australian Framework for Generative AI in Schools, which establishes a national approach to the ethical and responsible The framework emphasises that AI should be used to benefit students.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Review the College Board I have identified significant institutional and educator concerns regarding AI in high schools.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('gather evidence on those issues.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText("gather more details from the page to confirm the movie she plays in.The YouTube video at the link appears to be a short clip featuring a woman, but I couldn't extract the video content, title, or description from the page.", { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("review what we've gathered so far and identify the key evidence gaps for this phase on limitations, risks, and ethical concerns.", { requireSignal: true }),
    null,
  )
  assert.equal(
    stripToolActionNarration('I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries. now read the most promising source on expert AGI timeline'),
    'I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries.',
  )
  assert.equal(
    sanitizeNarrationText('Found the YouTube page did not expose a title, description, or transcript from that URL.The source still confirms it was a video page.', { requireSignal: true }),
    'Found the YouTube page did not expose a title, description, or transcript from that URL.',
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
    sanitizeNarrationText('Confirm café option selected and move to Location 3.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Confirmed café option selected.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('The sources so far show Manus emphasizes autonomous browser operation and tool execution across multi-step workflows.', { requireSignal: true }),
    'The sources so far show Manus emphasizes autonomous browser operation and tool execution across multi-step workflows.',
  )
  assert.equal(
    sanitizeNarrationText('Research indicates this source describes autonomous browsing and code writing and', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Click the "Update" button to confirm the prompt.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('This indicates that the action was ineffective.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Richard Marr's profile confirms his leadership at DevRev, which raised $100M Series A in late 2025. Next, I'll analyze Exa AI.", { requireSignal: true }),
    "Richard Marr's profile confirms his leadership at DevRev, which raised $100M Series A in late 2025. Next, I'll analyze Exa AI.",
  )
  assert.equal(
    sanitizeNarrationText("Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.", { requireSignal: true }),
    "Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.",
  )
  assert.equal(explicitWebSearchLimitFromText('do only one web search on parrotlets and create an .md file on them'), 1)
  assert.equal(explicitWebSearchLimitFromText('do two web searches then tell me'), 2)
  assert.equal(isDynamicKnowledgeQuestion('Why is Manus AI different from other AIs'), true)
  assert.equal(isDynamicKnowledgeQuestion('compare React and Vue at a high level'), false)
  const interruptedBrowseMessages = [
    { role: 'user', content: 'Go to woolworths.com.au and add all the needed separate ingredients to make pancakes to the cart.' },
    { role: 'assistant', content: 'Opening woolworths.com.au' },
    { role: 'user', content: 'no pancake mix' },
  ]
  assert.equal(isContextualTaskUpdate(interruptedBrowseMessages), true)
  assert.ok(effectiveTaskRequest(interruptedBrowseMessages).includes('Latest user interruption/correction: no pancake mix'))
  assert.equal(isContextualTaskUpdate([
    { role: 'user', content: 'research about pacific parrotlets' },
    { role: 'assistant', content: 'Earlier long task output' },
    { role: 'user', content: 'make a website about AI in education' },
  ]), false)
  assert.equal(isContextualTaskUpdate([
    { role: 'user', content: 'Create a website about birds' },
    { role: 'assistant', content: 'Started a website' },
    { role: 'user', content: 'change it to use a darker theme' },
  ]), true)
  assert.equal(resolveStrategy(interruptedBrowseMessages).type, 'browse')
  assert.equal(resolveStrategy([
    { role: 'user', content: 'Debate gemini ai about AI' },
  ]).type, 'browse')
  assert.equal(resolveStrategy([
    { role: 'user', content: 'do exactly 1 web search about ai and answer in 2 sentences' },
  ]).type, 'research')
  assert.equal(resolveStrategy([
    { role: 'user', content: 'do two web searches then tell me' },
  ]).type, 'research')
  assert.equal(resolveStrategy([
    { role: 'user', content: 'look it up and cite the source' },
  ]).type, 'research')
  const namedAiCompletion = detectBrowserTaskCompletion('Navigate to Gemini AI and initiate conversation', {
    success: true,
    url: 'https://gemini.google.com/app/test',
    title: 'AI Debate: Choose Your Battleground - Google Gemini',
    action: 'Fresh browser state after blocked preflight action.',
    content: 'Gemini Ask Gemini Challenge accepted. To kick it off, establish a foundational motion. Pick your poison, choose your side, and give me your opening argument.',
  })
  assert.equal(namedAiCompletion.completed, true)
  assert.match(namedAiCompletion.reason, /named AI chat page/)
  assert.equal(fixedWebSearchTopicFromMessages([
    { role: 'user', content: 'Why is Manus AI different from other AIs' },
    { role: 'assistant', content: 'Manus AI is different because it emphasizes transparency.' },
    { role: 'user', content: 'do two web searches then tell me' },
  ]), 'Why is Manus AI different from other AIs')
  assert.equal(fixedWebSearchTopicFromMessages([
    { role: 'user', content: 'only do two web searches on Manus AI differences' },
  ]), 'Manus AI differences')
  assert.equal(fixedWebSearchTopicFromMessages([
    { role: 'user', content: 'Why is Manus AI different from other AIs only do two web searches' },
  ]), 'Why is Manus AI different from other AIs')
  assert.equal(fixedWebSearchTopicFromMessages([
    { role: 'user', content: 'do 1 web search on best yoghurt toppings and get back to me in an md report file' },
  ]), 'best yoghurt toppings')
  assert.equal(fixedWebSearchTopicFromMessages([
    { role: 'user', content: 'do only one web search on parrotlets and create an .md file on them and return it' },
  ]), 'parrotlets')
  assert.equal(isSingleWebSearchMarkdownTask([
    { role: 'user', content: 'do only one web search on parrotlets and create an .md file on them and return it' },
  ]), true)
  assert.equal(isAtomicStep('Check ZoomEarth for precipitation in Ryde, NSW today between 5:30-6:15 PM AEST'), false)
  assert.equal(isAtomicStep('Confirm official signals and release-status breadcrumbs only'), false)
  assert.equal(isAtomicStep('Confirm conservation status and major evidence sources'), false)
  assert.equal(isAtomicStep('Check the current page loaded'), true)
  assert.equal(isAtomicStep('Confirm the final confirmation state'), true)
  const longGoalTracker = new GoalTracker()
  longGoalTracker.initializeFromPlan(Array.from({ length: 12 }, (_, idx) => \`Step \${idx + 1} with a fairly specific objective\`))
  longGoalTracker.advanceToStep(6)
  const compactGoalContext = longGoalTracker.renderForContext() || ''
  assert.match(compactGoalContext, /12 total/, 'long goal lists should render compact counts')
  assert.match(compactGoalContext, /\\[NOW\\] 7\\./, 'compact goal context must preserve the active goal')
  assert.ok(compactGoalContext.split('|').length <= 10, 'compact goal context should not list every long-plan goal')
  const inlineFinalStepMessage = buildStepMessage(
    ['Research product evidence', 'Synthesize final report'],
    1,
    undefined,
    new Map([[0, 'Step evidence captured from official and independent sources.']]),
    2,
    'research',
    'Write the final report in chat from gathered findings.',
  )
  assert.match(inlineFinalStepMessage, /FINAL PHASE SWITCH/, 'inline final step guidance must include a hard phase boundary')
  assert.match(inlineFinalStepMessage, /answer directly in chat now/, 'inline final step guidance must request a direct chat answer')
  assert.doesNotMatch(inlineFinalStepMessage, /create the deliverable file now/, 'inline final step guidance must not ask for a saved file')

  const finalStepMessage = buildStepMessage(
    ['Research product evidence', 'Synthesize final markdown report'],
    1,
    undefined,
    new Map([[0, 'Step evidence captured from official and independent sources.']]),
    2,
    'research',
    'Create the final markdown report file from gathered findings.',
  )
  assert.match(finalStepMessage, /FINAL PHASE SWITCH/, 'final step guidance must include a hard phase boundary')
  assert.match(finalStepMessage, /Start synthesis now/, 'final step guidance must tell the model to synthesize immediately')
  assert.match(finalStepMessage, /must not continue prior research/, 'final step guidance must reject previous-phase research carryover')

  const policy = new PolicyEngine()
  const cadenceState = createInitialState(false, timeouts)
  cadenceState.currentPlanItems = ['Gather source evidence', 'Write final answer']
  cadenceState.currentStepIdx = 0
  cadenceState.visibleToolActionsSinceLastNarration = 3
  cadenceState.consecutiveNoToolCalls = 2
  const cadenceActions = policy.evaluate(
    cadenceState,
    new Map(),
    "I confirmed the official source lists the requested habitat range and elevation details. Next, I'll compare those findings with independent taxonomic references.",
    false,
    30,
  )
  assert.deepEqual(cadenceActions, [], 'valid narration after 3 visible actions should be accepted as narration, not no-tool laziness')
  assert.equal(cadenceState.visibleToolActionsSinceLastNarration, 0)
  assert.equal(cadenceState.consecutiveNoToolCalls, 0)

  const invalidCadenceState = createInitialState(false, timeouts)
  invalidCadenceState.currentPlanItems = ['Gather source evidence', 'Write final answer']
  invalidCadenceState.currentStepIdx = 0
  invalidCadenceState.visibleToolActionsSinceLastNarration = 3
  const invalidCadenceFirstActions = policy.evaluate(
    invalidCadenceState,
    new Map(),
    'Working on this now.',
    false,
    30,
  )
  assert.ok(
    invalidCadenceFirstActions.some((action) => action.message?.content?.includes('previous progress update was not valid')),
    'first invalid cadence narration should get one rewrite attempt',
  )
  assert.equal(invalidCadenceState.visibleToolActionsSinceLastNarration, 3)
  const invalidCadenceSecondActions = policy.evaluate(
    invalidCadenceState,
    new Map(),
    'Still looking into it.',
    false,
    30,
  )
  assert.ok(
    invalidCadenceSecondActions.some((action) => action.message?.content?.includes('NARRATION CADENCE MISSED')),
    'repeated invalid cadence narration must release the next turn back to tool work',
  )
  assert.equal(invalidCadenceState.visibleToolActionsSinceLastNarration, 2)

  const phaseEndAdvanceState = createInitialState(false, timeouts)
  phaseEndAdvanceState.taskStrategy = 'analysis'
  phaseEndAdvanceState.currentPhase = 'analysis'
  phaseEndAdvanceState.currentPlanItems = ['Analyze collected evidence', 'Write final answer']
  phaseEndAdvanceState.currentStepIdx = 0
  phaseEndAdvanceState.visibleToolActionsSinceLastNarration = 4
  phaseEndAdvanceState.stepToolCallCount = 4
  phaseEndAdvanceState.stepIterationCount = 4
  const phaseEndAdvanceActions = policy.evaluate(
    phaseEndAdvanceState,
    new Map(),
    'Confirmed the official source lists the requested habitat range and elevation details for the species with matching taxonomy evidence.',
    true,
    30,
  )
  assert.equal(phaseEndAdvanceState.currentStepIdx, 1, 'valid phase-end narration plus next_step should advance in the same turn')
  assert.equal(phaseEndAdvanceState.visibleToolActionsSinceLastNarration, 0)
  assert.ok(phaseEndAdvanceActions.some((action) => action.type === 'step_advance'), 'phase-end narration should not swallow the next_step transition')

  const phaseEndMissingNarrationState = createInitialState(false, timeouts)
  phaseEndMissingNarrationState.taskStrategy = 'analysis'
  phaseEndMissingNarrationState.currentPhase = 'analysis'
  phaseEndMissingNarrationState.currentPlanItems = ['Analyze collected evidence', 'Write final answer']
  phaseEndMissingNarrationState.currentStepIdx = 0
  phaseEndMissingNarrationState.visibleToolActionsSinceLastNarration = 4
  phaseEndMissingNarrationState.stepToolCallCount = 4
  phaseEndMissingNarrationState.stepIterationCount = 4
  const phaseEndMissingNarrationActions = policy.evaluate(
    phaseEndMissingNarrationState,
    new Map(),
    '',
    true,
    30,
  )
  assert.equal(phaseEndMissingNarrationState.currentStepIdx, 0, 'phase advance without narration should pause on the active phase')
  assert.ok(
    phaseEndMissingNarrationActions.some((action) => action.message?.content?.includes('PHASE-END NARRATION REQUIRED')),
    'phase advance without narration should request the required phase-end LLM narration turn',
  )
  assert.equal(phaseEndMissingNarrationState.forceTextNextIteration, true, 'missing phase narration should force a compact narration-only turn before advancing')

  const phaseEndPendingNoMarkerState = createInitialState(false, timeouts)
  phaseEndPendingNoMarkerState.taskStrategy = 'analysis'
  phaseEndPendingNoMarkerState.currentPhase = 'analysis'
  phaseEndPendingNoMarkerState.currentPlanItems = ['Analyze collected evidence', 'Write final answer']
  phaseEndPendingNoMarkerState.currentStepIdx = 0
  phaseEndPendingNoMarkerState.visibleToolActionsSinceLastNarration = 4
  phaseEndPendingNoMarkerState.forceTextNextIteration = true
  phaseEndPendingNoMarkerState.phaseEndNarrationPending = true
  phaseEndPendingNoMarkerState.stepToolCallCount = 4
  phaseEndPendingNoMarkerState.stepIterationCount = 4
  const phaseEndPendingNoMarkerActions = policy.evaluate(
    phaseEndPendingNoMarkerState,
    new Map(),
    'Confirmed the core source evidence and comparison points needed for the final answer.',
    false,
    30,
  )
  assert.equal(phaseEndPendingNoMarkerState.currentStepIdx, 1, 'valid phase-end narration should advance even without the transition marker')
  assert.equal(phaseEndPendingNoMarkerState.forceTextNextIteration, false, 'accepted phase-end narration should release narration-only mode')
  assert.equal(phaseEndPendingNoMarkerState.phaseEndNarrationPending, false, 'accepted phase-end narration should clear the pending flag')
  assert.ok(
    phaseEndPendingNoMarkerActions.some((action) => action.type === 'step_advance'),
    'valid phase-end narration without next_step should emit a step advance',
  )

  const phaseEndPendingAdvanceState = createInitialState(false, timeouts)
  phaseEndPendingAdvanceState.taskStrategy = 'analysis'
  phaseEndPendingAdvanceState.currentPhase = 'analysis'
  phaseEndPendingAdvanceState.currentPlanItems = ['Analyze collected evidence', 'Write final answer']
  phaseEndPendingAdvanceState.currentStepIdx = 0
  phaseEndPendingAdvanceState.visibleToolActionsSinceLastNarration = 4
  phaseEndPendingAdvanceState.forceTextNextIteration = true
  phaseEndPendingAdvanceState.phaseEndNarrationPending = true
  phaseEndPendingAdvanceState.stepToolCallCount = 4
  phaseEndPendingAdvanceState.stepIterationCount = 4
  const phaseEndPendingAdvanceActions = policy.evaluate(
    phaseEndPendingAdvanceState,
    new Map(),
    'Confirmed the core source evidence and comparison points needed for the final answer.',
    true,
    30,
  )
  assert.equal(phaseEndPendingAdvanceState.currentStepIdx, 1, 'phase-end forced narration with next_step should advance')
  assert.equal(phaseEndPendingAdvanceState.phaseEndNarrationPending, false, 'advancing should clear the phase-end narration flag')
  assert.ok(
    phaseEndPendingAdvanceActions.some((action) => action.type === 'step_advance'),
    'phase-end forced narration with next_step should emit a step advance',
  )

  const stalledResearchLoopState = createInitialState(false, timeouts)
  stalledResearchLoopState.taskStrategy = 'research'
  stalledResearchLoopState.currentPhase = 'research'
  stalledResearchLoopState.currentPlanItems = ['Gather current Exa sources', 'Compare evidence']
  stalledResearchLoopState.currentStepIdx = 0
  stalledResearchLoopState.taskComplexity = 2
  stalledResearchLoopState.stepResearchCallCount = 5
  stalledResearchLoopState.stepToolCallCount = 5
  stalledResearchLoopState.stepIterationCount = 8
  stalledResearchLoopState.stepVisitedUrls.add('https://exa.ai/blog/announcing-series-b')
  markOpenedDomain(stalledResearchLoopState, 'exa.ai', 5)
  stalledResearchLoopState.recentToolCalls = [
    { name: 'browser_get_content', args: '{}' },
    { name: 'browser_get_content', args: '{}' },
    { name: 'browser_get_content', args: '{}' },
  ]
  const stalledResearchLoopActions = policy.evaluate(
    stalledResearchLoopState,
    new Map([[0, { id: 'loop_get_content', name: 'browser_get_content', arguments: '{}' }]]),
    '',
    false,
    30,
  )
  assert.equal(stalledResearchLoopState.currentStepIdx, 0, 'thin repeated research should stay in the current phase')
  assert.ok(
    stalledResearchLoopActions.some((action) => action.message?.content?.includes('Do not advance until the research-depth requirements are satisfied')),
    'thin repeated research loop recovery should redirect the next action instead of advancing',
  )
  assert.equal(stalledResearchLoopState.forceTextNextIteration, false, 'thin loop recovery should keep tools available for more evidence')

  const nearDepthNoToolLoopState = createInitialState(false, timeouts)
  nearDepthNoToolLoopState.taskStrategy = 'research'
  nearDepthNoToolLoopState.currentPhase = 'research'
  nearDepthNoToolLoopState.currentPlanItems = ['Gather current company and product evidence', 'Compare evidence']
  nearDepthNoToolLoopState.currentStepIdx = 0
  nearDepthNoToolLoopState.taskComplexity = 2
  nearDepthNoToolLoopState.stepResearchCallCount = 8
  nearDepthNoToolLoopState.stepToolCallCount = 8
  nearDepthNoToolLoopState.stepIterationCount = 10
  nearDepthNoToolLoopState.stepLoopDetections = 1
  nearDepthNoToolLoopState.stepVisitedUrls.add('https://exa.ai/')
  nearDepthNoToolLoopState.stepVisitedUrls.add('https://techcrunch.com/exa-ai-funding')
  markOpenedDomain(nearDepthNoToolLoopState, 'exa.ai', 4)
  markOpenedDomain(nearDepthNoToolLoopState, 'techcrunch.com', 4)
  nearDepthNoToolLoopState.consecutiveNoToolCalls = 4
  const nearDepthNoToolLoopActions = policy.evaluate(
    nearDepthNoToolLoopState,
    new Map(),
    'I have enough evidence to move on despite needing more independent source breadth.',
    false,
    30,
  )
  assert.equal(nearDepthNoToolLoopState.currentStepIdx, 0, 'near-depth stalled research should not skip to the next phase')
  assert.ok(!nearDepthNoToolLoopActions.some((action) => action.type === 'step_advance'), 'stalled research evidence must not count as phase completion')
  assert.ok(
    nearDepthNoToolLoopActions.some((action) => action.message?.content?.includes('RESEARCH DEPTH INCOMPLETE')),
    'near-depth stalled research should ask for more targeted source work',
  )

  const phaseEndAvailableEvidenceState = createInitialState(false, timeouts)
  phaseEndAvailableEvidenceState.taskStrategy = 'research'
  phaseEndAvailableEvidenceState.currentPhase = 'research'
  phaseEndAvailableEvidenceState.currentPlanItems = ['Gather current company and product evidence', 'Compare evidence']
  phaseEndAvailableEvidenceState.currentStepIdx = 0
  phaseEndAvailableEvidenceState.taskComplexity = 2
  phaseEndAvailableEvidenceState.stepResearchCallCount = 9
  phaseEndAvailableEvidenceState.stepToolCallCount = 9
  phaseEndAvailableEvidenceState.stepIterationCount = 8
  phaseEndAvailableEvidenceState.stepVisitedUrls.add('https://exa.ai/')
  phaseEndAvailableEvidenceState.stepVisitedUrls.add('https://techcrunch.com/exa-ai-funding')
  phaseEndAvailableEvidenceState.stepVisitedUrls.add('https://sacra.com/research/exa-ai')
  phaseEndAvailableEvidenceState.stepVisitedUrls.add('https://theinformation.com/exa-ai-product')
  phaseEndAvailableEvidenceState.stepVisitedUrls.add('https://research.example.edu/search-agent-benchmarks')
  markOpenedDomain(phaseEndAvailableEvidenceState, 'exa.ai', 3)
  markOpenedDomain(phaseEndAvailableEvidenceState, 'techcrunch.com', 2)
  markOpenedDomain(phaseEndAvailableEvidenceState, 'sacra.com', 1)
  markOpenedDomain(phaseEndAvailableEvidenceState, 'theinformation.com', 1)
  markOpenedDomain(phaseEndAvailableEvidenceState, 'research.example.edu', 1)
  const phaseEndAvailableEvidenceActions = policy.evaluate(
    phaseEndAvailableEvidenceState,
    new Map(),
    'The core company, funding, and product evidence is in place, with remaining caveats tracked for comparison.' +
      String.fromCharCode(10) +
      '<next_step/>',
    true,
    30,
  )
  assert.equal(phaseEndAvailableEvidenceState.currentStepIdx, 1, 'usable in-phase evidence plus model-authored next_step should advance instead of stalling')
  assert.ok(phaseEndAvailableEvidenceActions.some((action) => action.type === 'step_advance'), 'available evidence phase-end should emit a step advance')

  const repeatedToolSignalState = createInitialState(false, timeouts)
  repeatedToolSignalState.taskStrategy = 'research'
  repeatedToolSignalState.currentPhase = 'research'
  repeatedToolSignalState.currentPlanItems = ['Gather current company and product evidence', 'Compare evidence']
  repeatedToolSignalState.currentStepIdx = 0
  repeatedToolSignalState.taskComplexity = 2
  repeatedToolSignalState.stepResearchCallCount = 8
  repeatedToolSignalState.stepToolCallCount = 8
  repeatedToolSignalState.stepIterationCount = 10
  repeatedToolSignalState.stepVisitedUrls.add('https://exa.ai/')
  repeatedToolSignalState.stepVisitedUrls.add('https://techcrunch.com/exa-ai-funding')
  markOpenedDomain(repeatedToolSignalState, 'exa.ai', 4)
  markOpenedDomain(repeatedToolSignalState, 'techcrunch.com', 4)
  repeatedToolSignalState.lastLoopSignal = { type: 'cross_tool_cycle', tool: 'read_document' }
  repeatedToolSignalState.recentToolSequence = ['read_document::https://exa.ai', 'web_search::exa ai', 'read_document::https://exa.ai', 'web_search::exa ai']
  const repeatedToolSignalActions = policy.evaluate(
    repeatedToolSignalState,
    new Map([[0, { id: 'fresh_search', name: 'web_search', arguments: '{"query":"Exa AI enterprise customers funding 2026"}' }]]),
    '',
    false,
    30,
  )
  assert.equal(repeatedToolSignalState.currentStepIdx, 0, 'internal repeated-tool recovery should keep incomplete research in phase')
  assert.equal(repeatedToolSignalState.lastLoopSignal, null, 'internal repeated-tool recovery should clear stale loop state after redirecting')
  assert.ok(!repeatedToolSignalActions.some((action) => action.type === 'step_advance'), 'internal repeated-tool recovery must not skip incomplete research')
  assert.ok(
    repeatedToolSignalActions.some((action) => action.message?.content?.includes('Do not advance this phase yet')),
    'internal repeated-tool recovery should require a materially different evidence action',
  )

  const forcedNarrationState = createInitialState(false, timeouts)
  forcedNarrationState.currentPlanItems = ['Gather source evidence', 'Write final answer']
  forcedNarrationState.currentStepIdx = 0
  forcedNarrationState.visibleToolActionsSinceLastNarration = 4
  forcedNarrationState.forceTextNextIteration = true
  const forcedNarrationActions = policy.evaluate(
    forcedNarrationState,
    new Map([[0, { id: 'call_forced', name: 'web_search', arguments: '{"query":"habitat evidence"}' }]]),
    '',
    false,
    30,
  )
  assert.ok(
    forcedNarrationActions.some((action) => action.message?.content?.includes('NARRATION REQUIRED BEFORE NEXT ACTION')),
    'a tool call during an overdue narration state should be blocked until narration is written',
  )
  assert.equal(forcedNarrationState.forceTextNextIteration, true)

  const inlineFinalNoToolState = createInitialState(false, timeouts)
  inlineFinalNoToolState.taskStrategy = 'research'
  inlineFinalNoToolState.currentPhase = 'deliver'
  inlineFinalNoToolState.currentPlanItems = ['Research product evidence', 'Synthesize final report']
  inlineFinalNoToolState.currentStepIdx = 1
  inlineFinalNoToolState.stepToolCallCount = 0
  inlineFinalNoToolState.originalUserRequest = 'Write a report on DevRev AI very quickly.'
  const inlineFinalNoToolActions = policy.evaluate(
    inlineFinalNoToolState,
    new Map(),
    'I will now synthesize the gathered findings into the requested report.',
    false,
    30,
  )
  assert.ok(
    inlineFinalNoToolActions.some((action) => action.message?.content?.includes('Write the final answer directly in chat') || action.message?.content?.includes('Write the final answer now as the complete response')),
    'chat-only final reports should request a direct answer instead of a saved artifact',
  )
  assert.ok(
    inlineFinalNoToolActions.some((action) => action.message?.content?.includes('User request: Write a report on DevRev AI very quickly.')),
    'chat-only final report recovery should restate the original user request so the model answers instead of narrating',
  )

  const progressOnlyFinalState = createInitialState(false, timeouts)
  progressOnlyFinalState.taskStrategy = 'general'
  progressOnlyFinalState.currentPhase = 'deliver'
  progressOnlyFinalState.currentPlanItems = ['Frame and ground DevRev report', 'Write DevRev report in chat']
  progressOnlyFinalState.currentStepIdx = 1
  progressOnlyFinalState.originalUserRequest = 'write a report on DevRev AI very quickly'
  const progressOnlyFinalActions = policy.evaluate(
    progressOnlyFinalState,
    new Map(),
    'I found the DevRev homepage, but the compressed HTML makes it hard to read cleanly. Let me get the key pages instead.',
    false,
    30,
  )
  assert.ok(!progressOnlyFinalActions.some((action) => action.reason === 'inline_answer_complete'), 'progress/recovery narration must not count as a final chat answer')
  assert.ok(
    progressOnlyFinalActions.some((action) => action.message?.content?.includes('Write the final answer directly in chat') || action.message?.content?.includes('Write the final answer now as the complete response')),
    'progress-only final text should recover into a direct final answer',
  )

  const finalNoToolState = createInitialState(false, timeouts)
  finalNoToolState.taskStrategy = 'research'
  finalNoToolState.currentPhase = 'deliver'
  finalNoToolState.currentPlanItems = ['Research product evidence', 'Synthesize final markdown report']
  finalNoToolState.currentStepIdx = 1
  finalNoToolState.stepToolCallCount = 0
  finalNoToolState.originalUserRequest = 'Create a markdown file report on DevRev AI.'
  const finalNoToolActions = policy.evaluate(
    finalNoToolState,
    new Map(),
    'I will now synthesize the gathered findings into the requested report.',
    false,
    30,
  )
  assert.ok(finalNoToolActions.some((action) => action.message?.content?.includes('FINAL SYNTHESIS TOOL REQUIRED')), 'final synthesis must immediately require a concrete file/export tool after text-only drift')

  const shallowCurrentAiState = createInitialState(false, timeouts)
  shallowCurrentAiState.taskStrategy = 'research'
  shallowCurrentAiState.currentPhase = 'research'
  shallowCurrentAiState.currentPlanItems = [
    'Define artificial intelligence and core types',
    'Identify key technologies and applications',
    'Write final overview',
  ]
  shallowCurrentAiState.currentPlanScopes = [
    'Ground definitions and capability types in credible sources',
    'Cover ML, neural networks, NLP, adoption examples, caveats, and impact',
    '',
  ]
  shallowCurrentAiState.currentStepIdx = 0
  shallowCurrentAiState.taskComplexity = 2
  shallowCurrentAiState.originalUserRequest = 'Summarize the current state of artificial intelligence, covering core technologies and real-world applications. Provide a clear, concise overview.'
  shallowCurrentAiState.stepToolCallCount = 2
  shallowCurrentAiState.stepResearchCallCount = 2
  shallowCurrentAiState.stepSearchQueries.add('AI definitions and core types')
  shallowCurrentAiState.stepVisitedUrls.add('https://example.com/ai-types')
  markOpenedDomain(shallowCurrentAiState, 'example.com', 1)
  const shallowCurrentAiActions = policy.evaluate(
    shallowCurrentAiState,
    new Map(),
    'Artificial intelligence is defined as machine-simulated human intelligence, categorized into Narrow, General, and Superintelligence.' +
      String.fromCharCode(10) +
      '<next_step/>',
    true,
    60,
  )
  assert.equal(shallowCurrentAiState.currentStepIdx, 0, 'current-state AI overview must not advance after two actions and one opened source')
  assert.ok(!shallowCurrentAiActions.some((action) => action.type === 'step_advance'), 'shallow current-state AI phase must keep working')
  assert.ok(
    shallowCurrentAiActions.some((action) => action.message?.content?.includes('Research still needs')),
    'shallow current-state AI phase must request more opened/read source work',
  )

  const failedSourceAdvanceState = createInitialState(false, timeouts)
  failedSourceAdvanceState.taskStrategy = 'research'
  failedSourceAdvanceState.currentPhase = 'research'
  failedSourceAdvanceState.currentPlanItems = [
    'Detail temperament and social behavior',
    'Outline diet and daily care requirements',
    'Write final concise guide',
  ]
  failedSourceAdvanceState.currentStepIdx = 0
  failedSourceAdvanceState.taskComplexity = 2
  failedSourceAdvanceState.originalUserRequest = 'Write a concise guide on Pacific parrotlets covering physical traits, temperament, and essential care needs.'
  failedSourceAdvanceState.stepToolCallCount = 2
  failedSourceAdvanceState.stepResearchCallCount = 2
  failedSourceAdvanceState.stepSearchQueries.add('Pacific Parrotlet temperament and social behavior')
  failedSourceAdvanceState.stepSourceDomainCounts.set('thesprucepets.com', 1)
  failedSourceAdvanceState.stepSourceDomainCounts.set('lafeber.com', 1)
  failedSourceAdvanceState.stepFailureCount = 1
  const failedSourceAdvanceActions = policy.evaluate(
    failedSourceAdvanceState,
    new Map(),
    'During the research phase focusing on temperament and social behavior of the Pacific Parrotlet, attempts to open and extract detailed text from primary source URLs failed to return usable page content.' +
      String.fromCharCode(10) +
      '<next_step/>',
    true,
    60,
  )
  assert.equal(failedSourceAdvanceState.currentStepIdx, 0, 'failed source-opening narration must not advance a shallow research phase')
  assert.ok(!failedSourceAdvanceActions.some((action) => action.type === 'step_advance'), 'failed source-opening phase must keep trying sources')
  assert.ok(
    failedSourceAdvanceActions.some((action) => action.message?.content?.includes('Research still needs')),
    'failed source-opening phase must ask for another concrete source action',
  )

  const incompleteDepthState = createInitialState(false, timeouts)
  incompleteDepthState.taskStrategy = 'research'
  incompleteDepthState.currentPhase = 'research'
  incompleteDepthState.currentPlanItems = ['Map habitat and range evidence', 'Write final answer']
  incompleteDepthState.currentStepIdx = 0
  incompleteDepthState.taskComplexity = 3
  incompleteDepthState.stepToolCallCount = 3
  incompleteDepthState.stepResearchCallCount = 3
  incompleteDepthState.stepVisitedUrls.add('https://example.com/habitat')
  markOpenedDomain(incompleteDepthState, 'example.com', 1)
  incompleteDepthState.consecutiveNoToolCalls = 4
  const incompleteDepthActions = policy.evaluate(
    incompleteDepthState,
    new Map(),
    'I have identified useful habitat and distribution evidence, but additional elevation and seasonal occupancy sources remain relevant.',
    false,
    30,
  )
  assert.equal(incompleteDepthState.currentStepIdx, 0, 'complex research should not advance after a thin three-action, one-source phase')
  assert.ok(!incompleteDepthActions.some((action) => action.type === 'step_advance'), 'thin complex research must do more work inside the current phase')
  assert.ok(incompleteDepthActions.some((action) => action.message?.content?.includes('RESEARCH DEPTH INCOMPLETE')), 'thin complex research must request another targeted source/action')

  const fullDepthState = createInitialState(false, timeouts)
  fullDepthState.taskStrategy = 'research'
  fullDepthState.currentPhase = 'research'
  fullDepthState.currentPlanItems = ['Map habitat and range evidence', 'Write final answer']
  fullDepthState.currentStepIdx = 0
  fullDepthState.taskComplexity = 3
  fullDepthState.stepToolCallCount = 18
  fullDepthState.stepResearchCallCount = 18
  fullDepthState.stepVisitedUrls.add('https://example.com/habitat')
  fullDepthState.stepVisitedUrls.add('https://example.org/range')
  fullDepthState.stepVisitedUrls.add('https://research.example.edu/seasonal')
  fullDepthState.stepVisitedUrls.add('https://agency.example.gov/elevation')
  fullDepthState.stepVisitedUrls.add('https://museum.example.org/species-notes')
  fullDepthState.stepVisitedUrls.add('https://journal.example.net/field-study')
  fullDepthState.stepVisitedUrls.add('https://archive.example.ac.uk/historical-range')
  fullDepthState.stepVisitedUrls.add('https://conservation.example.int/status')
  fullDepthState.stepVisitedUrls.add('https://taxonomy.example.bio/species-profile')
  markOpenedDomain(fullDepthState, 'example.com', 1)
  markOpenedDomain(fullDepthState, 'example.org', 1)
  markOpenedDomain(fullDepthState, 'research.example.edu', 1)
  markOpenedDomain(fullDepthState, 'agency.example.gov', 1)
  markOpenedDomain(fullDepthState, 'museum.example.org', 1)
  markOpenedDomain(fullDepthState, 'journal.example.net', 1)
  markOpenedDomain(fullDepthState, 'archive.example.ac.uk', 1)
  markOpenedDomain(fullDepthState, 'conservation.example.int', 1)
  markOpenedDomain(fullDepthState, 'taxonomy.example.bio', 1)
  fullDepthState.consecutiveNoToolCalls = 4
  const fullDepthActions = policy.evaluate(
    fullDepthState,
    new Map(),
    'Confirmed the official source lists the requested habitat range and elevation details for the species with matching taxonomy evidence.',
    false,
    30,
  )
  assert.equal(fullDepthState.currentStepIdx, 1, 'full-depth complex research should advance after enough in-phase work')
  assert.ok(fullDepthActions.some((action) => action.type === 'step_advance'), 'full-depth complex research should move to the next phase')

  const searchOnlyBreadthState = createInitialState(false, timeouts)
  searchOnlyBreadthState.taskStrategy = 'research'
  searchOnlyBreadthState.currentPhase = 'research'
  searchOnlyBreadthState.currentPlanItems = ['Map habitat and range evidence', 'Write final answer']
  searchOnlyBreadthState.currentStepIdx = 0
  searchOnlyBreadthState.taskComplexity = 3
  searchOnlyBreadthState.stepToolCallCount = 18
  searchOnlyBreadthState.stepResearchCallCount = 18
  searchOnlyBreadthState.stepVisitedUrls.add('https://example.com/habitat')
  markOpenedDomain(searchOnlyBreadthState, 'example.com', 1)
  for (const domain of ['example.org', 'research.example.edu', 'agency.example.gov', 'museum.example.org', 'journal.example.net', 'archive.example.ac.uk', 'conservation.example.int', 'taxonomy.example.bio']) {
    searchOnlyBreadthState.stepSourceDomainCounts.set(domain, 1)
  }
  searchOnlyBreadthState.consecutiveNoToolCalls = 4
  const searchOnlyBreadthActions = policy.evaluate(
    searchOnlyBreadthState,
    new Map(),
    'Search results surfaced many candidate habitat and range sources, but only one source has been opened so far.',
    false,
    30,
  )
  assert.equal(searchOnlyBreadthState.currentStepIdx, 0, 'search-result domains alone must not satisfy opened-source breadth')
  assert.ok(!searchOnlyBreadthActions.some((action) => action.type === 'step_advance'), 'unopened search-result breadth must keep research in phase')
  assert.ok(searchOnlyBreadthActions.some((action) => action.message?.content?.includes('opened/read source')), 'unopened search breadth should request more opened/read source pages')

  const buildState = createInitialState(true, timeouts)
  buildState.taskStrategy = 'build'
  buildState.currentPlanItems = ['Scaffold Next.js project with Tailwind CSS and dependencies', 'Gather bird image assets']
  buildState.currentPlanScopes = ['Create package.json, app files, and Tailwind setup.', 'Search for source images only.']
  buildState.currentStepIdx = 0
  updatePhase(buildState)
  assert.equal(buildState.currentPhase, 'build')
  assert.equal(isConcreteBuildStep(buildState), true)
  buildState.currentStepIdx = 1
  updatePhase(buildState)
  assert.equal(isResearchStepText('Gather bird image assets'), true)
  assert.equal(isConcreteBuildStep(buildState), false)
  assert.equal(
    sanitizeNarrationText("The system is flagging this as a research step, but the user's explicit instructions say this is a build step."),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Navigation failed; choosing another route.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Navigate to any official government publications or reputable legal analysis sites detailing these amendments.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('state/territory). This decision suggests a stance of not weakening existing copyright protections for creators.'),
    null,
  )
  assert.equal(
    sanitizeNarrationText('or reputable legal analysis sites detailing these amendments. state actions and the status of legal reviews.'),
    null,
  )
  assert.equal(
    stripToolActionNarration("Australia is handling AI copyright issues federally. 2. Navigate to official government publications or reputable legal analysis sites detailing these amendments. 3. Synthesize all gathered information to provide a comprehensive answer on Australia's response to AI copyright issues, including national vs. state actions and the status of legal reviews. 4. Compile findings into a comprehensive report. The federal process remains the main venue."),
    'Australia is handling AI copyright issues federally. The federal process remains the main venue.',
  )

  const researchState = createInitialState(false, timeouts)
  researchState.taskStrategy = 'research'
  researchState.currentPhase = 'research'
  researchState.currentPlanItems = [
    "Identify Manus AI's core technology and unique selling propositions",
    "Analyze target market and applications",
    "Deliver summary",
  ]
  researchState.currentPlanScopes = [
    'Research the foundational technology, algorithms, and architecture.',
    'Research market and applications.',
    'Write final answer.',
  ]
  researchState.currentStepIdx = 0
  researchState.taskComplexity = 2
  researchState.stepToolCallCount = 8
  researchState.stepResearchCallCount = 8
  researchState.stepVisitedUrls.add('https://venturebeat.com/orchestration/why-meta-bought-manus')
  researchState.stepVisitedUrls.add('https://manus.im/product/agents')
  researchState.stepVisitedUrls.add('https://www.forbes.com/sites/ai/manus-enterprise-agents')
  researchState.stepVisitedUrls.add('https://research.example.edu/autonomous-agent-evaluation')
  researchState.stepVisitedUrls.add('https://workflow.example.org/agent-benchmark')
  markOpenedDomain(researchState, 'venturebeat.com', 1)
  markOpenedDomain(researchState, 'manus.im', 1)
  markOpenedDomain(researchState, 'research.example.edu', 1)
  markOpenedDomain(researchState, 'forbes.com', 1)
  markOpenedDomain(researchState, 'workflow.example.org', 1)
  const researchActions = policy.evaluate(
    researchState,
    new Map(),
    'According to the opened source, Manus is positioned around autonomous agent orchestration, browser operation, and tool execution rather than a normal chatbot. The source reports its differentiators as multi-step task execution and enterprise workflow automation.',
    false,
    30,
  )
  assert.equal(researchState.currentStepIdx, 1, 'full-depth research synthesis should advance instead of no-tool blocking')
  assert.ok(researchActions.some((action) => action.type === 'step_advance'))
  assert.ok(!researchActions.some((action) => action.type === 'terminate'))

  const zeroToolResearchState = createInitialState(false, timeouts)
  zeroToolResearchState.taskStrategy = 'research'
  zeroToolResearchState.currentPhase = 'research'
  zeroToolResearchState.currentPlanItems = [
    "Research Manus AI's core technology",
    "Compare Manus AI with other AI platforms",
    "Investigate Manus AI's approach to ethical AI, safety, and explainability",
    'Deliver final report',
  ]
  zeroToolResearchState.currentPlanScopes = [
    'Technology only.',
    'Comparative capabilities only.',
    'Ethics, safety, governance, and explainability only.',
    'Final synthesis.',
  ]
  zeroToolResearchState.currentStepIdx = 2
  zeroToolResearchState.consecutiveNoToolCalls = 8
  const zeroToolActions = policy.evaluate(
    zeroToolResearchState,
    new Map(),
    "I will now synthesize these findings into a comparative report on Manus AI's differentiation.",
    false,
    30,
  )
  assert.equal(zeroToolResearchState.currentStepIdx, 2)
  assert.ok(!zeroToolActions.some((action) => action.type === 'terminate'), 'zero-tool research step should not stop the whole run')
  assert.ok(zeroToolActions.some((action) => action.message?.content?.includes('RESEARCH STEP HAS ZERO TOOL CALLS')))

  const falseAccessState = createInitialState(false, timeouts)
  falseAccessState.taskStrategy = 'research'
  falseAccessState.currentPhase = 'research'
  falseAccessState.currentPlanItems = [
    'Run broad searches to surface every major publicly reported controversy',
    'Write the final report findings',
  ]
  falseAccessState.currentPlanScopes = [
    'Use live search/source evidence for publicly reported controversies.',
    'Synthesize only after research is complete.',
  ]
  falseAccessState.currentStepIdx = 0
  const falseAccessActions = policy.evaluate(
    falseAccessState,
    new Map([[0, {
      id: 'false-access-read',
      name: 'read_file',
      arguments: JSON.stringify({
        path: 'research-notes/step-2.md',
        action_label: 'Inspect existing research artifacts',
        plan_step_index: 1,
      }),
    }]]),
    'I’m blocked from doing the broad searches step properly right now because this chat environment/tools lack live access. Without live access, I can’t produce a credible controversy report yet.',
    false,
    30,
  )
  assert.ok(falseAccessActions.some((action) => action.message?.content?.includes('FALSE LIVE-ACCESS BLOCKER')), 'false live-access blocker narration must trigger source-tool recovery')
  assert.ok(!falseAccessActions.some((action) => action.type === 'terminate'), 'false live-access blocker should recover instead of ending the task')

  const researchDetourEvents: Array<{ type: string; name?: string; result?: unknown }> = []
  const researchDetourEmitter = {
    get isClosed() { return false },
    get terminalStatus() { return null },
    toolStart(_id: string, name: string) { researchDetourEvents.push({ type: 'tool_start', name }) },
    toolResult(_id: string, name: string, result: unknown) { researchDetourEvents.push({ type: 'tool_result', name, result }) },
    terminalOutput() {},
    creditEvent() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
    browserFrame() {},
  }
  const researchDetourState = createInitialState(false, timeouts)
  researchDetourState.taskStrategy = 'research'
  researchDetourState.currentPhase = 'research'
  researchDetourState.currentPlanItems = [
    'Run broad searches to surface every major publicly reported controversy',
    'Write the final report findings',
  ]
  researchDetourState.currentPlanScopes = [
    'Use live search/source evidence for publicly reported controversies.',
    'Synthesize only after research is complete.',
  ]
  researchDetourState.currentStepIdx = 0
  const researchDetourPipeline = new ToolPipeline(researchDetourEmitter as any, 'research-detour-smoke')
  const detourReadResults = await researchDetourPipeline.executeAll(new Map([[0, {
    id: 'detour-read-file',
    name: 'read_file',
    arguments: JSON.stringify({
      path: 'research-notes/step-2.md',
      action_label: 'Inspect existing research artifacts',
      plan_step_index: 1,
    }),
  }]]), researchDetourState)
  assert.equal(researchDetourEvents.filter((event) => event.type === 'tool_start').length, 0, 'research artifact read_file detour must be blocked before visible tool_start')
  assert.match(JSON.stringify(detourReadResults[0]?.result || {}), /live research phase/)

  const detourWriteResults = await researchDetourPipeline.executeAll(new Map([[0, {
    id: 'detour-create-file',
    name: 'create_file',
    arguments: JSON.stringify({
      path: 'research-notes/step-2.md',
      content: 'I am blocked from doing this broad searches step because this chat environment lacks live access, so this note records the limitation instead of source evidence.',
      action_label: 'Log web access limitation',
      plan_step_index: 1,
    }),
  }]]), researchDetourState)
  assert.equal(researchDetourEvents.filter((event) => event.type === 'tool_start').length, 0, 'research blocker-note create_file detour must be blocked before visible tool_start')
  assert.match(JSON.stringify(detourWriteResults[0]?.result || {}), /Do not create\\/read research notes/)

  const searchBalanceEvents: Array<{ type: string; name?: string; result?: unknown }> = []
  const searchBalanceEmitter = {
    get isClosed() { return false },
    get terminalStatus() { return null },
    toolStart(_id: string, name: string) { searchBalanceEvents.push({ type: 'tool_start', name }) },
    toolResult(_id: string, name: string, result: unknown) { searchBalanceEvents.push({ type: 'tool_result', name, result }) },
    terminalOutput() {},
    creditEvent() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
    browserFrame() {},
  }
  const searchBalanceState = createInitialState(false, timeouts)
  searchBalanceState.taskStrategy = 'research'
  searchBalanceState.currentPhase = 'research'
  searchBalanceState.currentPlanItems = [
    'Map current agentic AI market evidence',
    'Write the final report',
  ]
  searchBalanceState.currentPlanScopes = [
    'Use web search to find candidates and source extraction for concrete evidence.',
    'Synthesize from gathered evidence.',
  ]
  searchBalanceState.currentStepIdx = 0
  searchBalanceState.stepSearchQueries.add('agentic ai market size 2026')
  searchBalanceState.stepSearchQueries.add('agentic ai enterprise adoption 2026')
  searchBalanceState.stepToolTypeCounts.set('web_search', 2)
  const searchBalancePipeline = new ToolPipeline(searchBalanceEmitter as any, 'search-balance-smoke')
  const searchBalanceResults = await searchBalancePipeline.executeAll(new Map([[0, {
    id: 'search-balance-extra-search',
    name: 'web_search',
    arguments: JSON.stringify({
      query: 'agentic ai regulation 2026',
      action_label: 'Compare agentic AI regulation signals',
      plan_step_index: 1,
    }),
  }]]), searchBalanceState)
  assert.equal(searchBalanceEvents.filter((event) => event.type === 'tool_start').length, 0, 'search-only research chains must be blocked before visible tool_start')
  assert.match(JSON.stringify(searchBalanceResults[0]?.result || {}), /no opened or extracted source pages yet/)

  const deliverableRevisionEvents: Array<{ type: string; name?: string; result?: unknown }> = []
  const deliverableRevisionEmitter = {
    get isClosed() { return false },
    get terminalStatus() { return null },
    toolStart(_id: string, name: string) { deliverableRevisionEvents.push({ type: 'tool_start', name }) },
    toolResult(_id: string, name: string, result: unknown) { deliverableRevisionEvents.push({ type: 'tool_result', name, result }) },
    terminalOutput() {},
    creditEvent() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
    browserFrame() {},
  }
  const deliverableRevisionState = createInitialState(false, timeouts)
  deliverableRevisionState.taskStrategy = 'research'
  deliverableRevisionState.currentPhase = 'deliver'
  deliverableRevisionState.currentPlanItems = ['Research official release signals', 'Write final probability report']
  deliverableRevisionState.currentStepIdx = 1
  deliverableRevisionState.pendingDeliverableRevision = {
    path: 'deliverables/probability-report.md',
    failures: ['Only 0 citation(s), minimum 2'],
    suggestions: ['Add source URLs to support claims'],
    createdAt: Date.now(),
  }
  const deliverableRevisionPipeline = new ToolPipeline(deliverableRevisionEmitter as any, 'deliverable-revision-smoke')
  const deliverableRevisionResults = await deliverableRevisionPipeline.executeAll(new Map([[0, {
    id: 'revision-recreate',
    name: 'create_file',
    arguments: JSON.stringify({
      path: 'deliverables/probability-report.md',
      content: 'This replacement report tries to restart the existing final deliverable instead of revising it with the missing source citations.',
      action_label: 'Write replacement probability report',
      plan_step_index: 2,
    }),
  }]]), deliverableRevisionState)
  assert.equal(deliverableRevisionEvents.filter((event) => event.type === 'tool_start').length, 0, 'pending deliverable revision must block recreate before visible tool_start')
  assert.match(JSON.stringify(deliverableRevisionResults[0]?.result || {}), /already exists and needs a targeted final-deliverable revision/)
  assert.match(JSON.stringify(deliverableRevisionResults[0]?.result || {}), /append_file or edit_file/)

  const attachmentEvents: Array<{ type: string; name?: string; result?: unknown }> = []
  const attachmentEmitter = {
    get isClosed() { return false },
    get terminalStatus() { return null },
    toolStart(_id: string, name: string) { attachmentEvents.push({ type: 'tool_start', name }) },
    toolResult(_id: string, name: string, result: unknown) { attachmentEvents.push({ type: 'tool_result', name, result }) },
    terminalOutput() {},
    creditEvent() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
    browserFrame() {},
  }
  const attachmentState = createInitialState(false, timeouts)
  attachmentState.originalUserRequest = 'what is this?'
  attachmentState.currentPlanItems = ['Read uploaded attachment: Information Note', 'Answer from attachment']
  attachmentState.currentPlanScopes = ['Uploaded file context only.', 'Summarize from the uploaded content.']
  attachmentState.currentStepIdx = 0
  attachmentState.uploadedAttachmentContextAvailable = true
  attachmentState.uploadedAttachmentContentAvailable = true
  attachmentState.uploadedAttachmentNames = ['Information Note - Year 11 Geography Millers Point.pdf']
  const attachmentPipeline = new ToolPipeline(attachmentEmitter as any, 'attachment-guard-smoke')

  const searchResults = await attachmentPipeline.executeAll(new Map([[0, {
    id: 'attachment-search',
    name: 'web_search',
    arguments: JSON.stringify({
      query: 'Locate the Year 11 Geography Millers Point PDF',
      action_label: 'Locate uploaded PDF online',
      plan_step_index: 1,
    }),
  }]]), attachmentState)
  assert.equal(attachmentEvents.filter((event) => event.type === 'tool_start').length, 0, 'attachment filename web_search must be blocked before visible tool_start')
  assert.match(JSON.stringify(searchResults[0]?.result || {}), /Do not web_search uploaded attachment filenames or titles/)

  const readResults = await attachmentPipeline.executeAll(new Map([[0, {
    id: 'attachment-read-file',
    name: 'read_file',
    arguments: JSON.stringify({
      path: 'Information Note - Year 11 Geography Millers Point.pdf',
      action_label: 'Open uploaded PDF file',
      plan_step_index: 1,
    }),
  }]]), attachmentState)
  assert.equal(attachmentEvents.filter((event) => event.type === 'tool_start').length, 0, 'uploaded attachment read_file must be blocked before visible tool_start')
  assert.match(JSON.stringify(readResults[0]?.result || {}), /Do not use read_file for uploaded attachment names/)
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
      packages: 'external',
      external: [
        'playwright',
        'playwright-core',
        'chromium-bidi',
        'chromium-bidi/*',
      ],
    })

    const { runLedgerSmoke } = await import(pathToFileURL(bundlePath).href)
    await runLedgerSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await assertSourceContracts()
await assertLedgerRuntime()
console.log('agent runtime contract smoke checks passed')
