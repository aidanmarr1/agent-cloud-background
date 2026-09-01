import type { AgentEventEmitter } from './SSEEmitter'
import type { AgentStateData } from './AgentState'
import type { TierTimeouts } from './guards'
import { stripThinkingTags, stripStepMarkers, stripPlanMarkers, stripSpecialTokens, stripTextModeToolCallBlocks, stripInternalPolicyScaffolding, checkForLeakage, unescapeJsonChunk } from './guards'
import { IterationTimeoutError, InactivityTimeoutError, ContentOnlyTimeoutError } from './errors'
import { formatVisibleActionLabel, strictActionLabelFromArgs } from '@/lib/stream/ActivityDescriber'
import { NARRATION_MAX_VISIBLE_ACTION_GAP, NARRATION_THRESHOLD_DEFAULT } from './config'
import { sanitizeToolStartArgs } from './toolEventSanitizer'
import {
  extractCadenceProgressUpdate,
  reviewProgressNarration,
  stripCadenceProgressUpdateFromArguments,
} from './NarrationMemory'

export interface ToolCallData {
  id: string
  name: string
  arguments: string
  provisionalStartEmitted?: boolean
  provisionalStartExposed?: boolean
}

export interface StreamUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
}

export interface MissingStreamUsageEstimateInput {
  assistantContent: string
  reasoningContent: string
  toolCalls: Map<number, ToolCallData>
}

export type MissingStreamUsageEstimator = (
  input: MissingStreamUsageEstimateInput,
) => StreamUsage

export interface StreamResult {
  assistantContent: string
  reasoningContent: string
  toolCalls: Map<number, ToolCallData>
  finishReason?: string | null
  textOverflowSuppressed?: boolean
  stepAdvancedThisIteration: boolean
  leakageDetected: boolean
  timedOut: boolean
  contentStreamingStartTime: number | null
  usage: StreamUsage | null
  usageEstimated?: boolean
  cadenceProgressUpdate?: string
  cadenceProgressToolCallId?: string
  cadenceProgressViolation?: CadenceProgressViolation
}

/**
 * A cadence update is released before its bound action. Some native actions
 * already created a buffered provisional start while their arguments streamed;
 * deferred tools are first counted later, after execution preflight. Preserve
 * exactly the former here so both paths begin the new cadence window at one.
 */
export function carriedCadenceActionCount(
  result: Pick<StreamResult, 'toolCalls' | 'cadenceProgressToolCallId'>,
): 0 | 1 {
  if (!result.cadenceProgressToolCallId) return 0
  const boundToolCall = [...result.toolCalls.values()].find(
    (toolCall) => toolCall.id === result.cadenceProgressToolCallId,
  )
  return boundToolCall?.provisionalStartEmitted ? 1 : 0
}

export type CadenceProgressViolationCode =
  | 'missing_tool_call'
  | 'missing_progress_update'
  | 'invalid_progress_update'
  | 'duplicate_progress_update'

export interface CadenceProgressViolation {
  code: CadenceProgressViolationCode
  reason: string
}

export interface StreamToolCallPolicy {
  allowParallelSourceExtractionCalls: boolean
  maxParallelSourceExtractionCalls: number
  cadenceProgressUpdateEnabled?: boolean
  allowLongAssistantText?: boolean
  textSavedDeliverable?: {
    id: string
    path: string
    actionLabel: string
    started?: boolean
  }
}

type StreamingResponseChunk = {
  choices: Array<{
    delta?: Record<string, unknown>
    finish_reason?: string | null
  }>
}

