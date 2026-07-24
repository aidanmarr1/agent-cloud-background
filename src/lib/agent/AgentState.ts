import type { TierTimeouts } from './guards'
import type { WorkingMemory } from './WorkingMemory'
import type { GoalTracker } from './GoalTracker'
import type { TaskStrategyConfig } from './TaskStrategy'
import type { BrowserActionRecord } from '@/lib/browserIntelligence'
import {
  createResearchActivityIndex,
  normalizeResearchUrl,
  type ResearchActivityIndex,
} from './ResearchActivityLog'
import {
  MIN_ITERATION_DELAY_MS,
  AGENT_RUN_MAX_DURATION_MS,
  AGENT_DEADLINE_FINALIZATION_BUFFER_MS,
  AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS,
  AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
  RECENT_TOOL_CALL_WINDOW,
  LOOP_CHECK_WINDOW,
  LOOP_THRESHOLD,
  WORK_LOG_MAX_ENTRIES,
  WORK_SUMMARY_RECENT_SEARCHES,
  WORK_SUMMARY_RECENT_URLS,
  WORK_SUMMARY_RECENT_ACTIONS,
  NARRATION_THRESHOLD_DEFAULT,
} from './config'
import type { AcceptedNarrationRecord } from './NarrationMemory'

// Re-export from config so existing imports don't break
export { MAX_ITERATIONS, MIN_ITERATION_DELAY_MS, MAX_TIMEOUT_NUDGES, MAX_CONTEXT_MESSAGES } from './config'

export interface ToolCallRecord {
  name: string
  args: string
}

export type WorkLedgerArtifactPurpose = 'deliverable' | 'support' | 'internal'

export interface WorkLedger {
  currentObjective: string | null
  phaseNotes: Array<{ stepIdx: number; title: string; note: string; createdAt: number }>
  searchResults: Array<{ stepIdx: number; query: string; domain: string; url: string; title?: string; createdAt: number }>
  sources: Array<{ stepIdx: number; domain: string; url?: string; title?: string; createdAt: number }>
  failedRoutes: Array<{ stepIdx: number; tool: string; target: string; error: string; createdAt: number }>
  verifiedOutputs: Array<{ stepIdx: number; kind: string; detail: string; createdAt: number }>
  deliverableCandidates: Array<{ path: string; purpose: WorkLedgerArtifactPurpose; stepIdx: number; createdAt: number }>
  remainingRequirements: string[]
  satisfiedRequirements: Array<{ label: string; matchers: string[]; createdAt: number }>
  visualObservations: Array<{ stepIdx: number; tool: string; url?: string; title?: string; detail: string; createdAt: number }>
}

export interface AgentStateData {
  iterations: number
  runStartedAtMs: number
  runMaxDurationMs: number
  deadlineFinalizationBufferMs: number
  deadlineModelTurnTimeoutMs: number
  deadlineHardStopBufferMs: number
  deadlineFinalizationStarted: boolean
  lastIterationEnd: number
  iterationDelayMs: number
  timeoutNudgeCount: number
  buildTask: boolean
  tierTimeouts: TierTimeouts
  originalUserRequest: string | null

  // Web tracking
  consecutiveSearchFailures: number
  totalSearchFailures: number
  searchDisabled: boolean
  consecutiveBrowseFailures: number

  // Tool tracking
  recentToolCalls: ToolCallRecord[]
  consecutiveNoToolCalls: number
  iterationsSinceLastContent: number
  visibleToolActionsSinceLastNarration: number
  visibleNarrationToolStartIds: Set<string>
  recentNarrations: AcceptedNarrationRecord[]
  narrationWorkLogFrontier: string | null
  narrationNextAttemptAt: number
  narrationCadenceInFlight: boolean
  phaseNarrationEmittedThisStep: boolean
  forceTextNextIteration: boolean
  forcedNarrationRepairAttempts: number
  phaseEndNarrationPending: boolean
  finalInlineAnswerDelivered: boolean
  finalInlineAnswerRecoveryAttempts: number
  exactExtractionGuardPending: boolean
  exactExtractionGuardPrompt: string | null
  exactExtractionGuardAttempts: number

  // Plan / step tracking
  planEmitted: boolean
  planItems: string[] | null
  currentPlanItems: string[] | null
  // Parallel arrays to planItems / currentPlanItems holding the per-step scope
  // ("ONE specific angle this step covers"). Indexes line up 1:1 with the title
  // arrays. Null entries = legacy planner output (string[] only) — consumers
  // must treat null/missing scopes as "no constraint".
  planScopes: (string | null)[] | null
  currentPlanScopes: (string | null)[] | null
  currentStepIdx: number
  stepIterationCount: number
  perStepBudget: number
  deliverableStepBudget: number
  postCompletionIterations: number
  iterationsWithoutPlan: number
  stepFindings: Map<number, string>  // step index → brief summary of what was found

  // File tracking
  fileCreateCounts: Map<string, number>
  emittedImageArtifacts: Set<string>
  partialFileWriteRecoveries: Array<{ path: string; toolName: string; chars: number; lines: number; createdAt: number }>
  partialFileWriteRecoveryPending: { path: string; toolName: string; chars: number; lines: number } | null
  partialFileWriteRecoveryNudged: boolean

  // Work log — survives context trimming
  workLog: string[]
  workLedger: WorkLedger
  searchQueries: Set<string>
  visitedUrls: Set<string>
  createdFiles: Set<string>
  researchActivity: ResearchActivityIndex

  // Semantic search tracking
  searchQueryTokens: string[][]  // tokenized versions of each search query
  distinctSourceDomains: Set<string>  // domains that returned useful results
  sourceDomainCounts: Map<string, number>
  stepSourceDomainCounts: Map<string, number>
  stepOpenedSourceDomainCounts: Map<string, number>  // domains actually opened/read this step

  // Failure diagnosis
  failureLog: Array<{ tool: string; error: string; category: string }>

  // Flags
  researchCompletenessNudged: boolean
  briefInlineSourceQualityNudged: boolean
  deliverableQualityNudged: boolean
  semanticLoopNudged: boolean
  sourceDiversityNudged: boolean
  clickOscillationNudged: boolean  // per-step: have we already warned about flailing clicks?
  stepReflectionNudged: boolean    // per-step: have we already forced a "stop and reflect" prompt?

  // Task complexity (1=simple, 2=moderate, 3=complex)
  taskComplexity: number
  // Task strategy type (research, build, code, browse, etc.)
  taskStrategy: string
  // Full strategy config object — provides toolPriority, stepGuidance, temperature, etc.
  strategyConfig: TaskStrategyConfig | null

  // Tool health tracking — circuit breaker pattern
  toolHealth: Map<string, { successes: number; failures: number; consecutiveFailures: number; disabledUntil: number }>

  // Phase tracking
  currentPhase: 'research' | 'build' | 'deliver' | 'unknown'

  // Adaptive pacing
  stepCompletionTimes: number[]  // iterations taken to complete each step

  // Dynamic iteration limit (adjusted per complexity)
  dynamicIterationLimit: number

  // Mid-plan replanning
  replanCount: number
  stepFailureCount: number  // failures within current step

  // Step budget borrowing
  borrowedIterations: number  // iterations borrowed from future steps

