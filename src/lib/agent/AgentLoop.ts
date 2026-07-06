/**
 * AgentLoop — the main orchestrator for the AI agent.
 *
 * Simple while-loop architecture:
 *   PLANNING → STREAMING → EXECUTING_TOOLS → EVALUATING → STREAMING → ... → COMPLETE
 */

import {
  ASSISTANT_SUPPORTS_IMAGE_INPUT,
  ASSISTANT_PROVIDER,
  createStreamingCompletion,
  type ChatCompletionTool,
  type ChatMessageParam,
  type StreamingChatCompletionChunk,
} from '@/lib/llm'
import { estimateUsageCost } from '@/lib/modelPricing'
import { toolDefinitions } from '@/lib/tools'
import { getSystemPrompt, estimateTaskComplexity, type StrategyHints } from '@/lib/prompts'
import { effectiveTaskRequest, isContextualTaskUpdate } from '@/lib/conversationContext'
import { createFileInSandbox, readFileInSandbox } from '@/lib/sandbox'
import { subscribeToBrowserFrames } from '@/lib/browser'

import type { AgentEventEmitter } from './SSEEmitter'
import {
  AgentStateData,
  createInitialState,
  updatePhase,
  advanceStep,
  trackFileCreate,
  logWork,
  recordWorkLedgerDeliverable,
  currentStepText,
  isResearchStepText,
  markPhaseNarrationEmitted,
  needsPhaseNarrationBeforeAdvance,
  stepOpenedSourceDomains,
} from './AgentState'
import {
  MIN_ITERATION_DELAY_MS, MAX_TIMEOUT_NUDGES,
  STREAM_MAX_RETRIES, STREAM_RETRY_BASE_MS, STREAM_RETRY_EXPONENT,
  STREAM_REQUEST_TIMEOUT_MS, STREAM_RETRY_MAX_DELAY_MS,
  MAX_ATTACHMENT_CHARS, MAX_CONTEXT_ATTACHMENT_CHARS, URGENCY_FINAL_FRACTION,
  TOOL_CACHE_MAX_ENTRIES, TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_SIZE_CHARS,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  MAX_ITERATIONS,
  AGENT_RUN_MAX_DURATION_MS, AGENT_DEADLINE_FINALIZATION_BUFFER_MS,
  AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS, AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
  NARRATION_THRESHOLD_DEFAULT,
} from './config'
import { StreamProcessor, type StreamResult, type StreamUsage, type ToolCallData } from './StreamProcessor'
import { ToolPipeline, type ToolExecutionResult } from './ToolPipeline'
import { PolicyEngine } from './PolicyEngine'
import { PlanManager, type RequiredPlanStep } from './PlanManager'
import { isPromptInjection, type TierTimeouts } from './guards'
import { explicitWebSearchLimitFromText, isFixedWebSearchInlineAnswerState, taskDefaultsToMarkdownDeliverable } from './taskConstraints'

import { resolveStrategy, computeIterationLimit, computeTimeouts, type TaskStrategyConfig } from './TaskStrategy'
import { ContextManager } from './ContextManager'
import { ToolRegistry } from './ToolRegistry'
import { isNudgeableTimeout, TimeoutError } from './errors'

import { createAgentLogger } from './Logger'
import { ToolCache } from './ToolCache'
import { ToolRetry } from './ToolRetry'
import { ErrorRecoveryEngine } from './recovery/ErrorRecoveryEngine'
import { WorkingMemory } from './WorkingMemory'
import { ReflectionEngine } from './ReflectionEngine'
import { GoalTracker } from './GoalTracker'
import { OutputVerifier } from './OutputVerifier'
import { auditAgentCompletion } from './CompletionAudit'
import { shouldDefaultFrontendToNextTsx } from './frontendDefaults'
import { isWebsiteEntryPath } from '@/lib/localWebsiteServer'
import { getNextWebsiteProjectStatus } from '@/lib/tsxWebsitePreview'
import { OUT_OF_CREDITS_MESSAGE, type CreditTokenUsage } from '@/lib/creditPolicy'
import { assertServerCreditsAvailable, chargeServerTokenUsage, isOutOfCreditsError } from '@/lib/serverCredits'
import { drainLiveDirectives, type LiveDirective } from '@/lib/liveDirectives'
import { MAX_DELIVERABLE_REVISIONS } from './config'
import type { StepAdvanceStatus } from '@/types'
import {
  hydrateResearchActivityIndex,
  loadResearchActivityEntries,
  researchActivityContext,
} from './ResearchActivityLog'
import { userErrorMessage } from '@/lib/errorMessages'
import { cleanTaskSubjectText, humanTopicLabel } from './taskText'
import { researchDepthProfileForState } from './ResearchDepth'
import { toolTypeRateLimitForState } from './ToolLimits'
import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import { AGENT_IDENTITY_DISCLOSURE_RESPONSE, isAgentIdentityDisclosureQuestion, latestUserAskedAgentIdentityDisclosure } from '@/lib/agentIdentity'

/**
 * Phase 12 Fix NNN: scan the user's most recent message for a URL or bare
 * domain. Returns the first match (full URL preferred over bare domain), or
 * null if none. Used by AgentLoop to populate state.userProvidedUrl, which
 * ToolPipeline reads to reroute premature web_search calls into direct navigation.
 *
 * Bare-domain regex requires `[a-z]{2,}` TLD AND a leading domain part so
 * filenames (`report.pdf`) and version strings (`1.2.3`) don't false-positive.
 */
function stripUrlTrailingPunctuation(value: string): string {
  return value.replace(/[.,!?;:)\]}>'"]+$/g, '')
}

function normalizeUserProvidedUrl(value: string): string | null {
  const cleaned = stripUrlTrailingPunctuation(value.trim())
  if (!cleaned) return null
  if (/^https?:\/\//i.test(cleaned)) return cleaned
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) return `http://${cleaned}`
  if (/^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) return `http://${cleaned}`
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) {
    return `https://${cleaned}`
  }
  return null
}

function extractUserProvidedUrl(messages: Array<{ role: string; content: string }>): string | null {
  const content = effectiveTaskRequest(messages)
  if (!content) return null
  // Full URL match (preferred)
  const fullUrl = content.match(/https?:\/\/[^\s<>()\]]+/i)
  if (fullUrl) return normalizeUserProvidedUrl(fullUrl[0])
  // Bare domain match
  const bareDomain = content.match(/(?<!@)\b(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?)(?:\/[^\s<>()\]]*)?/i)
  if (bareDomain) return normalizeUserProvidedUrl(bareDomain[0])
  return null
}

function toolArgumentsForProviderHistory(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed)
    }
    return JSON.stringify({ value: parsed ?? null })
  } catch {
    return JSON.stringify({
      invalidArguments: true,
      rawPreview: argumentsText.slice(0, 1000),
    })
  }
}

function executedToolCallsForProviderHistory(
  requestedToolCalls: Map<number, ToolCallData>,
  toolResults: ToolExecutionResult[],
): ToolCallData[] {
  const requestedIds = new Set(Array.from(requestedToolCalls.values()).map(tc => tc.id))
  return toolResults
    .map(result => result.tc)
    .filter(tc => requestedIds.has(tc.id))
    .map(tc => ({
      ...tc,
      arguments: toolArgumentsForProviderHistory(tc.arguments),
    }))
}

function assistantHistoryMessageForStreamResult(
  result: StreamResult,
  contentOverride?: string,
): ChatMessageParam {
  const content = contentOverride ?? result.assistantContent
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: content || null,
  }
  if (ASSISTANT_PROVIDER === 'deepseek' && result.reasoningContent) {
    message.reasoning_content = result.reasoningContent
  }
  return message as ChatMessageParam
}

function approximateStreamUsageForCompletedTurn(
  model: string,
  requestMessages: ChatMessageParam[],
  result: StreamResult,
): StreamUsage {
  const promptChars = requestMessages.reduce((sum, message) => {
    if (typeof message.content === 'string') return sum + message.content.length
    if (Array.isArray(message.content)) {
      return sum + message.content.reduce((inner, part) => inner + (part.text?.length || 0), 0)
    }
    return sum
  }, 0)
  const toolArgChars = [...result.toolCalls.values()].reduce((sum, toolCall) => {
    return sum + toolCall.name.length + toolCall.arguments.length
  }, 0)
  const completionChars =
    result.assistantContent.length +
    result.reasoningContent.length +
    toolArgChars
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4))
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4))
  const totalTokens = promptTokens + completionTokens
  const cost = estimateUsageCost({
    model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  }) ?? 0
  return { promptTokens, completionTokens, totalTokens, cost }
}

const FINAL_DELIVERABLE_WRITE_TOOLS = new Set(['create_file', 'append_file', 'edit_file', 'export_pdf'])
const FAST_ACTION_REQUEST_TIMEOUT_MS = 2_000
const FAST_ACTION_ITERATION_TIMEOUT_MS = 2_800
const FAST_ACTION_INACTIVITY_TIMEOUT_MS = 600
const FAST_ACTION_CONTENT_ONLY_TIMEOUT_MS = 600
const FAST_ACTION_CONTENT_ONLY_MIN_CHARS = 160
const FAST_SOURCE_ACTION_MAX_TOKENS = 320
const SUBSTANTIVE_RESEARCH_RE = /\b(?:current\s+state|state\s+of|overview|landscape|ecosystem|real[-\s]?world\s+applications?|applications?|use\s+cases?|core\s+technolog(?:y|ies)|capabilities|trends?|impact|implications?)\b/i

function isAssistantRequestTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /Assistant request timed out after \d+ seconds/i.test(message) ||
    /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(message)
}

function supportsProviderRequiredToolChoice(): boolean {
  return true
}

function isSuccessfulFinalDeliverableWrite(result: ToolExecutionResult): boolean {
  return FINAL_DELIVERABLE_WRITE_TOOLS.has(result.tc.name) && !result.isError
}

function toolResultPath(result: ToolExecutionResult): string {
  try {
    const args = JSON.parse(result.tc.arguments) as { path?: string; output_path?: string; source_path?: string }
    if (result.tc.name === 'export_pdf') {
      return String((result.result as { path?: string } | undefined)?.path || args.output_path || '')
    }
    return String(args.path || args.output_path || args.source_path || '')
  } catch {
    return String((result.result as { path?: string } | undefined)?.path || '')
  }
}

const EXACT_EXTRACTION_SOURCE_TOOLS = new Set([
  'browser_navigate',
  'browse_page',
  'browser_get_content',
  'browser_find_text',
  'browser_scroll',
])

const EXACT_EXTRACTION_TOOLS = new Set([
  'browser_find_text',
  'browser_screenshot',
  'browser_get_content',
  'browser_scroll',
])

const EXACT_EXTRACTION_NEED_PATTERN =
  /\b(?:exact|wording|quote|verbatim|specific|precise|date|timing|pre[-\s]?order|availability|available|launch|release|announc(?:e|ed|ement)|price|pricing|deadline|starts?|begins?|ships?|on sale)\b/i

function contentTextForGuard(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function currentTaskTextForGuard(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string {
  return [
    effectiveTaskRequest(messages),
    state.currentPlanItems?.[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
  ].filter(Boolean).join(' ')
}

function exactExtractionHints(text: string): string[] {
  const hints = new Set<string>()
  const lower = text.toLowerCase()
  if (/\bpre[-\s]?order/.test(lower)) hints.add('pre-order')
  if (/\bavailable|availability|on sale|ships?\b/.test(lower)) hints.add('available')
  if (/\blaunch|release|announc/.test(lower)) hints.add('launch')
  if (/\bprice|pricing|cost\b/.test(lower)) hints.add('price')
  if (/\bdate|timing|deadline|starts?|begins?\b/.test(lower)) hints.add('date')
  const quoted = [...text.matchAll(/["'“”‘’]([^"'“”‘’]{3,80})["'“”‘’]/g)]
    .map(match => match[1]?.trim())
    .filter((value): value is string => !!value)
    .slice(0, 2)
  for (const value of quoted) hints.add(value)
  return [...hints].slice(0, 5)
}

function shouldArmExactExtractionGuard(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): { shouldArm: boolean; prompt: string | null } {
  if (state.exactExtractionGuardPending || state.exactExtractionGuardAttempts >= 2) {
    return { shouldArm: false, prompt: null }
  }
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) {
    return { shouldArm: false, prompt: null }
  }

  const taskText = currentTaskTextForGuard(state, messages)
  if (!EXACT_EXTRACTION_NEED_PATTERN.test(taskText)) {
    return { shouldArm: false, prompt: null }
  }

  const source = toolResults.find(({ tc, result, isError }) => {
    if (isError || !EXACT_EXTRACTION_SOURCE_TOOLS.has(tc.name)) return false
    const resultText = contentTextForGuard(result)
    if (!resultText || /\b(?:captcha|access denied|blocked|not found|failed|error)\b/i.test(resultText)) return false
    return true
  })
  if (!source) return { shouldArm: false, prompt: null }

  const hints = exactExtractionHints(taskText)
  const hintText = hints.length > 0
    ? ` Search targeted rendered text first with browser_find_text using one of: ${hints.map(h => `"${h}"`).join(', ')}.`
    : ' Search targeted rendered text first with browser_find_text using the key phrase/date/label from the current step.'

  return {
    shouldArm: true,
    prompt: [
      'EXACT EXTRACTION REQUIRED BEFORE NARRATION: the current task/step needs precise wording, timing, date, availability, launch, or pricing evidence from the page you just opened/read.',
      'Do not write a progress update, uncertainty paragraph, synthesis, or <next_step/> yet.',
      `${hintText} If rendered text is incomplete or no text-node match appears, use browser_screenshot to visually read the relevant area, browser_scroll to reveal it, or browser_get_content to refresh the page text.`,
      'Make exactly one native tool call now using browser_find_text, browser_screenshot, browser_get_content, or browser_scroll. After that result, answer from the verified evidence or continue the phase.',
    ].join(' '),
  }
}

function updateExactExtractionGuardAfterTools(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): void {
  const completedGuardExtraction = state.exactExtractionGuardPending &&
    toolResults.some(({ tc, isError }) => EXACT_EXTRACTION_TOOLS.has(tc.name) && !isError)

  if (completedGuardExtraction) {
    state.exactExtractionGuardPending = false
    state.exactExtractionGuardPrompt = null
    return
  }

  const nextGuard = shouldArmExactExtractionGuard(state, toolResults, messages)
  if (!nextGuard.shouldArm || !nextGuard.prompt) return

  state.exactExtractionGuardPending = true
  state.exactExtractionGuardPrompt = nextGuard.prompt
  state.exactExtractionGuardAttempts++
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
  state.visibleToolActionsSinceLastNarration = 0
}

async function deliverableContentForVerification(
  conversationId: string,
  result: ToolExecutionResult,
): Promise<{ path: string; content: string }> {
  let args: { path?: string; content?: string } = {}
  try {
    args = JSON.parse(result.tc.arguments) as { path?: string; content?: string }
  } catch {
    args = {}
  }

  const path = toolResultPath(result)
  let content = String(args.content || '')
  if (path && result.tc.name !== 'export_pdf') {
    try {
      const diskFile = await readFileInSandbox(conversationId, path)
      if (typeof diskFile.content === 'string' && !diskFile.content.startsWith('Error:')) {
        content = diskFile.content
      }
    } catch {
      // Fall back to the streamed tool argument content.
    }
  }
  return { path, content }
}

function publicAgentErrorMessage(error: unknown): string {
  if (isOutOfCreditsError(error)) return error.message || OUT_OF_CREDITS_MESSAGE
  const message = userErrorMessage(error, 'Unknown error')
  if (/assistant service|openrouter|qwen|gemini|model|provider|api key|env\.local|function\.arguments/i.test(message)) {
    if (/timed out|timeout/i.test(message)) return 'The task took too long to respond. Please try again.'
    if (/rate|429/i.test(message)) return 'The assistant is temporarily busy. Please try again shortly.'
    return 'The assistant could not complete the request. Please try again.'
  }
  return message
}

function redactAgentServiceText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/\b(?:qwen|openai|anthropic|google|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
    .replace(/\bdeepseek-v[0-9][A-Za-z0-9._:-]*/gi, '[assistant-route]')
    .replace(/deepseek/gi, 'assistant service')
    .replace(/openrouter/gi, 'assistant service')
}

function sanitizeAgentServiceError(error: unknown): Record<string, unknown> {
  const err = error as {
    name?: string
    status?: number
    body?: string
    message?: string
  }

  return {
    name: err?.name || (error instanceof Error ? error.name : 'Error'),
    status: err?.status,
    message: redactAgentServiceText(error instanceof Error ? error.message : String(error || 'Unknown error')),
    body: err?.body ? redactAgentServiceText(err.body).slice(0, 500) : undefined,
  }
}

function stepAdvanceStatusFor(state: AgentStateData, stepIdx: number): StepAdvanceStatus {
  const finding = state.stepFindings.get(stepIdx)
  return finding?.startsWith('[INCOMPLETE]') || finding?.startsWith('[BLOCKED]') ? 'incomplete' : 'done'
}

function shouldPauseForPhaseEndNarrationBeforeAutoAdvance(
  state: AgentStateData,
  assistantContent = '',
): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false

  if (assistantContent.trim() && sanitizeNarrationText(assistantContent, {
    requireSignal: false,
    maxSentences: 2,
    maxLength: 300,
  })) {
    markPhaseNarrationEmitted(state)
    return false
  }

  return needsPhaseNarrationBeforeAdvance(state) || state.visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT
}

function pauseForPhaseEndNarrationBeforeAutoAdvance(
  state: AgentStateData,
  contextManager: ContextManager,
  reason: string,
  assistantContent = '',
): boolean {
  if (!shouldPauseForPhaseEndNarrationBeforeAutoAdvance(state, assistantContent)) return false
  state.phaseEndNarrationPending = true
  state.forceTextNextIteration = true
  state.forcedNarrationRepairAttempts = 0
  contextManager.push({
    role: 'system',
    content: [
      `PHASE-END NARRATION REQUIRED before advancing: ${reason}.`,
      'Every phase must show at least one real LLM-written progress paragraph, even if the phase used fewer than 3 tools.',
      'Write one concise, result-first paragraph from completed work only, then put <next_step/> on its own final line. Do not call tools in this response.',
    ].join(' '),
  } as ChatMessageParam)
  return true
}

function liveDirectiveContextMessage(directives: LiveDirective[]): string {
  const directiveList = directives
    .map((directive, index) => {
      const receivedAt = new Date(directive.createdAt).toISOString()
      return `${index + 1}. Received ${receivedAt}: ${directive.content}`
    })
    .join('\n')

  return [
    'LIVE USER DIRECTIVE: The user sent the following instruction while this task was already running.',
    'Treat it as the newest user instruction for this same task. Apply it at the next safe action without restarting, stopping, or discarding completed work.',
    'If it changes source, browser, search, output, or plan constraints, obey it over earlier plan text and realign the current phase before using another tool.',
    'Do not execute stale tool calls that were selected before this directive if they now conflict with it.',
    '',
    directiveList,
  ].join('\n')
}

function agentRunRemainingMs(state: AgentStateData): number {
  return state.runStartedAtMs + (state.runMaxDurationMs || AGENT_RUN_MAX_DURATION_MS) - Date.now()
}

function shouldStartDeadlineFinalization(state: AgentStateData): boolean {
  if (state.deadlineFinalizationStarted) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentStepIdx < state.currentPlanItems.length - 1) return false
  return agentRunRemainingMs(state) <= (state.deadlineFinalizationBufferMs || AGENT_DEADLINE_FINALIZATION_BUFFER_MS)
}

function deadlineFinalizationMessage(state: AgentStateData): ChatMessageParam {
  const remainingSeconds = Math.max(0, Math.round(agentRunRemainingMs(state) / 1000))
  return {
    role: 'system',
    content: [
      `RUNTIME FINALIZATION DEADLINE: approximately ${remainingSeconds}s remain before the hosting platform can terminate this long task.`,
      'Stop starting new research, browsing, comparison branches, or optional verification.',
      'Use only the gathered work log, research activity, files, browser evidence, and current context to create the final user-facing result now.',
      'If a deliverable file is required and none is saved, make exactly one create_file call for the initial final output; use append_file only for essential continuation chunks.',
      'If the answer can be delivered inline, write the concise final answer now. Mention evidence gaps plainly instead of trying to fill them.',
    ].join(' '),
  } as ChatMessageParam
}

function iterationBudgetFinalizationReserve(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): number {
  const savedArtifactRequired = taskNeedsSavedFinalArtifact(state, messages)
  const deliverableBudget = state.deliverableStepBudget || 0
  const artifactReserve = savedArtifactRequired
    ? Math.max(18, Math.min(34, deliverableBudget + 6))
    : Math.max(10, Math.min(18, Math.ceil(deliverableBudget * 0.7) || 10))
  const remainingPlanSteps = state.currentPlanItems
    ? Math.max(0, state.currentPlanItems.length - state.currentStepIdx - 1)
    : 0
  return artifactReserve + Math.min(8, remainingPlanSteps * 2)
}

function iterationBudgetFinalizationTriggerTurns(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): number {
  return Math.max(8, Math.min(16, iterationBudgetFinalizationReserve(state, messages)))
}

function shouldStartIterationBudgetFinalization(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (state.deadlineFinalizationStarted) return false
  if (!state.dynamicIterationLimit) return false
  if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
  if (state.currentStepIdx >= state.currentPlanItems.length) return false

  const remainingIterations = state.dynamicIterationLimit - state.iterations
  return remainingIterations <= iterationBudgetFinalizationTriggerTurns(state, messages)
}

function iterationBudgetFinalizationMessage(state: AgentStateData, overrunStep: string): ChatMessageParam {
  return {
    role: 'system',
    content: [
      'ITERATION BUDGET FINALIZATION: stop source gathering and produce the final user-facing result now.',
      `The task spent too long on "${overrunStep}", so use the gathered evidence and clearly mention any important gaps inside the output.`,
      'Do not call web_search, read_document, browser tools, image_search, or optional verification.',
      'If a file/report is required, make exactly one create_file call for the final output under deliverables/; continue with append_file only if the write is clipped.',
      'If the answer belongs in chat, write the answer directly now.',
    ].join(' '),
  } as ChatMessageParam
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  messages: Array<{
    role: string
    content: string
    attachments?: Array<{
      id?: string
      name: string
      type: string
      size: number
      content?: string
      contentEncoding?: 'text' | 'data-url'
      url?: string
      sandboxPath?: string
      persisted?: boolean
      preview?: string
    }>
  }>
  model: string
  conversationId?: string
  customInstructions?: string
  startFreshSandbox?: boolean
  signal?: AbortSignal
  creditRunId?: string
  userId?: string
  skipStartupAcknowledgement?: boolean
  startupReadyPromise?: Promise<unknown>
  startupPlan?: {
    items: string[]
    scopes?: Array<string | null>
  }
  runMaxDurationMs?: number
  deadlineFinalizationBufferMs?: number
  deadlineModelTurnTimeoutMs?: number
  deadlineHardStopBufferMs?: number
  diagnostics?: (event: { type: string; data: Record<string, unknown> }) => void
}

// ── AgentLoop ───────────────────────────────────────────────────────────────

type Phase = 'PLANNING' | 'STREAMING' | 'EXECUTING_TOOLS' | 'EVALUATING' | 'COMPLETE' | 'ERROR'

const AUTOSAVE_DRAFT_MIN_CHARS = 1200
const FINAL_AUTOSAVE_DRAFT_MIN_CHARS = 600
const TEXT_ONLY_DRAFT_SAVE_VISIBLE_WAIT_MS = 3_500
const SKILL_ATTACHMENT_TYPE = 'application/x-agent-skill'
const MAX_PLANNING_SKILL_CHARS = 18_000
const MAX_PLANNING_ATTACHMENT_CHARS = 12_000
const MAX_PRELOADED_ATTACHMENT_PANEL_CHARS = 5_000
const FRESH_TASK_CONTEXT_MESSAGES = 1
const CONTEXTUAL_TASK_CONTEXT_MESSAGES = 6
const HISTORICAL_CONTEXT_CHARS = 1200
type AgentAttachment = NonNullable<AgentLoopOptions['messages'][number]['attachments']>[number]
type ToolDefinitionLike = { function?: { name?: string } }
type ModelToolDefinition = ToolDefinitionLike & {
  function?: {
    name?: string
    parameters?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

const BROWSER_NONFINAL_RUNTIME_TOOLS = new Set([
  'browser_navigate',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_find_text',
  'browser_screenshot',
  'browser_get_content',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_press_key',
  'browser_go_back',
  'browser_action_sequence',
  'browser_click_and_hold',
  'browser_drag',
  'web_search',
  'read_document',
])

const BROWSER_STEP_START_RUNTIME_TOOLS = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_get_content',
  'browser_find_text',
  'web_search',
  'read_document',
])