// File previews are a live transparency surface, not a completion preview.
// Forward every provider content chunk so the editor is visible from the
// opening characters instead of appearing after a large buffered block.
const FILE_PREVIEW_MIN_DELTA_CHARS = 1
const PROGRESS_NARRATION_TEXT_STREAM_CAP = 420
const FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 30_000
const FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 3_000
// create_website streams the complete HTML, CSS, and JavaScript through one
// native tool envelope. Once that visible action has started, let a healthy
// stream finish instead of clipping it at the generic 60-second turn boundary.
const WEBSITE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 180_000
const WEBSITE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 20_000
const STABLE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 8_000
const STABLE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 2_500
const STABLE_READ_ONLY_SOURCE_TOOLS = new Set(['web_search', 'read_document'])
const PARALLEL_STREAM_SOURCE_EXTRACTION_TOOLS = new Set([
  'read_document',
  'http_request',
])
const STREAMED_FILE_WRITE_TOOLS = new Set(['create_file', 'create_website', 'append_file', 'edit_file'])
const MAX_PARALLEL_STREAM_SOURCE_EXTRACTIONS = 3
const DISPLAY_FUTURE_ACTION_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:let\s+me|i(?:'|’)?ll|i\s+(?:will|need\s+to|have\s+to)|i(?:'|’)?m\s+going\s+to)\b[^.!?\n]*(?:research|search|look|gather|read|open|try|check|verify|move|continue|get|fetch|use|do|ground)\b[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_FUTURE_ACTION_TAIL_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:(?:l|le|let(?:\s+m(?:e)?)?|i(?:'|’)?(?:l(?:l)?|$)|i\s*(?:w(?:ill?)?|a(?:m)?|$)|i(?:'|’)?m(?:\s+g(?:oing?)?)?)\b|(?:extract|read|review|open|search|gather|scroll|find|get|try|check|verify|compare|continue|use|visit|fetch|inspect|navigate)\b|(?:the|this|that|an?|our|their)\b|(?:(?:the|this|that|an?|our|their)\s+)?(?:[A-Za-z0-9'’.-]+\s+){0,6}(?:source|article|blog|post|guide|paper|report|documentation|website|page)\b)[^.!?\n]*$/i
const DISPLAY_INTERNAL_TASK_REFLECTION_RE =
  /(?:^|(?<=[.!?]\s))\s*The user (?:has asked|asked|wants|requested)\b[^.!?\n]*(?:current plan|plan step|step \d|i(?:'|’)?ll|i\s+will)[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_OPERATIONAL_COMMAND_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:extract|read|review|open|search|gather|scroll|find|get|try|check|verify|compare|continue|use|visit|fetch|inspect|navigate)\b[^.!?\n]*(?:content|details|page|source|sources|docs?|documentation|article|blog|post|guide|paper|report|website|url|pricing|features?|query|results?|information|evidence|benchmarks?|next|instead)\b[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_SPECULATIVE_SOURCE_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:(?:the|this|that|an?|our|their)\s+)?(?:[A-Za-z0-9'’.-]+\s+){0,6}(?:source|article|blog|post|guide|paper|report|documentation|website|page)\b[^.!?\n]{0,180}\b(?:likely|probably|perhaps|may|might|could|should|is expected to)\b[^.!?\n]{0,120}\b(?:contain(?:s|ed)?|provid(?:e|es|ed)|explain(?:s|ed)?|detail(?:s|ed)?|show(?:s|ed)?|cover(?:s|ed)?|offer(?:s|ed)?|include(?:s|d)?)\b[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_INTERNAL_PROVIDER_RECOVERY_START_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:the\s+)?(?:(?:free\s+)?(?:serper|tavily|firecrawl|openrouter|deepseek|browserless|e2b)(?:\s+api)?|(?:search|model|tool|browser|extraction)\s+(?:api|provider)|provider\s+(?:api|request|response))\b/i
const DISPLAY_INTERNAL_PROVIDER_RECOVERY_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*[^.!?\n]{0,80}\b(?:(?:free\s+)?(?:serper|tavily|firecrawl|openrouter|deepseek|browserless|e2b)(?:\s+api)?|(?:search|model|tool|browser|extraction)\s+(?:api|provider)|provider\s+(?:api|request|response))\b[^.!?\n]{0,160}\b(?:block(?:ed|ing)?|fail(?:ed|ure)?|reject(?:ed|ion)?|tim(?:ed?\s*out|eout)|rate[-\s]?limit(?:ed|ing)?|quota|unavailable|error)\b[^.!?\n]*(?:[.!?]|$)/gi

function isProviderStepAdvanceToolName(value: string): boolean {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '') === 'nextstep'
}

function normalizeUsage(raw: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }): StreamUsage | null {
  if (!Number.isFinite(raw.prompt_tokens) || !Number.isFinite(raw.completion_tokens) || !Number.isFinite(raw.cost)) return null
  const promptTokens = Math.max(0, Math.round(raw.prompt_tokens || 0))
  const completionTokens = Math.max(0, Math.round(raw.completion_tokens || 0))
  const totalTokens = Number.isFinite(raw.total_tokens)
    ? Math.max(0, Math.round(raw.total_tokens || 0))
    : promptTokens + completionTokens
  const cost = Math.max(0, Number(raw.cost || 0))
  return { promptTokens, completionTokens, totalTokens, cost }
}

function decodePartialJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

function extractStringArg(rawArgs: string, key: string): string | undefined {
  const match = rawArgs.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  return match ? decodePartialJsonString(match[1]) : undefined
}

function extractNumberArg(rawArgs: string, key: string): number | undefined {
  const match = rawArgs.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : undefined
}

function extractPartialStringArg(rawArgs: string, key: string): string | undefined {
  const marker = rawArgs.match(new RegExp(`"${key}"\\s*:\\s*"`))
  if (!marker || marker.index === undefined) return undefined

  const start = marker.index + marker[0].length
  let escaped = false
  let rawValue = ''
  for (let i = start; i < rawArgs.length; i++) {
    const ch = rawArgs[i]
    if (escaped) {
      rawValue += `\\${ch}`
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') break
    rawValue += ch
  }

  const { text } = unescapeJsonChunk(rawValue, false)
  return text
}

function hasStableToolArgumentEnvelope(
  toolCalls: Map<number, ToolCallData>,
  state: AgentStateData,
): boolean {
  return [...toolCalls.values()].some((toolCall) => {
    // Keep this protection scoped to the recurrent read-only source-call
    // failures. Broadly extending every malformed native tool stream would
    // make unrelated bad calls slower to fail forward.
    if (!STABLE_READ_ONLY_SOURCE_TOOLS.has(toolCall.name)) return false
    const actionLabel = extractStringArg(toolCall.arguments, 'action_label')
    const planStepIndex = extractNumberArg(toolCall.arguments, 'plan_step_index')
    if (!strictActionLabelFromArgs({ action_label: actionLabel })) return false
    if (!Number.isInteger(planStepIndex)) return false
    if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return true
    return planStepIndex === state.currentStepIdx + 1
  })
}

function inlineFinalAnswerAllowsLongText(state: AgentStateData): boolean {
  if (state.finalDeliverableHandoffPending) return true
  if (state.currentPhase !== 'deliver') return false
  if (!state.currentPlanItems || state.currentStepIdx !== state.currentPlanItems.length - 1) return false
  const text = [
    state.currentPlanItems[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
    state.originalUserRequest || '',
  ].join(' ')
  const cleaned = text
    .replace(/\b(?:no|without)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck)\b/gi, ' ')
    .replace(/\b(?:don'?t|do\s+not|never)\s+(?:create|make|save|export|generate|write|return|produce)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck)\b/gi, ' ')
  const explicitSavedArtifact = /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|pptx|xlsx)\b/i.test(cleaned) ||
    /\b(?:save|create|write|export|make|generate|deliver|return|produce)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|deliverable)\b/i.test(cleaned)
  const inlineHint = /\b(?:in chat|answer\s+(?:directly|here)|directly\s+in\s+chat|no file|no document|just answer)\b/i.test(text) ||
    /\b(?:answer|report|summary|write)\b/i.test(state.currentPlanItems[state.currentStepIdx] || '')
  return inlineHint && !explicitSavedArtifact
}

function shouldCapProgressNarrationText(state: AgentStateData): boolean {
  if (state.forceTextNextIteration || state.phaseEndNarrationPending) return true
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.visibleToolActionsSinceLastNarration < NARRATION_THRESHOLD_DEFAULT || state.stepToolCallCount <= 0) return false

  const isFinalStep = state.currentStepIdx === state.currentPlanItems.length - 1
  return !isFinalStep || state.currentPhase !== 'deliver'
}

function addStringMetrics(target: Record<string, unknown>, rawArgs: string, key: string): void {
  const value = extractPartialStringArg(rawArgs, key)
  if (!value) return
  target[`${key}CharCount`] = value.length
  target[`${key}LineCount`] = value.split('\n').length
}

function addProvisionalRuntimeDisplayContract(
  args: Record<string, unknown>,
  state: AgentStateData,
): void {
  if (
    state.currentPlanItems &&
    state.currentStepIdx < state.currentPlanItems.length &&
    args.plan_step_index === undefined
  ) {
    args.plan_step_index = state.currentStepIdx + 1
  }
}

function addDisplayContractArgs(args: Record<string, unknown>, parsed: Record<string, unknown> | null, rawArgs: string): void {
  const actionLabel = parsed ? parsed.action_label : extractStringArg(rawArgs, 'action_label')
  if (typeof actionLabel === 'string' && actionLabel) args.action_label = formatVisibleActionLabel(actionLabel)

  const planStepIndex = parsed ? parsed.plan_step_index : extractNumberArg(rawArgs, 'plan_step_index')
  if (typeof planStepIndex === 'number' && Number.isFinite(planStepIndex)) args.plan_step_index = planStepIndex
}

function pickString(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (typeof value === 'string' && value) target[key] = value
}

function pickNumber(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
}

function buildEarlyToolArgs(toolName: string, rawArgs: string): Record<string, unknown> {
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(rawArgs)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Tool args are usually incomplete while the model is streaming them.
  }

  const args: Record<string, unknown> = {}
  addDisplayContractArgs(args, parsed, rawArgs)
  const addString = (key: string) => {
    const value = parsed ? parsed[key] : extractStringArg(rawArgs, key)
    if (typeof value === 'string' && value) args[key] = value
  }
  const addNumber = (key: string) => {
    const value = parsed ? parsed[key] : extractNumberArg(rawArgs, key)
    if (typeof value === 'number' && Number.isFinite(value)) args[key] = value
  }

  switch (toolName) {
    case 'web_search':
    case 'image_search':
      addString('query')
      addNumber('count')
      break
    case 'create_file':
    case 'append_file':
    case 'edit_file':
    case 'read_file':
    case 'delete_file':
      addString('path')
      if (toolName === 'create_file' || toolName === 'append_file') {
        addStringMetrics(args, rawArgs, 'content')
      } else if (toolName === 'edit_file') {
        addStringMetrics(args, rawArgs, 'new_string')
      }
      break
    case 'create_website':
      addString('output_path')
      addStringMetrics(args, rawArgs, 'html')
      // A streamed action_label only describes intent; it is not evidence that
      // website content has started arriving. Do not invent index.html early,
      // because that made clipped label-only calls flash as live file writes.
      // Once real HTML is present, the preview path can truthfully mirror the
      // runtime's optional output_path default.
      if (typeof args.output_path === 'string' && args.output_path) {
        args.path = args.output_path
      } else if (typeof args.htmlCharCount === 'number' && args.htmlCharCount > 0) {
        args.path = 'index.html'
      }
      break
    case 'list_files':
      addString('directory')
      addString('path')
      break
    case 'export_pdf':
      addString('source_path')
      addString('output_path')
      addString('title')
      break
    case 'execute_command':
      addString('command')
      break
    case 'run_code':
      addString('language')
      addStringMetrics(args, rawArgs, 'code')
      break
    case 'browse_page':
    case 'browser_navigate':
      addString('url')
      break
    case 'read_document':
      addString('source')
      addString('url')
      break
    case 'http_request':
      addString('method')
      addString('url')
      break
    case 'browser_click':
      addNumber('index')
      addString('selector')
      break
    case 'browser_click_at':
    case 'browser_hover':
      addNumber('index')
      addString('selector')
      break
    case 'browser_type':
      addNumber('index')
      addString('selector')
      addString('text')
      break
    case 'browser_select':
      addNumber('index')
      addString('selector')
      addString('value')
      break
    case 'browser_scroll':
      addString('direction')
      break
    case 'browser_screenshot':
      if (parsed && typeof parsed.fullPage === 'boolean') args.fullPage = parsed.fullPage
      break
    case 'browser_press_key':
      addString('key')
      break
    case 'browser_click_and_hold':
      addNumber('index')
      addNumber('duration')
      break
    case 'browser_drag':
      addNumber('fromIndex')
      addNumber('toIndex')
      addString('fromSelector')
      addString('toSelector')
      break
    case 'browser_fill_form':
    case 'browser_find_text':
      addString('text')
      addString('query')
      break
    default:
      if (parsed) {
        pickString(args, parsed, 'path')
        pickString(args, parsed, 'url')
        pickString(args, parsed, 'query')
        pickString(args, parsed, 'command')
        pickNumber(args, parsed, 'index')
      }
  }

  return sanitizeToolStartArgs(toolName, args)
}