  // Step tool call tracking — prevents premature advancement
  stepToolCallCount: number  // total tool calls made in current step
  stepBrowseCount: number    // browser_navigate/browser_get_content calls in current step
  stepResearchCallCount: number  // ONLY real research calls (search/browse/read/http) — excludes note files
  stepSearchQueries: Set<string>  // search queries in current step (for fuzzy dedup)
  stepVisitedUrls: Set<string>    // unique rendered/read URLs visited in current step
  // Search-result count at which the model last chose a direct 1–3 source
  // extraction batch. One result set gets one model-selected batch by default.
  stepLastSourceExtractionSearchCount: number

  // Conditional branching
  pendingConditions: Array<{ condition: string; ifTrue: string; ifFalse: string }>

  // Loop detection escalation counter
  loopDetectionCount: number
  stepLoopDetections: number  // Resets per-step; escalates loop response faster than the legacy consecutive counter
  stepCrossToolCycleDetections: number
  suppressedResearchToolName: string | null

  // Consecutive null stream responses (model not responding)
  consecutiveNullStreams: number
  lastModelErrorForUser: string | null
  pendingToolJsonRecovery: boolean
  toolJsonRecoveryCount: number
  displayContractRepairAttempts: number

  // Code execution tracking
  lastCodeExitCode: number | null
  lastCodeError: string | null
  consecutiveCodeErrors: number
  deliverableVerified: boolean

  // Browser progress tracking — detects "clicking but page never changes" loops
  lastBrowserStateHash: string | null
  consecutiveNoProgressClicks: number
  recentBrowserStateHashes: string[]  // Ring buffer of last 5 hashes — re-visiting any of these is "no progress"
  browserActionHistory: BrowserActionRecord[]
  lastNoProgressTargetKey: string | null
  browserRecoveryRequired: boolean
  browserVisualSnapshotsSent: number
  stepBrowserVisualSnapshotsSent: number
  browserTaskCompleted: boolean
  browserTaskCompletionEvidence: string[]
  browserNoToolRecoveryAttempts: number
  researchNoToolRecoveryAttempts: number

  // Step reflection escalation
  stepResearchCallsAtReflection: number  // Snapshot of stepResearchCallCount when Stage 1 reflection nudge fired
  stepToolCallsAtReflection: number      // Snapshot of stepToolCallCount when Stage 1 reflection nudge fired

  // Per-step micro-plan: 2-5 item checklist the model commits to at the start of a step
  stepMicroPlan: string | null     // Raw checklist text the model wrote in <plan>...</plan>
  stepMicroPlanRequested: boolean  // True if we already prompted for this step's plan

  // Phase 10 Fix III: per-step flag for atomic-step drift detection
  atomicStepDriftNudged: boolean   // True after warning the model that it's overrunning an atomic step

  // Phase 10 Fix JJJ: per-CONVERSATION flag (not per-step) for action-task hallucination guard
  actionFailureNudged: boolean     // True after warning the model to honestly report incomplete actions

  // Working memory — accumulates facts from search/browse calls across iterations
  workingMemory: WorkingMemory | null

  // URL the user provided in the scoped task request (if any). When non-null,
  // ToolPipeline silently reroutes premature web_search calls to direct navigation.
  userProvidedUrl: string | null
  uploadedAttachmentContextAvailable: boolean
  uploadedAttachmentContentAvailable: boolean
  uploadedImageAttachmentAvailable: boolean
  uploadedAttachmentNames: string[]

  // Reflection engine — tracks progress quality across iterations
  lastReflectionScore: number
  consecutiveLowProgress: number
  contradictionFlag: boolean

  // Goal tracking — explicit sub-goal state management
  goalTracker: GoalTracker | null
  goalsMet: boolean

  // Output verification — prevents premature completion with low-quality deliverables
  deliverableVerificationDone: boolean
  deliverableRevisionCount: number
  pendingDeliverableRevision: { path: string; failures: string[]; suggestions: string[]; createdAt: number } | null
  websiteBrowserCheckAttempted: boolean
  websiteBrowserCheckDone: boolean
  websiteBrowserCheckPath: string | null
  websiteResponsiveCheckPrompted: boolean
  websiteResponsiveCheckDone: boolean
  nextWebsitePreviewAttempted: boolean
  nextWebsitePreviewDone: boolean
  nextWebsitePreviewUrl: string | null
  nextWebsitePreviewError: string | null

  // Information-triggered replanning — cooldown and tracking
  infoReplanCooldown: number
  lastInfoReplanIteration: number

  // Session health summary — surfaced from ErrorRecoveryEngine for context injection
  sessionHealthSummary: string | null

  // Loop detection signal — set by ToolPipeline when a loop/block occurs, consumed by ReflectionEngine
  lastLoopSignal: { type: 'browser_state' | 'search_duplicate' | 'file_rewrite' | 'near_dup_search' | 'tool_rate_limit' | 'cross_tool_cycle'; tool: string } | null

  // Per-step tool type counters — for rate limiting
  stepToolTypeCounts: Map<string, number>
  // Whole-task counters — explicit "use X" instructions release after the
  // named tool/group has been attempted, even after the plan advances.
  taskToolTypeCounts: Map<string, number>
  // Successful accepted executions are tracked separately from attempts so
  // preflight blocks and execution errors cannot satisfy "use X" instructions.
  taskSuccessfulToolTypeCounts: Map<string, number>

  // Cross-tool pattern tracking — ordered list of tool/target signatures for cycle detection
  recentToolSequence: string[]

  // Diminishing returns tracking — new facts per iteration window
  iterationNewFactCounts: number[]
  diminishingReturnsNudged: boolean
}

export const BROWSER_INTERACTION_TOOLS = new Set([
  'browser_click', 'browser_click_at', 'browser_type', 'browser_fill_form',
  'browser_scroll', 'browser_find_text', 'browser_hover', 'browser_select',
  'browser_press_key', 'browser_screenshot', 'browser_get_content',
  'browser_click_and_hold', 'browser_drag', 'browser_action_sequence',
])

const BUILD_STEP_PATTERN = /\b(?:build|create|code|implement|develop|design|write|draft|style|css|html|assemble|layout|page|component|file|scaffold|set\s*up|setup|configure|config|install|initialize|initialise|init|bootstrap|wire|package|dependencies?|tailwind|next\.?js|tsx|jsx|react|route|preview|test|verify|run|boot|inspect|responsive)\b/i
const RESEARCH_STEP_PATTERN = /\b(?:research|gather|find|search|source|sources|collect|asset|assets|image|images|photo|photos|picture|pictures|reference|references|investigate|analy[sz]e|compare|evaluate|assess|impact|risk|policy|evidence|perspective|benefits?|problems?|browse|look\s*up)\b/i
const SYNTHESIS_STEP_PATTERN = /\b(?:synthesi[sz]e|compile|write|draft|assemble|produce|deliver|finali[sz]e|summari[sz]e|report|answer|conclusion|recommendation|verdict|polish)\b/i
const SYNTHESIS_LEADING_STEP_PATTERN = /^\s*(?:synthesi[sz]e|compile|write|draft|assemble|produce|deliver|finali[sz]e|summari[sz]e|prepare|polish)\b/i
const SOURCE_GATHERING_STEP_PATTERN = /\b(?:research|search|source|sources|evidence|gather|collect|find|investigate|verify|validate|audit|browse|read|extract|look\s*up|current|latest|recent|news|reported|publicly|public|asset|assets|image|images|reference|references)\b/i

