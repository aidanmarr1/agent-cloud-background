/**
 * AgentLoop — the main orchestrator for the AI agent.
 *
 * Simple while-loop architecture:
 *   PLANNING → STREAMING → EXECUTING_TOOLS → EVALUATING → STREAMING → ... → COMPLETE
 */

import {
  ASSISTANT_SUPPORTS_AUDIO_INPUT,
  ASSISTANT_SUPPORTS_FILE_INPUT,
  ASSISTANT_SUPPORTS_IMAGE_INPUT,
  ASSISTANT_SUPPORTS_VIDEO_INPUT,
  ASSISTANT_PROVIDER,
  createStreamingCompletion,
  type ChatContentPart,
  type ChatCompletionTool,
  type ChatMessageParam,
  type StreamingChatCompletionChunk,
} from '@/lib/llm'
import { toolDefinitions } from '@/lib/tools'
import { getSystemPrompt, estimateTaskComplexity, type StrategyHints } from '@/lib/prompts'
import { effectiveTaskRequest, isContextualTaskUpdate } from '@/lib/conversationContext'
import { createFileInSandbox, readFileInSandbox } from '@/lib/sandbox'
import { subscribeToBrowserFrames } from '@/lib/browser'
import { defaultFileActionLabel } from '@/lib/stream/ActivityDescriber'

import { sanitizeAgentEventEmitter, type AgentEventEmitter } from './SSEEmitter'
import {
  AgentStateData,
  createInitialState,
  updatePhase,
  advanceStep,
  trackFileCreate,
  logWork,
  recordWorkLedgerDeliverable,
  currentStepText,
  isCurrentSynthesisStep,
  isResearchStepText,
  stepOpenedSourceDomains,
  needsPhaseNarrationBeforeAdvance,
} from './AgentState'
import {
  acceptProgressNarration,
  beginNarrationCadenceAttempt,
  deferNarrationCadenceAttempt,
  finishNarrationCadenceAttempt,
  recentNarrationPromptExclusions,
  reviewProgressNarration,
  retryNarrationCadenceAfterNoProgress,
  retryNarrationCadenceAttemptWithoutNewAction,
  withCadenceProgressUpdateSchemas,
  workLogSinceAcceptedNarration,
} from './NarrationMemory'
import {
  MIN_ITERATION_DELAY_MS, MAX_TIMEOUT_NUDGES,
  STREAM_MAX_RETRIES, STREAM_RETRY_BASE_MS, STREAM_RETRY_EXPONENT,
  STREAM_REQUEST_TIMEOUT_MS, STREAM_RETRY_MAX_DELAY_MS,
  MAX_ATTACHMENT_CHARS, MAX_CONTEXT_ATTACHMENT_CHARS, MODEL_MAX_COMPLETION_TOKENS,
  TOOL_CACHE_MAX_ENTRIES, TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_SIZE_CHARS,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  MAX_ITERATIONS,
  AGENT_RUN_MAX_DURATION_MS, AGENT_DEADLINE_FINALIZATION_BUFFER_MS,
  AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS, AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
  NARRATION_MAX_VISIBLE_ACTION_GAP,
  NARRATION_REQUEST_AFTER_VISIBLE_ACTIONS,
} from './config'
import {
  carriedCadenceActionCount,
  StreamProcessor,
  type StreamResult,
  type StreamToolCallPolicy,
  type StreamUsage,
  type ToolCallData,
} from './StreamProcessor'
import { estimateConservativeMissingStreamUsage } from './StreamUsageEstimate'
import {
  PARTIAL_APPEND_RECOVERY_LIMIT_PER_PATH,
  ToolPipeline,
  partialAppendRecoveryCountForPath,
  type ToolExecutionResult,
} from './ToolPipeline'
import {
  decidePaidModelTurnProgress,
  type PaidModelTurnProgressSnapshot,
} from './PaidModelTurnProgress'
import {
  classifyDeterministicProviderRequestFailure,
  MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS,
  sanitizeProviderRequestMessagesForRetry,
} from './ProviderRequestFailure'
import { PolicyEngine } from './PolicyEngine'
import { PlanManager, type RequiredPlanStep } from './PlanManager'
import { isPromptInjection, type TierTimeouts } from './guards'
import {
  currentStepWebSearchLimit,
  explicitTaskToolTargetLabel,
  explicitTaskToolConstraintFromText,
  hasSingleWebSearchLimit,
  isFixedWebSearchInlineAnswerState,
  taskDefaultsToMarkdownDeliverable,
  toolAllowedByExplicitTaskConstraint,
  toolMatchesExplicitTaskToolTarget,
} from './taskConstraints'

import { resolveStrategy, computeIterationLimit, computeTimeouts, type TaskStrategyConfig } from './TaskStrategy'
import { ContextManager, hasCurrentModelEvidenceBatch } from './ContextManager'
import { ToolRegistry } from './ToolRegistry'
import type { InflightToolDrain } from './toolSafety'
import { scopeAgentTaskMessages } from './messageScope'
import { isNudgeableTimeout, TimeoutError } from './errors'

import { createAgentLogger } from './Logger'
import { ToolCache } from './ToolCache'
import { ToolRetry } from './ToolRetry'
import { ErrorRecoveryEngine } from './recovery/ErrorRecoveryEngine'
import { WorkingMemory } from './WorkingMemory'
import { ReflectionEngine } from './ReflectionEngine'
import { GoalTracker } from './GoalTracker'
import { OutputVerifier } from './OutputVerifier'
import { auditAgentCompletion, MISSING_FINAL_INLINE_ANSWER } from './CompletionAudit'
import {
  shouldDefaultFrontendToNextTsx,
  shouldDefaultFrontendToStandaloneHtml,
} from './frontendDefaults'
import { analyzeTaskIntent } from './TaskIntent'
import { taskRequiresSavedFinalArtifact } from './DeliverableContract'
import { getNextWebsiteProjectStatus } from '@/lib/tsxWebsitePreview'
import { OUT_OF_CREDITS_MESSAGE, type CreditTokenUsage } from '@/lib/creditPolicy'
import { assertServerCreditsAvailable, chargeServerTokenUsage, isOutOfCreditsError } from '@/lib/serverCredits'
import {
  drainLiveDirectives,
  sealLiveDirectiveRun,
  type LiveDirective,
} from '@/lib/liveDirectives'
import { MAX_DELIVERABLE_REVISIONS } from './config'
import type { StepAdvanceStatus } from '@/types'
import {
  hydrateResearchActivityIndex,
  loadResearchActivityEntries,
  normalizeResearchUrl,
  researchActivityContext,
} from './ResearchActivityLog'
import { userErrorMessage } from '@/lib/errorMessages'
import { cleanTaskSubjectText, humanTopicLabel } from './taskText'
import { hasCredibleResearchRecoveryPacket, researchDepthProfileForState } from './ResearchDepth'
import {
  assessBriefInlineRunResearchEvidence,
  assessBriefInlineResearchEvidence,
  briefInlineFinalDeliveryStepIndex,
  type BriefInlineResearchEvidenceAssessment,
} from './BriefInlineResearch'
import { toolTypeRateLimitForState } from './ToolLimits'
import { persistSandboxTaskFile } from '@/lib/taskFiles'

const PARALLEL_SOURCE_EXTRACTION_TOOL_NAMES = new Set(['read_document', 'http_request'])

function executedParallelSourceExtractionBatch(results: ToolExecutionResult[]): boolean {
  return results.length > 1 && results.every(result => PARALLEL_SOURCE_EXTRACTION_TOOL_NAMES.has(result.tc.name))
}

/**
 * Phase 12 Fix NNN: scan the user's most recent message for a URL or bare
 * domain. Returns the first match (full URL preferred over bare domain), or
 * null if none. Used by AgentLoop to give the model direct-target context while
 * preserving its full healthy tool menu and judgment about the best route.
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
    // Keep rejected-but-well-formed calls in the assistant envelope too: their
    // tool result messages explain the rejection and the provider protocol
    // still requires a matching assistant tool_call. Only the internal
    // malformed-JSON sentinel must be omitted because it was never executed.
    .filter(result => !isMalformedToolArgumentsRecovery(result))
    .map(result => result.tc)
    .filter(tc => requestedIds.has(tc.id))
    .map(tc => ({
      ...tc,
      arguments: toolArgumentsForProviderHistory(tc.arguments),
    }))
}

function isMalformedToolArgumentsRecovery(result: ToolExecutionResult): boolean {
  if (result.internalRecovery === 'malformed_tool_arguments') return true
  const error = result.result && typeof result.result === 'object'
    ? (result.result as { error?: unknown }).error
    : null
  return typeof error === 'string' && /^INTERNAL_RECOVERY:\s*malformed tool arguments\b/i.test(error)
}

function paidTurnProgressForIteration(
  progress: PaidModelTurnProgressSnapshot | null,
  iteration: number,
): PaidModelTurnProgressSnapshot | null {
  return progress?.iteration === iteration ? progress : null
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
  return message as ChatMessageParam
}

function approximateStreamUsageForCompletedTurn(
  model: string,
  requestMessages: ChatMessageParam[],
  result: Pick<StreamResult, 'assistantContent' | 'reasoningContent' | 'toolCalls'>,
  requestTools: unknown[] = [],
): StreamUsage {
  return estimateConservativeMissingStreamUsage({
    model,
    requestMessages,
    requestTools,
    assistantContent: result.assistantContent,
    reasoningContent: result.reasoningContent,
    toolCalls: [...result.toolCalls.values()],
  })
}

const FINAL_DELIVERABLE_WRITE_TOOLS = new Set(['create_file', 'create_website', 'append_file', 'edit_file', 'export_pdf', 'package_files'])
const FAST_SOURCE_ACTION_REQUEST_TIMEOUT_MS = 45_000
const FAST_ACTION_REQUEST_TIMEOUT_MS = 45_000
const FAST_ACTION_RETRY_REQUEST_TIMEOUT_MS = 60_000
const FAST_SOURCE_ACTION_ITERATION_TIMEOUT_MS = 60_000
const FAST_ACTION_ITERATION_TIMEOUT_MS = 60_000
// A fast action still needs enough first-token/inter-chunk headroom for normal
// routed-provider jitter. Cutting a healthy native tool envelope at 1.5s only
// buys another model turn and makes the task slower overall.
const FAST_SOURCE_ACTION_INACTIVITY_TIMEOUT_MS = 15_000
const FAST_ACTION_INACTIVITY_TIMEOUT_MS = 15_000
const FAST_ACTION_CONTENT_ONLY_TIMEOUT_MS = 3_000
const FAST_ACTION_CONTENT_ONLY_MIN_CHARS = 320
const INITIAL_STANDALONE_WEBSITE_ITERATION_TIMEOUT_MS = 180_000
const INITIAL_STANDALONE_WEBSITE_INACTIVITY_TIMEOUT_MS = 90_000
// Muse may spend part of this allowance on mandatory minimal reasoning before
// emitting a native tool call. A 260-token ceiling repeatedly cut otherwise
// tiny search JSON at the stream boundary, making the runtime pay for a full
// repair turn. Keep this far below synthesis budgets while leaving enough room
// for one complete action envelope (or the bounded three-source read batch).
const FAST_SOURCE_ACTION_MAX_TOKENS = 384
// Ordinary action-selection turns only need enough output for a complete
// native tool envelope. Reserving the model's full 65k report budget here made
// provider scheduling slower without adding useful capability. Full output
// capacity remains available for synthesis, reports, code, and deliverables.
const FAST_ACTION_MAX_TOKENS = 1_024
// A complete create_website envelope contains the page's full HTML, CSS, and
// JavaScript. The old 1k action cap clipped it, while the global 65k ceiling
// encouraged earlier provider routes to buffer an oversized function call for minutes. Live
// route validation shows 12k leaves ample room for a polished one-shot site
// while retaining a firm latency/cost boundary.
const INITIAL_STANDALONE_WEBSITE_MAX_TOKENS = 12_288
const FINAL_SAVED_DELIVERABLE_MODEL_START_TIMEOUT_CAP = 2
const PRESENTATION_REASONING = { effort: 'minimal' as const, exclude: true }
const FAST_ACTION_REASONING = { effort: 'minimal' as const, exclude: true }
const TASK_REASONING = { effort: 'minimal' as const, exclude: true }
const DEEP_TASK_REASONING = { effort: 'minimal' as const, exclude: true }
const SUBSTANTIVE_RESEARCH_RE = /\b(?:current\s+state|state\s+of|overview|landscape|ecosystem|real[-\s]?world\s+applications?|applications?|use\s+cases?|core\s+technolog(?:y|ies)|capabilities|trends?|impact|implications?)\b/i

function isAssistantRequestTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /Assistant request timed out after \d+ seconds/i.test(message) ||
    /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(message)
}

function isTransientAssistantStreamError(error: unknown): boolean {
  if ((error as { name?: string })?.name === 'AbortError') return false
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /\b(?:fetch failed|network|socket|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|temporarily unavailable)\b/i.test(message)
}

function isRetryableTaskInfrastructureInitializationError(error: unknown): boolean {
  return !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'RETRYABLE_TASK_INFRASTRUCTURE_INITIALIZATION'
}

function supportsProviderRequiredToolChoice(model: string): boolean {
  // The model ID is centrally pinned, including the balanced OpenRouter route.
  // Keep native action turns required for every pinned OpenRouter variant so a
  // provider route cannot silently return an empty prose turn instead of the
  // concrete tool call the active phase requires.
  return ASSISTANT_PROVIDER !== 'openrouter' || model.trim().length > 0
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
    return String((result.result as { path?: string } | undefined)?.path || args.path || args.output_path || args.source_path || '')
  } catch {
    return String((result.result as { path?: string } | undefined)?.path || '')
  }
}

const EXACT_EXTRACTION_SOURCE_TOOLS = new Set([
  'read_document',
  'http_request',
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
  /\b(?:exact(?:ly)?|wording|quote|verbatim|precise|visual(?:ly)?|rendered|screenshot|shown|displayed|on[-\s]?page)\b/i
const RENDERED_CONFIRMATION_NEED_PATTERN =
  /\b(?:visual(?:ly)?|rendered|screenshot|shown|displayed|on[-\s]?page)\b/i

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

function exactExtractionToolArgs(toolResult: ToolExecutionResult): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolResult.tc.arguments || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function exactExtractionHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function exactExtractionSourceUrl(toolResult: ToolExecutionResult): string | null {
  const args = exactExtractionToolArgs(toolResult)
  if (
    toolResult.tc.name === 'http_request' &&
    typeof args.method === 'string' &&
    !/^(?:GET|HEAD)$/i.test(args.method.trim())
  ) return null

  const result = toolResult.result && typeof toolResult.result === 'object'
    ? toolResult.result as Record<string, unknown>
    : null
  return exactExtractionHttpUrl(args.url) ||
    exactExtractionHttpUrl(args.source) ||
    exactExtractionHttpUrl(result?.source) ||
    exactExtractionHttpUrl(result?.url)
}

function exactExtractionResultHasEvidence(toolResult: ToolExecutionResult): boolean {
  if (toolResult.isError) return false
  const result = toolResult.result && typeof toolResult.result === 'object'
    ? toolResult.result as Record<string, unknown>
    : null
  if (result?.error || result?.success === false) return false
  if (
    typeof result?.status === 'number' &&
    (result.status < 200 || result.status >= 400)
  ) return false
  const evidence = result
    ? [result.content, result.body, result.text, result.title, result.screenshotPath, result.screenshotUrl]
      .filter(value => typeof value === 'string')
      .join('\n')
      .trim()
    : contentTextForGuard(toolResult.result).trim()
  return evidence.length > 0
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

function exactExtractionResultMatchesTask(
  toolResult: ToolExecutionResult,
  hints: string[],
): boolean {
  if (hints.length === 0) return true
  // Match against returned page evidence only. Action labels, tool arguments,
  // and source URLs often repeat the requested phrase even when the rendered
  // page did not contain it.
  const result = toolResult.result && typeof toolResult.result === 'object'
    ? toolResult.result as Record<string, unknown>
    : null
  const text = (result
    ? [result.content, result.body, result.text, result.title]
      .filter(value => typeof value === 'string')
      .join('\n')
    : contentTextForGuard(toolResult.result)
  ).toLowerCase()
  return hints.some(hint => text.includes(hint.toLowerCase()))
}

function exactExtractionInspectionPrompt(taskText: string): string {
  const hints = exactExtractionHints(taskText)
  const hintText = hints.length > 0
    ? `Search targeted rendered text first with browser_find_text using one of: ${hints.map(h => `"${h}"`).join(', ')}.`
    : 'Search targeted rendered text first with browser_find_text using the key phrase, value, or label from the current step.'

  return [
    'EXACT EXTRACTION REQUIRED BEFORE NARRATION: the request explicitly needs an exact or visually confirmed detail from the rendered page.',
    'Do not write a progress update, uncertainty paragraph, synthesis, or <next_step/> yet.',
    hintText,
    'If rendered text is incomplete or no text-node match appears, use browser_screenshot to inspect the visible value, browser_scroll to reveal it, or browser_get_content to refresh the rendered text.',
    'Make exactly one native browser_find_text, browser_screenshot, browser_get_content, or browser_scroll call now. After that result, answer from the verified evidence or continue the phase.',
  ].join(' ')
}

function exactExtractionNavigationPrompt(sourceUrl: string): string {
  return [
    'EXACT EXTRACTION REQUIRED BEFORE NARRATION: direct webpage extraction returned relevant evidence, and the request explicitly needs an exact or visually confirmed detail.',
    'Do not search for a replacement page or write a progress update yet.',
    `Open the same source in the rendered browser with browser_navigate using this exact URL verbatim: ${JSON.stringify(sourceUrl)}.`,
    'After it loads, inspect the targeted rendered text or visible value before narrating or advancing.',
    'Make exactly one native browser_navigate call now.',
  ].join(' ')
}

export function exactExtractionGuardToolNames(state: AgentStateData): ReadonlySet<string> {
  return state.exactExtractionGuardSourceUrl
    ? new Set(['browser_navigate'])
    : EXACT_EXTRACTION_TOOLS
}

function shouldArmExactExtractionGuard(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): { shouldArm: boolean; prompt: string | null; sourceUrl: string | null } {
  if (state.exactExtractionGuardPending || state.exactExtractionGuardAttempts >= 2) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }
  // Browser-action tasks already operate on live rendered state and must not be
  // interrupted by a research-only exact-detail detour.
  if (state.taskStrategy === 'browse') return { shouldArm: false, prompt: null, sourceUrl: null }

  const explicitToolConstraint = explicitTaskToolConstraintFromText(effectiveTaskRequest(messages))
  if (
    explicitToolConstraint &&
    !toolAllowedByExplicitTaskConstraint(explicitToolConstraint, 'browser_navigate')
  ) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }

  const taskText = currentTaskTextForGuard(state, messages)
  if (!EXACT_EXTRACTION_NEED_PATTERN.test(taskText)) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }

  const hints = exactExtractionHints(taskText)
  const source = toolResults.find(toolResult => {
    if (!EXACT_EXTRACTION_SOURCE_TOOLS.has(toolResult.tc.name)) return false
    if (!exactExtractionResultHasEvidence(toolResult)) return false
    return exactExtractionResultMatchesTask(toolResult, hints)
  })
  if (!source) return { shouldArm: false, prompt: null, sourceUrl: null }

  const directExtraction = source.tc.name === 'read_document' || source.tc.name === 'http_request'
  // Direct extraction already satisfies exact textual/data requests. Escalate
  // into the rendered browser only when the request itself calls for visual or
  // on-page confirmation; "exact" or "precise" alone is not enough.
  if (directExtraction && !RENDERED_CONFIRMATION_NEED_PATTERN.test(taskText)) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }
  const sourceUrl = directExtraction ? exactExtractionSourceUrl(source) : null
  // Local files and non-GET endpoints cannot be opened as the same rendered
  // webpage. Keep their successful extraction usable instead of inventing a
  // browser blocker with no exact route.
  if (directExtraction && !sourceUrl) {
    return { shouldArm: false, prompt: null, sourceUrl: null }
  }

  return {
    shouldArm: true,
    prompt: sourceUrl
      ? exactExtractionNavigationPrompt(sourceUrl)
      : exactExtractionInspectionPrompt(taskText),
    sourceUrl,
  }
}

function clearExactExtractionGuard(state: AgentStateData): void {
  state.exactExtractionGuardPending = false
  state.exactExtractionGuardPrompt = null
  state.exactExtractionGuardSourceUrl = null
}

function exactInspectionResultSatisfied(
  toolResult: ToolExecutionResult,
  taskText: string,
): boolean {
  if (!EXACT_EXTRACTION_TOOLS.has(toolResult.tc.name) || !exactExtractionResultHasEvidence(toolResult)) {
    return false
  }
  const resultText = contentTextForGuard(toolResult.result)
  if (toolResult.tc.name === 'browser_scroll') return false
  if (toolResult.tc.name === 'browser_find_text') {
    if (/\b(?:no visible text nodes matched|found\s+0\s+match|0\s+matches|text not found)\b/i.test(resultText)) {
      return false
    }
    return /\bfound\s+[1-9]\d*\s+match/i.test(resultText) ||
      exactExtractionResultMatchesTask(toolResult, exactExtractionHints(taskText))
  }
  if (toolResult.tc.name === 'browser_get_content') {
    return exactExtractionResultMatchesTask(toolResult, exactExtractionHints(taskText))
  }
  // A successful screenshot supplies the visual frame to the model itself.
  // The model must still report whether the target is actually visible; the
  // runtime records only that the requested visual inspection took place.
  return toolResult.tc.name === 'browser_screenshot'
}

export function updateExactExtractionGuardAfterTools(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): void {
  const pendingNavigationUrl = state.exactExtractionGuardPending
    ? state.exactExtractionGuardSourceUrl
    : null
  if (pendingNavigationUrl) {
    const navigation = toolResults.find(({ tc }) => tc.name === 'browser_navigate')
    if (!navigation) return
    const requestedUrl = exactExtractionSourceUrl(navigation)
    if (
      exactExtractionResultHasEvidence(navigation) &&
      requestedUrl === pendingNavigationUrl
    ) {
      state.exactExtractionGuardSourceUrl = null
      state.exactExtractionGuardPrompt = exactExtractionInspectionPrompt(
        currentTaskTextForGuard(state, messages),
      )
    } else {
      // Direct extraction is still usable. A failed or off-target browser open
      // must not become a permanent false blocker.
      clearExactExtractionGuard(state)
    }
    return
  }

  const taskText = currentTaskTextForGuard(state, messages)
  const completedGuardExtraction = state.exactExtractionGuardPending &&
    toolResults.some(toolResult => exactInspectionResultSatisfied(toolResult, taskText))

  if (completedGuardExtraction) {
    clearExactExtractionGuard(state)
    return
  }

  const nextGuard = shouldArmExactExtractionGuard(state, toolResults, messages)
  if (!nextGuard.shouldArm || !nextGuard.prompt) return

  state.exactExtractionGuardPending = true
  state.exactExtractionGuardPrompt = nextGuard.prompt
  state.exactExtractionGuardSourceUrl = nextGuard.sourceUrl
  state.exactExtractionGuardAttempts++
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
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
  if (path && result.tc.name !== 'export_pdf' && result.tc.name !== 'package_files') {
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
    .replace(/\b(?:qwen|openai|anthropic|google|meta|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
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

  if (assistantContent.trim()) {
    const accepted = acceptProgressNarration(state, assistantContent, {
      requireSignal: false,
      clearPhaseEndPending: true,
      resetCadence: true,
    })
    if (accepted.status === 'accepted') return false
  }
  return needsPhaseNarrationBeforeAdvance(state) && state.stepToolCallCount > 0
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
      `${reason}. Write one natural, result-first progress update containing the most useful finding, comparison, completed change, verified state, or real blocker from this phase, then put <next_step/> on its own final line.`,
      'Do not call another tool or merely repeat that pages were searched, opened, or read. Let the evidence determine whether this is one sentence, two sentences, or a brief paragraph; do not use a stock template.',
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

function isBudgetFinalizationResearchStep(state: AgentStateData, stepIdx: number): boolean {
  if (!state.currentPlanItems || stepIdx < 0 || stepIdx >= state.currentPlanItems.length - 1) return false
  if (state.taskStrategy === 'browse' || state.taskStrategy === 'creative') return false

  const stepText = [
    state.currentPlanItems[stepIdx] || '',
    state.currentPlanScopes?.[stepIdx] || '',
  ].join(' ')

  if (state.taskStrategy === 'build' || state.taskStrategy === 'code') {
    return isResearchStepText(stepText)
  }

  return state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    state.currentPhase === 'research' ||
    isResearchStepText(stepText)
}

function budgetFinalizationRequiresResearchIntegrity(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const text = [
    state.originalUserRequest || '',
    ...messages.map(message => message.content || ''),
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
  ].join(' ')

  return /\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|rigorous|extensive|full report|long report|serious analysis|strategic|technical|comparative|cited|citations?|sources?|source[-\s]?backed|evidence[-\s]?backed)\b/i.test(text) ||
    SUBSTANTIVE_RESEARCH_RE.test(text) ||
    taskDefaultsToMarkdownDeliverable(text)
}

function budgetFinalizationWouldSkipRequiredResearch(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (!budgetFinalizationRequiresResearchIntegrity(state, messages)) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length - 1) return false

  if (
    isBudgetFinalizationResearchStep(state, state.currentStepIdx) &&
    !compactResearchEvidenceComplete(state)
  ) {
    return true
  }

  for (let i = state.currentStepIdx + 1; i < state.currentPlanItems.length - 1; i++) {
    if (isBudgetFinalizationResearchStep(state, i)) return true
  }

  return false
}

function shouldStartIterationBudgetFinalization(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (state.deadlineFinalizationStarted) return false
  if (!state.dynamicIterationLimit) return false
  if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
  if (state.currentStepIdx >= state.currentPlanItems.length) return false
  if (budgetFinalizationWouldSkipRequiredResearch(state, messages)) return false

  const remainingIterations = state.dynamicIterationLimit - state.iterations
  return remainingIterations <= iterationBudgetFinalizationTriggerTurns(state, messages)
}

function iterationBudgetFinalizationMessage(state: AgentStateData, overrunStep: string): ChatMessageParam {
  return {
    role: 'system',
    content: [
      'ITERATION BUDGET FINALIZATION: stop source gathering and produce the final user-facing result now.',
      `The task spent too long on "${overrunStep}", so use the gathered evidence and clearly mention any important gaps inside the output.`,
      'Prioritize the final output now; avoid more research or optional verification unless one short action is genuinely necessary to make the requested result valid.',
      'If a file/report is required, make exactly one create_file call for the final output under deliverables/; continue with append_file only if the write is clipped.',
      'If the answer belongs in chat, write the answer directly now.',
    ].join(' '),
  } as ChatMessageParam
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  messages: Array<{
    id?: string
    timestamp?: number
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
  workerAttempt?: number
  recoveryAttempt?: number
  recoveryMode?: 'graceful_handoff' | 'stale_lease'
  recoveryContext?: string
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
  beforeDone?: () => Promise<void>
  registerInflightToolDrain?: (drain: InflightToolDrain) => void
  diagnostics?: (event: { type: string; data: Record<string, unknown> }) => void
}

// ── AgentLoop ───────────────────────────────────────────────────────────────

type Phase = 'PLANNING' | 'STREAMING' | 'EXECUTING_TOOLS' | 'EVALUATING' | 'COMPLETE' | 'ERROR'

const AUTOSAVE_DRAFT_MIN_CHARS = 1200
const FINAL_AUTOSAVE_DRAFT_MIN_CHARS = 600
const TEXT_ONLY_DRAFT_SAVE_VISIBLE_WAIT_MS = 3_500
const NON_REOPENABLE_LIVE_DIRECTIVE_TERMINAL_REASONS = new Set([
  'safety_leakage',
  'runtime_deadline',
  'runtime_deadline_finalized',
])
const NON_REOPENABLE_WEBSITE_TERMINAL_REASONS = new Set([
  'safety_leakage',
  'runtime_deadline',
  'runtime_deadline_finalized',
  'iteration_cap',
  'post_completion_rewrite',
  'step_blocked',
  'browser_stuck_step',
  'deliverable_verification_failed',
  'saved_deliverable_model_start_timeout',
  'deliverable_handoff_complete',
  'deliverable_handoff_fallback',
])
const SKILL_ATTACHMENT_TYPE = 'application/x-agent-skill'
const MAX_PLANNING_SKILL_CHARS = 18_000
const MAX_PLANNING_ATTACHMENT_CHARS = 12_000
const MAX_PRELOADED_ATTACHMENT_PANEL_CHARS = 5_000
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

function cleanDraftContent(content: string): string {
  return content
    .replace(/<next_step\s*\/?>/gi, '')
    .trim()
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
    // The final index alone is not proof that the earlier phases completed.
    // stepCompletionTimes is appended only by advanceStep(), so it is the
    // trustworthy sequential frontier. Never autosave premature prose as the
    // final artifact while an intermediate phase remains open.
    if (state.stepCompletionTimes.length < state.currentPlanItems.length - 1) return false
    // A text-only confirmation after the model has already written the final
    // artifact is not a second draft. Saving it as another deliverable leaves
    // the verified file's plan step open and can turn a successful run into a
    // paid no-progress failure.
    if (hasSavedFinalDeliverableCandidate(state)) return false
    const requestedMinimum = savedFinalDeliverableMinimumChars(state, messages)
    const recoveryMinimum = Math.min(FINAL_AUTOSAVE_DRAFT_MIN_CHARS, requestedMinimum)
    return text.length >= recoveryMinimum && taskNeedsSavedFinalArtifact(state, messages)
  }

  if (text.length < AUTOSAVE_DRAFT_MIN_CHARS) return false

  return state.currentPhase === 'build' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
}

function repairPrematureFinalStepJump(state: AgentStateData): boolean {
  const planLength = state.currentPlanItems?.length || 0
  if (planLength < 2 || state.currentStepIdx !== planLength - 1) return false
  if (state.stepCompletionTimes.length >= planLength - 1) return false
  if (hasSavedFinalDeliverableCandidate(state)) return false

  state.currentStepIdx = Math.min(state.stepCompletionTimes.length, planLength - 2)
  updatePhase(state)
  state.forceTextNextIteration = false
  state.phaseEndNarrationPending = false
  state.consecutiveNoToolCalls = 0
  return true
}

function requestedMarkdownDeliverablePath(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string | null {
  const request = state.originalUserRequest ||
    messages.filter(message => message.role === 'user').slice(-1)[0]?.content ||
    ''
  const matches = [
    ...request.matchAll(
      /\b(?:save|write|create|export|deliver|output)\b[^\n]{0,180}?\b((?:\.\/)?(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/gi,
    ),
    ...request.matchAll(
      /\b(deliverables\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/gi,
    ),
  ].sort((a, b) => (a.index || 0) - (b.index || 0))
  for (const match of matches.reverse()) {
    const path = match[1].replace(/^\.\//, '')
    if (
      path.length <= 240 &&
      !path.startsWith('/') &&
      !path.split('/').includes('..')
    ) {
      return path
    }
  }
  return null
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

function taskWantsZipArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return /\b(?:zip|archive|package(?:d)?\s+(?:files?|source|project))\b/i.test(`${currentToolIntentText(state)} ${userText}`)
}

function taskNeedsSavedFinalArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  return taskRequiresSavedFinalArtifact(state, effectiveTaskRequest(messages))
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
  const brief = /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple|one[-\s]?sentence|two[-\s]?sentence|in\s+\d+\s+sentences?)\b/.test(taskText)
  const inline = /\b(?:no file|no document|don't\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|answer\s+(?:directly|in chat|here)|just\s+answer)\b/.test(taskText)
  return (brief || inline) && !taskNeedsSavedFinalArtifact(state, messages)
}

function briefInlineResearchEvidenceAfterTools(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  results: ToolExecutionResult[],
): BriefInlineResearchEvidenceAssessment | null {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length - 1) return null
  if (!(state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.currentPhase === 'research')) return null
  if (!isBriefInlineDirectAnswerTask(state, messages)) return null
  const userText = messages
    .filter(message => message.role === 'user')
    .map(message => message.content)
    .join(' ')
  return assessBriefInlineResearchEvidence({
    request: state.originalUserRequest || userText,
    researchCalls: state.stepResearchCallCount,
    openedSourceUrls: state.stepVisitedUrls,
    sourceEvidence: state.workLedger.sources
      .filter(source => source.stepIdx === state.currentStepIdx && !!source.url)
      .map(source => ({ url: source.url!, title: source.title })),
    toolResults: results.map(result => ({
      toolName: result.tc.name,
      isError: result.isError,
      acceptedForExecution: result.acceptedForExecution,
    })),
  })
}

function isLeanFinalSynthesisStep(state: AgentStateData): boolean {
  return !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx === state.currentPlanItems.length - 1 &&
    state.currentPhase === 'deliver' &&
    (state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.taskStrategy === 'general') &&
    !state.buildTask
}

function isFinalDeliveryStep(state: AgentStateData): boolean {
  return !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx === state.currentPlanItems.length - 1 &&
    state.currentPhase === 'deliver'
}

function finalInlineAnswerTurn(state: AgentStateData, messages: Array<{ role: string; content: string }>): boolean {
  return isFinalDeliveryStep(state) && !taskNeedsSavedFinalArtifact(state, messages)
}

function finalBriefInlineResearchNeedsEvidenceAction(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (!finalInlineAnswerTurn(state, messages)) return false
  const request = state.originalUserRequest || effectiveTaskRequest(messages)
  // Plan advancement resets step-local counters. Reassess the evidence from
  // fresh, run-wide tool successes and sources actually opened in this run so
  // the final step neither repeats completed research nor trusts search-result
  // links or hydrated activity from an earlier run.
  const runEvidence = assessBriefInlineRunResearchEvidence({
    request,
    successfulToolTypeCounts: state.taskSuccessfulToolTypeCounts,
    openedSourceUrls: state.visitedUrls,
    sourceEvidence: state.workLedger.sources
      .filter(source => !!source.url)
      .map(source => ({ url: source.url!, title: source.title })),
  })
  if (runEvidence.ready) return false
  return /\b(?:research|search|look\s*up|find\s*out|current|latest|recent|source|fact|verify|evidence)\b/i.test(request)
}

function finalSavedResearchNeedsEvidenceAction(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  if (!finalSavedDeliverableTurn(state, messages)) return false
  const request = state.originalUserRequest || effectiveTaskRequest(messages)
  if (!/\b(?:research|search|look\s*up|find\s*out|current|latest|recent|source|citation|reference|credible|official|primary|fact|verify|evidence)\b/i.test(request)) {
    return false
  }
  return !assessBriefInlineRunResearchEvidence({
    request,
    successfulToolTypeCounts: state.taskSuccessfulToolTypeCounts,
    openedSourceUrls: state.visitedUrls,
    sourceEvidence: state.workLedger.sources
      .filter(source => !!source.url)
      .map(source => ({ url: source.url!, title: source.title })),
  }).ready
}

function shouldCompleteFinalInlineAnswerTurn(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  content: string,
): boolean {
  if (!finalInlineAnswerTurn(state, messages)) return false
  const text = content.trim()
  const request = state.originalUserRequest || effectiveTaskRequest(messages)
  const explicitlyRequestsShortLiteralAnswer =
    /\b(?:reply|respond|answer|output|return|say|write)\s+(?:(?:with|using)\s+)?(?:exactly|only)\b/i.test(request) ||
    /\b(?:reply|respond|answer|output|return|say|write)\s+(?:only\s+)?(?:the\s+)?(?:word|string|text|phrase)\b/i.test(request)
  if (text.length < 80 && !explicitlyRequestsShortLiteralAnswer) return false
  const startsLikeStatus =
    /^(?:i(?:'|’)?ll|i will|i am going to|we(?:'|’)?ll|let me|next,?\s+i|now,?\s+i)\b/i.test(text) ||
    /\blet me\b/i.test(text.slice(0, 240)) ||
    /\b(?:i|we)\s+(?:found|checked|searched|gathered|looked|reviewed)\b.{0,180}\b(?:but|so|next|instead)\b/i.test(text.slice(0, 260)) ||
    /\b(?:will|going to)\s+(?:research|gather|compare|summari[sz]e|investigate|check|look up|write|produce)\b/i.test(text.slice(0, 220))
  if (startsLikeStatus) return false
  return explicitlyRequestsShortLiteralAnswer ||
    /[.!?)]\s*$/.test(text) ||
    text.length >= FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS
}

const MAX_FINAL_INLINE_ANSWER_RECOVERY_ATTEMPTS = 2
const MAX_FINAL_SAVED_DELIVERABLE_RECOVERY_ATTEMPTS = 2
const MAX_TRUNCATED_FINAL_RESPONSE_REPAIR_ATTEMPTS = 2

function scheduleFinalInlineAnswerRecovery(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const planLength = state.currentPlanItems?.length || 0
  if (planLength === 0 || state.taskStrategy === 'browse') return false
  if (taskNeedsSavedFinalArtifact(state, messages)) return false
  if (state.finalInlineAnswerDelivered) return false
  const finalStepIdx = planLength - 1
  if (state.currentStepIdx < finalStepIdx) return false
  if (state.finalInlineAnswerRecoveryAttempts >= MAX_FINAL_INLINE_ANSWER_RECOVERY_ATTEMPTS) return false

  state.finalInlineAnswerRecoveryAttempts += 1
  state.currentStepIdx = finalStepIdx
  updatePhase(state)
  state.finalInlineAnswerDelivered = false
  state.forceTextNextIteration = false
  state.phaseEndNarrationPending = false
  state.consecutiveNoToolCalls = 0
  state.consecutiveNullStreams = 0
  state.toolJsonRecoveryCount = 0
  state.suppressedResearchToolName = null
  state.recentToolCalls = []
  state.recentToolSequence = []
  state.lastModelErrorForUser = null
  state.deadlineFinalizationStarted = false
  state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 2)
  return true
}

function scheduleFinalSavedDeliverableRecovery(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const planLength = state.currentPlanItems?.length || 0
  if (planLength === 0 || !taskNeedsSavedFinalArtifact(state, messages)) return false
  if (state.currentStepIdx < planLength - 1 || hasSavedFinalDeliverableCandidate(state)) return false
  if (state.finalSavedDeliverableRecoveryAttempts >= MAX_FINAL_SAVED_DELIVERABLE_RECOVERY_ATTEMPTS) return false

  state.finalSavedDeliverableRecoveryAttempts += 1
  state.currentStepIdx = planLength - 1
  updatePhase(state)
  state.forceTextNextIteration = false
  state.phaseEndNarrationPending = false
  state.consecutiveNoToolCalls = 0
  state.consecutiveNullStreams = 0
  state.toolJsonRecoveryCount = 0
  state.suppressedResearchToolName = null
  state.recentToolCalls = []
  state.recentToolSequence = []
  state.lastModelErrorForUser = null
  state.deadlineFinalizationStarted = false
  state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 3)
  return true
}

function finalSavedDeliverableTurn(state: AgentStateData, messages: Array<{ role: string; content: string }>): boolean {
  const compactSavedOutputStrategy =
    !state.buildTask &&
    state.taskStrategy !== 'build' &&
    state.taskStrategy !== 'code' &&
    state.taskStrategy !== 'creative'
  return isFinalDeliveryStep(state) &&
    compactSavedOutputStrategy &&
    taskNeedsSavedFinalArtifact(state, messages)
}

function shouldUseTextSavedFinalDeliverable(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  void state
  void messages
  // Never manufacture a filename from a plan title or local fallback. Saved
  // deliverables must arrive through the model's native file call, where the
  // model explicitly authors the topic-specific path.
  return false
}

function hasSavedFinalDeliverableCandidate(state: AgentStateData): boolean {
  return state.workLedger.deliverableCandidates.some(item => item.purpose === 'deliverable')
}

function latestSavedFinalDeliverablePath(state: AgentStateData): string | null {
  return state.workLedger.deliverableCandidates
    .filter(item => item.purpose === 'deliverable' && item.path)
    .slice(-1)[0]?.path || null
}

function pendingFinalDeliverableRevisionPath(state: AgentStateData): string | null {
  const path = state.pendingDeliverableRevision?.path?.trim()
  return path || null
}

function existingFinalDeliverablePath(state: AgentStateData): string | null {
  return pendingFinalDeliverableRevisionPath(state) || latestSavedFinalDeliverablePath(state)
}

function requireDeliverableInspectionBeforeRevision(
  state: AgentStateData,
  path: string,
): void {
  const target = path.trim()
  if (!target || target === 'the existing deliverable') return
  state.deliverableRevisionFailureCount = 0
  state.deliverableRevisionSnapshot = null
  state.fileWriteRepairPending = {
    path: target,
    reason: 'ambiguous_write',
    inspected: false,
  }
}

function deliverableRevisionLimit(state: AgentStateData): number {
  return state.buildTask || state.taskStrategy === 'build' || state.taskStrategy === 'code'
    ? MAX_DELIVERABLE_REVISIONS
    : 2
}

function hasBlockingDeliverableIntegrityFailure(failures: string[]): boolean {
  return failures.some(failure =>
    /empty or nearly empty|placeholder text|cut off or unfinished|duplicated substantive|duplicate numbered|structure restarts/i.test(failure),
  )
}

/**
 * Structural quality guidance is useful, but it must not turn an otherwise
 * readable saved report into an endless read/edit/append loop. After two
 * targeted report revisions, accept the artifact unless it is empty, clipped,
 * placeholder/outline-only, duplicated, or structurally restarted.
 */
