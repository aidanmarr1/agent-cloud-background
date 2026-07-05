import { AgentStateData, BROWSER_INTERACTION_TOOLS, detectToolCallLoop, detectClickOscillation, advanceStep, getFailureDiagnosis, isToolDisabled, currentStepText, isConcreteBuildStep, isResearchStepText } from './AgentState'
import { isAtomicStep } from './PlanManager'
import { buildStepMessage } from './guards'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { currentStepHasSingleWebSearchLimit, currentStepWebSearchLimit, hasSingleWebSearchLimit, isFixedWebSearchInlineAnswerState } from './taskConstraints'
import { isSubstantiveResearchState, researchDepthProfileForState } from './ResearchDepth'
import type { ToolCallData } from './StreamProcessor'
import {
  NO_TOOL_FORCE_ADVANCE,
  RESEARCH_NUDGE_ITERATION,
  CONSECUTIVE_SEARCH_FAILURES_WARN,
  TOTAL_SEARCH_FAILURES_DISABLE,
  CONSECUTIVE_BROWSE_FAILURES_WARN,
  POST_COMPLETION_MAX_ITERATIONS,
  NO_PLAN_RUNAWAY_LIMIT,
  LAST_STEP_NUDGE_MULTIPLIER,
  LAST_STEP_HARD_NUDGE_MULTIPLIER,
  LAST_STEP_TERMINATE_MULTIPLIER,
  SEMANTIC_LOOP_WINDOW,
  SEMANTIC_OVERLAP_THRESHOLD,
  SEMANTIC_CORE_TOKENS,
  FAILURE_PATTERN_THRESHOLD,
  SLOW_STEP_THRESHOLD,
  URGENCY_GENTLE_FRACTION,
  URGENCY_FIRM_FRACTION,
  URGENCY_FINAL_FRACTION,
  STEP_BUDGET_BORROW_FRACTION,
  REPLAN_AFTER_FAILURES,
  MIN_TOOL_CALLS_PER_STEP,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  LOOP_CHECK_WINDOW,
  REPLAN_MAX_TIMES,
  MIN_STEP_BUDGET,
} from './config'

export type PolicyActionType = 'inject_message' | 'step_advance' | 'terminate' | 'continue_loop'

export interface PolicyAction {
  type: PolicyActionType
  message?: { role: string; content: string }
  // When true, skip remaining policies and go to next iteration
  continueLoop?: boolean
  // Why the agent was terminated — for debugging
  reason?: string
}

function blockCurrentStep(state: AgentStateData, reason: string, code = 'step_blocked'): PolicyAction[] {
  const stepNumber = state.currentStepIdx + 1
  const stepTitle = state.currentPlanItems?.[state.currentStepIdx]
  const titleText = stepTitle ? ` "${stepTitle}"` : ''
  const detail = `Step ${stepNumber}${titleText} blocked before completion: ${reason}`
  state.stepFindings.set(state.currentStepIdx, `[BLOCKED] ${detail}`)
  return [{ type: 'terminate', reason: `${code}: ${detail}` }]
}

/** Helper to build step message with findings, micro-plan, working memory, goal tracking, and session health */
function stepMsg(state: AgentStateData, extra?: string): string {
  const memText = state.workingMemory?.render({ stepIdx: state.currentStepIdx, maxFacts: 8, maxChars: 1200 })
  const planText = state.stepMicroPlan
    ? `Your plan for this step:\n${state.stepMicroPlan}`
    : null
  const goalText = state.goalTracker?.renderForContext()
  const healthText = state.sessionHealthSummary

  // Stack: goal tracking → session health → working memory → micro-plan → caller's extra context
  const sections: string[] = []
  if (goalText) sections.push(goalText)
  if (healthText) sections.push(`TOOL HEALTH:\n${healthText}`)
  if (memText) sections.push(memText)
  if (planText) sections.push(planText)
  if (extra && extra.trim()) sections.push(extra)
  const fullExtra = sections.length > 0 ? sections.join('\n\n') : undefined

  return buildStepMessage(
    state.currentPlanItems!,
    state.currentStepIdx,
    fullExtra,
    state.stepFindings,
    state.taskComplexity,
    state.taskStrategy,
    state.currentPlanScopes?.[state.currentStepIdx] ?? undefined,
  )
}

function isValidProgressNarration(content: string, options: { requireSignal?: boolean } = {}): boolean {
  return !!sanitizeNarrationText(content, {
    requireSignal: options.requireSignal ?? true,
    maxSentences: 2,
    maxLength: 300,
  })
}

function isAcceptableForcedNarration(content: string): boolean {
  return isValidProgressNarration(content, { requireSignal: true }) ||
    isValidProgressNarration(content, { requireSignal: false })
}

function visibleActionsAfterAcceptedNarration(visibleActions: number): number {
  return Math.max(0, visibleActions - 4)
}

function shouldRequestPhaseEndNarration(state: AgentStateData, assistantContent = ''): boolean {
  return !!state.currentPlanItems &&
    state.currentStepIdx < state.currentPlanItems.length - 1 &&
    state.visibleToolActionsSinceLastNarration >= 3 &&
    !isValidProgressNarration(assistantContent)
}

function phaseEndNarrationAction(state: AgentStateData): PolicyAction {
  return {
    type: 'inject_message',
    message: {
      role: 'system',
      content: stepMsg(state, 'PHASE-END NARRATION REQUIRED: This phase is ready to advance and has reached the 3-4 visible-action narration window. This applies across every phase and task type. Write one concise, result-first progress paragraph from the completed work, then emit <next_step/> with no tool call. This is valid even when no more tool calls remain in the phase; do not start the next phase before that paragraph.'),
    },
    continueLoop: true,
  }
}

function rewriteInvalidForcedNarrationAction(): PolicyAction {
  return {
    type: 'inject_message',
    message: {
      role: 'system',
      content: 'The previous progress update was not valid user-facing narration. Rewrite it as one concrete, result-first Manus-style paragraph based only on completed work. Use 15-20 words preferred, hard cap 34 words / 240 characters. Vary the opening verb and sentence shape; do not repeat the same starter pattern. No internal step numbers, no "sufficient evidence" phrasing, no command/action fragments, no malformed sentence joins, and no tool calls.',
    },
    continueLoop: true,
  }
}

function releaseForcedNarrationForProgress(state: AgentStateData): void {
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
  state.iterationsSinceLastContent = 0
  // Leave the cadence close to the boundary so the next visible action gets
  // another chance to produce narration, but do not keep tools disabled.
  state.visibleToolActionsSinceLastNarration = Math.min(2, state.visibleToolActionsSinceLastNarration)
}

/** Get the minimum tool calls required for this task's complexity level */
function minToolCalls(state: AgentStateData): number {
  const c = state.taskComplexity as 1 | 2 | 3
  if (isResearchLikeStep(state)) {
    if (currentStepHasSingleWebSearchLimit(state)) return 1
    return researchDepthProfileForState(state).requiredCalls
  }
  return MIN_TOOL_CALLS_BY_COMPLEXITY[c] ?? MIN_TOOL_CALLS_PER_STEP
}

function isResearchLikeStep(state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentStepIdx === state.currentPlanItems.length - 1) return false
  if (state.taskStrategy === 'browse' || state.taskStrategy === 'creative') return false
  if (state.taskStrategy === 'build' || state.taskStrategy === 'code') {
    return isResearchStepText(currentStepText(state))
  }
  return state.taskStrategy === 'research' || state.currentPhase === 'research'
}

function researchDepthStatus(state: AgentStateData): {
  complete: boolean
  requiredCalls: number
  calls: number
  pages: number
  domains: number
  message: string
} {
  const fixedSearchLimit = currentStepWebSearchLimit(state)
  const profile = researchDepthProfileForState(state)
  const requiredCalls = fixedSearchLimit ?? profile.requiredCalls
  const searchOnly = profile.fixedSearchOnly
  const calls = state.stepResearchCallCount
  const pages = state.stepVisitedUrls.size
  const domains = state.stepSourceDomainCounts.size
  const missing: string[] = []
  if (calls < requiredCalls) missing.push(`${requiredCalls - calls} more research call${requiredCalls - calls === 1 ? '' : 's'}`)
  if (!searchOnly) {
    const requiredSourceBreadth = profile.requiredSourceBreadth
    if (requiredSourceBreadth > 0 && domains < requiredSourceBreadth) {
      missing.push(`${requiredSourceBreadth} opened distinct source domain${requiredSourceBreadth === 1 ? '' : 's'}`)
    }
  }
  return {
    complete: missing.length === 0,
    requiredCalls,
    calls,
    pages,
    domains,
    message: searchOnly
      ? (missing.length > 0
          ? `Fixed-search constraint is not satisfied yet: make exactly ${requiredCalls} web_search call${requiredCalls === 1 ? '' : 's'}, then advance without browsing result URLs. Current depth: ${calls}/${requiredCalls} search calls.`
          : `Fixed-search constraint satisfied: ${calls}/${requiredCalls} search call${calls === 1 ? '' : 's'} made. Advance without browsing result URLs or searching again.`)
      : missing.length > 0
      ? `Research still needs ${missing.join(', ')} before this phase is credible. Use one targeted source/tool next; do not advance from snippets alone.`
      : `Research depth is sufficient: ${calls}/${requiredCalls} research calls, ${pages} page${pages === 1 ? '' : 's'}, ${domains} source domain${domains === 1 ? '' : 's'}.`,
  }
}

function researchNotesPath(state: AgentStateData): string {
  return `research-notes/step-${state.currentStepIdx + 1}.md`
}

function shouldRequireResearchNotes(state: AgentStateData): boolean {
  void state
  // Research notes are useful when explicitly requested, but making them a
  // runtime prerequisite caused ordinary research phases to stall and loop.
  // The final answer/deliverable should carry the work unless a higher-level
  // planner/custom instruction explicitly created a file-writing phase.
  return false
}

function hasCurrentStepResearchNotes(state: AgentStateData): boolean {
  const exactPath = researchNotesPath(state)
  const stepMarker = `step-${state.currentStepIdx + 1}`
  return [...state.createdFiles].some(path => {
    const normalized = path.toLowerCase()
    return normalized === exactPath ||
      (normalized.endsWith('.md') && normalized.includes('research-notes') && normalized.includes(stepMarker))
  })
}

function researchNotesGuidance(state: AgentStateData): string {
  const path = researchNotesPath(state)
  return `Before advancing, save phase-scoped research notes with create_file or append_file at ${path}. Include: key findings, source URLs/domains, useful numbers/quotes, contradictions or caveats, and what the next phase should compare. Keep it compact; do not write the final report or implementation yet.`
}

function currentStepWantsImageArtifact(state: AgentStateData): boolean {
  const stepText = state.currentPlanItems?.[state.currentStepIdx] || ''
  return /\b(image|images|photo|photos|picture|pictures|asset|assets|retrieve|return|download)\b/i.test(stepText)
}

function isBrowserActionTask(state: AgentStateData): boolean {
  return state.taskStrategy === 'browse'
}

function browserActionRecoveryGuidance(state: AgentStateData, detail?: string): string {
  const stepText = state.currentPlanItems?.[state.currentStepIdx] || 'the current website action'
  return [
    detail,
    `Browser action recovery for "${stepText}": do NOT write a failure report while the current page still has actionable controls.`,
    'Read TARGET HINTS first, then cross-check the marked screenshot and fresh elements list. Prefer the hinted [N] with its recommended tool unless the screenshot clearly contradicts it.',
    'Do not re-click [SELECTED], [CHECKED], [PRESSED], [CURRENT], [DISABLED], [UNAVAILABLE], or any target the backend just blocked as no-progress. If the wanted control is missing, recover with browser_scroll, browser_find_text, browser_screenshot, browser_get_content, browser_press_key({key:"Escape"}), or a genuinely different browser_navigate.',
    'Only report failure after a concrete hard blocker is visible: CAPTCHA, login, payment, access denied, hard site error, rate limit, sold out, unavailable inventory, or required manual verification.',
  ].filter(Boolean).join('\n')
}

function looksLikePrematureBrowserGiveUp(content: string): boolean {
  const text = content.toLowerCase()
  if (!text.trim()) return false
  if (/\b(successfully|completed|added|submitted|downloaded|checked out|cart contains)\b/.test(text) &&
      !/\b(failure report|could not|unable to|failed|technical limitation|did not complete)\b/.test(text)) {
    return false
  }
  return /\b(failure report|unable to complete|could not complete|can't complete|cannot complete|not able to complete|technical limitations?|task could not be completed|couldn't finish|i have to report|i need to report|dead end|give up|giving up)\b/.test(text)
}

function looksLikeFalseLiveAccessBlocker(content: string): boolean {
  const text = content.toLowerCase()
  if (!text.trim()) return false
  return /\b(?:without live access|no live access|chat environment|this environment|tool access|tools?\s+(?:unavailable|not available|blocked|limited)|web access(?:\s+is)?\s+(?:unavailable|blocked|limited)|blocked from doing|blocked from completing|unable to do the .*search|cannot produce a credible|can't produce a credible|need live access|lack live access|do not have live access|don't have live access)\b/.test(text)
}

function namesHardBrowserBlocker(content: string): boolean {
  return /\b(captcha|2fa|two-factor|login required|sign in required|password|payment required|credit card|checkout payment|access denied|forbidden|blocked by the site|rate limited|sold out|out of stock|unavailable|not available|store unavailable|hard site error|server error)\b/i.test(content)
}