export function isBuildStepText(text: string | undefined | null): boolean {
  return BUILD_STEP_PATTERN.test(text || '')
}

export function isResearchStepText(text: string | undefined | null): boolean {
  return RESEARCH_STEP_PATTERN.test(text || '') && !isSynthesisStepText(text)
}

export function isSynthesisStepText(text: string | undefined | null): boolean {
  const value = text || ''
  return SYNTHESIS_STEP_PATTERN.test(value) && !SOURCE_GATHERING_STEP_PATTERN.test(value)
}

/**
 * Plan scopes often mention "sources" or "evidence" even when the plan item
 * itself is explicitly a synthesis action. Give that action title precedence
 * so scope wording cannot accidentally force another research tool call.
 */
export function isCurrentSynthesisStep(
  state: Pick<AgentStateData, 'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'>,
): boolean {
  const title = state.currentPlanItems?.[state.currentStepIdx] || ''
  if (SYNTHESIS_LEADING_STEP_PATTERN.test(title)) return true
  return isSynthesisStepText(currentStepText(state))
}

export function isBuildStrategyState(state: Pick<AgentStateData, 'currentPhase' | 'taskStrategy' | 'buildTask'>): boolean {
  return state.currentPhase === 'build' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative' ||
    state.buildTask
}

export function currentStepText(state: Pick<AgentStateData, 'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'>): string {
  return [
    state.currentPlanItems?.[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
  ].filter(Boolean).join(' ')
}

export function isConcreteBuildStep(
  state: Pick<AgentStateData, 'currentPhase' | 'taskStrategy' | 'buildTask' | 'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'>,
  text = currentStepText(state),
): boolean {
  const buildText = isBuildStepText(text)
  const researchText = isResearchStepText(text)
  if (!isBuildStrategyState(state)) return buildText && !researchText
  return buildText && !researchText
}

export function createInitialState(buildTask: boolean, tierTimeouts: TierTimeouts): AgentStateData {
  return {
    iterations: 0,
    runStartedAtMs: Date.now(),
    runMaxDurationMs: AGENT_RUN_MAX_DURATION_MS,
    deadlineFinalizationBufferMs: AGENT_DEADLINE_FINALIZATION_BUFFER_MS,
    deadlineModelTurnTimeoutMs: AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS,
    deadlineHardStopBufferMs: AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
    deadlineFinalizationStarted: false,
    lastIterationEnd: 0,
    iterationDelayMs: MIN_ITERATION_DELAY_MS,
    timeoutNudgeCount: 0,
    buildTask,
    tierTimeouts,
    originalUserRequest: null,
    consecutiveSearchFailures: 0,
    totalSearchFailures: 0,
    searchDisabled: false,
    consecutiveBrowseFailures: 0,
    recentToolCalls: [],
    consecutiveNoToolCalls: 0,
    iterationsSinceLastContent: 0,
    visibleToolActionsSinceLastNarration: 0,
    visibleNarrationToolStartIds: new Set(),
    recentNarrations: [],
    narrationWorkLogFrontier: null,
    narrationNextAttemptAt: NARRATION_THRESHOLD_DEFAULT,
    narrationCadenceInFlight: false,
    phaseNarrationEmittedThisStep: false,
    forceTextNextIteration: false,
    forcedNarrationRepairAttempts: 0,
    phaseEndNarrationPending: false,
    finalInlineAnswerDelivered: false,
    finalInlineAnswerRecoveryAttempts: 0,
    exactExtractionGuardPending: false,
    exactExtractionGuardPrompt: null,
    exactExtractionGuardAttempts: 0,
    planEmitted: false,
    planItems: null,
    currentPlanItems: null,
    planScopes: null,
    currentPlanScopes: null,
    currentStepIdx: 0,
    stepIterationCount: 0,
    perStepBudget: 0,
    deliverableStepBudget: 0,
    postCompletionIterations: 0,
    iterationsWithoutPlan: 0,
    stepFindings: new Map(),
    fileCreateCounts: new Map(),
    emittedImageArtifacts: new Set(),
    partialFileWriteRecoveries: [],
    partialFileWriteRecoveryPending: null,
    partialFileWriteRecoveryNudged: false,
    workLog: [],
    workLedger: {
      currentObjective: null,
      phaseNotes: [],
      searchResults: [],
      sources: [],
      failedRoutes: [],
      verifiedOutputs: [],
      deliverableCandidates: [],
      remainingRequirements: [],
      satisfiedRequirements: [],
      visualObservations: [],
    },
    searchQueries: new Set(),
    visitedUrls: new Set(),
    createdFiles: new Set(),
    researchActivity: createResearchActivityIndex(),
    searchQueryTokens: [],
    distinctSourceDomains: new Set(),
    sourceDomainCounts: new Map(),
    stepSourceDomainCounts: new Map(),
    stepOpenedSourceDomainCounts: new Map(),
    failureLog: [],
    researchCompletenessNudged: false,
    briefInlineSourceQualityNudged: false,
    deliverableQualityNudged: false,
    semanticLoopNudged: false,
    sourceDiversityNudged: false,
    clickOscillationNudged: false,
    stepReflectionNudged: false,
    taskComplexity: 1,
    taskStrategy: 'research',
    strategyConfig: null,
    toolHealth: new Map(),
    currentPhase: 'research',
    stepCompletionTimes: [],
    dynamicIterationLimit: 0,
    replanCount: 0,
    stepFailureCount: 0,
    borrowedIterations: 0,
    stepToolCallCount: 0,
    stepBrowseCount: 0,
    stepResearchCallCount: 0,
    stepSearchQueries: new Set(),
    stepVisitedUrls: new Set(),
    stepLastSourceExtractionSearchCount: -1,
    pendingConditions: [],
    loopDetectionCount: 0,
    stepLoopDetections: 0,
    stepCrossToolCycleDetections: 0,
    suppressedResearchToolName: null,
    consecutiveNullStreams: 0,
    lastModelErrorForUser: null,
    pendingToolJsonRecovery: false,
    toolJsonRecoveryCount: 0,
    displayContractRepairAttempts: 0,
    lastCodeExitCode: null,
    lastCodeError: null,
    consecutiveCodeErrors: 0,
    deliverableVerified: false,
    lastBrowserStateHash: null,
    consecutiveNoProgressClicks: 0,
    recentBrowserStateHashes: [],
    browserActionHistory: [],
    lastNoProgressTargetKey: null,
    browserRecoveryRequired: false,
    browserVisualSnapshotsSent: 0,
    stepBrowserVisualSnapshotsSent: 0,
    browserTaskCompleted: false,
    browserTaskCompletionEvidence: [],
    browserNoToolRecoveryAttempts: 0,
    researchNoToolRecoveryAttempts: 0,
    stepResearchCallsAtReflection: 0,
    stepToolCallsAtReflection: 0,
    stepMicroPlan: null,
    stepMicroPlanRequested: false,
    atomicStepDriftNudged: false,
    actionFailureNudged: false,
    workingMemory: null,
    userProvidedUrl: null,
    uploadedAttachmentContextAvailable: false,
    uploadedAttachmentContentAvailable: false,
    uploadedImageAttachmentAvailable: false,
    uploadedAttachmentNames: [],
    lastReflectionScore: 1.0,
    consecutiveLowProgress: 0,
    contradictionFlag: false,
    goalTracker: null,
    goalsMet: false,
    deliverableVerificationDone: false,
    deliverableRevisionCount: 0,
    pendingDeliverableRevision: null,
    websiteBrowserCheckAttempted: false,
    websiteBrowserCheckDone: false,
    websiteBrowserCheckPath: null,
    websiteResponsiveCheckPrompted: false,
    websiteResponsiveCheckDone: false,
    nextWebsitePreviewAttempted: false,
    nextWebsitePreviewDone: false,
    nextWebsitePreviewUrl: null,
    nextWebsitePreviewError: null,
    infoReplanCooldown: 0,
    lastInfoReplanIteration: 0,
    sessionHealthSummary: null,
    lastLoopSignal: null,
    stepToolTypeCounts: new Map(),
    taskToolTypeCounts: new Map(),
    taskSuccessfulToolTypeCounts: new Map(),
    recentToolSequence: [],
    iterationNewFactCounts: [],
    diminishingReturnsNudged: false,
  }
}

// --- Tracking helpers ---

export function trackToolCall(state: AgentStateData, name: string, args: string): void {
  state.recentToolCalls.push({ name, args: args.slice(0, 200) })
  if (state.recentToolCalls.length > RECENT_TOOL_CALL_WINDOW) state.recentToolCalls.shift()
  state.taskToolTypeCounts.set(name, (state.taskToolTypeCounts.get(name) || 0) + 1)
}

export function trackSuccessfulToolExecution(
  state: Pick<AgentStateData, 'taskSuccessfulToolTypeCounts'>,
  name: string,
): void {
  state.taskSuccessfulToolTypeCounts.set(
    name,
    (state.taskSuccessfulToolTypeCounts.get(name) || 0) + 1,
  )
}

export function trackFileCreate(state: AgentStateData, filePath: string): void {
  state.fileCreateCounts.set(filePath, (state.fileCreateCounts.get(filePath) || 0) + 1)
}

export function trackSearchResult(state: AgentStateData, isFailure: boolean): void {
  if (isFailure) {
    state.consecutiveSearchFailures++
    state.totalSearchFailures++
  } else {
    state.consecutiveSearchFailures = 0
  }
}

export function trackBrowseResult(state: AgentStateData, isFailure: boolean, url?: string): void {
  if (isFailure) {
    state.consecutiveBrowseFailures++
  } else {
    state.consecutiveBrowseFailures = 0
  }
  void url
}

export function advanceStep(state: AgentStateData, finding?: string, forceAdvanced?: boolean): void {
  // Record what was accomplished in this step
  let resolvedFinding: string | undefined
  if (finding) {
    resolvedFinding = finding
  } else {
    // Build a meaningful finding from state data, not just work log
    const parts: string[] = []

    // What searches were done
    const stepSearches = [...state.searchQueries].slice(-3)
    if (stepSearches.length > 0) {
      parts.push(`Researched: ${stepSearches.join(', ')}`)
    }

    // What sources were consulted
    const sources = [...state.distinctSourceDomains].slice(-5)
    if (sources.length > 0) {
      parts.push(`Sources: ${sources.join(', ')}`)
    }

    // Files created
    const files = [...state.createdFiles]
    if (files.length > 0) {
      parts.push(`Files: ${files.join(', ')}`)
    }

    // Fall back to work log if nothing else
    if (parts.length === 0) {
      const recentWork = state.workLog.slice(-3).map(e => e.replace(/^\[\d+\] /, '')).join('; ')
      if (recentWork) parts.push(recentWork)
    }

    if (parts.length > 0) resolvedFinding = parts.join(' | ')
  }

  if (forceAdvanced) {
    // Legacy callers used this flag to skip a stuck step. That breaks the task
    // contract: an unmet prerequisite must block the run, not advance the plan.
    const blockedFinding = `[BLOCKED] ${resolvedFinding || 'Step did not complete'}`
    state.stepFindings.set(state.currentStepIdx, blockedFinding)
    recordWorkLedgerNote(state, blockedFinding)
    return
  }

  if (resolvedFinding) {
    state.stepFindings.set(state.currentStepIdx, resolvedFinding)
    recordWorkLedgerNote(state, resolvedFinding)
  }

  // Track how many iterations this step took (for adaptive pacing)
  state.stepCompletionTimes.push(state.stepIterationCount)

  state.currentStepIdx++
  state.stepIterationCount = 0
  state.stepToolCallCount = 0
  state.stepBrowseCount = 0
  state.stepResearchCallCount = 0
  state.stepFailureCount = 0
  state.stepSearchQueries = new Set()
  state.stepVisitedUrls = new Set()
  state.stepLastSourceExtractionSearchCount = -1
  state.stepSourceDomainCounts = new Map()
  state.stepOpenedSourceDomainCounts = new Map()
  state.consecutiveNoToolCalls = 0  // Reset so nudges don't carry across steps
  state.lastBrowserStateHash = null  // Fresh page tracking per step
  state.consecutiveNoProgressClicks = 0  // Stuck-click counter resets per step
  state.browserActionHistory = []
  state.lastNoProgressTargetKey = null
  state.browserRecoveryRequired = false
  state.stepBrowserVisualSnapshotsSent = 0
  state.browserTaskCompleted = false
  state.browserTaskCompletionEvidence = []
  state.browserNoToolRecoveryAttempts = 0
  state.researchNoToolRecoveryAttempts = 0
  state.partialFileWriteRecoveryNudged = false
  // Phase 11: do NOT clear recentBrowserStateHashes on step advance — keeping
  // it across steps lets us detect "re-navigated to homepage to start step 2
  // when the test page from step 1 was the right place to be" failures. The
  // 5-entry ring buffer naturally ages out so legitimate cross-step navigation
  // still works after a few new pages.
  state.stepLoopDetections = 0  // Per-step loop counter resets
  state.stepCrossToolCycleDetections = 0
  state.suppressedResearchToolName = null
  state.toolJsonRecoveryCount = 0
  state.displayContractRepairAttempts = 0
  state.lastLoopSignal = null
  state.stepResearchCallsAtReflection = 0  // Reflection snapshot resets
  state.stepToolCallsAtReflection = 0      // Reflection snapshot resets
  state.stepMicroPlan = null  // Fresh micro-plan on each step
  state.stepMicroPlanRequested = false
  state.phaseNarrationEmittedThisStep = false
  state.phaseEndNarrationPending = false
  state.forcedNarrationRepairAttempts = 0
  state.stepToolTypeCounts = new Map()  // Rate limit counters reset per step
  state.iterationNewFactCounts = []     // Diminishing returns resets per step
  state.diminishingReturnsNudged = false

  // Reset per-step flags so policies can re-trigger on the new step
  state.semanticLoopNudged = false
  state.sourceDiversityNudged = false
  state.researchCompletenessNudged = false
  state.briefInlineSourceQualityNudged = false
  state.clickOscillationNudged = false
  state.stepReflectionNudged = false
  state.atomicStepDriftNudged = false  // Phase 10 Fix III — per-step

  // Update phase based on new step
  updatePhase(state)
  setWorkLedgerObjective(state)
}

export function markPhaseNarrationEmitted(state: AgentStateData): void {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return
  state.phaseNarrationEmittedThisStep = true
}

export function needsPhaseNarrationBeforeAdvance(state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  return !state.phaseNarrationEmittedThisStep
}

// --- Work log ---

export function logWork(state: AgentStateData, entry: string): void {
  state.workLog.push(`[${state.iterations}] ${entry}`)
  if (state.workLog.length > WORK_LOG_MAX_ENTRIES) state.workLog.shift()
}

const WORK_LEDGER_LIMITS = {
  phaseNotes: 24,
  searchResults: 40,
  sources: 40,
  failedRoutes: 24,
  verifiedOutputs: 24,
  deliverableCandidates: 32,
  visualObservations: 24,
  remainingRequirements: 12,
  satisfiedRequirements: 16,
} as const

function trimLedgerList<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items
}