function searchWouldBePreflightBlocked(toolName: string, args: Record<string, unknown>, state: AgentStateData): boolean {
  if (toolName !== 'web_search') return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.taskStrategy === 'browse' || state.taskStrategy === 'build' || state.taskStrategy === 'code') return false

  const query = typeof args.query === 'string' ? args.query.toLowerCase().trim() : ''
  return !!query && state.stepSearchQueries.has(query)
}

function shouldEmitProvisionalToolStart(toolName: string, args: Record<string, unknown>, state: AgentStateData): boolean {
  // Every visible action title comes from the model-authored action_label.
  // A known file path is useful preview metadata, but must never be promoted
  // into a generic path-derived title while the real label is still streaming.
  if (!strictActionLabelFromArgs(args)) return false

  if (toolName === 'web_search' || toolName === 'image_search') {
    if (searchWouldBePreflightBlocked(toolName, args, state)) return false
    return typeof args.query === 'string' && args.query.length > 0
  }

  if (toolName === 'create_file' || toolName === 'append_file') {
    return typeof args.path === 'string' && args.path.length > 0
  }

  if (toolName === 'create_website') {
    return typeof args.path === 'string' && args.path.length > 0 &&
      typeof args.htmlCharCount === 'number' && args.htmlCharCount > 0
  }

  if (toolName === 'edit_file') {
    return typeof args.path === 'string' && args.path.length > 0
  }

  if (toolName === 'execute_command') {
    return typeof args.command === 'string' && args.command.length > 0
  }

  if (toolName === 'run_code') {
    return typeof args.language === 'string' || typeof args.codeLineCount === 'number'
  }

  return false
}

function normalizePreviewPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/')
}

function pendingDeliverableRevisionAllowsPreview(
  toolName: string,
  args: Record<string, unknown>,
  state: AgentStateData,
): boolean {
  const pending = state.pendingDeliverableRevision
  if (!pending) return true
  if (toolName !== 'create_file' && toolName !== 'create_website' && toolName !== 'append_file' && toolName !== 'edit_file') return true
  if (toolName !== 'append_file' && toolName !== 'edit_file') return false

  const rawPath = typeof args.path === 'string' ? args.path : ''
  return rawPath.length > 0 && normalizePreviewPath(rawPath) === pending.path
}

function isCurrentPlanStepPreview(args: Record<string, unknown>, state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return true
  const rawIndex = args.plan_step_index
  const index = typeof rawIndex === 'number'
    ? rawIndex
    : typeof rawIndex === 'string'
      ? Number(rawIndex)
      : NaN
  return Number.isInteger(index) && index === state.currentStepIdx + 1
}

function provisionalToolStartSignature(toolCall: ToolCallData, args: Record<string, unknown>): string {
  const stableArgs = { ...args }
  delete stableArgs.contentCharCount
  delete stableArgs.contentLineCount
  delete stableArgs.new_stringCharCount
  delete stableArgs.new_stringLineCount
  delete stableArgs.codeCharCount
  delete stableArgs.codeLineCount
  delete stableArgs.htmlCharCount
  delete stableArgs.htmlLineCount
  return `${toolCall.id}:${toolCall.name}:${JSON.stringify(stableArgs)}`
}

function recordVisibleToolStartForNarration(
  toolCall: ToolCallData,
  args: Record<string, unknown>,
  state: AgentStateData,
): boolean {
  if (!strictActionLabelFromArgs(args)) return false
  if (state.visibleNarrationToolStartIds.has(toolCall.id)) return false
  state.visibleNarrationToolStartIds.add(toolCall.id)
  state.visibleToolActionsSinceLastNarration++
  return true
}

function splitCleanVisibleAssistantText(text: string): { text: string; hold: string } {
  const prepared = stripInternalPolicyScaffolding(stripPlanMarkers(text))
  const tailMatch = prepared.match(DISPLAY_FUTURE_ACTION_TAIL_RE)
  const providerRecoveryStart = DISPLAY_INTERNAL_PROVIDER_RECOVERY_START_RE.exec(prepared)
  const providerRecoveryTailIndex =
    providerRecoveryStart?.index !== undefined &&
    !/[.!?](?:\s|$)/.test(prepared.slice(providerRecoveryStart.index))
      ? providerRecoveryStart.index
      : undefined
  const candidateTailIndexes = [
    tailMatch?.index,
    providerRecoveryTailIndex,
  ].filter((value): value is number => value !== undefined)
  const tailIndex = candidateTailIndexes.length > 0
    ? Math.min(...candidateTailIndexes)
    : undefined
  const hold = tailIndex !== undefined ? prepared.slice(tailIndex) : ''
  const ready = tailIndex !== undefined ? prepared.slice(0, tailIndex) : prepared
  const cleaned = ready
    .replace(DISPLAY_FUTURE_ACTION_SENTENCE_RE, ' ')
    .replace(DISPLAY_INTERNAL_TASK_REFLECTION_RE, ' ')
    .replace(DISPLAY_OPERATIONAL_COMMAND_SENTENCE_RE, ' ')
    .replace(DISPLAY_SPECULATIVE_SOURCE_SENTENCE_RE, ' ')
    .replace(DISPLAY_INTERNAL_PROVIDER_RECOVERY_SENTENCE_RE, ' ')
  return { text: cleaned.trim() ? cleaned : '', hold }
}

function containsFalseCapabilityRefusal(text: string): boolean {
  return /(?:i (?:cannot|can't|am unable to|am not able to).{0,140}(?:access|browse|interact|perform|retrieve|search|download|images?|photos?|pictures?|real[- ]world)|i do not have (?:the )?capabilit(?:y|ies).{0,120}(?:browse|search|retrieve|images?|photos?|pictures?)|i can only provide text[- ]based information|please use (?:a )?(?:search engine|google images|bing images)|as (?:an? )?(?:ai|text[- ]based ai|language model).{0,120}(?:cannot|can't|unable))/i.test(text)
}