function looksLikeFutureTenseWorkNarration(content: string): boolean {
  const text = content.trim().toLowerCase()
  if (!text) return false
  if (/\b(i(?:'|’)?ll|i will|let me|now i(?:'|’)?ll|i(?:'|’)?m going to|i am going to)\b.{0,120}\b(build|create|write|research|implement|fix|add|start|run|check|verify|open|browse|search|continue|make)\b/.test(text)) {
    return true
  }
  return /\b(i(?:'|’)?ll|i will|let me|now i(?:'|’)?ll)\b.{0,80}\b(now|next|then)\b/.test(text)
}

function hasConcreteStepProgress(state: AgentStateData): boolean {
  return state.stepToolCallCount > 0 ||
    state.createdFiles.size > 0 ||
    state.workLedger.verifiedOutputs.some(entry => entry.stepIdx === state.currentStepIdx)
}

function deliverableCandidates(state: AgentStateData): Array<{ path: string; purpose: string }> {
  return state.workLedger.deliverableCandidates.filter(item => item.purpose === 'deliverable')
}

function hasFinalDeliverableCandidate(state: AgentStateData): boolean {
  return deliverableCandidates(state).length > 0
}

function latestFinalDeliverableCandidate(state: AgentStateData): { path: string; purpose: string } | null {
  return deliverableCandidates(state).slice(-1)[0] || null
}

function pendingDeliverableRevisionGuidance(state: AgentStateData, path: string): string {
  const pending = state.pendingDeliverableRevision
  const failures = pending?.failures?.length
    ? ` Verification issue${pending.failures.length === 1 ? '' : 's'}: ${pending.failures.join('; ')}.`
    : ' The saved deliverable has not passed final verification yet.'
  const suggestions = pending?.suggestions?.length
    ? ` Suggested fix: ${pending.suggestions.join('; ')}.`
    : ''
  return `FINAL DELIVERABLE REVISION REQUIRED: ${path} is already saved.${failures}${suggestions} Your next response must be exactly one native append_file or edit_file tool call against "${path}". Do not write another status sentence, do not create a new file, and do not repeat that the report was created.`
}

function finalDeliverableRequired(state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentStepIdx !== state.currentPlanItems.length - 1) return false
  if (isBrowserActionTask(state)) return false
  if (currentStepWantsImageArtifact(state)) return false
  if (isFixedWebSearchInlineAnswerState(state)) return false
  const taskText = [
    state.originalUserRequest || '',
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
  ].join(' ')
  return state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative' ||
    explicitSavedArtifactRequested(taskText)
}

function finalStepStartGuidance(state: AgentStateData): string {
  if (isFixedWebSearchInlineAnswerState(state)) {
    return 'This is the final answer step. Answer directly in chat from the fixed web search result, in the requested length. Do not create, mention, attach, or claim any file, report, artifact, or deliverable.'
  }
  return 'This is the DELIVERABLE step. Create the actual final output file using create_file, then append_file for large/chunked output. If the user requested PDF, save the source first and then call export_pdf. Do NOT write a summary or outline — produce the real deliverable.'
}

function explicitSavedArtifactRequested(text: string): boolean {
  return /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|pptx|xlsx)\b/i.test(text) ||
    /\b(?:save|create|write|export|make|generate|deliver|return)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable)\b/i.test(text) ||
    /\b(?:website|web\s*app|next\.?js|page\.tsx|layout\.tsx|globals\.css)\b/i.test(text)
}

function looksLikeSubstantiveInlineAnswer(content: string): boolean {
  const text = content.trim()
  if (text.length < 80) return false
  if (looksLikeFutureTenseWorkNarration(text)) return false
  return /\b(summary|result|found|search|source|news|today|latest|according|released|announced|reported|shows?|includes?)\b/i.test(text) ||
    /(?:^|\n)\s*(?:[-*]|\d+\.)\s+\S/.test(text)
}

function looksLikeCompleteInlineAnswer(content: string): boolean {
  const text = content.trim()
  if (text.length < 60) return false
  if (looksLikeFutureTenseWorkNarration(text)) return false
  const sentences = text
    .split(/[.!?]+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 20)
  return sentences.length >= 1 && /\b(?:is|are|has|have|shows?|suggests?|means?|matters?|challenge|trend|risk|benefit|because|however|therefore|key)\b/i.test(text)
}

function hasMinimumResearchEvidence(state: AgentStateData): boolean {
  const depth = researchDepthStatus(state)
  if (depth.complete) return true
  if (isSubstantiveResearchState(state)) return false
  if (currentStepHasSingleWebSearchLimit(state)) {
    return state.stepSearchQueries.size >= 1 && state.stepResearchCallCount >= 1
  }
  if (state.taskComplexity >= 2) return false
  const hasDirectEvidence = state.stepVisitedUrls.size > 0 ||
    state.stepSearchQueries.size > 0
  const usefulCalls = Math.max(1, Math.min(depth.requiredCalls, 2))
  return hasDirectEvidence && state.stepResearchCallCount >= usefulCalls
}