function normalizeRequirementText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function requirementMatches(req: string, matchers: string[]): boolean {
  const normalizedReq = normalizeRequirementText(req)
  return matchers.some(matcher => {
    const normalizedMatcher = normalizeRequirementText(matcher)
    return !!normalizedMatcher && (
      normalizedReq.includes(normalizedMatcher) ||
      normalizedMatcher.includes(normalizedReq)
    )
  })
}

export function setWorkLedgerObjective(state: AgentStateData, objective?: string): void {
  const planObjective = state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length
    ? state.currentPlanItems[state.currentStepIdx]
    : null
  state.workLedger.currentObjective = objective?.trim() || planObjective || null
}

export function setWorkLedgerRequirements(state: AgentStateData, requirements: string[]): void {
  const satisfiedMatchers = state.workLedger.satisfiedRequirements.flatMap(item => item.matchers)
  const cleaned = requirements
    .map(req => req.trim())
    .filter(Boolean)
    .filter(req => !requirementMatches(req, satisfiedMatchers))
    .slice(-WORK_LEDGER_LIMITS.remainingRequirements)
  state.workLedger.remainingRequirements = cleaned
}

export function satisfyWorkLedgerRequirement(
  state: AgentStateData,
  label: string,
  matchers: string[] = [label],
): void {
  const cleanLabel = label.trim()
  const cleanMatchers = matchers.map(matcher => matcher.trim()).filter(Boolean)
  if (!cleanLabel || cleanMatchers.length === 0) return

  const existingIdx = state.workLedger.satisfiedRequirements.findIndex(item =>
    normalizeRequirementText(item.label) === normalizeRequirementText(cleanLabel)
  )
  const entry = {
    label: cleanLabel,
    matchers: cleanMatchers,
    createdAt: Date.now(),
  }
  if (existingIdx >= 0) {
    state.workLedger.satisfiedRequirements[existingIdx] = entry
  } else {
    state.workLedger.satisfiedRequirements.push(entry)
  }
  state.workLedger.satisfiedRequirements = trimLedgerList(
    state.workLedger.satisfiedRequirements,
    WORK_LEDGER_LIMITS.satisfiedRequirements,
  )
  state.workLedger.remainingRequirements = state.workLedger.remainingRequirements
    .filter(req => !requirementMatches(req, cleanMatchers))
}