function deliverableVerificationAccepted(
  state: AgentStateData,
  verification: { passed: boolean; failures: string[] },
): boolean {
  if (verification.passed) return true
  return state.deliverableRevisionCount >= deliverableRevisionLimit(state) &&
    !hasBlockingDeliverableIntegrityFailure(verification.failures)
}

function savedFinalDeliverableMinimumChars(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): number {
  const taskText = `${state.originalUserRequest || ''} ${currentToolIntentText(state)} ${messages.map(m => m.content).join(' ')}`.toLowerCase()
  const originalRequest = state.originalUserRequest || ''
  const artifactRequest = originalRequest.replace(
    /\b(?:keep|make)\s+(?:the\s+)?final\s+(?:response|reply|answer|message|handoff)\s+(?:very\s+)?(?:brief|quick|short|concise|succinct)\b/gi,
    ' ',
  )
  const requestLooksBrief = /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple)\b/i.test(artifactRequest) ||
    /\b(?:one|two|three|four|five|\d+)[-\s]+sentences?\b/i.test(originalRequest) ||
    /\b\d{1,5}\s*(?:\+?\s*)?words?\b/i.test(originalRequest)
  const compactNamedDataArtifact = !!requestedMarkdownDeliverablePath(state, messages) &&
    !/\b(?:report|research|analysis|assessment|essay|memo|briefing|white\s+paper)\b/i.test(originalRequest) &&
    [
      /\btitle\b/i,
      /\b(?:source\s+)?url\b/i,
      /\blink\b/i,
      /\bstatus\b/i,
      /\bvalue\b/i,
      /\bresult\b/i,
    ].filter(pattern => pattern.test(originalRequest)).length >= 2
  if (/\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|rigorous|extensive|full report|long report|serious analysis|technical)\b/.test(taskText)) {
    return 4_800
  }
  if (requestLooksBrief || compactNamedDataArtifact) {
    // A clean, explicitly concise artifact must not be expanded merely to hit
    // a generic report-length floor. Whole-file verification still checks its
    // requested structure, substance, placeholders, duplicates, and ending.
    return 50
  }
  return 2_600
}

function savedDeliverableChunkEndsCleanly(content: string): boolean {
  const text = content.trim()
  if (!text) return false
  const fenceCount = (text.match(/```/g) || []).length
  if (fenceCount % 2 === 1) return false
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const lastLine = lines[lines.length - 1] || ''
  if (!lastLine) return false
  if (/^\|.+\|\s*$/.test(lastLine)) return true
  if (/^(?:[-*+]|\d+\.)\s+\S/.test(lastLine)) return true
  const stripped = lastLine.replace(/[\])}"'`*_]+$/g, '').trim()
  return /[.!?:;]$/.test(stripped)
}

function shouldContinueSavedFinalDeliverableChunk(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
  path: string,
  content: string,
): boolean {
  if (!finalSavedDeliverableTurn(state, messages)) return false
  if (!path || !path.toLowerCase().endsWith('.md')) return false
  if (state.deliverableRevisionCount >= deliverableRevisionLimit(state)) return false
  const minimumChars = savedFinalDeliverableMinimumChars(state, messages)
  if (content.trim().length < minimumChars) return true
  // A deliberately tiny named Markdown artifact (for example a title + source
  // URL check) should go straight to the real verifier once it reaches its
  // truthful minimum. Requiring prose punctuation here caused nonsensical
  // 350–650 word appends to already-complete bullet/value files.
  if (minimumChars <= 50) return false
  return !savedDeliverableChunkEndsCleanly(content)
}