export class StreamProcessor {
  private emitter: AgentEventEmitter
  private tierTimeouts: TierTimeouts
  private signal?: AbortSignal
  private bufferedEmissions: Array<() => void> | null = null
  private bufferedProvisionalToolStarts = new Map<string, {
    name: string
    state: AgentStateData
    counted: boolean
    exposed: boolean
  }>()

  constructor(emitter: AgentEventEmitter, tierTimeouts: TierTimeouts, signal?: AbortSignal) {
    this.emitter = emitter
    this.tierTimeouts = tierTimeouts
    this.signal = signal
  }

  setTierTimeouts(tierTimeouts: TierTimeouts): void {
    this.tierTimeouts = tierTimeouts
  }

  beginBufferedEmission(): void {
    if (this.bufferedEmissions) throw new Error('A model-turn emission buffer is already active.')
    this.bufferedEmissions = []
  }

  commitBufferedEmission(): void {
    const emissions = this.bufferedEmissions
    this.bufferedEmissions = null
    this.bufferedProvisionalToolStarts.clear()
    for (const emit of emissions || []) emit()
  }

  discardBufferedEmission(): void {
    this.bufferedEmissions = null
    // Live file previews intentionally bypass the model-turn buffer. If the
    // enclosing turn is rejected (provider failure, debit failure, or cadence
    // rejection), explicitly settle every exposed action so the client cannot
    // retain a stuck blue pill or LIVE editor.
    const provisionalStarts = [...this.bufferedProvisionalToolStarts]
    this.bufferedProvisionalToolStarts.clear()
    for (const [id, provisional] of provisionalStarts) {
      if (provisional.counted && provisional.state.visibleNarrationToolStartIds.delete(id)) {
        provisional.state.visibleToolActionsSinceLastNarration = Math.max(
          0,
          provisional.state.visibleToolActionsSinceLastNarration - 1,
        )
      }
      if (provisional.exposed) {
        this.emitter.toolResult(id, provisional.name, {
          error: 'INTERNAL_RECOVERY: The streamed file action was discarded before execution. Retry the current write.',
          discarded: true,
        } as never)
      }
    }
  }

  private emit(callback: () => void, options: { immediate?: boolean } = {}): void {
    if (this.bufferedEmissions && !options.immediate) {
      this.bufferedEmissions.push(callback)
      return
    }
    callback()
  }