export function recordWorkLedgerNote(state: AgentStateData, note: string, title?: string): void {
  const cleaned = note.trim()
  if (!cleaned) return
  state.workLedger.phaseNotes.push({
    stepIdx: state.currentStepIdx,
    title: title || state.currentPlanItems?.[state.currentStepIdx] || 'Current phase',
    note: cleaned.slice(0, 500),
    createdAt: Date.now(),
  })
  state.workLedger.phaseNotes = trimLedgerList(state.workLedger.phaseNotes, WORK_LEDGER_LIMITS.phaseNotes)
}

export function recordWorkLedgerSource(
  state: AgentStateData,
  source: { url?: string; title?: string; domain?: string },
): void {
  const domain = source.domain || (source.url ? normalizeSourceDomain(source.url) : null)
  if (!domain) return
  const url = source.url?.trim() || undefined
  const duplicate = state.workLedger.sources.some(entry =>
    entry.stepIdx === state.currentStepIdx &&
    entry.domain === domain &&
    (url ? entry.url === url : !entry.url)
  )
  if (duplicate) return
  state.workLedger.sources.push({
    stepIdx: state.currentStepIdx,
    domain,
    ...(url ? { url } : {}),
    ...(source.title?.trim() ? { title: source.title.trim().slice(0, 140) } : {}),
    createdAt: Date.now(),
  })
  state.workLedger.sources = trimLedgerList(state.workLedger.sources, WORK_LEDGER_LIMITS.sources)
}

export function recordWorkLedgerSearchResults(
  state: AgentStateData,
  query: string,
  results: Array<{ url?: string; title?: string }>,
): void {
  const cleanQuery = query.trim()
  if (!cleanQuery || results.length === 0) return

  for (const result of results) {
    const url = result.url?.trim()
    if (!url) continue
    const domain = normalizeSourceDomain(url)
    if (!domain) continue

    const duplicate = state.workLedger.searchResults.some(entry =>
      entry.stepIdx === state.currentStepIdx &&
      entry.url === url
    )
    if (duplicate) continue

    state.workLedger.searchResults.push({
      stepIdx: state.currentStepIdx,
      query: cleanQuery.slice(0, 180),
      domain,
      url,
      ...(result.title?.trim() ? { title: result.title.trim().slice(0, 140) } : {}),
      createdAt: Date.now(),
    })
  }

  state.workLedger.searchResults = trimLedgerList(
    state.workLedger.searchResults,
    WORK_LEDGER_LIMITS.searchResults,
  )
}

export function recordWorkLedgerFailure(
  state: AgentStateData,
  failure: { tool: string; target?: string; error: string },
): void {
  const error = failure.error.trim()
  if (!error) return
  state.workLedger.failedRoutes.push({
    stepIdx: state.currentStepIdx,
    tool: failure.tool,
    target: (failure.target || '').slice(0, 220),
    error: error.slice(0, 300),
    createdAt: Date.now(),
  })
  state.workLedger.failedRoutes = trimLedgerList(state.workLedger.failedRoutes, WORK_LEDGER_LIMITS.failedRoutes)
}

export function recordWorkLedgerVerification(
  state: AgentStateData,
  verification: { kind: string; detail: string },
): void {
  const detail = verification.detail.trim()
  if (!detail) return
  state.workLedger.verifiedOutputs.push({
    stepIdx: state.currentStepIdx,
    kind: verification.kind,
    detail: detail.slice(0, 300),
    createdAt: Date.now(),
  })
  state.workLedger.verifiedOutputs = trimLedgerList(state.workLedger.verifiedOutputs, WORK_LEDGER_LIMITS.verifiedOutputs)

  const kind = verification.kind.toLowerCase()
  if (kind.includes('website-preview')) {
    satisfyWorkLedgerRequirement(state, 'Local visual preview opened', [
      'boot local preview',
      'local preview',
      'visual preview',
      'visually verify',
      'blank or broken preview',
    ])
  }
  if (kind.includes('fixed-viewport')) {
    satisfyWorkLedgerRequirement(state, 'Fixed-viewport visual QA completed', [
      'fixed viewport',
      'current browser size',
      'existing browser size',
      'visually verify',
      'visual verify',
    ])
  }
  if (kind === 'execute_command' || kind === 'run_code') {
    satisfyWorkLedgerRequirement(state, 'Command verification completed', [
      'run verification',
      'verify output',
      'test',
      'lint',
      'typecheck',
    ])
  }
  if (kind.includes('browser-final') || kind.includes('browser-completion') || kind.includes('browser-hard-blocker')) {
    satisfyWorkLedgerRequirement(state, 'Final browser state verified', [
      'verify the final browser state',
      'concrete hard blocker',
      'final browser state',
      'hard blocker',
      'browser task completion',
    ])
  }
}

