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
    streamConstants,
    eventDispatcher,
    artifactSlice,
    searchResults,
    artifacts,
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
    taskWorker,
    e2bSandbox,
    taskQueue,
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
    activityDescriber,
    streamProcessor,
    agentConfig,
    toolRetry,
    toolCache,
    outputVerifier,
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
    mobileUnsupportedGate,
  ] = await Promise.all([
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/browser.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/constants.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/store/chat/artifactSlice.ts'), 'utf8'),
    readFile(join(root, 'src/components/computer/SearchResults.tsx'), 'utf8'),
    readFile(join(root, 'src/types/artifacts.ts'), 'utf8'),
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
    readFile(join(root, 'src/worker/taskWorker.ts'), 'utf8'),
    readFile(join(root, 'src/lib/e2bSandbox.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskQueue.ts'), 'utf8'),
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
    readFile(join(root, 'src/lib/stream/ActivityDescriber.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolRetry.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolCache.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/OutputVerifier.ts'), 'utf8'),
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
    readFile(join(root, 'src/components/layout/MobileUnsupportedGate.tsx'), 'utf8'),
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
  assert.match(planManager, /PLANNER_ACK_MAX_TOKENS = 128/, 'planner acknowledgements must stay bounded while leaving visible room for the active model')
  assert.match(planManager, /PLANNER_JSON_MAX_TOKENS = 1536/, 'planner JSON calls must avoid overlarge completion caps')
  assert.match(planManager, /REPLAN_JSON_MAX_TOKENS = 768/, 'replanning JSON calls must use a compact output cap')
  assert.doesNotMatch(planManager, /max_tokens: 2048/, 'planner calls must not keep the old overlarge 2048-token cap')
  assert.ok((planManager.match(/includeTemporalContext:\s*false/g) || []).length >= 5, 'planner, ack, and replan calls should not pay for automatic temporal context')
  assert.match(prompts, /Do not default to 3 or 4 steps/, 'planner prompt must keep step count flexible by task complexity')
  assert.match(prompts, /Avoid repair loops/, 'planner prompt must directly request runtime-valid plan shapes to avoid extra repair calls')
  assert.doesNotMatch(prompts, /Minimum 3 steps except/, 'planner prompt must not impose a blanket 3-step minimum')
  assert.match(planManager, /getPlanningPrompt\(this\.customInstructions\)/, 'PlanManager must pass custom instructions into planning')
  assert.match(planManager, /CUSTOM INSTRUCTIONS TO APPLY IN THIS STEP/, 'per-step guidance must preserve custom instruction compliance without duplicating the full saved text')
  assert.match(planManager, /root system prompt and current plan/, 'per-step custom guidance should reference the root custom instructions instead of repeating them every turn')
  assert.match(planManager, /CUSTOM INSTRUCTIONS STILL APPLY/, 'custom instructions must be preserved during replanning')
  assert.match(planManager, /visible step count/, 'planner repair must preserve custom visible step-count instructions')
  assert.match(planManager, /do not supersede safety, permissions, sandbox\/tool availability, or core runtime rules/, 'planner repair must not let custom instructions override safety or core runtime constraints')
  assert.match(planManager, /Do not let saved custom instructions override safety, permissions, sandbox\/tool availability, or core runtime rules/, 'per-step custom guidance must preserve safety and core runtime constraints')
  assert.match(planManager, /fixed number of steps\/phases.*binding for the visible plan/s, 'per-step custom guidance must treat custom phase count as binding')
  assert.match(planManager, /parseVisibleStepCountInstruction/, 'PlanManager must detect custom visible step-count instructions')
  assert.match(planManager, /customInstructionVisibleStepCount\(\) !== null && steps\.length > 0\) return steps/, 'default step expansion must not override custom visible step-count instructions')
  assert.match(planManager, /applyCustomInstructionPlanRequirements/, 'planner must convert custom instruction requirements into concrete plan steps')
  assert.match(planManager, /planAwareIterationFloor/, 'plan sizing must raise the global iteration cap for multi-phase tasks')
  assert.match(planManager, /state\.dynamicIterationLimit = boundedPlanFloor/, 'plan-aware iteration floors must update the live dynamic cap before work starts')
  assert.match(planManager, /Math\.min\(planFloor,\s*MAX_ITERATIONS\)/, 'plan-aware iteration floors must be capped to prevent runaway cost')
  assert.match(planManager, /emitFastStartPlan\(\)[\s\S]*this\.emitter\.plan\(withRequired\.titles\)[\s\S]*state\.planEmitted = true/, 'initial tasks must emit a fast-start plan before any slow planner/model roundtrip')
  assert.match(planManager, /if \(this\.emitFastStartPlan\(\)\) \{[\s\S]*this\.planPromise = Promise\.resolve\(null\)[\s\S]*return/, 'PlanManager startup must not wait on a planner LLM call after fast-start planning succeeds')
  assert.match(agentLoop, /function shouldRunStartupResearchSearch\(state: AgentStateData\)[\s\S]*state\.taskStrategy === 'research'[\s\S]*state\.taskStrategy === 'analysis'/, 'research startup must decide bootstrap search locally instead of waiting on the first model tool-selection turn')
  assert.match(agentLoop, /runStartupResearchSearch\([\s\S]*toolPipeline\.executeAll\(toolCalls,\s*state,\s*''\)/, 'startup research search must execute through ToolPipeline so it emits real tool events and server credit charges')
  assert.match(agentLoop, /lastToolResults = await this\.runStartupResearchSearch\([\s\S]*phase = 'STREAMING'/, 'startup research search must run after planning and before the first streaming model call')
  assert.match(agentLoop, /STARTUP SEARCH COMPLETE:[\s\S]*Do not repeat this exact query/, 'bootstrap search results must be injected into model context to prevent duplicate first searches')
  assert.match(agentConfig, /BASE_ITERATIONS\s*=\s*36/, 'long tasks need a larger base iteration budget')
  assert.match(agentConfig, /MAX_ITERATIONS\s*=\s*112/, 'long tasks need a higher global iteration ceiling')
  assert.match(agentConfig, /COMPLEXITY_ITERATION_BONUS\s*=\s*\{\s*1:\s*0,\s*2:\s*28,\s*3:\s*64\s*\}/, 'complex research tasks need expanded iteration bonus')
  assert.match(agentLoop, /new PlanManager\(this\.emitter,\s*planningMessages,\s*complexity,\s*requiredFirstSteps,\s*customInstructions,\s*recordPlannerUsage,\s*assertPlannerCreditRunway,\s*this\.options\.skipStartupAcknowledgement === true\)/, 'AgentLoop must wire custom instructions, credit usage, credit preflight, and startup acknowledgement control into PlanManager')
  assert.match(agentLoop, /latestUserMessage = \[\.\.\.messages\]\.reverse\(\)\.find\(m => m\.role === 'user'\)/, 'prompt-injection checks must only inspect the latest user turn')
  assert.doesNotMatch(agentLoop, /messages\.some\(\s*\n\s*m => m\.role === 'user' && isPromptInjection/, 'old user messages must not poison later unrelated tasks')
  assert.match(planManager, /Boot local preview/, 'website plans must still require local visual QA')
  assert.doesNotMatch(planManager, /deterministic|Deterministic|shouldUseDeterministic|Used deterministic/, 'planner must not use deterministic shortcut planning paths')
  assert.doesNotMatch(planManager, /browserActionPlanTemplate|websiteBuildPlanTemplate|codePlanTemplate|longWritingPlanTemplate|simpleFilePlanTemplate/, 'planner must not fabricate hard-coded plan templates')
  assert.match(planManager, /Read selected skill file/, 'skill/file plans must keep an explicit read phase')
  assert.match(planManager, /Use visual screenshot state plus fresh indexed controls/, 'browser action plans must require visual + indexed control verification')
  assert.match(planManager, /isSingleWebSearchMarkdownTask\(this\.messages\)[\s\S]*steps\.length !== 2[\s\S]*return steps/, 'single-search markdown plans must accept valid model-authored two-step plans without local generation')
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
  assert.match(agentConfig, /AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS\s*=\s*45_000/, 'deadline model turns must be capped during finalization')
  assert.match(agentConfig, /AGENT_DEADLINE_HARD_STOP_BUFFER_MS\s*=\s*35_000/, 'agent runtime must keep a hard stop buffer before route termination')
  assert.match(agentState, /runStartedAtMs/, 'agent state must track wall-clock start time for long task deadline handling')
  assert.match(agentState, /deadlineFinalizationStarted/, 'agent state must ensure deadline finalization is entered only once')
  assert.match(agentLoop, /maybeStartDeadlineFinalization/, 'agent loop must force final synthesis before a platform timeout can kill the stream')
  assert.match(agentLoop, /RUNTIME FINALIZATION DEADLINE/, 'deadline finalization prompt must stop new research and create the deliverable')
  assert.match(agentLoop, /deadlineFinalTools/, 'deadline finalization must expose only deliverable tools, not more research tools')
  assert.match(agentLoop, /agentRunRemainingMs\(state\) - AGENT_DEADLINE_HARD_STOP_BUFFER_MS/, 'deadline finalization model calls must stay below the remaining platform time')
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
  assert.match(homeSubmit, /setRouteHandoffPending\(true\)[\s\S]*router\.push\(`\/chat\/\$\{id\}`\)/, 'home submit must show the route handoff skeleton before pushing the new chat route')
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
  assert.match(rootOverlays, /<MobileUnsupportedGate \/>/, 'root overlays must include the mobile unsupported gate')
  assert.match(mobileUnsupportedGate, /AUTH_ROUTES = new Set\(\['\/sign-in', '\/sign-up'\]\)/, 'mobile unsupported gate must not block sign-in or sign-up')
  assert.match(mobileUnsupportedGate, /status === 'authenticated' && mobile && !isAuthRoute\(pathname\)/, 'mobile unsupported gate must only block authenticated non-auth app routes')
  assert.match(mobileUnsupportedGate, /MOBILE_QUERY = '\(max-width: 767px\)'/, 'mobile unsupported gate must track the app mobile breakpoint')
  assert.match(mobileUnsupportedGate, /role="alertdialog"/, 'mobile unsupported gate must be announced as an alert dialog')
  assert.match(mobileUnsupportedGate, /Monitor size=\{21\}/, 'mobile unsupported gate must show a desktop monitor icon')
  assert.match(mobileUnsupportedGate, /Agent is not mobile optimized yet\. Please view on desktop\./, 'mobile unsupported copy must tell users to use desktop')
  assert.match(mobileUnsupportedGate, /data-no-focus-ring/, 'mobile unsupported panel must not show the global focus ring around the border')
  assert.doesNotMatch(mobileUnsupportedGate, /onClick|onClose|Escape|Close dialog|setVisible\(false\)/, 'mobile unsupported gate must be non-dismissible')
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
  assert.match(chatServerSync, /serverSummary/, 'client sync must mark account task index rows as metadata-only summaries')
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
  assert.match(agentMessage, /splitTaskMessageContent\(cleanedContent,\s*hasGroups \|\| hasSteps\)/, 'task message rendering must use the shared acknowledgement splitter')
  assert.match(agentMessage, /cleanThinkingTokens\(message\.content\)/, 'rendered assistant messages must clean already-persisted raw tool metadata leaks')
  assert.match(taskMessageContent, /shouldMergeAcknowledgmentParagraph/, 'acknowledgement splitting must merge provider-inserted paragraph breaks')
  assert.match(taskMessageContent, /FINAL_CONTENT_START_PATTERN/, 'acknowledgement splitting must keep final summaries out of the header acknowledgement')
  assert.match(streamCleaners, /stripDisplayToolArgJsonLeaks/, 'stream cleaners must strip raw JSON display-argument leaks')
  assert.match(streamCleaners, /JSON_CHANNEL_MARKER_PATTERN/, 'stream cleaners must strip provider JSON-channel markers')
  assert.match(eventDispatcher, /purpose:\s*'deliverable'/, 'recovered artifacts must carry deliverable purpose')
  assert.match(artifacts, /ArtifactPurpose = 'deliverable' \| 'support' \| 'internal'/, 'artifacts must have purpose metadata')
  assert.match(agentLoop, /image_url:\s*\{ url: att\.content!, detail: 'high' \}/, 'image attachments must reach the model as image_url parts')
  assert.match(agentLoop, /visualImageUploadedAttachments/, 'agent loop must distinguish visual image attachments from text attachments')
  assert.match(agentLoop, /Visually inspect uploaded image/, 'image attachment preflight must be framed as visual inspection')
  assert.match(agentLoop, /Do not create browser\/open\/current-view\/extract-text\/read_file\/web_search steps/, 'planner image context must forbid browser/current-view detours for uploaded images')
  assert.match(agentLoop, /state\.uploadedImageAttachmentAvailable = visualImageUploadedAttachments/, 'agent state must record uploaded image visual input availability')
  assert.match(planManager, /visualInput\?: boolean/, 'required preloaded steps must be able to mark image visual input')
  assert.match(planManager, /Load uploaded image visual input/, 'preloaded image attachment event must render as visual input loading')
  assert.match(agentLoop, /Read this skill first/, 'skill attachments must be loaded before the agent starts work')
  assert.match(agentLoop, /attachmentContextForPlanning/, 'uploaded attachment text must be included in bounded planner context')
  assert.match(agentLoop, /requiredAttachmentPlanSteps/, 'uploaded attachments must get a preloaded read step before runtime work')
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
  assert.match(planManager, /this\.emitter\.textDelta\(ack \+ '\\n\\n'\)/, 'task acknowledgement should come from the planner/model ack field')
  assert.doesNotMatch(planManager, /max_tokens:\s*80/, 'acknowledgement calls must not use a tiny token cap that high reasoning can consume before visible text')
  assert.match(planManager, /max_tokens:\s*PLANNER_ACK_MAX_TOKENS/, 'acknowledgement calls should stay bounded while leaving room for a task-specific sentence')
  assert.match(planManager, /PLANNER_CONTROL_REASONING = \{ effort: 'minimal' as const, exclude: true \}/, 'planner control calls must not spend medium reasoning budget before emitting JSON or acknowledgement text')
  assert.ok((planManager.match(/reasoning:\s*PLANNER_CONTROL_REASONING/g) || []).length >= 5, 'planner ack, initial plan, repair, and replan calls should use planner control reasoning')
  assert.match(agentLoop, /state\.taskComplexity >= 2 \? 1536 : 768/, 'non-agentic stream iterations should stay lean outside deliverable/file-writing turns')
  assert.match(planManager, /PLANNER_QUALITY_ERROR/, 'missing acknowledgement or plan quality must fail hard instead of continuing silently')
  assert.doesNotMatch(planManager, /emitSyntheticPlan/, 'planner must not emit synthetic backup plans when model planning fails')
  assert.doesNotMatch(planManager, /buildEmergencyPlannerResponse|emergencyPlan|emergencyPlanner/, 'planner must not use local emergency fallback plans when model planning fails')
  assert.match(planManager, /repairPlannerResponse/, 'invalid planner JSON must be repaired before failing the task')
  assert.match(planManager, /isPlannerQualityError/, 'planner quality failures must be classified for model repair')
  assert.match(planManager, /QUALITY FAILURE TO FIX/, 'planner repair must include quality-gate failure context')
  assert.match(planManager, /repairPlannerResponse\(raw,\s*PLANNER_QUALITY_ERROR\)/, 'parseable but low-quality planner output must be repaired before failing')
  assert.match(planManager, /INVALID ACK TO REPLACE/, 'invalid generated acknowledgements must get one model-authored retry')
  assert.match(planManager, /response_format:\s*\{\s*type:\s*'json_object'\s*\}/, 'planner calls should request strict JSON when the provider supports it')
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
  assert.match(toolPipeline, /phaseSemanticBlockReason/, 'tool pipeline must block future-phase semantic drift before executing tools')
  assert.match(toolPipeline, /appears to continue previous step/, 'tool pipeline must block previous-phase semantic drift before executing tools')
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
  assert.match(eventDispatcher, /if \(!modelActionLabel\) return/, 'tool starts without strict model-authored action labels must not create visible pills')
  assert.match(eventDispatcher, /labelSource:\s*'model'/, 'visible task pills must preserve model-authored labels only')
  assert.match(useAgentStream, /isContextualTaskUpdateText/, 'client must only preserve sandbox state for contextual task updates')
  assert.match(useAgentStream, /isFirstTaskAutoStart \|\| \(!isAutoSend && !isContextualTaskUpdateText\(latestUserContent\)\)/, 'new user tasks and first-prompt auto-starts should start with an isolated sandbox')
  assert.match(chatRoute, /startIsolatedTaskSandbox/, 'server must enforce per-task sandbox isolation')
  assert.match(chatRoute, /resetSandboxDir\(conversationId\)/, 'isolated tasks must reset the sandbox before tool execution')
  assert.match(chatRoute, /isTruncatedFinishReason/, 'direct chat must detect provider length stops before displaying a response')
  assert.match(chatRoute, /isLikelyIncompleteDirectAnswer/, 'direct chat must detect mid-sentence answers even when the provider reports success')
  assert.match(chatRoute, /Continue exactly from the next word/, 'direct chat must request a continuation instead of showing cut-off text')
  assert.match(chatRoute, /chargeServerTokenUsage\(userId,\s*conversationId,\s*creditRunId,\s*creditUsage,\s*`direct:\$\{attempt \+ 1\}`\)/, 'direct chat continuation calls must be charged with distinct server ledger ids')
  assert.match(chatRoute, /DIRECT_CHAT_MAX_TOKENS = 1536/, 'direct chat should keep concise answers on a smaller completion cap')
  assert.match(chatRoute, /DIRECT_CHAT_CONTINUATION_MAX_TOKENS = 768/, 'direct chat continuations should stay compact')
  assert.match(chatRoute, /directChatNeedsConversationContext/, 'direct chat should avoid paying for history on standalone questions')
  assert.match(chatRoute, /return cleanMessages\.slice\(-1\)/, 'standalone direct chat should send only the latest user message')
  assert.match(chatRoute, /DIRECT_CHAT_CONTEXT_REFERENCE_PATTERN/, 'context-dependent direct-chat follow-ups must still preserve history')
  assert.match(chatRoute, /directChatNeedsTemporalContext/, 'direct chat should only pay for temporal context on date/time questions')
  assert.match(chatRoute, /includeTemporalContext:\s*directChatNeedsTemporalContext\(messages\)/, 'direct chat temporal context must be gated by the latest user request')
  assert.doesNotMatch(chatRoute, /deterministic|Deterministic|DIRECT_CHAT_EXACT_|DIRECT_CHAT_GREETING_PATTERN|DIRECT_CHAT_THANKS_PATTERN|DIRECT_CHAT_ACK_PATTERN|preHydrationDeterministicReply/, 'chat route must not use deterministic no-model reply paths')
  assert.doesNotMatch(directChatRouting, /EXACT_LOCAL_TEMPORAL_PATTERN|EXACT_SIMPLE_ARITHMETIC_PATTERN/, 'direct chat routing must not force exact-match temporal or arithmetic shortcut paths')
  assert.match(directChatRouting, /good\\s\+\(\?:morning\|afternoon\|evening\)/, 'router should keep common greeting variants out of the full agent path')
  assert.match(directChatRouting, /thank you\|thx/, 'router should keep compact thanks variants out of the full agent path')
  assert.match(directChatRouting, /got it\|sounds good\|sure\|alright/, 'router should keep common acknowledgement variants out of the full agent path')
  assert.match(chatRoute, /const rawMessages = validation\.data\.messages[\s\S]*const directChat = shouldUseDirectChat\(rawMessages\)[\s\S]*const messages = directChat[\s\S]*hydrateMessageAttachmentsForUser\(rawMessages,\s*userId\)[\s\S]*await assertServerCreditsAvailable\(userId\)/, 'chat route should route before attachment hydration and require credits without deterministic bypasses')
  assert.match(chatRoute, /if \(conversationId\) \{[\s\S]*chargeServerTaskStart/, 'chat route should use one metering path without deterministic task-start bypasses')
  assert.match(chatRoute, /meteredTaskStarted[\s\S]*chargeActiveCredit/, 'active-time credit charging should only finalize for metered task starts')
  assert.match(titleRoute, /includeTemporalContext:\s*false/, 'title generation should not pay for temporal context')
  assert.doesNotMatch(titleRoute, /heuristicTitleFromMessage|deterministicDirectTitleFromMessage|TITLE_HEURISTIC|TITLE_EXACT|TITLE_GREETING|TITLE_DOMAIN|Quick Calculation|Exact Reply|Help Request|Agent Identity/, 'title route must not use local deterministic title paths')
  assert.match(titleRoute, /await assertServerCreditsAvailable\(userId\)[\s\S]*createCompletion/, 'title route should always use provider title generation after credit check')
  assert.match(llm, /DEFAULT_OPENROUTER_MODEL/, 'runtime must route through the centralized default OpenRouter model')
  assert.match(llm, /function trimmedEnv\(value: string \| undefined\)/, 'runtime must expose shared env trimming for provider settings')
  assert.match(llm, /DEFAULT_MODEL = trimmedEnv\(process\.env\.OPENROUTER_MODEL\) \|\| DEFAULT_OPENROUTER_MODEL/, 'provider model IDs must be trimmed before request routing')
  assert.match(llm, /value \|\| 'minimal'/, 'reasoning must default to minimal effort so the active model uses the requested thinking level')
  assert.match(llm, /'xhigh'/, 'runtime must preserve xhigh reasoning instead of normalizing it down when explicitly configured')
  assert.match(llm, /DEFAULT_REASONING_EXCLUDE = booleanEnv\(process\.env\.OPENROUTER_REASONING_EXCLUDE,\s*true\)/, 'reasoning exclude flag must tolerate whitespace-padded Vercel env values')
  assert.match(llm, /getOpenRouterApiKey[\s\S]*trimmedEnv\(process\.env\.OPENROUTER_API_KEY\)/, 'provider credentials must be trimmed before request headers are built')
  assert.match(llm, /effort: DEFAULT_REASONING_EFFORT/, 'all model calls must include the configured reasoning effort by default')
  assert.match(llm, /exclude: DEFAULT_REASONING_EXCLUDE/, 'internal reasoning should be excluded from user-visible responses by default')
  assert.match(llm, /usage:\s*\{\s*include:\s*true\s*\}/, 'OpenRouter calls must explicitly request usage data for compatibility')
  assert.match(llm, /ASSISTANT_LOG_LABEL\s*=\s*'Agent'/, 'provider/runtime internals must be redacted from logs')
  assert.match(llm, /temporalContextCache/, 'temporal context should be cached instead of rebuilt on every model call')
  assert.match(llm, /Now: \$\{localDateTime\}; UTC \$\{utcMinute\}/, 'temporal context should stay concise while preserving local and UTC time')
  assert.match(llm, /first\?\.role === 'system' && typeof first\.content === 'string'/, 'temporal context should merge into an existing first system message')
  assert.match(llm, /content: `\$\{first\.content\}\\n\\n\$\{temporalContext\}`/, 'merged temporal context must preserve existing system instructions')
  assert.match(llm, /includeTemporalContext === false \? messages : withCurrentTemporalContext\(messages\)/, 'internal calls must be able to opt out of temporal context')
  assert.doesNotMatch(llm, /Current date\/time:/, 'temporal context should not use the old verbose per-call wording')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.inputUsdPer1M/, 'credit policy must use the current default model input price')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.outputUsdPer1M/, 'credit policy must use the current default model output price')
  assert.match(creditPolicy, /BRAVE_SEARCH_USD_PER_1K_REQUESTS\s*=\s*5/, 'web search credit cost must be anchored to Brave Search API pricing')
  assert.match(creditPolicy, /IMAGE_SEARCH_USD_PER_1K_REQUESTS\s*=\s*0/, 'image search must not be charged as Brave Search API traffic')
  assert.match(creditPolicy, /TASK_START_CREDITS\s*=\s*0/, 'task starts must not create a fixed upfront debit')
  assert.match(creditPolicy, /LOCAL_BROWSER_USD_PER_STEP\s*=\s*0/, 'local browser tools must not use Browser Use Cloud pricing')
  assert.match(creditPolicy, /ACTIVE_CREDITS_PER_MINUTE\s*=\s*0/, 'idle wall-clock runtime must not drain credits')
  assert.match(serverCredits, /TASK_START_CREDITS <= 0\) return null/, 'task starts must be server no-ops when there is no real cost')
  assert.match(serverCredits, /chargeServerActiveTime/, 'active-time ledger function must remain as a no-op compatible contract')
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
  assert.match(planManager, /recordCompletionUsage\(res\.usage/, 'planner completion responses must record provider billing cost')
  assert.doesNotMatch(agentLoop, /chargeServerTokenUsage\(this\.options\.userId,\s*this\.options\.conversationId,\s*this\.options\.creditRunId,\s*totalUsage\)/, 'agent sessions must not double-charge final cumulative token usage')
  assert.match(agentLoop, /this\.emitter\.done\(totalUsage\)/, 'completed sessions must still send token usage metadata to the stream')
  assert.match(agentLoop, /FIXED_WEB_SEARCH_RUNTIME_TOOLS = new Set\(\['web_search'\]\)/, 'fixed-search tasks must not send the full tool schema to small model routes')
  assert.match(agentLoop, /explicitWebSearchLimitFromText\(state\.originalUserRequest \|\| ''\) !== null[\s\S]*filterToolDefinitions\(tools,\s*FIXED_WEB_SEARCH_RUNTIME_TOOLS\)/, 'fixed-search research phases must expose only web_search')
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
  assert.match(activeTaskConstants, /ACTIVE_TASK_CONFLICT_CODE = 'ACTIVE_TASK_RUNNING'/, 'active-task conflicts must use a stable shared response code')
  assert.match(activeTasks, /create table if not exists user_active_task_leases/, 'server must create an account-scoped active-task lease table')
  assert.match(activeTasks, /primary key \(queue_name, user_id\)/, 'active-task leases must allow only one live task per authenticated user per queue')
  assert.match(activeTasks, /conversation_id text not null/, 'active-task leases must identify the running conversation for cross-browser routing')
  assert.match(activeTasks, /insert or ignore into user_active_task_leases/, 'active-task acquisition must be atomic under concurrent starts')
  assert.match(activeTasks, /delete from user_active_task_leases where expires_at_ms <= \? or updated_at_ms <= \?/, 'expired active-task leases must be cleared before acquisition')
  assert.match(activeTasks, /export async function refreshActiveTaskLease/, 'active tasks must refresh their account-wide lease while streaming')
  assert.match(activeTasks, /where queue_name = \? and user_id = \? and run_id = \?/, 'active-task release must only clear the matching running task in the current queue')
  assert.match(activeTasks, /export async function getActiveTaskLeaseForUser/, 'server must expose the current active task lease for reopen/resume discovery')
  assert.match(taskQueue, /AGENT_TASK_QUEUE_NAME/, 'task queue namespace must be configurable per deployment')
  assert.match(taskJobs, /export async function findActiveTaskJobForConversation/, 'server must discover active queued or running jobs from durable task state')
  assert.match(taskJobs, /export async function findActiveTaskJobForUser/, 'server must discover account-wide active jobs even if the short active-task lease expired')
  assert.match(taskJobs, /queue_name text not null default 'default'/, 'durable task jobs must store the deployment queue namespace')
  assert.match(taskJobs, /and queue_name = \?/, 'durable task job queries must be scoped to the current queue namespace')
  assert.match(taskJobs, /where user_id = \? and run_id = \? and queue_name = \?/, 'durable task cancellation must be scoped to the current queue namespace')
  assert.match(taskJobs, /where run_id = \? and queue_name = \?/, 'durable invalid-payload handling must be scoped to the current queue namespace')
  assert.match(taskJobs, /status in \('queued', 'running'\)/, 'active job discovery must include queued jobs that have not been claimed yet')
  assert.match(taskJobs, /cancel_requested = 0/, 'active job discovery must exclude cancelled jobs')
  assert.match(taskJobs, /TASK_JOB_DB_POLL_MS = 250/, 'persisted task event replay must poll fast enough for early acknowledgement')
  assert.match(taskJobs, /let pollInFlight = false[\s\S]*if \(closed \|\| pollInFlight\) return[\s\S]*pollInFlight = true[\s\S]*finally\(\(\) => \{[\s\S]*pollInFlight = false/, 'persisted task event replay must not overlap Turso polls and duplicate the same seq events')
  assert.match(taskJobs, /job\.conversationId !== input\.conversationId/, 'in-memory task event replay must reject run ids from a different conversation')
  assert.match(taskJobs, /snapshot\.conversationId !== input\.conversationId/, 'persisted task event replay must reject run ids from a different conversation')
  assert.match(useAgentStream, /let highestDispatchedSeq = 0[\s\S]*if \(seq <= highestDispatchedSeq\) continue[\s\S]*highestDispatchedSeq = seq/, 'client stream consumer must ignore duplicate persisted seq events before dispatch')
  assert.match(taskWorker, /DEFAULT_WORKER_POLL_MS = 250/, 'cloud worker must poll the queue quickly enough for sub-second claim latency')
  assert.match(taskWorker, /prewarmE2BSandbox\('worker-startup'\)/, 'worker readiness must include a prewarmed E2B sandbox and browser')
  assert.match(e2bSandbox, /warmSandboxPromise/, 'E2B runtime must track an in-process warm sandbox promise')
  assert.match(e2bSandbox, /adoptWarmE2BSandbox/, 'E2B runtime must adopt a prewarmed sandbox for the next task')
  assert.match(e2bSandbox, /ensureE2BRemoteBrowser\(warmId\)/, 'E2B warm pool must start Chromium before task acknowledgement')
  assert.match(chatTaskRunner, /ensureE2BRemoteBrowser\(conversationId\)/, 'worker task startup must ensure the task browser exists before acknowledgement')
  assert.match(chatTaskRunner, /Cloud sandbox and browser are ready/, 'worker must emit the first visible acknowledgement only after sandbox and browser readiness')
  assert.match(chatTaskRunner, /skipStartupAcknowledgement: startupAcknowledgementSent/, 'agent loop must skip planner acknowledgement after the sandbox-ready acknowledgement')
  assert.match(planManager, /if \(this\.skipAcknowledgement\) return/, 'planner must not emit a duplicate acknowledgement after worker startup text')
  assert.match(chatRoute, /acquireActiveTaskLease\(userId,\s*conversationId,\s*creditRunId\)/, 'chat route must acquire the account-wide active-task lease before starting a new task')
  assert.match(chatRoute, /findActiveTaskJobForUser\(userId\)/, 'chat route must reject new starts when a durable queued or running job already exists')
  assert.match(chatRoute, /status:\s*409/, 'second concurrent task starts must return a conflict response')
  assert.match(chatRoute, /ACTIVE_TASK_CONFLICT_CODE/, 'chat route conflict responses must include the shared active-task code')
  assert.match(chatRoute, /setInterval\(\(\) => \{[\s\S]*refreshActiveTaskLease\(userId,\s*creditRunId\)/, 'streaming chat route must keep the active-task lease alive during long tasks')
  assert.match(chatRoute, /releaseActiveTaskLease\(userId,\s*creditRunId\)/, 'chat route must release the active-task lease when the stream finishes or aborts')
  assert.match(chatRoute, /conversationId:\s*authenticated\.conversationId/, 'resume stream requests must bind run replay to the requested conversation')
  assert.match(chatRoute, /conversationId,\s*\n\s*afterSeq: 0/, 'initial stream requests must bind run replay to the created conversation')
  assert.match(activeChatRoute, /assertSameOriginRequest/, 'active-run discovery route must enforce same-origin requests')
  assert.match(activeChatRoute, /assertInviteAccessApproved/, 'active-run discovery route must enforce invite access')
  assert.match(activeChatRoute, /assertTaskAccess/, 'active-run discovery route must enforce task ownership before returning a run id')
  assert.match(activeChatRoute, /findActiveTaskJobForConversation/, 'active-run discovery route must prefer durable job state over expiring active-task leases')
  assert.match(activeChatRoute, /getActiveTaskLeaseForUser/, 'active-run discovery route must read the active lease from the server')
  assert.match(activeChatRoute, /lease\.conversationId !== conversationId/, 'active-run discovery route must not return another task run id')
  assert.match(useAgentStream, /ACTIVE_TASK_CONFLICT_CODE/, 'client stream must recognize active-task conflict responses')
  assert.match(useAgentStream, /response\.status === 409/, 'client stream must treat HTTP 409 as a concurrent-task conflict')
  assert.match(useAgentStream, /showActiveTaskConflict/, 'client stream must show the active-task conflict modal instead of starting another task')
  assert.match(useAgentStream, /pendingIds/, 'client stream must remove pending optimistic messages after a rejected concurrent task start')
  assert.match(useAgentStream, /fetchServerActiveRun/, 'client stream must query the server for active run ids when localStorage has no resume record')
  assert.match(useAgentStream, /getStoredActiveRun\(conversationId\) \|\| await fetchServerActiveRun\(conversationId\)/, 'resume must fall back to server active-run discovery before giving up')
  assert.match(uiStore, /activeTaskConflictModal/, 'UI store must hold active-task conflict modal state')
  assert.match(uiStore, /showActiveTaskConflict/, 'UI store must expose a conflict modal opener')
  assert.match(uiStore, /dismissActiveTaskConflict/, 'UI store must expose a dismiss action for the conflict modal')
  assert.match(rootOverlays, /<ActiveTaskConflictModal \/>/, 'root overlays must mount the active-task conflict modal globally')
  for (const [name, source] of Object.entries({
    modal,
    chatInput,
    userMessage,
    mobileUnsupportedGate,
    imagePreview: await readFile(join(root, 'src/components/chat/ImagePreview.tsx'), 'utf8'),
    conversationSearch: await readFile(join(root, 'src/components/chat/ConversationSearch.tsx'), 'utf8'),
    shortcutsPanel: await readFile(join(root, 'src/components/modals/ShortcutsPanel.tsx'), 'utf8'),
    commandPalette: await readFile(join(root, 'src/components/ui/CommandPalette.tsx'), 'utf8'),
    customSelect: await readFile(join(root, 'src/components/ui/CustomSelect.tsx'), 'utf8'),
  })) {
    assert.doesNotMatch(source, /\bautoFocus\b|\bautofocus\b|\.focus\s*\(/, `${name} must not move browser focus automatically`)
  }
  assert.match(activeTaskConflictModal, /Task already running/, 'active-task modal must clearly name the running-task conflict')
  assert.match(activeTaskConflictModal, /Only one task can run per account at a time, even across different browsers\./, 'active-task modal must explain the cross-browser account-wide rule')
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
  assert.match(prompts, /quickly\|quick\|brief\|short\|concise/, 'complexity pre-estimate must keep explicitly lightweight requests lightweight')
  assert.match(planManager, /Extract concrete evidence from pages you open/, 'research step guidance must require extraction beyond snippets')
  assert.match(planManager, /Unpack the angle before advancing/, 'research step guidance must ask the model to fill missing analytical gaps before advancing')
  assert.match(taskStrategy, /real evidence packet[\s\S]*targeted searches[\s\S]*concrete extracted details/, 'research strategy guidance must operationalize depth beyond source count')
  assert.match(goalTracker, /requiredOpenedSourcesForDepth/, 'goal completion must require stronger opened-source depth for moderate explanatory research')
  assert.match(goalTracker, /isExactSingleSourceLookup/, 'goal completion must preserve one-source behavior for exact official lookups')
  assert.doesNotMatch(prompts, /1500\+|1500-word|Minimum 1500/, 'research reports must not have a blanket 1500-word requirement')
  assert.match(prompts, /Report length must match the user's request and task complexity/, 'deliverable length must be complexity-driven')
  assert.match(prompts, /Executive Summary[\s\S]*numbered thematic sections[\s\S]*Conclusion[\s\S]*References/, 'research report deliverables must default to the clean report structure')
  assert.match(prompts, /inline bracket citations such as \[1\]/, 'research report deliverables must prefer inline numbered citations')
  assert.match(taskStrategy, /specific title, compact metadata[\s\S]*Executive Summary[\s\S]*numbered thematic findings[\s\S]*numbered References/, 'research strategy must preserve clean report-style final output guidance')
  assert.match(await readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'), /# specific title[\s\S]*## Executive Summary[\s\S]*numbered thematic sections[\s\S]*## Conclusion[\s\S]*## References/, 'final research step guidance must enforce the clean Markdown report skeleton')
  assert.match(prompts, /Length follows the user's request and task complexity/, 'planner research deliverables must not default to fixed report length')
  assert.doesNotMatch(await readFile(join(root, 'src/agent/guards/stepMessages.ts'), 'utf8'), /1500\+|1500-word/, 'step messages must not force fixed-length research reports')
  assert.match(agentConfig, /RESEARCH_MIN_WORDS_BY_COMPLEXITY/, 'research output verification must use complexity-aware word thresholds')
  assert.doesNotMatch(agentConfig, /RESEARCH_MIN_WORDS\s*=/, 'research output verification must not use a single fixed word minimum')
  assert.match(outputVerifier, /researchMinimumWords\(originalRequest,\s*taskComplexity\)/, 'research verifier must calculate length from request and complexity')
  assert.match(outputVerifier, /brief\|quick\|short\|concise/, 'research verifier must respect explicitly concise report requests')
  assert.match(agentLoop, /state\.forceTextNextIteration = state\.taskStrategy !== 'browse'/, 'malformed browser tool-call recovery must keep browser tools enabled')
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
  assert.doesNotMatch(toolPipeline, /BLOCKED: the user's request contains an explicit URL\/domain/, 'explicit URL search guard must not expose raw BLOCKED text')
  assert.match(toolPipeline, /function isBrowseFailureResult/, 'browse failure tracking must count failures without poisoning whole domains')
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
  assert.match(prompts, /At exactly 3 visible actions, start the next response/, 'runtime prompt must make narration same-turn at the 3-action point')
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
  assert.match(streamProcessor, /addDisplayContractArgs\(args,\s*parsed,\s*rawArgs\)/, 'stream parser must extract action labels before a tool call finishes streaming')
  assert.match(streamProcessor, /toolName === 'create_file' \|\| toolName === 'append_file'[\s\S]*?typeof args\.path === 'string'/, 'file writes must be eligible for provisional action starts once label and path exist')
  assert.match(streamProcessor, /toolName === 'edit_file'[\s\S]*?typeof args\.path === 'string'/, 'file edits must be eligible for provisional action starts once label and path exist')
  assert.match(streamProcessor, /addStringMetrics\(args,\s*rawArgs,\s*'new_string'\)/, 'edit_file replacement text must expose live size metrics while streaming')
  assert.match(streamProcessor, /delete stableArgs\.new_stringCharCount[\s\S]*delete stableArgs\.new_stringLineCount/, 'edit_file metric changes must not recreate the live action pill while replacement text streams')
  assert.match(streamProcessor, /hasDisplayLabel[\s\S]*?path && hasDisplayLabel/, 'live file previews must still require a strict model-authored action label')
  assert.match(streamProcessor, /this\.emitter\.fileContentStart\(toolCall\.id,\s*path,\s*toolCall\.name\)/, 'file write previews must initialize during tool argument streaming')
  assert.match(streamProcessor, /this\.emitter\.fileContentDelta\(toolCall\.id,\s*content\.slice\(preview\.emittedChars\)\)/, 'file write previews must stream incremental content deltas')
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
  assert.match(toolPipeline, /Used cached search:[\s\S]*this\.memory\?\.extractFromSearch/, 'cached search hits must preserve evidence in working memory')
  assert.match(toolPipeline, /Used cached HTTP result[\s\S]*this\.memory\?\.extractFromBrowse\(url, body/, 'cached http_request hits must preserve response bodies in working memory')
  assert.match(toolPipeline, /tc\.name === 'http_request'[\s\S]*recordHttpRequestEvidence\(args, result, state, false\)[\s\S]*recordResearchActivity/, 'fresh http_request results must update evidence tracking before the next model turn')
  assert.match(toolPipeline, /recordHttpRequestEvidence[\s\S]*trackVisitedSourceDomain[\s\S]*recordWorkLedgerSource/, 'http_request evidence should be tracked as a source, not just raw tool output')
  assert.match(toolPipeline, /tc\.name === 'read_document'[\s\S]*recordDocumentReadEvidence\(args, result, state, false\)[\s\S]*recordResearchActivity/, 'fresh read_document results must update evidence tracking before the next model turn')
  assert.match(toolPipeline, /Used cached document[\s\S]*this\.memory\?\.extractFromBrowse\(url, content/, 'cached read_document hits must preserve document evidence in working memory')
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
  assert.match(toolPipeline, /Model requested \$\{allCalls\.length\} tool calls; executing only the first one this turn/, 'tool execution must stay single-action per turn')
  assert.doesNotMatch(toolPipeline, /executeParallel|Promise\.allSettled\(promises\)|PARALLEL_TOOL_MAX_CONCURRENCY/, 'dead parallel execution path must stay removed from ToolPipeline')
  assert.doesNotMatch(`${contextManager}\n${toolPipeline}`, /websiteBrowserCheckPrompted/, 'website visual checks must use the typed websiteBrowserCheckAttempted state flag')
  assert.match(agentState, /stepCrossToolCycleDetections/, 'tool-cycle detections must be tracked per step')
  assert.match(agentConfig, /MIN_RESEARCH_CALLS_BY_COMPLEXITY = \{ 1: 2, 2: 5, 3: 8 \}/, 'research evidence thresholds should prevent shallow complex phases')
  assert.match(agentConfig, /MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY = \{ 1: 1, 2: 2, 3: 3 \}/, 'substantive research phases must require opened-source breadth, not just search counts')
  assert.match(goalTracker, /shallow search snippets can tick off the plan/, 'goal completion must require opened source evidence for complex research phases')
  assert.match(policyEngine, /Build a real evidence packet inside this phase/, 'phase guidance must push more work inside each phase instead of adding more phases')
  assert.match(toolPipeline, /topicFamiliesFor/, 'phase semantic guard must detect future-topic family drift')
  assert.match(agentConfig, /MIN_ITERATION_DELAY_MS = 0/, 'agent loop should not add a sluggish fixed inter-iteration delay')
  assert.match(agentConfig, /PLAN_STARTUP_DELAY_MS = 0/, 'planner startup should not wait before requesting the task plan')
  assert.match(agentConfig, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 45_000/, 'invisible model stalls should tolerate normal provider first-token latency before recovery')
  assert.match(agentConfig, /checkIntervalMs:\s*150/, 'stream stall checks should poll quickly enough for live UI feedback')
  assert.match(agentConfig, /TOOL_RETRY_BASE_MS = 250/, 'transient tool retries should be fast by default')
  assert.match(agentConfig, /TOOL_RETRY_MAX_DELAY_MS = 3_000/, 'tool retry backoff should not create long idle gaps')
  assert.match(toolRetry, /web_search:\s*\{ maxRetries: 0, baseDelayMs: 600 \}/, 'web-search retries must not hide long automatic retry stalls')
  assert.match(toolRetry, /browser_navigate:\s*\{ maxRetries: 0, baseDelayMs: 750 \}/, 'browser navigation retries must not hide long automatic retry stalls')
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
  assert.match(policyEngine, /After 4 completed visible action pills/, 'narration cadence must be based on visible user-facing action progress')
  assert.match(policyEngine, /const threshold = 4/, 'narration cadence must use the full 3-4 action window before nudging')
  assert.match(agentConfig, /NARRATION_THRESHOLD_DEFAULT\s*=\s*3/, 'default narration threshold must open the 3-4 action narration window')
  assert.match(agentConfig, /NARRATION_THRESHOLD_BROWSER\s*=\s*3/, 'browser-heavy tasks must enter the 3-4 narration window after 3 visible actions')
  assert.match(policyEngine, /NARRATION CADENCE RECOVERY/, 'backend cadence should recover missing narration with explicit progress copy')
  assert.match(policyEngine, /15-20 words preferred/, 'forced narration repair must keep updates in the desired short range')
  assert.match(policyEngine, /hard cap 34 words/, 'forced narration repair must keep progress paragraphs concise')
  assert.match(policyEngine, /result-first Manus-style paragraph/, 'forced narration repair must request result-first finding narration')
  assert.match(policyEngine, /Vary the opening verb and sentence shape/, 'forced narration repair must discourage repetitive starters')
  assert.doesNotMatch(policyEngine, /blockForcedNarrationToolCallAction/, 'narration cadence must not block useful tool-call turns')
  assert.match(policyEngine, /!isLastStep && state\.browserTaskCompleted[\s\S]*?advanceStep\(state,\s*finding\)/, 'browser completion evidence must advance before no-tool browser blocking')
  assert.match(policyEngine, /state\.visibleToolActionsSinceLastNarration >= 3[\s\S]*?isValidProgressNarration/, 'valid narration at the 3-action point must be accepted without being treated as no-tool laziness')
  assert.match(policyEngine, /if \(!stepAdvancedThisIteration\) return \[\]/, 'valid narration plus next_step must continue into step advancement instead of being swallowed')
  assert.match(policyEngine, /PHASE-END NARRATION REQUIRED/, 'policy auto-advance must request narration before crossing a phase boundary at the 3-4 action cadence')
  assert.match(agentLoop, /NARRATION CADENCE STATE/, 'model turns must receive live cadence state so narration is naturally produced at 3-4 actions')
  assert.match(agentLoop, /This applies in every phase and task type/, 'cadence state must explicitly apply to all phases and task types')
  assert.match(agentLoop, /Do not skip the paragraph just because another useful tool call is available/, 'cadence state must make model-authored narration the preferred next text')
  assert.match(agentLoop, /visibleToolActionsSinceLastNarration >= 3/, 'cadence prompt overhead should start inside the allowed 3-4 action window')
  assert.match(agentLoop, /NARRATION REQUIRED NOW/, 'the agent should request same-turn narration plus optional next tool')
  assert.match(agentLoop, /If this phase is complete[\s\S]{0,180}<next_step\/>/, 'cadence prompt must allow phase-end narration before next_step without another tool')
  assert.match(agentLoop, /compactForcedNarrationMessages/, 'forced narration turns must use a compact status-only prompt instead of the full task context')
  assert.match(agentLoop, /reasoning:\s*\{\s*effort:\s*'minimal'/, 'forced narration turns must use minimal reasoning to avoid slow status updates')
  assert.match(agentLoop, /shouldIncludeTemporalContextForTurn/, 'agent turns should gate temporal context by task type and temporal wording')
  assert.match(agentLoop, /if \(state\.forceTextNextIteration\) return false/, 'forced narration-only turns should not pay for temporal context')
  assert.match(agentLoop, /includeTemporalContext:\s*shouldIncludeTemporalContextForTurn\(state\)/, 'streaming model calls should not include temporal context by default')
  assert.match(agentLoop, /if \(state\.forceTextNextIteration\) return 96/, 'forced narration turns must use a small output cap')
  assert.match(agentState, /exactExtractionGuardPending/, 'state must track when exact extraction must happen before narration')
  assert.match(agentLoop, /EXACT EXTRACTION REQUIRED BEFORE NARRATION/, 'exact wording/date extraction risk must be handled before progress narration')
  assert.match(agentLoop, /state\.exactExtractionGuardPending[\s\S]*?NARRATION CADENCE STATE/, 'exact extraction guard must be evaluated before narration cadence prompts')
  assert.match(agentLoop, /EXACT_EXTRACTION_TOOLS[\s\S]*?browser_find_text[\s\S]*?browser_screenshot[\s\S]*?browser_get_content/, 'exact extraction guard must restrict the model to visual/text extraction tools')
  assert.match(agentLoop, /state\.exactExtractionGuardPending[\s\S]*?tool_choice:\s*'required'/, 'exact extraction guard must force a concrete extraction tool call')
  assert.match(agentLoop, /visibleToolActionsSinceLastNarration\s*=\s*0/, 'arming exact extraction must suppress the narration window for the next turn')
  assert.match(agentLoop, /tool_choice:\s*'required'/, 'browser/no-tool recovery turns must require an actual tool call instead of prose-only stalls')
  assert.match(agentLoop, /isLeanFinalSynthesisStep/, 'final research synthesis must use a lean deliverable-only tool set')
  assert.match(agentLoop, /allowedFinalTools/, 'lean final synthesis should reduce tool schema overhead without reducing deliverable quality')
  assert.match(agentLoop, /FINAL_OPTIONAL_RUNTIME_TOOLS/, 'final steps should not pay for optional image/browser/PDF/delete schemas unless relevant')
  assert.match(agentLoop, /finalStepAllowsOptionalTool/, 'final optional tools must be restored when task intent or QA state requires them')
  assert.match(agentLoop, /const finalWantsPdf = taskWantsPdfArtifact/, 'lean final synthesis should expose export_pdf only when PDF/export is requested')
  assert.match(agentLoop, /\.\.\.\(finalWantsPdf \? \['export_pdf'\] : \[\]\)/, 'export_pdf should be conditional in lean final synthesis')
  assert.doesNotMatch(agentLoop, /state\.visibleToolActionsSinceLastNarration >= 3[\s\S]{0,120}state\.forceTextNextIteration = true/, 'the loop must not immediately force a separate narration-only turn when same-turn narration can proceed')
  assert.match(toolPipeline, /validSameTurnNarration/, 'visible tool preflight must recognize same-turn narration')
  assert.match(toolPipeline, /Keep cadence soft/, 'visible tool preflight must not block useful tools for narration-only repair turns')
  assert.match(toolPipeline, /visibleActionsBeforeTool/, 'visible tool preflight must distinguish the already-rendered current tool from prior actions')
  assert.match(toolPipeline, /directNavigationBeforeSearchTarget[\s\S]*?return this\.executeSingle\(reroutedToolCall, state\)[\s\S]*?this\.emitter\.toolStart/, 'explicit URL search reroutes must happen before any misleading visible search pill is emitted')
  assert.match(eventDispatcher, /Never insert it between completed/, 'client must attach late narration recovery at the current frontier instead of inserting it between completed tools')
  assert.match(eventDispatcher, /discardNarrationBuffer/, 'client must drop early narration buffers instead of carrying them into later tool gaps')
  assert.match(streamProcessor, /recordVisibleToolStartForNarration/, 'provisional visible tool starts must count toward backend narration cadence')
  assert.match(streamProcessor, /strictActionLabelFromArgs\(args\)/, 'provisional visible tool starts must use the strict model-authored action label contract')
  assert.match(toolPipeline, /visibleNarrationToolStartIds\.has\(toolCallId\)/, 'executed tool starts must not double-count provisional visible starts')
  assert.match(agentState, /visibleNarrationToolStartIds/, 'agent state must dedupe visible tool starts across provisional and execution events')
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
  roundCreditAmount,
  tokenUsageCreditCharge,
  toolCreditCharge,
} from ${JSON.stringify(join(root, 'src/lib/creditPolicy.ts'))}
import {
  cleanThinkingTags,
  cleanThinkingTokens,
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
  explicitWebSearchLimitFromText,
  fixedWebSearchTopicFromMessages,
  isSingleWebSearchMarkdownTask,
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

  assert.equal(CREDIT_RATES.webSearchCredits, 5)
  assert.equal(CREDIT_RATES.imageSearchCredits, 0)
  assert.equal(CREDIT_RATES.browserStepCredits, 0)
  assert.equal(toolCreditCharge('web_search'), 5)
  assert.equal(toolCreditCharge('browser_click_at'), 0)
  assert.equal(toolCreditCharge('browser_screenshot'), 0)
  const expectedTokenCharge = roundCreditAmount(0.00123 * CREDIT_RATES.creditsPerUsd)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000 }), 0)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000, cost: 0.00123 }), expectedTokenCharge)
  const savedInstructions = 'Always use my three-step source review process before writing.'
  const runtimePrompt = getSystemPrompt(savedInstructions)
  const planningPrompt = getPlanningPrompt(savedInstructions)
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
  const finalStepMessage = buildStepMessage(
    ['Research product evidence', 'Synthesize final report'],
    1,
    undefined,
    new Map([[0, 'Step evidence captured from official and independent sources.']]),
    2,
    'research',
    'Create the final report from gathered findings.',
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
  assert.equal(phaseEndMissingNarrationState.currentStepIdx, 0, 'phase advance without required narration should pause before crossing the boundary')
  assert.ok(
    phaseEndMissingNarrationActions.some((action) => action.message?.content?.includes('PHASE-END NARRATION REQUIRED')),
    'phase advance without narration should request a concise paragraph plus next_step',
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
  assert.deepEqual(forcedNarrationActions, [], 'a tool call during an overdue narration state should be allowed so work keeps moving')
  assert.equal(forcedNarrationState.forceTextNextIteration, false)

  const finalNoToolState = createInitialState(false, timeouts)
  finalNoToolState.taskStrategy = 'research'
  finalNoToolState.currentPhase = 'deliver'
  finalNoToolState.currentPlanItems = ['Research product evidence', 'Synthesize final report']
  finalNoToolState.currentStepIdx = 1
  finalNoToolState.stepToolCallCount = 0
  const finalNoToolActions = policy.evaluate(
    finalNoToolState,
    new Map(),
    'I will now synthesize the gathered findings into the requested report.',
    false,
    30,
  )
  assert.ok(finalNoToolActions.some((action) => action.message?.content?.includes('FINAL SYNTHESIS TOOL REQUIRED')), 'final synthesis must immediately require a concrete file/export tool after text-only drift')

  const incompleteDepthState = createInitialState(false, timeouts)
  incompleteDepthState.taskStrategy = 'research'
  incompleteDepthState.currentPhase = 'research'
  incompleteDepthState.currentPlanItems = ['Map habitat and range evidence', 'Write final answer']
  incompleteDepthState.currentStepIdx = 0
  incompleteDepthState.taskComplexity = 3
  incompleteDepthState.stepToolCallCount = 6
  incompleteDepthState.stepResearchCallCount = 6
  incompleteDepthState.stepVisitedUrls.add('https://example.com/habitat')
  incompleteDepthState.stepVisitedUrls.add('https://example.org/range')
  incompleteDepthState.stepSourceDomainCounts.set('example.com', 1)
  incompleteDepthState.stepSourceDomainCounts.set('example.org', 1)
  incompleteDepthState.consecutiveNoToolCalls = 4
  const incompleteDepthActions = policy.evaluate(
    incompleteDepthState,
    new Map(),
    'I have identified useful habitat and distribution evidence, but additional elevation and seasonal occupancy sources remain relevant.',
    false,
    30,
  )
  assert.equal(incompleteDepthState.currentStepIdx, 0, 'complex research should not advance after a thin six-action, two-source phase')
  assert.ok(!incompleteDepthActions.some((action) => action.type === 'step_advance'), 'thin complex research must do more work inside the current phase')
  assert.ok(incompleteDepthActions.some((action) => action.message?.content?.includes('RESEARCH DEPTH INCOMPLETE')), 'thin complex research must request another targeted source/action')

  const fullDepthState = createInitialState(false, timeouts)
  fullDepthState.taskStrategy = 'research'
  fullDepthState.currentPhase = 'research'
  fullDepthState.currentPlanItems = ['Map habitat and range evidence', 'Write final answer']
  fullDepthState.currentStepIdx = 0
  fullDepthState.taskComplexity = 3
  fullDepthState.stepToolCallCount = 8
  fullDepthState.stepResearchCallCount = 8
  fullDepthState.stepVisitedUrls.add('https://example.com/habitat')
  fullDepthState.stepVisitedUrls.add('https://example.org/range')
  fullDepthState.stepVisitedUrls.add('https://example.edu/seasonal-occupancy')
  fullDepthState.stepSourceDomainCounts.set('example.com', 1)
  fullDepthState.stepSourceDomainCounts.set('example.org', 1)
  fullDepthState.stepSourceDomainCounts.set('example.edu', 1)
  fullDepthState.consecutiveNoToolCalls = 4
  const fullDepthActions = policy.evaluate(
    fullDepthState,
    new Map(),
    'I found habitat, range, and seasonal occupancy evidence across three opened source types, with enough detail to compare the main drivers and caveats.',
    false,
    30,
  )
  assert.equal(fullDepthState.currentStepIdx, 1, 'full-depth complex research should advance after enough in-phase work')
  assert.ok(fullDepthActions.some((action) => action.type === 'step_advance'), 'full-depth complex research should move to the next phase')

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
  researchState.stepToolCallCount = 6
  researchState.stepResearchCallCount = 6
  researchState.stepVisitedUrls.add('https://venturebeat.com/orchestration/why-meta-bought-manus')
  researchState.stepVisitedUrls.add('https://manus.im/product/agents')
  researchState.stepVisitedUrls.add('https://www.forbes.com/sites/ai/manus-enterprise-agents')
  researchState.stepVisitedUrls.add('https://research.example.edu/autonomous-agent-evaluation')
  researchState.stepSourceDomainCounts.set('venturebeat.com', 1)
  researchState.stepSourceDomainCounts.set('manus.im', 1)
  researchState.stepSourceDomainCounts.set('research.example.edu', 1)
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