const RESEARCH_FILE_WRITE_RUNTIME_TOOLS = new Set(['create_file', 'edit_file', 'append_file'])
const RESEARCH_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search'])
const RESEARCH_COLD_BROWSER_RUNTIME_TOOLS = new Set(['browser_navigate', 'browse_page', 'browser_get_content'])
const FIXED_WEB_SEARCH_RUNTIME_TOOLS = new Set(['web_search'])
const COMPACT_RESEARCH_RECOVERY_RUNTIME_TOOLS = new Set([
  'web_search',
  'read_document',
  'http_request',
  'image_search',
  'browser_get_content',
  'browser_navigate',
])
const COMPACT_RESEARCH_SOURCE_RUNTIME_TOOLS = new Set([
  'web_search',
  'read_document',
  'browser_navigate',
  'browser_get_content',
  'browser_find_text',
  'browser_scroll',
])
const COMPACT_RESEARCH_PRIMARY_SOURCE_RUNTIME_TOOLS = new Set([
  'web_search',
  'read_document',
  'browser_navigate',
  'browser_get_content',
  'browser_find_text',
])
const BUILD_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search', 'browser_screenshot', 'browser_scroll', 'export_pdf', 'delete_file'])
const FINAL_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search', 'browser_screenshot', 'browser_scroll', 'export_pdf', 'delete_file'])
const BROWSER_ADVANCED_POINTER_TOOLS = new Set(['browser_click_and_hold', 'browser_drag', 'browser_hover'])

function cleanDraftContent(content: string): string {
  return content
    .replace(/<next_step\s*\/?>/gi, '')
    .trim()
}

function slugifyDraftName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'draft'
}

function shouldAutosaveTextOnlyDraft(
  state: AgentStateData,
  content: string,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const text = cleanDraftContent(content)
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false

  const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
  if (isLastStep) {
    return text.length >= FINAL_AUTOSAVE_DRAFT_MIN_CHARS && taskNeedsSavedFinalArtifact(state, messages)
  }

  if (text.length < AUTOSAVE_DRAFT_MIN_CHARS) return false

  return state.currentPhase === 'build' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
}

function autosaveDraftPath(state: AgentStateData): string {
  const title = state.currentPlanItems?.[state.currentStepIdx] || 'draft'
  const slug = slugifyDraftName(title)
  const isLastStep = !!state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1
  return isLastStep
    ? `deliverables/${slug}.md`
    : `drafts/step-${state.currentStepIdx + 1}-${slug}.md`
}

function shouldKeepAssistantInjection(content: string): boolean {
  const text = content.trim()
  if (!text) return false
  if (looksLikeFutureOnlyAssistantInjection(text)) return false
  if (text.length >= 240) return true
  return /```|^#{1,6}\s|^\s*[-*]\s+\S/m.test(text)
}

function looksLikeFutureOnlyAssistantInjection(content: string): boolean {
  const text = content.trim().toLowerCase()
  if (!text) return false
  const futureAction =
    /\b(?:i(?:'|’)?ll|i will|let me|now i(?:'|’)?ll|i(?:'|’)?m going to|i am going to|next,?\s+i(?:'|’)?ll|next,?\s+i will)\b.{0,180}\b(?:build|create|write|research|implement|fix|add|start|run|check|verify|open|browse|search|continue|make|get|fetch|load|read|visit|pivot)\b/i.test(text)
  const concreteOutput =
    /```|^#{1,6}\s|^\s*[-*]\s+\S|\b(?:answer|verdict|summary|finding|conclusion|recommendation):/mi.test(content)
  return futureAction && !concreteOutput
}

function containsFalseCapabilityRefusal(content: string): boolean {
  return /(?:i (?:cannot|can't|am unable to|am not able to).{0,120}(?:access|browse|interact|perform|retrieve|search|images?|photos?|pictures?)|i can only provide text[- ]based information|please use (?:a )?(?:search engine|google images|bing images))/i.test(content)
}

function compactHistoricalAgentMessage(message: AgentLoopOptions['messages'][number], isLatest: boolean): AgentLoopOptions['messages'][number] {
  if (isLatest) return message
  const content = message.content.length > HISTORICAL_CONTEXT_CHARS
    ? `${message.content.slice(0, HISTORICAL_CONTEXT_CHARS)}\n...[historical message compacted]`
    : message.content
  return {
    ...message,
    content,
    attachments: undefined,
  }
}

function scopedMessagesForAgentTask(messages: AgentLoopOptions['messages']): AgentLoopOptions['messages'] {
  const latestUserIndex = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && message.content.trim())
    .at(-1)?.index ?? messages.length - 1

  if (!isContextualTaskUpdate(messages)) {
    return messages.slice(Math.max(0, latestUserIndex)).slice(-FRESH_TASK_CONTEXT_MESSAGES)
  }

  const recent = messages.slice(Math.max(0, messages.length - CONTEXTUAL_TASK_CONTEXT_MESSAGES))
  const lastIndex = recent.length - 1
  return recent.map((message, index) => compactHistoricalAgentMessage(message, index === lastIndex))
}

function taskWantsImageArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return /\b(image|images|photo|photos|picture|pictures|asset|assets|retrieve|return|download)\b/i.test(`${currentToolIntentText(state)} ${userText}`)
}

function taskWantsPdfArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return /\b(?:pdf|export)\b/i.test(`${currentToolIntentText(state)} ${userText}`)
}

function explicitSavedFinalArtifactRequested(text: string): boolean {
  const cleaned = text
    .replace(/\b(?:do\s+not|don't|dont|never)\s+(?:save|create|write|export|make|generate|deliver|return)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable)\b/gi, ' ')
    .replace(/\b(?:no|without)\s+(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable)\b/gi, ' ')
  const declinesSavedArtifact = /\b(?:no file|no document|without\s+(?:a\s+)?(?:file|document)|don't\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|answer\s+(?:directly|in chat|here)|just\s+answer)\b/i.test(text)
  const positiveArtifactRequest = /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|pptx|xlsx)\b/i.test(cleaned) ||
    /\b(?:save|create|write|export|make|generate|deliver)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable)\b/i.test(cleaned) ||
    /\breturn\s+(?:a|an|the)?\s*(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable)\b/i.test(cleaned) ||
    /\b(?:website|web\s*app|next\.?js|page\.tsx|layout\.tsx|globals\.css)\b/i.test(cleaned) ||
    taskDefaultsToMarkdownDeliverable(text)
  return positiveArtifactRequest && !declinesSavedArtifact
}

function originalRequestPrefersInlineBrief(text: string): boolean {
  if (!text) return false
  if (explicitSavedFinalArtifactRequested(text)) return false
  return /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple|small|tiny|fast)\b/i.test(text)
}

function taskNeedsSavedFinalArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  if (originalRequestPrefersInlineBrief(userText)) return false
  const taskText = `${currentToolIntentText(state)} ${userText}`
  return state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative' ||
    explicitSavedFinalArtifactRequested(taskText)
}

function isBriefInlineDirectAnswerTask(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  const taskText = `${currentToolIntentText(state)} ${userText}`.toLowerCase()
  if (/\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|rigorous|extensive|full report|serious analysis|strategic|technical|comparative)\b/.test(taskText)) {
    return false
  }
  const brief = /\b(?:brief|briefly|quick|quickly|short|succinct|simple|one[-\s]?sentence|two[-\s]?sentence|in\s+\d+\s+sentences?)\b/.test(taskText)
  const inline = /\b(?:no file|no document|don't\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|answer\s+(?:directly|in chat|here)|just\s+answer)\b/.test(taskText)
  return (brief || inline) && !taskNeedsSavedFinalArtifact(state, messages)
}

function shouldAutoAdvanceBriefInlineResearchAfterTools(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  results: ToolExecutionResult[],
): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length - 1) return false
  if (!(state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.currentPhase === 'research')) return false
  if (!isBriefInlineDirectAnswerTask(state, messages)) return false
  if (!results.some(result => !result.isError)) return false
  const openedOrExtractedSource = state.stepVisitedUrls.size > 0 || stepOpenedSourceDomains(state).size > 0
  const usefulDiscovery = state.stepSearchQueries.size > 0 || state.stepSourceDomainCounts.size > 0
  return openedOrExtractedSource ||
    (state.stepResearchCallCount >= 2 && usefulDiscovery)
}

function isLeanFinalSynthesisStep(state: AgentStateData): boolean {
  return !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx === state.currentPlanItems.length - 1 &&
    state.currentPhase === 'deliver' &&
    (state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.taskStrategy === 'general') &&
    !state.buildTask
}

function finalInlineAnswerTurn(state: AgentStateData, messages: Array<{ role: string; content: string }>): boolean {
  return isLeanFinalSynthesisStep(state) && !taskNeedsSavedFinalArtifact(state, messages)
}

function shouldCompleteFinalInlineAnswerTurn(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  content: string,
): boolean {
  if (!finalInlineAnswerTurn(state, messages)) return false
  const text = content.trim()
  if (text.length < 80) return false
  const startsLikeStatus =
    /^(?:i(?:'|’)?ll|i will|i am going to|we(?:'|’)?ll|let me|next,?\s+i|now,?\s+i)\b/i.test(text) ||
    /\blet me\b/i.test(text.slice(0, 240)) ||
    /\b(?:i|we)\s+(?:found|checked|searched|gathered|looked|reviewed)\b.{0,180}\b(?:but|so|next|instead)\b/i.test(text.slice(0, 260)) ||
    /\b(?:will|going to)\s+(?:research|gather|compare|summari[sz]e|investigate|check|look up|write|produce)\b/i.test(text.slice(0, 220))
  if (startsLikeStatus && text.length < 240) return false
  return /[.!?)]\s*$/.test(text) || text.length >= FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS
}

function finalSavedDeliverableTurn(state: AgentStateData, messages: Array<{ role: string; content: string }>): boolean {
  return isLeanFinalSynthesisStep(state) && taskNeedsSavedFinalArtifact(state, messages)
}

function shouldUseTextSavedFinalDeliverable(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  return ASSISTANT_PROVIDER === 'openrouter' &&
    finalSavedDeliverableTurn(state, messages) &&
    !state.partialFileWriteRecoveryPending &&
    !hasSavedFinalDeliverableCandidate(state)
}

function hasSavedFinalDeliverableCandidate(state: AgentStateData): boolean {
  return state.workLedger.deliverableCandidates.some(item => item.purpose === 'deliverable')
}

function latestSavedFinalDeliverablePath(state: AgentStateData): string | null {
  return state.workLedger.deliverableCandidates
    .filter(item => item.purpose === 'deliverable' && item.path)
    .slice(-1)[0]?.path || null
}

function savedFinalDeliverableMinimumChars(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): number {
  const taskText = `${state.originalUserRequest || ''} ${currentToolIntentText(state)} ${messages.map(m => m.content).join(' ')}`.toLowerCase()
  const originalRequest = state.originalUserRequest || ''
  const requestLooksBrief = /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple)\b/i.test(originalRequest)
  const requestedSavedReport = taskDefaultsToMarkdownDeliverable(originalRequest)
  if (/\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|rigorous|extensive|full report|long report|serious analysis|technical)\b/.test(taskText)) {
    return 4_800
  }
  if (requestLooksBrief) {
    return requestedSavedReport ? 2_200 : 1_400
  }
  return 2_600
}

function shouldContinueSavedFinalDeliverableChunk(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  path: string,
  content: string,
): boolean {
  if (!finalSavedDeliverableTurn(state, messages)) return false
  if (!path || !path.toLowerCase().endsWith('.md')) return false
  if (state.deliverableRevisionCount >= MAX_DELIVERABLE_REVISIONS) return false
  return content.trim().length < savedFinalDeliverableMinimumChars(state, messages)
}

function finalSavedDeliverableToolCallInstruction(
  state: AgentStateData,
  reason: string,
): string {
  const pending = state.partialFileWriteRecoveryPending
  const existingPath = latestSavedFinalDeliverablePath(state)
  const target = pending
    ? `Use append_file to continue "${pending.path}".`
    : existingPath
      ? `Use append_file or edit_file against "${existingPath}".`
      : 'Use create_file for the final saved output under deliverables/ unless the user named a different path.'
  const chunkGuidance = !pending && !existingPath
    ? 'For the first create_file call, save a fast opening chunk only: title, short intro, and the first useful section. Do not try to finish the whole deliverable in this first call.'
    : 'Append the next useful chunk only. Do not repeat existing content.'

  return [
    reason,
    target,
    chunkGuidance,
    'Make exactly one native file tool call now with strict JSON object arguments.',
    'Put action_label, plan_step_index, and path before content so the file action starts immediately.',
    'Do not write visible prose, a status update, a plan, a source count, or a permission question.',
    'The worker will keep the same final phase active until the saved output is complete.',
  ].join(' ')
}

function finalInlineAnswerPrompt(state: AgentStateData): string {
  const request = state.originalUserRequest?.trim()
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the final answer'
  const retry = state.consecutiveNoToolCalls > 0 || state.timeoutNudgeCount > 0
    ? 'A previous final-turn response was too slow or did not answer directly enough. Begin the answer immediately in the first sentence.'
    : 'This response must be the answer itself.'
  return [
    'FINAL INLINE ANSWER NOW: The user expects the final response in chat, not a saved file.',
    retry,
    request ? `User request: ${request}.` : '',
    `Current final task: ${step}.`,
    'Start with the answer content: a clear heading or the first factual sentence. Do not spend a separate hidden planning pass before writing.',
    'Do not write a status update, plan, tool label, action label, or permission question.',
    'Use the gathered evidence; if evidence is thin, answer with a brief caveat rather than searching, planning, or narrating.',
    'If the user explicitly asked for an inline report/no-file answer, write the actual report with concrete substance and stop.',
  ].filter(Boolean).join(' ')
}

function finalSavedDeliverablePrompt(state: AgentStateData): string {
  const request = state.originalUserRequest?.trim()
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the final deliverable'
  const pendingPartial = state.partialFileWriteRecoveryPending
  if (pendingPartial) {
    return [
      `PARTIAL FILE CONTINUATION NOW: make exactly one native append_file call to "${pendingPartial.path}" immediately.`,
      request ? `User request: ${request}.` : '',
      `Current final task: ${step}.`,
      `The existing file already contains ${pendingPartial.lines} lines / ${pendingPartial.chars} characters from a recovered clipped write.`,
      'Begin the tool call immediately; do not internally outline, narrate, or wait to draft a full report before starting the append_file arguments.',
      'Do not call create_file, edit_file, read_file, list_files, export_pdf, or any research/browser tool.',
      'Do not write visible prose, a status update, a plan, a source summary, or a permission question.',
      'Append only the next missing complete section or paragraph-bounded chunk. End cleanly at a sentence or section boundary; never stop mid-sentence. Do not repeat already-written content, and do not emit <next_step/> until after a successful append clears this partial-file state.',
      'Use the full output budget for the append_file content so long reports and code files continue instead of restarting.',
    ].filter(Boolean).join(' ')
  }
  return [
    'FINAL SAVED DELIVERABLE NOW: make exactly one native file tool call immediately.',
    request ? `User request: ${request}.` : '',
    `Current final task: ${step}.`,
    'Begin the tool call immediately; do not internally outline, narrate, or wait to draft the whole deliverable before starting the file-tool arguments.',
    'Do not write a status update, plan, source summary, or permission question.',
    'Use create_file for the first saved output; use append_file only after a file exists; use edit_file only for a targeted fix.',
    'For reports, research findings, and substantial write-ups, create a .md file under deliverables/ unless the user named a different path.',
    'For create_file and append_file, put action_label, plan_step_index, and path before content so the visible file action starts immediately.',
    'For the first create_file call, write only a fast opening chunk: title, short intro, and first useful complete section. End cleanly at a sentence or section boundary. The worker will continue with append_file chunks until the saved output is complete.',
  ].filter(Boolean).join(' ')
}

function finalSavedDeliverableTextPrompt(state: AgentStateData): string {
  const request = state.originalUserRequest?.trim()
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the final deliverable'
  return [
    'FINAL SAVED DELIVERABLE TEXT NOW: write the actual final Markdown content directly.',
    request ? `User request: ${request}.` : '',
    `Current final task: ${step}.`,
    'Start with a clear Markdown title and the useful content itself.',
    'Do not write a status update, source count, plan, permission question, tool label, action label, or note about attaching/saving a file.',
    'The app will save this exact Markdown content as the deliverable after you finish writing it.',
    'Use the gathered evidence and be concise, but include enough substance for the task.',
  ].filter(Boolean).join(' ')
}

function finalInlineAnswerTaskText(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return `${state.originalUserRequest || ''} ${currentToolIntentText(state)} ${currentStepText(state)} ${userText}`.toLowerCase()
}

function finalInlineAnswerMaxTokens(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): number {
  const taskText = finalInlineAnswerTaskText(state, messages)
  const wantsReportDepth = /\b(?:report|memo|briefing|essay|article|write[-\s]?up|deep|detailed|comprehensive|analysis|evaluate|compare|assessment)\b/i.test(taskText)
  if (wantsReportDepth) return FINAL_INLINE_REPORT_MAX_TOKENS
  return FINAL_INLINE_ANSWER_MAX_TOKENS
}

function isFastActionToolTurn(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (state.forceTextNextIteration || state.exactExtractionGuardPending) return false
  if (state.deadlineFinalizationStarted) return false
  if (finalInlineAnswerTurn(state, messages) || finalSavedDeliverableTurn(state, messages)) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentPhase === 'deliver') return false

  return state.taskStrategy === 'browse' ||
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.currentPhase === 'research' ||
    state.currentPhase === 'build' ||
    state.consecutiveNoToolCalls > 0 ||
    state.browserNoToolRecoveryAttempts > 0 ||
    state.researchNoToolRecoveryAttempts > 0
}

function isFastSourceActionToolTurn(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (!isFastActionToolTurn(state, messages)) return false
  return state.taskStrategy === 'browse' ||
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    state.currentPhase === 'research'
}

function shouldUseNaturalCadenceNarration(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (state.forceTextNextIteration || state.exactExtractionGuardPending) return false
  if (state.deadlineFinalizationStarted) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.visibleToolActionsSinceLastNarration < NARRATION_THRESHOLD_DEFAULT) return false
  if (state.partialFileWriteRecoveryPending) return false
  if (finalInlineAnswerTurn(state, messages) || finalSavedDeliverableTurn(state, messages)) return false
  return true
}

function tierTimeoutsForIteration(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  compactNarration = false,
): TierTimeouts {
  if (compactNarration || state.forceTextNextIteration) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: Math.min(state.tierTimeouts.iterationTimeoutMs, FORCED_NARRATION_ITERATION_TIMEOUT_MS),
      inactivityTimeoutMs: Math.min(state.tierTimeouts.inactivityTimeoutMs, FORCED_NARRATION_INACTIVITY_TIMEOUT_MS),
      contentOnlyTimeoutMs: FORCED_NARRATION_CONTENT_ONLY_TIMEOUT_MS,
      contentOnlyMinChars: 80,
    }
  }
  if (shouldUseTextSavedFinalDeliverable(state, messages)) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: FINAL_SAVED_DELIVERABLE_TEXT_ITERATION_TIMEOUT_MS,
      inactivityTimeoutMs: FINAL_SAVED_DELIVERABLE_TEXT_INACTIVITY_TIMEOUT_MS,
      contentOnlyTimeoutMs: FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_TIMEOUT_MS,
      contentOnlyMinChars: FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_MIN_CHARS,
    }
  }
  if (finalSavedDeliverableTurn(state, messages)) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: Math.min(state.tierTimeouts.iterationTimeoutMs, FINAL_SAVED_DELIVERABLE_ITERATION_TIMEOUT_MS),
      inactivityTimeoutMs: Math.min(state.tierTimeouts.inactivityTimeoutMs, FINAL_SAVED_DELIVERABLE_INACTIVITY_TIMEOUT_MS),
      contentOnlyTimeoutMs: FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_TIMEOUT_MS,
      contentOnlyMinChars: FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_MIN_CHARS,
    }
  }
  if (isFastActionToolTurn(state, messages)) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: Math.min(state.tierTimeouts.iterationTimeoutMs, FAST_ACTION_ITERATION_TIMEOUT_MS),
      inactivityTimeoutMs: Math.min(state.tierTimeouts.inactivityTimeoutMs, FAST_ACTION_INACTIVITY_TIMEOUT_MS),
      contentOnlyTimeoutMs: state.tierTimeouts.contentOnlyTimeoutMs === null
        ? null
        : Math.min(state.tierTimeouts.contentOnlyTimeoutMs, FAST_ACTION_CONTENT_ONLY_TIMEOUT_MS),
      contentOnlyMinChars: Math.min(state.tierTimeouts.contentOnlyMinChars, FAST_ACTION_CONTENT_ONLY_MIN_CHARS),
    }
  }
  if (!finalInlineAnswerTurn(state, messages)) return state.tierTimeouts
  return {
    ...state.tierTimeouts,
    iterationTimeoutMs: Math.min(state.tierTimeouts.iterationTimeoutMs, FINAL_INLINE_ANSWER_ITERATION_TIMEOUT_MS),
    inactivityTimeoutMs: Math.min(state.tierTimeouts.inactivityTimeoutMs, FINAL_INLINE_ANSWER_INACTIVITY_TIMEOUT_MS),
    contentOnlyTimeoutMs: FINAL_INLINE_ANSWER_CONTENT_ONLY_TIMEOUT_MS,
    contentOnlyMinChars: FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS,
  }
}

function isNonFinalBrowserStep(state: AgentStateData): boolean {
  return state.taskStrategy === 'browse' &&
    !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx < state.currentPlanItems.length - 1
}

function shouldInjectResearchActivityContext(state: AgentStateData): boolean {
  if (state.forceTextNextIteration) return false
  if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
  if (state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentPhase === 'research') return true
  return isNonFinalBrowserStep(state)
}

function filterToolDefinitions(
  tools: ToolDefinitionLike[],
  allowed: Set<string>,
): ToolDefinitionLike[] {
  return tools.filter(tool => {
    const name = tool.function?.name || ''
    return allowed.has(name)
  })
}

function toolStepRateLimitReached(state: AgentStateData, toolName: string): boolean {
  const limit = toolTypeRateLimitForState(state, toolName)
  if (limit === undefined) return false
  return (state.stepToolTypeCounts.get(toolName) || 0) >= limit
}

function pruneExhaustedStepToolsForCurrentTurn(
  state: AgentStateData,
  tools: ToolDefinitionLike[],
): { tools: ToolDefinitionLike[]; exhausted: string[] } {
  const exhausted = new Set<string>()
  const filtered = tools.filter(tool => {
    const name = tool.function?.name || ''
    if (!name || !toolStepRateLimitReached(state, name)) return true
    exhausted.add(name)
    return false
  })
  return {
    tools: filtered,
    exhausted: [...exhausted],
  }
}

function compactToolDefinitionsForModel(tools: ToolDefinitionLike[]): ToolDefinitionLike[] {
  return tools.map((tool) => {
    const modelTool = tool as ModelToolDefinition
    const parameters = modelTool.function?.parameters
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return tool
    const schema = parameters as { properties?: Record<string, unknown>; [key: string]: unknown }
    if (!schema.properties?.action_label && !schema.properties?.plan_step_index) return tool

    const compactProperties = { ...schema.properties }
    for (const key of ['action_label', 'plan_step_index'] as const) {
      const prop = compactProperties[key]
      if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue
      const { description: _description, ...rest } = prop as Record<string, unknown>
      compactProperties[key] = rest
    }

    return {
      ...modelTool,
      function: {
        ...modelTool.function,
        parameters: {
          ...schema,
          properties: compactProperties,
        },
      },
    } as ToolDefinitionLike
  })
}

function researchStepAllowsSupportFileTools(state: AgentStateData): boolean {
  if (state.currentPhase !== 'research') return true
  const stepText = state.currentPlanItems?.[state.currentStepIdx] || ''
  const scopeText = state.currentPlanScopes?.[state.currentStepIdx] || ''
  const text = [
    state.originalUserRequest || '',
    stepText,
    scopeText,
    state.stepMicroPlan || '',
  ].join('\n')
  return /\b(?:research[- ]?notes?|phase[- ]?notes?|notes?\.md|markdown notes?|save (?:the )?(?:notes?|findings)|write (?:the )?(?:notes?|findings)|create (?:a )?(?:notes?|markdown|\.md)|todo\.md|checklist|tracking file|progress file)\b/i.test(text)
}

function researchStepAllowsImageSearch(state: AgentStateData): boolean {
  if (state.currentPhase !== 'research') return true
  return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|return|download|real one|use real|logo|logos|icon|icons|illustration|illustrations)\b/i.test(currentToolIntentText(state))
}

function shouldPreferExtractionBeforeColdBrowser(state: AgentStateData): boolean {
  if (state.taskStrategy === 'browse') return false
  if (state.currentPhase === 'build' || state.currentPhase === 'deliver') return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.userProvidedUrl) return false
  if (state.stepResearchCallCount > 0 || state.stepVisitedUrls.size > 0) return false

  return /\b(?:research|source|sources|cite|citation|pricing|price|latest|current|recent|fact|facts|verify|check|find|fetch|gather|read|extract|report|analysis|compare)\b/i.test(currentToolIntentText(state))
}

function shouldUseCompactResearchRecoveryTools(state: AgentStateData): boolean {
  if (!shouldUseCompactResearchTurn(state)) return false
  if (!compactResearchNeedsToolAction(state)) return false
  return state.consecutiveNoToolCalls > 0 ||
    (state.stepToolCallCount > 0 && state.stepResearchCallCount === 0)
}