export function recordWorkLedgerDeliverable(
  state: AgentStateData,
  candidate: { path: string; purpose: WorkLedgerArtifactPurpose },
): void {
  const path = candidate.path.trim()
  if (!path) return
  const existingIdx = state.workLedger.deliverableCandidates.findIndex(entry => entry.path === path)
  const entry = {
    path,
    purpose: candidate.purpose,
    stepIdx: state.currentStepIdx,
    createdAt: Date.now(),
  }
  if (existingIdx >= 0) {
    state.workLedger.deliverableCandidates[existingIdx] = entry
  } else {
    state.workLedger.deliverableCandidates.push(entry)
  }
  state.workLedger.deliverableCandidates = trimLedgerList(
    state.workLedger.deliverableCandidates,
    WORK_LEDGER_LIMITS.deliverableCandidates,
  )
  if (candidate.purpose === 'deliverable') {
    satisfyWorkLedgerRequirement(state, 'Final deliverable saved', [
      'final phase',
      'deliver',
      'deliverable',
      'working website',
      'actual final output',
      'usage notes',
    ])
  }
}

export function recordWorkLedgerVisualObservation(
  state: AgentStateData,
  observation: { tool: string; url?: string; title?: string; detail: string },
): void {
  const detail = observation.detail.trim()
  if (!detail) return
  state.workLedger.visualObservations.push({
    stepIdx: state.currentStepIdx,
    tool: observation.tool,
    ...(observation.url ? { url: observation.url } : {}),
    ...(observation.title ? { title: observation.title.slice(0, 140) } : {}),
    detail: detail.slice(0, 300),
    createdAt: Date.now(),
  })
  state.workLedger.visualObservations = trimLedgerList(
    state.workLedger.visualObservations,
    WORK_LEDGER_LIMITS.visualObservations,
  )
  if (observation.tool.startsWith('browser_')) {
    satisfyWorkLedgerRequirement(state, 'Browser visual state inspected', [
      'visual screenshot state',
      'fresh indexed controls',
      'visual inspection',
      'screenshot state',
      'visual state',
    ])
  }
}

export function getWorkSummary(state: AgentStateData): string {
  const parts: string[] = []

  if (state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
    parts.push(`Step ${state.currentStepIdx + 1}/${state.currentPlanItems.length}: "${state.currentPlanItems[state.currentStepIdx]}"`)
    if (state.stepFindings.size > 0) {
      const findings = [...state.stepFindings.entries()]
        .map(([idx, f]) => {
          const truncated = f.length > 150 ? f.slice(0, 150) + '...' : f
          return `  Step ${idx + 1}: ${truncated}`
        })
        .join('\n')
      parts.push(findings)
    }
  }

  if (state.partialFileWriteRecoveryPending) {
    const p = state.partialFileWriteRecoveryPending
    parts.push(`PARTIAL FILE WRITE RECOVERED: ${p.path} (${p.lines} lines, ${p.chars} chars). Continue this file with append_file only; do not recreate, edit, read, export, or switch files until the append clears the partial state.`)
  }

  if (state.workLedger.currentObjective) {
    parts.push(`Current objective: ${state.workLedger.currentObjective}`)
  }
  if (state.workLedger.remainingRequirements.length > 0) {
    parts.push(`Remaining requirements: ${state.workLedger.remainingRequirements.join('; ')}`)
  }
  const recentlySatisfied = state.workLedger.satisfiedRequirements.slice(-5)
  if (recentlySatisfied.length > 0) {
    parts.push(`Satisfied requirements: ${recentlySatisfied.map(item => item.label).join('; ')}`)
  }
  const recentSources = state.workLedger.sources.slice(-5)
  if (recentSources.length > 0) {
    parts.push(`Recent source domains: ${[...new Set(recentSources.map(source => source.domain))].join(', ')}`)
  }
  const normalizedStepVisitedUrls = new Set(
    [...state.stepVisitedUrls].map(url => normalizeResearchUrl(url)),
  )
  const unopenedSearchResults = state.workLedger.searchResults
    .filter(result =>
      result.stepIdx === state.currentStepIdx &&
      !normalizedStepVisitedUrls.has(normalizeResearchUrl(result.url)),
    )
    .slice(0, 5)
  const searchResultRoutes = unopenedSearchResults.length > 0
    ? unopenedSearchResults
    : state.workLedger.searchResults.slice(-5)
  if (searchResultRoutes.length > 0) {
    const routeLabel = unopenedSearchResults.length > 0
      ? 'Unopened search result routes'
      : 'Recent search result routes'
    parts.push(`${routeLabel}: ${searchResultRoutes.map(result => `${result.url}${result.title ? ` (${result.title})` : ''}`).join('; ')}`)
  }
  const recentFailures = state.workLedger.failedRoutes.slice(-3)
  if (recentFailures.length > 0) {
    parts.push(`Recent blocked routes: ${recentFailures.map(f => `${f.tool} ${f.target || '(no target)'} → ${f.error}`).join(' | ')}`)
  }
  const recentVerified = state.workLedger.verifiedOutputs.slice(-3)
  if (recentVerified.length > 0) {
    parts.push(`Verified outputs: ${recentVerified.map(v => `${v.kind}: ${v.detail}`).join(' | ')}`)
  }
  const deliverables = state.workLedger.deliverableCandidates.filter(item => item.purpose === 'deliverable').slice(-5)
  if (deliverables.length > 0) {
    parts.push(`Deliverable candidates: ${deliverables.map(item => item.path).join(', ')}`)
  }
  const supportArtifacts = state.workLedger.deliverableCandidates.filter(item => item.purpose !== 'deliverable').slice(-5)
  if (supportArtifacts.length > 0) {
    parts.push(`Support/internal artifacts, not final deliverables: ${supportArtifacts.map(item => item.path).join(', ')}`)
  }
  const classifiedArtifacts = new Set(state.workLedger.deliverableCandidates.map(item => item.path))
  const recentWorkspaceFiles = [...state.createdFiles].filter(path => !classifiedArtifacts.has(path)).slice(-8)
  if (recentWorkspaceFiles.length > 0) {
    parts.push(`Recent workspace files, not automatically final deliverables: ${recentWorkspaceFiles.join(', ')}`)
  }

  // Only show search count, not full queries — saves tokens
  if (state.searchQueries.size > 0) {
    parts.push(`${state.searchQueries.size} searches, ${state.visitedUrls.size} pages visited`)
  }

  const diagnosis = getFailureDiagnosis(state)
  if (diagnosis) {
    parts.push(`ISSUES: ${diagnosis}`)
  }

  if (state.workLog.length > 0) {
    parts.push(`Recent actions:\n${state.workLog.slice(-WORK_SUMMARY_RECENT_ACTIONS).join('\n')}`)
  }
  return parts.join('\n')
}

// --- Semantic search helpers ---

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'by', 'from', 'about', 'how', 'what', 'when', 'where', 'who', 'which', 'that', 'this', 'best', 'top', 'latest', 'most', 'new'])

export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
}

export function trackSearchQuery(state: AgentStateData, query: string): void {
  const normalized = query.toLowerCase().trim()
  state.searchQueries.add(normalized)
  state.stepSearchQueries.add(normalized)
  state.searchQueryTokens.push(tokenizeQuery(query))
}