  async processStream(
    response: AsyncIterable<StreamingResponseChunk>,
    state: AgentStateData,
    cadenceProgressUpdateEnabled = false,
    estimateMissingUsage?: MissingStreamUsageEstimator,
    toolCallPolicy?: StreamToolCallPolicy,
    onCadenceProgressReady?: (text: string, toolCallId: string) => void,
  ): Promise<StreamResult> {
    if (this.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const emittedToolStarts: Map<number, string> = new Map()
    const filePreviewState: Map<number, { path: string; emittedChars: number; started: boolean }> = new Map()
    let assistantContent = ''
    let reasoningContent = ''
    let contentBuffer = ''
    let visibleTextBuffer = ''
    const toolCalls: Map<number, ToolCallData> = new Map()
    const providerStepAdvanceToolIndexes = new Set<number>()
    let firstToolCallIndex: number | null = null
    const textSavedDeliverable = toolCallPolicy?.textSavedDeliverable
    const requestedParallelSourceCallLimitRaw = toolCallPolicy?.maxParallelSourceExtractionCalls
    const requestedParallelSourceCallLimit =
      typeof requestedParallelSourceCallLimitRaw === 'number' && Number.isFinite(requestedParallelSourceCallLimitRaw)
        ? Math.floor(requestedParallelSourceCallLimitRaw)
        : 1
    const maxStreamedToolCalls = toolCallPolicy?.allowParallelSourceExtractionCalls
      ? Math.max(
          1,
          Math.min(
            MAX_PARALLEL_STREAM_SOURCE_EXTRACTIONS,
            requestedParallelSourceCallLimit,
          ),
        )
      : 1
    let usage: StreamUsage | null = null
    let usageEstimated = false
    let finishReason: string | null = null
    let insideThinkBlock = false
    let insideTextModeToolCallBlock = false
    let reasoningPhaseEnded = false
    let accumulatedForLeakCheck = ''
    let leakageDetected = false
    let stepAdvancedThisIteration = false
    let suppressTextOnlyOverflow = false
    let cadenceProgressUpdate: string | null = null
    let cadenceProgressToolCallId: string | null = null
    let cadenceProgressViolation: CadenceProgressViolation | null = null
    const rejectedCadenceProgressToolCalls = new Set<number>()
    // Once three visible actions exist, the next action is the preferred
    // cadence boundary. A valid model-authored update is released before that
    // action, but narration is display-only and must never block useful work.
    const hardCadenceBoundary = cadenceProgressUpdateEnabled &&
      state.visibleToolActionsSinceLastNarration >= NARRATION_MAX_VISIBLE_ACTION_GAP - 1

    const markCadenceProgressViolation = (
      code: CadenceProgressViolationCode,
      reason: string,
    ): void => {
      if (!cadenceProgressViolation) cadenceProgressViolation = { code, reason }
    }

    const stageCadenceProgressUpdate = (text: string, toolCall: ToolCallData): void => {
      cadenceProgressUpdate = text
      cadenceProgressToolCallId = toolCall.id
      assistantContent = assistantContent.trim()
        ? `${assistantContent.trim()}\n\n${text}`
        : text
      // Buffered actions are released after their model-usage debit commits.
      // An eligible live file preview releases this staged update later inside
      // emitProvisionalToolStart, after the same preview guards have passed and
      // immediately before the first live file event.
    }

    const prepareCadenceProgressUpdate = (
      index: number,
      toolCall: ToolCallData,
      allowMissing = false,
    ): boolean => {
      if (!cadenceProgressUpdateEnabled) return true
      if (cadenceProgressUpdate) return true
      if (rejectedCadenceProgressToolCalls.has(index)) return allowMissing

      const rawUpdate = extractCadenceProgressUpdate(toolCall.arguments)
      if (rawUpdate === undefined) {
        // Keep holding the provisional action while the optional display field
        // may still be streaming. Once the tool envelope is complete, fail
        // open: the model's concrete action is more important than narration.
        if (allowMissing) {
          rejectedCadenceProgressToolCalls.add(index)
          return true
        }
        return false
      }
      const review = reviewProgressNarration(state, rawUpdate, { requireSignal: false })
      if (review.status !== 'accepted') {
        rejectedCadenceProgressToolCalls.add(index)
        // Invalid or duplicate narration stays invisible. The native tool call
        // remains executable, and cadence gets another natural opportunity on
        // a later action instead of paying for a repair loop.
        return allowMissing
      }

      stageCadenceProgressUpdate(review.text, toolCall)
      return true
    }

    const emitProvisionalToolStart = (index: number, toolCall: ToolCallData): void => {
      // One model tool-call ID maps to one visible action. Streaming may add
      // optional arguments later, but the UI already owns the action and file
      // content has a dedicated delta lane for live updates.
      if (toolCall.provisionalStartEmitted) return
      const earlyArgs = buildEarlyToolArgs(toolCall.name, toolCall.arguments)
      addProvisionalRuntimeDisplayContract(earlyArgs, state)
      const currentStepPreview = isCurrentPlanStepPreview(earlyArgs, state)
      const revisionPreviewAllowed = pendingDeliverableRevisionAllowsPreview(toolCall.name, earlyArgs, state)
      if (!currentStepPreview || !revisionPreviewAllowed || !shouldEmitProvisionalToolStart(toolCall.name, earlyArgs, state)) return
      const signature = provisionalToolStartSignature(toolCall, earlyArgs)
      if (emittedToolStarts.get(index) === signature) return
      emittedToolStarts.set(index, signature)
      const streamFileWriteImmediately = STREAMED_FILE_WRITE_TOOLS.has(toolCall.name)
      if (
        streamFileWriteImmediately &&
        cadenceProgressUpdate &&
        cadenceProgressToolCallId === toolCall.id
      ) {
        onCadenceProgressReady?.(cadenceProgressUpdate, toolCall.id)
      }
      const countedForNarration = recordVisibleToolStartForNarration(toolCall, earlyArgs, state)
      toolCall.provisionalStartEmitted = true
      // Current-step file writes need to become visible while the model is
      // still generating their arguments. Their provisional start args are
      // already sanitized and the preview is reconciled with the eventual
      // tool result, so these events may safely bypass the model-turn billing
      // buffer. Keep prose and all other actions buffered.
      if (this.bufferedEmissions) {
        this.bufferedProvisionalToolStarts.set(toolCall.id, {
          name: toolCall.name,
          state,
          counted: countedForNarration,
          exposed: streamFileWriteImmediately,
        })
        if (streamFileWriteImmediately) toolCall.provisionalStartExposed = true
      }
      this.emit(
        () => this.emitter.toolStart(
          toolCall.id,
          toolCall.name,
          earlyArgs,
          { provisional: true },
        ),
        { immediate: streamFileWriteImmediately },
      )
      lastVisibleActivityTime = Date.now()
    }

    let lastChunkTime = Date.now()
    const iterationStartTime = Date.now()
    let lastVisibleActivityTime = iterationStartTime
    let streamTimedOut = false
    let timeoutReason: 'inactivity' | 'iteration' | 'content_only' | null = null
    let contentStreamingStartTime: number | null = null
    const progressNarrationTextCap = shouldCapProgressNarrationText(state)
      ? PROGRESS_NARRATION_TEXT_STREAM_CAP
      : null
    const stageVisibleAssistantContent = (content: string): void => {
      if (!content) return
      lastVisibleActivityTime = Date.now()
      if (!textSavedDeliverable) {
        // Native-tool providers may stream short status prose before revealing
        // the tool envelope. Hold ordinary chat text until the turn closes so
        // a later tool call can suppress that ancillary narration atomically.
        // Text-only final answers, phase narration and genuine blockers are
        // released below once the completed turn proves there is no tool call.
        return
      }

      if (!textSavedDeliverable.started) {
        textSavedDeliverable.started = true
        this.bufferedProvisionalToolStarts.set(textSavedDeliverable.id, {
          name: 'create_file',
          state,
          counted: false,
          exposed: true,
        })
        this.emit(
          () => this.emitter.toolStart(
            textSavedDeliverable.id,
            'create_file',
            {
              path: textSavedDeliverable.path,
              action_label: textSavedDeliverable.actionLabel,
              plan_step_index: state.currentStepIdx + 1,
            },
            { provisional: true },
          ),
          { immediate: true },
        )
        this.emit(
          () => this.emitter.fileContentStart(
            textSavedDeliverable.id,
            textSavedDeliverable.path,
            'create_file',
          ),
          { immediate: true },
        )
      }

      // This is the provider's accepted output chunk, not a placeholder or a
      // replay. It bypasses persistence/billing buffering in the same way as
      // native streamed file arguments so the task view is genuinely live.
      this.emit(
        () => this.emitter.fileContentDelta(textSavedDeliverable.id, content),
        { immediate: true },
      )
    }

    const abortStreamingResponse = (): void => {
      try {
        const streamAny = response as unknown as Record<string, unknown>
        if (typeof (streamAny.controller as AbortController)?.abort === 'function') {
          ;(streamAny.controller as AbortController).abort()
        } else if (typeof (streamAny.abort as () => void) === 'function') {
          ;(streamAny as unknown as { abort: () => void }).abort()
        } else if (typeof (streamAny.response as { body?: ReadableStream })?.body?.cancel === 'function') {
          ;(streamAny.response as { body: ReadableStream }).body.cancel()
        }
      } catch { /* stream may already be closed */ }
    }

    const markStreamTimeoutIfExpired = (): boolean => {
      if (streamTimedOut) return true
      const now = Date.now()
      // Once the model has supplied a valid display/step envelope, give the
      // remaining native tool arguments a short bounded completion window.
      // This prevents normal provider pauses from cutting small calls mid-JSON,
      // while incomplete hidden prefixes still fail forward on the normal timer.
      const isStreamingToolArgs = [...toolCalls.values()].some(tc => STREAMED_FILE_WRITE_TOOLS.has(tc.name))
      const isStreamingWebsiteArgs = [...toolCalls.values()].some(tc => tc.name === 'create_website')
      const hasStableToolArgs = hasStableToolArgumentEnvelope(toolCalls, state)
      const effectiveInactivityMs = isStreamingWebsiteArgs
        ? Math.max(this.tierTimeouts.inactivityTimeoutMs, WEBSITE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : isStreamingToolArgs
        ? Math.max(this.tierTimeouts.inactivityTimeoutMs * 2, FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : hasStableToolArgs
          ? Math.max(this.tierTimeouts.inactivityTimeoutMs, STABLE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : this.tierTimeouts.inactivityTimeoutMs
      const effectiveIterationMs = isStreamingWebsiteArgs
        ? Math.max(this.tierTimeouts.iterationTimeoutMs, WEBSITE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS)
        : isStreamingToolArgs
        ? Math.max(this.tierTimeouts.iterationTimeoutMs, FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS)
        : hasStableToolArgs
          ? Math.max(this.tierTimeouts.iterationTimeoutMs, STABLE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS)
        : this.tierTimeouts.iterationTimeoutMs
      const inactivityExpired = now - lastChunkTime > effectiveInactivityMs
      // Provider activity is authoritative while the model is assembling a
      // hidden native-tool envelope. Do not abort a healthy stream merely
      // because its action pill cannot be shown yet; the bounded iteration
      // deadline still recovers genuinely invisible/malformed streams.
      const visibleInactivityExpired = now - lastVisibleActivityTime > effectiveIterationMs
      const iterationExpired = now - iterationStartTime > effectiveIterationMs
      // Content-only timeout: only fire if the model is producing ONLY text (no tool calls
      // at all) and has stalled. Never fire if tool calls are being streamed.
      const contentOnlyStallMs = this.tierTimeouts.contentOnlyTimeoutMs === null
        ? 5_000
        : Math.min(5_000, Math.max(150, this.tierTimeouts.contentOnlyTimeoutMs))
      const streamStalled = now - lastChunkTime > contentOnlyStallMs
      const contentOnlyExpired =
        this.tierTimeouts.contentOnlyTimeoutMs !== null &&
        contentStreamingStartTime !== null &&
        toolCalls.size === 0 &&
        streamStalled &&
        assistantContent.length > this.tierTimeouts.contentOnlyMinChars &&
        now - contentStreamingStartTime > this.tierTimeouts.contentOnlyTimeoutMs
      if (inactivityExpired || visibleInactivityExpired || iterationExpired || contentOnlyExpired) {
        streamTimedOut = true
        timeoutReason = iterationExpired ? 'iteration' : contentOnlyExpired ? 'content_only' : 'inactivity'
        abortStreamingResponse()
        return true
      }
      return false
    }

    const inactivityCheck = setInterval(markStreamTimeoutIfExpired, this.tierTimeouts.checkIntervalMs)

    const streamPollMs = Math.max(10, Math.min(this.tierTimeouts.checkIntervalMs, 100))
    const nextStreamChunk = async (
      iterator: AsyncIterator<StreamingResponseChunk>,
    ): Promise<IteratorResult<StreamingResponseChunk>> => {
      const nextPromise = iterator.next()
      nextPromise.catch(() => {})

      while (true) {
        let pollTimer: ReturnType<typeof setTimeout> | null = null
        const raced = await Promise.race([
          nextPromise.then(value => ({ type: 'chunk' as const, value })),
          new Promise<{ type: 'poll' }>(resolve => {
            pollTimer = setTimeout(() => resolve({ type: 'poll' }), streamPollMs)
          }),
        ])
        if (pollTimer) clearTimeout(pollTimer)

        if (raced.type === 'chunk') return raced.value

        if (this.signal?.aborted) {
          try {
            if (typeof iterator.return === 'function') {
              void iterator.return().catch(() => {})
            }
          } catch { /* stream may already be closed */ }
          throw new DOMException('The operation was aborted.', 'AbortError')
        }

        if (markStreamTimeoutIfExpired()) {
          try {
            if (typeof iterator.return === 'function') {
              void iterator.return().catch(() => {})
            }
          } catch { /* stream may already be closed */ }
          const elapsed = Date.now() - iterationStartTime
          if (timeoutReason === 'iteration') {
            throw new IterationTimeoutError(elapsed)
          }
          if (timeoutReason === 'content_only') {
            throw new ContentOnlyTimeoutError(elapsed, assistantContent.length, assistantContent || '')
          }
          throw new InactivityTimeoutError(elapsed, assistantContent || '')
        }
      }
    }

    const resolvedUsage = (): StreamUsage | null => {
      if (usage) return usage
      if (!estimateMissingUsage) return null
      try {
        const estimate = estimateMissingUsage({ assistantContent, reasoningContent, toolCalls })
        if (
          !Number.isFinite(estimate.promptTokens) || estimate.promptTokens <= 0 ||
          !Number.isFinite(estimate.completionTokens) || estimate.completionTokens <= 0 ||
          !Number.isFinite(estimate.totalTokens) || estimate.totalTokens <= 0 ||
          !Number.isFinite(estimate.cost) || estimate.cost <= 0
        ) {
          throw new Error('Missing-usage estimator returned an invalid or zero estimate.')
        }
        usageEstimated = true
        return estimate
      } catch (error) {
        console.warn('[StreamProcessor] Synchronous usage estimate failed; caller fallback will be used.', {
          message: error instanceof Error ? error.message : String(error || 'Unknown error'),
        })
        return null
      }
    }

    try {
      const streamIterator = response[Symbol.asyncIterator]()
      while (true) {
        const nextChunk = await nextStreamChunk(streamIterator)
        if (nextChunk.done) break
        const chunk = nextChunk.value
        lastChunkTime = Date.now()

        const chunkFinishReason = chunk.choices[0]?.finish_reason
        if (typeof chunkFinishReason === 'string' && chunkFinishReason) {
          finishReason = chunkFinishReason
        }

        // Capture usage data from final chunk (OpenRouter sends this)
        const chunkAny = chunk as Record<string, unknown>
        if (chunkAny.usage) {
          const u = chunkAny.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
          usage = normalizeUsage(u)
        }

        const delta = (chunk.choices[0]?.delta || {}) as Record<string, unknown>

        // Reasoning content (if model supports it)
        // Ollama gemma4 sends reasoning as `reasoning`, OpenAI/OpenRouter use `reasoning_content`
        if (delta.reasoning && !delta.reasoning_content) {
          delta.reasoning_content = delta.reasoning
        }
        if (delta.reasoning_content) {
          reasoningContent += String(delta.reasoning_content)
          // Reasoning is intentionally kept out of the visible UI. Some
          // thinking-mode providers require it in later tool-call turns.
        }

        // Content delta
        if (delta.content) {
          contentDelta: {
            if (cadenceProgressUpdateEnabled) {
              // Cadence text has exactly one model-authored lane: the required
              // progress_update field on the accompanying native tool call.
              // Ignore ordinary prose so a provider cannot satisfy or duplicate
              // the cadence outside that same action contract.
              break contentDelta
            }
            const content = delta.content as string
            if (suppressTextOnlyOverflow || cadenceProgressUpdate) {
              // Once the schema lane has supplied the single accepted update,
              // discard any provider prose that follows it in the same turn.
              // The tool call still drains and executes normally.
              break contentDelta
            }
            if (reasoningContent && !reasoningPhaseEnded) {
              reasoningPhaseEnded = true
              this.emit(() => this.emitter.reasoningDone())
            }
            contentBuffer += content

            // Track <think> blocks
            if (!insideThinkBlock && contentBuffer.includes('<think>')) {
              insideThinkBlock = true
            }
            if (insideThinkBlock) {
              if (contentBuffer.includes('</think>')) {
                contentBuffer = contentBuffer.replace(/<think>[\s\S]*?<\/think>/g, '')
                insideThinkBlock = contentBuffer.includes('<think>')
              }
            }

            if (!insideThinkBlock && contentBuffer.length > 0) {
              const strippedToolBlocks = stripTextModeToolCallBlocks(contentBuffer, insideTextModeToolCallBlock)
              contentBuffer = strippedToolBlocks.text
              insideTextModeToolCallBlock = strippedToolBlocks.insideBlock
              if (insideTextModeToolCallBlock && !contentBuffer.trim()) {
                contentBuffer = ''
                break contentDelta
              }

            // Strip special tokens before any other processing
            contentBuffer = stripSpecialTokens(contentBuffer)

            contentBuffer = contentBuffer.replace(/<\s*\|?\s*(?:begin|end)[_\s]*of[_\s]*thinking\s*\|?\s*>/gi, '')
            contentBuffer = contentBuffer.replace(/\(end_of_thinking\)/g, '')
            contentBuffer = contentBuffer.replace(/\b(?:end_of_thinking|begin_of_thinking|end_thinking|begin_thinking)\b/gi, '')
            contentBuffer = contentBuffer.replace(/^\]\s+/, '')

            // Detect <next_step/> — flexible matching for model variants
            // Matches: <next_step/>, <next_step />, <next_step>, <NEXT_STEP/>, [next_step], **<next_step/>**
            const nextStepPattern = /(?:\*{0,2})(?:<\/?next[-_]?step\s*\/?>|\[next[-_]?step\])(?:\*{0,2})/gi
            const nextStepMatches = contentBuffer.match(nextStepPattern)
            if (nextStepMatches && !stepAdvancedThisIteration) {
              // Mark that the model wants to advance — but DON'T emit yet.
              // The PolicyEngine will decide whether to allow it based on
              // minimum tool call requirements. We just record the intent.
              stepAdvancedThisIteration = true
            }
            contentBuffer = contentBuffer.replace(nextStepPattern, '')

            // Detect <plan>...</plan> — per-step micro-plan from the model.
            // Only the FIRST <plan> in a step is honored; persisted on state and
            // re-surfaced via stepMsg() until advanceStep() clears it. The tag is
            // stripped from the user-visible stream so it doesn't pollute UI text.
            if (!state.stepMicroPlan) {
              const planMatch = contentBuffer.match(/<plan>([\s\S]*?)<\/plan>/i)
              if (planMatch && planMatch[1].trim()) {
                state.stepMicroPlan = planMatch[1].trim().slice(0, 500)
                console.log(`[StreamProcessor] Captured micro-plan for step ${state.currentStepIdx + 1}: ${state.stepMicroPlan.split('\n').filter(l => l.trim()).length} items`)
              }
            }
            contentBuffer = contentBuffer.replace(/<plan>[\s\S]*?<\/plan>\s*/gi, '')

            // Compress excessive blank lines but preserve paragraph breaks (\n\n).
            // Earlier this collapsed every \n{2,} → \n, which destroyed paragraph
            // structure and broke downstream first-paragraph splits in
            // eventDispatcher.ts and AgentMessage.tsx that rely on \n\n as a marker.
            contentBuffer = contentBuffer.replace(/\n{3,}/g, '\n\n')

            // Hold back partial tags
            const partialTagMatch = contentBuffer.match(/<[^>]{0,40}$/)
            const safeContent = partialTagMatch
              ? contentBuffer.slice(0, partialTagMatch.index)
              : contentBuffer

            if (safeContent) {
              visibleTextBuffer += safeContent
              const visible = splitCleanVisibleAssistantText(visibleTextBuffer)
              const cleaned = visible.text
              visibleTextBuffer = visible.hold
              assistantContent += cleaned
              if (contentStreamingStartTime === null && cleaned.length > 0) {
                contentStreamingStartTime = Date.now()
              }
              accumulatedForLeakCheck += cleaned

              if (toolCalls.size === 0 && containsFalseCapabilityRefusal(accumulatedForLeakCheck)) {
                clearInterval(inactivityCheck)
                try {
                  const streamAny = response as unknown as Record<string, unknown>
                  if (typeof (streamAny.controller as AbortController)?.abort === 'function') {
                    ;(streamAny.controller as AbortController).abort()
                  } else if (typeof (streamAny.abort as () => void) === 'function') {
                    ;(streamAny as unknown as { abort: () => void }).abort()
                  }
                } catch { /* stream may already be closed */ }
                return {
                  assistantContent, reasoningContent, toolCalls,
                  stepAdvancedThisIteration, leakageDetected: false, timedOut: false,
                  contentStreamingStartTime, usage: resolvedUsage(), usageEstimated,
                }
              }

              // Cut off long text-only responses to prevent narration loops.
              // Keep draining the provider stream so it can still emit a later
              // tool call or final usage chunk; aborting here turns a clipped
              // progress paragraph into a terminal task error.
              const allowLongAssistantText = !!textSavedDeliverable ||
                toolCallPolicy?.allowLongAssistantText === true ||
                inlineFinalAnswerAllowsLongText(state)
              const TEXT_ONLY_CAP: number | null = allowLongAssistantText
                ? null
                : progressNarrationTextCap
                if (TEXT_ONLY_CAP !== null && toolCalls.size === 0 && assistantContent.length > TEXT_ONLY_CAP && !stepAdvancedThisIteration) {
                  suppressTextOnlyOverflow = true
                  contentBuffer = ''
                  break contentDelta
                }

              // Check for leakage BEFORE emitting to prevent leaked content reaching the UI
              if (accumulatedForLeakCheck.length > 150 && checkForLeakage(accumulatedForLeakCheck)) {
                leakageDetected = true
                const deflections = [
                  "I'm here to help \u2014 what can I do for you?",
                  "Let me know what you'd like to work on!",
                  "What can I help you with today?",
                ]
                const deflection = deflections[Math.floor(Math.random() * deflections.length)]
                this.emit(() => this.emitter.textDelta(deflection))
                clearInterval(inactivityCheck)
                return {
                  assistantContent, reasoningContent, toolCalls,
                  stepAdvancedThisIteration, leakageDetected: true, timedOut: false,
                  contentStreamingStartTime, usage: resolvedUsage(), usageEstimated,
                }
              }

              // Only emit to user AFTER leakage check passes
              if (cleaned) {
                stageVisibleAssistantContent(cleaned)
              }
                contentBuffer = contentBuffer.slice(safeContent.length)
              }
            }
          }
        }

        // Tool calls
        if (delta.tool_calls) {
          // Tool-call chunks reset provider inactivity through lastChunkTime.
          // Only reset visible inactivity once an action pill or file preview
          // is actually emitted, otherwise malformed/hidden arguments can keep
          // the UI apparently frozen until the full iteration timeout.
          const tcs = delta.tool_calls as Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
          for (const tc of tcs) {
            const existing = toolCalls.get(tc.index)
            const streamedName = tc.function?.name || existing?.name || ''
            if (providerStepAdvanceToolIndexes.has(tc.index) || isProviderStepAdvanceToolName(streamedName)) {
              // Some OpenAI-compatible providers occasionally encode the
              // instructed <next_step/> marker as a native function call even
              // though no such tool was offered. Treat that variant as the
              // same model-authored phase-advance request. It must never enter
              // display validation as a hidden/failed ghost action.
              providerStepAdvanceToolIndexes.add(tc.index)
              stepAdvancedThisIteration = true
              toolCalls.delete(tc.index)
              continue
            }
            if (firstToolCallIndex === null) firstToolCallIndex = tc.index
            const isPrimaryToolCall = tc.index === firstToolCallIndex
            if (
              !isPrimaryToolCall &&
              !toolCalls.has(tc.index) &&
              toolCalls.size >= maxStreamedToolCalls
            ) continue

            if (existing) {
              existing.arguments += tc.function?.arguments || ''
            } else {
              toolCalls.set(tc.index, {
                id: tc.id || `call_${state.iterations}_${tc.index}`,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              })
            }

            // File content streaming
            const toolCall = toolCalls.get(tc.index)!

            if (toolCall.name) {
              const earlyArgs = buildEarlyToolArgs(toolCall.name, toolCall.arguments)
              addProvisionalRuntimeDisplayContract(earlyArgs, state)
              const currentStepPreview = isCurrentPlanStepPreview(earlyArgs, state)
              const revisionPreviewAllowed = pendingDeliverableRevisionAllowsPreview(toolCall.name, earlyArgs, state)
              // Secondary calls stay UI-silent until the completed stream proves
              // that the whole requested batch is source-only. This prevents a
              // mixed/unsafe second call from flashing a provisional action that
              // the execution policy will subsequently reject.
              if (isPrimaryToolCall) {
                const cadenceReady = prepareCadenceProgressUpdate(tc.index, toolCall)
                if (!hardCadenceBoundary || cadenceReady) emitProvisionalToolStart(tc.index, toolCall)
              }

              if (STREAMED_FILE_WRITE_TOOLS.has(toolCall.name)) {
                const path = typeof earlyArgs.path === 'string' ? earlyArgs.path : ''
                const contentKey = toolCall.name === 'edit_file'
                  ? 'new_string'
                  : toolCall.name === 'create_website'
                    ? 'html'
                    : 'content'
                const content = extractPartialStringArg(toolCall.arguments, contentKey)
                const hasDisplayLabel = typeof earlyArgs.action_label === 'string' && earlyArgs.action_label.length > 0
                if (toolCall.provisionalStartEmitted && currentStepPreview && revisionPreviewAllowed && path && hasDisplayLabel) {
                  const preview = filePreviewState.get(tc.index) || { path, emittedChars: 0, started: false }
                  if (!preview.started || preview.path !== path) {
                    preview.path = path
                    preview.started = true
                    preview.emittedChars = 0
                    this.emit(
                      () => this.emitter.fileContentStart(toolCall.id, path, toolCall.name),
                      { immediate: toolCall.provisionalStartExposed === true },
                    )
                    lastVisibleActivityTime = Date.now()
                  }
                  if (typeof content === 'string' && content.length > preview.emittedChars) {
                    const pendingChars = content.length - preview.emittedChars
                    if (pendingChars >= FILE_PREVIEW_MIN_DELTA_CHARS) {
                      const deltaContent = content.slice(preview.emittedChars)
                      this.emit(
                        () => this.emitter.fileContentDelta(toolCall.id, deltaContent),
                        { immediate: toolCall.provisionalStartExposed === true },
                      )
                      lastVisibleActivityTime = Date.now()
                      preview.emittedChars = content.length
                    }
                  }
                  filePreviewState.set(tc.index, preview)
                }
              }
            }
          }
        }
      }
    } catch (streamError) {
      clearInterval(inactivityCheck)

      if (!streamTimedOut) {
        throw streamError
      }

      const elapsed = Date.now() - iterationStartTime

      // Timeout with tool calls in progress:
      // Return partial results so the tool pipeline can execute complete calls
      // or route malformed/incomplete JSON through internal recovery.
      if (toolCalls.size > 0) {
        // Non-fatal timeout during tool streaming — fall through.
      } else {
        // No tool calls → nudgeable timeouts
        if (timeoutReason === 'content_only') {
          throw new ContentOnlyTimeoutError(elapsed, assistantContent.length, assistantContent || '')
        }
        throw new InactivityTimeoutError(elapsed, assistantContent || '')
      }
    }
    clearInterval(inactivityCheck)

    // Emit reasoning_done if needed
    if (reasoningContent && !reasoningPhaseEnded) {
      reasoningPhaseEnded = true
      this.emit(() => this.emitter.reasoningDone())
    }

    // Flush remaining buffer
    if (contentBuffer || visibleTextBuffer) {
      let flushed = stripSpecialTokens(visibleTextBuffer + contentBuffer)
      flushed = stripThinkingTags(flushed)
      flushed = stripStepMarkers(flushed)
      flushed = splitCleanVisibleAssistantText(flushed).text
      if (flushed) {
        accumulatedForLeakCheck += flushed
        if (checkForLeakage(accumulatedForLeakCheck)) {
          const deflections = [
            "I'm here to help \u2014 what can I do for you?",
            "Let me know what you'd like to work on!",
            "What can I help you with today?",
          ]
          const deflection = deflections[Math.floor(Math.random() * deflections.length)]
          this.emit(() => this.emitter.textDelta(deflection))
          return {
            assistantContent, reasoningContent, toolCalls,
            stepAdvancedThisIteration, leakageDetected: true, timedOut: false,
            contentStreamingStartTime, usage: resolvedUsage(), usageEstimated,
          }
        }
        assistantContent += flushed
        stageVisibleAssistantContent(flushed)
      }
    }

    // Strip leaked tags from accumulated content
    assistantContent = stripSpecialTokens(assistantContent)
    assistantContent = stripThinkingTags(assistantContent)
    assistantContent = stripStepMarkers(assistantContent)
    assistantContent = stripPlanMarkers(assistantContent)

    // Defensive normalization if a provider reveals the hallucinated
    // next_step function name only after earlier argument chunks.
    for (const [index, toolCall] of toolCalls) {
      if (!isProviderStepAdvanceToolName(toolCall.name)) continue
      stepAdvancedThisIteration = true
      toolCalls.delete(index)
    }

    // The model may stream multiple native calls only on an explicitly enabled,
    // capped source-action turn. Preserve provider index order for a valid
    // read_document/http_request batch. Any mixed, unknown, or non-source batch
    // falls back to the first streamed call, matching the sequential safety
    // policy without exposing ghost secondary actions.
    if (toolCalls.size > 1) {
      const orderedEntries = [...toolCalls.entries()].sort(([a], [b]) => a - b)
      const sourceOnlyBatch =
        maxStreamedToolCalls > 1 &&
        orderedEntries.every(([, toolCall]) => PARALLEL_STREAM_SOURCE_EXTRACTION_TOOLS.has(toolCall.name))
      if (!sourceOnlyBatch) {
        const primaryToolCall = firstToolCallIndex === null
          ? undefined
          : toolCalls.get(firstToolCallIndex)
        toolCalls.clear()
        if (primaryToolCall && firstToolCallIndex !== null) {
          toolCalls.set(firstToolCallIndex, primaryToolCall)
        }
      } else {
        toolCalls.clear()
        for (const [index, toolCall] of orderedEntries.slice(0, maxStreamedToolCalls)) {
          toolCalls.set(index, toolCall)
        }
      }
    }

    if (cadenceProgressUpdateEnabled && toolCalls.size === 0) {
      markCadenceProgressViolation(
        'missing_tool_call',
        'the cadence-enabled turn did not include a native tool call carrying progress_update',
      )
    }

    // Stage valid narration for release immediately before the buffered next
    // action. Missing/invalid narration stays invisible but cannot suppress the
    // model-selected action.
    for (const [index, toolCall] of toolCalls) {
      const cadenceReady = prepareCadenceProgressUpdate(index, toolCall, true)
      if (!hardCadenceBoundary || cadenceReady) emitProvisionalToolStart(index, toolCall)
    }

    for (const [index, preview] of filePreviewState) {
      const toolCall = toolCalls.get(index)
      if (!toolCall) continue
      const contentKey = toolCall.name === 'edit_file'
        ? 'new_string'
        : toolCall.name === 'create_website'
          ? 'html'
          : 'content'
      const content = extractPartialStringArg(toolCall.arguments, contentKey)
      if (typeof content === 'string' && content.length > preview.emittedChars) {
        const deltaContent = content.slice(preview.emittedChars)
        this.emit(
          () => this.emitter.fileContentDelta(toolCall.id, deltaContent),
          { immediate: toolCall.provisionalStartExposed === true },
        )
        preview.emittedChars = content.length
      }
    }

    // The cadence lane is display-only. Remove it before provider history,
    // validation, caching, persistence, signatures, or tool execution can see it.
    for (const toolCall of toolCalls.values()) {
      toolCall.arguments = stripCadenceProgressUpdateFromArguments(toolCall.arguments)
    }
    // Text-only cadence turns can still be repaired. Native tool calls always
    // fail open because the cadence lane is display-only.
    if (cadenceProgressViolation && (toolCalls.size === 0 || hardCadenceBoundary)) toolCalls.clear()

    // Preserve all generated output in a missing-provider-usage estimate even
    // when ancillary tool-turn prose is intentionally hidden below.
    const completedTurnUsage = resolvedUsage()

    if (!textSavedDeliverable) {
      if (toolCalls.size > 0 && !cadenceProgressUpdate) {
        // Ordinary native-tool turns have one visible communication surface:
        // the specific action pill. Discard any provider-authored micro-status
        // text both from the event stream and assistant history. Cadence turns
        // retain their accepted structured update for the explicit progress
        // lane and subsequent model context.
        assistantContent = ''
      } else if (
        toolCalls.size === 0 &&
        !cadenceProgressViolation &&
        assistantContent
      ) {
        // Every accepted text-only model turn is a distinct prose segment.
        // Prefix a boundary so a phase update ending in "now." and a later
        // final handoff beginning with "Your" cannot persist as "now.Your".
        this.emit(() => this.emitter.textDelta(`\n\n${assistantContent}`))
      }
    }

    return {
      assistantContent,
      reasoningContent,
      toolCalls,
      finishReason,
      textOverflowSuppressed: suppressTextOnlyOverflow,
      stepAdvancedThisIteration,
      leakageDetected: false,
      timedOut: streamTimedOut,
      contentStreamingStartTime,
      usage: completedTurnUsage,
      usageEstimated,
      cadenceProgressUpdate: cadenceProgressUpdate || undefined,
      cadenceProgressToolCallId: cadenceProgressToolCallId || undefined,
      cadenceProgressViolation: cadenceProgressViolation || undefined,
    }
  }
}