function researchEvidenceFinding(state: AgentStateData, prefix: string): string {
  const domains = [...state.stepSourceDomainCounts.keys()].slice(0, 3)
  const parts = [
    `${prefix}: ${state.stepResearchCallCount} research call${state.stepResearchCallCount === 1 ? '' : 's'}`,
    `${state.stepVisitedUrls.size} page${state.stepVisitedUrls.size === 1 ? '' : 's'}`,
    domains.length > 0 ? `source domain${domains.length === 1 ? '' : 's'} ${domains.join(', ')}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

function isWebsiteLikeTask(state: AgentStateData): boolean {
  if (!state.buildTask && state.taskStrategy !== 'build' && state.taskStrategy !== 'code') return false
  const planText = [
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
    ...state.createdFiles,
  ].join(' ')
  return /\b(next\.?js|website|web\s*site|webpage|landing page|site|page\.tsx|layout\.tsx|globals\.css|responsive|preview|localhost)\b/i.test(planText)
}

function websiteStructureStatus(state: AgentStateData): { complete: boolean; missing: string[] } {
  const files = [...state.createdFiles].map(path => path.toLowerCase())
  const planText = [
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
    ...files,
  ].join(' ')

  const hasTsx = files.some(path => path.endsWith('.tsx') || path.endsWith('.jsx'))
  const wantsNextStructure = hasTsx || /\b(next\.?js|app\/page\.tsx|layout\.tsx|globals\.css|react|tsx)\b/i.test(planText)
  if (!wantsNextStructure) return { complete: true, missing: [] }

  const hasPage = files.some(path => /(?:^|\/)(?:app\/)?page\.(?:tsx|jsx)$/.test(path))
  const hasLayout = files.some(path => /(?:^|\/)(?:app\/)?layout\.(?:tsx|jsx)$/.test(path))
  const hasStyles = files.some(path => /(?:^|\/)(?:app\/)?globals\.css$/.test(path) || path.endsWith('.css'))
  const hasPackage = files.some(path => /(?:^|\/)package\.json$/.test(path))

  const missing: string[] = []
  if (!hasPackage) missing.push('package.json')
  if (!hasLayout) missing.push('app/layout.tsx with ./globals.css import')
  if (!hasPage) missing.push('app/page.tsx')
  if (!hasStyles) missing.push('app/globals.css or equivalent CSS')

  return { complete: missing.length === 0, missing }
}

function websiteQaStatus(state: AgentStateData): string | null {
  if (!isWebsiteLikeTask(state)) return null
  if (state.createdFiles.size === 0) return null

  const structure = websiteStructureStatus(state)
  if (!structure.complete) {
    return `WEBSITE STRUCTURE CHECK: The generated website still looks incomplete. Missing: ${structure.missing.join(', ')}. Create or repair the missing runnable files before final delivery. Do not leave the user with a lone TSX/page file.`
  }

  if (!state.websiteBrowserCheckDone) {
    const attempted = state.websiteBrowserCheckAttempted
      ? ` The last preview attempt failed${state.nextWebsitePreviewError ? `: ${state.nextWebsitePreviewError}` : ''}; repair the files and re-run the local preview.`
      : ''
    return `LOCAL VISUAL QA REQUIRED: Boot/open the local website preview and inspect it visually before final delivery.${attempted} A website task is not complete until the local preview renders non-blank.`
  }

  if (!state.websiteResponsiveCheckDone) {
    return 'LOCAL VISUAL QA REQUIRED: The website rendered once, but final visual verification is not complete. Use browser_screenshot or browser_scroll on the local preview at the existing browser size, then fix visible layout issues before final delivery.'
  }

  return null
}

function phaseStartGuidance(state: AgentStateData): string {
  if (isResearchLikeStep(state)) {
    return 'Start this phase from its own objective. Build a real evidence packet inside this phase: use targeted searches, open the strongest pages, extract concrete details, and fill mechanism/evidence/example/caveat gaps before advancing.'
  }
  if (isWebsiteLikeTask(state)) {
    return 'Keep website work structured: build the complete runnable file set first, then use the dedicated local visual QA phase for preview inspection and targeted repairs.'
  }
  return 'Continue with this step. Use the right tool for the current phase and do not repeat work from the previous phase.'
}

function researchZeroToolRecoveryGuidance(state: AgentStateData): string {
  const title = state.currentPlanItems?.[state.currentStepIdx] || 'the current research step'
  const scope = state.currentPlanScopes?.[state.currentStepIdx]
  const querySeed = (scope || title)
    .replace(/\s+/g, ' ')
    .replace(/["{}[\]\n\r]/g, ' ')
    .trim()
    .slice(0, 100)

  if (state.uploadedAttachmentContextAvailable) {
    return [
      `UPLOADED ATTACHMENT STEP HAS ZERO EXTERNAL TOOL REQUIREMENT: The current step is "${title}".`,
      scope ? `Scope: ${scope}` : '',
      'Use the uploaded attachment content already present in conversation context. Do not call web_search for attachment filenames/titles. Do not call read_file for uploaded attachment names because read_file only reads workspace/sandbox files.',
      state.uploadedAttachmentContentAvailable
        ? 'Answer from the attached content now, or emit <next_step/> if this preloaded attachment phase is complete.'
        : 'If no attachment text/image content is available in context, report that the uploaded file could not be read from the provided content.',
    ].filter(Boolean).join('\n')
  }

  return [
    `RESEARCH STEP HAS ZERO TOOL CALLS: The current step is "${title}".`,
    scope ? `Scope: ${scope}` : '',
    'Prior step results do not satisfy this step. Do not synthesize yet and do not write another status sentence.',
    `Your next assistant response must be exactly one native tool call, preferably web_search with a query about: "${querySeed}".`,
    `One targeted research call is enough to restart progress; continue only if the result leaves a material evidence gap.`,
  ].filter(Boolean).join('\n')
}

function browserCompletionFinding(state: AgentStateData): string {
  const evidence = state.browserTaskCompletionEvidence.slice(0, 3).join('; ')
  return evidence
    ? `Browser task completion detected: ${evidence}`
    : 'Browser task completion detected from the live page.'
}

/**
 * PolicyContext passed to each policy check.
 * Avoids passing 5+ params through every method.
 */
export interface PolicyContext {
  state: AgentStateData
  toolCalls: Map<number, ToolCallData>
  assistantContent: string
  stepAdvancedThisIteration: boolean
  iterationLimit: number
}

export class PolicyEngine {
  /**
   * Evaluate all policies in priority order.
   * Policies are grouped into tiers:
   *   Tier 1 (Critical): Termination guards — run first, immediate exit on terminate
   *   Tier 2 (High): Loop/failure detection — run next, terminate if detected
   *   Tier 3 (Normal): Nudges and guidance — accumulated into actions
   */
  evaluate(
    state: AgentStateData,
    toolCalls: Map<number, ToolCallData>,
    assistantContent: string,
    stepAdvancedThisIteration: boolean,
    iterationLimit: number,
  ): PolicyAction[] {
    const ctx: PolicyContext = { state, toolCalls, assistantContent, stepAdvancedThisIteration, iterationLimit }

    // Clear forced-text flag when the model produced text without tools — the
    // forced narration iteration succeeded. Must happen before checkNoToolCalls
    // since that method can return early and skip checkNarrationNudge.
    if (state.forceTextNextIteration && isAcceptableForcedNarration(assistantContent) && toolCalls.size === 0) {
      state.forceTextNextIteration = false
      state.forcedNarrationRepairAttempts = 0
      state.iterationsSinceLastContent = 0
      state.visibleToolActionsSinceLastNarration = visibleActionsAfterAcceptedNarration(state.visibleToolActionsSinceLastNarration)
    }

    if (
      state.forceTextNextIteration &&
      toolCalls.size === 0 &&
      !assistantContent.trim()
    ) {
      releaseForcedNarrationForProgress(state)
      state.consecutiveNoToolCalls = 0
      return []
    }

    if (
      !state.forceTextNextIteration &&
      toolCalls.size === 0 &&
      assistantContent.trim() &&
      state.currentPlanItems &&
      state.currentStepIdx < state.currentPlanItems.length &&
      state.visibleToolActionsSinceLastNarration >= 3 &&
      isValidProgressNarration(assistantContent)
    ) {
      state.iterationsSinceLastContent = 0
      state.consecutiveNoToolCalls = 0
      state.forcedNarrationRepairAttempts = 0
      state.visibleToolActionsSinceLastNarration = visibleActionsAfterAcceptedNarration(state.visibleToolActionsSinceLastNarration)
      if (!stepAdvancedThisIteration) return []
    }

    if (
      toolCalls.size === 0 &&
      assistantContent.trim() &&
      state.currentPlanItems &&
      state.currentStepIdx < state.currentPlanItems.length - 1 &&
      state.visibleToolActionsSinceLastNarration >= 4 &&
      !isAcceptableForcedNarration(assistantContent)
    ) {
      state.forcedNarrationRepairAttempts++
      if (state.forcedNarrationRepairAttempts >= 2) {
        releaseForcedNarrationForProgress(state)
        return []
      }
      state.iterationsSinceLastContent++
      return []
    }

    // Invalid forced narration must be repaired before generic no-tool guards.
    // Otherwise malformed progress text can be treated like an ordinary
    // text-only iteration and the mandatory narration turn gets lost.
    if (
      state.forceTextNextIteration &&
      toolCalls.size === 0 &&
      assistantContent.trim() &&
      !isAcceptableForcedNarration(assistantContent)
    ) {
      state.forcedNarrationRepairAttempts++
      if (state.forcedNarrationRepairAttempts >= 2) {
        releaseForcedNarrationForProgress(state)
        return []
      }
      state.iterationsSinceLastContent++
      releaseForcedNarrationForProgress(state)
      return []
    }

    if (state.forceTextNextIteration && toolCalls.size > 0) {
      if (isAcceptableForcedNarration(assistantContent)) {
        state.forceTextNextIteration = false
        state.forcedNarrationRepairAttempts = 0
        state.iterationsSinceLastContent = 0
        state.visibleToolActionsSinceLastNarration = Math.min(1, state.visibleToolActionsSinceLastNarration)
      } else {
        // Do not block useful progress for a narration-only repair turn.
        // The next request will still carry the cadence reminder.
        releaseForcedNarrationForProgress(state)
      }
    }

    // Always track step iterations BEFORE any early returns.
    // Without this, early returns from checkNoToolCalls, checkRewriteLoop, etc.
    // prevent stepIterationCount from ever incrementing, so budget enforcement
    // at checkStepAdvancement never fires and the agent gets stuck on step 0.
    // advanceStep() resets this to 0 when a step actually advances.
    if (state.currentPlanItems && state.currentPlanItems.length > 0) {
      state.stepIterationCount++
    }

    // ── Tier 1: Critical guards (terminate immediately if triggered) ──

    const falseLiveAccessBlocker = this.checkFalseLiveAccessBlocker(state, assistantContent, toolCalls)
    if (falseLiveAccessBlocker) return falseLiveAccessBlocker

    // Refusal detection — model produced an "I can't" response. Inject a hard
    // capability reminder and force it to retry with tools.
    const refusalAction = this.checkRefusal(assistantContent, toolCalls)
    if (refusalAction) return refusalAction

    const prematureGiveUp = this.checkPrematureBrowserGiveUp(state, assistantContent, toolCalls)
    if (prematureGiveUp) return prematureGiveUp

    const futureNarration = this.checkFutureTenseAfterProgress(state, assistantContent, toolCalls)
    if (futureNarration) return futureNarration

    // Stuck-click detection — model is clicking but the page never changes.
    // Runs before tier 2 loop checks because it's a more specific signal than
    // generic loop detection (and stage 2 blocks or terminates).
    const stuckAction = this.checkBrowserProgress(state, assistantContent)
    if (stuckAction) return stuckAction

    // No tool calls tracking
    if (toolCalls.size === 0) {
      // If the model output <next_step/>, process step advancement even without tool calls.
      // This MUST run before checkNoToolCalls, which returns early and would swallow the signal.
      if (stepAdvancedThisIteration && state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
        console.log(`[Policy] <next_step/> detected in text-only response — routing to checkStepAdvancement`)
        state.consecutiveNoToolCalls = 0
        const stepActions = this.checkStepAdvancement(state, stepAdvancedThisIteration, iterationLimit, assistantContent)
        if (stepActions.length > 0) return stepActions
      }

      console.log(`[Policy] No tool calls. Step ${state.currentStepIdx}/${state.currentPlanItems?.length || 0}, consecutiveNoTool=${state.consecutiveNoToolCalls}, stepToolCalls=${state.stepToolCallCount}`)
      const noToolActions = this.checkNoToolCalls(state, assistantContent)
      if (noToolActions.some(a => a.type === 'terminate')) {
        console.log(`[Policy] TERMINATING from checkNoToolCalls`)
        return noToolActions
      }
      if (noToolActions.length > 0) return noToolActions
    } else {
      state.consecutiveNoToolCalls = 0
      state.browserNoToolRecoveryAttempts = 0
    }

    const postComplete = this.checkPostCompletion(state)
    if (postComplete) {
      console.log(`[Policy] TERMINATING from checkPostCompletion. stepIdx=${state.currentStepIdx}, planLength=${state.currentPlanItems?.length}, postCompletionIter=${state.postCompletionIterations}`)
      return [postComplete]
    }

    const rewriteActions = this.checkRewriteLoop(state)
    // Only return early on rewrite TERMINATE — warnings must not block
    // tier 2/3 checks (especially checkStepAdvancement budget enforcement)
    if (rewriteActions.some(a => a.type === 'terminate')) return rewriteActions

    const runawayAction = this.checkNoPlanRunaway(state)
    if (runawayAction) return [runawayAction]

    // ── Tier 2: Loop and failure detection (may terminate) ──

    const tier2Actions: PolicyAction[] = [...rewriteActions]

    const loopActions = this.checkLoopDetection(state)
    if (loopActions) {
      const terminate = loopActions.find(a => a.type === 'terminate')
      if (terminate) return [terminate]
      tier2Actions.push(...loopActions)
    }

    // Click oscillation: agent flailing between distinct targets without committing.
    // Runs after generic loop detection so the more specific signal wins on display.
    const oscillationAction = this.checkClickOscillation(state)
    if (oscillationAction) tier2Actions.push(oscillationAction)

    const semanticLoop = this.checkSemanticSearchLoop(state)
    if (semanticLoop) {
      if (semanticLoop.type === 'terminate') return [semanticLoop]
      tier2Actions.push(semanticLoop)
    }

    // ── Tier 3: Guidance and nudges (accumulated, never contradict tier 1/2) ──

    const tier3Actions: PolicyAction[] = []

    const narration = this.checkNarrationNudge(state, toolCalls, assistantContent)
    if (narration) tier3Actions.push(narration)

    const searchActions = this.checkSearchFailure(state)
    tier3Actions.push(...searchActions)

    const browseAction = this.checkBrowseFailure(state)
    if (browseAction) tier3Actions.push(browseAction)

    const failureDiag = this.checkFailureDiagnosis(state)
    if (failureDiag) tier3Actions.push(failureDiag)

    const completeness = this.checkResearchCompleteness(state)
    if (completeness) tier3Actions.push(completeness)

    const sourceDiversity = this.checkSourceDiversity(state)
    if (sourceDiversity) tier3Actions.push(sourceDiversity)

    const circuitAction = this.checkCircuitBreakers(state, toolCalls)
    if (circuitAction) tier3Actions.push(circuitAction)

    const driftAction = this.checkStepDrift(state, toolCalls)
    if (driftAction) tier3Actions.push(driftAction)

    // On iteration 1 of each research step, ask the model to commit to a micro-plan.
    // The plan is captured by StreamProcessor's <plan> parser and surfaced in every
    // subsequent step message via stepMsg() until advanceStep() clears it.
    const microPlanAction = this.checkMicroPlanRequest(state)
    if (microPlanAction) tier3Actions.push(microPlanAction)

    // Phase 10 Fix III: detect atomic-step drift. Atomic steps ("Navigate to X",
    // "Open the homepage") should complete in 1-3 iterations. Stage 1 nudges at
    // iter 3+; Stage 2 blocks at iter 5+ if Stage 1 was ignored.
    const atomicDriftActions = this.checkAtomicStepDrift(state)
    if (atomicDriftActions) {
      const terminate = atomicDriftActions.find(a => a.type === 'terminate')
      if (terminate) return [terminate]
      tier3Actions.push(...atomicDriftActions)
    }

    // Force a structured reflection when the step has been spinning without progress.
    // Stage 2 blocks if Stage 1 was ignored — must check for terminate too.
    const reflectionActions = this.checkStepReflection(state)
    if (reflectionActions) {
      const terminate = reflectionActions.find(a => a.type === 'terminate')
      if (terminate) return [terminate]
      tier3Actions.push(...reflectionActions)
    }

    const stepActions = this.checkStepAdvancement(state, stepAdvancedThisIteration, iterationLimit, assistantContent)
    if (stepActions.some(a => a.type === 'terminate')) return stepActions
    tier3Actions.push(...stepActions)

    const slowAction = this.checkSlowProgress(state)
    if (slowAction) tier3Actions.push(slowAction)

    const limitAction = this.checkIterationLimit(state, iterationLimit)
    if (limitAction) tier3Actions.push(limitAction)

    const qualityAction = this.checkDeliverableQuality(state)
    if (qualityAction) tier3Actions.push(qualityAction)

    // Check for any late terminate in tier 3 (e.g., step budget exhaustion)
    const terminateAction = [...tier2Actions, ...tier3Actions].find(a => a.type === 'terminate')
    if (terminateAction) return [terminateAction]

    return [...tier2Actions, ...tier3Actions]
  }

  /**
   * Detect "I can't / I'm an AI / I cannot access" style refusals. The model has REAL tools,
   * so any such refusal is a hallucinated limitation. Inject a hard capability reminder
   * and force it to retry with the actual tools instead of giving up.
   */
  private checkRefusal(assistantContent: string, toolCalls: Map<number, ToolCallData>): PolicyAction[] | null {
    if (!assistantContent || assistantContent.length < 20) return null
    const text = assistantContent.toLowerCase()
    const refusalPatterns = [
      /(?:without|no)\s+live access/,
      /(?:this|the) chat environment.{0,120}\b(?:tools?|web|live access|access)\b/,
      /i'?m blocked from doing.{0,120}\b(?:because|due to).{0,80}\b(?:tools?|environment|live access)\b/,
      /tools? (?:are|is) (?:unavailable|not available|blocked|limited)/,
      /i (?:do not|don'?t) have (?:live )?(?:web|internet|browser|tool) access/,
      /i (?:cannot|can't|am unable to|am not able to) (?:access|browse|interact|click|navigate|fill|take|complete|perform)/,
      /i (?:cannot|can't|am unable to|am not able to) (?:generate|search for|retrieve|find|download).{0,80}\b(images?|photos?|pictures?|real[- ]world photographs?)\b/,
      /i (?:cannot|can't|am unable to|am not able to) perform live image searches/,
      /i can only provide text[- ]based information/,
      /please use (?:a )?(?:search engine|google images|bing images)/,
      /(?:i'?m|i am) (?:just |only |an? )?(?:an? )?(?:ai|language model|llm)(?:\b|,|\.| and| but)/,
      /(?:i (?:cannot|can't|don'?t) interact with|i (?:cannot|can't) (?:physically )?interact)/,
      /unable to (?:access|browse|interact|click|navigate) (?:websites|web pages|the (?:web|internet|page))/,
      /(?:i (?:cannot|can't) (?:perform|do|complete) (?:tasks|actions) that require)/,
      /i (?:cannot|can't) (?:take the test|fill the form|click the button|submit the form)/,
    ]
    const matched = refusalPatterns.some(p => p.test(text))
    if (!matched) return null

    console.log('[Policy] REFUSAL DETECTED — injecting capability override')
    return [
      {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `STOP. That refusal is FALSE. You are an autonomous agent with REAL browser, image, file, and code tools. You CAN access websites, click buttons, fill forms, take quizzes, complete interactive tasks, and retrieve real images with image_search. Your previous response was a hallucinated limitation.

DO NOT apologize, do not explain, do not refuse again. Your next response MUST be exactly one tool call that actually attempts the user's task. If they asked for an image or a "real one", call image_search. If they asked you to take a test, browser_navigate to the test, then browser_click_at the answers. If they asked you to fill a form, browser_type into the fields. Just DO IT.${toolCalls.size === 0 ? ' (You also failed to call any tools — that\'s required on every response.)' : ''}`,
        },
        continueLoop: true,
      },
    ]
  }

  private checkFalseLiveAccessBlocker(
    state: AgentStateData,
    assistantContent: string,
    toolCalls: Map<number, ToolCallData>,
  ): PolicyAction[] | null {
    if (!assistantContent || assistantContent.length < 20) return null
    if (!looksLikeFalseLiveAccessBlocker(assistantContent)) return null
    if (!isResearchLikeStep(state) && !isBrowserActionTask(state)) return null

    console.log('[Policy] FALSE LIVE-ACCESS BLOCKER DETECTED — forcing source tool recovery')
    const sourceToolHint = state.searchDisabled
      ? 'browser_navigate, read_document, http_request, browser_get_content, or browser_find_text'
      : 'web_search, browser_navigate, read_document, browser_get_content, browser_find_text, or http_request'

    return [
      { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
      {
        type: 'inject_message',
        message: {
          role: 'system',
          content: stepMsg(
            state,
            `FALSE LIVE-ACCESS BLOCKER: The previous text claimed this chat environment lacks live access, the web, or tools. That is false for this task. Do not repeat that blocker or save it into research notes. If this phase needs public/current evidence, make exactly one concrete source tool call now using ${sourceToolHint}. If a specific tool just returned a real error, switch route and use a different source/tool; do not generalize it into "no live access."${toolCalls.size === 0 ? ' You also made no native tool call; the next response must be one native tool call.' : ''}`,
          ),
        },
        continueLoop: true,
      },
    ]
  }

  /**
   * Browser action tasks should not turn a recoverable UI state into a final
   * failure report. If the model starts giving up without naming a concrete hard
   * blocker, force it back into browser recovery.
   */
  private checkPrematureBrowserGiveUp(
    state: AgentStateData,
    assistantContent: string,
    toolCalls: Map<number, ToolCallData>,
  ): PolicyAction[] | null {
    if (!isBrowserActionTask(state)) return null
    if (state.browserTaskCompleted) return null
    const toolArgumentText = Array.from(toolCalls.values()).map(tc => tc.arguments || '').join('\n')
    const combinedText = `${assistantContent}\n${toolArgumentText}`
    if (!looksLikePrematureBrowserGiveUp(combinedText)) return null
    if (namesHardBrowserBlocker(combinedText)) return null

    const hasBrowserTool = Array.from(toolCalls.values()).some(tc => tc.name.startsWith('browser_'))
    if (hasBrowserTool) return null

    console.log('[Policy] PREMATURE BROWSER GIVE-UP DETECTED — forcing recovery')
    state.consecutiveNoToolCalls = 0
    state.stepLoopDetections = 0
    state.consecutiveNoProgressClicks = Math.min(state.consecutiveNoProgressClicks, 2)
    return [
      { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
      {
        type: 'inject_message',
        message: {
          role: 'system',
          content: browserActionRecoveryGuidance(
            state,
            'PREMATURE FAILURE BLOCKED: You started to give up without proving a hard blocker. The user expects persistence when the page is still actionable.',
          ),
        },
        continueLoop: true,
      },
    ]
  }

  private checkFutureTenseAfterProgress(
    state: AgentStateData,
    assistantContent: string,
    toolCalls: Map<number, ToolCallData>,
  ): PolicyAction[] | null {
    if (toolCalls.size > 0) return null
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null
    if (!hasConcreteStepProgress(state)) return null
    if (!looksLikeFutureTenseWorkNarration(assistantContent)) return null

    return [
      { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
      {
        type: 'inject_message',
        message: {
          role: 'system',
          content: stepMsg(
            state,
            'FUTURE-TENSE STATUS BLOCKED: Work has already started on this phase. Do not say what you will do next as a standalone message. Either make the next concrete tool call now, save/verify the deliverable, emit <next_step/> if the phase is complete, or provide a factual blocker/result based on completed work.',
          ),
        },
        continueLoop: true,
      },
    ]
  }

  /**
   * Detect "click happened but page never changed" loops. The state hash in
   * ToolPipeline increments consecutiveNoProgressClicks each time an interactive
   * browser tool returns the same URL/title/elements as the previous call.
   *
   * Stage 1 (>= 3): Inject a strong nudge telling the model the click is a no-op
   *   and to scroll, pick a different @(x,y), or navigate elsewhere.
   * Stage 2 (>= 5): Block the current step. A stuck prerequisite is not allowed
   *   to advance the plan, because later steps would be based on false progress.
   */
  private checkBrowserProgress(state: AgentStateData, assistantContent: string): PolicyAction[] | null {
    if (state.browserTaskCompleted) return null
    const stuck = state.consecutiveNoProgressClicks
    if (stuck < 3) return null

    console.log(`[Policy] STUCK CLICK DETECTED: ${stuck} consecutive no-progress browser actions`)

    if (isBrowserActionTask(state)) {
      if (stuck >= 5) {
        // Browser action tasks often remain on the same URL/title/elements while
        // a configurator option is already selected. Do not block or terminate;
        // reset to a soft-warning state and make the model recover.
        state.consecutiveNoProgressClicks = 2
      }
      return [
        { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
        {
          type: 'inject_message',
          message: {
            role: 'system',
            content: browserActionRecoveryGuidance(
              state,
              `Your last ${stuck} browser actions left the page visually unchanged. Treat that as a signal to change tactics, not as permission to give up.`,
            ),
          },
          continueLoop: true,
        },
      ]
    }

    // Stage 2: hard intervention
    if (stuck >= 5) {
      // Reset so the next step starts clean
      state.consecutiveNoProgressClicks = 0
      state.lastBrowserStateHash = null

      const isLastStep = !!state.currentPlanItems &&
        state.currentStepIdx === state.currentPlanItems.length - 1

      if (!isLastStep && state.currentPlanItems) {
        if (isResearchLikeStep(state)) {
          const depth = researchDepthStatus(state)
          if (!depth.complete) {
            state.consecutiveNoProgressClicks = 2
            return [
              { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
              {
                type: 'inject_message',
                message: {
                  role: 'system',
                  content: stepMsg(state, `Your last ${stuck} browser actions left the page unchanged. ${depth.message} Stop clicking the same page; use browser_get_content, browser_find_text, browser_scroll, or navigate to a different useful source.`),
                },
                continueLoop: true,
              },
            ]
          }
        }
        return blockCurrentStep(state, `${stuck} consecutive browser clicks made no visible progress`, 'browser_stuck_step')
      }

      // Last step or no plan — terminate
      return [{ type: 'terminate', reason: 'browser_stuck_loop' }]
    }

    // Stage 1: nudge
    return [
      { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
      {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `STOP. Your last ${stuck} browser actions left the page UNCHANGED — same URL, same title, same elements. The clicks are hitting empty space or dead pixels. DO NOT click the same coordinates again. Instead: (1) browser_get_content to read the loaded article, (2) browser_find_text for a relevant section, (3) browser_scroll('down') to reveal new elements, or (4) browser_navigate to a different unvisited source domain.`,
        },
        continueLoop: true,
      },
    ]
  }

  /**
   * Detect "indecisive flailing" — clicking back and forth between distinct
   * targets without committing to a strategy. The regular loop detector misses
   * this because no single target hits LOOP_THRESHOLD.
   *
   * When detected, inject a focused nudge naming the targets so the model
   * sees its own oscillation pattern and is forced to commit. We do NOT
   * terminate or block — checkBrowserProgress already handles those
   * cases when actual progress stops.
   */
  private checkClickOscillation(state: AgentStateData): PolicyAction | null {
    const result = detectClickOscillation(state)
    if (!result.oscillating) return null

    // Only nudge once per step — the agent needs a chance to recover after
    // hearing the warning. The flag is reset in advanceStep().
    if (state.clickOscillationNudged) return null
    state.clickOscillationNudged = true

    console.log(`[Policy] CLICK OSCILLATION DETECTED: ${result.revisits} revisits among ${result.targets.length} targets`)

    // Format targets for human-readable display in the nudge
    const targetList = result.targets.slice(0, 4).map(t => {
      // Strip the "click_at:" / "click:" prefix for readability
      return t.replace(/^(click_at|click|type|browser_hover):/, '')
    }).join(', ')

    return {
      type: 'inject_message',
      message: {
        role: 'system',
        content: `INDECISION DETECTED. You've been clicking back and forth between these targets without committing: [${targetList}]. This is flailing — none of these clicks are advancing your goal.

STOP and decide:
1. What is the ONE objective for THIS step? (e.g., "fill the search box", "click the login button", "answer question 3")
2. Which SINGLE element is the right one to click for that objective?
3. Click it ONCE. If the page changes, continue. If it doesn't, the click missed — pick a DIFFERENT @(x,y) from the FRESH elements list, OR scroll, OR navigate elsewhere.

Do NOT click any of [${targetList}] again unless you're certain it's the correct element. Pick ONE strategy and execute it.`,
      },
      continueLoop: true,
    }
  }

  /**
   * On the FIRST iteration of a research step, prompt the model to write a
   * <plan>...</plan> block in its next text response. The plan is parsed by
   * StreamProcessor and persisted on state.stepMicroPlan, then re-surfaced in
   * every subsequent step message via stepMsg() until advanceStep() clears it.
   *
   * Skipped on the deliverable step (model writes prose, not actions) and only
   * fires once per step.
   */
  private checkMicroPlanRequest(state: AgentStateData): PolicyAction | null {
    void state
    // Do not force a separate per-step planning turn. It slows the agent down
    // and was causing "text-only reply" guard failures before useful tool calls.
    // The model may still emit <plan> voluntarily; StreamProcessor will capture it.
    return null

    /*
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null
    if (state.stepMicroPlanRequested) return null
    if (state.stepMicroPlan) return null  // already captured (model emitted it spontaneously)
    if (state.stepIterationCount !== 1) return null  // only on iteration 1 of a step

    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    if (isLastStep) return null  // deliverable step writes prose, not actions

    state.stepMicroPlanRequested = true
    const stepText = state.currentPlanItems[state.currentStepIdx]
    console.log(`[Policy] MICRO-PLAN REQUESTED for step ${state.currentStepIdx + 1}`)

    return {
      type: 'inject_message',
      message: {
        role: 'system',
        content: `Before your next tool call, write a <plan>...</plan> block in your text response listing 2-5 micro-actions you will take to complete this step:

  "${stepText}"

Format:
<plan>
1. <first action — be specific>
2. <second action>
3. <third action>
</plan>

Then make your first tool call. Your plan will be remembered across iterations of this step — you do NOT need to repeat it. If your plan turns out to be wrong, just adapt — the runtime will not enforce it as a checklist, but it will remind you what you committed to. Keep the plan SHORT and CONCRETE.`,
      },
    }
    */
  }

  /**
   * Force a structured reflection when a step has been spinning without progress.
   *
   * Phase 10 Fix III: detect when the model is overrunning an atomic step.
   *
   * Atomic steps ("Navigate to woolworths.com.au homepage", "Open the page",
   * "Visit example.com") are SINGLE actions. They should complete in 1-3
   * iterations. When the model burns more than 3 iterations on an atomic step,
   * it's typically because it's bleeding work from the NEXT step into this one
   * (e.g., typing a search query into the homepage when "search for X" is the
   * next step). This nudge tells the model to emit <next_step/> immediately.
   *
   * Fires once per step, before checkStepReflection. Resets via
   * advanceStep()'s flag-reset block.
   */
  private checkAtomicStepDrift(state: AgentStateData): PolicyAction[] | null {
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null
    const stepText = state.currentPlanItems[state.currentStepIdx]
    if (isResearchLikeStep(state)) return null
    if (!isAtomicStep(stepText)) return null

    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    const browserAction = isBrowserActionTask(state)

    // Phase 10 Fix III-B: Stage 2 — block if Stage 1 was ignored.
    // The original implementation only nudged once and the model could ignore it
    // for 6+ more iterations (observed: step 1 ran 9 actions on a "Navigate to..."
    // step). This fires at iter 5+ because by then the model has had two chances
    // to advance: the iter-3 nudge and another two iterations to obey it.
    if (state.atomicStepDriftNudged && state.stepIterationCount >= 5 && !isLastStep) {
      if (browserAction) {
        state.atomicStepDriftNudged = false
        return [{
          type: 'inject_message',
          message: {
            role: 'system',
            content: browserActionRecoveryGuidance(
              state,
              `Atomic-step guard: "${stepText}" has taken ${state.stepIterationCount} iterations, but browser action tasks must keep working while the site is still usable.`,
            ),
          },
          continueLoop: true,
        }]
      }
      console.log(`[Policy] ATOMIC STEP DRIFT — auto-advancing step ${state.currentStepIdx + 1} "${stepText}" after ${state.stepIterationCount} iterations`)
      advanceStep(state, `Moved past atomic step after ${state.stepIterationCount} iterations`)
      if (state.currentStepIdx >= state.currentPlanItems.length) {
        return [{ type: 'step_advance' }]
      }
      return [
        { type: 'step_advance' },
        {
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, phaseStartGuidance(state)),
          },
          continueLoop: true,
        },
      ]
    }

    // Stage 1: first nudge at iteration 3+
    if (state.atomicStepDriftNudged) return null
    if (state.stepIterationCount < 3) return null

    state.atomicStepDriftNudged = true
    console.log(`[Policy] ATOMIC STEP DRIFT — step ${state.currentStepIdx + 1} "${stepText}" has run ${state.stepIterationCount} iterations`)
    if (browserAction) {
      return [{
        type: 'inject_message',
        message: {
          role: 'system',
          content: browserActionRecoveryGuidance(
            state,
            `This looks like a single-action step ("${stepText}"), but do not skip it unless the specific browser objective is actually done. If navigation/dismissal is complete, emit <next_step/>. Otherwise continue with a different browser action.`,
          ),
        },
      }]
    }
    return [{
      type: 'inject_message',
      message: {
        role: 'system',
        content: `STOP. The current step is "${stepText}" — that's a SINGLE ACTION. You've used ${state.stepIterationCount} iterations. The page has already loaded. Emit <next_step/> NOW and move to the next step. Do NOT type queries, do NOT search, do NOT click extra links — that work belongs to the next step, not this one. ⚠ If you do not advance within 2 more iterations, this step will be FORCE-ADVANCED.`,
      },
    }]
  }

  /**
   *
   * Triggered when the step has run for >= 6 iterations and we haven't already
   * forced reflection on this step. The model is required to answer four
   * questions in its next text response: goal, accomplished, blocker, next-action.
   * This re-orients the agent and surfaces "I don't know what I'm doing" honestly
   * instead of letting it keep spinning.
   *
   * Skipped on the deliverable step — the model legitimately needs runway there
   * to write substantial content.
   */
  private checkStepReflection(state: AgentStateData): PolicyAction[] | null {
    void state
    // Reflection prompts became a second planning loop: the model would answer
    // the reflection instead of taking the next tool action, and downstream
    // guards then stopped the task for "no tool progress". Keep progress checks
    // tool/result driven instead of adding mandatory reflection turns.
    return null

    /*
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null
    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    if (isLastStep) return null  // deliverable step needs writing runway

    // Stage 2: block if Stage 1 was ignored (still no new research after 6+ more iterations)
    if (state.stepReflectionNudged && state.stepIterationCount >= 12) {
      const noResearchProgress = state.stepResearchCallCount === state.stepResearchCallsAtReflection
      const noToolProgress = state.stepToolCallCount === state.stepToolCallsAtReflection
      if (noResearchProgress) {
        if (isBrowserActionTask(state)) {
          state.stepReflectionNudged = false
          state.stepResearchCallsAtReflection = state.stepResearchCallCount
          state.stepToolCallsAtReflection = state.stepToolCallCount
          return [{
            type: 'inject_message',
            message: {
              role: 'system',
              content: browserActionRecoveryGuidance(
                state,
                `You ignored the recovery prompt for ${state.stepIterationCount} iterations. This is still not permission to give up; make a materially different browser call now.`,
              ),
            },
            continueLoop: true,
          }]
        }
        state.stepReflectionNudged = false
        state.stepResearchCallsAtReflection = state.stepResearchCallCount
        state.stepToolCallsAtReflection = state.stepToolCallCount
        state.stepFailureCount++
        console.log(`[Policy] STEP REFLECTION REROUTE — step ${state.currentStepIdx + 1} no verified research progress after reflection`)
        return [{
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(
              state,
              noToolProgress
                ? 'RECOVERY REQUIRED: The previous reflection produced no tool progress. Do not explain, apologize, or summarize. Make exactly one concrete tool call now, scoped to this current phase.'
                : 'RECOVERY REQUIRED: Recent tool calls did not add verified progress for this phase. Stop retrying the same route; use a materially different query/source, or use browser_get_content if the current page is readable.',
            ),
          },
          continueLoop: true,
        }]
      }
    }

    // Stage 1: first nudge at iteration 6+
    if (state.stepReflectionNudged) return null
    if (state.stepIterationCount < 6) return null

    state.stepReflectionNudged = true
    state.stepResearchCallsAtReflection = state.stepResearchCallCount  // Snapshot for Stage 2
    state.stepToolCallsAtReflection = state.stepToolCallCount
    console.log(`[Policy] STEP REFLECTION TRIGGERED at iteration ${state.stepIterationCount} of step ${state.currentStepIdx + 1}`)

    const stepText = state.currentPlanItems[state.currentStepIdx]
    // Prefer the per-step scope (Fix 3) — it's the precise constraint the planner
    // wrote for this step. Fall back to the title when the scope is null (legacy
    // plans / planner returned strings only).
    const scopeOrTitle = state.currentPlanScopes?.[state.currentStepIdx] ?? stepText
    if (isBrowserActionTask(state)) {
      return [{
        type: 'inject_message',
        message: {
          role: 'system',
          content: browserActionRecoveryGuidance(
            state,
            `The scope is "${scopeOrTitle}" and progress is slow. Change tactics; do not skip, force-complete, or write a failure report unless a hard blocker is visible.`,
          ),
        },
        continueLoop: true,
      }]
    }
    return [{
      type: 'inject_message',
      message: {
        role: 'system',
        content: `STOP. The scope of this step is: "${scopeOrTitle}". You've spent ${state.stepIterationCount} iterations and aren't making progress. Make ONE different tool call right now — different URL, different query, or call <next_step/> if you've already covered the scope. Do NOT restate the goal or write a status update — just take a different action.`,
      },
      continueLoop: true,
    }]
    */
  }

  private checkNoToolCalls(state: AgentStateData, assistantContent: string): PolicyAction[] {
    state.consecutiveNoToolCalls++

    if (state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
      const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1

      if (state.emittedImageArtifacts.size > 0 && currentStepWantsImageArtifact(state)) {
        advanceStep(state, `Image artifact already available: ${[...state.emittedImageArtifacts].slice(-3).join(', ')}`)
        state.consecutiveNoToolCalls = 0
        if (state.currentStepIdx >= state.currentPlanItems.length) {
          return [
            { type: 'step_advance' },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: 'The requested image artifact has already been downloaded and shown to the user. You are DONE. Write a natural final response and mention the attached image only if useful. Do NOT force **Summary** or **Deliverables** headings. Do NOT search again and do NOT browse.',
              },
              continueLoop: true,
            },
          ]
        }
        return [
          { type: 'step_advance' },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, 'The requested image artifact is already available. Move to the next step without re-searching or re-downloading it.'),
            },
            continueLoop: true,
          },
        ]
      }

      const finalDeliverable = isLastStep && !isBrowserActionTask(state)
        ? latestFinalDeliverableCandidate(state)
        : null
      if (finalDeliverable) {
        if (state.deliverableVerificationDone) {
          advanceStep(state, `Saved final deliverable: ${finalDeliverable.path}`)
          state.consecutiveNoToolCalls = 0
          return [
            { type: 'step_advance' },
            { type: 'terminate', reason: 'deliverable_created' },
          ]
        }

        const threshold = NO_TOOL_FORCE_ADVANCE * 2
        if (state.consecutiveNoToolCalls >= threshold) {
          state.deliverableVerificationDone = true
          state.pendingDeliverableRevision = null
          advanceStep(state, `Saved final deliverable: ${finalDeliverable.path}`)
          state.consecutiveNoToolCalls = 0
          return [
            { type: 'step_advance' },
            { type: 'terminate', reason: 'deliverable_saved_after_revision_stall' },
          ]
        }

        return [
          {
            type: 'inject_message',
            message: { role: 'assistant', content: assistantContent || '' },
          },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, pendingDeliverableRevisionGuidance(state, finalDeliverable.path)),
            },
            continueLoop: true,
          },
        ]
      }

      if (
        isLastStep &&
        !isBrowserActionTask(state) &&
        (
          (!finalDeliverableRequired(state) && looksLikeSubstantiveInlineAnswer(assistantContent)) ||
          (isFixedWebSearchInlineAnswerState(state) && looksLikeCompleteInlineAnswer(assistantContent))
        )
      ) {
        advanceStep(state, 'Answered inline in chat')
        state.consecutiveNoToolCalls = 0
        return [
          { type: 'step_advance' },
          { type: 'terminate', reason: 'inline_answer_complete' },
        ]
      }

      if (isBrowserActionTask(state) && (!isLastStep || state.createdFiles.size === 0)) {
        if (!isLastStep && state.browserTaskCompleted) {
          const finding = state.browserTaskCompletionEvidence.length > 0
            ? `Verified browser state: ${state.browserTaskCompletionEvidence.slice(0, 3).join('; ')}`
            : 'Verified current browser state satisfies this phase'
          advanceStep(state, finding)
          state.consecutiveNoToolCalls = 0
          return [
            { type: 'step_advance' },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, phaseStartGuidance(state)),
              },
              continueLoop: true,
            },
          ]
        }

        const threshold = isLastStep ? NO_TOOL_FORCE_ADVANCE * 2 : NO_TOOL_FORCE_ADVANCE
        if (state.consecutiveNoToolCalls >= threshold) {
          releaseForcedNarrationForProgress(state)
          state.browserNoToolRecoveryAttempts++
          if (state.browserNoToolRecoveryAttempts > 3 && !isLastStep && state.stepToolCallCount > 0) {
            state.consecutiveNoToolCalls = 0
            state.browserNoToolRecoveryAttempts = 0
            return [
              { type: 'terminate', reason: 'browser_no_tool_recovery_exhausted' },
            ]
          }
          if (state.browserNoToolRecoveryAttempts > 3) {
            state.browserNoToolRecoveryAttempts = 2
            state.consecutiveNoToolCalls = Math.max(0, threshold - 1)
          }
          const recoveryDetail = state.stepToolCallCount === 0
            ? 'NO-TOOL BROWSER START RECOVERY: The website step has not actually started. Do not write more text. Make exactly one concrete browser tool call now, preferably browser_navigate for the target site or browser_get_content/browser_screenshot if the page is already open.'
            : 'NO-TOOL BROWSER RECOVERY: The live page is still actionable. Do not write more text and do not mark the step blocked. Make exactly one concrete browser tool call now on the current page: type into the active field, click the matching result/add button, select the relevant option, inspect content, press Escape to clear a modal, or scroll only if the target is off-screen.'
          return [
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, browserActionRecoveryGuidance(state, recoveryDetail)),
              },
              continueLoop: true,
            },
          ]
        }

        const guidance = isLastStep
          ? 'If the website action is complete or a concrete hard blocker is visible, save the short action report with create_file. If not, use a browser tool now to verify or continue the flow.'
          : browserActionRecoveryGuidance(state, 'Text-only response blocked: browser action steps require another concrete browser action, not narration or failure prose.')
        return [
          { type: 'inject_message', message: { role: 'assistant', content: assistantContent || '' } },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, guidance),
            },
            continueLoop: true,
          },
        ]
      }

      // On research steps that have done enough REAL research, auto-advance after
      // consecutive no-tool iterations. Explicit fixed-search tasks can advance
      // immediately after the requested searches are done; waiting four text-only
      // replies is what caused completed search steps to be marked blocked.
      const autoAdvanceThreshold = currentStepWebSearchLimit(state) !== null ? 1 : 2
      const researchDepth = researchDepthStatus(state)
      if (
        !isLastStep &&
        isResearchLikeStep(state) &&
        hasMinimumResearchEvidence(state) &&
        looksLikeSubstantiveInlineAnswer(assistantContent)
      ) {
        if (shouldRequestPhaseEndNarration(state, assistantContent)) {
          state.consecutiveNoToolCalls = 0
          return [
            {
              type: 'inject_message',
              message: { role: 'assistant', content: assistantContent || '' },
            },
            phaseEndNarrationAction(state),
          ]
        }
        advanceStep(state, researchEvidenceFinding(state, 'Synthesized research evidence'))
        state.consecutiveNoToolCalls = 0

        if (state.currentStepIdx < state.currentPlanItems.length) {
          const isNowLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
          return [
            { type: 'step_advance' },
            {
              type: 'inject_message',
              message: { role: 'assistant', content: assistantContent || '' },
            },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, isNowLastStep ? finalStepStartGuidance(state) : phaseStartGuidance(state)),
              },
              continueLoop: true,
            },
          ]
        }
      }
      if (!isLastStep && researchDepth.complete && shouldRequireResearchNotes(state) && !hasCurrentStepResearchNotes(state)) {
        state.consecutiveNoToolCalls = 0
        return [
          {
            type: 'inject_message',
            message: { role: 'assistant', content: assistantContent || '' },
          },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, researchNotesGuidance(state)),
            },
            continueLoop: true,
          },
        ]
      }
      if (!isLastStep && (!isResearchLikeStep(state) || researchDepth.complete) && state.stepResearchCallCount >= minToolCalls(state) && state.consecutiveNoToolCalls >= autoAdvanceThreshold) {
        if (shouldRequestPhaseEndNarration(state, assistantContent)) {
          state.consecutiveNoToolCalls = 0
          return [
            {
              type: 'inject_message',
              message: { role: 'assistant', content: assistantContent || '' },
            },
            phaseEndNarrationAction(state),
          ]
        }
        advanceStep(state, `Auto-advanced research step after ${state.stepResearchCallCount} research calls`)
        state.consecutiveNoToolCalls = 0

        if (state.currentStepIdx < state.currentPlanItems.length) {
          const isNowLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
          const nextDepth = researchDepthStatus(state)
          const hint = isNowLastStep
            ? finalStepStartGuidance(state)
            : state.currentPhase === 'build' || state.taskStrategy === 'build' || state.taskStrategy === 'code' || state.taskStrategy === 'creative'
              ? 'Continue with this step. Use create_file, append_file, export_pdf, edit_file, or read_file to make concrete saved-file progress.'
              : phaseStartGuidance(state)
          return [
            { type: 'step_advance' },
            {
              type: 'inject_message',
              message: { role: 'assistant', content: assistantContent || '' },
            },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, hint),
              },
              continueLoop: true,
            },
          ]
        }
      }

      // On the deliverable step, do not allow the model to drift through several
      // text-only turns. Synthesis must start as saved work immediately after the
      // phase boundary; long prose belongs in create_file/append_file chunks.
      const threshold = isLastStep ? NO_TOOL_FORCE_ADVANCE * 2 : NO_TOOL_FORCE_ADVANCE

      if (state.consecutiveNoToolCalls < threshold) {
        if (isLastStep) {
          return [
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(
                  state,
                  'FINAL SYNTHESIS TOOL REQUIRED: Do not write another text-only planning, research, or status reply. Make exactly one concrete deliverable tool call now: create_file for the initial saved output, append_file for continuation chunks, edit_file for targeted revisions, read_file/list_files only to inspect existing work, or export_pdf after the source file exists.',
                ),
              },
              continueLoop: true,
            },
          ]
        }

        if (!isLastStep && isResearchLikeStep(state) && !researchDepth.complete) {
          return [
            {
              type: 'inject_message',
              message: { role: 'assistant', content: assistantContent || '' },
            },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, researchDepth.message),
              },
              continueLoop: true,
            },
          ]
        }

        const urgency = state.consecutiveNoToolCalls >= threshold - 1
          ? state.currentPhase === 'build' || state.taskStrategy === 'build' || state.taskStrategy === 'code' || state.taskStrategy === 'creative'
            ? 'You have produced text without saving it. Make exactly one file tool call now: create_file for a new file, append_file for continuation chunks, export_pdf for a completed PDF request, edit_file for targeted replacements, or read_file to inspect existing work.'
            : 'You have produced text without tool calls multiple times. Make a tool call (e.g., create_file or append_file to save your work, export_pdf for a completed PDF request, or web_search for research) to continue making progress.'
          : state.currentPhase === 'build' || state.taskStrategy === 'build' || state.taskStrategy === 'code' || state.taskStrategy === 'creative'
            ? 'You must save progress with tools. Make exactly one create_file, append_file, export_pdf, edit_file, or read_file call now.'
            : 'You must use tools to complete this step. Make a tool call now — for example, use create_file or append_file to save your output, or export_pdf for a completed PDF request.'
        return [
          {
            type: 'inject_message',
            message: { role: 'assistant', content: assistantContent || '' },
          },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, urgency),
            },
            continueLoop: true,
          },
        ]
      }

      // If the model hasn't made ANY tool calls on this step, don't skip it —
      // force it to actually do the work instead of advancing an empty step.
      // Do not reset consecutiveNoToolCalls here: repeated short no-tool
      // responses were observed burning dozens of model turns while appearing
      // idle to the user.
      if (!isLastStep && state.stepToolCallCount === 0) {
        if (isResearchLikeStep(state)) {
          // A zero-tool research step is recoverable: the model is trying to
          // summarize or narrate instead of starting the new phase. Do not end
          // the whole task; force a tool-only retry for the current step.
          state.consecutiveNoToolCalls = Math.min(state.consecutiveNoToolCalls, threshold - 1)
          return [
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, researchZeroToolRecoveryGuidance(state)),
              },
              continueLoop: true,
            },
          ]
        }
        if (state.consecutiveNoToolCalls >= threshold + 2) {
          state.consecutiveNoToolCalls = Math.max(0, threshold - 1)
        }
        return [
          {
            type: 'inject_message',
            message: { role: 'assistant', content: assistantContent || '' },
          },
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state,
                state.currentPhase === 'build' || state.taskStrategy === 'build' || state.taskStrategy === 'code' || state.taskStrategy === 'creative'
                  ? `CRITICAL: You have NOT saved anything on this step. Use create_file for a new file or append_file for a continuation chunk NOW. Use export_pdf only after the source file is complete and the user requested PDF. Use edit_file only for targeted replacements. Do NOT write more prose in the reply. Save it to a file.`
                  : state.uploadedAttachmentContextAvailable
                    ? `UPLOADED ATTACHMENT CONTEXT AVAILABLE: Do NOT use web_search, browser_navigate, or read_file to locate the uploaded attachment. Use the attached content already in context and answer now, or emit <next_step/> if the attachment-read phase is complete. If extracted content is unavailable, report that the uploaded file could not be read from the provided content.`
                  : `CRITICAL: You have NOT made any tool calls on this step. Use web_search for a targeted query or read_document for a known source URL NOW. Use browser_navigate only when rendered state or interaction is needed. Do NOT write text — call a tool immediately. Example: web_search("${state.currentPlanItems[state.currentStepIdx]?.slice(0, 40)}")`
              ),
            },
            continueLoop: true,
          },
        ]
      }

      // Stop instead of skipping the unmet step. Repeated no-tool replies mean
      // the current requirement is unresolved, not that the next step is safe.
      if (!isLastStep && isResearchLikeStep(state) && hasMinimumResearchEvidence(state)) {
        advanceStep(state, researchEvidenceFinding(state, 'Advanced from gathered research evidence after repeated text-only replies'))
        state.consecutiveNoToolCalls = 0
        if (state.currentStepIdx < state.currentPlanItems.length) {
          const isNowLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
          return [
            { type: 'step_advance' },
            {
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, isNowLastStep ? finalStepStartGuidance(state) : phaseStartGuidance(state)),
              },
              continueLoop: true,
            },
          ]
        }
      }
      state.consecutiveNoToolCalls = 0
      if (!isLastStep && isResearchLikeStep(state)) {
        state.consecutiveNoToolCalls = Math.max(0, threshold - 1)
        return [
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(
                state,
                state.uploadedAttachmentContextAvailable
                  ? `UPLOADED ATTACHMENT CONTEXT AVAILABLE: This phase should use the attached file content already in context. Do not compensate with web_search/browser_navigate/read_file for the uploaded filename. Answer from the attachment content, emit <next_step/> if this phase is complete, or report that the uploaded file content could not be read.`
                  : `RESEARCH DEPTH INCOMPLETE: ${researchDepth.message} The previous text-only turns did not finish this phase. Do not write another progress update, synthesis, or failure report. Make exactly one concrete research tool call now, scoped to this step: use web_search with a new specific query, read_document for a known source URL, browser_get_content on an already-open relevant page, or browser_find_text for a concrete term. Use browser_navigate only when rendered state or interaction is needed.`,
              ),
            },
            continueLoop: true,
          },
        ]
      }
      state.consecutiveNoToolCalls = Math.max(0, threshold - 1)
      return [
        {
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(
              state,
              'Progress guard: do not write another text-only status reply. Take one concrete tool action now, or emit <next_step/> if this phase is already complete.',
            ),
          },
          continueLoop: true,
        },
      ]
    }

    // No plan but complex task (plan call likely failed): give the model runway
    // to orient and start making tool calls before terminating.
    if (!state.currentPlanItems && state.taskComplexity > 1) {
      if (state.consecutiveNoToolCalls < NO_TOOL_FORCE_ADVANCE) {
        return [
          {
            type: 'inject_message',
            message: { role: 'assistant', content: assistantContent || '' },
          },
          {
            type: 'inject_message',
              message: {
                role: 'system',
                content: state.uploadedAttachmentContextAvailable
                  ? 'Uploaded attachment context is already loaded for this task. Do not force web_search/read_file for the uploaded filename; answer from the attachment context or report that the uploaded content could not be read.'
                  : 'You must use tools to complete this task. Make a tool call now — for example, use web_search to research, or create_file to produce output.',
              },
              continueLoop: true,
            },
        ]
      }
    }

    // All plan steps complete — let checkPostCompletion handle wrap-up timing
    if (state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length) {
      return []
    }

    // Simple task without plan or stuck → finish
    return [{ type: 'terminate', reason: 'no_plan_or_stuck' }]
  }

  private checkPostCompletion(state: AgentStateData): PolicyAction | null {
    if (state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length) {
      state.postCompletionIterations++
      // Disable forced narration during wind-down — nothing new to report
      state.forceTextNextIteration = false
      state.forcedNarrationRepairAttempts = 0
      if (state.postCompletionIterations > POST_COMPLETION_MAX_ITERATIONS) {
        return { type: 'terminate', reason: 'post_completion_max' }
      }
    }
    return null
  }

  private checkNarrationNudge(
    state: AgentStateData,
    toolCalls: Map<number, ToolCallData>,
    assistantContent: string,
  ): PolicyAction | null {
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null

    const visibleActions = state.visibleToolActionsSinceLastNarration

    if (assistantContent.trim()) {
      const validProgressNarration = state.forceTextNextIteration
        ? isAcceptableForcedNarration(assistantContent)
        : isValidProgressNarration(assistantContent)
      if (!validProgressNarration) {
        state.iterationsSinceLastContent++
        if (state.forceTextNextIteration) {
          state.forcedNarrationRepairAttempts++
          if (state.forcedNarrationRepairAttempts >= 2) {
            state.forceTextNextIteration = false
            state.forcedNarrationRepairAttempts = 0
            state.visibleToolActionsSinceLastNarration = Math.min(2, state.visibleToolActionsSinceLastNarration)
            state.iterationsSinceLastContent = 0
            return null
          }
          return rewriteInvalidForcedNarrationAction()
        }
        return null
      }
      // Narration before 3 visible actions is too early. Do not let it reset
      // the mandatory 3-4 action cadence, otherwise the UI suppresses it and
      // the backend never forces a properly timed update.
      if (visibleActions < 3 && !state.forceTextNextIteration) {
        state.iterationsSinceLastContent++
        return null
      }
      state.iterationsSinceLastContent = 0
      state.visibleToolActionsSinceLastNarration = visibleActionsAfterAcceptedNarration(visibleActions)
      state.forceTextNextIteration = false
      state.forcedNarrationRepairAttempts = 0
    } else {
      state.iterationsSinceLastContent++
    }

    // After 4 completed visible action pills, force a text update. This is based
    // on what the user actually sees, not on raw model iterations, so long
    // browser/search loops cannot skip the narration cadence.
    const threshold = 4

    if (state.visibleToolActionsSinceLastNarration >= threshold && !state.forceTextNextIteration) {
      state.forceTextNextIteration = true
      state.forcedNarrationRepairAttempts = 0
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: 'NARRATION CADENCE RECOVERY: four visible action pills have completed without a valid user-facing progress paragraph. This applies no matter the current phase or task type. The next turn is narration-only: write one concrete Manus-style paragraph from completed work, 15-20 words preferred, hard cap 34 words / 240 characters, and do not call tools.',
        },
        continueLoop: true,
      }
    }

    return null
  }

  private checkSearchFailure(state: AgentStateData): PolicyAction[] {
    const actions: PolicyAction[] = []

    if (state.consecutiveSearchFailures >= CONSECUTIVE_SEARCH_FAILURES_WARN) {
      actions.push({
        type: 'inject_message',
        message: {
          role: 'system',
          content: "IMPORTANT: Search is currently unavailable — ALL providers are down. Do NOT call web_search again. Instead, use browser_navigate to visit well-known websites directly (Wikipedia, official docs, news sites). If the task doesn't require web data, proceed to your final deliverable step now.",
        },
      })
    }

    if (state.totalSearchFailures >= TOTAL_SEARCH_FAILURES_DISABLE && !state.searchDisabled) {
      state.searchDisabled = true
      console.log(`[Search] Permanently disabled after ${TOTAL_SEARCH_FAILURES_DISABLE} total failures`)
      actions.push({
        type: 'inject_message',
        message: {
          role: 'system',
          content: 'CRITICAL: web_search has been permanently disabled for this task. The tool has been removed. Use browser_navigate with direct URLs if you need web information, or proceed with your existing knowledge.',
        },
      })
    }

    return actions
  }

  private checkBrowseFailure(state: AgentStateData): PolicyAction | null {
    if (state.consecutiveBrowseFailures >= CONSECUTIVE_BROWSE_FAILURES_WARN) {
      state.consecutiveBrowseFailures = 0
      if (isBrowserActionTask(state)) {
        return {
          type: 'inject_message',
          message: {
            role: 'system',
            content: browserActionRecoveryGuidance(state, 'Multiple browser attempts failed. That is not enough to give up on an action task; inspect the page and try a different browser tactic.'),
          },
        }
      }
      if (isResearchLikeStep(state)) {
        const depth = researchDepthStatus(state)
        if (!depth.complete) {
          return {
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, `Multiple browse attempts failed. ${depth.message} Switch route: use read_document on a useful source URL, or a more specific web_search query instead of retrying the failed page. Use the full browser only when rendered state is necessary.`),
            },
          }
        }
      }
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: 'IMPORTANT: Multiple browse attempts have failed. Stop trying to browse and proceed with the information you already have. Write your deliverable now.',
        },
      }
    }
    return null
  }

  /**
   * Detect "same tool called N times" loops with per-step escalation:
   *   1st detection: nudge (warn the model, let it recover)
   *   2nd detection in same step: block the step (model didn't take the hint)
   *   3rd detection: terminate the entire task
   *
   * Unlike the old consecutive-counter version, this counter is per-step (resets in
   * advanceStep) and DOES NOT clear recentToolCalls — letting the natural sliding
   * window age out the looping calls. Clearing it gave the model a "fresh start"
   * that defeated escalation entirely.
   */
  private checkLoopDetection(state: AgentStateData): PolicyAction[] | null {
    const loopCheck = detectToolCallLoop(state)
    if (!loopCheck.looping) return null

    state.stepLoopDetections = (state.stepLoopDetections || 0) + 1
    console.log(`[Policy] LOOP DETECTED #${state.stepLoopDetections} this step: "${loopCheck.tool}" x${loopCheck.count}`)

    const isLastStep = !!state.currentPlanItems &&
      state.currentStepIdx === state.currentPlanItems.length - 1

    if (isBrowserActionTask(state)) {
      state.recentToolCalls = []
      state.stepLoopDetections = Math.min(state.stepLoopDetections, 1)
      return [{
        type: 'inject_message',
        message: {
          role: 'system',
          content: browserActionRecoveryGuidance(
            state,
            `Loop blocked: "${loopCheck.tool}" repeated ${loopCheck.count} times. Do not terminate this website action while the site is usable; switch tools and continue.`,
          ),
        },
        continueLoop: true,
      }]
    }

    // On the final step, a loop before any file exists is usually the model
    // avoiding the actual deliverable. Give it one hard redirect instead of
    // ending with "task completed" and no artifact.
    if (isLastStep && state.createdFiles.size === 0 && state.stepLoopDetections >= 2) {
      state.recentToolCalls = []
      return [{
        type: 'inject_message',
        message: {
          role: 'system',
          content: 'FINAL STEP RECOVERY: Stop all research, browsing, HTTP requests, and retries. You have no written deliverable file yet. Your next tool call MUST be create_file for the initial written/code deliverable. For large manuscripts, create the file with the opening section and then use append_file for chunks. If the user requested PDF, export_pdf comes only after the source file exists. Use image_search only if the user requested an image deliverable. Use only the findings and assets already in context.',
        },
        continueLoop: true,
      }]
    }

    // Stage 3: terminate (model has had two chances to recover and didn't)
    if (state.stepLoopDetections >= 3) {
      return [{ type: 'terminate', reason: 'loop_detected' }]
    }

    // Stage 2 (last step only): terminate. There's no skip-forward escape on
    // the last step, so a second loop detection means the agent is stuck and
    // a second nudge would just waste another 3 calls.
    if (state.stepLoopDetections >= 2 && isLastStep) {
      return [{ type: 'terminate', reason: 'loop_detected_on_last_step' }]
    }

    // Stage 2: block the step (only on non-final steps)
    if (state.stepLoopDetections >= 2 && state.currentPlanItems && !isLastStep) {
      if (isResearchLikeStep(state)) {
        const depth = researchDepthStatus(state)
        if (!depth.complete) {
          state.recentToolCalls = []
          state.stepLoopDetections = 1
          return [{
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, `Loop detected: "${loopCheck.tool}" repeated ${loopCheck.count} times. ${depth.message} Stop repeating the same action; use a relevant result URL, browser_get_content on the current article, browser_find_text for a useful section, or a different search angle.`),
            },
            continueLoop: true,
          }]
        }
      }
      return blockCurrentStep(state, `loop detected ${state.stepLoopDetections}x on "${loopCheck.tool}"`, 'tool_loop_detected')
    }

    // Stage 1: nudge (no longer clears recentToolCalls — natural window aging handles it)
    return [{
      type: 'inject_message',
      message: {
        role: 'system',
        content: `CRITICAL: You are stuck in a loop — "${loopCheck.tool}" called ${loopCheck.count} times in ${LOOP_CHECK_WINDOW} actions. STOP. Use a DIFFERENT tool or approach entirely. Options: browse a URL you haven't visited, use browser_get_content or browser_find_text on the current page, or try a different search angle. Do not advance until the research-depth requirements are satisfied.`,
      },
    }]
  }

  /**
   * Detect when the agent is searching for the same concept with different words.
   * E.g., "AI safety", "artificial intelligence risks", "AI alignment" — all overlap.
   */
  private checkSemanticSearchLoop(state: AgentStateData): PolicyAction | null {
    if (state.semanticLoopNudged) return null
    const tokens = state.searchQueryTokens
    if (tokens.length < SEMANTIC_OVERLAP_THRESHOLD) return null

    const recent = tokens.slice(-SEMANTIC_LOOP_WINDOW)
    // Extract core tokens (first N significant words) from each query
    const cores = recent.map(t => t.slice(0, SEMANTIC_CORE_TOKENS).sort().join(' '))

    // Count how many queries share the same core
    const coreCounts = new Map<string, number>()
    for (const core of cores) {
      if (!core) continue
      coreCounts.set(core, (coreCounts.get(core) || 0) + 1)
    }

    // Also check token overlap between different queries
    let highOverlapCount = 0
    for (let i = 0; i < recent.length; i++) {
      for (let j = i + 1; j < recent.length; j++) {
        const overlap = recent[i].filter(t => recent[j].includes(t)).length
        const maxLen = Math.max(recent[i].length, recent[j].length, 1)
        if (overlap / maxLen >= 0.6) highOverlapCount++
      }
    }

    const hasCoreLoop = [...coreCounts.values()].some(c => c >= SEMANTIC_OVERLAP_THRESHOLD)
    const hasOverlapLoop = highOverlapCount >= SEMANTIC_OVERLAP_THRESHOLD

    if (hasCoreLoop || hasOverlapLoop) {
      state.semanticLoopNudged = true
      const concept = [...coreCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'this topic'
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `STOP: You have searched ${state.searchQueries.size} variations of "${concept}" — these are all yielding similar results. You have data from ${state.distinctSourceDomains.size} sources already. Do NOT search this topic again. Either: (1) browse a result URL you haven't visited to get deeper details, (2) move to a DIFFERENT aspect of the task, or (3) if you have enough info, the system will advance you automatically.`,
        },
      }
    }
    return null
  }

  /**
   * Detect patterns in tool failures and provide strategic diagnosis.
   */
  private checkFailureDiagnosis(state: AgentStateData): PolicyAction | null {
    if (state.failureLog.length < FAILURE_PATTERN_THRESHOLD) return null

    const diagnosis = getFailureDiagnosis(state)
    if (!diagnosis) return null

    // Only inject once per diagnosis type
    const alreadyDiagnosed = state.workLog.some(e => e.includes('DIAGNOSIS:'))
    if (alreadyDiagnosed) return null

    // Suggest alternative approaches based on failure patterns
    const alternatives = this.suggestAlternativeApproach(state)
    const fullDiagnosis = alternatives
      ? `DIAGNOSIS: ${diagnosis}\n\nALTERNATIVE APPROACHES:\n${alternatives}`
      : `DIAGNOSIS: ${diagnosis}`

    state.workLog.push(`[${state.iterations}] DIAGNOSIS: ${diagnosis}`)
    return {
      type: 'inject_message',
      message: {
        role: 'system',
        content: fullDiagnosis,
      },
    }
  }

  /**
   * Suggest alternative tool strategies when the current approach is failing.
   */
  private suggestAlternativeApproach(state: AgentStateData): string | null {
    const recent = state.failureLog.slice(-5)
    const failedTools = new Set(recent.map(f => f.tool))
    const suggestions: string[] = []

    if (failedTools.has('web_search')) {
      suggestions.push('- Search is failing: Use browser_navigate to go directly to authoritative URLs (Wikipedia, official docs, MDN, GitHub)')
    }
    if (failedTools.has('browse_page')) {
      suggestions.push('- Browse is failing: Use browser_navigate for rendered pages, browser_get_content to inspect loaded content, or read_document for PDFs/documents.')
    }
    if (failedTools.has('browser_navigate') || failedTools.has('browser_click')) {
      suggestions.push('- Browser automation failing: Use browser_screenshot to see current page state. Try browser_get_content to verify the page loaded. Use browser_click_at({index: N}) from the fresh elements list instead of selectors')
    }

    return suggestions.length > 0 ? suggestions.join('\n') : null
  }

  /**
   * On research steps, nudge the agent to evaluate if it has enough data
   * before the budget runs out.
   */
  private checkResearchCompleteness(state: AgentStateData): PolicyAction | null {
    void state
    // Completeness is now handled by the normal step-advancement path. The old
    // extra research-check injection added another paid model turn and often
    // nudged the agent into unnecessary source gathering after enough evidence.
    return null
  }

  private checkSourceDiversity(state: AgentStateData): PolicyAction | null {
    void state
    // Keep source diversity as prompt guidance only. A runtime injection here was
    // a hidden cost path: it created extra model turns and sent the model away
    // from already-sufficient evidence just to satisfy a diversity heuristic.
    return null
  }

  private checkRewriteLoop(state: AgentStateData): PolicyAction[] {
    const totalFileCreates = Array.from(state.fileCreateCounts.values()).reduce((a, b) => a + b, 0)
    const hasRewrite = Array.from(state.fileCreateCounts.values()).some(c => c >= 2)

    if (!hasRewrite && totalFileCreates < 4) return []

    // File blocked on 2nd+ attempt — warn first, only terminate on 3rd+
    if (hasRewrite) {
      const maxCount = Math.max(...Array.from(state.fileCreateCounts.values()))
      if (maxCount >= 3) {
        // 3+ attempts on same file — actually stuck, terminate
        return [
          {
            type: 'inject_message',
            message: {
              role: 'system',
              content: 'CRITICAL: You have already created all necessary files. STOP creating or rewriting files immediately. Write a natural final response and mention attached files in one short sentence if useful. Do NOT force **Summary** or **Deliverables** headings. Then STOP.',
            },
          },
          { type: 'terminate', reason: 'rewrite_loop' },
        ]
      }
      // 2nd attempt — warn but let agent try a different approach
      return [
        {
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'WARNING: A file you tried to create already exists. Use append_file to continue writing it, edit_file for targeted replacements, or create a DIFFERENT file. Do NOT retry the same create_file call.',
          },
        },
      ]
    }

    if (!state.currentPlanItems || (state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length)) {
      return [
        {
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'CRITICAL: You have already created all necessary files. STOP creating or rewriting files immediately. Write a natural final response and mention attached files in one short sentence if useful. Do NOT force **Summary** or **Deliverables** headings. Then STOP. Any further file operations will be blocked.',
          },
        },
        { type: 'terminate', reason: 'post_completion_rewrite' },
      ]
    }

    // Mid-plan rewrite loop: block; rewrites do not satisfy the current step.
    if (state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
      state.fileCreateCounts.clear()
      return blockCurrentStep(state, 'file rewrite loop prevented verified step completion', 'rewrite_loop')
    }

    return []
  }

  /**
   * Detect when the model creates files on a research step (drifting into deliverable work early).
   */
  private checkStepDrift(state: AgentStateData, toolCalls: Map<number, ToolCallData>): PolicyAction | null {
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return null
    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    if (isLastStep) return null

    if (isBrowserActionTask(state)) {
      const hasFileWrite = Array.from(toolCalls.values()).some(tc => ['create_file', 'append_file', 'edit_file'].includes(tc.name))
      if (hasFileWrite) {
        return {
          type: 'inject_message',
          message: {
            role: 'system',
            content: browserActionRecoveryGuidance(state, 'Premature report blocked: do not write files or reports before the website action step is actually complete or hard-blocked.'),
          },
        }
      }
    }

    // Check if the current step is a build/code step where file writes are expected
    if (isConcreteBuildStep(state)) return null

    // Check if any tool call is create_file for non-.md files (premature deliverable creation)
    // .md files are fine — they're research notes
    const hasNonMdCreate = Array.from(toolCalls.values()).some(tc => {
      if (tc.name !== 'create_file') return false
      try { return !JSON.parse(tc.arguments).path?.endsWith('.md') } catch { return true }
    })
    if (!hasNonMdCreate) return null

    return {
      type: 'inject_message',
      message: {
        role: 'system',
        content: `You called create_file during a RESEARCH step. Do NOT create deliverable files yet — that belongs to the final step. Save research notes to .md files instead. When done researching, the system will advance you automatically.`,
      },
    }
  }

  private checkStepAdvancement(
    state: AgentStateData,
    stepAdvancedThisIteration: boolean,
    iterationLimit: number,
    assistantContent = '',
  ): PolicyAction[] {
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return []

    const actions: PolicyAction[] = []
    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1

    if (!stepAdvancedThisIteration && isBrowserActionTask(state) && state.browserTaskCompleted && !isLastStep) {
      if (shouldRequestPhaseEndNarration(state, assistantContent)) {
        return [phaseEndNarrationAction(state)]
      }
      const finding = browserCompletionFinding(state)
      advanceStep(state, finding)
      actions.push({ type: 'step_advance' })
      if (state.currentStepIdx >= state.currentPlanItems.length) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'ALL PLAN STEPS ARE COMPLETE. The browser task shows completion evidence. Write a concise natural final response with the actual final state. Do NOT force **Summary** headings. Do not keep clicking.',
          },
        })
      } else {
        const nowLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
        const hint = nowLastStep
          ? 'This is the action report step. Use the completion evidence already gathered; verify only if the requested final answer needs it.'
          : browserActionRecoveryGuidance(state, 'Continue from the current browser state. The previous step was advanced because the live page showed completion evidence.')
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, hint),
          },
          continueLoop: true,
        })
      }
      return actions
    }

    if (stepAdvancedThisIteration) {
      const isCurrentLastStep = state.currentStepIdx === state.currentPlanItems.length - 1

      // Block premature advancement: if the model outputs <next_step/> but hasn't done enough work,
      // reject the advance and tell it to keep working.
      // Require minimum REAL research calls (search/browse) — note files don't count.
      const minIters = 6
      if (isBrowserActionTask(state) && !isCurrentLastStep && state.stepToolCallCount === 0) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, browserActionRecoveryGuidance(state, 'You tried to advance without taking a browser action on this step. Do the website action first.')),
          },
        })
        return actions
      }
      if (isBrowserActionTask(state) && !isCurrentLastStep && state.consecutiveNoProgressClicks > 0 && !state.browserTaskCompleted) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, browserActionRecoveryGuidance(state, 'You tried to advance immediately after a no-progress browser action. First recover on the live page or verify the target is already selected/completed.')),
          },
        })
        return actions
      }
      if (isBrowserActionTask(state) && !isCurrentLastStep) {
        if (!state.browserTaskCompleted) {
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, browserActionRecoveryGuidance(
                state,
                'You tried to advance this browser action step, but the live browser state does not prove the step is complete. Do not emit <next_step/> for browser work until the current page shows exact completion evidence for this step.',
              )),
            },
            continueLoop: true,
          })
          return actions
        }

        if (shouldRequestPhaseEndNarration(state, assistantContent)) {
          return [phaseEndNarrationAction(state)]
        }
        const finding = browserCompletionFinding(state)
        advanceStep(state, finding)

        if (state.currentStepIdx >= state.currentPlanItems.length) {
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: 'ALL PLAN STEPS ARE COMPLETE. If the requested website action actually succeeded or hit a concrete hard blocker, write a concise natural final response with the actual final state. Do NOT force **Summary** headings. Do not invent success or failure.',
            },
          })
        } else {
          const isLast = state.currentStepIdx === state.currentPlanItems.length - 1
          const hint = isLast
            ? 'This is the action report step. First verify the current browser state if needed. Only report failure when there is a concrete hard blocker; otherwise keep completing the website flow.'
            : browserActionRecoveryGuidance(state, 'Continue the website flow from the current page. Do not restart or redo completed selections.')
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, hint),
            },
          })
        }
        return actions
      }
      const depth = researchDepthStatus(state)
      if (!isCurrentLastStep && isResearchLikeStep(state) && !depth.complete) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, `${depth.message} Do not emit <next_step/> yet.`),
          },
        })
        return actions
      }
      if (!isCurrentLastStep && depth.complete && shouldRequireResearchNotes(state) && !hasCurrentStepResearchNotes(state)) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, `${researchNotesGuidance(state)} Do not emit <next_step/> until the notes are saved.`),
          },
        })
        return actions
      }
      if (!isCurrentLastStep && !isResearchLikeStep(state)) {
        const isBuildLikeStep = state.currentPhase === 'build' ||
          state.taskStrategy === 'build' ||
          state.taskStrategy === 'code' ||
          state.taskStrategy === 'creative'
        if (isBuildLikeStep && state.stepToolCallCount === 0) {
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, 'You tried to advance a build/writing step without making saved-file progress. Use create_file, append_file, edit_file, read_file, or export_pdf as appropriate before advancing.'),
            },
          })
          return actions
        }
      }
      if (!isCurrentLastStep && !isResearchLikeStep(state) && state.currentPhase !== 'build' && state.taskStrategy !== 'build' && state.taskStrategy !== 'code' && state.taskStrategy !== 'creative' && state.stepToolCallCount === 0 && state.stepIterationCount < minIters) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state,
              'This step has not used a concrete tool yet. Use the smallest relevant tool action now, or finish directly only if this step truly needs no tool.'
            ),
          },
        })
        return actions
      }


      if (!isCurrentLastStep && shouldRequestPhaseEndNarration(state, assistantContent)) {
        return [phaseEndNarrationAction(state)]
      }
      advanceStep(state)
      actions.push({ type: 'step_advance' })

      if (state.currentStepIdx >= state.currentPlanItems.length) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'ALL PLAN STEPS ARE COMPLETE. You are DONE. Write a natural final response, then STOP. Use plain paragraphs or bullets only when they genuinely help the user. Do not force **Summary** or **Deliverables** headings. If files/artifacts exist, mention they are attached below in one short sentence. Include concrete results, caveats, or next steps only when useful. Do NOT create any more files, do NOT rewrite existing files, do NOT do any more research.',
          },
        })
      } else {
        const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
        const nextDepth = researchDepthStatus(state)
        const stepHint = isLastStep
          ? finalStepStartGuidance(state)
          : isResearchLikeStep(state)
            ? phaseStartGuidance(state)
            : isWebsiteLikeTask(state)
              ? phaseStartGuidance(state)
              : 'Use the next concrete action for this step. Keep it scoped, avoid repeat work, and advance once the objective is satisfied.'
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, stepHint),
          },
        })
      }
      // Already advanced this iteration — skip budget enforcement to prevent double-advance
      return actions
    }

    const effectiveBudget = isLastStep && state.deliverableStepBudget > 0
      ? state.deliverableStepBudget
      : state.perStepBudget

    if (!isLastStep && isResearchLikeStep(state)) {
      const depth = researchDepthStatus(state)
      const notesSatisfied = !shouldRequireResearchNotes(state) || hasCurrentStepResearchNotes(state)
      if (depth.complete && notesSatisfied && state.stepResearchCallCount >= depth.requiredCalls) {
        if (shouldRequestPhaseEndNarration(state, assistantContent)) {
          return [phaseEndNarrationAction(state)]
        }
        const finding = researchEvidenceFinding(state, 'Research phase complete')
        advanceStep(state, finding)
        actions.push({ type: 'step_advance' })
        if (state.currentStepIdx < state.currentPlanItems.length) {
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, phaseStartGuidance(state)),
            },
            continueLoop: true,
          })
        }
        return actions
      }
    }

    // Force-advance or nudge if stuck (not on last step)
    // With budget borrowing: allow exceeding step budget by borrowing from next step
    if (!isLastStep) {
      const canBorrow = state.perStepBudget > 0
        && state.stepIterationCount >= state.perStepBudget
        && state.currentStepIdx + 1 < state.currentPlanItems.length
      const maxBorrowable = Math.floor(state.perStepBudget * STEP_BUDGET_BORROW_FRACTION)
      const alreadyBorrowed = state.borrowedIterations
      const borrowAvailable = canBorrow && alreadyBorrowed < maxBorrowable && !isResearchLikeStep(state)

      if (state.perStepBudget > 0 && state.stepIterationCount >= state.perStepBudget && !borrowAvailable) {
        if (isBrowserActionTask(state)) {
          state.borrowedIterations = 0
          state.perStepBudget = Math.max(state.perStepBudget + MIN_STEP_BUDGET, state.stepIterationCount + MIN_STEP_BUDGET)
          actions.push({
            type: 'inject_message',
            message: {
              role: 'system',
              content: stepMsg(state, browserActionRecoveryGuidance(state, `Browser action budget extended to ${state.perStepBudget} iterations. Do not give up while the site remains actionable.`)),
            },
          })
          return actions
        }
        if (isResearchLikeStep(state)) {
          const depth = researchDepthStatus(state)
          if (!depth.complete && isSubstantiveResearchState(state)) {
            state.perStepBudget = Math.max(state.perStepBudget + 2, state.stepIterationCount + 2)
            actions.push({
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, `${depth.message} This is a broad/current research phase, so do not move on with a shallow packet. Open and extract more distinct source domains before advancing.`),
              },
              continueLoop: true,
            })
            return actions
          }
          if (!depth.complete && state.stepFailureCount < REPLAN_AFTER_FAILURES) {
            if (hasMinimumResearchEvidence(state)) {
              if (shouldRequestPhaseEndNarration(state, assistantContent)) {
                return [phaseEndNarrationAction(state)]
              }
              state.borrowedIterations = 0
              advanceStep(state, `Moved on at research budget with ${state.stepResearchCallCount} research actions and recorded gaps`)
              actions.push({ type: 'step_advance' })
              if (state.currentStepIdx < state.currentPlanItems.length) {
                actions.push({
                  type: 'inject_message',
                  message: {
                    role: 'system',
                    content: stepMsg(state, phaseStartGuidance(state)),
                  },
                  continueLoop: true,
                })
              }
              return actions
            }
            state.perStepBudget = Math.max(state.perStepBudget + 2, state.stepIterationCount + 2)
            actions.push({
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, `${depth.message} Make one targeted research tool call now; if it still does not produce evidence, move on with the known gap.`),
              },
              continueLoop: true,
            })
            return actions
          }
        }
        state.borrowedIterations = 0
        if (state.stepToolCallCount > 0) {
          if (shouldRequestPhaseEndNarration(state, assistantContent)) {
            return [phaseEndNarrationAction(state)]
          }
          advanceStep(state, `Moved on after step budget was reached with ${state.stepToolCallCount} tool actions`)
          actions.push({ type: 'step_advance' })
          if (state.currentStepIdx < state.currentPlanItems.length) {
            actions.push({
              type: 'inject_message',
              message: {
                role: 'system',
                content: stepMsg(state, phaseStartGuidance(state)),
              },
              continueLoop: true,
            })
          }
          return actions
        }
        state.perStepBudget = Math.max(state.perStepBudget + MIN_STEP_BUDGET, state.stepIterationCount + MIN_STEP_BUDGET)
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, `Step budget extended to ${state.perStepBudget} because no concrete tool progress was recorded yet. Make one concrete tool call now.`),
          },
          continueLoop: true,
        })
        return actions
      } else if (borrowAvailable) {
        // Borrowing from next step — allow extra iterations but warn
        state.borrowedIterations++
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: `Budget extended: borrowing iteration ${alreadyBorrowed + 1}/${maxBorrowable} from the next step. Finish this step quickly.`,
          },
        })
      } else if (state.stepIterationCount >= RESEARCH_NUDGE_ITERATION) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, `You have used ${state.stepIterationCount} iterations on this step. If your research is thorough and you have solid findings, continue working — the system will advance you when ready. If key gaps remain, continue working.`),
          },
        })
      }
    }

    // On the last step, enforce budget with escalating urgency
    if (isLastStep && effectiveBudget > 0) {
      const fractionUsed = state.stepIterationCount / effectiveBudget

      if (isBrowserActionTask(state) && state.createdFiles.size === 0 && state.stepIterationCount >= effectiveBudget) {
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: stepMsg(state, 'Action-task final step: if the website action is complete or blocked by a concrete hard blocker, create the short action report now. If it is still actionable, continue with browser tools. Do not end with an unsupported failure report.'),
          },
        })
        return actions
      }

      if (state.stepIterationCount >= effectiveBudget * LAST_STEP_TERMINATE_MULTIPLIER) {
        // Hard terminate at 2x budget
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'ALL PLAN STEPS ARE COMPLETE. You are DONE. Write a natural final response and mention attached files/artifacts in one short sentence if useful. Do NOT force **Summary** or **Deliverables** headings. Then STOP. Do NOT create any more files or rewrite existing ones.',
          },
        })
        state.currentStepIdx = state.currentPlanItems.length
      } else if (state.stepIterationCount >= Math.floor(effectiveBudget * LAST_STEP_HARD_NUDGE_MULTIPLIER)) {
        // Hard "FINISH NOW" at 1.5x budget
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'You have significantly exceeded your budget for this step. Finalize your deliverable file and stop. Do not start any new work.',
          },
        })
      } else if (fractionUsed >= URGENCY_FINAL_FRACTION) {
        // Urgent at 90%
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: `You have used ${Math.round(fractionUsed * 100)}% of your iteration budget for this step. Begin finalizing your deliverable. If you have a file in progress, complete it. Avoid starting new research at this point.`,
          },
        })
      } else if (fractionUsed >= URGENCY_FIRM_FRACTION) {
        // Firm at 80%
        actions.push({
          type: 'inject_message',
          message: {
            role: 'system',
            content: `WARNING: You have used ${Math.round(fractionUsed * 100)}% of your iteration budget. Start wrapping up your deliverable. Focus only on finishing, not on perfecting or adding more content.`,
          },
        })
      }
    }

    return actions
  }

  private checkIterationLimit(state: AgentStateData, iterationLimit: number): PolicyAction | null {
    if (state.iterations >= iterationLimit - 10) {
      if (isBrowserActionTask(state)) {
        return {
          type: 'inject_message',
          message: {
            role: 'system',
            content: browserActionRecoveryGuidance(state, `You have used ${state.iterations} of ${iterationLimit} allowed iterations. Prioritize completing the website action from the current page; do not spend remaining iterations on unsupported failure prose.`),
          },
        }
      }
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `WARNING: You have used ${state.iterations} of ${iterationLimit} allowed iterations. You are approaching the limit. Prioritize completing your deliverable using create_file for the initial file and append_file for remaining chunks. If the user requested PDF and the source is complete, call export_pdf. Focus on quality over additional research.`,
        },
      }
    }
    return null
  }

  /**
   * Warn when circuit-broken tools are being called.
   */
  private checkCircuitBreakers(state: AgentStateData, toolCalls: Map<number, ToolCallData>): PolicyAction | null {
    const disabledTools: string[] = []
    for (const tc of toolCalls.values()) {
      if (isToolDisabled(state, tc.name)) {
        disabledTools.push(tc.name)
      }
    }
    if (disabledTools.length > 0) {
      const TOOL_ALTERNATIVES: Record<string, string[]> = {
        web_search: ['browser_navigate', 'read_document'],
        browser_navigate: ['web_search', 'read_document'],
        http_request: ['browser_navigate', 'read_document', 'web_search'],
      }
      const alternatives = disabledTools.map(t => {
        const alts = TOOL_ALTERNATIVES[t]
        return alts?.length ? `${t} → try ${alts.join(' or ')}` : t
      }).join('; ')

      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `WARNING: Disabled tools due to repeated failures: ${alternatives}. Adapt your approach. They will be re-enabled automatically after a cooldown period.`,
        },
      }
    }
    return null
  }

  /**
   * Detect when the agent is making slow progress on a step and provide guidance.
   */
  private checkSlowProgress(state: AgentStateData): PolicyAction | null {
    if (!state.currentPlanItems) return null
    if (state.currentStepIdx >= state.currentPlanItems.length) return null

    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    if (isLastStep) return null  // Last step has its own budget enforcement

    if (state.stepIterationCount === SLOW_STEP_THRESHOLD) {
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `PROGRESS NOTE: You have spent ${state.stepIterationCount} iterations on this step ("${state.currentPlanItems[state.currentStepIdx]}"). If you are making genuine progress and gathering valuable information, continue. If you are stuck or going in circles, try a different approach or continue working — the system will advance you when ready.`,
        },
      }
    }

    // Trigger replan suggestion when too many failures on a single step
    if (state.stepFailureCount >= REPLAN_AFTER_FAILURES && state.replanCount < REPLAN_MAX_TIMES) {
      state.stepFailureCount = 0  // Reset so we don't trigger again immediately
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `STRATEGY SHIFT: This step has encountered ${REPLAN_AFTER_FAILURES}+ failures. Your current approach is not working. Consider: (1) Skip this step if the data isn't critical, (2) Try a completely different tool or source, (3) Proceed with partial information.`,
        },
      }
    }

    return null
  }

  private checkNoPlanRunaway(state: AgentStateData): PolicyAction | null {
    if (!state.currentPlanItems) {
      state.iterationsWithoutPlan++
      if (state.iterationsWithoutPlan >= NO_PLAN_RUNAWAY_LIMIT) {
        return { type: 'terminate', reason: 'no_plan_runaway' }
      }
    }
    return null
  }

  /**
   * Completion quality gate: prevent termination when deliverables are missing or broken.
   */
  private checkDeliverableQuality(state: AgentStateData): PolicyAction | null {
    // Only check on deliverable step
    if (!state.currentPlanItems) return null
    const isDeliverableStep = state.currentStepIdx === state.currentPlanItems.length - 1
    if (!isDeliverableStep) return null

    if (state.partialFileWriteRecoveryPending && !state.partialFileWriteRecoveryNudged) {
      state.partialFileWriteRecoveryNudged = true
      const p = state.partialFileWriteRecoveryPending
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `PARTIAL FILE WRITE RECOVERED: ${p.path} was saved from an interrupted streamed ${p.toolName} call (${p.lines} lines, ${p.chars} chars). Do NOT recreate or overwrite this file. Continue from the saved file with append_file for the next chunk, or use edit_file only for a targeted correction. The user should never see the file restart from the top.`,
        },
      }
    }

    const websiteQa = websiteQaStatus(state)
    if (websiteQa) {
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: websiteQa,
        },
      }
    }

    if (finalDeliverableRequired(state) && state.stepToolCallCount >= 1 && !hasFinalDeliverableCandidate(state)) {
      const supportFiles = state.workLedger.deliverableCandidates
        .filter(item => item.purpose !== 'deliverable')
        .map(item => item.path)
        .slice(-4)
      const supportContext = supportFiles.length > 0
        ? ` Support files already saved (${supportFiles.join(', ')}) do not count as the final deliverable.`
        : ''
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `FINAL DELIVERABLE REQUIRED: You are on the final deliverable phase but have not saved a user-facing deliverable artifact yet.${supportContext} Use create_file for the initial final output, append_file for continuation chunks, edit_file for targeted repairs, and export_pdf only after the completed source exists. Do not finish with only research notes, screenshots, logs, or support assets.`,
        },
      }
    }

    // Phase 10 Fix JJJ: anti-hallucination guard for ACTION tasks. Legacy
    // conversations may still contain unresolved prior-step markers; the model
    // must acknowledge them instead of pretending the actions succeeded.
    //
    // Per-task flag (not per-step) - once warned, the model has the signal
    // and a second injection wastes tokens. Reset only by createInitialState().
    if (state.taskStrategy === 'browse' && !state.actionFailureNudged && state.stepToolCallCount >= 1) {
      const incompleteEntries = Array.from(state.stepFindings.entries())
        .filter(([, f]) => f.startsWith('[INCOMPLETE]') || f.startsWith('[BLOCKED]'))
      if (incompleteEntries.length > 0) {
        state.actionFailureNudged = true
        const incompleteLabel = incompleteEntries.map(([idx]) => `Step ${idx + 1}`).join(', ')
        console.log(`[Policy] ACTION-TASK HALLUCINATION GUARD — ${incompleteEntries.length} incomplete prior step(s): ${incompleteLabel}`)
        return {
          type: 'inject_message',
          message: {
            role: 'system',
            content: `CRITICAL: You are on the deliverable step of an ACTION task, but ${incompleteLabel} did not complete. Do NOT turn that marker into an automatic failure report.

First verify the live browser state. If the page is still actionable, continue the website flow with browser_screenshot, browser_find_text, browser_scroll, browser_fill_form, browser_select, browser_press_key, or a click on a different visible element. Only write the action report after the requested action succeeds or after you can name a concrete hard blocker such as login, payment, CAPTCHA, unavailable inventory, access denied, or a hard site error.

When you do write the report, be short and factual. Never pretend success, but also never claim failure just because an earlier step has an unresolved marker.`,
          },
        }
      }
    }

    // Check if we're about to complete but have no files
    if (state.buildTask && state.createdFiles.size === 0 && state.stepToolCallCount >= 2) {
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: 'QUALITY CHECK: You are on the deliverable step but haven\'t created any files yet. Use create_file to save the first complete section of your deliverable, then append_file for additional chunks if needed. If the user requested PDF, export the completed source with export_pdf. The user expects a tangible result.',
        },
      }
    }

    // Check if last code execution had errors
    if (state.lastCodeExitCode !== null && state.lastCodeExitCode !== 0 && state.consecutiveCodeErrors > 0 && state.consecutiveCodeErrors <= 3) {
      return {
        type: 'inject_message',
        message: {
          role: 'system',
          content: `QUALITY CHECK: Your code has errors (exit code ${state.lastCodeExitCode}). Fix the errors using edit_file, then re-run the code. Do not mark the task as complete until the code runs successfully.`,
        },
      }
    }

    // Check if deliverable is being created with minimal research backing
    if (!state.deliverableQualityNudged && state.stepToolCallCount >= 1 && state.createdFiles.size >= 1) {
      const totalResearchActions = state.searchQueries.size + state.visitedUrls.size
      if (totalResearchActions < 3 && state.currentPlanItems.length > 1) {
        state.deliverableQualityNudged = true
        return {
          type: 'inject_message',
          message: {
            role: 'system',
            content: 'QUALITY CHECK: You are creating a deliverable but have very little research backing it. Before finalizing, verify your output is comprehensive and well-supported. If key claims lack evidence, do additional research now.',
          },
        }
      }
    }

    return null
  }
}