export function trackSourceDomain(state: AgentStateData, results: Array<{ url?: string }>): void {
  for (const r of results) {
    if (r.url) {
      const domain = normalizeSourceDomain(r.url)
      if (!domain) continue
      state.distinctSourceDomains.add(domain)
      state.sourceDomainCounts.set(domain, (state.sourceDomainCounts.get(domain) || 0) + 1)
      state.stepSourceDomainCounts.set(domain, (state.stepSourceDomainCounts.get(domain) || 0) + 1)
    }
  }
}

export function stepOpenedSourceDomains(state: AgentStateData): Map<string, number> {
  if (!state.stepOpenedSourceDomainCounts) {
    state.stepOpenedSourceDomainCounts = new Map()
  }
  return state.stepOpenedSourceDomainCounts
}

function normalizeSourceDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

export function trackVisitedSourceDomain(state: AgentStateData, url: string): void {
  const domain = normalizeSourceDomain(url)
  if (!domain) return
  state.distinctSourceDomains.add(domain)
  state.sourceDomainCounts.set(domain, (state.sourceDomainCounts.get(domain) || 0) + 1)
  state.stepSourceDomainCounts.set(domain, (state.stepSourceDomainCounts.get(domain) || 0) + 1)
  const openedDomains = stepOpenedSourceDomains(state)
  openedDomains.set(domain, (openedDomains.get(domain) || 0) + 1)
}

export function trackFailure(state: AgentStateData, tool: string, error: string): void {
  // Categorize the failure
  let category = 'unknown'
  if (error.includes('403') || error.includes('Forbidden') || /CAPTCHA|human-verification|access denied/i.test(error)) category = 'access-block'
  else if (error.includes('429') || error.includes('rate limit')) category = 'rate-limited'
  else if (error.includes('timeout') || error.includes('timed out')) category = 'timeout'
  else if (error.includes('unavailable') || error.includes('down')) category = 'service-down'
  else if (error.includes('parse') || error.includes('format')) category = 'format-error'

  state.failureLog.push({ tool, error: error.slice(0, 100), category })
  if (state.failureLog.length > 20) state.failureLog.shift()
}

export function getFailureDiagnosis(state: AgentStateData): string | null {
  if (state.failureLog.length < 3) return null

  // Count failures by category
  const categoryCounts = new Map<string, number>()
  for (const f of state.failureLog.slice(-10)) {
    categoryCounts.set(f.category, (categoryCounts.get(f.category) || 0) + 1)
  }

  for (const [category, count] of categoryCounts) {
    if (count >= 3) {
      switch (category) {
        case 'access-block':
          return 'Multiple page access errors occurred. Use a different specific source route or continue from already gathered evidence; do not assume the entire domain is blocked.'
        case 'rate-limited':
          return 'You are being rate-limited. Slow down — wait between requests or proceed with the information you already have.'
        case 'timeout':
          return 'Multiple tools are timing out. The network or service may be slow. Use shorter queries, simpler requests, or proceed with what you have.'
        case 'service-down':
          return 'Search providers appear to be down. Switch to browsing known URLs directly, or proceed with your existing knowledge.'
        default:
          return `Multiple failures of type "${category}". Try a completely different approach.`
      }
    }
  }
  return null
}

// --- Tool health / circuit breaker ---

import { CIRCUIT_BREAKER_FAILURE_THRESHOLD, CIRCUIT_BREAKER_COOLDOWN_MS } from './config'

const CIRCUIT_BREAKER_EXEMPT_TOOLS = new Set([
  // read_document failures are usually per-source web access outcomes
  // such as 403/404/429, not evidence that extraction is globally broken.
  'read_document',
])

export function updateToolHealth(state: AgentStateData, toolName: string, success: boolean): void {
  let health = state.toolHealth.get(toolName)
  if (!health) {
    health = { successes: 0, failures: 0, consecutiveFailures: 0, disabledUntil: 0 }
    state.toolHealth.set(toolName, health)
  }

  const canTripCircuitBreaker = !CIRCUIT_BREAKER_EXEMPT_TOOLS.has(toolName)

  if (success) {
    health.successes++
    health.consecutiveFailures = 0
    // Re-enable if was disabled
    health.disabledUntil = 0
  } else {
    health.failures++
    health.consecutiveFailures = canTripCircuitBreaker
      ? health.consecutiveFailures + 1
      : 0
    // Trip circuit breaker
    if (canTripCircuitBreaker && health.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD && health.disabledUntil === 0) {
      health.disabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS
    }
  }
}

export function isToolDisabled(state: AgentStateData, toolName: string): boolean {
  const health = state.toolHealth.get(toolName)
  if (!health) return false
  if (health.disabledUntil === 0) return false
  if (Date.now() >= health.disabledUntil) {
    // Cooldown expired — allow one more attempt (half-open)
    health.disabledUntil = 0
    health.consecutiveFailures = Math.max(0, health.consecutiveFailures - 1)
    return false
  }
  return true
}

export function getToolHealthSummary(state: AgentStateData): string {
  const unhealthy: string[] = []
  for (const [name, health] of state.toolHealth) {
    const total = health.successes + health.failures
    if (total >= 3 && health.failures / total > 0.5) {
      unhealthy.push(`${name}: ${health.failures}/${total} failed`)
    }
  }
  return unhealthy.length > 0 ? `Unreliable tools: ${unhealthy.join(', ')}` : ''
}

// --- Phase tracking ---

export function updatePhase(state: AgentStateData): void {
  if (!state.currentPlanItems) {
    state.currentPhase = 'research'
    return
  }
  if (state.currentStepIdx >= state.currentPlanItems.length) {
    state.currentPhase = 'deliver'
    return
  }
  const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
  const stepText = currentStepText(state).toLowerCase()
  if (isLastStep || isCurrentSynthesisStep(state)) {
    state.currentPhase = 'deliver'
  } else {
    // Check step content for phase hints
    if (isConcreteBuildStep(state, stepText)) {
      state.currentPhase = 'build'
    } else {
      state.currentPhase = 'research'
    }
  }
}

// --- Loop detection ---

/**
 * Improved loop detection: checks tool name + arguments to distinguish
 * "same search 3 times" from "3 different searches".
 */