function isPartialRecoveryClosingAppendTurn(state: AgentStateData): boolean {
  const pending = state.partialFileWriteRecoveryPending
  return !!pending &&
    state.deliverableRevisionCount >= deliverableRevisionLimit(state) &&
    partialAppendRecoveryCountForPath(state, pending.path) >= PARTIAL_APPEND_RECOVERY_LIMIT_PER_PATH
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
      : 'Use create_file for the final saved output. Choose a concise topic-specific filename yourself unless the user supplied an exact path; never copy the plan-step title or use a generic fallback filename.'
  const chunkGuidance = !pending && !existingPath
    ? 'For the first create_file call, write one coherent complete Markdown deliverable whenever it fits. Do not deliberately stop after the introduction or first section; append_file is only for a genuinely clipped or still-incomplete saved file.'
    : 'Append the next complete, substantive section only—normally 350–650 words when that much content remains, or all remaining content when less remains. Do not repeat existing headings, claims, citations, or paragraphs, and never dribble out a tiny fragment.'

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

function finalDeliverableHandoffPrompt(state: AgentStateData): string {
  const pending = state.finalDeliverableHandoffPending
  const request = state.originalUserRequest?.trim()
  const target = pending?.path || 'the completed deliverable'
  return [
    'PERSONALIZED FINAL HANDOFF NOW: the requested artifact is complete and verified.',
    request ? `Original request: ${request}` : '',
    `Completed artifact: ${target}.`,
    'Write the user-facing final response now with no tool call.',
    'Tailor it to this exact task: lead with the real outcome, then mention the most useful concrete findings, design choices, behavior, caveats, or usage detail from the completed work.',
    'If one or more files are attached below, make it clear in natural task-specific wording that the user can open those attachments, and identify what they contain when useful.',
    'Choose the length and structure from the task and completed context. A sentence, several paragraphs, headings, bullets, or another clear shape are all acceptable; do not force the same layout across tasks.',
    'Write natural completion prose in your own words. Do not copy a plan-step title or form broken phrases such as "I finished synthesize"; use grammatical past-tense wording.',
    'Avoid falling back to the same stock handoff sentence across tasks. Do not repeat the whole deliverable or narrate internal steps, source counts, tool calls, verification mechanics, or phases.',
    'Use natural Markdown only when it helps and finish cleanly.',
  ].filter(Boolean).join(' ')
}

function finalDeliverableHandoffHasInvalidForm(
  content: string,
  state: AgentStateData,
): boolean {
  const text = content.trim()
  if (!text || !/[A-Za-z0-9]/.test(text)) return true
  if (/^(?:i(?:'|’)?ll|i will|i am going to|let me)\b/i.test(text)) return true
  if (/\bi (?:have )?finished\s+(?:synthesize|write|create|compile|generate|produce|build|draft|prepare|research|analyze|summarize)\b/i.test(text)) {
    return true
  }

  const normalize = (value: string) => value
    .toLowerCase()
    .replace(/[*_`#()[\]{}.!?:;,/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const activeStep = state.currentPlanItems?.[state.currentStepIdx] || ''
  if (activeStep && normalize(text) === normalize(activeStep)) return true

  return false
}

function finalDeliverableHandoffLooksUseful(
  content: string,
  state: AgentStateData,
): boolean {
  const text = content.trim()
  if (text.length < 24) return false
  if (finalDeliverableHandoffHasInvalidForm(text, state)) return false
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const lastLine = lines.at(-1) || ''
  if (/^(?:#{1,6}\s+|[-+*]|\d+[.)]?)$/.test(lastLine)) return false
  if (/[,;:\-–—/]$/.test(lastLine)) return false
  if (/\b(?:and|or|of|the|with|to|for|in|on|at|from|key)$/i.test(lastLine)) return false
  if ((text.match(/```/g) || []).length % 2 !== 0) return false
  return true
}

function shouldAcceptFinalDeliverableHandoff(
  content: string,
  attemptNumber: number,
  state: AgentStateData,
): boolean {
  const text = content.trim()
  return finalDeliverableHandoffLooksUseful(text, state) ||
    (
      text.length >= 16 &&
      attemptNumber >= 2 &&
      !finalDeliverableHandoffHasInvalidForm(text, state)
    )
}

function verifiedFinalPhaseNaturalHandoffPath(
  state: AgentStateData,
  content: string,
): string | null {
  if (state.finalDeliverableHandoffPending) return null
  if (!state.deliverableVerificationDone) return null
  if (state.pendingDeliverableRevision || state.fileWriteRepairPending || state.partialFileWriteRecoveryPending) return null
  if (!state.currentPlanItems || state.currentStepIdx !== state.currentPlanItems.length - 1) return null

  const path = latestSavedFinalDeliverablePath(state)
  if (!path || !shouldAcceptFinalDeliverableHandoff(content, 1, state)) return null

  const text = content.trim()
  const explicitlyContinuing = /\b(?:next\s+i(?:'|’)?ll|next\s+i\s+will|i\s+(?:still\s+)?need\s+to|i(?:'|’)?ll\s+(?:now\s+)?continue|i\s+will\s+(?:now\s+)?continue|remaining\s+(?:work|steps?|tasks?|actions?)|proceeding\s+to)\b/i.test(text)
  if (explicitlyContinuing) return null

  // This is an LLM-authored completion decision, not a runtime-generated
  // fallback. A natural saved/ready/attached handoff after whole-file
  // verification is equivalent to an internal phase marker and should end the
  // task instead of being followed by generic read/grep verification loops.
  const completionCue = /\b(?:complete|completed|finished|ready|saved|created|built|delivered|attached|available|open|download|review)\b/i.test(text)
  return completionCue ? path : null
}

function shouldRejectBuildTextOnlyEmission(
  state: AgentStateData,
  result: Pick<StreamResult, 'assistantContent' | 'toolCalls' | 'stepAdvancedThisIteration'>,
): boolean {
  if (result.toolCalls.size > 0 || result.stepAdvancedThisIteration) return false
  if (state.finalDeliverableHandoffPending) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (!(state.taskStrategy === 'build' || state.taskStrategy === 'code')) return false

  const text = result.assistantContent.trim()
  if (!text) return false
  const codeOrFalseCompletion =
    /```(?:tsx?|jsx?|css|html)?\b/i.test(text) ||
    /\b(?:import\s+React|export\s+default\s+function|className=|What Was Built|I have created|I(?:'|’)ve created|fully responsive|website is complete)\b/i.test(text)

  return state.currentPhase === 'build' || codeOrFalseCompletion
}

function isInitialStandaloneWebsiteCreateTurn(state: AgentStateData): boolean {
  return (state.currentPhase === 'build' || state.currentPhase === 'deliver') &&
    shouldDefaultFrontendToStandaloneHtml(state.originalUserRequest || '') &&
    !normalizedCreatedFileSet(state.createdFiles).has('index.html')
}

function hasCompleteInitialStandaloneWebsiteCreateCall(
  result: Pick<StreamResult, 'toolCalls'>,
): boolean {
  const calls = [...result.toolCalls.values()]
  if (calls.length !== 1 || calls[0].name !== 'create_website') return false

  try {
    const args = JSON.parse(calls[0].arguments) as {
      html?: unknown
      css?: unknown
      javascript?: unknown
    }
    const html = typeof args.html === 'string' ? args.html.trim() : ''
    const css = typeof args.css === 'string' ? args.css.trim() : ''
    return html.length >= 120 &&
      css.length >= 80 &&
      typeof args.javascript === 'string' &&
      /<(?:html|body|main)\b/i.test(html) &&
      /\{[\s\S]*?\}/.test(css)
  } catch {
    return false
  }
}

function standaloneWebsiteRequiresPostBuildAction(request: string): boolean {
  return /\b(?:deploy|publish|host|\.zip|zip file|archive|compressed package|test|testing|verify|validate|inspect|qa|audit|debug|benchmark)\b/i.test(request)
}

function continueFinalPhaseAfterVerifiedArtifact(
  state: AgentStateData,
  path: string,
  contextManager: ContextManager,
): void {
  state.fileWriteRepairPending = null
  state.pendingDeliverableRevision = null
  state.partialFileWriteRecoveryPending = null
  state.partialFileWriteRecoveryNudged = false
  state.deliverableRevisionFailureCount = 0
  state.deliverableRevisionSnapshot = null
  state.deliverableVerificationDone = true
  state.forceTextNextIteration = false
  state.phaseEndNarrationPending = false
  state.consecutiveNoToolCalls = 0
  state.consecutiveNullStreams = 0
  state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 3)
  contextManager.push({
    role: 'system',
    content: `VERIFIED OUTCOME: "${path}" is already saved and has passed whole-file integrity checks. Do not re-read it or run generic verification commands for work the runtime has already verified. Treat it as one completed outcome, then use the model-authored phase scope and latest user direction to decide naturally whether anything explicitly requested remains. If the requested phase is complete, give the user the task-specific final handoff now with no tool call; that natural handoff is the completion decision. If a distinct requested action, artifact, integration, or test remains, perform only that relevant work before the handoff.`,
  } as ChatMessageParam)
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
    'When the answer is longer than a few sentences, use natural Markdown structure: a clear heading, short sections or bullets where useful, and readable paragraphs. Never output one merged wall of text, repeat the title inside a paragraph, or stop mid-sentence.',
  ].filter(Boolean).join(' ')
}

function finalSavedDeliverablePrompt(state: AgentStateData): string {
  const request = state.originalUserRequest?.trim()
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the final deliverable'
  const pendingPartial = state.partialFileWriteRecoveryPending
  if (pendingPartial) {
    const boundedClosingAppend = isPartialRecoveryClosingAppendTurn(state)
    return [
      `PARTIAL FILE CONTINUATION NOW: make exactly one native append_file call to "${pendingPartial.path}" immediately.`,
      request ? `User request: ${request}.` : '',
      `Current final task: ${step}.`,
      `The existing file already contains ${pendingPartial.lines} lines / ${pendingPartial.chars} characters from a recovered clipped write.`,
      'Begin the tool call immediately; do not internally outline, narrate, or wait to draft a full report before starting the append_file arguments.',
      'Do not call create_file, edit_file, read_file, list_files, export_pdf, or any research/browser tool.',
      'Do not write visible prose, a status update, a plan, a source summary, or a permission question.',
      boundedClosingAppend
        ? 'This is the only permitted closing append. Add only the most important missing closing material in roughly 180–300 words, then stop at a clean sentence or section boundary.'
        : 'Append only the next missing complete, substantive section—normally 350–650 words when that much remains, or all remaining content when less remains. End cleanly at a sentence or section boundary; never stop mid-sentence.',
      'Do not repeat existing headings, claims, citations, or paragraphs, and do not emit <next_step/> until after a successful append clears this partial-file state.',
    ].filter(Boolean).join(' ')
  }
  const existingPath = existingFinalDeliverablePath(state)
  if (existingPath) {
    if (state.fileWriteRepairPending && !state.fileWriteRepairPending.inspected) {
      return [
        `FINAL SAVED DELIVERABLE INSPECTION NOW: make exactly one native read_file call for "${state.fileWriteRepairPending.path}" immediately.`,
        request ? `User request: ${request}.` : '',
        `Current final task: ${step}.`,
        'A structural revision is required, but the exact current file contents must be refreshed before editing.',
        'Do not append, edit, recreate, search, narrate, or emit <next_step/> on this turn.',
        'After this one read, revise the same file in place and re-run whole-file verification.',
      ].filter(Boolean).join(' ')
    }
    const revision = state.pendingDeliverableRevision
    if (!revision) {
      return [
        `SAVED DELIVERABLE VERIFICATION BOUNDARY: "${existingPath}" already exists.`,
        request ? `User request: ${request}.` : '',
        `Current final task: ${step}.`,
        'Do not rewrite, append, recreate, or inspect the file with another tool.',
        'Write one brief, natural user-facing confirmation that the saved deliverable is ready, then stop.',
        'Do not mention internal verification, phases, ledgers, retries, or tool mechanics.',
      ].filter(Boolean).join(' ')
    }
    const duplicatedPassageFailure = revision.failures.some(failure =>
      /\bduplicat(?:e|ed|ion)\b/i.test(failure),
    )
    const structuralRevision = revision.failures.some(failure =>
      /\b(?:outline|heading|paragraph|citation|structure|restart|order|cut off|unfinished)\b/i.test(failure),
    )
    return [
      `FINAL SAVED DELIVERABLE REVISION NOW: make exactly one native append_file or edit_file call to "${existingPath}" immediately.`,
      request ? `User request: ${request}.` : '',
      `Current final task: ${step}.`,
      revision?.failures?.length ? `Fix these verification failures: ${revision.failures.join('; ')}.` : '',
      revision?.suggestions?.length ? `Use these suggestions: ${revision.suggestions.join('; ')}.` : '',
      'Do not call create_file, do not create a second report, do not write visible prose, and do not emit <next_step/>.',
      duplicatedPassageFailure
        ? 'This is a duplication repair: use edit_file to remove the repeated copy while preserving the single complete passage. Do not append anything.'
        : structuralRevision
          ? 'This is a structural/content repair: use edit_file to revise the existing report in place. Use append_file only when genuinely missing material belongs after the current last section and will not restart the report structure.'
          : 'Use edit_file for targeted corrections. Use append_file only when genuinely missing material belongs at the current end of the file.',
      revision.failures.some(failure => /citation|source|url/i.test(failure))
        ? 'Add inline [n] markers beside supported claims with edit_file. Append a References or Sources section only when the file does not already have one and it belongs at the true end.'
        : '',
      'For professional research/report Markdown, use a clear title, an opening synthesis, substantive topic-specific sections, a conclusion, and references where evidence requires them. Adapt headings and numbering to the request instead of forcing a template.',
      'End cleanly at a sentence or section boundary.',
    ].filter(Boolean).join(' ')
  }
  return [
    'FINAL SAVED DELIVERABLE NOW: make exactly one native file tool call immediately.',
    request ? `User request: ${request}.` : '',
    `Current final task: ${step}.`,
    'Begin the tool call immediately; do not internally outline, narrate, or wait to draft the whole deliverable before starting the file-tool arguments.',
    'Do not write a status update, plan, source summary, or permission question.',
    'Use create_file for the first saved output; use append_file only after that file exists and only when additional content is genuinely needed; use edit_file only for a targeted fix.',
    'For reports, research findings, and substantial write-ups, create a .md file under deliverables/ unless the user named a different path.',
    'Choose a concise topic-specific report filename in the create_file path. Never copy the plan-step title and never use output.md, report.md, draft.md, or another runtime fallback.',
    'For create_file and append_file, put action_label, plan_step_index, and path before content so the visible file action starts immediately.',
    'For the first create_file call, write one coherent complete Markdown deliverable whenever it fits. For a professional report, synthesize substantive prose under topic-specific headings, include an opening summary and conclusion when useful, and cite researched claims with a references section. Adapt the structure to the request rather than mechanically filling a template.',
    'Do not deliberately stop after the introduction or first section. Use append_file only if the provider genuinely clips the write or the saved file is still missing necessary material, and always end each write at a clean sentence or section boundary.',
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
    'Use the gathered evidence and include enough substance for the task.',
    'Structure the Markdown cleanly with one title, useful section headings, short readable paragraphs, and bullets or a table where they improve clarity. For research reports, include an executive summary, conclusions, and a references section with source URLs when available. Never merge headings into body text, duplicate passages, or stop mid-sentence.',
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
  if (isCurrentSynthesisStep(state)) return false
  if (state.currentPhase === 'deliver') return false
  if (isInitialStandaloneWebsiteCreateTurn(state)) return false

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

function userRequestedRepeatedSourceExtraction(state: AgentStateData): boolean {
  return /\b(?:exhaustive(?:ly)?|all\s+(?:the\s+)?(?:results?|sources?|links?|pages?)|every\s+(?:result|source|link|page)|open\s+(?:and\s+)?read\s+(?:them\s+)?all|extract\s+(?:them\s+)?all|read\s+every)\b/i
    .test(state.originalUserRequest || '')
}

function sourceExtractionBatchConsumedForLatestSearch(state: AgentStateData): boolean {
  if (userRequestedRepeatedSourceExtraction(state)) return false
  const searchCount = state.stepSearchQueries.size
  return searchCount > 0 &&
    state.stepLastSourceExtractionSearchCount === searchCount
}

function shouldUseNaturalCadenceNarration(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  // Exact-extraction and compact-text guards may defer the preferred action-3
  // update, but they must not push a real visible action beyond the hard
  // action-4 window. Tool availability is finalized later; if a guarded turn
  // is genuinely text-only, the cadence attempt is released at this frontier.
  const hardWindowOpen =
    state.visibleToolActionsSinceLastNarration >= NARRATION_MAX_VISIBLE_ACTION_GAP - 1
  if (
    (state.forceTextNextIteration || state.exactExtractionGuardPending) &&
    !hardWindowOpen
  ) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.narrationCadenceInFlight) return false
  if (state.visibleToolActionsSinceLastNarration < state.narrationNextAttemptAt) return false
  // Saved-file writes are still visible work. Long reports may require several
  // create/append actions, so keep the same LLM-authored 3–4 action narration
  // cadence active while those chunks stream. Only a single inline final answer
  // has no intermediate action cluster to narrate.
  if (finalInlineAnswerTurn(state, messages)) return false
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
  if (state.finalDeliverableHandoffPending) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: FINAL_DELIVERABLE_HANDOFF_ITERATION_TIMEOUT_MS,
      inactivityTimeoutMs: FINAL_DELIVERABLE_HANDOFF_INACTIVITY_TIMEOUT_MS,
      contentOnlyTimeoutMs: 1_200,
      contentOnlyMinChars: 80,
    }
  }
  if (isInitialStandaloneWebsiteCreateTurn(state)) {
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: Math.max(
        state.tierTimeouts.iterationTimeoutMs,
        INITIAL_STANDALONE_WEBSITE_ITERATION_TIMEOUT_MS,
      ),
      inactivityTimeoutMs: Math.max(
        state.tierTimeouts.inactivityTimeoutMs,
        INITIAL_STANDALONE_WEBSITE_INACTIVITY_TIMEOUT_MS,
      ),
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
      // A saved report streams its body inside the native file arguments. The
      // final-write window is therefore a minimum allowance, not a cap. Using
      // Math.min here silently reduced research reports to the generic 25s
      // strategy timeout, clipping healthy model streams into repeated partial
      // create/append recovery turns.
      iterationTimeoutMs: Math.max(state.tierTimeouts.iterationTimeoutMs, FINAL_SAVED_DELIVERABLE_ITERATION_TIMEOUT_MS),
      inactivityTimeoutMs: Math.max(state.tierTimeouts.inactivityTimeoutMs, FINAL_SAVED_DELIVERABLE_INACTIVITY_TIMEOUT_MS),
      contentOnlyTimeoutMs: FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_TIMEOUT_MS,
      contentOnlyMinChars: FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_MIN_CHARS,
    }
  }
  if (isFastActionToolTurn(state, messages)) {
    const sourceAction = isFastSourceActionToolTurn(state, messages)
    return {
      ...state.tierTimeouts,
      iterationTimeoutMs: Math.min(
        state.tierTimeouts.iterationTimeoutMs,
        sourceAction ? FAST_SOURCE_ACTION_ITERATION_TIMEOUT_MS : FAST_ACTION_ITERATION_TIMEOUT_MS,
      ),
      inactivityTimeoutMs: Math.min(
        state.tierTimeouts.inactivityTimeoutMs,
        sourceAction ? FAST_SOURCE_ACTION_INACTIVITY_TIMEOUT_MS : FAST_ACTION_INACTIVITY_TIMEOUT_MS,
      ),
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
    const actionLabelProperty = compactProperties.action_label
    if (actionLabelProperty && typeof actionLabelProperty === 'object' && !Array.isArray(actionLabelProperty)) {
      compactProperties.action_label = {
        ...(actionLabelProperty as Record<string, unknown>),
        description: 'Specific mini-objective: verb + named target + intended evidence/output; never only page, article, source, query, or details.',
      }
    }
    const planStepProperty = compactProperties.plan_step_index
    if (planStepProperty && typeof planStepProperty === 'object' && !Array.isArray(planStepProperty)) {
      const { description: _description, ...rest } = planStepProperty as Record<string, unknown>
      compactProperties.plan_step_index = rest
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

function shouldUseCompactResearchRecoveryTools(state: AgentStateData): boolean {
  if (!shouldUseCompactResearchTurn(state)) return false
  if (!compactResearchNeedsToolAction(state)) return false
  return state.consecutiveNoToolCalls > 0 ||
    (state.stepToolCallCount > 0 && state.stepResearchCallCount === 0)
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

function assistantSupportsNativeAttachment(attachment: AgentAttachment): boolean {
  if (attachment.type.startsWith('image/')) return ASSISTANT_SUPPORTS_IMAGE_INPUT
  if (attachment.type.startsWith('video/')) return ASSISTANT_SUPPORTS_VIDEO_INPUT
  if (attachment.type.startsWith('audio/')) return ASSISTANT_SUPPORTS_AUDIO_INPUT
  if (attachment.type === 'application/pdf') return ASSISTANT_SUPPORTS_FILE_INPUT
  return false
}

function nativeMultimodalUploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return uploadedAttachments(messages).filter((attachment) => (
    !!attachment.content &&
    attachment.contentEncoding === 'data-url' &&
    assistantSupportsNativeAttachment(attachment)
  ))
}

function dataUrlBase64Payload(dataUrl: string): string {
  const separator = dataUrl.indexOf(',')
  return separator >= 0 ? dataUrl.slice(separator + 1) : dataUrl
}

function audioFormatForAttachment(attachment: AgentAttachment): string {
  const extension = attachment.name.split('.').pop()?.toLowerCase()
  if (extension && /^[a-z0-9]{2,8}$/.test(extension)) return extension
  return attachment.type.split('/')[1]?.split(';')[0] || 'wav'
}

function nativeAttachmentContentPart(attachment: AgentAttachment): ChatContentPart | null {
  const content = attachment.content
  if (
    !content ||
    attachment.contentEncoding !== 'data-url' ||
    !assistantSupportsNativeAttachment(attachment)
  ) return null
  if (attachment.type.startsWith('image/')) {
    return {
      type: 'image_url',
      image_url: { url: content, detail: 'high' },
    }
  }
  if (attachment.type === 'application/pdf') {
    return {
      type: 'file',
      file: {
        filename: attachment.name,
        file_data: content,
      },
    }
  }
  if (attachment.type.startsWith('audio/')) {
    return {
      type: 'input_audio',
      input_audio: {
        data: dataUrlBase64Payload(content),
        format: audioFormatForAttachment(attachment),
      },
    }
  }
  if (attachment.type.startsWith('video/')) {
    return {
      type: 'video_url',
      video_url: { url: content },
    }
  }
  return null
}

function uploadedAttachmentNames(messages: AgentLoopOptions['messages']): string[] {
  return [...new Set(uploadedAttachments(messages).map((attachment) => attachment.name).filter(Boolean))]
}

function describeAttachmentForContext(attachment: AgentAttachment): string {
  const size = attachment.size > 0 ? `, ${Math.round(attachment.size / 1024)} KB` : ''
  const sandboxPath = attachment.sandboxPath ? `, sandbox path: ${attachment.sandboxPath}` : ''
  if (attachment.type.startsWith('image/')) return `Image: ${attachment.name} (${attachment.type}${size})`
  if (attachment.type.startsWith('audio/')) return `Audio: ${attachment.name} (${attachment.type}${size}${sandboxPath})`
  if (attachment.type.startsWith('video/')) return `Video: ${attachment.name} (${attachment.type}${size}${sandboxPath})`
  if (attachment.type === 'application/pdf') return `PDF: ${attachment.name} (${attachment.type}${size}${sandboxPath})`
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
    } else if (assistantSupportsNativeAttachment(attachment)) {
      sections.push([
            `Attachment ${attachment.name} is already available as native multimodal input at runtime.`,
            'Inspect the uploaded content directly.',
            'Do not create browser/open/current-view/read_file/web_search steps for its filename.',
          ].join(' '))
    } else if (attachment.sandboxPath) {
      sections.push(`Attachment ${attachment.name} is not a native input modality for this model route. Inspect its exact sandbox path with the appropriate document or terminal tool; do not search the web for its filename.`)
    } else {
      sections.push(`No extracted text is currently loaded for ${attachment.name}. If runtime still lacks content, report that this uploaded file could not be read instead of searching the web for the filename.`)
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
  const attachments = uploadedAttachments(messages).filter((attachment) => !(
    attachment.contentEncoding === 'data-url' &&
    !!attachment.content &&
    assistantSupportsNativeAttachment(attachment)
  ))
  if (attachments.length === 0) return []

  const names = [...new Set(attachments.map((attachment) => attachment.name).filter(Boolean))]
  const readableName = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '')
  const firstReadable = attachments.find(isReadableAttachmentContent)
  const hasVisualImages = false
  const hasNativeMultimodal = false
  const hasTextOnlyImages = !ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments(messages).length > 0
  const hasSandboxUploads = attachments.some(attachment => !!attachment.sandboxPath)
  const contentPreview = firstReadable?.content
    ? firstReadable.content.slice(0, MAX_PRELOADED_ATTACHMENT_PANEL_CHARS)
    : hasVisualImages
      ? 'Uploaded image visual content is available as high-detail model input. No browser opening, current-view extraction, or filename search is required.'
      : hasTextOnlyImages
        ? 'Uploaded image metadata was loaded, but this model route cannot inspect the image pixels directly.'
    : hasNativeMultimodal
      ? 'Uploaded image, PDF, audio, or video content is available as native multimodal model input.'
      : 'Uploaded attachment metadata was loaded, but no extracted text was available in context.'
  const titlePrefix = hasVisualImages
    ? `Visually inspect uploaded image${names.length === 1 ? '' : 's'}`
    : `Read uploaded attachment${names.length === 1 ? '' : 's'}`
  const scope = hasNativeMultimodal
    ? 'Runtime preflight only: uploaded image, PDF, audio, or video bytes are already loaded as native multimodal input in the model context. Inspect the attached content directly. Do not plan browser/open/current-view/read_file/web_search steps for its filename. Use web/browsing only if the user explicitly asks for outside/current information beyond the attachment.'
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
  content: string | ChatContentPart[]
}

export function preprocessMessagesForAgentContext(messages: AgentLoopOptions['messages']): AgentContextMessage[] {
  return messages.map(m => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content }
    }

    const hasUploadedAttachments = m.attachments.some(a => a.type !== SKILL_ATTACHMENT_TYPE)
    const nativeMultimodalAttachments = m.attachments.filter(a => (
      a.contentEncoding === 'data-url' &&
      !!a.content &&
      (
        a.type.startsWith('image/') ||
        a.type.startsWith('audio/') ||
        a.type.startsWith('video/') ||
        a.type === 'application/pdf'
      )
    ))
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

    if (nativeMultimodalAttachments.length > 0) {
      textContent += '\n\nUse the attached multimodal content below directly; do not claim the attachment was unavailable.'
      const parts: ChatContentPart[] = [
        { type: 'text', text: textContent },
      ]
      for (const att of nativeMultimodalAttachments) {
        const part = nativeAttachmentContentPart(att)
        if (part) parts.push(part)
      }
      return { role: m.role, content: parts }
    }

    if (nativeMultimodalAttachments.length > 0) {
      textContent += '\n\nThe current route could not inspect the uploaded multimodal bytes directly. Use the sandbox copy with an appropriate document or terminal tool.'
    }

    const metadataOnlyAttachments = m.attachments.filter(a =>
      a.type !== SKILL_ATTACHMENT_TYPE &&
      !nativeMultimodalAttachments.includes(a) &&
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

  return {
    missingFiles: [
      hasPage ? '' : 'app/page.tsx',
      hasLayout ? '' : 'app/layout.tsx',
      hasStyles ? '' : 'app/globals.css',
    ].filter(Boolean),
    structureIssues: [],
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
  const expectsNext = shouldDefaultFrontendToNextTsx(originalRequest)
  const expectsStandalone = shouldDefaultFrontendToStandaloneHtml(originalRequest)
  if (!expectsNext && !expectsStandalone) return null

  if (expectsStandalone) {
    const created = normalizedCreatedFileSet(state.createdFiles)
    if (!created.has('index.html')) {
      return 'WEBSITE COMPLETION BLOCKED: The requested website has not been created. Make exactly one create_website call with complete HTML, CSS, and JavaScript. The runtime will save the editable source set and bundle it into a self-contained index.html. Do not read, list, verify, or append website files before creating them.'
    }
    return null
  }

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

    return `WEBSITE COMPLETION BLOCKED: The requested website is not a complete renderable Next.js/TSX build. ${details} Create or edit the actual website files now: app/page.tsx, app/layout.tsx importing './globals.css', and substantive app/globals.css. Reusable components are optional when page.tsx is already cohesive; do not create parallel header/navigation variants merely to satisfy structure.`
  }

  return null
}

function maxTokensForIteration(state: AgentStateData): number {
  const maxNormalOutputTokens = MODEL_MAX_COMPLETION_TOKENS
  const maxBuildOutputTokens = MODEL_MAX_COMPLETION_TOKENS
  const maxDeliverableOutputTokens = MODEL_MAX_COMPLETION_TOKENS
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
  if (isCurrentSynthesisStep(state)) return false
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

function pendingExplicitToolTargets(state: AgentStateData): string[] {
  const constraint = explicitTaskToolConstraintFromText(state.originalUserRequest || '')
  if (!constraint) return []
  return constraint.required.filter(target =>
    ![...state.taskSuccessfulToolTypeCounts.keys()].some(toolName =>
      toolMatchesExplicitTaskToolTarget(target, toolName)
    )
  )
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
  if (toolCall.name === 'browse_page' || toolCall.name.startsWith('browser_')) return true
  if (toolCall.name === 'read_document') {
    const args = parsedToolCallArgs(toolCall)
    return sourceLooksLocal(args.url || args.source)
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
  if (Array.isArray(content)) {
    return content
      .map(part => part.type === 'text' ? part.text : '')
      .filter(Boolean)
      .join('\n')
  }
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

function compactInitialStandaloneWebsiteMessages(
  state: AgentStateData,
  allMessages: ChatMessageParam[],
  customInstructions?: string,
): ChatMessageParam[] {
  const latestUserMessage = [...allMessages].reverse().find(message => message.role === 'user')
  const request = state.originalUserRequest ||
    (latestUserMessage ? messageText(latestUserMessage.content).trim() : '') ||
    'Build the requested website.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'Build the website'
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx]?.trim()
  const boundedCustomInstructions = customInstructions?.trim().slice(0, 2_400)
  const latestUserText = latestUserMessage ? messageText(latestUserMessage.content).trim() : ''
  const requestContext = latestUserText && request.includes(latestUserText)
    ? ''
    : `Complete request context: ${request.slice(0, 4_000)}`

  return [
    {
      role: 'system',
      content: [
        'INITIAL WEBSITE BUILD REQUIRED: TOOL CALL ONLY.',
        'Use the available create_website function exactly once to create the complete first working version now.',
        'Return semantic HTML, responsive CSS, and only the JavaScript the experience actually needs.',
        'Make the result polished and faithful to the user request and any attached reference content.',
        'Keep the source concise enough for one reliable tool call: HTML must stay between 4,000 and 7,000 characters, CSS between 4,000 and 7,000 characters, JavaScript at or below 1,500 characters, and the complete tool arguments at or below about 16,000 characters.',
        'Do not use data URIs, embedded base64, long SVG paths, duplicated sections, repeated declarations, filler, visible status prose, or any other tool.',
        `Active build task: ${currentStep.slice(0, 500)}.`,
        currentScope ? `Design/build brief: ${currentScope.slice(0, 1_600)}` : '',
        requestContext,
        boundedCustomInstructions ? `Applicable custom instructions:\n${boundedCustomInstructions}` : '',
      ].filter(Boolean).join('\n\n'),
    },
    latestUserMessage || {
      role: 'user',
      content: request,
    },
  ]
}

function compactExplicitTerminalActionMessages(
  state: AgentStateData,
  allMessages: ChatMessageParam[],
): ChatMessageParam[] {
  const latestUserMessage = [...allMessages].reverse().find(message => message.role === 'user')
  const request = state.originalUserRequest ||
    (latestUserMessage ? messageText(latestUserMessage.content).trim() : '') ||
    'Complete the requested terminal action.'
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'Complete the terminal action'

  return [
    {
      role: 'system',
      content: [
        'SANDBOX TERMINAL ACTION REQUIRED: TOOL CALL ONLY.',
        'A real Linux terminal and execution environment are available.',
        'Call execute_command now with the shortest safe command that directly completes the request.',
        'Do not claim the terminal is unavailable, do not give the user instructions to run locally, and do not write prose before the command.',
        `Current action: ${currentStep.slice(0, 500)}.`,
      ].join(' '),
    },
    {
      role: 'user',
      content: request.slice(0, 4_000),
    },
  ]
}

function compactFinalDeliverableHandoffMessages(
  state: AgentStateData,
  allMessages: ChatMessageParam[],
  customInstructions?: string,
): ChatMessageParam[] {
  const pending = state.finalDeliverableHandoffPending
  const recentEvidence = recentNarrationToolEvidence(allMessages, 4)
  const recentWork = state.workLog
    .slice(-6)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const planSummary = (state.currentPlanItems || []).slice(0, 6)
  const boundedCustomInstructions = customInstructions?.trim().slice(0, 1_600)

  return [
    {
      role: 'system',
      content: [
        finalDeliverableHandoffPrompt(state),
        boundedCustomInstructions ? `Applicable custom instructions:\n${boundedCustomInstructions}` : '',
      ].filter(Boolean).join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `Original request: ${state.originalUserRequest || latestUserMessageText(allMessages) || 'Complete the requested task.'}`,
        `Completed attachment: ${pending?.path || 'the completed deliverable'}`,
        planSummary.length ? `Requested outcome:\n- ${planSummary.join('\n- ')}` : '',
        recentEvidence.length ? `Latest verified tool results:\n- ${recentEvidence.join('\n- ')}` : '',
        recentWork.length ? `Completed work:\n- ${recentWork.join('\n- ')}` : '',
        state.createdFiles.size > 0 ? `Saved files: ${[...state.createdFiles].slice(-8).join(', ')}` : '',
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

function recentNarrationToolEvidence(messages: ChatMessageParam[], limit = 3): string[] {
  return messages
    .filter(message => message.role === 'tool')
    .slice(-limit)
    .map(message => messageText(message.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(text => text.slice(0, 280))
}

function compactForcedNarrationMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'current step'
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx]
  const recentActions = workLogSinceAcceptedNarration(state)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const currentFinding = state.stepFindings.get(state.currentStepIdx)
  const recentToolEvidence = recentNarrationToolEvidence(allMessages)
  const browserEvidence = state.browserTaskCompletionEvidence.slice(-3)
  const visualObservations = state.workLedger.visualObservations
    .slice(-3)
    .map(item => `${item.title || item.url || item.tool}: ${item.detail}`)
  const previousNarrations = recentNarrationPromptExclusions(state)

  const context = [
    `User request: ${state.originalUserRequest || latestUserMessageText(allMessages) || 'not available'}`,
    `Active phase: ${state.currentStepIdx + 1}/${state.currentPlanItems?.length || 1} - ${currentStep}`,
    currentScope ? `Phase scope: ${currentScope}` : '',
    recentActions.length ? `New visible work since the last accepted update:\n- ${recentActions.join('\n- ')}` : 'No new work-log entries are available; do not restate an earlier update.',
    recentToolEvidence.length ? `Newest tool-result evidence — use this before any cumulative summary:\n- ${recentToolEvidence.join('\n- ')}` : '',
    currentFinding ? `Active-phase background — use only to interpret the new delta, never to repeat the running conclusion:\n- ${currentFinding}` : '',
    browserEvidence.length ? `Browser completion evidence:\n- ${browserEvidence.join('\n- ')}` : '',
    visualObservations.length ? `Recent browser/page observations:\n- ${visualObservations.join('\n- ')}` : '',
    previousNarrations.length ? `Already shown — do not repeat or paraphrase these claims:\n- ${previousNarrations.join('\n- ')}` : '',
    'This narration-only request has no selected next action. Keep it result-only; do not infer an action from the next plan phase.',
  ].filter(Boolean).join('\n\n')

  const narrationInstruction = [
    state.phaseEndNarrationPending
      ? 'FAST PHASE-END PROGRESS NARRATION ONLY.'
      : 'FAST PROGRESS NARRATION ONLY.',
    'Do not solve, plan, browse, search, write files, or call tools.',
    'Write one natural progress update from the compact context only.',
    'Treat it as a progressive evidence trace: select the newest delta, not the cumulative task conclusion.',
    'Size the update to the evidence: one sentence for a clear finding, two when a contrast or implication matters, or a short paragraph for a dense milestone.',
    'Lead with a fact-dense new result and connect it naturally to the completed work. Preserve material uncertainty, disagreement, or an evidence gap. Choose the wording freely: a direct factual subject, first-person confirmation, or concise review/finding lead can all be natural, and a source-action lead is valid when it immediately carries the concrete result or important provenance. Do not force a stock opening or repeat the recent updates.',
    'Because this asynchronous narration-only request has no selected next action, keep it result-only. Do not add a future-action sentence or infer an action from the following plan phase.',
    'No permission questions, internal step numbers, action counts, source dumps, vague sufficiency claims, or command fragments.',
    'Describe only user-visible findings, completed changes, or real blockers. Never mention providers, APIs, service names, quotas, rate limits, tools, tool results, payloads, JSON, parsing, truncation, download confirmations, caches, retries, runtime/backend state, call IDs, or other implementation mechanics.',
    state.phaseEndNarrationPending ? 'Put <next_step/> on its own final line after the paragraph.' : '',
  ].filter(Boolean).join(' ')

  return [
    {
      role: 'system',
      content: narrationInstruction,
    },
    {
      role: 'user',
      content: context || 'Write a concise progress update from the recent completed work.',
    },
  ]
}

function compactResearchRemainingCandidates(state: AgentStateData): string[] {
  const visited = new Set(
    [...state.stepVisitedUrls]
      .filter(Boolean)
      .map(normalizeResearchUrl),
  )
  const failed = new Set(
    state.workLedger.failedRoutes
      .filter(route => route.stepIdx === state.currentStepIdx && /^https?:\/\//i.test(route.target))
      .map(route => normalizeResearchUrl(route.target)),
  )
  const seen = new Set<string>()
  const candidates: string[] = []

  for (const result of state.workLedger.searchResults) {
    if (result.stepIdx !== state.currentStepIdx || !result.url.trim()) continue
    const normalized = normalizeResearchUrl(result.url)
    if (!normalized || seen.has(normalized) || visited.has(normalized) || failed.has(normalized)) continue
    seen.add(normalized)
    const title = result.title?.replace(/\s+/g, ' ').trim().slice(0, 100)
    candidates.push(title ? `${title} — ${result.url}` : result.url)
    if (candidates.length >= 5) break
  }

  return candidates
}

function cadenceNarrationMainTurnGuidance(state: AgentStateData): string {
  const newWork = workLogSinceAcceptedNarration(state)
    .slice(-6)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const alreadyShown = recentNarrationPromptExclusions(state, 8)
  return [
    'CADENCE ACTION TURN: make the next concrete native tool call immediately. Do not emit ordinary assistant prose before or after it.',
    'Every available tool schema includes a required, non-empty progress_update. Use it to synthesize the newest useful outcome from the completed actions immediately above this call: a finding, comparison or implication, verified artifact/UI state, completed change, or real blocker.',
    'Lead with a fact-dense outcome and make it continue naturally from the completed work immediately above. Carry forward only context needed to show what changed, and state material uncertainty, disagreement, or an evidence gap instead of smoothing it away. The visible action pills already show operations, so do not use an operation or vague purpose such as "to expand the evidence base" as the outcome. A concise source-action lead is valid when it immediately carries the concrete finding or important provenance. Avoid hype, praise, criticism, and unsupported evaluative adjectives. The current tool has not returned yet, so never invent what it will find.',
    'If work is continuing, add an immediate useful direction only when it helps orient the user; omit it at phase completion, when the next move is obvious, or when no concrete direction is selected. Vary the syntax to fit the result: a direct factual subject, first-person confirmation, or concise review/finding lead can all be natural. Do not copy a fixed opening, transition, or sentence count. Never output future-only narration, promise an uncertain result, substitute a broad later-phase plan for the new completed result, or repeat/paraphrase an already-shown update. Do not mention providers, APIs, service names, retries, quotas, rate limits, action/tool/search counts, internal steps, or ask permission to continue.',
    'progress_update is display-only. The runtime will place it immediately before this native action starts. It summarizes only the preceding completed work, so do not claim that the current action succeeded or returned evidence. Still complete every normal required tool argument and make the tool call immediately.',
    newWork.length ? `New completed work to synthesize (use its outcomes, not its action labels):\n- ${newWork.join('\n- ')}` : 'Use the concrete completed tool-result context already in the conversation. If evidence access failed, state that user-relevant blocker and the alternate evidence route—not that a search or page-open happened.',
    alreadyShown.length ? `Already shown — exclude these claims:\n- ${alreadyShown.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')
}

function cadenceNarrationActionRetryMessage(reason: string): string {
  return [
    `CADENCE ACTION RETRY: ${reason}.`,
    'Retry the same active phase now in the ordinary action-selection turn.',
    'Make exactly one concrete native tool call. In progress_update, summarize a genuinely new finding, verified state, completed change, or real blocker from the preceding completed actions; do not restate or claim a result from the current tool operation. It will be shown immediately before that action starts.',
    'Do not output ordinary prose, planning, speculation, a future-only action fragment, or narration without a tool call.',
  ].join(' ')
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
  const remainingCandidates = compactResearchRemainingCandidates(state)

  const context = [
    `User request: ${request}`,
    `Active phase: ${state.currentStepIdx + 1}/${state.currentPlanItems?.length || 1} - ${currentStep}`,
    currentScope ? `Phase scope: ${currentScope}` : '',
    memoryText,
    remainingCandidates.length ? `Remaining candidate URLs (not yet opened or failed):\n- ${remainingCandidates.join('\n- ')}` : '',
    recentSources.length ? `Recent sources/results:\n- ${recentSources.join('\n- ')}` : '',
    recentActions.length ? `Recent completed work:\n- ${recentActions.join('\n- ')}` : '',
    findings.length ? `Completed findings:\n- ${findings.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  const actionInstruction = compactResearchEvidenceComplete(state)
    ? 'The runtime has confirmed this phase has enough opened-source evidence. Write one concise result-first progress paragraph and emit <next_step/>.'
    : 'This phase still needs evidence. Make one concrete native research tool call now. Do not write progress prose, a final answer, or <next_step/> in this response.'

  return [
    {
      role: 'system',
      content: `COMPACT RESEARCH TURN. Continue from the compact task state below; do not ask to see the full transcript and do not repeat completed source actions. Tool caps are ceilings, never targets: do not chase available search/extraction budget once the phase has a credible evidence packet. Use targeted web_search for the next missing evidence gap, then read_document on the strongest candidate URL. If strong candidate URLs are already available, read the best one instead of searching again. ${actionInstruction} Use browser navigation only when rendered state, interaction, screenshots, or page scripts are necessary.`,
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
  if (isCurrentSynthesisStep(state)) return false
  if (state.currentStepIdx === state.currentPlanItems.length - 1 && state.currentPhase === 'deliver') return false
  return true
}

function compactResearchNeedsToolAction(state: AgentStateData): boolean {
  return !compactResearchEvidenceComplete(state)
}

function canAdvanceResearchAfterPaidNoProgress(state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length - 1) return false
  if (currentStepWebSearchLimit(state) !== null || hasSingleWebSearchLimit(state)) return false
  const researchLike = state.currentPhase === 'research' ||
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    isResearchStepText(currentStepText(state))
  if (!researchLike) return false
  if (hasCredibleResearchRecoveryPacket(state)) return true

  // A normal research phase may already have a useful cross-source packet
  // when one sibling source is blocked and the model then emits no next
  // action. At the paid no-progress boundary, two successfully opened,
  // distinct sources are enough to advance this ordinary phase rather than
  // fail the entire task. Deep/wide work retains the stricter recovery floor.
  const depth = researchDepthProfileForState(state)

  // A first-party claims/ingredients extraction phase is complete once the
  // supplied authoritative page has been opened and read. Task-wide depth must
  // not force duplicate reads of that one page; independent evidence belongs
  // in the later evaluation phases.
  const activeStep = currentStepText(state)
  const singleAuthoritativeClaimsPacket =
    /\bextract\b/i.test(activeStep) &&
    /\b(?:claims?|ingredients?|specifications?|features?|manufacturer|product)\b/i.test(activeStep) &&
    state.stepResearchCallCount >= 2 &&
    state.stepToolCallCount >= 2 &&
    state.stepVisitedUrls.size >= 1 &&
    stepOpenedSourceDomains(state).size >= 1
  if (singleAuthoritativeClaimsPacket) return true

  // A later evidence angle can exhaust several distinct searches while its
  // review/catalog pages reject extraction. When earlier phases already opened
  // real sources, retain that verified task-level evidence and advance after a
  // substantial multi-domain discovery packet instead of throwing away the
  // entire answer. Explicit wide research remains strict.
  const hasPriorOpenedEvidence =
    state.currentStepIdx > 0 &&
    state.visitedUrls.size > state.stepVisitedUrls.size
  const exhaustedLaterPhaseDiscoveryPacket =
    depth.label !== 'wide' &&
    hasPriorOpenedEvidence &&
    state.stepResearchCallCount >= 4 &&
    state.stepToolCallCount >= 6 &&
    state.stepSearchQueries.size >= 4 &&
    state.stepSourceDomainCounts.size >= 3
  if (exhaustedLaterPhaseDiscoveryPacket) return true

  if (depth.label === 'deep' || depth.label === 'wide') return false

  const multiSourcePacket = state.stepResearchCallCount >= 3 &&
    state.stepVisitedUrls.size >= 2 &&
    stepOpenedSourceDomains(state).size >= 2
  if (multiSourcePacket) return true

  // Ordinary brand/product lookups often have one authoritative first-party
  // page while sibling catalog URLs block extraction. If the model has already
  // spent a broad action packet, found candidates across domains, opened one
  // real page, and then stops producing actions, preserve that direct evidence
  // and advance instead of failing the whole task at the paid retry boundary.
  const authoritativeCurrentPhasePacket = state.stepResearchCallCount >= 4 &&
    state.stepToolCallCount >= 6 &&
    state.stepVisitedUrls.size >= 1 &&
    stepOpenedSourceDomains(state).size >= 1 &&
    state.stepSourceDomainCounts.size >= 2 &&
    state.stepFailureCount >= 1
  if (authoritativeCurrentPhasePacket) return true

  // In later phases of an ordinary overview, retain the opened evidence from
  // completed phases when the current angle has a multi-domain search packet
  // but its concrete source-opening route fails and the model exhausts its
  // bounded action repair. This is never available to the first phase or to
  // deep/wide work, so a snippets-only task still cannot finish as researched.
  return hasPriorOpenedEvidence &&
    state.stepResearchCallCount >= 1 &&
    state.stepToolCallCount >= 2 &&
    state.stepSearchQueries.size >= 1 &&
    state.stepSourceDomainCounts.size >= 2
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
  // Two distinct failures from the current candidate pool reopen discovery.
  // The next executed search clears this set and makes its new pool eligible
  // for source-opening requirements again.
  if (state.stepFailedSourceTargets.size >= 2) return false
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

  const credibleCalls = Math.min(
    requiredResearchCalls,
    Math.max(5, Math.ceil(requiredResearchCalls * 0.4)),
  )
  const credibleOpenedPages = Math.min(
    requiredOpenedPages,
    Math.max(3, Math.ceil(requiredOpenedPages * 0.6)),
  )
  const credibleDomains = Math.min(
    requiredSourceBreadth,
    Math.max(3, Math.ceil(requiredSourceBreadth * 0.6)),
  )
  const credibleEvidencePacket =
    state.stepResearchCallCount >= credibleCalls &&
    openedPages >= credibleOpenedPages &&
    distinctDomains >= credibleDomains
  const repeatedResearchLoop =
    state.stepLoopDetections >= 2 ||
    state.stepToolCallCount >= Math.max(12, credibleCalls * 3)

  if (hasDirectEvidence && compactResearchBreadthSaturated(state, depth)) return true
  if (hasDirectEvidence && (state.consecutiveNoToolCalls >= 3 || repeatedResearchLoop)) {
    if (
      credibleEvidencePacket
    ) {
      return true
    }
  }
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
  const boundedClosingAppend = isPartialRecoveryClosingAppendTurn(state)
  const existingPath = existingFinalDeliverablePath(state)
  const pendingRepairRead = state.fileWriteRepairPending && !state.fileWriteRepairPending.inspected
  const revisionSnapshot = existingPath && state.deliverableRevisionSnapshot?.path === existingPath
    ? state.deliverableRevisionSnapshot.content
    : ''
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
    !pendingPartial && existingPath ? `Existing saved deliverable: ${existingPath}.` : '',
    !pendingPartial && state.pendingDeliverableRevision?.failures?.length ? `Verification failures:\n- ${state.pendingDeliverableRevision.failures.join('\n- ')}` : '',
    !pendingPartial && state.pendingDeliverableRevision?.suggestions?.length ? `Revision suggestions:\n- ${state.pendingDeliverableRevision.suggestions.join('\n- ')}` : '',
    !pendingPartial && revisionSnapshot
      ? `Exact current saved-file contents (copy old_string verbatim from this text):\n\n${revisionSnapshot}`
      : '',
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
            boundedClosingAppend
              ? 'This is the one permitted closing append after repeated clipped writes. Add only the most important missing closing material, roughly 180–300 words, and finish at a clean sentence or section boundary.'
              : 'Append the next missing complete, substantive section only—normally 350–650 words when that much remains, or all remaining content when less remains. End cleanly at a sentence or section boundary; never stop mid-sentence.',
            'Do not repeat existing headings, claims, citations, or paragraphs.',
            'Do not emit <next_step/> until after a successful append clears the partial-file state.',
          ].join(' ')
        : existingPath
          ? pendingRepairRead
            ? [
                'FINAL SAVED DELIVERABLE INSPECTION TOOL CALL ONLY.',
                `Make exactly one native read_file call for "${state.fileWriteRepairPending!.path}" now; do not write visible prose before it.`,
                'Do not call create_file, append_file, edit_file, research tools, browser tools, or emit <next_step/> on this turn.',
                'The current contents must be refreshed once before the targeted in-place revision.',
              ].join(' ')
            : [
              'FINAL SAVED DELIVERABLE REVISION TOOL CALL ONLY.',
              `Make exactly one native append_file or edit_file call to "${existingPath}" now; do not write visible prose before it.`,
              'Do not call create_file, read-only research tools, browser tools, or emit <next_step/>.',
              revisionSnapshot
                ? 'The exact current file is included below. For edit_file, copy a short unique old_string verbatim from it—never paraphrase, abbreviate, or invent the match text.'
                : 'Use the retained current file state to make the smallest reliable in-place revision.',
              'Prefer edit_file for structural changes, substantive paragraph revisions, duplicate removal, and inline citation placement. Use append_file only when genuinely missing material belongs after the current last section and no equivalent terminal section already exists.',
              'For professional research/report Markdown, preserve one coherent title, an opening synthesis, substantive topic-specific sections, a conclusion, and references where evidence requires them. Adapt headings and numbering to the request instead of forcing a template.',
              'Start the file tool call immediately and end the new content cleanly at a sentence or section boundary.',
            ].join(' ')
        : [
            'FINAL SAVED DELIVERABLE TOOL CALL ONLY.',
            'Make exactly one native create_file or append_file call now; do not write visible prose before it.',
            'Start the file tool call immediately; do not spend a hidden pass outlining the deliverable first.',
            'For the first saved output, use create_file with action_label, plan_step_index, and path before content. Do not choose append_file unless the same file was already created and more content is actually required.',
            'For reports, research findings, and substantial write-ups, create a .md file under deliverables/ unless the user named a different path.',
            'Choose a concise topic-specific filename yourself in the create_file path. Never derive it from the plan-step title and never use a generic fallback filename.',
            state.stepToolCallCount > 0 && !hasSavedFinalDeliverableCandidate(state)
              ? 'A previous final-write turn did not save a deliverable; make a shorter complete create_file call now instead of continuing to reason.'
              : '',
            'Write one coherent complete deliverable in the first create_file call whenever it fits. Do not deliberately split a normal report into create-plus-append stages. Use append_file only if the provider genuinely clips the write or necessary material is still missing, and end every write at a clean sentence or section boundary.',
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
        'Use one title, clear section headings, short readable paragraphs, and bullets or a table where they improve clarity. For a research report, include an executive summary, conclusions, and a references section with source URLs when available. Never merge a heading into body prose, duplicate the report inside itself, or end mid-sentence.',
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
    'Retry the current step immediately with exactly one native tool call using strict JSON object arguments, or finish directly only if the current plan no longer requires a tool.',
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
    ? 'Recovery mode is active: choose one focused evidence action from the full healthy tool menu. A targeted web_search may help with a missing angle; when candidate URLs already exist, up to 3 parallel read_document/http_request source extractions may be efficient. Use another available tool when it better closes the actual evidence gap.'
    : 'Choose the most useful source/search/browser/document action for this specific step; if independent candidate URLs already exist, you may use up to 3 parallel read_document/http_request calls. Use strict JSON object arguments.'
  return [
    'RESEARCH TOOL REQUIRED:',
    `Continue "${step}" with an appropriate evidence tool call now; for independent source URLs, up to 3 parallel source extraction calls are allowed.`,
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
  return typeof value === 'string' && (
    /display contract repair needed before executing this action/i.test(value) ||
    /tool call was skipped because (?:it declared )?plan_step_index\b/i.test(value)
  )
}

function isSynthesisFinalizationRecoveryResult(result: ToolExecutionResult): boolean {
  const value = result.result && typeof result.result === 'object'
    ? (result.result as { error?: unknown }).error
    : undefined
  return typeof value === 'string' &&
    /^INTERNAL_RECOVERY:/i.test(value) &&
    /\b(?:final synthesis\/deliverable phase|for synthesizing, writing, or delivering)\b/i.test(value)
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
    'Replace only action_label with a fresh model-authored mini-objective, usually 3-24 words. Start with a capital letter and do not end with a period. Name the concrete subject plus the intended evidence, output, state, or verification; never only a page, article, source, query, or details. No first person, tool names, raw URL/path, or past-tense summary.',
    'Make the native tool call now with no prose.',
  ].join(' ')
}

const FINAL_INLINE_ANSWER_REQUEST_TIMEOUT_MS = 60_000
const FINAL_INLINE_ANSWER_ITERATION_TIMEOUT_MS = 60_000
const FINAL_INLINE_ANSWER_INACTIVITY_TIMEOUT_MS = 15_000
const FINAL_INLINE_ANSWER_CONTENT_ONLY_TIMEOUT_MS = FINAL_INLINE_ANSWER_ITERATION_TIMEOUT_MS
const FINAL_INLINE_ANSWER_MIN_CONTENT_CHARS = 420
const FINAL_INLINE_ANSWER_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FINAL_INLINE_REPORT_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FINAL_SAVED_DELIVERABLE_REQUEST_TIMEOUT_MS = 60_000
const FINAL_SAVED_DELIVERABLE_INITIAL_REQUEST_TIMEOUT_MS = 60_000
const FINAL_SAVED_DELIVERABLE_ITERATION_TIMEOUT_MS = 60_000
const FINAL_SAVED_DELIVERABLE_INACTIVITY_TIMEOUT_MS = 15_000
const FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_TIMEOUT_MS = 1_500
const FINAL_SAVED_DELIVERABLE_CONTENT_ONLY_MIN_CHARS = 350
const FINAL_SAVED_DELIVERABLE_TEXT_REQUEST_TIMEOUT_MS = 60_000
const FINAL_SAVED_DELIVERABLE_TEXT_ITERATION_TIMEOUT_MS = 60_000
const FINAL_SAVED_DELIVERABLE_TEXT_INACTIVITY_TIMEOUT_MS = 15_000
const FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_TIMEOUT_MS = 14_000
const FINAL_SAVED_DELIVERABLE_TEXT_CONTENT_ONLY_MIN_CHARS = 1_000
const FINAL_SAVED_DELIVERABLE_TEXT_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FINAL_SAVED_DELIVERABLE_INITIAL_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FINAL_SAVED_DELIVERABLE_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FINAL_DELIVERABLE_HANDOFF_REQUEST_TIMEOUT_MS = 15_000
const FINAL_DELIVERABLE_HANDOFF_ITERATION_TIMEOUT_MS = 20_000
const FINAL_DELIVERABLE_HANDOFF_INACTIVITY_TIMEOUT_MS = 8_000
// Final handoffs are model-authored task responses, not progress narration.
// Give them the provider's full output allowance and let the task context and
// handoff prompt determine their natural length. The former 420-token cap
// persisted visibly clipped headings and list markers as completed messages.
const FINAL_DELIVERABLE_HANDOFF_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const PARTIAL_RECOVERY_CLOSING_APPEND_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS
const FORCED_NARRATION_REQUEST_TIMEOUT_MS = 6_000
const FORCED_NARRATION_ITERATION_TIMEOUT_MS = 6_000
const FORCED_NARRATION_INACTIVITY_TIMEOUT_MS = 2_000
const FORCED_NARRATION_CONTENT_ONLY_TIMEOUT_MS = 2_000
const FORCED_NARRATION_MAX_TOKENS = 128
const CREDIT_PREFLIGHT_CACHE_MS = 60_000

export class AgentLoop {
  private emitter: AgentEventEmitter
  private options: AgentLoopOptions
  private lastCreditRunwayCheckAt = Date.now()

  constructor(emitter: AgentEventEmitter, options: AgentLoopOptions) {
    this.emitter = sanitizeAgentEventEmitter(emitter)
    this.options = options
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
    toolPipeline: ToolPipeline,
    streamedTarget?: StreamToolCallPolicy['textSavedDeliverable'],
  ): Promise<Phase | null> {
    const { conversationId } = this.options
    if (!conversationId) return null

    if (repairPrematureFinalStepJump(state)) {
      contextManager.push({
        role: 'system',
        content: `PLAN SEQUENCE REPAIRED: resume active step ${state.currentStepIdx + 1} ("${state.currentPlanItems?.[state.currentStepIdx] || 'the unfinished phase'}"). The final deliverable phase cannot begin until each earlier phase advances normally. Make the next concrete action for this active step now; do not repeat or save the premature draft.`,
      } as ChatMessageParam)
      return 'STREAMING'
    }

    const isLastStep = !!state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1
    const existingDeliverablePath = isLastStep && taskNeedsSavedFinalArtifact(state, this.options.messages)
      ? latestSavedFinalDeliverablePath(state)
      : null

    // A text turn after saving may be progress narration, a finding, or a real
    // completion signal. Re-verify the artifact, but do not infer that the
    // whole model-authored phase is complete from the existence of one file.
    if (existingDeliverablePath && state.currentPlanItems) {
      try {
        const verifiedFile = await readFileInSandbox(conversationId, existingDeliverablePath)
        const originalRequest =
          this.options.messages[this.options.messages.length - 1]?.content ||
          state.originalUserRequest ||
          ''
        const verification = outputVerifier.verify(
          verifiedFile.content || '',
          existingDeliverablePath,
          originalRequest,
          state.taskStrategy,
          workingMemory,
          state.taskComplexity,
        )

        if (deliverableVerificationAccepted(state, verification)) {
          continueFinalPhaseAfterVerifiedArtifact(state, existingDeliverablePath, contextManager)
          console.log('[AgentDiagnostics] Existing saved deliverable verified without auto-closing the final phase', {
            path: existingDeliverablePath,
            chars: verifiedFile.content?.length || 0,
            step: state.currentStepIdx,
            totalSteps: state.currentPlanItems.length,
          })
          return 'STREAMING'
        }

        if (state.deliverableRevisionCount < deliverableRevisionLimit(state)) {
          state.deliverableRevisionCount++
          state.pendingDeliverableRevision = {
            path: existingDeliverablePath,
            failures: verification.failures,
            suggestions: verification.suggestions,
            createdAt: Date.now(),
          }
          requireDeliverableInspectionBeforeRevision(state, existingDeliverablePath)
          state.deliverableVerificationDone = false
          contextManager.push({
            role: 'system',
            content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${verification.failures.join('; ')}. Inspect "${existingDeliverablePath}" once with read_file, then make one targeted edit_file revision against that same file. Use append_file only if genuinely missing material belongs at the current end. Do not write another confirmation, create a second file, search again, or expose this verification step.${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
          } as ChatMessageParam)
          return 'STREAMING'
        }
      } catch (error) {
        console.warn('[AgentDiagnostics] Existing saved deliverable could not be re-verified after final text', {
          path: existingDeliverablePath,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      // Never convert a final confirmation into a second autosaved artifact.
      return null
    }

    // A required native file turn that returned prose has not opened a genuine
    // live file lane. Keep that draft hidden and let the next bounded
    // OpenRouter recovery turn stream its accepted text directly into the file
    // preview from the first content chunk. The streamed recovery target below
    // then saves that exact body once, without replaying it in chat.
    if (
      ASSISTANT_PROVIDER === 'openrouter' &&
      finalSavedDeliverableTurn(state, this.options.messages) &&
      !streamedTarget
    ) {
      return null
    }

    if (!shouldAutosaveTextOnlyDraft(state, assistantContent, this.options.messages)) {
      if (streamedTarget?.started) {
        this.emitter.toolResult(streamedTarget.id, 'create_file', {
          superseded: true,
          error: 'INTERNAL_RECOVERY: The streamed saved-output draft was too short to persist safely.',
        } as never)
      }
      if (streamedTarget && state.consecutiveNoToolCalls >= 2) {
        state.lastModelErrorForUser = 'The assistant could not produce enough valid content to save the requested file.'
        return 'ERROR'
      }
      return null
    }

    const content = cleanDraftContent(assistantContent)
    const target = streamedTarget
    if (!target) return null
    const { path, id } = target

    if (!target.started) {
      target.started = true
      this.emitter.toolStart(id, 'create_file', {
        path,
        action_label: defaultFileActionLabel('create_file', path),
        plan_step_index: state.currentStepIdx + 1,
      }, { provisional: true })
      this.emitter.fileContentStart(id, path, 'create_file')
      this.emitter.fileContentDelta(id, content)
    }
    await this.emitter.flush?.()
    if (this.options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    const savePromise = toolPipeline.trackInflightOperation(
      createFileInSandbox(conversationId, path, content),
      'create_file',
      { path },
    )
    let result = await Promise.race([
      this.awaitWithTaskSignal(savePromise),
      this.wait(TEXT_ONLY_DRAFT_SAVE_VISIBLE_WAIT_MS).then(() => null),
    ])

    if (!result) {
      console.log('[AgentDiagnostics] Text-only draft save still in progress; waiting before completion', {
        path,
        chars: content.length,
      })
      result = await this.awaitWithTaskSignal(savePromise)
    }
    if (result.size === undefined) {
      this.emitter.toolResult(id, 'create_file', result as never)
      contextManager.push({
        role: 'system',
        content: `The draft text was not saved because create_file failed for ${path}. Retry with a shorter create_file call or a safer path.`,
      } as ChatMessageParam)
      return null
    }

    if (this.options.userId) {
      try {
        const persisted = await persistSandboxTaskFile({
          userId: this.options.userId,
          conversationId,
          path,
        })
        if (!persisted) {
          throw new Error('The saved draft could not be copied to durable task storage.')
        }
      } catch (error) {
        this.emitter.toolResult(id, 'create_file', {
          error: 'The draft was written in the active workspace but could not be saved durably.',
          path,
        } as never)
        throw error
      }
    }

    this.emitter.toolResult(id, 'create_file', result as never)

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
          content: `SAVED DELIVERABLE CONTINUATION REQUIRED: "${path}" has started successfully but is not complete enough for the requested saved output yet. Next response must be exactly one native append_file call to the same path with the next complete, substantive section (normally 350–650 words when that much remains). Do not repeat existing headings or paragraphs, do not recreate the file, do not write visible prose, and do not emit <next_step/> yet.`,
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
      const verificationAccepted = deliverableVerificationAccepted(state, verification)
      if (!verificationAccepted && state.deliverableRevisionCount < deliverableRevisionLimit(state)) {
        state.deliverableRevisionCount++
        state.pendingDeliverableRevision = {
          path,
          failures: verification.failures,
          suggestions: verification.suggestions,
          createdAt: Date.now(),
        }
        requireDeliverableInspectionBeforeRevision(state, path)
        state.deliverableVerificationDone = false
        contextManager.push({
          role: 'system',
          content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${verification.failures.join('; ')}. Inspect "${path}" once with read_file, then make one targeted edit_file revision against that same file. Use append_file only if genuinely missing material belongs at the current end. Do NOT write status text, create a new file, or repeat that the report was created.${verification.failures.some(failure => /citation|source|url/i.test(failure)) ? ' Add inline [n] citations beside supported claims; append a References or Sources section only when none exists and it belongs at the true end.' : ''}${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
        } as ChatMessageParam)
        return 'STREAMING'
      }

      if (!verificationAccepted) {
        state.pendingDeliverableRevision = {
          path,
          failures: verification.failures,
          suggestions: verification.suggestions,
          createdAt: Date.now(),
        }
        state.deliverableVerificationDone = false
        return 'COMPLETE'
      }

      state.deliverableVerificationDone = true
      state.pendingDeliverableRevision = null
      state.partialFileWriteRecoveryPending = null
      state.partialFileWriteRecoveryNudged = false
      continueFinalPhaseAfterVerifiedArtifact(state, path, contextManager)
      state.lastIterationEnd = Date.now()
      return 'STREAMING'
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

  private maybeStartIterationCapFinalWrite(
    state: AgentStateData,
    contextManager: ContextManager,
    goalTracker: GoalTracker,
  ): boolean {
    if (state.deadlineFinalizationStarted) return false
    if (!state.dynamicIterationLimit || state.iterations < state.dynamicIterationLimit) return false
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
    if (!taskNeedsSavedFinalArtifact(state, this.options.messages)) return false
    if (hasSavedFinalDeliverableCandidate(state)) return false

    const stepIdxBefore = state.currentStepIdx
    const finalStepIdx = state.currentPlanItems.length - 1
    const overrunStep = state.currentPlanItems[stepIdxBefore] || 'the current phase'
    while (state.currentStepIdx < finalStepIdx) {
      const currentStep = state.currentPlanItems[state.currentStepIdx] || 'phase'
      advanceStep(state, `Emergency final write after cap pressure; folded ${currentStep} into the final output from available evidence`)
    }
    updatePhase(state)

    state.deadlineFinalizationStarted = true
    state.forceTextNextIteration = false
    state.phaseEndNarrationPending = false
    state.forcedNarrationRepairAttempts = 0
    state.consecutiveNoToolCalls = 0
    state.recentToolCalls = []
    state.stepLoopDetections = 0
    state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 8)
    contextManager.push(iterationBudgetFinalizationMessage(state, overrunStep))
    if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
    for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
      this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
    }
    console.log('[AgentDiagnostics] Iteration cap final-write rescue started', {
      iteration: state.iterations,
      limit: state.dynamicIterationLimit,
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
    const injectionDetected = latestUserMessage ? isPromptInjection(latestUserMessage.content || '') : false
    if (injectionDetected) {
      this.emitter.textDelta("I can't reveal or override internal instructions. Send the task normally and I'll work on it.")
      await this.options.beforeDone?.()
      this.emitter.done()
      this.emitter.close()
      return
    }

    // ── Initialize Components ─────────────────────────────────────────

    const log = createAgentLogger()

    const scopedMessages = scopeAgentTaskMessages(messages)
    const strategy = resolveStrategy(scopedMessages)
    const complexity = estimateTaskComplexity(scopedMessages)
    const iterationLimit = computeIterationLimit(complexity)
    const timeouts = computeTimeouts(strategy)

    log.info(`Strategy: ${strategy.type}, complexity: ${complexity}/3, temp: ${strategy.temperature}, limit: ${iterationLimit}`)

    const isBuild = strategy.type === 'build' || strategy.type === 'code'
    const state = createInitialState(isBuild, timeouts)
    const creditAttempt = Number.isFinite(Number(this.options.workerAttempt))
      ? Math.max(1, Math.floor(Number(this.options.workerAttempt)))
      : 1
    state.runMaxDurationMs = this.options.runMaxDurationMs ?? AGENT_RUN_MAX_DURATION_MS
    state.deadlineFinalizationBufferMs = this.options.deadlineFinalizationBufferMs ?? AGENT_DEADLINE_FINALIZATION_BUFFER_MS
    state.deadlineModelTurnTimeoutMs = this.options.deadlineModelTurnTimeoutMs ?? AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS
    state.deadlineHardStopBufferMs = this.options.deadlineHardStopBufferMs ?? AGENT_DEADLINE_HARD_STOP_BUFFER_MS
    state.taskComplexity = complexity
    state.taskStrategy = strategy.type
    state.strategyConfig = strategy
    state.dynamicIterationLimit = iterationLimit
    state.originalUserRequest = effectiveTaskRequest(messages) || null
    const effectiveCustomInstructions = customInstructions?.trim() || undefined
    state.uploadedAttachmentNames = uploadedAttachmentNames(scopedMessages)
    state.uploadedAttachmentContextAvailable = state.uploadedAttachmentNames.length > 0
    state.uploadedImageAttachmentAvailable = ASSISTANT_SUPPORTS_IMAGE_INPUT && visualImageUploadedAttachments(scopedMessages).length > 0
    state.uploadedAttachmentContentAvailable = readableUploadedAttachments(scopedMessages).length > 0 ||
      state.uploadedImageAttachmentAvailable
    // Detect a URL/domain in the scoped task request so premature web_search
    // attempts can be rejected and suppressed until the model opens it directly.
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
    const systemPrompt = { role: 'system', content: getSystemPrompt(effectiveCustomInstructions, strategyHints) } as ChatMessageParam
    contextManager.initialize(
      systemPrompt,
      processedMessages as ChatMessageParam[]
    )
    if ((this.options.recoveryAttempt || 1) > 1) {
      const recoveryStateGuidance = this.options.recoveryMode === 'graceful_handoff'
        ? 'The existing browser session and remote workspace may be reusable, and durable files/event history may already reflect successful side effects from that attempt.'
        : 'This is stale-lease recovery: the old sandbox was kill-fenced and the browser is fresh. Only durable files, results, and event history may remain; do not assume any prior browser session state is reusable.'
      contextManager.push({
        role: 'system',
        content: [
          `WORKER RECOVERY ATTEMPT ${this.options.recoveryAttempt}: a previous worker lost its lease before it could commit a terminal result.`,
          recoveryStateGuidance,
          'Before any write, submit, send, purchase, delete, upload, or other irreversible action, inspect the current state with list_files/read_file and browser_screenshot/browser_get_content as applicable.',
          'Reuse completed work and continue from verified state. Do not repeat an irreversible action merely because it is absent from the original messages or plan.',
          'If state cannot be verified safely, stop with the concrete uncertainty instead of guessing or duplicating the action.',
          this.options.recoveryContext
            ? `Durable recovery summary (completed results/artifacts only; verify before relying on it): ${this.options.recoveryContext}`
            : '',
        ].filter(Boolean).join(' '),
      } as ChatMessageParam, 10)
    }
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
    const streamProcessor = new StreamProcessor(this.emitter, timeouts, signal)
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
    const releaseBrowserFrameStream = () => {
      browserFrameStream.unsubscribe?.()
      browserFrameStream.unsubscribe = null
      browserFrameStream.lastFrameAt = 0
    }
    const toolPipeline = new ToolPipeline(this.emitter, conversationId, {
      cache: toolCache,
      retry: toolRetry,
      memory: workingMemory,
      logger: log.child('Tools'),
      recovery: errorRecovery,
      signal,
      creditRunId: this.options.creditRunId,
      creditAttempt,
      userId: this.options.userId,
      ensureBrowserFrameStream,
      registerInflightToolDrain: this.options.registerInflightToolDrain,
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
        `attempt:${creditAttempt}:${chargeId}`,
      )
      if (recorded?.created) this.emitter.creditEvent(recorded.entry)
    }
    const assertPlannerCreditRunway = async () => this.assertServerCreditRunwayCached()
    const planManager = new PlanManager(
      this.emitter,
      planningMessages,
      complexity,
      requiredFirstSteps,
      effectiveCustomInstructions,
      recordPlannerUsage,
      assertPlannerCreditRunway,
      this.options.skipStartupAcknowledgement === true,
      signal,
      processedMessages as ChatMessageParam[],
    )

    planManager.setStateRef(state)
    const startupPlanUsed = this.options.startupPlan?.items?.length
      ? planManager.usePrecomputedPlan(state, this.options.startupPlan, { emitPlan: false })
      : false
    if (startupPlanUsed) {
      // The persisted plan is already present in the task event stream, but
      // the worker still owns the opening message. Start only the model-authored
      // acknowledgement call here; awaitPlan() fences first-step work on it.
      planManager.startAcknowledgementCall()
    } else {
      planManager.startPlanCall()
    }

    // ── Mutable iteration state ───────────────────────────────────────

    let lastStreamResult: StreamResult | null = null
    let lastStreamToolCallPolicy: StreamToolCallPolicy = {
      allowParallelSourceExtractionCalls: false,
      maxParallelSourceExtractionCalls: 1,
      cadenceProgressUpdateEnabled: false,
    }
    let lastStreamWasCompactNarration = false
    let lastToolResults: ToolExecutionResult[] = []
    let pendingPaidTurnProgress: PaidModelTurnProgressSnapshot | null = null
    let pendingActionSelectionRepairPrompt: string | null = null
    let pendingCadenceTurnProgress: {
      attemptIteration: number
      visibleActionFrontier: number
    } | null = null
    let consecutivePaidNoProgressTurns = 0
    let consecutivePaidInternalRecoveryTurns = 0
    let cumulativeInputTokens = 0
    let cumulativeOutputTokens = 0
    let cumulativeCost = 0
    let terminalReason = 'unknown'

    const injectRunLiveDirectives = async (
      options: { sealWhenEmpty?: boolean } = {},
    ): Promise<false | 'injected'> => {
      const result = await this.injectLiveDirectives(contextManager, options)
      if (!result) return false
      return result
    }

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
          if (this.maybeStartIterationCapFinalWrite(state, contextManager, goalTracker)) {
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
            try {
              await planManager.awaitPlan(state)
            } catch (planningError) {
              if (isOutOfCreditsError(planningError) || signal?.aborted) throw planningError
              const recovered = planManager.recoverFromPlannerFailure(state)
              if (!recovered) throw planningError
              this.options.diagnostics?.({
                type: 'planner_route_recovery',
                data: {
                  iteration: state.iterations,
                  error: planningError instanceof Error ? planningError.message : String(planningError),
                },
              })
            }

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
            if (repairPrematureFinalStepJump(state)) {
              contextManager.push({
                role: 'system',
                content: `PLAN SEQUENCE REPAIRED: resume active step ${state.currentStepIdx + 1} ("${state.currentPlanItems?.[state.currentStepIdx] || 'the unfinished phase'}"). The final deliverable phase cannot begin until each earlier phase advances normally. Make the next concrete action for this active step now; do not repeat or save premature report prose.`,
              } as ChatMessageParam)
            }

            const liveDirectiveInjected = await injectRunLiveDirectives()
            if (liveDirectiveInjected) {
              // A new user directive starts a fresh intent boundary rather than
              // consuming the autonomous recovery allowance from the old intent.
              pendingPaidTurnProgress = null
              pendingActionSelectionRepairPrompt = null
              pendingCadenceTurnProgress = null
              consecutivePaidNoProgressTurns = 0
              consecutivePaidInternalRecoveryTurns = 0
              state.toolJsonRecoveryCount = 0
              state.suppressedResearchToolName = null
              log.info('Injected live user directive before model turn')
            }

            if (pendingCadenceTurnProgress) {
              const cadenceTurn = pendingCadenceTurnProgress
              pendingCadenceTurnProgress = null
              const matchingPaidTurn = pendingPaidTurnProgress?.iteration === cadenceTurn.attemptIteration
                ? pendingPaidTurnProgress
                : null
              retryNarrationCadenceAfterNoProgress(state, {
                ...cadenceTurn,
                acceptedVisibleAction:
                  matchingPaidTurn?.acceptedToolCall === true &&
                  state.visibleToolActionsSinceLastNarration > cadenceTurn.visibleActionFrontier,
              })
            }

            if (pendingPaidTurnProgress) {
              const priorTurn = pendingPaidTurnProgress
              pendingPaidTurnProgress = null
              const progressDecision = decidePaidModelTurnProgress(
                priorTurn,
                state.currentStepIdx,
                consecutivePaidNoProgressTurns,
                consecutivePaidInternalRecoveryTurns,
              )
              consecutivePaidNoProgressTurns = progressDecision.consecutiveNoProgressTurns
              consecutivePaidInternalRecoveryTurns = progressDecision.consecutiveInternalRecoveryTurns

              if (progressDecision.kind === 'progress') {
                state.autonomousRecoveryEscalations = 0
              }

              const initialWebsiteActionRetryFenced =
                isInitialStandaloneWebsiteCreateTurn(state) &&
                (
                  progressDecision.kind === 'stop' ||
                  (
                    progressDecision.kind === 'allow_internal_recovery' &&
                    progressDecision.consecutiveInternalRecoveryTurns >= 2
                  )
                )
              if (initialWebsiteActionRetryFenced) {
                const trigger = progressDecision.kind === 'stop'
                  ? progressDecision.reason
                  : 'internal_recovery_cap'
                terminalReason = 'initial_website_action_rejected'
                state.lastModelErrorForUser = 'The website action could not be saved after repeated invalid internal responses. The retry loop was stopped before it could consume more credits; please retry the task.'
                this.options.diagnostics?.({
                  type: 'initial_website_action_retry_fenced',
                  data: {
                    iteration: priorTurn.iteration,
                    step: state.currentStepIdx,
                    trigger,
                    consecutiveNoProgressTurns: consecutivePaidNoProgressTurns,
                    consecutiveInternalRecoveryTurns: consecutivePaidInternalRecoveryTurns,
                  },
                })
                console.error('[AgentDiagnostics] Stopped rejected initial website actions at the bounded retry fence', {
                  step: state.currentStepIdx,
                  trigger,
                })
                phase = 'ERROR'
                break
              }

              if (progressDecision.kind === 'allow_recovery') {
                const activeStep =
                  state.currentPlanItems?.[state.currentStepIdx] ||
                  'the active task'
                state.forceTextNextIteration = false
                state.phaseEndNarrationPending = false
                state.consecutiveNoToolCalls = Math.max(1, state.consecutiveNoToolCalls)
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                state.dynamicIterationLimit = Math.max(
                  state.dynamicIterationLimit,
                  state.iterations + 2,
                )
                pendingActionSelectionRepairPrompt = [
                  'ACTION SELECTION REPAIR: The previous assistant turn produced neither an executable action nor a complete answer.',
                  `Continue the active work "${activeStep}" now.`,
                  'If this is the final answer phase, answer directly from the evidence already gathered.',
                  'Otherwise make one materially new native tool call with complete strict arguments; do not repeat the preceding request, write a status update, expose this repair, or ask permission.',
                ].join(' ')
                this.options.diagnostics?.({
                  type: 'paid_no_progress_recovery',
                  data: {
                    iteration: priorTurn.iteration,
                    step: state.currentStepIdx,
                    stepBefore: priorTurn.stepIdxBefore,
                    visibleText: priorTurn.visibleText,
                    acceptedToolCall: priorTurn.acceptedToolCall,
                  },
                })
                console.warn('[AgentDiagnostics] Reissued one explicit model-driven action after a no-progress turn', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                })
              }

              if (progressDecision.kind === 'stop') {
                if (scheduleFinalInlineAnswerRecovery(state, this.options.messages)) {
                  consecutivePaidNoProgressTurns = 0
                  consecutivePaidInternalRecoveryTurns = 0
                  terminalReason = 'unknown'
                  state.lastIterationEnd = Date.now()
                  this.options.diagnostics?.({
                    type: 'final_inline_answer_recovery',
                    data: {
                      iteration: priorTurn.iteration,
                      step: state.currentStepIdx,
                      attempt: state.finalInlineAnswerRecoveryAttempts,
                      trigger: progressDecision.reason,
                    },
                  })
                  console.warn('[AgentDiagnostics] Redirected no-progress final phase into a bounded inline answer turn', {
                    step: state.currentStepIdx,
                    attempt: state.finalInlineAnswerRecoveryAttempts,
                    trigger: progressDecision.reason,
                  })
                  phase = 'STREAMING'
                  break
                }

                if (scheduleFinalSavedDeliverableRecovery(state, this.options.messages)) {
                  consecutivePaidNoProgressTurns = 0
                  consecutivePaidInternalRecoveryTurns = 0
                  terminalReason = 'unknown'
                  contextManager.push({
                    role: 'system',
                    content: [
                      'FINAL SAVED OUTPUT RECOVERY: produce the requested deliverable now from the evidence already gathered.',
                      'Begin with the concrete Markdown content or file action required by the active final step.',
                      'Do not search again, write another status update, expose this recovery, or ask permission.',
                    ].join(' '),
                  } as ChatMessageParam)
                  this.options.diagnostics?.({
                    type: 'final_saved_deliverable_recovery',
                    data: {
                      iteration: priorTurn.iteration,
                      step: state.currentStepIdx,
                      attempt: state.finalSavedDeliverableRecoveryAttempts,
                      trigger: progressDecision.reason,
                    },
                  })
                  console.warn('[AgentDiagnostics] Redirected no-progress final phase into a bounded saved deliverable turn', {
                    step: state.currentStepIdx,
                    attempt: state.finalSavedDeliverableRecoveryAttempts,
                    trigger: progressDecision.reason,
                  })
                  state.lastIterationEnd = Date.now()
                  phase = 'STREAMING'
                  break
                }

                if (canAdvanceResearchAfterPaidNoProgress(state)) {
                  const stepBeforeAdvance = state.currentStepIdx
                  const recoveryEvidence = {
                    researchCalls: state.stepResearchCallCount,
                    openedPages: state.stepVisitedUrls.size,
                    openedDomains: stepOpenedSourceDomains(state).size,
                  }
                  const advanceMsg = planManager.handleStepAdvance(state)
                  if (state.currentStepIdx > stepBeforeAdvance) {
                    contextManager.compactForStepTransition(state)
                    if (advanceMsg) contextManager.push(advanceMsg as ChatMessageParam)
                    if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
                    this.emitter.stepAdvance(stepAdvanceStatusFor(state, stepBeforeAdvance))
                    consecutivePaidNoProgressTurns = 0
                    consecutivePaidInternalRecoveryTurns = 0
                    this.options.diagnostics?.({
                      type: 'paid_no_progress_research_advance',
                      data: {
                        iteration: priorTurn.iteration,
                        step: stepBeforeAdvance,
                        nextStep: state.currentStepIdx,
                        ...recoveryEvidence,
                      },
                    })
                    console.warn('[AgentDiagnostics] Advanced research phase at paid no-progress boundary using existing evidence', {
                      step: stepBeforeAdvance,
                      nextStep: state.currentStepIdx,
                      ...recoveryEvidence,
                    })
                    state.lastIterationEnd = Date.now()
                    phase = 'STREAMING'
                    break
                  }
                }

                const recoveryReason = progressDecision.reason === 'internal_recovery_cap'
                  ? 'paid_internal_recovery_cap'
                  : 'paid_no_progress_cap'
                this.options.diagnostics?.({
                  type: recoveryReason,
                  data: {
                    iteration: priorTurn.iteration,
                    step: state.currentStepIdx,
                    stepBefore: priorTurn.stepIdxBefore,
                    visibleText: priorTurn.visibleText,
                    acceptedToolCall: priorTurn.acceptedToolCall,
                    internalRecoveryScheduled: priorTurn.internalRecoveryScheduled || null,
                    consecutiveNoProgressTurns: consecutivePaidNoProgressTurns,
                    consecutiveInternalRecoveryTurns: consecutivePaidInternalRecoveryTurns,
                  },
                })

                const planLength = state.currentPlanItems?.length ?? 0
                const planAlreadyComplete = planLength > 0 && state.currentStepIdx >= planLength
                if (planAlreadyComplete) {
                  phase = 'COMPLETE'
                  break
                }

                // Internal action-selection failures are strategy signals, not
                // user-facing terminal errors. Reset the stale route memory and
                // require a materially different tool/source/path. Global
                // iteration and runtime deadlines still provide hard cost and
                // safety bounds if every available route remains unavailable.
                state.autonomousRecoveryEscalations += 1
                state.lastModelErrorForUser = null
                state.forceTextNextIteration = false
                state.phaseEndNarrationPending = false
                state.consecutiveNoToolCalls = 0
                state.consecutiveNullStreams = 0
                state.toolJsonRecoveryCount = 0
                state.displayContractRepairAttempts = 0
                state.recentToolCalls = []
                state.recentToolSequence = []
                state.stepLoopDetections = 0
                state.stepCrossToolCycleDetections = 0
                state.suppressedResearchToolName = null
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                state.dynamicIterationLimit = Math.max(
                  state.dynamicIterationLimit,
                  state.iterations + 4,
                )
                consecutivePaidNoProgressTurns = 0
                consecutivePaidInternalRecoveryTurns = 0

                const activeStep =
                  state.currentPlanItems?.[state.currentStepIdx] ||
                  'the active task'
                const routeGuidance = state.currentPhase === 'research'
                  ? 'Use a different source domain or a different available source tool. If extraction is blocked, use rendered browser content; if the browser route is blocked, use another search result or continue from credible evidence already gathered.'
                  : state.taskStrategy === 'browse'
                    ? 'Refresh the page state with a screenshot or content read, then use a different visible control, coordinate, navigation path, or verification method.'
                    : state.currentPhase === 'build' || state.taskStrategy === 'build' || state.taskStrategy === 'code'
                      ? 'Inspect the current workspace state, preserve existing work, then use a targeted edit, a different file operation, or a different verification command. Never recreate or append a duplicate module.'
                      : 'Choose a materially different native action. If enough evidence already exists, finish the answer or deliverable directly instead of retrying the failed route.'
                pendingActionSelectionRepairPrompt = [
                  `AUTONOMOUS ROUTE CHANGE ${state.autonomousRecoveryEscalations}: the previous internal action route is exhausted, but the task is still active.`,
                  `Continue "${activeStep}" without exposing this recovery or asking the user to retry.`,
                  routeGuidance,
                  'Make one concrete executable action now; do not repeat the rejected call or another status-only response.',
                ].join(' ')
                this.options.diagnostics?.({
                  type: 'autonomous_route_change',
                  data: {
                    iteration: priorTurn.iteration,
                    step: state.currentStepIdx,
                    attempt: state.autonomousRecoveryEscalations,
                    trigger: recoveryReason,
                  },
                })
                console.warn('[AgentDiagnostics] Recovered from paid no-progress cap by changing route', {
                  step: state.currentStepIdx,
                  attempt: state.autonomousRecoveryEscalations,
                  trigger: recoveryReason,
                })
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }
            }

            state.iterations++
            const modelTurnStartStepIdx = state.currentStepIdx

            // Rate limit delay
            const elapsed = Date.now() - state.lastIterationEnd
            if (elapsed < state.iterationDelayMs && state.iterations > 1) {
              await this.wait(state.iterationDelayMs - elapsed)
              if (signal?.aborted) { phase = 'ERROR'; break }
            }
            if (state.iterationDelayMs > MIN_ITERATION_DELAY_MS) {
              state.iterationDelayMs = Math.max(MIN_ITERATION_DELAY_MS, state.iterationDelayMs - 500)
            }

            this.maybeStartDeadlineFinalization(state, contextManager)

            // Context trimming
            contextManager.compactForModelCall(state)
            contextManager.trimIfNeeded(state)

            const cadenceVisibleActionFrontier = state.visibleToolActionsSinceLastNarration
            // Arm after three completed visible actions so the next native
            // tool call carries the LLM-authored update. It summarizes the
            // settled work and is released immediately before that action.
            // Keeping it in the work request avoids a competing provider call.
            const cadenceNarrationInMainTurn =
              shouldUseNaturalCadenceNarration(state, this.options.messages) &&
              beginNarrationCadenceAttempt(state)
            let modelRequestMessagesForUsage = [...contextManager.getMessages()]
            let modelRequestToolsForUsage: unknown[] = []
            let streamToolCallPolicy: StreamToolCallPolicy = {
              allowParallelSourceExtractionCalls: false,
              maxParallelSourceExtractionCalls: 1,
              cadenceProgressUpdateEnabled: false,
            }
            const actionSelectionRepairPrompt = pendingActionSelectionRepairPrompt
            pendingActionSelectionRepairPrompt = null
            const response = await this.callLLMWithRetry(
              model,
              modelRequestMessagesForUsage,
              state,
              strategy,
              toolRegistry,
              cadenceNarrationInMainTurn,
              (requestMessages, requestTools) => {
                modelRequestMessagesForUsage = [...requestMessages]
                modelRequestToolsForUsage = [...requestTools]
              },
              policy => {
                streamToolCallPolicy = policy
              },
              actionSelectionRepairPrompt,
            )
            lastStreamToolCallPolicy = streamToolCallPolicy
            if (signal?.aborted) { phase = 'ERROR'; break }

            const cadenceNarrationForRequestedStream =
              cadenceNarrationInMainTurn &&
              streamToolCallPolicy.cadenceProgressUpdateEnabled === true

            if (!response) {
              // A deterministic provider rejection is terminal. Fence it
              // before cadence or generic null-stream recovery can mutate
              // state and accidentally schedule another paid iteration.
              if (state.lastModelErrorForUser) {
                phase = 'ERROR'
                break
              }
              if (state.finalDeliverableHandoffPending) {
                state.finalDeliverableHandoffAttempts += 1
                if (state.finalDeliverableHandoffAttempts < 2) {
                  contextManager.push({
                    role: 'system',
                    content: 'The prior personalized handoff stream did not start. Respond immediately with the concise, task-specific final handoff requested for the completed artifact.',
                  } as ChatMessageParam)
                  state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                  state.lastIterationEnd = Date.now()
                  phase = 'STREAMING'
                  break
                }
                const stepBeforeComplete = state.currentStepIdx
                state.finalDeliverableHandoffPending = null
                if (state.currentPlanItems) state.currentStepIdx = state.currentPlanItems.length
                for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                  this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                }
                terminalReason = 'deliverable_handoff_fallback'
                phase = 'COMPLETE'
                break
              }
              if (cadenceNarrationForRequestedStream) {
                retryNarrationCadenceAttemptWithoutNewAction(state)
              } else if (cadenceNarrationInMainTurn) {
                // Tool availability was finalized before the provider request.
                // A text-only request cannot carry progress_update, so keep the
                // cadence due at the same visible-action frontier.
                retryNarrationCadenceAttemptWithoutNewAction(state)
              }
              if (state.pendingToolJsonRecovery) {
                state.pendingToolJsonRecovery = false
                state.lastModelErrorForUser = null
                state.consecutiveNullStreams = 0
                state.forceTextNextIteration = false
                contextManager.push({
                  role: 'system',
                  content: toolJsonRecoveryMessage(state, this.options.messages),
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                break // stay in STREAMING after an internal recovery nudge
              }

              const wasForcedNarrationRecovery = state.forceTextNextIteration
              const wasCompactCadenceNarration = false
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
              if (
                cadenceNarrationForRequestedStream &&
                state.currentPlanItems &&
                state.currentStepIdx < state.currentPlanItems.length &&
                state.consecutiveNullStreams <= 2
              ) {
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                contextManager.push({
                  role: 'system',
                  content: cadenceNarrationActionRetryMessage('the prior cadence-enabled action turn did not start streaming'),
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }
              if (wasForcedNarrationRecovery || wasCompactCadenceNarration) {
                const phaseEndNarrationWasPending = state.phaseEndNarrationPending
                if (phaseEndNarrationWasPending) {
                  state.forcedNarrationRepairAttempts += 1
                  state.forceTextNextIteration = true
                  state.phaseEndNarrationPending = true
                  state.consecutiveNullStreams = 0
                  state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                  contextManager.push({
                    role: 'system',
                    content: 'The phase progress update did not start streaming. Retry it immediately from the completed evidence, keeping it natural, concrete, and result-first, then put <next_step/> on its own final line. Do not call tools and do not substitute a stock status sentence.',
                  } as ChatMessageParam)
                  state.lastIterationEnd = Date.now()
                  console.log('[AgentDiagnostics] Retrying required LLM-authored phase narration after model-start timeout', {
                    step: state.currentStepIdx,
                    totalSteps: state.currentPlanItems?.length || 0,
                    repairAttempt: state.forcedNarrationRepairAttempts,
                  })
                  phase = 'STREAMING'
                  break
                }
                deferNarrationCadenceAttempt(state)
                state.consecutiveNullStreams = 0
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Skipped narration-only turn after model-start timeout; continuing task work', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  phaseEndNarrationWasPending,
                  compactCadenceNarration: wasCompactCadenceNarration,
                })
                phase = 'STREAMING'
                break
              }
              if (
                !wasForcedNarrationRecovery &&
                !wasCompactCadenceNarration &&
                isFastActionToolTurn(state, this.options.messages) &&
                !(shouldUseCompactResearchTurn(state) && state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length - 1) &&
                !finalSavedDeliverableTurn(state, this.options.messages) &&
                state.consecutiveNullStreams <= 2
              ) {
                state.forceTextNextIteration = false
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                contextManager.push({
                  role: 'system',
                  content: 'HOT ACTION START RETRY: the previous action-selection call did not start streaming in the first fast window. Retry the same active phase now with exactly one concrete native tool call; do not detour into progress narration, planning, apologies, or a final answer.',
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Retrying hot action after model-start timeout without narration detour', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  consecutiveNullStreams: state.consecutiveNullStreams,
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
                  if (pauseForPhaseEndNarrationBeforeAutoAdvance(
                    state,
                    contextManager,
                    'The compact research phase has enough evidence',
                    '',
                  )) {
                    state.consecutiveNullStreams = 0
                    state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                    state.lastIterationEnd = Date.now()
                    console.log('[AgentDiagnostics] Required narration before advancing compact research after model-start timeout', {
                      step: state.currentStepIdx,
                      totalSteps: state.currentPlanItems.length,
                    })
                    phase = 'STREAMING'
                    break
                  }
                  const stepBeforeAdvance = state.currentStepIdx
                  const completedEvidence = {
                    researchCalls: state.stepResearchCallCount,
                    sourceBreadth: Math.max(
                      state.stepVisitedUrls.size,
                      stepOpenedSourceDomains(state).size,
                    ),
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
                  state.forceTextNextIteration = false
                  state.consecutiveNullStreams = 0
                  state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                  state.lastIterationEnd = Date.now()
                  console.log('[AgentDiagnostics] Model-start timeout advanced compact research phase from gathered evidence', {
                    step: state.currentStepIdx,
                    totalSteps: state.currentPlanItems.length,
                    ...completedEvidence,
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
                const hasSavedFinalDeliverable = hasSavedFinalDeliverableCandidate(state)
                if (
                  hasSavedFinalDeliverable &&
                  state.consecutiveNullStreams >= FINAL_SAVED_DELIVERABLE_MODEL_START_TIMEOUT_CAP
                ) {
                  const stepBeforeComplete = state.currentStepIdx
                  state.pendingDeliverableRevision = null
                  state.deliverableVerificationDone = true
                  state.currentStepIdx = state.currentPlanItems?.length || state.currentStepIdx
                  for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                    this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                  }
                  terminalReason = 'saved_deliverable_model_start_timeout'
                  console.log('[AgentDiagnostics] Completed with existing saved deliverable after repeated model-start timeouts', {
                    step: stepBeforeComplete,
                    totalSteps: state.currentPlanItems?.length || 0,
                    finalPath: latestSavedFinalDeliverablePath(state),
                    consecutiveNullStreams: state.consecutiveNullStreams,
                  })
                  phase = 'COMPLETE'
                  break
                }
                if (!hasSavedFinalDeliverable && state.consecutiveNullStreams >= FINAL_SAVED_DELIVERABLE_MODEL_START_TIMEOUT_CAP) {
                  state.lastModelErrorForUser = 'The final file write could not start quickly enough. Please retry the task.'
                  phase = 'ERROR'
                  break
                }
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
                  hasFinalDeliverable: hasSavedFinalDeliverable,
                })
                phase = 'STREAMING'
                break
              }
              if (!wasForcedNarrationRecovery && state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length) {
                deferNarrationCadenceAttempt(state)
                state.iterationDelayMs = MIN_ITERATION_DELAY_MS
                contextManager.push({
                  role: 'system',
                  content: 'MODEL START RECOVERY: The previous model turn timed out before streaming. Continue the active phase immediately with one concrete native tool call. Do not detour into progress narration, planning, apologies, or a final answer.',
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                console.log('[Agent] Continuing with a concrete action after empty stream')
                break
              }
              state.lastModelErrorForUser = 'Agent could not start the next action quickly enough. Please retry the task.'
              phase = 'ERROR'
              break
            }
            if (cadenceNarrationInMainTurn && !cadenceNarrationForRequestedStream) {
              // Tool availability is finalized inside callLLMWithRetry. If
              // filtering left this as a text-only request, release the cadence
              // attempt at the same action frontier instead of requiring a
              // tool field that the provider had no tool schema to emit.
              retryNarrationCadenceAttemptWithoutNewAction(state)
            }
            const cadenceNarrationForOpenedStream = cadenceNarrationForRequestedStream
            state.consecutiveNullStreams = 0

            // Process stream
            let processedCompactNarrationTurn = false
            let cadenceProgressReleasedDuringStream = false
            streamProcessor.beginBufferedEmission()
            try {
              lastStreamWasCompactNarration = false
              processedCompactNarrationTurn = state.forceTextNextIteration && !state.exactExtractionGuardPending
              lastStreamWasCompactNarration = processedCompactNarrationTurn
              streamProcessor.setTierTimeouts(tierTimeoutsForIteration(state, this.options.messages, processedCompactNarrationTurn))
              lastStreamResult = await streamProcessor.processStream(
                response,
                state,
                cadenceNarrationForOpenedStream,
                streamOutput => approximateStreamUsageForCompletedTurn(
                  model,
                  modelRequestMessagesForUsage,
                  streamOutput,
                  modelRequestToolsForUsage,
                ),
                streamToolCallPolicy,
                cadenceNarrationForOpenedStream
                  ? (text, toolCallId) => {
                      const acceptedNarration = acceptProgressNarration(state, text, {
                        requireSignal: false,
                        remainingVisibleActions: 0,
                        resetCadence: true,
                      })
                      if (acceptedNarration.status !== 'accepted') return
                      cadenceProgressReleasedDuringStream = true
                      this.emitter.progressUpdate(acceptedNarration.text, {
                        stepIndex: state.currentStepIdx,
                        beforeToolId: toolCallId,
                        remainingVisibleActions: 0,
                      })
                    }
                  : undefined,
              )
            } catch (streamError) {
              if (cadenceNarrationForOpenedStream && !cadenceProgressReleasedDuringStream) {
                retryNarrationCadenceAttemptWithoutNewAction(state)
              }
              streamProcessor.discardBufferedEmission()
              log.info(`Stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
              phase = this.handleStreamError(
                streamError,
                state,
                contextManager,
                state.buildTask,
                cadenceNarrationForOpenedStream && !cadenceProgressReleasedDuringStream,
              )
              break
            }
            // Timeout nudges are a consecutive-stall budget, not a lifetime
            // run budget. Reset only after a stream finishes normally. A
            // partial tool envelope returned from a timed-out stream is still
            // part of the same stall sequence and must not erase that budget.
            if (!lastStreamResult.timedOut) state.timeoutNudgeCount = 0
            if (cadenceNarrationForOpenedStream) finishNarrationCadenceAttempt(state)

            if (lastStreamResult.leakageDetected) {
              terminalReason = 'safety_leakage'
              const normalizedWorkerAttempt = Number.isFinite(Number(this.options.workerAttempt))
                ? Math.max(1, Math.floor(Number(this.options.workerAttempt)))
                : 1
              if (conversationId) {
                try {
                  await sealLiveDirectiveRun(
                    conversationId,
                    this.options.userId,
                    this.options.creditRunId,
                    normalizedWorkerAttempt,
                  )
                } catch (error) {
                  streamProcessor.discardBufferedEmission()
                  throw error
                }
              }
            }

            // Log costs. Provider usage metadata can arrive late or be unavailable
            // for some routed generations, so estimate instead of interrupting work.
            const u = lastStreamResult.usage ?? approximateStreamUsageForCompletedTurn(
              model,
              contextManager.getMessages(),
              lastStreamResult,
            )
            if (lastStreamResult.usageEstimated || !lastStreamResult.usage) {
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
            const pendingHandoffText =
              state.finalDeliverableHandoffPending &&
              lastStreamResult.toolCalls.size === 0
                ? lastStreamResult.assistantContent.trim()
                : null
            const truncatedFinalResponse =
              lastStreamResult.finishReason === 'length' &&
              lastStreamResult.toolCalls.size === 0 &&
              (
                !!state.finalDeliverableHandoffPending ||
                finalInlineAnswerTurn(state, this.options.messages)
              )
            const compactNarrationReview =
              processedCompactNarrationTurn &&
              lastStreamResult.toolCalls.size === 0
                ? reviewProgressNarration(
                    state,
                    lastStreamResult.assistantContent,
                    { requireSignal: false },
                  )
                : null
            const rejectedCompactNarrationEmission =
              compactNarrationReview !== null &&
              compactNarrationReview.status !== 'accepted'
            const rejectedHandoffEmission =
              pendingHandoffText !== null &&
              (
                truncatedFinalResponse ||
                !shouldAcceptFinalDeliverableHandoff(
                  pendingHandoffText,
                  state.finalDeliverableHandoffAttempts + 1,
                  state,
                )
              )
            const rejectedBuildTextOnlyEmission = shouldRejectBuildTextOnlyEmission(
              state,
              lastStreamResult,
            )
            const rejectedUnsavedFinalDeliverableDraft =
              !lastStreamToolCallPolicy.textSavedDeliverable &&
              lastStreamResult.toolCalls.size === 0 &&
              finalSavedDeliverableTurn(state, this.options.messages) &&
              !hasSavedFinalDeliverableCandidate(state) &&
              lastStreamResult.assistantContent.trim().length > 0
            const rejectedInitialWebsiteCreateEmission =
              isInitialStandaloneWebsiteCreateTurn(state) &&
              !hasCompleteInitialStandaloneWebsiteCreateCall(lastStreamResult)
            const rejectedModelEmission =
              truncatedFinalResponse ||
              rejectedCompactNarrationEmission ||
              rejectedHandoffEmission ||
              rejectedBuildTextOnlyEmission ||
              rejectedUnsavedFinalDeliverableDraft ||
              rejectedInitialWebsiteCreateEmission
            // A cadence/display-contract failure or malformed initial website
            // action is an internal orchestration miss: no model output is
            // released and no executable action is admitted. Do not make the
            // user pay for a turn the product itself rejects.
            const nonBillableInternalTurn =
              !!lastStreamResult.cadenceProgressViolation ||
              rejectedModelEmission
            const usageDebitStartedAt = Date.now()
            try {
              if (
                !nonBillableInternalTurn &&
                this.options.userId &&
                this.options.conversationId &&
                this.options.creditRunId
              ) {
                const recorded = await chargeServerTokenUsage(
                  this.options.userId,
                  this.options.conversationId,
                  this.options.creditRunId,
                  u,
                  `attempt:${creditAttempt}:tokens:${state.iterations}`,
                )
                if (recorded?.created) this.emitter.creditEvent(recorded.entry)
              }
              // Ordinary model text and provisional actions become visible
              // only after the corresponding debit commits. The structured
              // cadence update and validated file preview are live exceptions.
              // Validated current-step file writes stream their action and LIVE
              // preview immediately. Their structured cadence update is released
              // first; buffered actions receive the same update after the debit
              // commits and immediately before their exact action ID.
              // discardBufferedEmission settles any optimistic file action if
              // the turn cannot commit.
              // Validate personalized handoff prose before releasing the
              // buffered text. A rejected attempt remains model context for the
              // retry, but never reaches the client and cannot concatenate with
              // the accepted final response.
              if (lastStreamResult.cadenceProgressViolation || rejectedModelEmission) {
                streamProcessor.discardBufferedEmission()
              } else {
                if (lastStreamResult.cadenceProgressUpdate) {
                  if (!cadenceProgressReleasedDuringStream) {
                    const carriedVisibleActions = carriedCadenceActionCount(lastStreamResult)
                    const acceptedNarration = acceptProgressNarration(
                      state,
                      lastStreamResult.cadenceProgressUpdate,
                      {
                        requireSignal: false,
                        // Provisionally staged actions are already counted and
                        // become action one after this reset. Deferred tools are
                        // counted by ToolPipeline only after preflight succeeds.
                        remainingVisibleActions: carriedVisibleActions,
                        resetCadence: true,
                      },
                    )
                    if (acceptedNarration.status === 'accepted') {
                      this.emitter.progressUpdate(acceptedNarration.text, {
                        stepIndex: state.currentStepIdx,
                        beforeToolId: lastStreamResult.cadenceProgressToolCallId,
                        remainingVisibleActions: 0,
                      })
                    }
                  }
                  // Cadence narration has one release point: before the
                  // buffered action. Never retain it for a post-result path.
                  lastStreamResult.cadenceProgressUpdate = undefined
                }
                streamProcessor.commitBufferedEmission()
              }
              console.log(
                nonBillableInternalTurn
                  ? '[AgentDiagnostics] Discarded an unbilled internal model-turn failure'
                  : rejectedHandoffEmission
                    ? '[AgentDiagnostics] Held back an unaccepted personalized handoff'
                    : rejectedBuildTextOnlyEmission
                      ? '[AgentDiagnostics] Held back a text-only website build drift'
                      : rejectedUnsavedFinalDeliverableDraft
                        ? '[AgentDiagnostics] Held back an unsaved final-deliverable draft'
                        : '[AgentDiagnostics] Released billed model-turn emissions',
                {
                  iteration: state.iterations,
                  usageDebitMs: Date.now() - usageDebitStartedAt,
                  firstContentHeldMs: lastStreamResult.contentStreamingStartTime === null
                    ? 0
                    : Date.now() - lastStreamResult.contentStreamingStartTime,
                  cadenceProgressViolation: lastStreamResult.cadenceProgressViolation?.code || null,
                  rejectedHandoffEmission,
                  truncatedFinalResponse,
                  rejectedCompactNarrationEmission,
                  rejectedBuildTextOnlyEmission,
                  rejectedUnsavedFinalDeliverableDraft,
                  rejectedInitialWebsiteCreateEmission,
                  userDebitSkipped: nonBillableInternalTurn,
                },
              )
              pendingPaidTurnProgress = {
                iteration: state.iterations,
                stepIdxBefore: modelTurnStartStepIdx,
                visibleText: !lastStreamResult.cadenceProgressViolation &&
                  !rejectedModelEmission &&
                  lastStreamResult.assistantContent.trim().length > 0,
                acceptedToolCall: false,
                ...(nonBillableInternalTurn
                  ? { internalRecoveryScheduled: 'display_contract' as const }
                  : {}),
              }
              pendingCadenceTurnProgress = cadenceNarrationForOpenedStream
                ? {
                    attemptIteration: state.iterations,
                    visibleActionFrontier: cadenceVisibleActionFrontier,
                  }
                : null
            } catch (error) {
              streamProcessor.discardBufferedEmission()
              throw error
            }

            // Cadence-only prose and fourth-action tool calls without a valid
            // LLM-authored progress update are rejected before execution. The
            // same ordinary action turn is repaired immediately.
            if (lastStreamResult.cadenceProgressViolation) {
              contextManager.push({
                role: 'system',
                content: cadenceNarrationActionRetryMessage(
                  lastStreamResult.cadenceProgressViolation.reason,
                ),
              } as ChatMessageParam)
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (lastStreamResult.leakageDetected) {
              phase = 'COMPLETE'
              break
            }

            if (truncatedFinalResponse) {
              if (
                state.truncatedFinalResponseRepairAttempts >=
                MAX_TRUNCATED_FINAL_RESPONSE_REPAIR_ATTEMPTS
              ) {
                state.lastModelErrorForUser =
                  'The final response repeatedly reached the provider output limit before it could finish.'
                console.error('[AgentDiagnostics] Exhausted truncated final-response repairs', {
                  iteration: state.iterations,
                  step: state.currentStepIdx,
                  finishReason: lastStreamResult.finishReason,
                  repairs: state.truncatedFinalResponseRepairAttempts,
                })
                phase = 'ERROR'
                break
              }

              contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              contextManager.push({
                role: 'system',
                content: [
                  'The previous final response reached the provider output limit and was not shown to the user.',
                  'Rewrite the complete final response from the beginning in a naturally concise form, preserving the important task-specific outcome and any useful attachment guidance.',
                  'Finish every heading, sentence, list item, and Markdown structure cleanly. Do not call tools or mention this repair.',
                ].join(' '),
              } as ChatMessageParam)
              state.truncatedFinalResponseRepairAttempts += 1
              if (state.finalDeliverableHandoffPending) {
                state.finalDeliverableHandoffAttempts += 1
              } else {
                state.finalInlineAnswerRecoveryAttempts += 1
              }
              state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 1)
              state.lastIterationEnd = Date.now()
              console.warn('[AgentDiagnostics] Retrying a provider-truncated final response', {
                iteration: state.iterations,
                step: state.currentStepIdx,
                finishReason: lastStreamResult.finishReason,
                repair: state.truncatedFinalResponseRepairAttempts,
              })
              phase = 'STREAMING'
              break
            }

            updatePhase(state)

            const naturalVerifiedHandoffPath =
              !processedCompactNarrationTurn &&
              lastStreamResult.finishReason !== 'length' &&
              lastStreamResult.toolCalls.size === 0
                ? verifiedFinalPhaseNaturalHandoffPath(
                    state,
                    lastStreamResult.assistantContent,
                  )
                : null
            if (naturalVerifiedHandoffPath) {
              const stepBeforeComplete = state.currentStepIdx
              contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              state.finalDeliverableHandoffPending = null
              state.finalDeliverableHandoffAttempts = 1
              if (state.currentPlanItems) {
                state.currentStepIdx = state.currentPlanItems.length
              }
              state.lastIterationEnd = Date.now()
              terminalReason = 'deliverable_handoff_complete'
              for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              console.log('[AgentDiagnostics] Natural verified-phase handoff accepted', {
                iteration: state.iterations,
                chars: lastStreamResult.assistantContent.trim().length,
                path: naturalVerifiedHandoffPath,
                step: stepBeforeComplete,
                totalSteps: state.currentPlanItems?.length || 0,
              })
              phase = 'COMPLETE'
              break
            }

            if (
              state.finalDeliverableHandoffPending &&
              lastStreamResult.toolCalls.size === 0
            ) {
              const handoffText = lastStreamResult.assistantContent.trim()
              state.finalDeliverableHandoffAttempts += 1

              if (shouldAcceptFinalDeliverableHandoff(handoffText, state.finalDeliverableHandoffAttempts, state)) {
                const stepBeforeComplete = state.currentStepIdx
                contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                state.finalDeliverableHandoffPending = null
                if (state.currentPlanItems) {
                  state.currentStepIdx = state.currentPlanItems.length
                }
                state.lastIterationEnd = Date.now()
                terminalReason = 'deliverable_handoff_complete'
                for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                  this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
                }
                console.log('[AgentDiagnostics] Personalized deliverable handoff accepted', {
                  iteration: state.iterations,
                  chars: handoffText.length,
                  step: stepBeforeComplete,
                  totalSteps: state.currentPlanItems?.length || 0,
                  attempts: state.finalDeliverableHandoffAttempts,
                })
                phase = 'COMPLETE'
                break
              }

              if (state.finalDeliverableHandoffAttempts < 2) {
                if (handoffText) {
                  contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
                }
                contextManager.push({
                  role: 'system',
                  content: 'The previous personalized handoff was too short, generic, or unfinished. Give the concise, task-specific final response immediately in this turn.',
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }

              // Never turn a successfully completed artifact into a failed task
              // solely because the optional handoff prose failed to stream.
              const stepBeforeComplete = state.currentStepIdx
              state.finalDeliverableHandoffPending = null
              if (state.currentPlanItems) {
                state.currentStepIdx = state.currentPlanItems.length
              }
              terminalReason = 'deliverable_handoff_fallback'
              for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              phase = 'COMPLETE'
              break
            }

            if (
              processedCompactNarrationTurn &&
              lastStreamResult.toolCalls.size === 0
            ) {
              const phaseEndNarrationWasPending = state.phaseEndNarrationPending
              const narration = compactNarrationReview?.status === 'accepted'
                ? acceptProgressNarration(state, lastStreamResult.assistantContent, {
                    requireSignal: false,
                    remainingVisibleActions: 0,
                    clearPhaseEndPending: phaseEndNarrationWasPending,
                    resetCadence: phaseEndNarrationWasPending,
                  })
                : compactNarrationReview!
              if (narration.status === 'accepted') {
                state.consecutiveNoToolCalls = 0
              } else if (phaseEndNarrationWasPending) {
                state.forcedNarrationRepairAttempts += 1
                state.phaseEndNarrationPending = true
                state.forceTextNextIteration = true
                state.consecutiveNoToolCalls = 0
                contextManager.push({
                  role: 'system',
                  content: [
                    `The prior phase update was ${narration.status === 'duplicate' ? 'too close to an update already shown' : 'empty, incomplete, or not grounded in a completed result'}.`,
                    'Retry immediately from the newest completed evidence. State the useful finding, comparison, verified state, completed change, or real blocker in natural language, then put <next_step/> on its own final line.',
                    'Do not call tools, repeat visible action labels, write future-only intent, or use a canned status sentence.',
                  ].join(' '),
                } as ChatMessageParam)
                lastStreamResult = { ...lastStreamResult, assistantContent: '' }
                state.lastIterationEnd = Date.now()
                console.log('[AgentDiagnostics] Retrying required LLM-authored phase narration', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  repairAttempt: state.forcedNarrationRepairAttempts,
                  review: narration.status,
                })
                phase = 'STREAMING'
                break
              } else {
                deferNarrationCadenceAttempt(state)
                contextManager.push({
                  role: 'system',
                  content: 'The optional progress update was skipped because it was empty, invalid, or repeated prior information. Do not retry narration. Continue immediately with the next concrete tool call for the active phase.',
                } as ChatMessageParam)
                lastStreamResult = { ...lastStreamResult, assistantContent: '' }
                state.lastIterationEnd = Date.now()
                phase = 'STREAMING'
                break
              }
            }

            const stillRequiredExplicitTools = lastStreamResult.toolCalls.size === 0
              ? pendingExplicitToolTargets(state)
              : []
            if (stillRequiredExplicitTools.length > 0) {
              // Never accept a generic chat refusal or phase completion while
              // a user-requested runtime action has not actually executed.
              // This is especially important for one-phase terminal tasks,
              // which otherwise resemble ordinary final-answer turns.
              state.consecutiveNoToolCalls += 1
              state.forceTextNextIteration = false
              contextManager.push({
                role: 'system',
                content: [
                  `REQUIRED USER ACTION NOT YET EXECUTED: ${stillRequiredExplicitTools.map(explicitTaskToolTargetLabel).join(', ')}.`,
                  'The sandbox has the declared tools. Do not claim the terminal, filesystem, browser, or execution environment is unavailable unless an actual tool call returned that concrete failure.',
                  'Discard the prior prose response and make the required native tool call now with strict JSON object arguments. Do not emit <next_step/> or a final answer first.',
                ].join(' '),
              } as ChatMessageParam)
              lastStreamResult = { ...lastStreamResult, assistantContent: '' }
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              lastStreamResult.finishReason !== 'length' &&
              shouldCompleteFinalInlineAnswerTurn(state, this.options.messages, lastStreamResult.assistantContent)
            ) {
              const stepBeforeComplete = state.currentStepIdx
              contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              if (state.currentPlanItems) {
                state.currentStepIdx = state.currentPlanItems.length
              }
              state.forceTextNextIteration = false
              state.phaseEndNarrationPending = false
              state.finalInlineAnswerDelivered = true
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

            // Check plan on early text-only iterations. If the model already
            // selected a tool, run it immediately instead of holding the hot
            // path open while a background planner finishes.
            if (state.iterations <= 2 && lastStreamResult.toolCalls.size === 0) {
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
                if (pauseForPhaseEndNarrationBeforeAutoAdvance(
                  state,
                  contextManager,
                  'The compact research phase has enough evidence',
                  lastStreamResult.assistantContent,
                )) {
                  state.lastIterationEnd = Date.now()
                  phase = 'STREAMING'
                  break
                }
                const stepBeforeAdvance = state.currentStepIdx
                const completedEvidence = {
                  researchCalls: state.stepResearchCallCount,
                  sourceBreadth: Math.max(
                    state.stepVisitedUrls.size,
                    stepOpenedSourceDomains(state).size,
                  ),
                }
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
                  ...completedEvidence,
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

            if (await injectRunLiveDirectives()) {
              for (const toolCall of lastStreamResult.toolCalls.values()) {
                if (!toolCall.provisionalStartEmitted) continue
                this.emitter.toolResult(toolCall.id, toolCall.name, {
                  superseded: true,
                  error: 'Superseded by a newer live instruction before execution.',
                } as never)
                if (state.visibleNarrationToolStartIds.delete(toolCall.id)) {
                  state.visibleToolActionsSinceLastNarration = Math.max(
                    0,
                    state.visibleToolActionsSinceLastNarration - 1,
                  )
                }
              }
              log.info('Live user directive superseded pending tool calls')
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (!startupReadyAwaited && this.options.startupReadyPromise && toolCallsNeedStartupReady(lastStreamResult.toolCalls)) {
              startupReadyAwaited = true
              const waitStartedAt = Date.now()
              try {
                await this.awaitWithTaskSignal(this.options.startupReadyPromise)
                console.log('[AgentDiagnostics] Tool startup prerequisites ready', {
                  elapsedMs: Date.now() - waitStartedAt,
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                })
              } catch (error) {
                if (isRetryableTaskInfrastructureInitializationError(error)) throw error
                console.error('[AgentDiagnostics] Tool startup prerequisites failed', {
                  elapsedMs: Date.now() - waitStartedAt,
                  error: error instanceof Error ? error.message : String(error),
                })
                state.lastModelErrorForUser = userErrorMessage(error, 'Task setup failed before tools could run. Please try again.')
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
            const currentPaidTurnProgress = paidTurnProgressForIteration(
              pendingPaidTurnProgress,
              state.iterations,
            )
            if (currentPaidTurnProgress) {
              currentPaidTurnProgress.acceptedToolCall ||= lastToolResults.some(
                // A cache hit is useful context, but it is not a newly admitted
                // action. Counting repeated cached reads as paid-turn progress
                // hid source loops from the bounded no-progress fence.
                result => result.acceptedForExecution === true && result.cached !== true,
              )
            }

            const malformedToolResults = lastToolResults.filter(isMalformedToolArgumentsRecovery)
            if (malformedToolResults.length > 0) {
              const acceptedSiblingResults = lastToolResults.filter(
                result => result.acceptedForExecution === true && !isMalformedToolArgumentsRecovery(result),
              )
              // A provider may return a valid source call beside an incomplete
              // streamed sibling. Keep every admitted sibling in provider
              // history before scheduling recovery; otherwise the model never
              // sees evidence the runtime already gathered and asks for the
              // same cached reads again.
              const executedSiblingCalls = executedToolCallsForProviderHistory(
                lastStreamResult.toolCalls,
                acceptedSiblingResults,
              )
              if (executedSiblingCalls.length > 0) {
                const assistantMsg: Record<string, unknown> = {
                  role: 'assistant',
                  content: lastStreamResult.assistantContent || null,
                  tool_calls: executedSiblingCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                }
                contextManager.push(assistantMsg as unknown as ChatMessageParam)
                for (const msg of toolPipeline.buildToolResultMessages(acceptedSiblingResults, state)) {
                  contextManager.push(msg as unknown as ChatMessageParam, 4)
                }
                for (const result of acceptedSiblingResults) toolRegistry.recordCall(result.tc.name)
              } else if (lastStreamResult.assistantContent) {
                contextManager.push(assistantHistoryMessageForStreamResult(lastStreamResult))
              }

              state.toolJsonRecoveryCount += 1
              if (currentPaidTurnProgress) {
                currentPaidTurnProgress.internalRecoveryScheduled = 'malformed_tool_arguments'
              }
              state.consecutiveNoToolCalls = 0
              state.consecutiveNullStreams = 0
              state.forceTextNextIteration = false
              state.iterationDelayMs = MIN_ITERATION_DELAY_MS

              if (state.toolJsonRecoveryCount === 1) {
                contextManager.push({
                  role: 'system',
                  content: [
                    'TOOL JSON RECOVERY: One native tool call in the previous model turn streamed an incomplete or malformed argument object before execution.',
                    'Any valid sibling results are already preserved above; do not request those sources again.',
                    'Do not expose this runtime issue to the user.',
                    'Make one bounded repair attempt now with exactly one native tool call using complete strict JSON arguments.',
                    'For web_search, include both action_label and query as real strings; never use placeholder text such as Search Results.',
                  ].join(' '),
                } as ChatMessageParam)
                console.warn('[AgentDiagnostics] Reissued tool call after malformed streamed tool arguments', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  recoveryAttempt: state.toolJsonRecoveryCount,
                  malformedTools: malformedToolResults.map(result => result.tc.name),
                  preservedSiblingTools: acceptedSiblingResults.map(result => result.tc.name),
                })
              } else {
                const malformedResearchTool = malformedToolResults
                  .map(result => result.tc.name)
                  .find(name => [
                    'web_search', 'read_document', 'http_request',
                    'browser_navigate', 'browser_get_content', 'browser_find_text',
                  ].includes(name))
                if (malformedResearchTool) {
                  state.suppressedResearchToolName = malformedResearchTool
                  state.stepLoopDetections = Math.max(1, state.stepLoopDetections + 1)
                }

                if (canAdvanceResearchAfterPaidNoProgress(state)) {
                  const stepBeforeAdvance = state.currentStepIdx
                  const advanceMsg = planManager.handleStepAdvance(state)
                  if (state.currentStepIdx > stepBeforeAdvance) {
                    contextManager.compactForStepTransition(state)
                    if (advanceMsg) contextManager.push(advanceMsg as ChatMessageParam)
                    if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
                    this.emitter.stepAdvance(stepAdvanceStatusFor(state, stepBeforeAdvance))
                    console.warn('[AgentDiagnostics] Advanced research phase after bounded malformed-tool recovery using preserved evidence', {
                      step: stepBeforeAdvance,
                      nextStep: state.currentStepIdx,
                      malformedTools: malformedToolResults.map(result => result.tc.name),
                      preservedSiblingTools: acceptedSiblingResults.map(result => result.tc.name),
                    })
                    state.lastIterationEnd = Date.now()
                    phase = 'STREAMING'
                    break
                  }
                }

                state.consecutiveNoToolCalls = Math.max(1, state.consecutiveNoToolCalls)
                contextManager.push({
                  role: 'system',
                  content: [
                    'TOOL JSON RECOVERY LIMIT REACHED: do not retry the malformed tool route or any source already returned from cache.',
                    malformedResearchTool
                      ? `The runtime has disabled ${malformedResearchTool} for the next recovery action.`
                      : 'The runtime will not allow another same-route JSON repair in this step.',
                    'Use one materially different available source/search/browser tool, or advance from the evidence already gathered.',
                    'Do not narrate this internal recovery condition to the user.',
                  ].join(' '),
                } as ChatMessageParam)
                console.warn('[AgentDiagnostics] Switched route after bounded malformed streamed tool arguments', {
                  step: state.currentStepIdx,
                  totalSteps: state.currentPlanItems?.length || 0,
                  recoveryAttempts: state.toolJsonRecoveryCount,
                  suppressedTool: malformedResearchTool || null,
                  malformedTools: malformedToolResults.map(result => result.tc.name),
                  preservedSiblingTools: acceptedSiblingResults.map(result => result.tc.name),
                })
              }
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            if (lastToolResults.length > 0 && lastToolResults.every(isDisplayContractRepairResult)) {
              if (currentPaidTurnProgress) {
                currentPaidTurnProgress.internalRecoveryScheduled = 'display_contract'
              }
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
              lastToolResults.length > 0 &&
              lastToolResults.every(isSynthesisFinalizationRecoveryResult)
            ) {
              const planLength = state.currentPlanItems?.length || 0
              if (planLength > 0) {
                state.currentStepIdx = planLength - 1
                updatePhase(state)
              }
              state.forceTextNextIteration = false
              state.phaseEndNarrationPending = false
              state.consecutiveNoToolCalls = 0
              state.consecutiveNullStreams = 0
              state.recentToolCalls = []
              state.recentToolSequence = []
              state.lastModelErrorForUser = null
              pendingPaidTurnProgress = null
              consecutivePaidNoProgressTurns = 0
              consecutivePaidInternalRecoveryTurns = 0

              const inlineRecoveryScheduled = scheduleFinalInlineAnswerRecovery(
                state,
                this.options.messages,
              )
              if (!inlineRecoveryScheduled && taskNeedsSavedFinalArtifact(state, this.options.messages)) {
                contextManager.push({
                  role: 'system',
                  content: 'FINALIZATION TURN: use the evidence already gathered and prioritize the requested saved deliverable now. Further research is usually unnecessary here, but the full healthy tool set remains available if one action is genuinely required to make the deliverable valid.',
                } as ChatMessageParam)
                state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 2)
              }

              console.warn('[AgentDiagnostics] Redirected blocked synthesis research directly into finalization', {
                step: state.currentStepIdx,
                totalSteps: planLength,
                mode: inlineRecoveryScheduled ? 'inline' : 'saved',
                blockedTools: lastToolResults.map(result => result.tc.name),
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
            const executedParallelSourceBatch =
              lastStreamResult.toolCalls.size > 1 &&
              executedParallelSourceExtractionBatch(lastToolResults)
            if (lastStreamResult.toolCalls.size > executedToolCalls.length && !executedCoalescedBrowserSequence) {
              contextManager.push({
                role: 'system',
                content: executedParallelSourceBatch
                  ? 'TOOL EXECUTION NOTE: The runtime executed the one allowed model-selected source batch for this search set, capped at 3 calls. Do not extract more links from that result set. Continue by synthesizing or advancing when the evidence is sufficient, browsing a promising site when rendered exploration is useful, or making a materially different targeted search for a real remaining gap.'
                  : 'TOOL EXECUTION NOTE: Multiple tool calls were requested in one assistant turn, but only safe source extraction calls can run in parallel. Continue from the executed result and call the next required tool separately.',
              } as ChatMessageParam, 2)
            }

            for (const result of lastToolResults) {
              toolRegistry.recordCall(result.tc.name)
            }

            // Do not drain live directives again at the post-result boundary.
            // Every continuation from here either reaches STREAMING, whose
            // entry drain injects the directive immediately before the next
            // model turn, or COMPLETE, whose atomic seal/drain owns the final
            // acceptance race. The pre-execution drain above remains the
            // supersession fence for already-selected tool calls. Polling here
            // as well made the common result -> next-model path perform two
            // consecutive empty write transactions without improving safety.

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

            const successfulStandaloneWebsiteCreate = lastToolResults.find(result => (
              result.tc.name === 'create_website' && !result.isError
            ))
            if (
              successfulStandaloneWebsiteCreate &&
              shouldDefaultFrontendToStandaloneHtml(state.originalUserRequest || '') &&
              !standaloneWebsiteRequiresPostBuildAction(state.originalUserRequest || '')
            ) {
              const finalPath = toolResultPath(successfulStandaloneWebsiteCreate) || 'index.html'
              state.deliverableVerificationDone = true
              state.pendingDeliverableRevision = null
              state.standaloneWebsiteHandoffReady = true
              continueFinalPhaseAfterVerifiedArtifact(state, finalPath, contextManager)
              state.lastIterationEnd = Date.now()
              log.info('Complete standalone website saved — keeping the model-authored final phase open', {
                path: finalPath,
                step: state.currentStepIdx,
                totalSteps: state.currentPlanItems?.length || 0,
              })
              phase = 'STREAMING'
              break
            }

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

            if (
              isLastStep &&
              conversationId &&
              state.pendingDeliverableRevision &&
              state.deliverableRevisionFailureCount >= 2
            ) {
              const revisionPath = state.pendingDeliverableRevision.path
              try {
                const currentFile = await readFileInSandbox(conversationId, revisionPath)
                const verification = outputVerifier.verify(
                  currentFile.content || '',
                  revisionPath,
                  messages[messages.length - 1]?.content || state.originalUserRequest || '',
                  state.taskStrategy,
                  workingMemory,
                  state.taskComplexity,
                )
                // Two concrete in-place repair attempts are enough. Do not let
                // provider-specific old_string/append mistakes turn a readable
                // saved report into dozens of read-only retries. At this
                // boundary, soft report-shape heuristics yield to the intact
                // artifact; genuine truncation/corruption still fails.
                state.deliverableRevisionCount = deliverableRevisionLimit(state)
                if (deliverableVerificationAccepted(state, verification)) {
                  state.deliverableVerificationDone = true
                  state.pendingDeliverableRevision = null
                  state.fileWriteRepairPending = null
                  state.deliverableRevisionFailureCount = 0
                  state.deliverableRevisionSnapshot = null
                  continueFinalPhaseAfterVerifiedArtifact(state, revisionPath, contextManager)
                  state.lastIterationEnd = Date.now()
                  log.info('Accepted intact saved deliverable after bounded revision-tool failures', {
                    path: revisionPath,
                    failures: verification.failures,
                  })
                  phase = 'STREAMING'
                  break
                }

                state.deliverableVerificationDone = false
                state.fileWriteRepairPending = null
                state.deliverableRevisionSnapshot = null
                terminalReason = 'deliverable_verification_failed'
                log.warn('Saved deliverable retained a blocking integrity failure after bounded repair attempts', {
                  path: revisionPath,
                  failures: verification.failures,
                })
                phase = 'COMPLETE'
                break
              } catch (error) {
                state.deliverableVerificationDone = false
                state.fileWriteRepairPending = null
                state.deliverableRevisionSnapshot = null
                terminalReason = 'deliverable_verification_failed'
                log.warn('Could not re-read saved deliverable after bounded repair attempts', {
                  path: revisionPath,
                  error: error instanceof Error ? error.message : String(error),
                })
                phase = 'COMPLETE'
                break
              }
            }

            if (isLastStep && imageDeliverableCreated && imageDeliverableRequested) {
              const imageResult = lastToolResults.find(result => {
                if (result.tc.name !== 'image_search' || result.isError) return false
                return ((result.result as { downloaded?: string[] })?.downloaded?.length || 0) > 0
              })
              const imagePath = (imageResult?.result as { downloaded?: string[] } | undefined)?.downloaded?.[0] || 'the generated image'
              recordWorkLedgerDeliverable(state, { path: imagePath, purpose: 'deliverable' })
              continueFinalPhaseAfterVerifiedArtifact(state, imagePath, contextManager)
              state.lastIterationEnd = Date.now()
              log.info('Image artifact created on last step — requesting personalized final handoff')
              phase = 'STREAMING'
              break
            }

            // Last-step deliverable created → verify quality before terminating
            if (isLastStep && deliverableCreated) {
              const deliverableResult = lastToolResults.find(isSuccessfulFinalDeliverableWrite)
              const partialRecoveryResult = deliverableResult?.result as {
                partialWriteIncomplete?: boolean
                partialWriteRecoveryLimitReached?: boolean
              } | undefined
              const recoveredPartialWrite = !!partialRecoveryResult?.partialWriteIncomplete
              if (deliverableResult && recoveredPartialWrite) {
                const pending = state.partialFileWriteRecoveryPending
                const path = pending?.path || toolResultPath(deliverableResult) || 'the saved deliverable'
                if (conversationId && path !== 'the saved deliverable') {
                  try {
                    const verifiedContent = await deliverableContentForVerification(conversationId, deliverableResult)
                    const originalRequest = messages[messages.length - 1]?.content || ''
                    const verification = outputVerifier.verify(
                      verifiedContent.content,
                      verifiedContent.path || path,
                      originalRequest,
                      state.taskStrategy,
                      workingMemory,
                      state.taskComplexity,
                    )
                    if (verifiedContent.path) {
                      recordWorkLedgerDeliverable(state, {
                        path: verifiedContent.path,
                        purpose: 'deliverable',
                      })
                    }

                    if (deliverableVerificationAccepted(state, verification)) {
                      state.partialFileWriteRecoveryPending = null
                      state.partialFileWriteRecoveryNudged = false
                      state.deliverableVerificationDone = true
                      state.pendingDeliverableRevision = null
                      continueFinalPhaseAfterVerifiedArtifact(state, path, contextManager)
                      state.lastIterationEnd = Date.now()
                      log.info('Recovered deliverable passed whole-file verification — requesting personalized final handoff')
                      phase = 'STREAMING'
                      break
                    }

                    if (partialRecoveryResult?.partialWriteRecoveryLimitReached) {
                      const appendRecoveryCount = partialAppendRecoveryCountForPath(state, path)
                      const closingAppendAlreadyGranted =
                        appendRecoveryCount > PARTIAL_APPEND_RECOVERY_LIMIT_PER_PATH ||
                        state.deliverableRevisionCount >= deliverableRevisionLimit(state)
                      if (!closingAppendAlreadyGranted) {
                        state.deliverableRevisionCount = deliverableRevisionLimit(state)
                        state.pendingDeliverableRevision = {
                          path,
                          failures: verification.failures,
                          suggestions: verification.suggestions,
                          createdAt: Date.now(),
                        }
                        contextManager.push({
                          role: 'system',
                          content: `PARTIAL APPEND RECOVERY LIMIT REACHED: "${path}" has been read back and verified as a whole. Make exactly one final small append_file call to the same path, limited to the most important missing closing material (${verification.failures.join('; ')}). Keep it to roughly 180–300 words, finish at a clean sentence or section boundary, and do not repeat existing content. This is the only remaining append attempt; do not write visible prose or emit <next_step/>.`,
                        } as ChatMessageParam)
                        log.info('Partial append recovery limit reached — allowing one bounded closing append')
                        phase = 'EVALUATING'
                        break
                      }

                      state.partialFileWriteRecoveryPending = null
                      state.partialFileWriteRecoveryNudged = false
                      state.pendingDeliverableRevision = {
                        path,
                        failures: verification.failures,
                        suggestions: verification.suggestions,
                        createdAt: Date.now(),
                      }
                      state.deliverableVerificationDone = false
                      terminalReason = 'deliverable_verification_failed'
                      log.warn('Recovered deliverable still failed verification after bounded closing append', {
                        path,
                        failures: verification.failures,
                      })
                      phase = 'COMPLETE'
                      break
                    }
                  } catch (error) {
                    log.warn('Could not verify recovered deliverable before continuation', {
                      path,
                      error: error instanceof Error ? error.message : String(error),
                    })
                    if (partialRecoveryResult?.partialWriteRecoveryLimitReached) {
                      state.partialFileWriteRecoveryPending = null
                      state.partialFileWriteRecoveryNudged = false
                      state.deliverableVerificationDone = false
                      terminalReason = 'deliverable_verification_failed'
                      phase = 'COMPLETE'
                      break
                    }
                  }
                }
                log.info('Recovered partial deliverable write on last step — requiring append continuation')
                contextManager.push({
                  role: 'system',
                  content: `PARTIAL DELIVERABLE SAVED: ${path} already exists. Do not call create_file for it again. Next response must be exactly one append_file call to the same path with the next complete, substantive missing section (normally 350–650 words when that much remains). End at a clean sentence or section boundary and do not repeat existing headings or paragraphs. Do not emit <next_step/> or any visible prose until a successful append_file call clears this partial-file state.`,
                } as ChatMessageParam)
                phase = 'EVALUATING'
                break
              }
              if (deliverableResult && !state.deliverableVerificationDone) {
                if (deliverableResult.tc.name !== 'export_pdf' && deliverableResult.tc.name !== 'package_files') {
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
                        content: `SAVED DELIVERABLE CONTINUATION REQUIRED: "${continuationPath}" has started successfully but is not complete enough for the requested saved output yet. Next response must be exactly one native append_file call to the same path with the next complete, substantive section (normally 350–650 words when that much remains). Do not repeat existing headings or paragraphs, do not recreate the file, do not write visible prose, and do not emit <next_step/> yet.`,
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
                          content: `NEXT.JS WEBSITE COMPLETENESS REQUIRED: Before finishing, fix these structure/style issues: ${websiteProblems.structureIssues.join(' ')} The site may be one cohesive page, but it must include the runnable files required by the chosen Next.js structure. Add reusable components only when they improve the architecture; do not create redundant header/navigation variants.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                    }
                    const verification = outputVerifier.verify(
                      verifiedContent.content || args.content || '',
                      verifiedContent.path || args.path || '',
                      originalRequest,
                      state.taskStrategy,
                      workingMemory,
                      state.taskComplexity,
                    )

                    const verificationAccepted = deliverableVerificationAccepted(state, verification)
                    if (!verificationAccepted && state.deliverableRevisionCount < deliverableRevisionLimit(state)) {
                      state.deliverableRevisionCount++
                      state.pendingDeliverableRevision = {
                        path: verifiedContent.path || args.path || toolResultPath(deliverableResult) || 'the existing deliverable',
                        failures: verification.failures,
                        suggestions: verification.suggestions,
                        createdAt: Date.now(),
                      }
                      requireDeliverableInspectionBeforeRevision(state, state.pendingDeliverableRevision.path)
                      const failureList = verification.failures.join('; ')
                      log.info(`Output verification failed (${verification.score.toFixed(2)}): ${failureList}`)
                      contextManager.push({
                        role: 'system',
                        content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${failureList}. Inspect "${state.pendingDeliverableRevision.path}" once with read_file, then make one targeted edit_file revision against that same file. Use append_file only if genuinely missing material belongs at the current end. Do NOT write status text, create a new file, or repeat that the report was created.${verification.failures.some(failure => /citation|source|url/i.test(failure)) ? ' Add inline [n] citations beside supported claims; append a References or Sources section only when none exists and it belongs at the true end.' : ''}${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
                      } as ChatMessageParam)
                      // Stay on deliverable step for revision
                      phase = 'EVALUATING'
                      break
                    }

                    if (!verificationAccepted) {
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

                  } catch {
                    state.deliverableVerificationDone = false
                    terminalReason = 'deliverable_verification_failed'
                    phase = 'COMPLETE'
                    break
                  }
                } else if (deliverableResult.tc.name === 'export_pdf') {
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
              const finalPath = deliverableResult
                ? toolResultPath(deliverableResult) || latestSavedFinalDeliverablePath(state) || 'the completed deliverable'
                : latestSavedFinalDeliverablePath(state) || 'the completed deliverable'
              continueFinalPhaseAfterVerifiedArtifact(state, finalPath, contextManager)
              state.lastIterationEnd = Date.now()
              log.info('Deliverable file created on last step — keeping the full final phase open')
              phase = 'STREAMING'
              break
            }

            // Non-last website build mutations → force advance as soon as the
            // runnable file set is complete. Integration edits are just as
            // meaningful as first-time creates.
            const nonNoteFileCreated = lastToolResults.some(r => {
              if (!['create_file', 'create_website', 'append_file', 'edit_file'].includes(r.tc.name) || r.isError) return false
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

            const briefEvidenceAssessment = state.currentStepIdx === stepIdxBeforeExec
              ? briefInlineResearchEvidenceAfterTools(state, this.options.messages, lastToolResults)
              : null
            if (briefEvidenceAssessment?.ready) {
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
              const userText = this.options.messages
                .filter(message => message.role === 'user')
                .map(message => message.content)
                .join(' ')
              const fastFinalStepIdx = briefInlineFinalDeliveryStepIndex({
                request: state.originalUserRequest || userText,
                planItems: state.currentPlanItems || [],
                planScopes: state.currentPlanScopes,
                currentStepIdx: state.currentStepIdx,
              })
              const targetStepIdx = fastFinalStepIdx ?? Math.min(
                state.currentStepIdx + 1,
                (state.currentPlanItems?.length || 1) - 1,
              )
              let advanceMsg: { role: string; content: string } | null = null
              do {
                advanceMsg = planManager.handleStepAdvance(state)
              } while (state.currentStepIdx < targetStepIdx)
              if (state.currentStepIdx > stepBeforeAdvance) {
                contextManager.compactForStepTransition(state)
              }
              if (advanceMsg) {
                contextManager.push(advanceMsg as ChatMessageParam)
              }
              if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
            } else if (
              briefEvidenceAssessment?.reason === 'explicit-source-quality' &&
              briefEvidenceAssessment.recoveryInstruction &&
              !state.briefInlineSourceQualityNudged
            ) {
              state.briefInlineSourceQualityNudged = true
              contextManager.push({
                role: 'system',
                content: briefEvidenceAssessment.recoveryInstruction,
              } as ChatMessageParam)
              log.info(
                `Brief inline source-quality gate kept step ${state.currentStepIdx} active ` +
                `(${briefEvidenceAssessment.qualifyingSourceCount}/${briefEvidenceAssessment.requiredOpenedSources} qualifying)`,
              )
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
                toolPipeline,
                lastStreamToolCallPolicy.textSavedDeliverable,
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

            if (shouldTerminate) {
              if (pendingPaidTurnProgress?.iteration === state.iterations) {
                pendingPaidTurnProgress.terminalAction = true
              }
              phase = 'COMPLETE'
              break
            }

            state.lastIterationEnd = Date.now()
            phase = 'STREAMING'
            break
          }
          }
        }

        if (phase !== 'COMPLETE') break

        const websiteBlocker = NON_REOPENABLE_WEBSITE_TERMINAL_REASONS.has(terminalReason)
          ? null
          : await getNextWebsiteCompletionBlocker(
              conversationId,
              state,
              messages[messages.length - 1]?.content || '',
            )
        if (websiteBlocker) {
          if (state.iterations >= state.dynamicIterationLimit) {
            state.lastModelErrorForUser = `Website build did not complete. ${websiteBlocker}`
            phase = 'ERROR'
            break
          }
          contextManager.push({ role: 'system', content: websiteBlocker } as ChatMessageParam)
          state.lastIterationEnd = Date.now()
          phase = 'STREAMING'
          continue
        }

        // Final directive acceptance and the empty-queue seal happen in one
        // transaction. If an instruction won the race, reopen the final phase
        // and give it real execution budget; otherwise no later POST can be
        // accepted between this check and the terminal event.
        const terminalCanAcceptLiveDirective = !NON_REOPENABLE_LIVE_DIRECTIVE_TERMINAL_REASONS.has(terminalReason)
        if (!terminalCanAcceptLiveDirective) {
          const normalizedWorkerAttempt = Number.isFinite(Number(this.options.workerAttempt))
            ? Math.max(1, Math.floor(Number(this.options.workerAttempt)))
            : 1
          if (conversationId) {
            await sealLiveDirectiveRun(
              conversationId,
              this.options.userId,
              this.options.creditRunId,
              normalizedWorkerAttempt,
            )
          }
        } else if (await injectRunLiveDirectives({ sealWhenEmpty: true })) {
          log.info('Injected live user directive at completion boundary')
          terminalReason = 'unknown'
          state.lastIterationEnd = Date.now()
          state.dynamicIterationLimit = Math.max(state.dynamicIterationLimit, state.iterations + 4)
          state.deadlineFinalizationStarted = false
          state.forceTextNextIteration = false
          state.phaseEndNarrationPending = false
          state.forcedNarrationRepairAttempts = 0
          state.finalInlineAnswerDelivered = false
          state.finalInlineAnswerRecoveryAttempts = 0
          state.finalDeliverableHandoffPending = null
          state.finalDeliverableHandoffAttempts = 0
          state.consecutiveNoToolCalls = 0
          state.deliverableVerificationDone = false
          if (state.currentPlanItems?.length && state.currentStepIdx >= state.currentPlanItems.length) {
            state.currentStepIdx = state.currentPlanItems.length - 1
            updatePhase(state)
            if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
          }
          phase = 'STREAMING'
          continue
        }

        const preFinalCompletionAudit = auditAgentCompletion(state, terminalReason)
        const recoverableMissingInlineAnswer =
          preFinalCompletionAudit.missing.includes(MISSING_FINAL_INLINE_ANSWER) &&
          preFinalCompletionAudit.missing.every(missing =>
            missing === MISSING_FINAL_INLINE_ANSWER ||
            missing === 'the iteration limit was reached before a verified completion state',
          )
        if (
          recoverableMissingInlineAnswer &&
          scheduleFinalInlineAnswerRecovery(state, this.options.messages)
        ) {
          terminalReason = 'unknown'
          state.lastIterationEnd = Date.now()
          console.warn('[AgentDiagnostics] Completion audit reopened a missing final inline answer', {
            step: state.currentStepIdx,
            attempt: state.finalInlineAnswerRecoveryAttempts,
            previousReason: preFinalCompletionAudit.reason,
          })
          phase = 'STREAMING'
          continue
        }

        // ── Finalization ────────────────────────────────────────────────

        const totalUsage = {
          promptTokens: cumulativeInputTokens,
          completionTokens: cumulativeOutputTokens,
          totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
          cost: cumulativeCost,
        }
        const completionAudit = preFinalCompletionAudit
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

        await this.options.beforeDone?.()
        this.emitter.done(totalUsage)
        this.emitter.close()
        break
      }

      if (phase === 'ERROR') {
        if (!signal?.aborted && !this.emitter.isClosed && !this.emitter.terminalStatus) {
          this.emitter.error(
            state.lastModelErrorForUser ||
            'The task stopped before it finished. Please try again.',
          )
        }
      }
    } catch (err) {
      if (isRetryableTaskInfrastructureInitializationError(err)) throw err
      if (signal?.aborted) {
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
      planManager.dispose()
      releaseBrowserFrameStream()
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  /**
   * Await shared startup work without allowing a hung sandbox/bootstrap promise
   * to outlive cancellation, lease loss, or the hard runtime deadline.
   */
  private async awaitWithTaskSignal<T>(promise: Promise<T>): Promise<T> {
    const signal = this.options.signal
    if (!signal) return promise
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    let onAbort: (() => void) | null = null
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, abortPromise])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

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

  private async injectLiveDirectives(
    contextManager: ContextManager,
    options: { sealWhenEmpty?: boolean } = {},
  ): Promise<false | 'injected'> {
    const { conversationId, userId, creditRunId, workerAttempt } = this.options
    if (!conversationId) return false

    const normalizedWorkerAttempt = Number.isFinite(Number(workerAttempt))
      ? Math.max(1, Math.floor(Number(workerAttempt)))
      : 1
    const directives = await drainLiveDirectives(
      conversationId,
      userId,
      creditRunId,
      normalizedWorkerAttempt,
      options,
    )
    if (directives.length === 0) return false

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
  ): Array<{ role: string; content: string | ChatContentPart[] }> {
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
    cadenceNarrationInMainTurn = false,
    captureUsageEstimateEnvelope?: (
      requestMessages: ChatMessageParam[],
      requestTools: unknown[],
    ) => void,
    captureStreamToolCallPolicy?: (policy: StreamToolCallPolicy) => void,
    actionSelectionRepairPrompt: string | null = null,
  ): Promise<AsyncIterable<StreamingChatCompletionChunk> | null> {
    const useCompactForcedNarration = false
    const useCompactNarration = useCompactForcedNarration
    const scopedTaskRequest = state.originalUserRequest || effectiveTaskRequest(this.options.messages)
    const standaloneWebsiteNeedsInitialCreate = isInitialStandaloneWebsiteCreateTurn(state)
    const useCompactFinalDeliverableHandoff = !!state.finalDeliverableHandoffPending
    const explicitTaskToolConstraint = explicitTaskToolConstraintFromText(scopedTaskRequest)
    const pendingExplicitTaskToolTargets = explicitTaskToolConstraint?.required.filter(
      target => ![...state.taskSuccessfulToolTypeCounts.keys()].some(
        toolName => toolMatchesExplicitTaskToolTarget(target, toolName),
      ),
    ) || []
    const explicitTaskToolNeedsInitialAction = pendingExplicitTaskToolTargets.length > 0
    const explicitTerminalNeedsInitialAction = pendingExplicitTaskToolTargets.length > 0 &&
      pendingExplicitTaskToolTargets.every(target => target === 'terminal' || target === 'execute_command')
    const hasPersistentExplicitTaskToolRestriction =
      (explicitTaskToolConstraint?.exclusive.length || 0) > 0 ||
      (explicitTaskToolConstraint?.forbidden.length || 0) > 0
    const briefInlineResearchNeedsEvidenceAction =
      !explicitTaskToolNeedsInitialAction &&
      !hasPersistentExplicitTaskToolRestriction &&
      finalBriefInlineResearchNeedsEvidenceAction(state, this.options.messages)
    const savedResearchNeedsEvidenceAction =
      !explicitTaskToolNeedsInitialAction &&
      !hasPersistentExplicitTaskToolRestriction &&
      finalSavedResearchNeedsEvidenceAction(state, this.options.messages)
    const useCompactFinalInlineAnswer = finalInlineAnswerTurn(state, this.options.messages) &&
      (state.finalInlineAnswerRecoveryAttempts > 0 || state.deadlineFinalizationStarted) &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending &&
      !briefInlineResearchNeedsEvidenceAction &&
      !explicitTaskToolNeedsInitialAction
    const useTextFinalDeliverable = shouldUseTextSavedFinalDeliverable(state, this.options.messages) &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending &&
      !savedResearchNeedsEvidenceAction &&
      !explicitTaskToolNeedsInitialAction &&
      !hasPersistentExplicitTaskToolRestriction
    const useCompactFinalDeliverable = finalSavedDeliverableTurn(state, this.options.messages) &&
      (
        state.finalSavedDeliverableRecoveryAttempts > 0 ||
        state.deadlineFinalizationStarted ||
        !!state.partialFileWriteRecoveryPending ||
        !!state.fileWriteRepairPending ||
        !!state.pendingDeliverableRevision
      ) &&
      !useTextFinalDeliverable &&
      !useCompactNarration &&
      !state.exactExtractionGuardPending &&
      !savedResearchNeedsEvidenceAction &&
      !explicitTaskToolNeedsInitialAction &&
      !hasPersistentExplicitTaskToolRestriction
    const preserveCurrentEvidenceForModel = hasCurrentModelEvidenceBatch(allMessages)
    const useCompactResearchTurn = !useCompactNarration &&
      !useCompactFinalInlineAnswer &&
      !useTextFinalDeliverable &&
      !useCompactFinalDeliverable &&
      !preserveCurrentEvidenceForModel &&
      shouldUseCompactResearchTurn(state)
    const compactResearchPhaseCanAdvance = !explicitTaskToolNeedsInitialAction &&
      useCompactResearchTurn &&
      !!state.currentPlanItems &&
      state.currentStepIdx < state.currentPlanItems.length - 1 &&
      compactResearchEvidenceComplete(state)
    let requestMessages = explicitTerminalNeedsInitialAction
      ? compactExplicitTerminalActionMessages(state, allMessages)
      : standaloneWebsiteNeedsInitialCreate
      ? compactInitialStandaloneWebsiteMessages(state, allMessages, this.options.customInstructions)
      : useCompactFinalDeliverableHandoff
        ? compactFinalDeliverableHandoffMessages(state, allMessages, this.options.customInstructions)
      : useCompactNarration
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
      const boundedClosingAppend = isPartialRecoveryClosingAppendTurn(state)
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: [
            'PARTIAL FILE CONTINUATION REQUIRED NOW.',
            `The only valid next action is one native append_file call to "${pending.path}".`,
            `That file already has ${pending.lines} lines / ${pending.chars} characters from a recovered clipped write.`,
            'Do not call create_file, edit_file, read_file, list_files, export_pdf, browser tools, research tools, or emit <next_step/>.',
            boundedClosingAppend
              ? 'This is the only permitted closing append. Add only the most important missing closing material in roughly 180–300 words, end cleanly, and do not repeat existing content.'
              : 'Append only the next missing complete, substantive section—normally 350–650 words when that much remains, or all remaining content when less remains. Do not repeat existing headings, claims, citations, or paragraphs.',
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
    if (
      sourceExtractionBatchConsumedForLatestSearch(state) &&
      !isCurrentSynthesisStep(state)
    ) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: [
            'SOURCE-SET DECISION COMPLETE: you already chose and opened the useful direct-extraction batch from the latest search results.',
            'Usually avoid mining that same result set with another read_document/http_request batch unless a concrete unresolved detail makes it useful.',
            'Use your judgment now: synthesize or advance if the evidence is sufficient, browse a promising site when rendered exploration will help, or make a materially different targeted search for a real remaining gap.',
          ].join(' '),
        } as ChatMessageParam,
      ]
    }
    if (useCompactResearchTurn && compactResearchNeedsOpenedSource(state)) {
      const sourceOpeningExhausted = compactResearchSourceOpeningExhausted(
        state,
        researchDepthProfileForState(state),
      )
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: sourceOpeningExhausted
            ? 'SOURCE OPENING RECOVERY: prior source-opening attempts did not produce usable page evidence. Prefer a materially different source action now: web_search for a new authoritative domain, one parallel batch of up to 2 read_document/http_request calls for different surfaced URLs, browser_navigate to a different URL, or browser_get_content if a useful page is already open. New domains are usually more useful than retrying the same blocked source, but choose based on the actual evidence gap.'
            : state.suppressedResearchToolName === 'read_document'
              ? 'SOURCE OPENING RECOVERY: read_document repeated in a loop, so a materially different source route is likely best. Consider an untried URL from the Remaining candidate URLs block with browser_navigate, browser_get_content from a different useful open page, http_request when appropriate, or a targeted web_search for a new authoritative domain when the existing candidates are unusable. The full healthy tool set remains available; choose based on the evidence gap.'
              : 'SOURCE OPENING RECOMMENDATION: known search result URLs are already available and search breadth is high enough for this phase. Opening or extracting the strongest surfaced URLs will usually add more value than another query variant. Use read_document/http_request for readable pages or browser tools when rendered state matters, while retaining judgment to choose another healthy tool when it better serves the evidence gap.',
        } as ChatMessageParam,
      ]
    }
    if (compactResearchPhaseCanAdvance) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'PHASE EVIDENCE READY: write one natural completed-result progress update first, then put <next_step/> on its own final line. Size the update to the newest evidence instead of a fixed template. Do not call tools, output only <next_step/>, or write future-only intent; the update must report a concrete finding from completed work.',
        } as ChatMessageParam,
      ]
    }
    if (savedResearchNeedsEvidenceAction) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'LIVE EVIDENCE RECOMMENDATION: The requested saved research output does not yet have usable source-page evidence from this run. A direct evidence action on a concrete, untried source URL is likely the strongest next move. Keep the full healthy tool set available and choose the route that best supports a valid deliverable.',
        } as ChatMessageParam,
      ]
    } else if (state.finalDeliverableHandoffPending && !useCompactFinalDeliverableHandoff) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: finalDeliverableHandoffPrompt(state),
        } as ChatMessageParam,
      ]
    } else if (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state)) {
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
    if (actionSelectionRepairPrompt) {
      // Compact task prompts intentionally replace raw history. Carry this
      // one-turn repair explicitly so a rejected/cached action cannot be
      // requested again merely because its recovery message was compacted out.
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: actionSelectionRepairPrompt,
        } as ChatMessageParam,
      ]
    }
    let relaxRequiredToolChoice = false
    let lastShouldRequireToolCall = false
    let providerRequestRepairAttempts = 0
    // The outer handoff state already provides two bounded LLM-authored
    // attempts. Do not multiply those by the normal provider-start retry loop.
    const maxModelStartAttempts = state.finalDeliverableHandoffPending
      ? 1
      : STREAM_MAX_RETRIES + MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS + 1
    for (let attempt = 0; attempt < maxModelStartAttempts; attempt++) {
      try {
        let activeTools: ToolDefinitionLike[]
        const isPostCompletion = state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length
        const intentionalTextOnlyTurn =
          isPostCompletion ||
          state.finalDeliverableHandoffPending ||
          useCompactNarration ||
          useTextFinalDeliverable ||
          compactResearchPhaseCanAdvance ||
          (state.deadlineFinalizationStarted && !taskNeedsSavedFinalArtifact(state, this.options.messages)) ||
          (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state))

        if (intentionalTextOnlyTurn) {
          activeTools = []
        } else {
          // Phase, strategy, urgency, and recovery state guide ordering and
          // prompts; they never hide a healthy tool from the model. Actual
          // availability remains governed by registry health/config checks,
          // explicit user constraints, permissions, and execution safety.
          activeTools = toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[]
        }

        if (state.exactExtractionGuardPending && activeTools.length > 0) {
          const activeGuardPrompt = state.exactExtractionGuardPrompt
          const allowedExactConfirmationTools = exactExtractionGuardToolNames(state)
          const hasConfirmationRoute = activeTools.some(tool =>
            allowedExactConfirmationTools.has(tool.function?.name || ''),
          )
          if (!hasConfirmationRoute) {
            clearExactExtractionGuard(state)
            requestMessages = requestMessages.filter(message => message.content !== activeGuardPrompt)
            requestMessages.push({
              role: 'system',
              content: 'RENDERED CONFIRMATION UNAVAILABLE: continue from the successful direct extraction. Do not claim that the detail was visually confirmed; state the missing rendered confirmation as a limitation only when it materially affects the answer.',
            } as ChatMessageParam)
          }
        }
        const compactResearchNeedsTool = useCompactResearchTurn && compactResearchNeedsToolAction(state)
        if (state.fileWriteRepairPending && !partialFileContinuationNeedsTool) {
          const pending = state.fileWriteRepairPending
          const codeLikeTarget = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|vue|svelte|astro|json|ya?ml|toml|xml|html?)$/i.test(pending.path)
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: [
                `FILE REVISION REQUIRED: "${pending.path}" has an unresolved write conflict.`,
                !pending.inspected
                  ? 'The most direct recovery is to read that exact file before deciding how to repair it.'
                  : codeLikeTarget
                    ? 'The current contents are refreshed; prefer one targeted edit rather than appending a duplicate code module.'
                    : 'The current contents are refreshed; choose a targeted edit or append only genuinely missing prose.',
                'Avoid replacement or duplicate files. Use another available tool only when it is genuinely the better recovery for this conflict.',
              ].join(' '),
            } as ChatMessageParam,
          ]
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
        const finalSavedDeliverableRevisionNeedsTool = useCompactFinalDeliverable &&
          !!existingFinalDeliverablePath(state) &&
          !state.deliverableVerificationDone
        const finalSavedDeliverableNeedsTool = useCompactFinalDeliverable &&
          (
            partialFileContinuationNeedsTool ||
            finalSavedDeliverableRevisionNeedsTool ||
            !hasSavedFinalDeliverableCandidate(state)
          )
        if (
          briefInlineResearchNeedsEvidenceAction &&
          !isPostCompletion &&
          !useCompactNarration
        ) {
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: 'INLINE RESEARCH EVIDENCE REQUIRED: Before answering this short current-information request, make one targeted evidence action now. Choose the most direct available tool for the actual target; if the user supplied a URL, directly reading or opening it will usually be more useful than rediscovering it.',
            } as ChatMessageParam,
          ]
        }
        if (
          explicitTaskToolConstraint &&
          !isPostCompletion &&
          !useCompactNarration &&
          !useTextFinalDeliverable &&
          !compactResearchPhaseCanAdvance
        ) {
          const availabilityState = {
            ...state,
            currentPhase: 'unknown' as const,
          }
          const availableTools = toolRegistry.getActiveDefinitions(availabilityState) as ToolDefinitionLike[]
          const permittedAvailableTools = availableTools.filter(tool =>
            toolAllowedByExplicitTaskConstraint(
              explicitTaskToolConstraint,
              tool.function?.name || '',
            ),
          )
          const unavailableRequiredTargets = pendingExplicitTaskToolTargets.filter(
            target => !permittedAvailableTools.some(tool =>
              toolMatchesExplicitTaskToolTarget(target, tool.function?.name || ''),
            ),
          )
          const unavailableExclusiveTargets = explicitTaskToolConstraint.exclusive.length > 0 &&
            permittedAvailableTools.length === 0
            ? explicitTaskToolConstraint.exclusive
            : []
          const unavailableTargets = [
            ...new Set([...unavailableRequiredTargets, ...unavailableExclusiveTargets]),
          ]

          if (unavailableTargets.length > 0) {
            activeTools = []
          } else if (pendingExplicitTaskToolTargets.length > 0) {
            const preferredTools = activeTools.filter(tool =>
              pendingExplicitTaskToolTargets.some(target =>
                toolMatchesExplicitTaskToolTarget(target, tool.function?.name || ''),
              ),
            )
            const preferredNames = new Set(preferredTools.map(tool => tool.function?.name || ''))
            activeTools = [
              ...preferredTools,
              ...activeTools.filter(tool => !preferredNames.has(tool.function?.name || '')),
            ]
          } else if (explicitTaskToolConstraint.exclusive.length > 0) {
            activeTools = permittedAvailableTools
          } else if (explicitTaskToolConstraint.forbidden.length > 0) {
            activeTools = activeTools.filter(tool =>
              toolAllowedByExplicitTaskConstraint(
                explicitTaskToolConstraint,
                tool.function?.name || '',
              ),
            )
          }

          const requiredLabels = pendingExplicitTaskToolTargets
            .map(explicitTaskToolTargetLabel)
            .join(', ')
          const exclusiveLabels = explicitTaskToolConstraint.exclusive
            .map(explicitTaskToolTargetLabel)
            .join(', ')
          const forbiddenLabels = explicitTaskToolConstraint.forbidden
            .map(explicitTaskToolTargetLabel)
            .join(', ')
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: unavailableTargets.length > 0
                ? `USER TOOL INSTRUCTION BLOCKER: The explicitly named tool scope (${unavailableTargets.map(explicitTaskToolTargetLabel).join(', ')}) is not currently available under the runtime's safety, permission, and availability checks. Do not silently substitute another tool. Report this concrete blocker briefly.`
                : [
                    'USER TOOL INSTRUCTION: Preserve the user-specified step order.',
                    requiredLabels
                      ? `Use one of the following required named tool scopes now, before normal tool freedom resumes: ${requiredLabels}.`
                      : '',
                    exclusiveLabels
                      ? `Every tool action must remain inside this exclusive allowed scope: ${exclusiveLabels}.`
                      : '',
                    forbiddenLabels
                      ? `Never call tools in this forbidden scope: ${forbiddenLabels}.`
                      : '',
                    'Safety, permissions, and actual tool availability still take precedence. Do not silently substitute for an unavailable required tool.',
                  ].filter(Boolean).join(' '),
            } as ChatMessageParam,
          ]
        }
        const explicitWebSearchMethod = !!explicitTaskToolConstraint && (
          explicitTaskToolConstraint.required.includes('web_search') ||
          explicitTaskToolConstraint.exclusive.includes('web_search')
        )
        const directUserUrlNeedsFirstAction =
          !!state.userProvidedUrl &&
          state.stepToolCallCount === 0 &&
          !explicitWebSearchMethod &&
          !isPostCompletion &&
          !useCompactNarration &&
          !useTextFinalDeliverable
        if (directUserUrlNeedsFirstAction) {
          const hasDirectSourceTool = activeTools.some(tool => {
            const name = tool.function?.name || ''
            return name === 'browser_navigate' || name === 'read_document' || name === 'http_request'
          })
          if (hasDirectSourceTool) {
            requestMessages = [
              ...requestMessages,
              {
                role: 'system',
                content: [
                  `DIRECT USER TARGET: The user supplied ${state.userProvidedUrl}.`,
                  'Use the exact target directly when it is the best route; do not rediscover a replacement without a concrete reason.',
                  'For ordinary research-page reading, full-page extraction is usually efficient. Browser tools are useful for dynamic or scripted state, interaction/action work, screenshots, or exact visibly rendered confirmation. The full healthy tool set remains available—choose from it based on the page and requested outcome.',
                ].join(' '),
              } as ChatMessageParam,
            ]
          }
        }
        const effectiveCadenceNarrationInMainTurn =
          cadenceNarrationInMainTurn &&
          activeTools.length > 0
        if (effectiveCadenceNarrationInMainTurn && !useCompactNarration) {
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: cadenceNarrationMainTurnGuidance(state),
            } as ChatMessageParam,
          ]
        }
        const shouldRequireToolCall =
          activeTools.length > 0 &&
          !isPostCompletion &&
          !state.forceTextNextIteration &&
          (
            effectiveCadenceNarrationInMainTurn ||
            partialFileContinuationNeedsTool ||
            finalSavedDeliverableNeedsTool ||
            explicitTaskToolNeedsInitialAction ||
            briefInlineResearchNeedsEvidenceAction ||
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
        let requiredToolIntent = shouldRequireToolCall
        let fastActionTurn = activeTools.length > 0 &&
          !isPostCompletion &&
          isFastActionToolTurn(state, this.options.messages)
        let fastSourceActionTurn = !explicitTaskToolNeedsInitialAction &&
          !hasPersistentExplicitTaskToolRestriction &&
          fastActionTurn &&
          isFastSourceActionToolTurn(state, this.options.messages)
        fastActionTurn = fastActionTurn && activeTools.length > 0
        fastSourceActionTurn = fastSourceActionTurn && activeTools.length > 0
        // Reserve the next action for the narration-carrying request. Without
        // this reservation, a parallel batch could silently consume actions
        // two through four and make the update appear only on action five.
        const sourceBatchRoomBeforeNarration = Math.max(
          0,
          NARRATION_REQUEST_AFTER_VISIBLE_ACTIONS - state.visibleToolActionsSinceLastNarration,
        )
        const allowParallelSourceToolCalls = fastSourceActionTurn &&
          !sourceExtractionBatchConsumedForLatestSearch(state) &&
          sourceBatchRoomBeforeNarration >= 2
        const maxParallelSourceExtractionCalls = allowParallelSourceToolCalls
          ? Math.min(2, sourceBatchRoomBeforeNarration)
          : 1
        // Source recovery can deliberately remove the last unsafe route after
        // the initial requirement calculation. Never ask a provider to require
        // a tool call when the final tool menu is empty.
        requiredToolIntent = requiredToolIntent && activeTools.length > 0
        if (fastActionTurn && !useCompactNarration) {
          requestMessages = [
            ...requestMessages,
            {
              role: 'system',
              content: fastSourceActionTurn
                ? allowParallelSourceToolCalls
                ? 'HOT PATH SOURCE ACTION TURN: decide immediately. Make one native tool call, or if recent search results already provide independent candidate URLs and no extraction batch has been used for that search set, make one parallel batch of up to 2 source extraction calls using read_document or http_request. Do not use parallel browser navigation/state tools or file tools. Do not write ordinary prose, status, plans, apologies, or hidden reasoning. Preserve depth; speed comes from acting quickly and reading independent sources together.'
                : 'HOT PATH SOURCE ACTION TURN: decide immediately and make exactly one native evidence tool call. Cadence headroom is intentionally reserving the next source actions for the following ordinary turn. Do not write prose, status, plans, apologies, or hidden reasoning.'
                : 'HOT PATH ACTION TURN: decide the next concrete action immediately and make exactly one native tool call. Do not write prose, status, plans, apologies, or hidden reasoning. Preserve the task depth/quality requirements; speed comes from choosing the next action quickly, not from doing less work.',
            } as ChatMessageParam,
          ]
        }
        const useRequiredToolCall = (standaloneWebsiteNeedsInitialCreate || requiredToolIntent) &&
          !relaxRequiredToolChoice &&
          supportsProviderRequiredToolChoice(model)
        const requestedToolChoice = useRequiredToolCall
          ? 'required'
          : undefined
        lastShouldRequireToolCall = useRequiredToolCall

        const approxChars = requestMessages.reduce((sum, m) => {
          if (typeof m.content === 'string') return sum + m.content.length
          if (Array.isArray(m.content)) return sum + (m.content as Array<{ text?: string }>).reduce((s, p) => s + (p.text?.length || 0), 0)
          return sum
        }, 0)
        console.log(`[Agent] iter=${state.iterations} msgs=${requestMessages.length} ~${Math.round(approxChars / 4)}tok tools=${activeTools.length} step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)

        const modelTools = withCadenceProgressUpdateSchemas(
          compactToolDefinitionsForModel(activeTools),
          effectiveCadenceNarrationInMainTurn,
        )
        const isFinalInlineAnswerTurn = finalInlineAnswerTurn(state, this.options.messages)
        const isFinalSavedDeliverableTurn = finalSavedDeliverableTurn(state, this.options.messages)
        const isFinalDeliverableHandoffTurn = !!state.finalDeliverableHandoffPending
        const isInitialFinalSavedDeliverableTurn = isFinalSavedDeliverableTurn &&
          !state.partialFileWriteRecoveryPending &&
          !hasSavedFinalDeliverableCandidate(state)
        const isBoundedPartialRecoveryClosingAppend =
          isFinalSavedDeliverableTurn &&
          isPartialRecoveryClosingAppendTurn(state)
        const maxTokens = useCompactNarration
          ? Math.min(maxTokensForIteration(state), FORCED_NARRATION_MAX_TOKENS)
          : isFinalDeliverableHandoffTurn
          ? Math.min(maxTokensForIteration(state), FINAL_DELIVERABLE_HANDOFF_MAX_TOKENS)
          : isBoundedPartialRecoveryClosingAppend
          ? Math.min(maxTokensForIteration(state), PARTIAL_RECOVERY_CLOSING_APPEND_MAX_TOKENS)
          : isFinalInlineAnswerTurn
          ? Math.min(maxTokensForIteration(state), finalInlineAnswerMaxTokens(state, this.options.messages))
          : useTextFinalDeliverable
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_TEXT_MAX_TOKENS)
          : isInitialFinalSavedDeliverableTurn
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_INITIAL_MAX_TOKENS)
          : isFinalSavedDeliverableTurn
          ? Math.min(maxTokensForIteration(state), FINAL_SAVED_DELIVERABLE_MAX_TOKENS)
          : standaloneWebsiteNeedsInitialCreate
          ? Math.min(maxTokensForIteration(state), INITIAL_STANDALONE_WEBSITE_MAX_TOKENS)
          : fastSourceActionTurn
          ? Math.min(maxTokensForIteration(state), FAST_SOURCE_ACTION_MAX_TOKENS)
          : fastActionTurn
          ? Math.min(maxTokensForIteration(state), FAST_ACTION_MAX_TOKENS)
          : maxTokensForIteration(state)
        const requestTemperature = useCompactNarration
          ? 0.25
          : isFinalDeliverableHandoffTurn
            ? 0.3
          : isFinalInlineAnswerTurn
            ? Math.min(0.35, state.strategyConfig?.temperature ?? strategy.temperature)
            : isFinalSavedDeliverableTurn
              ? Math.min(0.35, state.strategyConfig?.temperature ?? strategy.temperature)
            : state.strategyConfig?.temperature ?? strategy.temperature
        const requestReasoning = useCompactNarration
          ? { reasoning: PRESENTATION_REASONING }
          : isFinalDeliverableHandoffTurn
            ? { reasoning: PRESENTATION_REASONING }
          : isFinalInlineAnswerTurn
            ? { reasoning: DEEP_TASK_REASONING }
            : isFinalSavedDeliverableTurn
              ? { reasoning: DEEP_TASK_REASONING }
              : standaloneWebsiteNeedsInitialCreate
                ? { reasoning: DEEP_TASK_REASONING }
              : fastActionTurn
                ? { reasoning: FAST_ACTION_REASONING }
            : { reasoning: TASK_REASONING }
        const requestTimeoutMs = useCompactNarration
            ? FORCED_NARRATION_REQUEST_TIMEOUT_MS
          : isFinalDeliverableHandoffTurn
            ? FINAL_DELIVERABLE_HANDOFF_REQUEST_TIMEOUT_MS
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
          : fastSourceActionTurn
            ? FAST_SOURCE_ACTION_REQUEST_TIMEOUT_MS
          : fastActionTurn
            ? state.consecutiveNullStreams > 0
              ? FAST_ACTION_RETRY_REQUEST_TIMEOUT_MS
              : FAST_ACTION_REQUEST_TIMEOUT_MS
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
          providerRequiredToolChoice: supportsProviderRequiredToolChoice(model),
          fastActionTurn,
          fastSourceActionTurn,
          forceTextNextIteration: !!state.forceTextNextIteration,
          cadenceNarrationInMainTurn: effectiveCadenceNarrationInMainTurn,
          approxTokens: Math.round(approxChars / 4),
          maxTokens,
          finalInlineAnswer: isFinalInlineAnswerTurn,
          finalSavedDeliverable: isFinalSavedDeliverableTurn,
          initialStandaloneWebsiteCreate: standaloneWebsiteNeedsInitialCreate,
          requestedToolChoice: standaloneWebsiteNeedsInitialCreate && useRequiredToolCall
            ? 'create_website'
            : useRequiredToolCall
              ? 'required'
              : null,
          requestTimeoutMs,
        })
        // Preserve the exact request envelope for the synchronous conservative
        // debit if this provider omits the final streamed usage chunk. Capture
        // again on retry so accounting follows the request that actually ran.
        captureUsageEstimateEnvelope?.(requestMessages, modelTools)
        await this.assertServerCreditRunwayCached()
        const streamPolicy = {
          allowParallelSourceExtractionCalls: allowParallelSourceToolCalls,
          maxParallelSourceExtractionCalls,
          cadenceProgressUpdateEnabled: effectiveCadenceNarrationInMainTurn,
        }
        // Capture the exact request policy before awaiting provider response
        // headers. If the request itself times out, the outer loop can still
        // distinguish a real cadence-enabled action request from a text-only
        // request and avoid an unnecessary cadence retry.
        captureStreamToolCallPolicy?.(streamPolicy)

        const response = await createStreamingCompletion({
          model,
          messages: requestMessages,
          ...(modelTools.length > 0
            ? { tools: modelTools as unknown as ChatCompletionTool[] }
            : {}),
          ...(requestedToolChoice !== undefined ? { tool_choice: requestedToolChoice } : {}),
          temperature: requestTemperature,
          parallel_tool_calls: allowParallelSourceToolCalls,
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
          /\bfunction\.arguments\b[\s\S]*\bJSON format\b|\b(?:invalid_parameter_error|invalid_parameter)\b[\s\S]{0,240}\b(?:function\.arguments|tool(?: call)? arguments?)\b/i.test(errorText)
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
            maxAttempts: maxModelStartAttempts,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          if (providerRequestRepairAttempts < MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS) {
            providerRequestRepairAttempts++
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
          state.pendingToolJsonRecovery = false
          state.lastModelErrorForUser = 'The assistant rejected malformed tool-call data after bounded compatibility repairs. Please retry the task.'
          console.error('[Agent] Assistant service rejected malformed tool-call JSON after bounded compatibility repairs; stopping the run.')
          return null
        }
        const providerRejectedForcedToolMode = status === 400 &&
          lastShouldRequireToolCall &&
          !relaxRequiredToolChoice &&
          /\b(?:tool_choice|required tool(?: call)?|forced tool(?: call)?|function(?:s| calling)?[^\n]{0,100}(?:unsupported|not supported|not available)|tools?[^\n]{0,100}(?:unsupported|not supported|not available|does not support))\b/i.test(errorText)
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
            maxAttempts: maxModelStartAttempts,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            activeStep: state.currentPlanItems?.[state.currentStepIdx],
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          relaxRequiredToolChoice = true
          if (providerRequestRepairAttempts < MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS) {
            providerRequestRepairAttempts++
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
          state.pendingToolJsonRecovery = false
          state.lastModelErrorForUser = 'The assistant rejected the tool-call request after bounded compatibility repairs. Please retry the task.'
          console.error('[Agent] Assistant service rejected forced tool-call mode after bounded compatibility repairs; stopping the run.')
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
        const deterministicRequestFailure = classifyDeterministicProviderRequestFailure(status, errorText)
        if (deterministicRequestFailure) {
          const repair = deterministicRequestFailure.messagePayloadRepairable &&
            providerRequestRepairAttempts < MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS
            ? sanitizeProviderRequestMessagesForRetry(requestMessages)
            : null

          if (repair?.changed) {
            providerRequestRepairAttempts++
            requestMessages = repair.messages as ChatMessageParam[]
            state.iterationDelayMs = MIN_ITERATION_DELAY_MS
            this.options.diagnostics?.({
              type: 'stream_error',
              data: {
                category: 'provider_request_payload_repair',
                providerCategory: deterministicRequestFailure.category,
                attempt: attempt + 1,
                maxAttempts: maxModelStartAttempts,
                repairAttempt: providerRequestRepairAttempts,
                iteration: state.iterations,
                phase: state.currentPhase,
                step: state.currentStepIdx,
                status,
                error: sanitizeAgentServiceError(streamErr),
              },
            })
            console.warn('[AgentDiagnostics] Retrying one normalized provider request before the terminal 4xx fence', {
              category: deterministicRequestFailure.category,
              repairAttempt: providerRequestRepairAttempts,
              iteration: state.iterations,
              step: state.currentStepIdx,
              status,
            })
            continue
          }

          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'provider_request_rejected_terminal',
              providerCategory: deterministicRequestFailure.category,
              attempt: attempt + 1,
              maxAttempts: maxModelStartAttempts,
              repairAttempts: providerRequestRepairAttempts,
              repairAvailable: deterministicRequestFailure.messagePayloadRepairable,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Deterministic provider request failure reached the terminal fence', {
            category: deterministicRequestFailure.category,
            attempt: attempt + 1,
            repairAttempts: providerRequestRepairAttempts,
            iteration: state.iterations,
            step: state.currentStepIdx,
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          state.pendingToolJsonRecovery = false
          state.lastModelErrorForUser = deterministicRequestFailure.category === 'authentication'
            ? 'The assistant service credentials were rejected. Please check the configured provider credentials and retry the task.'
            : providerRequestRepairAttempts > 0
              ? 'The assistant rejected its request data after bounded compatibility repairs. Please retry the task.'
              : 'The assistant rejected the request data before the next action could start. Please retry the task.'
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
    cadenceNarrationRetry = false,
  ): Phase {
    if (!(error instanceof Error)) {
      return 'ERROR'
    }

    // Fatal timeout
    if (error instanceof TimeoutError && !error.nudgeable) {
      state.lastModelErrorForUser = 'The assistant stopped responding.'
      return 'ERROR'
    }

    // Nudgeable timeout
    if (isNudgeableTimeout(error)) {
      if (state.finalDeliverableHandoffPending) {
        const partialContent = (error.partialContent || '').trim()
        state.finalDeliverableHandoffAttempts += 1
        if (shouldAcceptFinalDeliverableHandoff(partialContent, state.finalDeliverableHandoffAttempts, state)) {
          const stepBeforeComplete = state.currentStepIdx
          this.emitter.textDelta(partialContent)
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
          state.finalDeliverableHandoffPending = null
          if (state.currentPlanItems) state.currentStepIdx = state.currentPlanItems.length
          state.lastIterationEnd = Date.now()
          for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
            this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
          }
          return 'COMPLETE'
        }
        if (state.finalDeliverableHandoffAttempts < 2) {
          contextManager.push({
            role: 'system',
            content: 'The previous personalized handoff stalled. Give the concise, task-specific final response immediately.',
          } as ChatMessageParam)
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
          state.lastIterationEnd = Date.now()
          return 'STREAMING'
        }
        const stepBeforeComplete = state.currentStepIdx
        state.finalDeliverableHandoffPending = null
        if (state.currentPlanItems) state.currentStepIdx = state.currentPlanItems.length
        for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
          this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
        }
        return 'COMPLETE'
      }

      if (finalInlineAnswerTurn(state, this.options.messages)) {
        const partialContent = error.partialContent || ''
        if (shouldCompleteFinalInlineAnswerTurn(state, this.options.messages, partialContent)) {
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
          if (state.currentPlanItems) {
            state.currentStepIdx = state.currentPlanItems.length
          }
          state.forceTextNextIteration = false
          state.phaseEndNarrationPending = false
          state.finalInlineAnswerDelivered = true
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

        state.lastModelErrorForUser = 'The final answer took too long to respond. Please try again.'
        return 'ERROR'
      }

      if (isInitialStandaloneWebsiteCreateTurn(state)) {
        if (state.timeoutNudgeCount < 1) {
          state.timeoutNudgeCount++
          contextManager.push({
            role: 'system',
            content: 'WEBSITE GENERATION RETRY: the previous exact create_website stream did not finish. Make the same single complete native create_website call now. Do not switch tools, emit prose, or split the website across calls.',
          } as ChatMessageParam)
          state.iterationDelayMs = MIN_ITERATION_DELAY_MS
          state.lastIterationEnd = Date.now()
          return 'STREAMING'
        }

        state.lastModelErrorForUser = 'The website generation stream stalled twice. Those incomplete internal attempts were not charged; please retry the task.'
        return 'ERROR'
      }

      if (finalSavedDeliverableTurn(state, this.options.messages)) {
        const hasSavedFinalDeliverable = hasSavedFinalDeliverableCandidate(state)
        if (
          hasSavedFinalDeliverable &&
          state.timeoutNudgeCount >= MAX_TIMEOUT_NUDGES
        ) {
          const stepBeforeComplete = state.currentStepIdx
          state.pendingDeliverableRevision = null
          state.deliverableVerificationDone = true
          state.currentStepIdx = state.currentPlanItems?.length || state.currentStepIdx
          for (let i = stepBeforeComplete; i < state.currentStepIdx; i++) {
            this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
          }
          console.log('[AgentDiagnostics] Completed with existing saved deliverable after final-turn timeout nudges', {
            step: stepBeforeComplete,
            totalSteps: state.currentPlanItems?.length || 0,
            finalPath: latestSavedFinalDeliverablePath(state),
            timeoutNudgeCount: state.timeoutNudgeCount,
          })
          return 'COMPLETE'
        }
        if (!hasSavedFinalDeliverable && state.timeoutNudgeCount >= MAX_TIMEOUT_NUDGES) {
          state.lastModelErrorForUser = 'The final file write took too long to start. Please retry the task.'
          return 'ERROR'
        }
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
        if (!cadenceNarrationRetry && partialContent) {
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
        }

        const nudgeMessage = cadenceNarrationRetry
          ? cadenceNarrationActionRetryMessage('the prior cadence-enabled action stream stalled before completing an action')
          : state.taskStrategy === 'browse'
            ? 'Time check: you have been reasoning too long for a live website task. Call a browser tool now — browser_screenshot, browser_click_at, browser_type, browser_scroll, browser_select, or browser_find_text — and continue from the current page.'
            : isBuild
              ? 'Time check: you have been generating text for a while. Call a tool to make progress — image_search, create_file, append_file, export_pdf, or edit_file.'
              : 'Time check: extended reasoning detected. Call a tool to gather information or produce output. If you are stuck, try a different approach.'
        contextManager.push({ role: 'system', content: nudgeMessage } as unknown as ChatMessageParam)

        state.lastIterationEnd = Date.now()
        return 'STREAMING'
      }

      // Escalate the recovery route instead of converting provider jitter into
      // a terminal task failure. Clear local loop suppression and demand one
      // concrete action; the ordinary iteration/runtime deadline is still the
      // bounded stop if the provider never recovers.
      state.timeoutNudgeCount = 0
      state.consecutiveNoToolCalls = Math.max(1, state.consecutiveNoToolCalls)
      state.suppressedResearchToolName = null
      state.stepLoopDetections = 0
      state.recentToolCalls = []
      state.forceTextNextIteration = false
      contextManager.push({
        role: 'system',
        content: isBuild
          ? 'MODEL TIMEOUT ROUTE RECOVERY: the previous response route stalled repeatedly. Continue from current state with exactly one concrete native build or file tool call. Use a different viable action/path than the stalled attempt. Do not restart, plan, apologize, narrate, or stop the task.'
          : state.taskStrategy === 'browse'
            ? 'MODEL TIMEOUT ROUTE RECOVERY: the previous response route stalled repeatedly. Continue from the current page with exactly one concrete browser action. Change the action or route if the previous target was unresponsive. Do not restart, plan, apologize, narrate, or stop the task.'
            : 'MODEL TIMEOUT ROUTE RECOVERY: the previous response route stalled repeatedly. Continue the active phase with exactly one concrete native tool call, using a different viable source or action path. Do not restart, plan, apologize, narrate, or stop the task.',
      } as ChatMessageParam)
      state.iterationDelayMs = MIN_ITERATION_DELAY_MS
      state.lastIterationEnd = Date.now()
      return 'STREAMING'
    }

    if (isTransientAssistantStreamError(error)) {
      state.consecutiveNullStreams = (state.consecutiveNullStreams || 0) + 1
      state.iterationDelayMs = MIN_ITERATION_DELAY_MS
      state.lastIterationEnd = Date.now()
      if (state.consecutiveNullStreams <= 2) {
        if (!cadenceNarrationRetry) deferNarrationCadenceAttempt(state)
        contextManager.push({
          role: 'system',
          content: cadenceNarrationRetry
            ? cadenceNarrationActionRetryMessage('the prior cadence-enabled action stream disconnected before completion')
            : 'MODEL STREAM NETWORK RECOVERY: the previous model stream disconnected before completion. Retry the active phase immediately with one concrete next action. Do not restart, summarize, apologize, or ask permission.',
        } as ChatMessageParam)
        return 'STREAMING'
      }
      state.lastModelErrorForUser = 'Assistant stream lost connection repeatedly. Please retry the task.'
      return 'ERROR'
    }

    // Unknown errors — retry
    if (state.iterations < state.dynamicIterationLimit) {
      console.error('[Agent] Stream interrupted, retrying iteration...')
      state.lastIterationEnd = Date.now()
      state.iterationDelayMs = MIN_ITERATION_DELAY_MS
      return 'STREAMING'
    }
    state.lastModelErrorForUser = 'The task stopped before it finished. Please try again.'
    return 'ERROR'
  }
}