function compactResearchRecoveryToolsForState(
  state: AgentStateData,
  tools: ToolDefinitionLike[],
): ToolDefinitionLike[] {
  const allowed = new Set(COMPACT_RESEARCH_RECOVERY_RUNTIME_TOOLS)
  if (!researchStepAllowsImageSearch(state)) allowed.delete('image_search')
  if (!hasRenderedBrowserContext(state)) allowed.delete('browser_get_content')
  const needsOpenedSourceRoute = compactResearchNeedsOpenedSource(state) ||
    state.suppressedResearchToolName === 'read_document'
  if (!state.userProvidedUrl && state.stepResearchCallCount > 0 && !needsOpenedSourceRoute) {
    allowed.delete('browser_navigate')
  }
  const narrowed = filterToolDefinitions(tools, allowed)
  return narrowed.length > 0 ? narrowed : tools
}

function compactResearchOpenedSourceToolsForState(
  state: AgentStateData,
  tools: ToolDefinitionLike[],
): ToolDefinitionLike[] {
  const openedDomains = stepOpenedSourceDomains(state).size
  const candidateDomains = state.stepSourceDomainCounts.size
  const needsAlternateSourceRoute =
    state.suppressedResearchToolName === 'read_document' ||
    state.stepLoopDetections > 0 ||
    state.consecutiveNoToolCalls > 0 ||
    (state.stepResearchCallCount >= 2 && openedDomains < Math.min(2, Math.max(1, candidateDomains)))

  const allowed = needsAlternateSourceRoute
    ? new Set(COMPACT_RESEARCH_SOURCE_RUNTIME_TOOLS)
    : new Set(['read_document'])
  if (state.suppressedResearchToolName) allowed.delete(state.suppressedResearchToolName)
  if (!hasRenderedBrowserContext(state)) {
    allowed.delete('browser_get_content')
    allowed.delete('browser_find_text')
    allowed.delete('browser_scroll')
  }
  const narrowed = filterToolDefinitions(tools, allowed)
  return narrowed.length > 0 ? narrowed : tools
}

function compactResearchSourceRecoveryToolsForState(
  state: AgentStateData,
  currentTools: ToolDefinitionLike[],
  sourcePool: ToolDefinitionLike[],
): ToolDefinitionLike[] {
  const hasPrimarySourceRoute = currentTools.some(tool =>
    COMPACT_RESEARCH_PRIMARY_SOURCE_RUNTIME_TOOLS.has(tool.function?.name || ''),
  )
  if (hasPrimarySourceRoute) return currentTools

  const allowed = new Set(COMPACT_RESEARCH_SOURCE_RUNTIME_TOOLS)
  if (state.suppressedResearchToolName) allowed.delete(state.suppressedResearchToolName)
  if (!hasRenderedBrowserContext(state)) {
    allowed.delete('browser_get_content')
    allowed.delete('browser_find_text')
    allowed.delete('browser_scroll')
  }
  const recovered = filterToolDefinitions(sourcePool, allowed)
  const recoveredHasPrimarySourceRoute = recovered.some(tool =>
    COMPACT_RESEARCH_PRIMARY_SOURCE_RUNTIME_TOOLS.has(tool.function?.name || ''),
  )
  return recoveredHasPrimarySourceRoute ? recovered : currentTools
}

function loopRecoveryToolForState(
  state: AgentStateData,
  tools: ToolDefinitionLike[],
): ToolDefinitionLike[] {
  const suppressed = state.suppressedResearchToolName
  if (!suppressed) return tools

  if (suppressed === 'web_search' && state.stepLoopDetections >= 1) {
    const names = hasRenderedBrowserContext(state)
      ? ['read_document', 'browser_navigate', 'browser_get_content', 'browser_find_text']
      : ['read_document', 'browser_navigate']
    const narrowed = tools.filter(tool => names.includes(tool.function?.name || ''))
    if (narrowed.length > 0) return narrowed
  }

  if (state.stepLoopDetections < 2) return tools

  const preferred = suppressed === 'read_document'
    ? ['browser_navigate', 'browser_get_content', 'browser_find_text', 'web_search']
    : ['read_document', 'web_search', 'browser_get_content', 'browser_navigate', 'browser_find_text']

  const narrowed = tools.filter(tool => {
    const name = tool.function?.name || ''
    if (name === suppressed) return false
    if ((name === 'browser_get_content' || name === 'browser_find_text') && !hasRenderedBrowserContext(state)) return false
    return preferred.includes(name)
  })
  if (narrowed.length > 0) return narrowed
  return tools.length > 1 ? tools.slice(0, 1) : tools
}

function hasRenderedBrowserContext(state: AgentStateData): boolean {
  const signature = state.lastBrowserStateHash
  return !!signature && signature !== '||0'
}

function currentToolIntentText(state: AgentStateData): string {
  return [
    state.originalUserRequest || '',
    state.currentPlanItems?.[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
    state.stepMicroPlan || '',
  ].join('\n')
}

function shouldIncludeTemporalContextForTurn(state: AgentStateData): boolean {
  if (state.forceTextNextIteration) return false
  if (state.taskStrategy === 'research' || state.taskStrategy === 'browse' || state.taskStrategy === 'analysis') return true
  return /\b(?:today|tomorrow|yesterday|latest|recent|up[-\s]?to[-\s]?date|date|time|timezone|time\s*zone|as of|current\s+(?:date|time|weather|news|price|score|schedule|status|version))\b/i.test(currentToolIntentText(state))
}

function browserStepAllowsAdvancedPointerTools(state: AgentStateData): boolean {
  if (state.browserRecoveryRequired || state.stepFailureCount >= 2) return true
  return /\b(?:drag|drop|drag[- ]?and[- ]?drop|click[- ]?and[- ]?hold|click hold|long[- ]?press|hold|hover|tooltip|flyout|sub[- ]?menu|menu|mega[- ]?menu|slider|range input|resize handle|reorder|sort|move item|move card|move marker|pan map|canvas|drawing|scrub|swipe)\b/i.test(currentToolIntentText(state))
}

function browserStepAllowsDocumentTool(state: AgentStateData): boolean {
  if (state.browserRecoveryRequired || state.stepFailureCount >= 2) return true
  return /\b(?:pdf|document|docx?|paper|report|manual|whitepaper|file|download|transcript|terms|policy)\b/i.test(currentToolIntentText(state))
}

function buildStepAllowsOptionalTool(state: AgentStateData, toolName: string): boolean {
  if (state.currentPhase !== 'build') return true
  const text = currentToolIntentText(state)
  if (toolName === 'image_search') {
    return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|download|real one|use real)\b/i.test(text)
  }
  if (toolName === 'browser_screenshot' || toolName === 'browser_scroll') {
    return state.websiteBrowserCheckAttempted ||
      state.websiteBrowserCheckDone ||
      state.websiteResponsiveCheckPrompted ||
      state.nextWebsitePreviewAttempted ||
      state.nextWebsitePreviewDone ||
      /\b(?:preview|visual|inspect|browser|screenshot|scroll|render|responsive|viewport|local site|local preview|qa|quality check|verify)\b/i.test(text)
  }
  if (toolName === 'export_pdf') {
    return /\b(?:pdf|export)\b/i.test(text)
  }
  if (toolName === 'delete_file') {
    return /\b(?:delete|remove|cleanup|clean up|discard)\b/i.test(text)
  }
  return true
}

function finalStepAllowsOptionalTool(state: AgentStateData, toolName: string): boolean {
  if (state.currentPhase !== 'deliver') return true
  const text = currentToolIntentText(state)
  if (toolName === 'image_search') {
    return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|download|real one|use real)\b/i.test(text)
  }
  if (toolName === 'browser_screenshot' || toolName === 'browser_scroll') {
    return state.taskStrategy === 'browse' ||
      state.websiteBrowserCheckAttempted ||
      state.websiteBrowserCheckDone ||
      state.websiteResponsiveCheckPrompted ||
      state.nextWebsitePreviewAttempted ||
      state.nextWebsitePreviewDone ||
      /\b(?:preview|visual|inspect|browser|screenshot|scroll|render|responsive|viewport|local site|local preview|qa|quality check|verify)\b/i.test(text)
  }
  if (toolName === 'export_pdf') {
    return /\b(?:pdf|export)\b/i.test(text)
  }
  if (toolName === 'delete_file') {
    return /\b(?:delete|remove|cleanup|clean up|discard)\b/i.test(text)
  }
  return true
}

function pruneToolsForCurrentStep(state: AgentStateData, tools: ToolDefinitionLike[]): ToolDefinitionLike[] {
  if (isNonFinalBrowserStep(state)) {
    if (state.stepToolCallCount === 0 && !state.browserRecoveryRequired) {
      const startTools = filterToolDefinitions(tools, BROWSER_STEP_START_RUNTIME_TOOLS)
      return browserStepAllowsDocumentTool(state)
        ? startTools
        : startTools.filter(tool => tool.function?.name !== 'read_document')
    }
    const browserTools = filterToolDefinitions(tools, BROWSER_NONFINAL_RUNTIME_TOOLS)
    const toolsWithoutColdDocument = browserStepAllowsDocumentTool(state)
      ? browserTools
      : browserTools.filter(tool => tool.function?.name !== 'read_document')
    if (browserStepAllowsAdvancedPointerTools(state)) return toolsWithoutColdDocument
    return browserTools.filter(tool => {
      const name = tool.function?.name || ''
      return !BROWSER_ADVANCED_POINTER_TOOLS.has(name) && (name !== 'read_document' || browserStepAllowsDocumentTool(state))
    })
  }
  let stepTools = tools
  if (shouldPreferExtractionBeforeColdBrowser(state)) {
    const narrowed = stepTools.filter(tool => !RESEARCH_COLD_BROWSER_RUNTIME_TOOLS.has(tool.function?.name || ''))
    if (narrowed.length > 0) stepTools = narrowed
  }
  if (state.currentPhase === 'research') {
    if (explicitWebSearchLimitFromText(state.originalUserRequest || '') !== null) {
      return filterToolDefinitions(stepTools, FIXED_WEB_SEARCH_RUNTIME_TOOLS)
    }
    const allowSupportFiles = researchStepAllowsSupportFileTools(state)
    const allowImageSearch = researchStepAllowsImageSearch(state)
    const allowColdBrowserOpen =
      !!state.userProvidedUrl ||
      state.stepResearchCallCount > 0 ||
      state.stepVisitedUrls.size > 0 ||
      state.suppressedResearchToolName === 'read_document'
    return stepTools.filter(tool => {
      const name = tool.function?.name || ''
      if (!allowSupportFiles && RESEARCH_FILE_WRITE_RUNTIME_TOOLS.has(name)) return false
      if (!allowImageSearch && RESEARCH_OPTIONAL_RUNTIME_TOOLS.has(name)) return false
      if (!allowColdBrowserOpen && RESEARCH_COLD_BROWSER_RUNTIME_TOOLS.has(name)) return false
      return true
    })
  }
  if (state.currentPhase === 'build') {
    return stepTools.filter(tool => {
      const name = tool.function?.name || ''
      return !BUILD_OPTIONAL_RUNTIME_TOOLS.has(name) || buildStepAllowsOptionalTool(state, name)
    })
  }
  if (state.currentPhase === 'deliver') {
    return stepTools.filter(tool => {
      const name = tool.function?.name || ''
      return !FINAL_OPTIONAL_RUNTIME_TOOLS.has(name) || finalStepAllowsOptionalTool(state, name)
    })
  }
  return stepTools
}

function selectedSkillAttachments(messages: AgentLoopOptions['messages']): Array<{ name: string; content: string }> {
  return messages.flatMap((message) =>
    (message.attachments || [])
      .filter((attachment) => attachment.type === SKILL_ATTACHMENT_TYPE && attachment.content)
      .map((attachment) => ({
        name: attachment.name.replace(/\.skill$/i, ''),
        content: attachment.content || '',
      }))
  )
}

function uploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return messages.flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type !== SKILL_ATTACHMENT_TYPE)
  )
}

function isReadableAttachmentContent(attachment: AgentAttachment): boolean {
  return !!attachment.content &&
    !attachment.type.startsWith('image/') &&
    attachment.contentEncoding !== 'data-url'
}

function readableUploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return uploadedAttachments(messages).filter(isReadableAttachmentContent)
}

function visualImageUploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return uploadedAttachments(messages).filter((attachment) =>
    attachment.type.startsWith('image/') && !!attachment.content
  )
}

function uploadedAttachmentNames(messages: AgentLoopOptions['messages']): string[] {
  return [...new Set(uploadedAttachments(messages).map((attachment) => attachment.name).filter(Boolean))]
}

function describeAttachmentForContext(attachment: AgentAttachment): string {
  const size = attachment.size > 0 ? `, ${Math.round(attachment.size / 1024)} KB` : ''
  const sandboxPath = attachment.sandboxPath ? `, sandbox path: ${attachment.sandboxPath}` : ''
  if (attachment.type.startsWith('image/')) return `Image: ${attachment.name} (${attachment.type}${size})`
  if (attachment.type === SKILL_ATTACHMENT_TYPE) return `Selected skill file: ${attachment.name}${size ? ` (${Math.round(attachment.size / 1024)} KB)` : ''}`
  return `Attached file: ${attachment.name} (${attachment.type || 'unknown type'}${size}${sandboxPath})`
}

function attachmentSummaryForContext(message: AgentLoopOptions['messages'][number], includeSkills = false): string {
  const attachments = (message.attachments || []).filter((attachment) =>
    includeSkills || attachment.type !== SKILL_ATTACHMENT_TYPE
  )
  if (attachments.length === 0) return ''

  return [
    'ATTACHMENTS PROVIDED BY THE USER:',
    ...attachments.map((attachment) => `- ${describeAttachmentForContext(attachment)}`),
  ].join('\n')
}

function attachmentContextForPlanning(message: AgentLoopOptions['messages'][number]): string {
  const attachments = (message.attachments || []).filter((attachment) => attachment.type !== SKILL_ATTACHMENT_TYPE)
  if (attachments.length === 0) return ''

  const sections = [
    'UPLOADED ATTACHMENT HANDLING:',
    'These files came from the user upload UI, not the public web. If the user asks about them, plan from the uploaded attachment context first.',
    'Do not plan web_search for an uploaded filename/title. If a sandbox path is listed, inspect that exact uploaded sandbox file with document or terminal tools when file contents are needed.',
    'Use web/browsing only if the user explicitly asks for outside/current information beyond the attachment.',
  ]

  for (const attachment of attachments) {
    sections.push(`- ${describeAttachmentForContext(attachment)}`)
    if (isReadableAttachmentContent(attachment)) {
      const content = attachment.content || ''
      const excerpt = content.length > MAX_PLANNING_ATTACHMENT_CHARS
        ? `${content.slice(0, MAX_PLANNING_ATTACHMENT_CHARS)}\n... [truncated from ${content.length} characters]`
        : content
      sections.push(`--- Uploaded attachment text: ${attachment.name} ---\n${excerpt}\n--- End uploaded attachment text: ${attachment.name} ---`)
    } else if (attachment.type.startsWith('image/')) {
      sections.push(ASSISTANT_SUPPORTS_IMAGE_INPUT
        ? [
            `Image attachment ${attachment.name} is already available as high-detail visual input at runtime.`,
            'For image questions, inspect the uploaded image directly from the visual input.',
            'Do not create browser/open/current-view/extract-text/read_file/web_search steps for the uploaded image filename.',
          ].join(' ')
        : [
            `Image attachment ${attachment.name} was uploaded, but the active model route does not accept direct image input.`,
            'Use any extracted text or metadata already present.',
            'If the user needs visual interpretation of the image itself, explain that direct image inspection is not available on this route.',
            'Do not web_search the uploaded image filename unless the user explicitly asks for outside/current information.',
          ].join(' '))
    } else {
      sections.push(attachment.sandboxPath
        ? `No extracted text is currently loaded for ${attachment.name}. A sandbox copy is listed at ${attachment.sandboxPath}; use that path with document or terminal tools if the file contents are required.`
        : `No extracted text is currently loaded for ${attachment.name}. If runtime still lacks content, report that this uploaded file could not be read instead of searching the web for the filename.`)
    }
  }

  return sections.join('\n')
}

function buildPlanningMessages(messages: AgentLoopOptions['messages']): Array<{ role: string; content: string }> {
  const planningMessages = messages.map((message) => {
    const skills = (message.attachments || [])
      .filter((attachment) => attachment.type === SKILL_ATTACHMENT_TYPE && attachment.content)
    const attachmentSummary = attachmentSummaryForContext(message)
    const uploadedAttachmentContext = attachmentContextForPlanning(message)

    if (skills.length === 0 && !attachmentSummary && !uploadedAttachmentContext) {
      return { role: message.role, content: message.content }
    }

    const skillContext = skills.map((skill) => {
      const content = skill.content || ''
      const truncated = content.length > MAX_PLANNING_SKILL_CHARS
        ? `${content.slice(0, MAX_PLANNING_SKILL_CHARS)}\n... [truncated from ${content.length} characters]`
        : content
      return `--- Selected skill file: ${skill.name} ---\n${truncated}\n--- End selected skill file: ${skill.name} ---`
    }).join('\n\n')

    return {
      role: message.role,
      content: [
        message.content,
        attachmentSummary,
        uploadedAttachmentContext,
        skills.length > 0
          ? `SELECTED SKILL FILES LOADED BEFORE PLANNING:\n${skillContext}\n\nPlanner requirement: include and respect a first step that reads and applies these selected skill files before any research, browsing, coding, or writing.`
          : '',
      ].filter(Boolean).join('\n\n'),
    }
  })

  if (isContextualTaskUpdate(messages)) {
    planningMessages.push({
      role: 'system',
      content: `The latest user message is an interruption/correction to the previous task. Plan for the combined effective request below, and treat the correction as a hard constraint:\n\n${effectiveTaskRequest(messages)}`,
    })
  }

  return planningMessages
}

function requiredAttachmentPlanSteps(messages: AgentLoopOptions['messages']): RequiredPlanStep[] {
  const attachments = uploadedAttachments(messages)
  if (attachments.length === 0) return []

  const names = uploadedAttachmentNames(messages)
  const readableName = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '')
  const firstReadable = readableUploadedAttachments(messages)[0]
  const hasVisualImages = ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments(messages).length > 0
  const hasTextOnlyImages = !ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments(messages).length > 0
  const hasSandboxUploads = attachments.some(attachment => !!attachment.sandboxPath)
  const contentPreview = firstReadable?.content
    ? firstReadable.content.slice(0, MAX_PRELOADED_ATTACHMENT_PANEL_CHARS)
    : hasVisualImages
      ? 'Uploaded image visual content is available as high-detail model input. No browser opening, current-view extraction, or filename search is required.'
      : hasTextOnlyImages
        ? 'Uploaded image metadata was loaded, but this model route cannot inspect the image pixels directly.'
      : 'Uploaded attachment metadata was loaded, but no extracted text was available in context.'
  const titlePrefix = hasVisualImages
    ? `Visually inspect uploaded image${names.length === 1 ? '' : 's'}`
    : `Read uploaded attachment${names.length === 1 ? '' : 's'}`
  const scope = hasVisualImages
    ? 'Runtime preflight only: uploaded image bytes are already loaded as high-detail visual input in the model context. Inspect the attached image directly from that visual input. Do not plan browser/open/current-view/extract-text/read_file/web_search steps for the image filename. Use web/browsing only if the user explicitly asks for outside/current information beyond the image.'
    : hasTextOnlyImages
      ? 'Runtime preflight only: uploaded image metadata is loaded, but the active model route cannot inspect image pixels directly. Use extracted text/metadata if present; otherwise report that direct image inspection is unavailable on this route. Do not web_search uploaded filenames unless the user explicitly asks for outside/current information.'
    : hasSandboxUploads
      ? 'Runtime preflight only: uploaded attachment metadata is loaded and sandbox copies are available at the listed paths. Use extracted message text if present; otherwise inspect the listed sandbox path with document or terminal tools. Do not web_search uploaded filenames.'
      : 'Runtime preflight only: uploaded attachment content is loaded from the message/server and must be used as the source context. Do not web_search uploaded filenames. Do not use read_file for uploaded attachment names.'

  return [{
    title: `${titlePrefix}: ${readableName || 'provided file'}`,
    scope,
    preloaded: true,
    kind: 'attachment',
    label: readableName || 'uploaded attachment',
    contentPreview,
    visualInput: hasVisualImages,
  }]
}

function requiredSkillPlanSteps(messages: AgentLoopOptions['messages']): RequiredPlanStep[] {
  const skills = selectedSkillAttachments(messages)
  if (skills.length === 0) return []

  const names = [...new Set(skills.map((skill) => skill.name || 'selected skill'))]
  const readableNames = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')

  return [{
    title: `Read selected skill file${names.length === 1 ? '' : 's'}: ${readableNames}`,
    scope: 'Runtime preflight only: selected skill attachment content is loaded into context and must be understood before any research, browsing, coding, or writing. Do not use external tools in this step.',
    preloaded: true,
    kind: 'skill',
    label: readableNames,
  }]
}

export type AgentContextMessage = {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>
}

export function preprocessMessagesForAgentContext(messages: AgentLoopOptions['messages']): AgentContextMessage[] {
  return messages.map(m => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content }
    }

    const hasUploadedAttachments = m.attachments.some(a => a.type !== SKILL_ATTACHMENT_TYPE)
    const imageAttachments = m.attachments.filter(a => a.type.startsWith('image/') && a.content)
    const textAttachments = m.attachments.filter(a =>
      !a.type.startsWith('image/') &&
      a.content &&
      a.contentEncoding !== 'data-url'
    )

    let textContent = m.content
    if (hasUploadedAttachments) {
      textContent += `\n\n${attachmentSummaryForContext(m, false)}`
    }
    let remainingAttachmentChars = MAX_CONTEXT_ATTACHMENT_CHARS
    for (const att of textAttachments) {
      if (!att.content) continue
      const isSkill = att.type === SKILL_ATTACHMENT_TYPE
      const isExpandedArchive = att.type === 'application/vnd.agent.archive-text'
      if (remainingAttachmentChars <= 0) {
        textContent += `\n\n--- Attached file: ${att.name} ---\n[omitted: attachment context budget reached]\n--- End of ${att.name} ---`
        continue
      }
      const maxChars = Math.min(
        remainingAttachmentChars,
        isSkill || isExpandedArchive ? MAX_CONTEXT_ATTACHMENT_CHARS : MAX_ATTACHMENT_CHARS,
      )
      const label = isSkill ? 'Selected skill' : isExpandedArchive ? 'Extracted archive' : 'Attached file'
      const instruction = isSkill
        ? '\nRead this skill first and apply the relevant instructions before continuing.'
        : ''
      const truncated = att.content.length > maxChars
        ? att.content.slice(0, maxChars) + `\n... [truncated from ${att.content.length} characters]`
        : att.content
      remainingAttachmentChars -= Math.min(att.content.length, maxChars)
      textContent += `\n\n--- ${label}: ${att.name} ---${instruction}\n${truncated}\n--- End of ${att.name} ---`
    }

    if (imageAttachments.length > 0 && ASSISTANT_SUPPORTS_IMAGE_INPUT) {
      textContent += '\n\nUse the attached image content below as visual input; do not claim the image was unavailable.'
      const parts: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [
        { type: 'text', text: textContent },
      ]
      for (const att of imageAttachments) {
        parts.push({
          type: 'image_url',
          image_url: { url: att.content!, detail: 'high' },
        })
      }
      return { role: m.role, content: parts }
    }

    if (imageAttachments.length > 0) {
      textContent += '\n\nUploaded image bytes are stored with the conversation, but the active DeepSeek API route does not accept direct image input. Use any extracted text or metadata already loaded; if the user asks for visual interpretation of the image itself, state that direct image inspection is unavailable on this route.'
    }

    const metadataOnlyAttachments = m.attachments.filter(a =>
      a.type !== SKILL_ATTACHMENT_TYPE &&
      !a.type.startsWith('image/') &&
      !isReadableAttachmentContent(a)
    )
    if (metadataOnlyAttachments.length > 0) {
      const hasSandboxCopies = metadataOnlyAttachments.some(att => !!att.sandboxPath)
      textContent += [
        '',
        'Uploaded attachment metadata is present, but no extracted text was loaded for the following file(s):',
        ...metadataOnlyAttachments.map(att => `- ${describeAttachmentForContext(att)}`),
        hasSandboxCopies
          ? 'Do not say no file was attached. Use the listed sandbox path with document or terminal tools when the user asks for the file contents.'
          : 'Do not say no file was attached. Identify the file from this metadata and state that its contents could not be read from the provided upload context unless another tool supplies the contents.',
      ].join('\n')
    }

    return { role: m.role, content: textContent }
  })
}