export function detectToolCallLoop(state: AgentStateData): { looping: boolean; tool: string; rawTool: string; count: number } {
  if (state.recentToolCalls.length < 3) return { looping: false, tool: '', rawTool: '', count: 0 }
  const recent = state.recentToolCalls.slice(-LOOP_CHECK_WINDOW)
  const counts = new Map<string, number>()

  for (const call of recent) {
    let key = call.name

    // For content-fetching tools, include the target in the key
    if (call.name === 'web_search') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.query) key = `web_search:${parsed.query.toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'read_document') {
      try {
        const parsed = JSON.parse(call.args)
        const target = parsed.url || parsed.source
        if (target) key = `read_document:${String(target).toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_navigate' || call.name === 'browse_page') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.url) key = `${call.name}:${parsed.url}`
      } catch { /* use plain name */ }
    } else if (call.name === 'create_file') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.path) key = `create_file:${parsed.path}`
      } catch { /* use plain name */ }
    } else if (call.name === 'append_file') {
      try {
        const parsed = JSON.parse(call.args)
        const path = parsed.path || ''
        const content = String(parsed.content || '')
        key = `append_file:${path}:${content.length}:${content.slice(0, 120)}`
      } catch { /* use plain name */ }
    } else if (call.name === 'export_pdf') {
      try {
        const parsed = JSON.parse(call.args)
        const outputPath = parsed.output_path || parsed.source_path || ''
        key = `export_pdf:${outputPath}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_click_at') {
      // Bucket coords to nearest 30px so near-duplicate clicks count as the same target.
      // Without this, the agent can click (46, 647) infinitely without tripping a loop.
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const bx = Math.round(parsed.x / 30) * 30
          const by = Math.round(parsed.y / 30) * 30
          key = `browser_click_at:${bx},${by}`
        }
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_click' || call.name === 'browser_hover') {
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.index === 'number') key = `${call.name}:idx${parsed.index}`
        else if (parsed.selector) key = `${call.name}:${String(parsed.selector).toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_type') {
      try {
        const parsed = JSON.parse(call.args)
        // Bucket by index (Manus-style) or selector (legacy). Text content is intentionally
        // ignored — we want to detect "typed into the same target multiple times", not
        // "typed the same text". Rotating text into one input still trips this bucket.
        if (typeof parsed.index === 'number') key = `browser_type:idx${parsed.index}`
        else if (parsed.selector) key = `browser_type:${String(parsed.selector).toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_select') {
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.index === 'number') key = `browser_select:idx${parsed.index}`
        else if (parsed.selector) key = `browser_select:${String(parsed.selector).toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_fill_form') {
      try {
        const parsed = JSON.parse(call.args)
        const fields = Array.isArray(parsed.fields)
          ? parsed.fields.map((f: Record<string, unknown>) => f.index ?? f.label ?? '').join('|').slice(0, 120)
          : ''
        key = `browser_fill_form:${fields}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_find_text') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.query) key = `browser_find_text:${String(parsed.query).toLowerCase().trim()}`
      } catch { /* use plain name */ }
    } else if (call.name === 'browser_action_sequence') {
      // Bucket by the sequence's first action's target so two sequences that
      // start with the same click/type collapse into one bucket and trip the
      // loop detector together.
      try {
        const parsed = JSON.parse(call.args)
        if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
          const first = parsed.actions[0]
          const argSummary = first?.args ? JSON.stringify(first.args).slice(0, 40) : ''
          key = `browser_action_sequence:${first?.action || 'unknown'}:${argSummary}`
        }
      } catch { /* use plain name */ }
    }

    counts.set(key, (counts.get(key) || 0) + 1)
  }

  for (const [tool, count] of counts) {
    // Only exempt screenshots. Repeated browser_get_content calls on the same
    // page are a common expensive research stall and must trip recovery.
    if (tool === 'browser_screenshot') continue
    if (count >= LOOP_THRESHOLD) {
      const displayName = tool.includes(':') ? tool.split(':')[0] + ' (same target)' : tool
      const rawTool = tool.includes(':') ? tool.split(':')[0] : tool
      return { looping: true, tool: displayName, rawTool, count }
    }
  }
  return { looping: false, tool: '', rawTool: '', count: 0 }
}

/**
 * Detect oscillation between distinct browser interaction targets — the agent
 * clicking [A, B, A, B] or [A, B, C, A, B] without committing to a strategy.
 * This is the "indecisive flailing" pattern that the regular loop detector
 * misses (because no single target hits LOOP_THRESHOLD).
 *
 * A "revisit" is a target that appears earlier in the window with at least one
 * DIFFERENT target between the two visits. Two or more revisits = oscillation.
 */
export function detectClickOscillation(state: AgentStateData): { oscillating: boolean; targets: string[]; revisits: number } {
  if (state.recentToolCalls.length < 4) return { oscillating: false, targets: [], revisits: 0 }

  // Consider INTERACTIVE browser calls AND navigations. Navigation IS flailing when the
  // agent re-visits the same URL between other actions (Woolworths-pattern: nav→type→nav→type
  // with rotating text). Scroll is still excluded — it's an intentional viewport change.
  const INTERACTIVE = new Set([
    'browser_click', 'browser_click_at', 'browser_type', 'browser_fill_form',
    'browser_find_text', 'browser_press_key', 'browser_hover', 'browser_navigate',
  ])
  const recent = state.recentToolCalls.slice(-LOOP_CHECK_WINDOW).filter(c => INTERACTIVE.has(c.name))
  if (recent.length < 4) return { oscillating: false, targets: [], revisits: 0 }

  // Build disambiguated keys (mirrors detectToolCallLoop logic)
  const keys: string[] = []
  for (const call of recent) {
    let key = call.name
    if (call.name === 'browser_click_at') {
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          // Use a coarser bucket (50px) for oscillation than for loops (30px),
          // so two clicks "near each other" still count as the same target.
          const bx = Math.round(parsed.x / 50) * 50
          const by = Math.round(parsed.y / 50) * 50
          key = `click_at:${bx},${by}`
        }
      } catch { /* */ }
    } else if (call.name === 'browser_click' || call.name === 'browser_hover') {
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.index === 'number') key = `${call.name}:idx${parsed.index}`
        else if (parsed.selector) key = `${call.name}:${String(parsed.selector).toLowerCase().trim()}`
      } catch { /* */ }
    } else if (call.name === 'browser_type') {
      try {
        const parsed = JSON.parse(call.args)
        if (typeof parsed.index === 'number') key = `type:idx${parsed.index}`
        else if (parsed.selector) key = `type:${String(parsed.selector).toLowerCase().trim()}`
      } catch { /* */ }
    } else if (call.name === 'browser_fill_form') {
      try {
        const parsed = JSON.parse(call.args)
        const fields = Array.isArray(parsed.fields)
          ? parsed.fields.map((f: Record<string, unknown>) => f.index ?? f.label ?? '').join('|').slice(0, 120)
          : ''
        key = `fill_form:${fields}`
      } catch { /* */ }
    } else if (call.name === 'browser_find_text') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.query) key = `find_text:${String(parsed.query).toLowerCase().trim()}`
      } catch { /* */ }
    } else if (call.name === 'browser_navigate') {
      try {
        const parsed = JSON.parse(call.args)
        if (parsed.url) {
          // Bucket by hostname+path so utm_*-style query variants collapse to the same key.
          // Re-navigating to the same homepage between other actions = oscillation signal.
          try {
            const u = new URL(parsed.url)
            key = `nav:${u.hostname}${u.pathname}`
          } catch {
            key = `nav:${String(parsed.url).toLowerCase()}`
          }
        }
      } catch { /* */ }
    }
    keys.push(key)
  }

  // Count revisits: a target is "revisited" when it appears at index j > i AND
  // at least one DIFFERENT key sits between i and j. Adjacent repeats don't count
  // (clicking the same thing twice in a row is "trying again", not flailing).
  let revisits = 0
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 2; j < keys.length; j++) {
      if (keys[j] !== keys[i]) continue
      // Need at least one different key strictly between i and j
      let hasDifferent = false
      for (let k = i + 1; k < j; k++) {
        if (keys[k] !== keys[i]) { hasDifferent = true; break }
      }
      if (hasDifferent) {
        revisits++
        break  // Don't double-count this i
      }
    }
  }

  if (revisits >= 2) {
    const distinctTargets = [...new Set(keys)]
    return { oscillating: true, targets: distinctTargets, revisits }
  }
  return { oscillating: false, targets: [], revisits: 0 }
}