function normalizedCreatedFileSet(createdFiles: Iterable<string>): Set<string> {
  return new Set([...createdFiles].map(p => p.replace(/^\.?\//, '').toLowerCase()))
}

function createdFileWebsiteProblems(createdFiles: Iterable<string>): { missingFiles: string[]; structureIssues: string[] } {
  const created = normalizedCreatedFileSet(createdFiles)
  const hasPage = created.has('app/page.tsx') || created.has('src/app/page.tsx')
  const hasLayout = created.has('app/layout.tsx') || created.has('src/app/layout.tsx')
  const hasStyles = created.has('app/globals.css') || created.has('src/app/globals.css') || created.has('styles/globals.css')
  const hasComponent = [...created].some(p =>
    /^(src\/)?components\/.+\.(?:tsx|jsx)$/.test(p) ||
    /^(src\/)?app\/components\/.+\.(?:tsx|jsx)$/.test(p)
  )

  return {
    missingFiles: [
      hasPage ? '' : 'app/page.tsx',
      hasLayout ? '' : 'app/layout.tsx',
      hasStyles ? '' : 'app/globals.css',
    ].filter(Boolean),
    structureIssues: hasComponent
      ? []
      : ['Create at least one reusable TSX component under components/ or app/components/ and render it from page.tsx.'],
  }
}

async function getNextWebsiteCompletionProblems(
  conversationId: string | undefined,
  createdFiles: Iterable<string>,
): Promise<{ missingFiles: string[]; structureIssues: string[] }> {
  if (!conversationId) return createdFileWebsiteProblems(createdFiles)

  const status = await getNextWebsiteProjectStatus(conversationId)
  return {
    missingFiles: status.missingFiles,
    structureIssues: status.ready ? status.structureIssues : [],
  }
}

async function getNextWebsiteCompletionBlocker(
  conversationId: string | undefined,
  state: AgentStateData,
  originalRequest: string,
): Promise<string | null> {
  if (!shouldDefaultFrontendToNextTsx(originalRequest)) return null

  const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
  if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
    const details = [
      websiteProblems.missingFiles.length > 0
        ? `Missing required file(s): ${websiteProblems.missingFiles.join(', ')}.`
        : '',
      websiteProblems.structureIssues.length > 0
        ? `Structure/style issue(s): ${websiteProblems.structureIssues.join(' ')}`
        : '',
    ].filter(Boolean).join(' ')

    return `WEBSITE COMPLETION BLOCKED: The requested website is not a complete renderable Next.js/TSX build. ${details} Create or edit the actual website files now: app/page.tsx, app/layout.tsx importing './globals.css', app/globals.css, and at least one imported reusable component under components/ or app/components/. Do not finish after only package/config/layout files.`
  }

  if (!state.nextWebsitePreviewDone) {
    const previewProblem = state.nextWebsitePreviewError
      ? ` Last preview error: ${state.nextWebsitePreviewError}`
      : state.nextWebsitePreviewAttempted
        ? ' The preview was attempted but did not open successfully.'
        : ' The local TSX preview has not run yet.'

    return `WEBSITE COMPLETION BLOCKED: The Next.js/TSX website has not successfully built and opened in the Computer browser.${previewProblem} Fix the generated frontend files or make a targeted frontend edit so the backend rebuilds and opens the local preview.`
  }

  if (!state.websiteResponsiveCheckDone) {
    return `WEBSITE COMPLETION BLOCKED: The local website preview opened, but the required visual check has not passed. Use browser_screenshot or browser_scroll on the managed local preview at the existing browser size, then fix visual issues or finish only after the visual check succeeds.`
  }

  return null
}

function maxTokensForIteration(state: AgentStateData): number {
  const maxNormalOutputTokens = 8192
  const maxBuildOutputTokens = 24_576
  const maxDeliverableOutputTokens = 24_576
  if (state.deadlineFinalizationStarted) return maxDeliverableOutputTokens
  if (state.currentPhase === 'deliver') {
    return maxDeliverableOutputTokens
  }
  if (state.taskStrategy === 'browse') return 4096
  if (state.currentPhase === 'build') return maxBuildOutputTokens
  if (state.taskStrategy === 'research' || state.taskStrategy === 'analysis') {
    return maxNormalOutputTokens
  }
  return maxNormalOutputTokens
}

function shouldForceAgenticToolCall(state: AgentStateData, hasActivePlanStep: boolean): boolean {
  if (!hasActivePlanStep || state.currentPhase === 'deliver') return false
  if (state.taskStrategy === 'browse') return true

  const stepLooksActionable = isResearchStepText(currentStepText(state))
  const agenticStep =
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.currentPhase === 'research' ||
    state.currentPhase === 'build' ||
    stepLooksActionable
  if (!agenticStep) return false

  const complexity = state.taskComplexity as 1 | 2 | 3
  const requiredCalls = state.currentPhase === 'research' || state.taskStrategy === 'research' || state.taskStrategy === 'analysis'
    ? researchDepthProfileForState(state).requiredCalls
    : (MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 2)
  const earlyToolFloor = Math.min(requiredCalls, state.taskComplexity >= 3 ? 2 : 1)

  return state.stepToolCallCount < earlyToolFloor
}

const STARTUP_READY_REQUIRED_TOOLS = new Set([
  'create_file',
  'edit_file',
  'append_file',
  'export_pdf',
  'read_file',
  'list_files',
  'delete_file',
  'execute_command',
  'run_code',
])

function parsedToolCallArgs(toolCall: ToolCallData): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.arguments || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function sourceLooksLocal(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  if (/^(?:https?:|data:|blob:|mailto:|tel:)/i.test(text)) return false
  return true
}

function toolCallNeedsStartupReady(toolCall: ToolCallData): boolean {
  if (STARTUP_READY_REQUIRED_TOOLS.has(toolCall.name)) return true
  if (toolCall.name === 'read_document') {
    return sourceLooksLocal(parsedToolCallArgs(toolCall).source)
  }
  if (toolCall.name === 'http_request') {
    return sourceLooksLocal(parsedToolCallArgs(toolCall).url)
  }
  return false
}

function toolCallsNeedStartupReady(toolCalls: Map<number, ToolCallData>): boolean {
  return [...toolCalls.values()].some(toolCallNeedsStartupReady)
}

function messageText(content: ChatMessageParam['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part.text || '').filter(Boolean).join('\n')
  return ''
}

function latestUserMessageText(messages: ChatMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const text = messageText(messages[i].content)
      if (text.trim()) return text.trim().slice(0, 700)
    }
  }
  return ''
}

function compactForcedNarrationMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'current step'
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx]
  const recentActions = state.workLog
    .slice(-6)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const recentFindings = [...state.stepFindings.entries()]
    .slice(-3)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)
  const browserEvidence = state.browserTaskCompletionEvidence.slice(-3)
  const visualObservations = state.workLedger.visualObservations
    .slice(-3)
    .map(item => `${item.title || item.url || item.tool}: ${item.detail}`)

  const context = [
    `User request: ${state.originalUserRequest || latestUserMessageText(allMessages) || 'not available'}`,
    `Active phase: ${state.currentStepIdx + 1}/${state.currentPlanItems?.length || 1} - ${currentStep}`,
    currentScope ? `Phase scope: ${currentScope}` : '',
    recentActions.length ? `Recent visible work:\n- ${recentActions.join('\n- ')}` : '',
    recentFindings.length ? `Recent findings:\n- ${recentFindings.join('\n- ')}` : '',
    browserEvidence.length ? `Browser completion evidence:\n- ${browserEvidence.join('\n- ')}` : '',
    visualObservations.length ? `Recent browser/page observations:\n- ${visualObservations.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: state.phaseEndNarrationPending
        ? 'FAST PHASE-END PROGRESS NARRATION ONLY. Do not solve, plan, browse, search, write files, or call tools. Write one natural result-first progress paragraph from the compact context only, then put <next_step/> on its own final line. This applies before the next phase starts in every task type. Use 1-2 complete sentences, 15-20 words preferred, hard cap 34 words / 240 characters before the marker. Never ask permission to continue or write opt-in handoffs. No internal step numbers, no vague "sufficient evidence", no command fragments, no source dump. Do not start with "Synthesized key", "Completed N searches", or tool/action accounting.'
        : 'FAST PROGRESS NARRATION ONLY. Do not solve, plan, browse, search, write files, or call tools. Write one natural Manus-style progress paragraph from the compact context only. This applies to the current phase regardless of task type. Use 1-2 complete sentences, 15-20 words preferred, hard cap 34 words / 240 characters. Be result-first and concrete. Vary the opening verb and sentence shape; do not repeat the same starter pattern. Never ask permission to continue or write opt-in handoffs. No internal step numbers, no vague "sufficient evidence", no command fragments, no source dump. Do not start with "Synthesized key", "Completed N searches", or tool/action accounting.',
    },
    {
      role: 'user',
      content: context || 'Write a concise progress update from the recent completed work.',
    },
  ]
}

function compactResearchTurnMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const request = state.originalUserRequest || latestUserMessageText(allMessages) || 'Continue the research task.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'current research step'
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx]
  const memoryText = state.workingMemory?.render({ stepIdx: state.currentStepIdx, maxFacts: 10, maxChars: 1000 }) || ''
  const recentSources = state.researchActivity.entries
    .filter(entry => entry.success && (entry.domain || entry.query || entry.url || entry.titles?.length))
    .slice(-5)
    .map(entry => {
      const target = entry.domain || entry.url || entry.query || entry.tool
      const titles = entry.titles?.slice(0, 2).join('; ')
      return titles ? `${entry.kind}: ${target} - ${titles}` : `${entry.kind}: ${target}`
    })
  const recentActions = state.workLog
    .slice(-5)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const findings = [...state.stepFindings.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-4)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)

  const context = [
    `User request: ${request}`,
    `Active phase: ${state.currentStepIdx + 1}/${state.currentPlanItems?.length || 1} - ${currentStep}`,
    currentScope ? `Phase scope: ${currentScope}` : '',
    memoryText,
    recentSources.length ? `Recent sources/results:\n- ${recentSources.join('\n- ')}` : '',
    recentActions.length ? `Recent completed work:\n- ${recentActions.join('\n- ')}` : '',
    findings.length ? `Completed findings:\n- ${findings.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: 'COMPACT RESEARCH TURN. Continue from the compact task state below; do not ask to see the full transcript and do not repeat completed source actions. Tool caps are ceilings, never targets: do not chase available search/extraction budget once the phase has a credible evidence packet. Use targeted web_search for the next missing evidence gap, then read_document on the strongest candidate URL. If strong candidate URLs are already available, read the best one instead of searching again. If the phase has enough evidence, write one concise result-first progress paragraph and emit <next_step/>. Use browser navigation only when rendered state, interaction, screenshots, or page scripts are necessary.',
    },
    {
      role: 'user',
      content: context,
    },
  ]
}

function shouldUseCompactResearchTurn(state: AgentStateData): boolean {
  if (state.forceTextNextIteration || state.exactExtractionGuardPending) return false
  if (state.deadlineFinalizationStarted) return false
  if (!(state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.currentPhase === 'research')) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentStepIdx === state.currentPlanItems.length - 1 && state.currentPhase === 'deliver') return false
  return true
}

function compactResearchNeedsToolAction(state: AgentStateData): boolean {
  return !compactResearchEvidenceComplete(state)
}

function compactResearchBreadthSaturated(state: AgentStateData, depth: ReturnType<typeof researchDepthProfileForState>): boolean {
  if (depth.label === 'single-source' || depth.label === 'light') return false
  const openedPages = state.stepVisitedUrls.size
  const distinctDomains = stepOpenedSourceDomains(state).size
  const uniqueSearches = state.stepSearchQueries.size
  const usefulCalls = Math.max(
    depth.label === 'wide' ? 9 : depth.label === 'deep' ? 7 : 4,
    Math.ceil(depth.requiredCalls * 0.75),
  )
  const usefulOpenedPages = Math.min(
    depth.requiredSourceBreadth,
    Math.max(3, Math.ceil(depth.requiredSourceBreadth * 0.7)),
  )
  return state.stepResearchCallCount >= usefulCalls &&
    uniqueSearches >= Math.min(usefulCalls, depth.label === 'wide' ? 7 : 5) &&
    openedPages >= usefulOpenedPages &&
    distinctDomains >= depth.requiredSourceBreadth
}

function compactResearchNeedsOpenedSource(state: AgentStateData): boolean {
  const depth = researchDepthProfileForState(state)
  if (depth.label === 'single-source' || depth.label === 'light') return false
  if (compactResearchEvidenceComplete(state)) return false
  const openedPages = state.stepVisitedUrls.size
  const candidateDomains = state.stepSourceDomainCounts.size
  const evidenceDomains = Math.max(stepOpenedSourceDomains(state).size, candidateDomains)
  const uniqueSearches = state.stepSearchQueries.size
  const usefulCalls = Math.max(
    depth.label === 'wide' ? 9 : depth.label === 'deep' ? 7 : 4,
    Math.ceil(depth.requiredCalls * 0.75),
  )
  const usefulOpenedPages = Math.min(
    depth.requiredSourceBreadth,
    Math.max(3, Math.ceil(depth.requiredSourceBreadth * 0.7)),
  )
  return state.stepResearchCallCount >= 1 &&
    uniqueSearches >= 1 &&
    evidenceDomains >= 1 &&
    openedPages < usefulOpenedPages
}

function compactResearchStalledSearchPacketComplete(
  state: AgentStateData,
  depth: ReturnType<typeof researchDepthProfileForState>,
): boolean {
  if (state.consecutiveNoToolCalls < 3) return false

  const calls = state.stepResearchCallCount
  const uniqueSearches = state.stepSearchQueries.size
  const candidateDomains = state.stepSourceDomainCounts.size
  if (calls <= 0 || uniqueSearches <= 0 || candidateDomains <= 0) return false

  if (depth.label === 'single-source' || depth.label === 'light') {
    return calls >= Math.min(2, depth.requiredCalls) &&
      candidateDomains >= 1
  }

  const usefulCalls = Math.max(3, Math.ceil(depth.requiredCalls * 0.45))
  const usefulSearches = Math.max(2, Math.ceil(depth.requiredCalls * 0.3))
  const usefulCandidateDomains = Math.min(
    depth.requiredSourceBreadth,
    Math.max(2, Math.ceil(depth.requiredSourceBreadth * 0.4)),
  )

  return calls >= usefulCalls &&
    uniqueSearches >= Math.min(usefulSearches, calls) &&
    candidateDomains >= usefulCandidateDomains
}

function compactResearchSourceOpeningExhausted(
  state: AgentStateData,
  depth: ReturnType<typeof researchDepthProfileForState>,
): boolean {
  if (state.stepVisitedUrls.size > 0 || stepOpenedSourceDomains(state).size > 0) return false
  if (state.stepSearchQueries.size === 0 || state.stepSourceDomainCounts.size === 0) return false
  if (state.stepResearchCallCount === 0) return false

  const repeatedSourceLoops = state.stepLoopDetections >= 4
  const repeatedToolAttempts = state.stepToolCallCount >= Math.max(8, Math.min(14, depth.requiredCalls))
  return repeatedSourceLoops && repeatedToolAttempts
}

function compactResearchEvidenceComplete(state: AgentStateData): boolean {
  const depth = researchDepthProfileForState(state)
  const requiredResearchCalls = depth.requiredCalls
  const requiredSourceBreadth = depth.requiredSourceBreadth
  const openedPages = state.stepVisitedUrls.size
  const distinctDomains = stepOpenedSourceDomains(state).size
  const requiredOpenedPages = Math.min(requiredSourceBreadth, Math.max(1, Math.ceil(requiredResearchCalls / 3)))
  const hasDirectEvidence = openedPages > 0 && distinctDomains > 0
  const candidateDomains = state.stepSourceDomainCounts.size
  const originalRequest = state.originalUserRequest || ''
  const explicitlyHighEvidenceRequest =
    /\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|report|\.md|markdown|cited|citations?|sources?|source[-\s]?backed|evidence[-\s]?backed|compare|versus|vs\.?|analysis|dossier|briefing)\b/i.test(originalRequest) ||
    SUBSTANTIVE_RESEARCH_RE.test(originalRequest)
  const reportResearchNeedsSources =
    taskDefaultsToMarkdownDeliverable(originalRequest) &&
    explicitlyHighEvidenceRequest

  if (hasDirectEvidence && compactResearchBreadthSaturated(state, depth)) return true
  if (compactResearchSourceOpeningExhausted(state, depth)) return true
  if (!reportResearchNeedsSources && !explicitlyHighEvidenceRequest && compactResearchStalledSearchPacketComplete(state, depth)) return true
  if (hasDirectEvidence && state.stepFailureCount >= 2 && !explicitlyHighEvidenceRequest) {
    return state.stepResearchCallCount >= Math.max(2, Math.ceil(requiredResearchCalls * 0.35)) &&
      (candidateDomains >= 2 || distinctDomains >= 1)
  }
  if (hasDirectEvidence && depth.label === 'standard' && !explicitlyHighEvidenceRequest) {
    const usefulCalls = Math.max(4, Math.ceil(requiredResearchCalls * 0.6))
    return state.stepResearchCallCount >= usefulCalls &&
      openedPages >= Math.min(2, requiredOpenedPages) &&
      distinctDomains >= Math.min(2, requiredSourceBreadth)
  }
  if (hasDirectEvidence && depth.label === 'light') {
    return state.stepResearchCallCount >= Math.min(3, requiredResearchCalls) &&
      distinctDomains >= 1
  }
  return state.stepResearchCallCount >= requiredResearchCalls &&
    hasDirectEvidence &&
    openedPages >= requiredOpenedPages &&
    distinctDomains >= requiredSourceBreadth
}

function compactFinalInlineAnswerMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const request = state.originalUserRequest || latestUserMessageText(allMessages) || 'Answer the user directly in chat.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'final answer'
  const memoryText = state.workingMemory?.render({ maxFacts: 12, maxChars: 1800 }) || ''
  const findings = [...state.stepFindings.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)
    .slice(-6)
  const recentActions = state.workLog
    .slice(-8)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const recentSources = state.researchActivity.entries
    .filter(entry => entry.success && (entry.domain || entry.query || entry.url || entry.titles?.length))
    .slice(-8)
    .map(entry => {
      const target = entry.domain || entry.url || entry.query || entry.tool
      const titles = entry.titles?.slice(0, 2).join('; ')
      return titles ? `${entry.kind}: ${target} - ${titles}` : `${entry.kind}: ${target}`
    })
  const context = [
    `User request: ${request}`,
    `Final task: ${currentStep}`,
    memoryText,
    findings.length ? `Completed findings:\n- ${findings.join('\n- ')}` : '',
    recentSources.length ? `Recent sources/results:\n- ${recentSources.join('\n- ')}` : '',
    recentActions.length ? `Recent completed work:\n- ${recentActions.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: 'FINAL INLINE ANSWER ONLY. Write the final answer directly in chat now. Do not call tools, do not write a status update, do not explain what you will do, do not mention plan steps/action labels/files, and do not ask permission to continue. Start with the answer content itself. Use the supplied context as evidence; if context is thin, answer with a concise caveat instead of stalling.',
    },
    {
      role: 'user',
      content: context,
    },
  ]
}

function compactFinalDeliverableMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const request = state.originalUserRequest || latestUserMessageText(allMessages) || 'Create the requested deliverable.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'final deliverable'
  const pendingPartial = state.partialFileWriteRecoveryPending
  const memoryText = state.workingMemory?.render({ maxFacts: 12, maxChars: 1800 }) || ''
  const findings = [...state.stepFindings.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)
    .slice(-6)
  const recentActions = state.workLog
    .slice(-8)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const recentSources = state.researchActivity.entries
    .filter(entry => entry.success && (entry.domain || entry.query || entry.url || entry.titles?.length))
    .slice(-8)
    .map(entry => {
      const target = entry.domain || entry.url || entry.query || entry.tool
      const titles = entry.titles?.slice(0, 2).join('; ')
      return titles ? `${entry.kind}: ${target} - ${titles}` : `${entry.kind}: ${target}`
    })
  const context = [
    `User request: ${request}`,
    `Final task: ${currentStep}`,
    pendingPartial ? `Partial saved file: ${pendingPartial.path} (${pendingPartial.lines} lines, ${pendingPartial.chars} chars).` : '',
    memoryText,
    findings.length ? `Completed findings:\n- ${findings.join('\n- ')}` : '',
    recentSources.length ? `Recent sources/results:\n- ${recentSources.join('\n- ')}` : '',
    recentActions.length ? `Recent completed work:\n- ${recentActions.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: pendingPartial
        ? [
            'PARTIAL FILE CONTINUATION TOOL CALL ONLY.',
            `Make exactly one native append_file call to "${pendingPartial.path}" now; do not write visible prose before it.`,
            'Start the append_file call immediately; do not spend a hidden pass outlining the next section.',
            'Do not call create_file, edit_file, read_file, list_files, export_pdf, research tools, or browser tools.',
            'Append the next missing complete section or paragraph-bounded chunk only. End cleanly at a sentence or section boundary; never stop mid-sentence. Do not repeat already-written content.',
            'Do not emit <next_step/> until after a successful append clears the partial-file state.',
            'Use the full available output budget for this append so clipped long reports and code continue cleanly.',
          ].join(' ')
        : [
            'FINAL SAVED DELIVERABLE TOOL CALL ONLY.',
            'Make exactly one native create_file or append_file call now; do not write visible prose before it.',
            'Start the file tool call immediately; do not spend a hidden pass outlining the deliverable first.',
            'For the first saved output, use create_file with action_label, plan_step_index, and path before content.',
            'For reports, research findings, and substantial write-ups, create a .md file under deliverables/ unless the user named a different path.',
            state.stepToolCallCount > 0 && !hasSavedFinalDeliverableCandidate(state)
              ? 'A previous final-write turn did not save a deliverable; make a shorter complete create_file call now instead of continuing to reason.'
              : '',
            'Write the complete deliverable when it fits. If it does not fit, write a clean opening chunk that ends at a sentence or section boundary, then continue the same file with append_file on the next turn.',
          ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: context,
    },
  ]
}

function compactFinalTextDeliverableMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const request = state.originalUserRequest || latestUserMessageText(allMessages) || 'Create the requested deliverable.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'final deliverable'
  const memoryText = state.workingMemory?.render({ maxFacts: 14, maxChars: 2200 }) || ''
  const findings = [...state.stepFindings.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)
    .slice(-8)
  const recentActions = state.workLog
    .slice(-10)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const recentSources = state.researchActivity.entries
    .filter(entry => entry.success && (entry.domain || entry.query || entry.url || entry.titles?.length))
    .slice(-10)
    .map(entry => {
      const target = entry.domain || entry.url || entry.query || entry.tool
      const titles = entry.titles?.slice(0, 2).join('; ')
      return titles ? `${entry.kind}: ${target} - ${titles}` : `${entry.kind}: ${target}`
    })
  const context = [
    `User request: ${request}`,
    `Final task: ${currentStep}`,
    memoryText,
    findings.length ? `Completed findings:\n- ${findings.join('\n- ')}` : '',
    recentSources.length ? `Recent sources/results:\n- ${recentSources.join('\n- ')}` : '',
    recentActions.length ? `Recent completed work:\n- ${recentActions.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: [
        'FINAL SAVED DELIVERABLE TEXT ONLY.',
        'Write the actual Markdown deliverable directly now.',
        'Start with the title and content; do not write status, plan, action labels, source counts, or attachment/save narration.',
        'The app will save this exact text into the requested Markdown file after your response.',
        'Use the supplied evidence. If evidence is limited, include a short caveat inside the deliverable instead of searching again.',
      ].filter(Boolean).join(' '),
    },
    {
      role: 'user',
      content: context,
    },
  ]
}

function toolJsonRecoveryMessage(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string {
  if (finalSavedDeliverableTurn(state, messages)) {
    return finalSavedDeliverableToolCallInstruction(
      state,
      'FINAL SAVED DELIVERABLE TOOL FORMAT REPAIR: the previous file action was rejected before streaming.',
    )
  }

  if (state.taskStrategy === 'browse') {
    return [
      'TOOL FORMAT RECOVERY: The previous assistant response was rejected before streaming because the browser tool call format or forced tool-call mode was not accepted.',
      'Do not expose this provider/runtime issue to the user.',
      'Retry the current browser step with exactly one native browser tool call using strict JSON object arguments. Do not write a progress update, do not emit <next_step/>, and do not report success unless the live browser state proves this exact step is done.',
      'Use the current page state: browser_screenshot, browser_click_at, browser_type, browser_scroll, browser_find_text, browser_press_key, browser_select, or browser_get_content. If the page is a concrete hard blocker, verify it with browser_screenshot or browser_get_content before reporting.',
      'Never write raw XML-like tool markup such as <toolcall> or <function=...>.',
    ].filter(Boolean).join(' ')
  }

  return [
    'TOOL FORMAT RECOVERY: The previous assistant response was rejected before streaming because the tool-call format or forced tool-call mode was not accepted.',
    'Do not expose this provider/runtime issue to the user.',
    'For this recovery turn, write one concise progress update from evidence already gathered if any exists, then stop.',
    'On the following turn, continue with exactly one native tool call using strict JSON object arguments, or finish directly if the user only needed a direct answer.',
    'If the current browser page is blocked by CAPTCHA, Cloudflare, human verification, access denial, or a hard error, do not click it and do not retry the same URL. Switch to a different credible source, a same-site search result, or synthesize from existing evidence.',
    'Never write raw XML-like tool markup such as <toolcall> or <function=...>.',
  ].filter(Boolean).join(' ')
}

function providerToolModeRecoveryMessage(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string {
  if (finalSavedDeliverableTurn(state, messages)) {
    return finalSavedDeliverableToolCallInstruction(
      state,
      'FINAL SAVED DELIVERABLE TOOL MODE REPAIR: continue with a voluntary native file tool call.',
    )
  }

  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the current task phase'
  const preferredTool = state.taskStrategy === 'browse'
    ? 'a browser tool such as browser_screenshot, browser_get_content, browser_click_at, browser_type, browser_scroll, or browser_find_text'
    : state.currentPhase === 'research' || state.taskStrategy === 'research' || state.taskStrategy === 'analysis'
      ? 'web_search, browser_navigate, browser_get_content, read_document, or image_search if visual evidence is needed'
      : 'the single most useful available tool'

  return [
    'PROVIDER TOOL-CALL RECOVERY: The previous attempt was rejected before streaming because forced tool-call mode was not accepted by this model route.',
    'Do not expose this provider/runtime issue to the user.',
    `Continue "${step}" now. Make exactly one native tool call voluntarily using strict JSON object arguments.`,
    `Use ${preferredTool}.`,
    'Do not answer from memory, do not emit <next_step/>, do not write raw XML-like tool markup, and do not stop unless the requested work is already complete from existing evidence.',
  ].join(' ')
}

function compactResearchToolRequiredMessage(state: AgentStateData, reason: string): string {
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the current research step'
  const evidenceNeed = compactResearchEvidenceComplete(state)
    ? 'The evidence floor is already satisfied; emit <next_step/> only if this phase is complete.'
    : 'The evidence floor is not satisfied yet.'
  const recoveryToolNote = shouldUseCompactResearchRecoveryTools(state)
    ? 'Recovery mode is active: choose one focused evidence tool from the narrowed source menu. Use web_search for a specific missing angle, or read_document when candidate URLs already exist. Do not ask for another broad planning turn.'
    : 'Choose the most useful source/search/browser/document action for this specific step; use strict JSON object arguments.'
  return [
    'RESEARCH TOOL REQUIRED:',
    `Continue "${step}" with exactly one appropriate evidence tool call now.`,
    `Reason: ${reason}.`,
    evidenceNeed,
    recoveryToolNote,
    'Do not write a prose-only update, do not answer from memory, and do not advance until this phase has enough evidence.',
  ].join(' ')
}

function compactToolFailureDiagnostics(results: ToolExecutionResult[]): Array<{
  tool: string
  error: string
  durationMs?: number
}> {
  return results
    .filter(result => result.isError)
    .slice(-4)
    .map(result => {
      const value = result.result && typeof result.result === 'object'
        ? (result.result as { error?: unknown }).error
        : undefined
      const error = typeof value === 'string'
        ? value.replace(/\s+/g, ' ').slice(0, 220)
        : 'unknown tool error'
      return {
        tool: result.tc.name,
        error,
        durationMs: result.durationMs,
      }
    })
}

function isDisplayContractRepairResult(result: ToolExecutionResult): boolean {
  const value = result.result && typeof result.result === 'object'
    ? (result.result as { error?: unknown }).error
    : undefined
  return typeof value === 'string' &&
    /display contract repair needed before executing this action/i.test(value)
}

function displayContractRepairInstruction(state: AgentStateData, results: ToolExecutionResult[]): string {
  const latest = [...results].reverse().find(isDisplayContractRepairResult) || results[results.length - 1]
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the active step'
  let safeArgs: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(latest.tc.arguments) as Record<string, unknown>
    const keepKeys = ['query', 'url', 'source', 'path', 'output_path', 'source_path', 'directory', 'text', 'index', 'selector', 'method']
    safeArgs = Object.fromEntries(
      keepKeys
        .filter(key => parsed[key] !== undefined)
        .map(key => [key, parsed[key]]),
    )
  } catch {
    safeArgs = {}
  }
  const argHint = Object.keys(safeArgs).length > 0
    ? `Keep these non-display arguments unchanged: ${JSON.stringify(safeArgs).slice(0, 900)}.`
    : 'Keep the same non-display arguments from the rejected tool call.'

  return [
    'ACTION LABEL REPAIR:',
    `Retry the same ${latest.tc.name} action now for "${step}".`,
    argHint,
    `Set plan_step_index to ${state.currentStepIdx + 1}.`,
    'Replace only action_label with a fresh model-authored purpose label, 2-12 words, starts with a capital letter, does not end with a period, no first person, no tool names, no raw URL/path, and no past-tense summary.',
    'Make the native tool call now with no prose.',
  ].join(' ')
}

const FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS = 2_800
const FINAL_INLINE_ANSWER_ITERATION_TIMEOUT_MS = 5_000
const FINAL_INLINE_ANSWER_INACTIVITY_TIMEOUT_MS = 650
const FINAL_INLINE_ANSWER_CONTENT_ONLY_TIMEOUT_MS = 1_200
const FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS = 420
const FINAL_INLINE_ANSWER_MAX_TOKENS = 1_200
const FINAL_INLINE_REPORT_MAX_TOKENS = 3_000
const FINAL_SAVED_DELIVERABLE_REQUEST_TIMEOUT_MS = 2_200
const FINAL_SAVED_DELIVERABLE_INITIAL_REQUEST_TIMEOUT_MS = 3_200
const FINAL_SAVED_DELIVERABLE_ITERATION_TIMEOUT_MS = 9_000
const FINAL_SAVED_DELIVERABLE_INACTIVITY_TIMEOUT_MS = 900
const FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_TIMEOUT_MS = 900
const FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_MIN_CHARS = 220
const FINAL_SAVED_DELIVERABLE_TEXT_REQUEST_TIMEOUT_MS = 6_500
const FINAL_SAVED_DELIVERABLE_TEXT_ITERATION_TIMEOUT_MS = 24_000
const FINAL_SAVED_DELIVERABLE_TEXT_INACTIVITY_TIMEOUT_MS = 6_000
const FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_TIMEOUT_MS = 14_000
const FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_MIN_CHARS = 1_000
const FINAL_SAVED_DELIVERABLE_TEXT_MAX_TOKENS = 1_800
const FINAL_SAVED_DELIVERABLE_INITIAL_MAX_TOKENS = 520
const FINAL_SAVED_DELIVERABLE_MAX_TOKENS = 1_200
const FORCED_NARRATION_REQUEST_TIMEOUT_MS = 2_000
const FORCED_NARRATION_ITERATION_TIMEOUT_MS = 2_800
const FORCED_NARRATION_INACTIVITY_TIMEOUT_MS = 650
const FORCED_NARRATION_CONTENT_ONLY_TIMEOUT_MS = 650
const FORCED_NARRATION_MAX_TOKENS = 48
const CREDIT_PREFLIGHT_CACHE_MS = 60_000

export class AgentLoop {
  private emitter: AgentEventEmitter
  private options: AgentLoopOptions
  private lastCreditRunwayCheckAt = Date.now()

  constructor(emitter: AgentEventEmitter, options: AgentLoopOptions) {
    this.emitter = emitter
    this.options = options
  }

  private emitAgentIdentityDisclosureAnswer(): void {
    if (this.emitter.isClosed) return
    this.emitter.textDelta(AGENT_IDENTITY_DISCLOSURE_RESPONSE)
    this.emitter.done()
    this.emitter.close()
  }

  private async assertServerCreditRunwayCached(): Promise<void> {
    if (!this.options.userId) return
    const now = Date.now()
    if (now - this.lastCreditRunwayCheckAt < CREDIT_PREFLIGHT_CACHE_MS) return
    await assertServerCreditsAvailable(this.options.userId)
    this.lastCreditRunwayCheckAt = now
  }

  private async recoverTextOnlyDraft(
    state: AgentStateData,
    assistantContent: string,
    contextManager: ContextManager,
    planManager: PlanManager,
    workingMemory: WorkingMemory,
    goalTracker: GoalTracker,
    outputVerifier: OutputVerifier,
  ): Promise<Phase | null> {
    const { conversationId } = this.options
    if (!conversationId || !shouldAutosaveTextOnlyDraft(state, assistantContent, this.options.messages)) return null

    const content = cleanDraftContent(assistantContent)
    const path = autosaveDraftPath(state)
    const id = `autosave_${state.iterations}_${state.currentStepIdx}`
    const isLastStep = !!state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1

    const previewContent = content.length > 5000
      ? content.slice(0, 5000) + '\n\n...[autosaved draft continues in the saved file]'
      : content
    this.emitter.toolStart(id, 'create_file', { path, content: previewContent })
    if (isLastStep) {
      this.emitter.artifactCreated({
        id: `artifact_${id}`,
        fileName: path.split('/').pop() || path,
        filePath: path,
        content: content.length > 20_000
          ? content.slice(0, 20_000) + '\n\n---\n*Content truncated for preview. Open the file for the full saved draft.*'
          : content,
        type: 'document',
        deliverable: true,
        createdAt: Date.now(),
      })
    }

    const savePromise = createFileInSandbox(conversationId, path, content)
    const result = await Promise.race([
      savePromise,
      this.wait(TEXT_ONLY_DRAFT_SAVE_VISIBLE_WAIT_MS).then(() => null),
    ])

    if (!result) {
      this.emitter.toolResult(id, 'create_file', {
        action: 'created',
        path,
        content: previewContent,
        size: content.length,
      } as never)
      void savePromise
        .then(saveResult => {
          console.log('[AgentDiagnostics] Text-only draft save completed after visible artifact', {
            path,
            size: saveResult.size,
            hasError: saveResult.size === undefined,
          })
        })
        .catch(err => {
          console.warn('[AgentDiagnostics] Text-only draft save finished after completion with error', {
            path,
            error: err instanceof Error ? err.message : String(err),
          })
        })
    } else {
      this.emitter.toolResult(id, 'create_file', result as never)
    }

    if (result && result.size === undefined) {
      contextManager.push({
        role: 'system',
        content: `The draft text was not saved because create_file failed for ${path}. Retry with a shorter create_file call or a safer path.`,
      } as ChatMessageParam)
      return null
    }

    state.createdFiles.add(path)
    trackFileCreate(state, path)
    recordWorkLedgerDeliverable(state, { path, purpose: isLastStep ? 'deliverable' : 'support' })
    logWork(state, `Autosaved text-only draft: ${path}`)
    workingMemory.recordFileCreated(path, state.currentStepIdx)

    contextManager.push({
      role: 'system',
      content: `RECOVERY SAVE: Your previous text-only draft was saved to ${path}. Do NOT rewrite it from scratch. Continue from this saved file; use append_file for additional chunks and edit_file only for targeted revisions.`,
    } as ChatMessageParam)

    if (isLastStep && state.currentPlanItems) {
      if (
        shouldContinueSavedFinalDeliverableChunk(
          state,
          this.options.messages,
          path,
          content,
        )
      ) {
        const lines = content.split(/\r?\n/).filter(Boolean).length
        state.deliverableRevisionCount++
        state.partialFileWriteRecoveryPending = {
          path,
          toolName: 'append_file',
          chars: content.length,
          lines,
        }
        state.partialFileWriteRecoveryNudged = false
        state.deliverableVerificationDone = false
        contextManager.push({
          role: 'system',
          content: `SAVED DELIVERABLE CONTINUATION REQUIRED: "${path}" has started successfully but is not complete enough for the requested saved output yet. Next response must be exactly one native append_file call to the same path with the next useful section. Do not recreate the file, do not write visible prose, and do not emit <next_step/> yet.`,
        } as ChatMessageParam)
        return 'STREAMING'
      }

      const originalRequest = this.options.messages[this.options.messages.length - 1]?.content || state.originalUserRequest || ''
      const verification = outputVerifier.verify(
        content,
        path,
        originalRequest,
        state.taskStrategy,
        workingMemory,
        state.taskComplexity,
      )
      if (!verification.passed && state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS) {
        state.deliverableRevisionCount++
        state.pendingDeliverableRevision = {
          path,
          failures: verification.failures,
          suggestions: verification.suggestions,
          createdAt: Date.now(),
        }
        state.deliverableVerificationDone = false
        contextManager.push({
          role: 'system',
          content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${verification.failures.join('; ')}. Your next response must be exactly one native append_file or edit_file tool call against "${path}". Do NOT write status text, do NOT create a new file, and do NOT repeat that the report was created.${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
        } as ChatMessageParam)
        return 'STREAMING'
      }

      if (!verification.passed) {
        state.pendingDeliverableRevision = {
          path,
          failures: verification.failures,
          suggestions: verification.suggestions,
          createdAt: Date.now(),
        }
        state.deliverableVerificationDone = false
        return 'COMPLETE'
      }

      const stepIdxBefore = state.currentStepIdx
      state.deliverableVerificationDone = true
      state.currentStepIdx = state.currentPlanItems.length
      for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
        this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
      }
      return 'COMPLETE'
    }

    const stepIdxBefore = state.currentStepIdx
    const advanceMsg = planManager.handleStepAdvance(state)
    if (advanceMsg) {
      contextManager.push(advanceMsg as ChatMessageParam)
    }
    if (goalTracker.isInitialized()) {
      goalTracker.advanceToStep(state.currentStepIdx)
    }
    for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
      this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
    }
    return 'STREAMING'
  }

  private maybeStartDeadlineFinalization(
    state: AgentStateData,
    contextManager: ContextManager,
  ): boolean {
    if (!shouldStartDeadlineFinalization(state)) return false

    state.deadlineFinalizationStarted = true
    state.forceTextNextIteration = false
    state.forcedNarrationRepairAttempts = 0
    contextManager.push(deadlineFinalizationMessage(state))
    console.log('[AgentDiagnostics] Runtime deadline finalization started', {
      iteration: state.iterations,
      step: state.currentStepIdx,
      totalSteps: state.currentPlanItems?.length || 0,
      remainingMs: agentRunRemainingMs(state),
      elapsedMs: Date.now() - state.runStartedAtMs,
    })
    return true
  }

  private maybeStartIterationBudgetFinalization(
    state: AgentStateData,
    contextManager: ContextManager,
    goalTracker: GoalTracker,
  ): boolean {
    if (!shouldStartIterationBudgetFinalization(state, this.options.messages)) return false
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false

    const stepIdxBefore = state.currentStepIdx
    const finalStepIdx = state.currentPlanItems.length - 1
    const overrunStep = state.currentPlanItems[stepIdxBefore] || 'the current phase'
    const finalizationTurns = iterationBudgetFinalizationTriggerTurns(state, this.options.messages)
    while (state.currentStepIdx < finalStepIdx) {
      const currentStep = state.currentPlanItems[state.currentStepIdx] || 'phase'
      const finding = state.currentStepIdx === stepIdxBefore
        ? `Reserved final output budget after working on ${currentStep}`
        : `Folded ${currentStep} into the final output from available evidence`
      advanceStep(state, finding)
    }

    state.deadlineFinalizationStarted = true
    state.forceTextNextIteration = false
    state.phaseEndNarrationPending = false
    state.forcedNarrationRepairAttempts = 0
    state.consecutiveNoToolCalls = 0
    state.dynamicIterationLimit = Math.min(
      MAX_ITERATIONS,
      Math.max(state.dynamicIterationLimit, state.iterations + finalizationTurns),
    )
    contextManager.push(iterationBudgetFinalizationMessage(state, overrunStep))
    if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
    for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
      this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
    }
    console.log('[AgentDiagnostics] Iteration budget finalization started', {
      iteration: state.iterations,
      limit: state.dynamicIterationLimit,
      finalizationTurns,
      fromStep: stepIdxBefore,
      finalStep: state.currentStepIdx,
      totalSteps: state.currentPlanItems.length,
    })
    return true
  }

  async run(): Promise<void> {
    const { messages, model, conversationId, customInstructions, signal } = this.options

    // ── Security: Prompt Injection Check ───────────────────────────────

    const latestUserMessage = [...messages].reverse().find(m => m.role === 'user')
    if (latestUserAskedAgentIdentityDisclosure(messages)) {
      this.emitAgentIdentityDisclosureAnswer()
      return
    }

    const injectionDetected = latestUserMessage ? isPromptInjection(latestUserMessage.content || '') : false
    if (injectionDetected) {
      this.emitter.textDelta("I can't reveal or override internal instructions. Send the task normally and I'll work on it.")
      this.emitter.done()
      this.emitter.close()
      return
    }

    // ── Initialize Components ─────────────────────────────────────────

    const log = createAgentLogger()

    const scopedMessages = scopedMessagesForAgentTask(messages)
    const strategy = resolveStrategy(scopedMessages)
    const complexity = estimateTaskComplexity(scopedMessages)
    const iterationLimit = computeIterationLimit(complexity)
    const timeouts = computeTimeouts(strategy)

    log.info(`Strategy: ${strategy.type}, complexity: ${complexity}/3, temp: ${strategy.temperature}, limit: ${iterationLimit}`)

    const isBuild = strategy.type === 'build' || strategy.type === 'code'
    const state = createInitialState(isBuild, timeouts)
    state.runMaxDurationMs = this.options.runMaxDurationMs ?? AGENT_RUN_MAX_DURATION_MS
    state.deadlineFinalizationBufferMs = this.options.deadlineFinalizationBufferMs ?? AGENT_DEADLINE_FINALIZATION_BUFFER_MS
    state.deadlineModelTurnTimeoutMs = this.options.deadlineModelTurnTimeoutMs ?? AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS
    state.deadlineHardStopBufferMs = this.options.deadlineHardStopBufferMs ?? AGENT_DEADLINE_HARD_STOP_BUFFER_MS
    state.taskComplexity = complexity
    state.taskStrategy = strategy.type
    state.strategyConfig = strategy
    state.dynamicIterationLimit = iterationLimit
    state.originalUserRequest = effectiveTaskRequest(messages) || null
    state.uploadedAttachmentNames = uploadedAttachmentNames(scopedMessages)
    state.uploadedAttachmentContextAvailable = state.uploadedAttachmentNames.length > 0
    state.uploadedImageAttachmentAvailable = ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments(scopedMessages).length > 0
    state.uploadedAttachmentContentAvailable = readableUploadedAttachments(scopedMessages).length > 0 ||
      state.uploadedImageAttachmentAvailable
    // Detect a URL/domain in the scoped task request so web_search attempts can
    // be silently rerouted to direct navigation before another paid model turn.
    state.userProvidedUrl = extractUserProvidedUrl(scopedMessages)
    if (state.userProvidedUrl) log.info(`User provided URL detected: ${state.userProvidedUrl}`)
    const shouldHydrateResearchActivity = !!this.options.userId &&
      !!conversationId &&
      this.options.startFreshSandbox !== true
    if (shouldHydrateResearchActivity && this.options.userId && conversationId) {
      try {
        const entries = await loadResearchActivityEntries(this.options.userId, conversationId)
        hydrateResearchActivityIndex(state.researchActivity, entries)
      } catch (error) {
        log.warn('Failed to hydrate hidden research activity log', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const processedMessages = this.preprocessMessages(scopedMessages)
    const planningMessages = buildPlanningMessages(scopedMessages)
    const requiredFirstSteps = [
      ...requiredAttachmentPlanSteps(scopedMessages),
      ...requiredSkillPlanSteps(scopedMessages),
    ]

    const contextManager = new ContextManager()
    const strategyHints: StrategyHints = {
      type: strategy.type,
      toolPriority: strategy.toolPriority,
      stepGuidance: strategy.stepGuidance,
      temperature: strategy.temperature,
    }
    const systemPrompt = { role: 'system', content: getSystemPrompt(customInstructions, strategyHints) } as ChatMessageParam
    contextManager.initialize(
      systemPrompt,
      processedMessages as ChatMessageParam[]
    )
    if (scopedMessages.some(m => m.role === 'assistant' && containsFalseCapabilityRefusal(m.content))) {
      contextManager.push({
        role: 'system',
        content: `CAPABILITY CORRECTION: Ignore any earlier assistant message claiming it cannot browse, search, retrieve real images, or perform live image searches. That was false. You are the tool-using agent. For the user's latest request, make exactly one relevant tool call instead of refusing. If the latest request is asking for a real image or "real one", use image_search.`,
      } as ChatMessageParam, 9)
    }
    if (isContextualTaskUpdate(scopedMessages)) {
      contextManager.push({
        role: 'system',
        content: `INTERRUPTION UPDATE: The latest user message is a correction to the previous task, not a standalone question. Continue the prior task using the current browser/session state and apply this correction as a hard constraint. Do not answer from memory or refuse because an earlier assistant message was interrupted.`,
      } as ChatMessageParam, 9)
    }

    const toolRegistry = new ToolRegistry()
    toolRegistry.registerFromDefinitions(toolDefinitions as unknown[])

    const toolCache = new ToolCache({
      logger: log.child('Cache'),
      maxEntries: TOOL_CACHE_MAX_ENTRIES,
      ttlMs: TOOL_CACHE_TTL_MS,
      maxTotalSizeChars: TOOL_CACHE_MAX_SIZE_CHARS,
    })
    const toolRetry = new ToolRetry(log.child('Retry'))
    const errorRecovery = new ErrorRecoveryEngine()
    const streamProcessor = new StreamProcessor(this.emitter, timeouts)
    const workingMemory = new WorkingMemory()
    state.workingMemory = workingMemory
    const browserFrameStream = {
      unsubscribe: null as (() => void) | null,
      lastFrameAt: 0,
    }
    const ensureBrowserFrameStream = () => {
      if (!conversationId || browserFrameStream.unsubscribe) return
      browserFrameStream.unsubscribe = subscribeToBrowserFrames(conversationId, (frame) => {
        const now = Date.now()
        if (now - browserFrameStream.lastFrameAt < 200) return
        browserFrameStream.lastFrameAt = now
        this.emitter.browserFrame(frame)
      })
    }
    const toolPipeline = new ToolPipeline(this.emitter, conversationId, {
      cache: toolCache,
      retry: toolRetry,
      memory: workingMemory,
      logger: log.child('Tools'),
      recovery: errorRecovery,
      signal,
      creditRunId: this.options.creditRunId,
      userId: this.options.userId,
      ensureBrowserFrameStream,
    })
    const policyEngine = new PolicyEngine()
    const reflectionEngine = new ReflectionEngine()
    const goalTracker = new GoalTracker()
    state.goalTracker = goalTracker
    const outputVerifier = new OutputVerifier()
    const recordPlannerUsage = async (usage: CreditTokenUsage, chargeId: string) => {
      if (!this.options.userId || !this.options.conversationId || !this.options.creditRunId) return
      const recorded = await chargeServerTokenUsage(
        this.options.userId,
        this.options.conversationId,
        this.options.creditRunId,
        usage,
        chargeId,
      )
      if (recorded?.created) this.emitter.creditEvent(recorded.entry)
    }
    const assertPlannerCreditRunway = async () => this.assertServerCreditRunwayCached()
    const planManager = new PlanManager(this.emitter, planningMessages, complexity, requiredFirstSteps, customInstructions, recordPlannerUsage, assertPlannerCreditRunway, this.options.skipStartupAcknowledgement === true)

    planManager.setStateRef(state)
    const startupPlanUsed = this.options.startupPlan?.items?.length
      ? planManager.usePrecomputedPlan(state, this.options.startupPlan)
      : false
    if (!startupPlanUsed) planManager.startPlanCall()

    // ── Mutable iteration state ───────────────────────────────────────

    let lastStreamResult: StreamResult | null = null
    let lastStreamWasCompactNarration = false
    let lastToolResults: ToolExecutionResult[] = []
    let cumulativeInputTokens = 0
    let cumulativeOutputTokens = 0
    let cumulativeCost = 0
    let terminalReason = 'unknown'

    // ── Main Loop ─────────────────────────────────────────────────────

    let phase = 'PLANNING' as Phase
    let startupReadyAwaited = false

    try {
      while (true) {
        if (phase === 'ERROR') break
        while (phase !== 'COMPLETE' && phase !== 'ERROR') {
          if (signal?.aborted) { phase = 'ERROR'; break }
          if (agentRunRemainingMs(state) <= (state.deadlineHardStopBufferMs || AGENT_DEADLINE_HARD_STOP_BUFFER_MS)) {
            terminalReason = state.deadlineFinalizationStarted
              ? 'runtime_deadline_finalized'
              : 'runtime_deadline'
            phase = 'COMPLETE'
            break
          }
          if (this.maybeStartIterationBudgetFinalization(state, contextManager, goalTracker)) {
            phase = 'STREAMING'
            continue
          }
          if (state.iterations >= state.dynamicIterationLimit) {
            log.info(`Iteration cap reached: ${state.iterations}/${state.dynamicIterationLimit}`)
            terminalReason = 'iteration_cap'
            phase = 'COMPLETE'
            break
          }

          switch (phase) {
          // ── PLANNING ──────────────────────────────────────────────
          case 'PLANNING': {
            await planManager.awaitPlan(state)

            if (state.taskComplexity !== complexity) {
              const newLimit = computeIterationLimit(state.taskComplexity)
              state.dynamicIterationLimit = newLimit
              log.info(`Complexity upgraded: ${complexity} → ${state.taskComplexity}, limit → ${newLimit}`)
            }

            const planInjection = planManager.getStepInjection(state, state.dynamicIterationLimit)
            if (planInjection) {
              contextManager.push(planInjection as ChatMessageParam)
            }
            const preloadedStepMessages = planManager.completePreloadedFirstSteps(state)
            for (const msg of preloadedStepMessages) {
              contextManager.push(msg as ChatMessageParam)
            }
            // Budgets are calculated by PlanManager.getStepInjection() using the
            // RESEARCH_STEP_BUDGET_MULTIPLIER and complexity multiplier — single source of truth.

            // Initialize goal tracking from the plan
            if (state.currentPlanItems && !goalTracker.isInitialized()) {
              goalTracker.initializeFromPlan(state.currentPlanItems)
            }

            phase = 'STREAMING'
            break
          }

          // ── STREAMING ─────────────────────────────────────────────
          case 'STREAMING': {
            state.iterations++

            // Rate limit delay
            const elapsed = Date.now() - state.lastIterationEnd
            if (elapsed < state.iterationDelayMs && state.iterations > 1) {
              await this.wait(state.iterationDelayMs - elapsed)
              if (signal?.aborted) { phase = 'ERROR'; break }
            }
            if (state.iterationDelayMs > MIN_ITERATION_DELAY_MS) {
              state.iterationDelayMs = Math.max(MIN_ITERATION_DELAY_MS, state.iterationDelayMs - 500)
            }

            const streamingDirectiveStatus = this.injectLiveDirectives(contextManager)
            if (streamingDirectiveStatus === 'identity') return
            if (streamingDirectiveStatus) {
              log.info('Injected live user directive before model turn')
            }

            this.maybeStartDeadlineFinalization(state, contextManager)

            // Context trimming
            contextManager.compactForModelCall(state)
            contextManager.trimIfNeeded(state)

            const response = await this.callLLMWithRetry(
              model, contextManager.getMessages(), state, strategy, toolRegistry
            )
            if (signal?.aborted) { phase = 'ERROR'; break }

            if (!response) {
              if (state.pendingToolJsonRecovery) {
                state.pendingToolJsonRecovery = false
                state.lastModelErrorForUser = null
                state.consecutiveNullStreams = 0
                const recoveringFinalSavedDeliverable = finalSavedDeliverableTurn(state, this.options.messages)
                state.forceTextNextIteration = !recoveringFinalSavedDeliverable && state.taskStrategy !== 'browse'
                contextManager.push({
                  role: 'system',
                  content: toolJsonRecoveryMessage(state, this.options.messages),
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                break // stay in STREAMING after an internal recovery nudge
              }

              const wasForcedNarrationRecovery = state.forceTextNextIteration
              const wasCompactCadenceNarration = !wasForcedNarrationRecovery &&
                shouldUseNaturalCadenceNarration(state, this.options.messages)
              state.consecutiveNullStreams = (state.consecutiveNullStreams || 0) + 1
              console.error('[AgentDiagnostics] Stream unavailable after model call', {
                attempt: state.consecutiveNullStreams,
                iteration: state.iterations,
                phase: state.currentPhase,
                step: state.currentStepIdx,
                totalSteps: state.currentPlanItems?.length || 0,
                strategy: state.taskStrategy,
                signalAborted: !!signal?.aborted,
                pendingToolJsonRecovery: !!state.pendingToolJsonRecovery,
                hasLastModelError: !!state.lastModelErrorForUser,
                forcedNarrationRecovery: wasForcedNarrationRecovery,
                compactCadenceNarration: wasCompactCadenceNarration,
              })
              log.info(`Agent returned no stream (attempt ${state.consecutiveNullStreams}/1)`)
              if (state.lastModelErrorForUser) {
                this.emitter.error(state.lastModelErrorForUser)
                phase = 'ERROR'
                break
              }
              if (wasForcedNarrationRecovery || wasCompactCadenceNarration) {
                if (state.phaseEndNarrationPending) {
                  markPhaseNarrationEmitted(state)
                  state.phaseEndNarrationPending = false
                }
                state.forceTextNextIteration = false
                state.forcedNarrationRepairAttempts = 0
                state.visibleToolActionsSinceLastNarration = Math.min(NARRATION_THRESHOLD_DEFAULT - 1, state.visibleToolActionsSinceLastNarration)
                state.consecutiveNullStreams = 0
                contextManager.push({
                  role: 'system',
                  content: 'The progress narration window timed out before streaming. Continue the active phase with one concrete action now; the narration window should open again after the next visible action.',
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Released narration timeout back to active work', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  visibleToolActionsSinceLastNarration: state.visibleToolActionsSinceLastNarration,
                  phaseEndNarrationPending: state.phaseEndNarrationPending,
                })
                phase = 'STREAMING'
                break
              }
              if (
                shouldUseCompactResearchTurn(state) &&
                state.currentPlanItems &&
                state.currentStepIdx < state.currentPlanItems.length - 1
              ) {
                if (compactResearchEvidenceComplete(state)) {
                  const stepBeforeAdvance = state.currentStepIdx
                  const advanceMsg = planManager.handleStepAdvance(state)
                  if (state.currentStepIdx > stepBeforeAdvance) {
                    contextManager.compactForStepTransition(state)
                  }
                  if (advanceMsg) {
                    contextManager.push(advanceMsg as ChatMessageParam)
                  }
                  if (goalTracker.isInitialized()) {
                    goalTracker.advanceToStep(state.currentStepIdx)
                  }
                  for (let i = stepBeforeAdvance; i < state.currentStepIdx; i++) {
                    this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                  }
                  state.forceTextNextIteration = false
                  state.consecutiveNullStreams = 0
                  state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                  state.lastIterationEnd = Date.now()
                  console.log('[AgentDiagnostics] Model-start timeout advanced compact research phase from gathered evidence', {
                    step: state.currentStepIdx,
                    totalSteps: state.currentPlanItems.length,
                    researchCalls: state.stepResearchCallCount,
                    sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                  })
                  phase = 'STREAMING'
                  break
                }

                if (state.consecutiveNullStreams >= 2) {
                  state.consecutiveNullStreams = 0
                  state.consecutiveNoToolCalls = Math.max(state.consecutiveNoToolCalls, 1)
                }
                contextManager.push({
                  role: 'system',
                  content: compactResearchToolRequiredMessage(state, 'the previous model turn timed out before starting a tool action'),
                } as ChatMessageParam)
                state.forceTextNextIteration = false
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Model-start timeout reissued model-selected research tool requirement', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems.length,
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                })
                phase = 'STREAMING'
                break
              }
              if (finalSavedDeliverableTurn(state, this.options.messages)) {
                state.forceTextNextIteration = false
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                contextManager.push({
                  role: 'system',
                  content: finalSavedDeliverableToolCallInstruction(
                    state,
                    'FINAL SAVED DELIVERABLE START CHECK: the previous model call did not start streaming quickly enough.',
                  ),
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Reissued final saved deliverable file-tool instruction after model-start timeout', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  hasFinalDeliverable: hasSavedFinalDeliverableCandidate(state),
                })
                phase = 'STREAMING'
                break
              }
              if (!wasForcedNarrationRecovery && state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
                state.forceTextNextIteration = true
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                contextManager.push({
                  role: 'system',
                  content: 'MODEL START RECOVERY: The previous full model turn timed out before streaming. Do not retry the same heavy context. Use the compact forced-narration path next so the UI gets a concrete progress update quickly, then continue from the active phase.',
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                console.log('[Agent] Switching to compact progress recovery after empty stream')
                break
              }
              this.emitter.error('Agent could not start the next action quickly enough. Please retry the task.')
              phase = 'ERROR'
              break
            }
            state.consecutiveNullStreams = 0

            // Process stream
            let processedCompactNarrationTurn = false
            try {
              lastStreamWasCompactNarration = false
              processedCompactNarrationTurn =
                (state.forceTextNextIteration && !state.exactExtractionGuardPending) ||
                (!state.forceTextNextIteration && shouldUseNaturalCadenceNarration(state, this.options.messages))
              lastStreamWasCompactNarration = processedCompactNarrationTurn
              streamProcessor.setTierTimeouts(tierTimeoutsForIteration(state, this.options.messages, processedCompactNarrationTurn))
              lastStreamResult = await streamProcessor.processStream(
                response,
                state,
              )
            } catch (streamError) {
              log.info(`Stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
              phase = this.handleStreamError(streamError, state, contextManager, state.buildTask)
              break
            }

            if (lastStreamResult.leakageDetected) {
              terminalReason = 'safety_leakage'
              phase = 'COMPLETE'
              break
            }

            // Log costs. Provider usage metadata can arrive late or be unavailable
            // for some routed generations, so estimate instead of interrupting work.
            const u = lastStreamResult.usage ?? approximateStreamUsageForCompletedTurn(
              model,
              contextManager.getMessages(),
              lastStreamResult,
            )
            if (!lastStreamResult.usage) {
              console.warn('[AgentDiagnostics] Missing model usage metadata; continuing with estimated usage', {
                iteration: state.iterations,
                phase: state.currentPhase,
                step: state.currentStepIdx,
                promptTokens: u.promptTokens,
                completionTokens: u.completionTokens,
                cost: u.cost,
              })
            }
            cumulativeInputTokens += u.promptTokens
            cumulativeOutputTokens += u.completionTokens
            cumulativeCost += u.cost
            console.log(`[COST] iter=${state.iterations} in=${u.promptTokens} out=${u.completionTokens} cost=$${u.cost.toFixed(6)} totalCost=$${cumulativeCost.toFixed(6)}`)
            if (this.options.userId && this.options.conversationId && this.options.creditRunId) {
              const recorded = await chargeServerTokenUsage(
                this.options.userId,
                this.options.conversationId,
                this.options.creditRunId,
                u,
                `tokens:${state.iterations}`,
              )
              if (recorded?.created) this.emitter.creditEvent(recorded.entry)
            }

            updatePhase(state)

            if (
              processedCompactNarrationTurn &&
              !state.phaseEndNarrationPending &&
              lastStreamResult.toolCalls.size === 0 &&
              lastStreamResult.assistantContent.trim()
            ) {
              markPhaseNarrationEmitted(state)
              state.forceTextNextIteration = false
              state.forcedNarrationRepairAttempts = 0
              state.visibleToolActionsSinceLastNarration = 0
              state.consecutiveNoToolCalls = 0
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              shouldCompleteFinalInlineAnswerTurn(state, this.options.messages, lastStreamResult.assistantContent)
            ) {
              const stepBeforeComplete = state.currentStepIdx
              contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              if (state.currentPlanItems) {
                state.currentStepIdx = state.currentPlanItems.length
              }
              state.forceTextNextIteration = false
              state.phaseEndNarrationPending = false
              state.lastIterationEnd = Date.now()
              terminalReason = 'final_inline_answer_complete'
              for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              console.log('[AgentDiagnostics] Final inline answer accepted without another policy retry', {
                iteration: state.iterations,
                chars: lastStreamResult.assistantContent.trim().length,
                step: stepBeforeComplete,
                totalSteps: state.currentPlanItems?.length || 0,
              })
              phase = 'COMPLETE'
              break
            }

            // Check plan on early iterations
            if (state.iterations <= 2) {
              await planManager.awaitPlan(state)
              const planInjection = planManager.getStepInjection(state, state.dynamicIterationLimit)
              if (planInjection) {
                contextManager.push(planInjection as ChatMessageParam)
              }
            }

            if (
              !lastStreamWasCompactNarration &&
              lastStreamResult.toolCalls.size === 0 &&
              shouldUseCompactResearchTurn(state) &&
              state.currentPlanItems &&
              state.currentStepIdx < state.currentPlanItems.length - 1
            ) {
              if (compactResearchEvidenceComplete(state)) {
                const stepBeforeAdvance = state.currentStepIdx
                if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                  contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                }
                const advanceMsg = planManager.handleStepAdvance(state)
                if (state.currentStepIdx > stepBeforeAdvance) {
                  contextManager.compactForStepTransition(state)
                }
                if (advanceMsg) {
                  contextManager.push(advanceMsg as ChatMessageParam)
                }
                if (goalTracker.isInitialized()) {
                  goalTracker.advanceToStep(state.currentStepIdx)
                }
                for (let i = stepBeforeAdvance; i < state.currentStepIdx; i++) {
                  this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                }
                console.log('[AgentDiagnostics] Compact research evidence complete; advanced immediately after text-only turn', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems.length,
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                })
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }

              if (compactResearchNeedsToolAction(state)) {
                if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                  contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                }
                state.consecutiveNoToolCalls += 1
                state.forceTextNextIteration = false
                if (state.consecutiveNoToolCalls >= 2) {
                  state.suppressedResearchToolName = null
                  state.stepLoopDetections = 0
                  state.recentToolCalls = []
                }
                contextManager.push({
                  role: 'system',
                  content: compactResearchToolRequiredMessage(
                    state,
                    state.consecutiveNoToolCalls >= 2
                      ? 'the compact research turn repeated without a tool call, so reopened source tools and cleared the loop state'
                      : 'the previous research response did not include the required evidence tool call',
                  ),
                } as ChatMessageParam)
                console.log('[AgentDiagnostics] Compact research no-tool response reissued model-selected tool requirement', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems.length,
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                  reopenedTools: state.consecutiveNoToolCalls >= 2,
                })
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }
            }

            phase = lastStreamResult.toolCalls.size > 0 ? 'EXECUTING_TOOLS' : 'EVALUATING'
            break
          }

          // ── EXECUTING_TOOLS ───────────────────────────────────────
          case 'EXECUTING_TOOLS': {
            if (!lastStreamResult) { phase = 'ERROR'; break }

            const stepIdxBeforeExec = state.currentStepIdx

            const preToolDirectiveStatus = this.injectLiveDirectives(contextManager)
            if (preToolDirectiveStatus === 'identity') return
            if (preToolDirectiveStatus) {
              log.info('Live user directive superseded pending tool calls')
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (!startupReadyAwaited && this.options.startupReadyPromise && toolCallsNeedStartupReady(lastStreamResult.toolCalls)) {
              startupReadyAwaited = true
              const waitStartedAt = Date.now()
              try {
                await this.options.startupReadyPromise
                console.log('[AgentDiagnostics] Tool startup prerequisites ready', {
                  elapsedMs: Date.now() - waitStartedAt,
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                })
              } catch (error) {
                console.error('[AgentDiagnostics] Tool startup prerequisites failed', {
                  elapsedMs: Date.now() - waitStartedAt,
                  error: error instanceof Error ? error.message : String(error),
                })
                this.emitter.error(userErrorMessage(error, 'Task setup failed before tools could run. Please try again.'))
                phase = 'ERROR'
                break
              }
              if (signal?.aborted) { phase = 'ERROR'; break }
            }

            // Execute tools
            const previousFactCount = workingMemory.size().facts
            lastToolResults = await toolPipeline.executeAll(
              lastStreamResult.toolCalls,
              state,
              lastStreamResult.assistantContent,
            )
            if (signal?.aborted) { phase = 'ERROR'; break }

            if (lastToolResults.length > 0 && lastToolResults.every(isDisplayContractRepairResult)) {
              if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              }
              state.consecutiveNoToolCalls = 0
              state.forceTextNextIteration = false
              state.recentToolCalls = []
              state.recentToolSequence = []
              contextManager.push({
                role: 'system',
                content: displayContractRepairInstruction(state, lastToolResults),
              } as ChatMessageParam)
              console.log('[AgentDiagnostics] Reissued model-selected tool after display contract repair', {
                step: state.currentStepIdx,
                totalSteps: state.currentPlanItems?.length || 0,
                attempts: state.displayContractRepairAttempts,
                tool: lastToolResults[0]?.tc.name,
              })
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (
              (lastToolResults.length === 0 || state.stepResearchCallCount === 0) &&
              shouldUseCompactResearchTurn(state) &&
              state.currentPlanItems &&
              state.currentStepIdx < state.currentPlanItems.length - 1 &&
              compactResearchNeedsToolAction(state)
            ) {
              if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              }
              state.consecutiveNoToolCalls += 1
              contextManager.push({
                role: 'system',
                content: compactResearchToolRequiredMessage(state, 'the previous tool turn did not produce usable research evidence'),
              } as ChatMessageParam)
              console.log('[AgentDiagnostics] Empty compact research tool turn reissued model-selected tool requirement', {
                step: state.currentStepIdx,
                totalSteps: state.currentPlanItems.length,
                researchCalls: state.stepResearchCallCount,
                sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                toolErrors: compactToolFailureDiagnostics(lastToolResults),
              })
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            // OpenAI-compatible APIs require tool result messages to appear
            // immediately after the assistant message that declared tool_calls.
            // Do not insert reflection/system messages between them.
            const executedToolCalls = executedToolCallsForProviderHistory(
              lastStreamResult.toolCalls,
              lastToolResults,
            )
            if (executedToolCalls.length > 0) {
              const assistantMsg: Record<string, unknown> = {
                role: 'assistant',
                content: lastStreamResult.assistantContent || null,
                tool_calls: executedToolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
              if (ASSISTANT_PROVIDER === 'deepseek' && lastStreamResult.reasoningContent) {
                assistantMsg.reasoning_content = lastStreamResult.reasoningContent
              }
              contextManager.push(assistantMsg as unknown as ChatMessageParam)
            } else if (lastStreamResult.assistantContent) {
              contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
            }

            const toolMessages = toolPipeline.buildToolResultMessages(lastToolResults, state)
            for (const msg of toolMessages) {
              contextManager.push(msg as unknown as ChatMessageParam, 4)
            }

            updateExactExtractionGuardAfterTools(state, lastToolResults, messages)

            const executedCoalescedBrowserSequence =
              lastStreamResult.toolCalls.size > 1 &&
              lastToolResults.some(result => result.tc.name === 'browser_action_sequence')
            if (lastStreamResult.toolCalls.size > executedToolCalls.length && !executedCoalescedBrowserSequence) {
              contextManager.push({
                role: 'system',
                content: 'TOOL EXECUTION NOTE: Multiple tool calls were requested in one assistant turn, but this runtime executes one tool at a time. Continue from the executed result and call the next required tool separately.',
              } as ChatMessageParam, 2)
            }

            for (const result of lastToolResults) {
              toolRegistry.recordCall(result.tc.name)
            }

            const postToolDirectiveStatus = this.injectLiveDirectives(contextManager)
            if (postToolDirectiveStatus === 'identity') return
            if (postToolDirectiveStatus) {
              log.info('Injected live user directive after tool results')
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            // Goal tracking: record tool contributions
            if (goalTracker.isInitialized()) {
              for (const result of lastToolResults) {
                goalTracker.recordToolContribution(result.tc.name, result, state.currentStepIdx, workingMemory)
              }
            }

            // Reflection: evaluate progress after tool execution
            const currentStepGoal = state.currentPlanItems?.[state.currentStepIdx]
            const reflection = reflectionEngine.reflect(state, lastToolResults, currentStepGoal, previousFactCount)
            state.lastReflectionScore = reflection.progressScore
            state.consecutiveLowProgress = reflection.progressScore < 0.2
              ? state.consecutiveLowProgress + 1
              : 0
            if (reflection.contradictionDetected) state.contradictionFlag = true
            state.lastLoopSignal = null // consumed by reflection

            if (reflection.summary && (reflection.contradictionDetected || reflection.recommendation === 'try_alternative')) {
              contextManager.push({
                role: 'system',
                content: `[REFLECTION] ${reflection.summary}`,
              } as ChatMessageParam, 2)
            }

            // Update session health summary for context injection
            state.sessionHealthSummary = errorRecovery.getSessionHealthSummary()

            // Check deliverable on last step
            const isLastStep = state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1
            const deliverableCreated = lastToolResults.some(isSuccessfulFinalDeliverableWrite)
            const imageDeliverableCreated = lastToolResults.some(r => {
              if (r.tc.name !== 'image_search' || r.isError) return false
              const downloaded = (r.result as { downloaded?: string[] })?.downloaded
              return Array.isArray(downloaded) && downloaded.length > 0
            })
            const currentRequestText = messages.map(m => m.content || '').join(' ')
            const imageDeliverableRequested = /\b(image|images|photo|photos|picture|pictures|asset|assets)\b/i.test(
              `${currentRequestText} ${state.currentPlanItems?.[state.currentStepIdx] || ''}`,
            )

            if (isLastStep && imageDeliverableCreated && imageDeliverableRequested) {
              state.currentStepIdx = state.currentPlanItems!.length
              log.info('Image artifact created on last step — terminating')
              terminalReason = 'image_deliverable_created'
              for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              phase = 'COMPLETE'
              break
            }

            // Last-step deliverable created → verify quality before terminating
            if (isLastStep && deliverableCreated) {
              const deliverableResult = lastToolResults.find(isSuccessfulFinalDeliverableWrite)
              const recoveredPartialWrite = !!(deliverableResult?.result as { partialWriteIncomplete?: boolean } | undefined)?.partialWriteIncomplete
              if (deliverableResult && recoveredPartialWrite) {
                const pending = state.partialFileWriteRecoveryPending
                const path = pending?.path || toolResultPath(deliverableResult) || 'the saved deliverable'
                log.info('Recovered partial deliverable write on last step — requiring append continuation')
                contextManager.push({
                  role: 'system',
                  content: `PARTIAL DELIVERABLE SAVED: ${path} already exists. Do not call create_file for it again. Next response must be exactly one append_file call to the same path with the next complete missing section, using the full available output budget. Do not emit <next_step/> or any visible prose until a successful append_file call clears this partial-file state.`,
                } as ChatMessageParam)
                phase = 'EVALUATING'
                break
              }
              if (deliverableResult && !state.deliverableVerificationDone) {
                if (deliverableResult.tc.name !== 'export_pdf') {
                  try {
                    const args = JSON.parse(deliverableResult.tc.arguments) as { content?: string; path?: string }
                    const verifiedContent = conversationId
                      ? await deliverableContentForVerification(conversationId, deliverableResult)
                      : { path: toolResultPath(deliverableResult) || args.path || '', content: args.content || '' }
                    if (verifiedContent.path) {
                      recordWorkLedgerDeliverable(state, { path: verifiedContent.path, purpose: 'deliverable' })
                    }
                    const originalRequest = messages[messages.length - 1]?.content || ''
                    if (
                      shouldContinueSavedFinalDeliverableChunk(
                        state,
                        this.options.messages,
                        verifiedContent.path || args.path || toolResultPath(deliverableResult) || '',
                        verifiedContent.content || args.content || '',
                      )
                    ) {
                      const continuationPath = verifiedContent.path || args.path || toolResultPath(deliverableResult) || ''
                      const continuationContent = verifiedContent.content || args.content || ''
                      const continuationLines = continuationContent.split(/\r?\n/).filter(Boolean).length
                      state.deliverableRevisionCount++
                      state.partialFileWriteRecoveryPending = {
                        path: continuationPath,
                        toolName: 'append_file',
                        chars: continuationContent.length,
                        lines: continuationLines,
                      }
                      state.partialFileWriteRecoveryNudged = false
                      contextManager.push({
                        role: 'system',
                        content: `SAVED DELIVERABLE CONTINUATION REQUIRED: "${continuationPath}" has started successfully but is not complete enough for the requested saved output yet. Next response must be exactly one native append_file call to the same path with the next useful section. Do not recreate the file, do not write visible prose, and do not emit <next_step/> yet.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                    if (shouldDefaultFrontendToNextTsx(originalRequest)) {
                      const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
                      if (websiteProblems.missingFiles.length > 0) {
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS STRUCTURE REQUIRED: Website/app builds default to Next.js + TSX. Before finishing, create the missing file(s): ${websiteProblems.missingFiles.join(', ')}. A standalone home.tsx or one TSX file is not renderable enough. Do not replace this with index.html unless the user explicitly asked for standalone HTML.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                      if (websiteProblems.structureIssues.length > 0) {
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS WEBSITE COMPLETENESS REQUIRED: Before finishing, fix these structure/style issues: ${websiteProblems.structureIssues.join(' ')} The site may still be one page, but it must be a real composed website with app/page.tsx, app/layout.tsx importing './globals.css', app/globals.css, imported component files, substantive styling, and a successful local visual check.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                      if (!state.nextWebsitePreviewDone) {
                        const previewProblem = state.nextWebsitePreviewError
                          ? ` Last preview error: ${state.nextWebsitePreviewError}`
                          : state.nextWebsitePreviewAttempted
                          ? ' The preview was attempted but did not open successfully.'
                          : ' The required files exist, but the local TSX preview has not run yet.'
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS/TSX LOCAL PREVIEW REQUIRED: The generated website must build and open in the Computer browser before final delivery.${previewProblem} Fix the TSX/CSS using edit_file, or make a small targeted edit to a frontend file so the backend rebuilds and reopens the local preview. Do not finish until the preview succeeds.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                    }
                    if (
                      args.path &&
                      isWebsiteEntryPath(args.path) &&
                      !state.websiteBrowserCheckDone &&
                      state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS
                    ) {
                      state.deliverableRevisionCount++
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL WEBSITE SERVER CHECK REQUIRED: ${args.path} has not been successfully opened and inspected in the Computer browser. Keep working on the same file; after the backend opens it locally, use browser_screenshot and browser_scroll to inspect it before final delivery. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                    const verification = outputVerifier.verify(
                      verifiedContent.content || args.content || '',
                      verifiedContent.path || args.path || '',
                      originalRequest,
                      state.taskStrategy,
                      workingMemory,
                      state.taskComplexity,
                    )

                    if (!verification.passed && state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS) {
                      state.deliverableRevisionCount++
                      state.pendingDeliverableRevision = {
                        path: verifiedContent.path || args.path || toolResultPath(deliverableResult) || 'the existing deliverable',
                        failures: verification.failures,
                        suggestions: verification.suggestions,
                        createdAt: Date.now(),
                      }
                      const failureList = verification.failures.join('; ')
                      log.info(`Output verification failed (${verification.score.toFixed(2)}): ${failureList}`)
                      contextManager.push({
                        role: 'system',
                        content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${failureList}. Your next response must be exactly one native append_file or edit_file tool call against "${state.pendingDeliverableRevision.path}". Do NOT write status text, do NOT create a new file, and do NOT repeat that the report was created.${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
                      } as ChatMessageParam)
                      // Stay on deliverable step for revision
                      phase = 'EVALUATING'
                      break
                    }

                    if (!verification.passed) {
                      state.pendingDeliverableRevision = {
                        path: verifiedContent.path || args.path || toolResultPath(deliverableResult) || 'the existing deliverable',
                        failures: verification.failures,
                        suggestions: verification.suggestions,
                        createdAt: Date.now(),
                      }
                      state.deliverableVerificationDone = false
                      terminalReason = 'deliverable_verification_failed'
                      phase = 'COMPLETE'
                      break
                    }

                    if (
                      args.path &&
                      isWebsiteEntryPath(args.path) &&
                      !state.websiteResponsiveCheckDone
                    ) {
                      state.deliverableVerificationDone = true
                      state.websiteResponsiveCheckPrompted = true
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL VISUAL CHECK REQUIRED: ${args.path} is open on the local sandbox server. Inspect it before final delivery with browser_screenshot or browser_scroll at the existing browser size, and use edit_file if anything is visually broken. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                    if (
                      shouldDefaultFrontendToNextTsx(originalRequest) &&
                      state.nextWebsitePreviewDone &&
                      !state.websiteResponsiveCheckDone
                    ) {
                      state.deliverableVerificationDone = true
                      state.websiteResponsiveCheckPrompted = true
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL VISUAL CHECK REQUIRED: The Next.js/TSX preview is open in the Computer browser at ${state.nextWebsitePreviewUrl || 'the local preview URL'}. Before final delivery, inspect it with browser_screenshot or browser_scroll at the existing browser size, and use edit_file if anything is visually broken. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                  } catch {
                    state.deliverableVerificationDone = false
                    terminalReason = 'deliverable_verification_failed'
                    phase = 'COMPLETE'
                    break
                  }
                } else {
                  const originalRequest = messages[messages.length - 1]?.content || ''
                  const wantsPdf = /\bpdf\b/i.test(originalRequest)
                  const pdfPath = (deliverableResult.result as { path?: string })?.path || ''
                  if (wantsPdf && !pdfPath.toLowerCase().endsWith('.pdf') && state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS) {
                    state.deliverableRevisionCount++
                    contextManager.push({
                      role: 'system',
                      content: 'OUTPUT QUALITY CHECK FAILED: The user requested a PDF, but the exported file path is not a .pdf. Call export_pdf again with an output_path ending in .pdf.',
                    } as ChatMessageParam)
                    phase = 'EVALUATING'
                    break
                  }
                }
              }
              state.deliverableVerificationDone = true
              state.pendingDeliverableRevision = null
              state.currentStepIdx = state.currentPlanItems!.length
              log.info('Deliverable file created on last step — terminating')
              terminalReason = 'deliverable_created'
              for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              phase = 'COMPLETE'
              break
            }

            // Non-last step non-note file creation → force advance.
            const nonNoteFileCreated = lastToolResults.some(r => {
              if (r.tc.name !== 'create_file' || r.isError) return false
              try {
                const parsed = JSON.parse(r.tc.arguments) as { path?: string }
                const p = String(parsed?.path || '')
                return !p.toLowerCase().endsWith('.md')
              } catch {
                return false
              }
            })
            if (
              state.currentPlanItems &&
              nonNoteFileCreated &&
              !isLastStep &&
              (state.taskStrategy === 'build' || state.taskStrategy === 'code') &&
              shouldDefaultFrontendToNextTsx(messages[messages.length - 1]?.content || '')
            ) {
              const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
              if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
                const details = [
                  websiteProblems.missingFiles.length > 0 ? `Missing files: ${websiteProblems.missingFiles.join(', ')}.` : '',
                  websiteProblems.structureIssues.length > 0 ? `Structure/style issues: ${websiteProblems.structureIssues.join(' ')}` : '',
                ].filter(Boolean).join(' ')
                contextManager.push({
                  role: 'system',
                  content: `CONTINUE THE SAME BUILD PHASE. You created part of the website, but the initial Next.js/TSX file set is not complete yet. ${details} Keep creating/editing the required files in this same phase; do not advance to preview or delivery until the page, layout, styles, and reusable component structure exist.`,
                } as ChatMessageParam)
                phase = 'STREAMING'
                break
              }
            }
            if (state.currentPlanItems && nonNoteFileCreated) {
              if (pauseForPhaseEndNarrationBeforeAutoAdvance(
                state,
                contextManager,
                'The non-note file creation phase',
                lastStreamResult.assistantContent,
              )) {
                phase = 'STREAMING'
                break
              }
              log.info(`Non-note file created on step ${state.currentStepIdx} — forcing step advance`)
              const stepBeforeAdvance = state.currentStepIdx
              const advanceMsg = planManager.handleStepAdvance(state)
              if (state.currentStepIdx > stepBeforeAdvance) {
                contextManager.compactForStepTransition(state)
              }
              if (advanceMsg) {
                contextManager.push(advanceMsg as ChatMessageParam)
              }
              if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
            }

            // Goal completion check: auto-advance if all goals met for current step
            if (goalTracker.isInitialized() && state.currentPlanItems && !isLastStep && state.taskStrategy !== 'browse') {
              const goalCheck = goalTracker.checkGoalCompletion(state.currentStepIdx, state)
              if (goalCheck.allMet) {
                state.goalsMet = true
                if (pauseForPhaseEndNarrationBeforeAutoAdvance(
                  state,
                  contextManager,
                  'The goal-complete phase',
                  lastStreamResult.assistantContent,
                )) {
                  phase = 'STREAMING'
                  break
                }
                log.info(`Goals met for step ${state.currentStepIdx} — advancing`)
                const stepBeforeAdvance = state.currentStepIdx
                const advanceMsg = planManager.handleStepAdvance(state)
                if (state.currentStepIdx > stepBeforeAdvance) {
                  contextManager.compactForStepTransition(state)
                }
                if (advanceMsg) {
                  contextManager.push(advanceMsg as ChatMessageParam)
                }
                goalTracker.advanceToStep(state.currentStepIdx)
              }
            }

            // Information-triggered replanning used to call the planner mid-run,
            // which added paid model turns and often expanded the visible plan
            // after useful work had already started. Keep the signal for the
            // existing policies, but do not spend an extra planning call here.
            if (state.contradictionFlag || reflection.recommendation === 'try_alternative') {
              state.contradictionFlag = false
              state.infoReplanCooldown = 0
            }

            // Decrement info-replan cooldown
            if (state.infoReplanCooldown > 0) state.infoReplanCooldown--

            // Auto-debug injection
            const debugInjection = toolPipeline.buildDebugInjection(lastToolResults, state)
            if (debugInjection) {
              contextManager.push(debugInjection as ChatMessageParam)
            }

            if (
              state.currentStepIdx === stepIdxBeforeExec &&
              shouldAutoAdvanceBriefInlineResearchAfterTools(state, this.options.messages, lastToolResults)
            ) {
              if (pauseForPhaseEndNarrationBeforeAutoAdvance(
                state,
                contextManager,
                'The quick research phase',
                lastStreamResult.assistantContent,
              )) {
                phase = 'STREAMING'
                break
              }
              log.info(`Brief inline research evidence gathered on step ${state.currentStepIdx} — advancing to answer`)
              const stepBeforeAdvance = state.currentStepIdx
              const advanceMsg = planManager.handleStepAdvance(state)
              if (state.currentStepIdx > stepBeforeAdvance) {
                contextManager.compactForStepTransition(state)
              }
              if (advanceMsg) {
                contextManager.push(advanceMsg as ChatMessageParam)
              }
              if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
            }

            // Emit SSE step_advance events for any step advancement that happened
            for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
              this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
            }

            phase = 'EVALUATING'
            break
          }

          // ── EVALUATING ────────────────────────────────────────────
          case 'EVALUATING': {
            if (!lastStreamResult) { phase = 'ERROR'; break }

            if (lastStreamResult.toolCalls.size === 0) {
              const recoveredPhase = await this.recoverTextOnlyDraft(
                state,
                lastStreamResult.assistantContent,
                contextManager,
                planManager,
                workingMemory,
                goalTracker,
                outputVerifier,
              )
              if (recoveredPhase) {
                phase = recoveredPhase
                break
              }
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              shouldDefaultFrontendToNextTsx(messages[messages.length - 1]?.content || '')
            ) {
              const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
              if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
                const details = [
                  websiteProblems.missingFiles.length > 0 ? `Missing files: ${websiteProblems.missingFiles.join(', ')}.` : '',
                  websiteProblems.structureIssues.length > 0 ? `Structure/style issues: ${websiteProblems.structureIssues.join(' ')}` : '',
                ].filter(Boolean).join(' ')
                contextManager.push({
                  role: 'system',
                  content: `Do not finish yet. The requested website is not a complete renderable Next.js/TSX build. ${details} Create or edit the actual files now; a lone home.tsx/page TSX file is not acceptable.`,
                } as ChatMessageParam)
                phase = 'STREAMING'
                break
              }
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.nextWebsitePreviewAttempted &&
              !state.nextWebsitePreviewDone
            ) {
              contextManager.push({
                role: 'system',
                content: `Do not finish yet. A Next.js/TSX website was created, but the required local preview has not successfully built and opened in the Computer browser.${state.nextWebsitePreviewError ? ` Last preview error: ${state.nextWebsitePreviewError}` : ''} Fix the generated frontend files with edit_file so the backend can rebuild and reopen the preview.`,
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.websiteBrowserCheckAttempted &&
              !state.websiteBrowserCheckDone
            ) {
              contextManager.push({
                role: 'system',
                content: 'Do not finish yet. A website entry file was written, but it has not successfully opened in the Computer browser from the local sandbox server. Continue working on the same file and trigger a new write/edit so the local server check can run.',
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.websiteResponsiveCheckPrompted &&
              !state.websiteResponsiveCheckDone
            ) {
              contextManager.push({
                role: 'system',
                content: 'Do not finish yet. A website was created, but the required local visual check has not run. Use browser_screenshot or browser_scroll on the currently open local site at the existing browser size, then either fix issues with edit_file or finish if it looks correct.',
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            if (
              !lastStreamWasCompactNarration &&
              lastStreamResult.toolCalls.size === 0 &&
              shouldUseCompactResearchTurn(state) &&
              state.currentPlanItems &&
              state.currentStepIdx < state.currentPlanItems.length - 1
            ) {
              if (compactResearchEvidenceComplete(state)) {
                const stepBeforeAdvance = state.currentStepIdx
                if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                  contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                }
                const advanceMsg = planManager.handleStepAdvance(state)
                if (state.currentStepIdx > stepBeforeAdvance) {
                  contextManager.compactForStepTransition(state)
                }
                if (advanceMsg) {
                  contextManager.push(advanceMsg as ChatMessageParam)
                }
                if (goalTracker.isInitialized()) {
                  goalTracker.advanceToStep(state.currentStepIdx)
                }
                for (let i = stepBeforeAdvance; i < state.currentStepIdx; i++) {
                  this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                }
                console.log('[AgentDiagnostics] Compact research evidence complete; advanced after text-only turn', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems.length,
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                })
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }

              if (compactResearchNeedsToolAction(state)) {
                if (lastStreamResult.assistantContent && shouldKeepAssistantInjection(lastStreamResult.assistantContent)) {
                  contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                }
                state.consecutiveNoToolCalls += 1
                state.forceTextNextIteration = false
                if (state.consecutiveNoToolCalls >= 2) {
                  state.suppressedResearchToolName = null
                  state.stepLoopDetections = 0
                  state.recentToolCalls = []
                }
                contextManager.push({
                  role: 'system',
                  content: compactResearchToolRequiredMessage(
                    state,
                    state.consecutiveNoToolCalls >= 2
                      ? 'the compact research turn repeated without a tool call, so reopened source tools and cleared the loop state'
                      : 'the current research phase still needs model-selected evidence before it can advance',
                  ),
                } as ChatMessageParam)
                console.log('[AgentDiagnostics] Compact research text loop reissued model-selected tool requirement', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems.length,
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(state.stepVisitedUrls.size, stepOpenedSourceDomains(state).size),
                  reopenedTools: state.consecutiveNoToolCalls >= 2,
                })
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }
            }

            const stepIdxBeforeEval = state.currentStepIdx

            const actions = policyEngine.evaluate(
              state,
              lastStreamResult.toolCalls,
              lastStreamResult.assistantContent,
              lastStreamResult.stepAdvancedThisIteration,
              state.dynamicIterationLimit,
            )

            // Emit SSE step_advance events for actual step advancement triggered by policies
            // (manual <next_step/>, verified completion, etc.). Blocked steps must not advance.
            for (let i = stepIdxBeforeEval; i < state.currentStepIdx; i++) {
              this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
            }

            let shouldTerminate = false
            const systemInjections: string[] = []

            for (const action of actions) {
              if (action.type === 'terminate') {
                shouldTerminate = true
                const reason = action.reason || 'unknown'
                terminalReason = reason
                console.log(`[TERMINATE] reason=${reason} iter=${state.iterations} step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)
                break
              }
              if (action.type === 'inject_message' && action.message) {
                if (action.message.role === 'system') {
                  systemInjections.push(action.message.content as string)
                } else if (shouldKeepAssistantInjection(action.message.content as string)) {
                  const actionContent = String(action.message.content || '')
                  const isCurrentAssistantReplay =
                    action.message.role === 'assistant' &&
                    actionContent === lastStreamResult.assistantContent
                  contextManager.push(isCurrentAssistantReplay
                    ? assistantHistoryMessageForStreamResult(lastStreamResult, actionContent)
                    : action.message as ChatMessageParam)
                } else {
                  console.log('[Context] Dropped short assistant no-tool injection from model context')
                }
              }
            }

            // Budget rebalancing on step advance
            const hasStepAdvance = actions.some(a => a.type === 'step_advance')
            if (hasStepAdvance && !shouldTerminate) {
              contextManager.compactForStepTransition(state)
            }
            if (hasStepAdvance && state.currentPlanItems && state.stepCompletionTimes.length > 0 && !shouldTerminate) {
              const lastCompletion = state.stepCompletionTimes[state.stepCompletionTimes.length - 1]
              const surplus = state.perStepBudget - lastCompletion
              const remaining = state.currentPlanItems.length - state.currentStepIdx
              if (surplus > 0 && remaining > 0) {
                state.perStepBudget += Math.floor(surplus / remaining)
              }
            }

            // Push consolidated system message
            if (systemInjections.length > 0 && !shouldTerminate) {
              const consolidated = systemInjections.length === 1
                ? systemInjections[0]
                : systemInjections.join('\n\n')
              contextManager.push({ role: 'system', content: consolidated } as ChatMessageParam)
            }

            if (shouldTerminate) { phase = 'COMPLETE'; break }

            state.lastIterationEnd = Date.now()
            phase = 'STREAMING'
            break
          }
          }
        }

        if (phase !== 'COMPLETE') break

        const websiteBlocker = await getNextWebsiteCompletionBlocker(
          conversationId,
          state,
          messages[messages.length - 1]?.content || '',
        )
        if (websiteBlocker) {
          if (state.iterations >= state.dynamicIterationLimit) {
            this.emitter.error(`Website build did not complete. ${websiteBlocker}`)
            phase = 'ERROR'
            break
          }
          contextManager.push({ role: 'system', content: websiteBlocker } as ChatMessageParam)
          state.lastIterationEnd = Date.now()
          phase = 'STREAMING'
          continue
        }

        break
      }

      // ── Finalization ──────────────────────────────────────────────────

      if (phase === 'COMPLETE') {
        const totalUsage = {
          promptTokens: cumulativeInputTokens,
          completionTokens: cumulativeOutputTokens,
          totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
          cost: cumulativeCost,
        }
        const completionAudit = auditAgentCompletion(state, terminalReason)
        log.info(`COMPLETE: iterations=${state.iterations}, step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)
        console.log(`[COST TOTAL] iterations=${state.iterations} inputTokens=${cumulativeInputTokens} outputTokens=${cumulativeOutputTokens} providerCost=$${cumulativeCost.toFixed(6)}`)

        if (state.iterations >= state.dynamicIterationLimit) {
          this.emitter.textDelta('\n\n*Reached maximum number of actions. Results so far are shown above.*')
        }

        const cacheStats = toolCache.getStats()
        log.info(`Session complete: ${state.iterations} iterations`, {
          cacheHits: cacheStats.hits,
          cacheMisses: cacheStats.misses,
          cacheHitRate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
          filesCreated: state.createdFiles.size,
          searchesDone: state.searchQueries.size,
        })

        if (!completionAudit.complete) {
          log.warn('Completion audit failed', {
            reason: completionAudit.reason,
            missing: completionAudit.missing,
          })
          this.emitter.error(completionAudit.message)
          this.emitter.close()
          return
        }

        this.emitter.done(totalUsage)
        this.emitter.close()
      } else {
        // ERROR: keep the stream open so the API route can finish accounting
        // and close the response.
      }
    } catch (err) {
      if (signal?.aborted) {
        this.emitter.close()
        return
      }
      log.error('Unhandled error in agent loop', {
        error: err instanceof Error ? err.message : String(err),
        iterations: state.iterations,
        phase: state.currentPhase,
      })
      if (!this.emitter.isClosed) {
        if (isOutOfCreditsError(err) && err.record?.created) {
          this.emitter.creditEvent(err.record.entry)
        }
        this.emitter.error(publicAgentErrorMessage(err))
      }
    } finally {
      browserFrameStream.unsubscribe?.()
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  /**
   * Abort-aware sleep for delays between model calls.
   */
  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    const signal = this.options.signal
    if (!signal) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }
    if (signal.aborted) return Promise.resolve()

    return new Promise(resolve => {
      let timeout: ReturnType<typeof setTimeout>
      const cleanup = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => cleanup()
      timeout = setTimeout(cleanup, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private injectLiveDirectives(contextManager: ContextManager): false | 'injected' | 'identity' {
    const { conversationId, userId } = this.options
    if (!conversationId) return false

    const directives = drainLiveDirectives(conversationId, userId)
    if (directives.length === 0) return false

    if (directives.some(directive => isAgentIdentityDisclosureQuestion(directive.content))) {
      this.emitAgentIdentityDisclosureAnswer()
      return 'identity'
    }

    contextManager.push({
      role: 'user',
      content: liveDirectiveContextMessage(directives),
    } as ChatMessageParam, 10)
    return 'injected'
  }

  /**
   * Preprocess messages: inline file attachments.
   */
  private preprocessMessages(
    messages: AgentLoopOptions['messages']
  ): Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> }> {
    return preprocessMessagesForAgentContext(messages)
  }

  /**
   * Call assistant service with exponential backoff retry for rate limits.
   */
  private async callLLMWithRetry(
    model: string,
    allMessages: ChatMessageParam[],
    state: AgentStateData,
    strategy: TaskStrategyConfig,
    toolRegistry: ToolRegistry,
  ): Promise<AsyncIterable<StreamingChatCompletionChunk> | null> {
    const useCompactForcedNarration = state.forceTextNextIteration && !state.exactExtractionGuardPending
    const useCompactCadenceNarration = !useCompactForcedNarration &&
      shouldUseNaturalCadenceNarration(state, this.options.messages)
    const useCompactNarration = useCompactForcedNarration || useCompactCadenceNarration
    const useCompactFinalInlineAnswer = finalInlineAnswerTurn(state, this.options.messages) &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending
    const useTextFinalDeliverable = shouldUseTextSavedFinalDeliverable(state, this.options.messages) &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending
    const useCompactFinalDeliverable = finalSavedDeliverableTurn(state, this.options.messages) &&
      !useTextFinalDeliverable &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending
    const useCompactResearchTurn = !useCompactNarration &&
      !useCompactFinalInlineAnswer &&
      !useTextFinalDeliverable &&
      !useCompactFinalDeliverable &&
      shouldUseCompactResearchTurn(state)
    const compactResearchPhaseCanAdvance = useCompactResearchTurn &&
      !!state.currentPlanItems &&
      state.currentStepIdx < state.currentPlanItems.length - 1 &&
      compactResearchEvidenceComplete(state)
    let requestMessages = useCompactNarration
      ? compactForcedNarrationMessages(state, allMessages)
      : useCompactFinalInlineAnswer
        ? compactFinalInlineAnswerMessages(state, allMessages)
        : useTextFinalDeliverable
          ? compactFinalTextDeliverableMessages(state, allMessages)
        : useCompactFinalDeliverable
          ? compactFinalDeliverableMessages(state, allMessages)
          : useCompactResearchTurn
            ? compactResearchTurnMessages(state, allMessages)
            : allMessages
    if (!useCompactNarration && state.strategyConfig && state.strategyConfig.type !== strategy.type) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: `RUNTIME STRATEGY OVERRIDE: use "${state.strategyConfig.type}" behavior for this task now. Follow the current plan/step guidance over the initial classifier hint.`,
        } as ChatMessageParam,
      ]
    }
    const hasActivePlanStep = !!state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length
    const partialFileContinuationNeedsTool = hasActivePlanStep &&
      !!state.partialFileWriteRecoveryPending &&
      !state.forceTextNextIteration &&
      !state.exactExtractionGuardPending
    if (state.exactExtractionGuardPending && state.exactExtractionGuardPrompt) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: state.exactExtractionGuardPrompt,
        } as ChatMessageParam,
      ]
    } else if (partialFileContinuationNeedsTool && state.partialFileWriteRecoveryPending) {
      const pending = state.partialFileWriteRecoveryPending
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: [
            'PARTIAL FILE CONTINUATION REQUIRED NOW.',
            `The only valid next action is one native append_file call to "${pending.path}".`,
            `That file already has ${pending.lines} lines / ${pending.chars} characters from a recovered clipped write.`,
            'Do not call create_file, edit_file, read_file, list_files, export_pdf, browser tools, research tools, or emit <next_step/>.',
            'Append only the next missing section or chunk, without repeating earlier content.',
          ].join(' '),
        } as ChatMessageParam,
      ]
    }
    if (state.forceTextNextIteration) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: [
            'NARRATION DUE: write exactly one concise, concrete progress paragraph from completed work.',
            'This is a narration-only repair turn: do not call tools, do not ask permission to continue, and do not stop with future intent.',
            'After this paragraph is accepted, the following turn can continue the active phase or final answer.',
          ].join(' '),
        } as ChatMessageParam,
      ]
    }
    const researchLogContext = !useCompactNarration && shouldInjectResearchActivityContext(state)
      ? researchActivityContext(state.researchActivity, state.currentStepIdx)
      : null
    if (researchLogContext) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: researchLogContext,
        } as ChatMessageParam,
      ]
    }
    if (useCompactResearchTurn && compactResearchNeedsOpenedSource(state)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: state.suppressedResearchToolName === 'read_document'
            ? 'SOURCE OPENING RECOVERY: read_document is temporarily suppressed because it repeated in a loop. Use a materially different source route now: targeted web_search for a new authoritative URL, browser_navigate to that URL, or browser_get_content from a different already-open useful page. Do not retry the same extracted URL.'
            : 'SOURCE OPENING REQUIRED: search breadth is already high enough for this phase. Do not call web_search again. Open or extract one of the strongest URLs already surfaced in the research activity context using read_document, browser_navigate, or browser_get_content if a useful page is already open. After this opened/read source, synthesize or advance instead of doing more query variants.',
        } as ChatMessageParam,
      ]
    }
    if (compactResearchPhaseCanAdvance) {
      const sourceOpeningExhausted = compactResearchSourceOpeningExhausted(
        state,
        researchDepthProfileForState(state),
      )
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: sourceOpeningExhausted
            ? 'SOURCE OPENING EXHAUSTED: repeated attempts to open or extract the surfaced source URLs looped without usable page evidence. Stop rotating source tools for this phase. Write one concise progress paragraph using the available search-result packet, explicitly note that source opening failed for this phase, then emit <next_step/>. Do not call more tools for this phase.'
            : 'PHASE EVIDENCE READY: write one concise progress paragraph with the main findings from this phase, then emit <next_step/>. Do not call more tools for this phase.',
        } as ChatMessageParam,
      ]
    }
    if (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'FIXED-SEARCH INLINE ANSWER: The user requested a limited web search followed by an inline chat answer, not a saved file. Use only the completed search evidence and answer directly in the requested length. Do not create, mention, attach, or claim any file, report, artifact, or deliverable.',
        } as ChatMessageParam,
      ]
    } else if (finalInlineAnswerTurn(state, this.options.messages)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: finalInlineAnswerPrompt(state),
        } as ChatMessageParam,
      ]
    } else if (shouldUseTextSavedFinalDeliverable(state, this.options.messages)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: finalSavedDeliverableTextPrompt(state),
        } as ChatMessageParam,
      ]
    } else if (finalSavedDeliverableTurn(state, this.options.messages)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: finalSavedDeliverablePrompt(state),
        } as ChatMessageParam,
      ]
    }
    let relaxRequiredToolChoice = false
    let lastShouldRequireToolCall = false
    for (let attempt = 0; attempt <= STREAM_MAX_RETRIES; attempt++) {
      try {
        const budgetFraction = state.dynamicIterationLimit
          ? state.iterations / state.dynamicIterationLimit
          : 0

        let activeTools: ToolDefinitionLike[]
        const isPostCompletion = state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length
        if (isPostCompletion) {
          activeTools = []
        } else if (state.exactExtractionGuardPending) {
          activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
            .filter(t => EXACT_EXTRACTION_TOOLS.has(t.function?.name || ''))
        } else if (useCompactNarration) {
          activeTools = []
        } else if (useTextFinalDeliverable) {
          activeTools = []
        } else if (compactResearchPhaseCanAdvance) {
          activeTools = []
        } else if (state.deadlineFinalizationStarted) {
          if (!taskNeedsSavedFinalArtifact(state, this.options.messages)) {
            activeTools = []
          } else {
            const finalWantsPdf = taskWantsPdfArtifact(state, this.options.messages)
            const deadlineFinalTools = new Set([
              'create_file',
              'append_file',
              'edit_file',
              'read_file',
              'list_files',
              ...(finalWantsPdf ? ['export_pdf'] : []),
            ])
            activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
              .filter(t => deadlineFinalTools.has(t.function?.name || ''))
          }
        } else if (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state)) {
          activeTools = []
        } else if (isLeanFinalSynthesisStep(state)) {
          if (!taskNeedsSavedFinalArtifact(state, this.options.messages)) {
            activeTools = []
          } else {
            const finalWantsImage = taskWantsImageArtifact(state, this.options.messages)
            const finalWantsPdf = taskWantsPdfArtifact(state, this.options.messages)
            const allowedFinalTools = new Set([
              'create_file',
              'edit_file',
              'append_file',
              'read_file',
              'list_files',
              ...(finalWantsPdf ? ['export_pdf'] : []),
              ...(finalWantsImage ? ['image_search'] : []),
            ])
            activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
              .filter(t => {
                const name = t.function?.name || ''
                return allowedFinalTools.has(name)
              })
          }
        } else if (budgetFraction >= URGENCY_FINAL_FRACTION) {
          const finalWantsImage = taskWantsImageArtifact(state, this.options.messages)
          const allActiveTools = toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[]
          if (state.taskStrategy === 'browse') {
            activeTools = allActiveTools.filter(t => {
              const name = t.function?.name || ''
              return name.startsWith('browser_') ||
                name === 'web_search' ||
                name === 'read_document' ||
                name === 'create_file' ||
                name === 'edit_file' ||
                name === 'append_file' ||
                name === 'read_file'
            })
          } else {
            activeTools = allActiveTools
              .filter(t => {
                const name = t.function?.name
                return name === 'create_file' ||
                  name === 'edit_file' ||
                  name === 'append_file' ||
                  name === 'export_pdf' ||
                  name === 'read_file' ||
                  name === 'browser_screenshot' ||
                  name === 'browser_scroll' ||
                  (finalWantsImage && name === 'image_search')
              })
          }
        } else {
          activeTools = toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[]
        }
        const compactResearchNeedsTool = useCompactResearchTurn && compactResearchNeedsToolAction(state)
        const compactResearchToolState = compactResearchNeedsTool && state.currentPhase !== 'research'
          ? ({ ...state, currentPhase: 'research' as const })
          : state
        if (compactResearchToolState !== state) {
          activeTools = toolRegistry.getActiveDefinitions(compactResearchToolState) as ToolDefinitionLike[]
        }
        if (compactResearchNeedsTool) {
          const sourceRecoveryPool = toolRegistry.getActiveDefinitions(compactResearchToolState) as ToolDefinitionLike[]
          const restoredTools = compactResearchSourceRecoveryToolsForState(
            state,
            activeTools,
            sourceRecoveryPool,
          )
          if (restoredTools !== activeTools) {
            console.log('[AgentDiagnostics] Restored compact research source tools', {
              step: state.currentStepIdx,
              totalSteps: state.currentPlanItems?.length || 0,
              beforeTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
              afterTools: restoredTools.map(tool => tool.function?.name).filter(Boolean),
            })
            activeTools = restoredTools
          }
        }
        activeTools = pruneToolsForCurrentStep(compactResearchToolState, activeTools)
        if (compactResearchNeedsTool && compactResearchNeedsOpenedSource(state)) {
          const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
          activeTools = compactResearchOpenedSourceToolsForState(state, activeTools)
          console.log('[AgentDiagnostics] Narrowed compact research to opened-source tools', {
            step: state.currentStepIdx,
            totalSteps: state.currentPlanItems?.length || 0,
            stepResearchCallCount: state.stepResearchCallCount,
            stepSearchQueries: state.stepSearchQueries.size,
            stepVisitedUrls: state.stepVisitedUrls.size,
            stepSourceDomains: stepOpenedSourceDomains(state).size,
            beforeTools,
            afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
          })
        }
        if (compactResearchNeedsTool && shouldUseCompactResearchRecoveryTools(state)) {
          const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
          activeTools = compactResearchRecoveryToolsForState(state, activeTools)
          console.log('[AgentDiagnostics] Narrowed compact research recovery tools', {
            step: state.currentStepIdx,
            totalSteps: state.currentPlanItems?.length || 0,
            consecutiveNoToolCalls: state.consecutiveNoToolCalls,
            stepToolCallCount: state.stepToolCallCount,
            stepResearchCallCount: state.stepResearchCallCount,
            beforeTools,
            afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
          })
        }
        if (
          compactResearchNeedsTool &&
          state.suppressedResearchToolName &&
          !compactResearchEvidenceComplete(state)
        ) {
          const suppressed = state.suppressedResearchToolName
          const filtered = activeTools.filter(tool => tool.function?.name !== suppressed)
          if (filtered.length > 0) {
            const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
            activeTools = loopRecoveryToolForState(state, filtered)
            console.log('[AgentDiagnostics] Suppressed looped research tool for recovery', {
              step: state.currentStepIdx,
              totalSteps: state.currentPlanItems?.length || 0,
              suppressed,
              loopDetections: state.stepLoopDetections,
              beforeTools,
              afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
            })
          }
        }
        if (partialFileContinuationNeedsTool) {
          const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
          activeTools = activeTools.filter(tool => tool.function?.name === 'append_file')
          console.log('[AgentDiagnostics] Narrowed tools for partial file continuation', {
            step: state.currentStepIdx,
            partialPath: state.partialFileWriteRecoveryPending?.path || '',
            beforeTools,
            afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
          })
        }
        const exhaustedStepToolPrune = pruneExhaustedStepToolsForCurrentTurn(state, activeTools)
        if (exhaustedStepToolPrune.exhausted.length > 0) {
          const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
          activeTools = exhaustedStepToolPrune.tools
          console.log('[AgentDiagnostics] Pruned exhausted step tools before model call', {
            step: state.currentStepIdx,
            totalSteps: state.currentPlanItems?.length || 0,
            exhausted: exhaustedStepToolPrune.exhausted,
            beforeTools,
            afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
          })
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: `STEP TOOL LIMIT REACHED: ${exhaustedStepToolPrune.exhausted.join(', ')} is unavailable for the rest of this phase because its per-phase limit is exhausted. Do not request that tool. Use one of the remaining tools, or if the phase has enough evidence, write a concise progress paragraph and emit <next_step/>.`,
            } as ChatMessageParam,
          ]
        }
        const agenticStepNeedsTool = shouldForceAgenticToolCall(state, hasActivePlanStep)
        const finalSavedDeliverableNeedsTool = useCompactFinalDeliverable &&
          (
            partialFileContinuationNeedsTool ||
            !hasSavedFinalDeliverableCandidate(state)
          )
        if (
          finalSavedDeliverableNeedsTool &&
          !partialFileContinuationNeedsTool &&
          !hasSavedFinalDeliverableCandidate(state)
        ) {
          const beforeTools = activeTools.map(tool => tool.function?.name).filter(Boolean)
          activeTools = activeTools.filter(tool => tool.function?.name === 'create_file')
          console.log('[AgentDiagnostics] Narrowed tools for initial final saved deliverable', {
            step: state.currentStepIdx,
            beforeTools,
            afterTools: activeTools.map(tool => tool.function?.name).filter(Boolean),
          })
        }
        const narrationWindowOpen =
          hasActivePlanStep &&
          !state.forceTextNextIteration &&
          !state.exactExtractionGuardPending &&
          state.visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT &&
          !finalSavedDeliverableNeedsTool &&
          !partialFileContinuationNeedsTool
        const shouldRequireToolCall =
          activeTools.length > 0 &&
          !isPostCompletion &&
          !state.forceTextNextIteration &&
          (
            partialFileContinuationNeedsTool ||
            finalSavedDeliverableNeedsTool ||
            (
              state.currentPhase !== 'deliver' &&
              (
                agenticStepNeedsTool ||
                compactResearchNeedsTool ||
                state.exactExtractionGuardPending ||
                state.taskStrategy === 'browse' ||
                state.consecutiveNoToolCalls > 0 ||
                state.browserNoToolRecoveryAttempts > 0
              )
            )
          )
        const requiredToolIntent = shouldRequireToolCall && !narrationWindowOpen
        const fastActionTurn = activeTools.length > 0 &&
          !isPostCompletion &&
          isFastActionToolTurn(state, this.options.messages) &&
          (requiredToolIntent || compactResearchNeedsTool || agenticStepNeedsTool || narrationWindowOpen)
        const fastSourceActionTurn = fastActionTurn &&
          isFastSourceActionToolTurn(state, this.options.messages)
        const useRequiredToolCall = requiredToolIntent &&
          !relaxRequiredToolChoice &&
          supportsProviderRequiredToolChoice()
        lastShouldRequireToolCall = useRequiredToolCall

        const approxChars = requestMessages.reduce((sum, m) => {
          if (typeof m.content === 'string') return sum + m.content.length
          if (Array.isArray(m.content)) return sum + (m.content as Array<{ text?: string }>).reduce((s, p) => s + (p.text?.length || 0), 0)
          return sum
        }, 0)
        console.log(`[Agent] iter=${state.iterations} msgs=${requestMessages.length} ~${Math.round(approxChars / 4)}tok tools=${activeTools.length} step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)

        const modelTools = compactToolDefinitionsForModel(activeTools)
        const isFinalInlineAnswerTurn = finalInlineAnswerTurn(state, this.options.messages)
        const isFinalSavedDeliverableTurn = finalSavedDeliverableTurn(state, this.options.messages)
        const isInitialFinalSavedDeliverableTurn = isFinalSavedDeliverableTurn &&
          !state.partialFileWriteRecoveryPending &&
          !hasSavedFinalDeliverableCandidate(state)
        const maxTokens = useCompactNarration
          ? Math.min(maxTokensForIteration(state), FORCED_NARRATION_MAX_TOKENS)
          : isFinalInlineAnswerTurn
          ? Math.min(maxTokensForIteration(state), finalInlineAnswerMaxTokens(state, this.options.messages))
          : useTextFinalDeliverable
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_TEXT_MAX_TOKENS)
          : isInitialFinalSavedDeliverableTurn
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_INITIAL_MAX_TOKENS)
          : isFinalSavedDeliverableTurn
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_MAX_TOKENS)
          : fastSourceActionTurn
          ? Math.min(maxTokensForIteration(state), FAST_SOURCE_ACTION_MAX_TOKENS)
          : maxTokensForIteration(state)
        const requestTemperature = useCompactNarration
          ? 0.25
          : isFinalInlineAnswerTurn
            ? Math.min(0.35, state.strategyConfig?.temperature ?? strategy.temperature)
            : isFinalSavedDeliverableTurn
              ? Math.min(0.35, state.strategyConfig?.temperature ?? strategy.temperature)
            : state.strategyConfig?.temperature ?? strategy.temperature
        const requestReasoning = useCompactNarration
          ? { reasoning: { effort: 'minimal' as const, exclude: true } }
          : isFinalInlineAnswerTurn
            ? { reasoning: { effort: 'minimal' as const, exclude: true } }
            : isFinalSavedDeliverableTurn
              ? { reasoning: { effort: 'minimal' as const, exclude: true } }
              : fastActionTurn
                ? { reasoning: { effort: 'minimal' as const, exclude: true } }
            : {}
        const requestTimeoutMs = useCompactNarration
            ? FORCED_NARRATION_REQUEST_TIMEOUT_MS
          : isFinalInlineAnswerTurn
            ? FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS
          : useTextFinalDeliverable
            ? FINAL_SAVED_DELIVERABLE_TEXT_REQUEST_TIMEOUT_MS
          : isInitialFinalSavedDeliverableTurn
            ? FINAL_SAVED_DELIVERABLE_INITIAL_REQUEST_TIMEOUT_MS
          : isFinalSavedDeliverableTurn
            ? FINAL_SAVED_DELIVERABLE_REQUEST_TIMEOUT_MS
          : state.deadlineFinalizationStarted
            ? Math.max(
                10_000,
                Math.min(
                  state.deadlineModelTurnTimeoutMs || AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS,
                  agentRunRemainingMs(state) - (state.deadlineHardStopBufferMs || AGENT_DEADLINE_HARD_STOP_BUFFER_MS),
                ),
              )
          : fastActionTurn
            ? FAST_ACTION_REQUEST_TIMEOUT_MS
          : STREAM_REQUEST_TIMEOUT_MS
        console.error('[AgentDiagnostics] Opening streaming model call', {
          iteration: state.iterations,
          phase: state.currentPhase,
          step: state.currentStepIdx,
          totalSteps: state.currentPlanItems?.length || 0,
          strategy: state.taskStrategy,
          activeTools: activeTools.length,
          modelTools: modelTools.length,
          requireToolCall: useRequiredToolCall,
          requiredToolIntent,
          providerRequiredToolChoice: supportsProviderRequiredToolChoice(),
          fastActionTurn,
          fastSourceActionTurn,
          forceTextNextIteration: !!state.forceTextNextIteration,
          compactCadenceNarration: !!useCompactCadenceNarration,
          approxTokens: Math.round(approxChars / 4),
          maxTokens,
          finalInlineAnswer: isFinalInlineAnswerTurn,
          finalSavedDeliverable: isFinalSavedDeliverableTurn,
          requestTimeoutMs,
        })
        await this.assertServerCreditRunwayCached()
        const response = await createStreamingCompletion({
          model,
          messages: requestMessages,
          ...(modelTools.length > 0
            ? { tools: modelTools as unknown as ChatCompletionTool[] }
            : {}),
          ...(useRequiredToolCall ? { tool_choice: 'required' } : {}),
          temperature: requestTemperature,
          parallel_tool_calls: false,
          max_tokens: maxTokens,
          ...requestReasoning,
          includeTemporalContext: shouldIncludeTemporalContextForTurn(state),
          stream_options: { include_usage: true },
          requestTimeoutMs,
          retryMaxAttempts: STREAM_MAX_RETRIES,
          retryBaseDelayMs: STREAM_RETRY_BASE_MS,
          retryMaxDelayMs: STREAM_RETRY_MAX_DELAY_MS,
          abortSignal: this.options.signal,
        })

        if (attempt > 0) {
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
        }

        state.lastModelErrorForUser = null
        return response
      } catch (streamErr) {
        const status = (streamErr as { status?: number })?.status
        const errorText = `${(streamErr as { body?: string })?.body || ''}\n${streamErr instanceof Error ? streamErr.message : String(streamErr)}`
        if (isAssistantRequestTimeout(streamErr)) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'model_start_timeout',
              attempt: attempt + 1,
              maxAttempts: STREAM_MAX_RETRIES + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              requiredToolMode: lastShouldRequireToolCall,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.warn('[AgentDiagnostics] Streaming model did not start before the bounded action timeout', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            requiredToolMode: lastShouldRequireToolCall,
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          state.lastModelErrorForUser = null
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
          return null
        }
        const invalidToolArguments = status === 400 &&
          /\bfunction\.arguments\b[\s\S]*\bJSON format\b|invalid_parameter_error|invalid_parameter/i.test(errorText)
        if (invalidToolArguments) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'invalid_tool_arguments',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              activeTools: lastShouldRequireToolCall,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rejected malformed tool arguments', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          if (attempt < STREAM_MAX_RETRIES) {
            console.warn('[Agent] Assistant service rejected malformed tool-call JSON; retrying with stricter tool-call instruction.')
            requestMessages = [
              ...requestMessages,
              {
                role: 'system',
                content: 'PROVIDER RECOVERY: The previous model attempt was rejected before streaming because a function/tool call used invalid JSON for function.arguments. Your next response must make exactly one native tool call with arguments as a strict JSON object. Use double quotes around every key and string value, no markdown, no comments, no trailing commas, no bare strings, and no prose outside the tool call. Example arguments: {"query":"specific search phrase"} or {"url":"https://example.com"}. If the current page is blocked by CAPTCHA, Cloudflare, access denial, or human verification, do not interact with it and do not retry the same URL; choose a different source route.',
              } as ChatMessageParam,
            ]
            state.iterationDelayMs = MIN_ITERATION_DELAY_MS
            continue
          }
          state.lastModelErrorForUser = null
          state.pendingToolJsonRecovery = true
          state.toolJsonRecoveryCount = (state.toolJsonRecoveryCount || 0) + 1
          console.warn('[Agent] Assistant service rejected malformed tool-call JSON after retry; recovering with a text-only nudge.')
          return null
        }
        const providerRejectedForcedToolMode = status === 400 &&
          lastShouldRequireToolCall &&
          !relaxRequiredToolChoice &&
          /\b(?:tool_choice|required|tools?|function(?:s| calling)?|schema|unsupported|not supported|not available|does not support|invalid request)\b/i.test(errorText)
        if (providerRejectedForcedToolMode) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'forced_tool_mode_rejected',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              requiredToolMode: lastShouldRequireToolCall,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rejected forced tool mode', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            activeStep: state.currentPlanItems?.[state.currentStepIdx],
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          relaxRequiredToolChoice = true
          if (attempt < STREAM_MAX_RETRIES) {
            console.warn('[Agent] Assistant service rejected forced tool-call mode; retrying with optional tool-call recovery.')
            requestMessages = [
              ...requestMessages,
              {
                role: 'system',
                content: providerToolModeRecoveryMessage(state, this.options.messages),
              } as ChatMessageParam,
            ]
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
            continue
          }
          state.lastModelErrorForUser = null
          state.pendingToolJsonRecovery = true
          state.toolJsonRecoveryCount = (state.toolJsonRecoveryCount || 0) + 1
          console.warn('[Agent] Assistant service rejected forced tool-call mode after retry; recovering with a text-only nudge.')
          return null
        }
        if (status === 402) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'provider_token_or_credit_limit',
              attempt: attempt + 1,
              maxAttempts: STREAM_MAX_RETRIES + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model hit provider token/credit limit', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            error: sanitizeAgentServiceError(streamErr),
          })
          state.lastModelErrorForUser = 'Agent could not start the next action because the assistant service token or credit limit was exceeded.'
          return null
        }
        if (status === 429 && attempt < STREAM_MAX_RETRIES) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'rate_limited',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rate limited', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
          })
          const retryAfterRaw = (streamErr as { headers?: Record<string, string> })?.headers?.['retry-after']
          const retryAfterMs = retryAfterRaw ? (parseInt(retryAfterRaw, 10) || 0) * 1000 : 0
          const baseBackoff = STREAM_RETRY_BASE_MS * Math.pow(STREAM_RETRY_EXPONENT, attempt)
          const retryDelay = Math.min(Math.max(retryAfterMs, baseBackoff), STREAM_RETRY_MAX_DELAY_MS)
          const backoff = retryDelay + Math.random() * 300

          this.emitter.textDelta('')  // keep connection alive
          if (attempt === 0) console.log('[Agent] Rate limited, retrying streaming request')
          await this.wait(backoff)
          if (this.options.signal?.aborted) return null
          continue
        }

        if (this.options.signal?.aborted) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'request_aborted',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model call aborted by request signal', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
          })
          return null
        }
        console.error('[AgentDiagnostics] Streaming model call failed', {
          attempt: attempt + 1,
          maxAttempts: STREAM_MAX_RETRIES + 1,
          status,
          iteration: state.iterations,
          phase: state.currentPhase,
          step: state.currentStepIdx,
          signalAborted: !!this.options.signal?.aborted,
          error: sanitizeAgentServiceError(streamErr),
        })
        this.options.diagnostics?.({
          type: 'stream_error',
          data: {
            category: 'stream_call_failed',
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            signalAborted: !!this.options.signal?.aborted,
            status,
            error: sanitizeAgentServiceError(streamErr),
          },
        })
        state.iterationDelayMs = MIN_ITERATION_DELAY_MS
        return null
      }
    }
    return null
  }

  /**
   * Handle stream processing errors.
   */
  private handleStreamError(
    error: unknown,
    state: AgentStateData,
    contextManager: ContextManager,
    isBuild: boolean,
  ): Phase {
    if (!(error instanceof Error)) {
      return 'ERROR'
    }

    // Fatal timeout
    if (error instanceof TimeoutError && !error.nudgeable) {
      this.emitter.error('The assistant stopped responding.')
      return 'ERROR'
    }

    // Nudgeable timeout
    if (isNudgeableTimeout(error)) {
      if (finalInlineAnswerTurn(state, this.options.messages)) {
        const partialContent = error.partialContent || ''
        if (partialContent.trim().length >= FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS) {
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
          if (state.currentPlanItems) {
            state.currentStepIdx = state.currentPlanItems.length
          }
          state.forceTextNextIteration = false
          state.phaseEndNarrationPending = false
          state.lastIterationEnd = Date.now()
          return 'COMPLETE'
        }

        if (state.timeoutNudgeCount < 1) {
          state.timeoutNudgeCount++
          contextManager.push({
            role: 'system',
            content: 'FINAL ANSWER TIME CHECK: stop hidden reasoning and write the answer now from gathered evidence only. No tools, no planning, no status update, no extra source gathering. Keep it concise and finish in this response.',
          } as ChatMessageParam)
          state.lastIterationEnd = Date.now()
          return 'STREAMING'
        }

        this.emitter.error('The final answer took too long to respond. Please try again.')
        return 'ERROR'
      }

      if (finalSavedDeliverableTurn(state, this.options.messages)) {
        if (state.timeoutNudgeCount < MAX_TIMEOUT_NUDGES) {
          state.timeoutNudgeCount++
          state.forceTextNextIteration = false
          contextManager.push({
            role: 'system',
            content: finalSavedDeliverableToolCallInstruction(
              state,
              'FINAL SAVED DELIVERABLE TIME CHECK: the final output turn stalled before saving the deliverable.',
            ),
          } as ChatMessageParam)
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
          state.lastIterationEnd = Date.now()
          return 'STREAMING'
        }

        state.timeoutNudgeCount = 0
        state.forceTextNextIteration = false
        contextManager.push({
          role: 'system',
          content: finalSavedDeliverableToolCallInstruction(
            state,
            'FINAL SAVED DELIVERABLE IMMEDIATE WRITE: the previous saved-output turn was too slow.',
          ),
        } as ChatMessageParam)
        state.iterationDelayMs = MIN_ITERATION_DELAY_MS
        state.lastIterationEnd = Date.now()
        return 'STREAMING'
      }

      if (state.timeoutNudgeCount < MAX_TIMEOUT_NUDGES) {
        state.timeoutNudgeCount++

        const partialContent = error.partialContent || ''
        if (partialContent) {
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
        }

        const nudgeMessage = state.taskStrategy === 'browse'
          ? 'Time check: you have been reasoning too long for a live website task. Call a browser tool now — browser_screenshot, browser_click_at, browser_type, browser_scroll, browser_select, or browser_find_text — and continue from the current page.'
          : isBuild
            ? 'Time check: you have been generating text for a while. Call a tool to make progress — image_search, create_file, append_file, export_pdf, or edit_file.'
            : 'Time check: extended reasoning detected. Call a tool to gather information or produce output. If you are stuck, try a different approach.'
        contextManager.push({ role: 'system', content: nudgeMessage } as unknown as ChatMessageParam)

        state.lastIterationEnd = Date.now()
        return 'STREAMING'
      }

      this.emitter.error('The task took too long to respond. Please try again.')
      return 'ERROR'
    }

    // Unknown errors — retry
    if (state.iterations < state.dynamicIterationLimit) {
      console.error('[Agent] Stream interrupted, retrying iteration...')
      state.lastIterationEnd = Date.now()
      state.iterationDelayMs = MIN_ITERATION_DELAY_MS
      return 'STREAMING'
    }
    this.emitter.error('The task stopped before it finished. Please try again.')
    return 'ERROR'
  }
}
