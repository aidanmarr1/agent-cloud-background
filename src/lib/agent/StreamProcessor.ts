import type { AgentEventEmitter } from './SSEEmitter'
import type { AgentStateData } from './AgentState'
import { stepOpenedSourceDomains } from './AgentState'
import type { TierTimeouts } from './guards'
import { stripThinkingTags, stripStepMarkers, stripPlanMarkers, stripSpecialTokens, stripTextModeToolCallBlocks, stripInternalPolicyScaffolding, checkForLeakage, unescapeJsonChunk } from './guards'
import { IterationTimeoutError, InactivityTimeoutError, ContentOnlyTimeoutError } from './errors'
import { formatVisibleActionLabel, strictActionLabelFromArgs } from '@/lib/stream/ActivityDescriber'
import { NARRATION_THRESHOLD_DEFAULT } from './config'
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
  stepAdvancedThisIteration: boolean
  leakageDetected: boolean
  timedOut: boolean
  contentStreamingStartTime: number | null
  usage: StreamUsage | null
  usageEstimated?: boolean
  cadenceProgressUpdate?: string
  cadenceProgressVisibleActionsAfter?: number
  cadenceProgressViolation?: CadenceProgressViolation
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
}

const FILE_PREVIEW_MIN_DELTA_CHARS = 48
const PROGRESS_NARRATION_TEXT_STREAM_CAP = 420
const DEFAULT_TEXT_ONLY_STREAM_CAP = 800
const INLINE_FINAL_TEXT_STREAM_CAP = 6000
const FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 30_000
const FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 3_000
const STABLE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 8_000
const STABLE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 2_500
const STABLE_READ_ONLY_SOURCE_TOOLS = new Set(['web_search', 'read_document'])
const PARALLEL_STREAM_SOURCE_EXTRACTION_TOOLS = new Set([
  'read_document',
  'http_request',
])
const STREAMED_FILE_WRITE_TOOLS = new Set(['create_file', 'append_file', 'edit_file'])
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

function totalOpenedSourceReads(state: AgentStateData): number {
  return [...stepOpenedSourceDomains(state).values()].reduce((sum, count) => sum + count, 0)
}

function searchWouldBePreflightBlocked(toolName: string, args: Record<string, unknown>, state: AgentStateData): boolean {
  if (toolName !== 'web_search') return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.taskStrategy === 'browse' || state.taskStrategy === 'build' || state.taskStrategy === 'code') return false

  const query = typeof args.query === 'string' ? args.query.toLowerCase().trim() : ''
  if (query && state.stepSearchQueries.has(query)) return true

  const completedSearches = Math.max(
    state.stepSearchQueries.size,
    state.stepToolTypeCounts.get('web_search') || 0,
  )
  const openedSourceReads = totalOpenedSourceReads(state)

  if (completedSearches >= 1 && openedSourceReads === 0 && state.stepFailureCount < 2) return true
  if (completedSearches >= 4 && openedSourceReads < Math.floor(completedSearches / 2) && state.stepFailureCount < 2) return true
  return false
}

function shouldEmitProvisionalToolStart(toolName: string, args: Record<string, unknown>, state: AgentStateData): boolean {
  if (!strictActionLabelFromArgs(args)) return false

  if (toolName === 'web_search' || toolName === 'image_search') {
    if (searchWouldBePreflightBlocked(toolName, args, state)) return false
    return typeof args.query === 'string' && args.query.length > 0
  }

  if (toolName === 'create_file' || toolName === 'append_file') {
    return typeof args.path === 'string' && args.path.length > 0
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
  if (toolName !== 'create_file' && toolName !== 'append_file' && toolName !== 'edit_file') return true
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
  return `${toolCall.id}:${toolCall.name}:${JSON.stringify(stableArgs)}`
}

function recordVisibleToolStartForNarration(
  toolCall: ToolCallData,
  args: Record<string, unknown>,
  state: AgentStateData,
): boolean {
  if (toolCall.name === 'browser_screenshot' || toolCall.name === 'browser_resize') return false
  if (!strictActionLabelFromArgs(args)) return false
  if (state.visibleNarrationToolStartIds.has(toolCall.id)) return false
  state.visibleNarrationToolStartIds.add(toolCall.id)
  state.visibleToolActionsSinceLastNarration++
  return true
}

function splitCleanVisibleAssistantText(text: string): { text: string; hold: string } {
  const prepared = stripInternalPolicyScaffolding(stripPlanMarkers(text))
  const tailMatch = prepared.match(DISPLAY_FUTURE_ACTION_TAIL_RE)
  const tailIndex = tailMatch?.index
  const hold = tailIndex !== undefined ? prepared.slice(tailIndex) : ''
  const ready = tailIndex !== undefined ? prepared.slice(0, tailIndex) : prepared
  const cleaned = ready
    .replace(DISPLAY_FUTURE_ACTION_SENTENCE_RE, ' ')
    .replace(DISPLAY_INTERNAL_TASK_REFLECTION_RE, ' ')
    .replace(DISPLAY_OPERATIONAL_COMMAND_SENTENCE_RE, ' ')
    .replace(DISPLAY_SPECULATIVE_SOURCE_SENTENCE_RE, ' ')
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
  private exposedBufferedFileTools = new Map<string, string>()

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
    this.exposedBufferedFileTools.clear()
    for (const emit of emissions || []) emit()
  }

  discardBufferedEmission(): void {
    this.bufferedEmissions = null
    // Live file previews intentionally bypass the model-turn buffer. If the
    // enclosing turn is rejected (provider failure, debit failure, or cadence
    // rejection), explicitly settle every exposed action so the client cannot
    // retain a stuck blue pill or LIVE editor.
    const exposedFileTools = [...this.exposedBufferedFileTools]
    this.exposedBufferedFileTools.clear()
    for (const [id, name] of exposedFileTools) {
      this.emitter.toolResult(id, name, {
        error: 'INTERNAL_RECOVERY: The streamed file action was discarded before execution. Retry the current write.',
        discarded: true,
      } as never)
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
    response: AsyncIterable<{ choices: Array<{ delta?: Record<string, unknown> }> }>,
    state: AgentStateData,
    cadenceProgressUpdateEnabled = false,
    estimateMissingUsage?: MissingStreamUsageEstimator,
    toolCallPolicy?: StreamToolCallPolicy,
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
    let firstToolCallIndex: number | null = null
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
    let insideThinkBlock = false
    let insideTextModeToolCallBlock = false
    let reasoningPhaseEnded = false
    let accumulatedForLeakCheck = ''
    let leakageDetected = false
    let stepAdvancedThisIteration = false
    let suppressTextOnlyOverflow = false
    let cadenceProgressUpdate: string | null = null
    let cadenceProgressVisibleActionsAfter = 0
    let cadenceProgressViolation: CadenceProgressViolation | null = null
    const rejectedCadenceProgressToolCalls = new Set<number>()

    const markCadenceProgressViolation = (
      code: CadenceProgressViolationCode,
      reason: string,
    ): void => {
      if (!cadenceProgressViolation) cadenceProgressViolation = { code, reason }
    }

    const emitCadenceProgressUpdate = (text: string): void => {
      cadenceProgressUpdate = text
      assistantContent = assistantContent.trim()
        ? `${assistantContent.trim()}\n\n${text}`
        : text
      if (contentStreamingStartTime === null) contentStreamingStartTime = Date.now()
      lastVisibleActivityTime = Date.now()
      this.emit(() => this.emitter.progressUpdate(text))
    }

    const prepareCadenceProgressUpdate = (
      index: number,
      toolCall: ToolCallData,
      allowMissing = false,
    ): boolean => {
      if (!cadenceProgressUpdateEnabled) return true
      if (cadenceProgressUpdate) return true
      if (rejectedCadenceProgressToolCalls.has(index)) return false

      const rawUpdate = extractCadenceProgressUpdate(toolCall.arguments)
      if (rawUpdate === undefined) {
        // Keep holding the action while the required field is still streaming.
        // At end-of-stream, fail open for the concrete action. Narration is a
        // display lane and must never make the runtime discard useful work or
        // buy a second model turn merely to repair prose.
        if (allowMissing) {
          rejectedCadenceProgressToolCalls.add(index)
          return true
        }
        return false
      }
      const review = reviewProgressNarration(state, rawUpdate, { requireSignal: false })
      if (review.status !== 'accepted') {
        rejectedCadenceProgressToolCalls.add(index)
        // Suppress invalid/duplicate display text, but preserve the valid
        // native tool call. Cadence remains due at the next action frontier.
        return allowMissing
      }

      emitCadenceProgressUpdate(review.text)
      return true
    }

    const emitProvisionalToolStart = (index: number, toolCall: ToolCallData): void => {
      const earlyArgs = buildEarlyToolArgs(toolCall.name, toolCall.arguments)
      addProvisionalRuntimeDisplayContract(earlyArgs, state)
      const currentStepPreview = isCurrentPlanStepPreview(earlyArgs, state)
      const revisionPreviewAllowed = pendingDeliverableRevisionAllowsPreview(toolCall.name, earlyArgs, state)
      if (!currentStepPreview || !revisionPreviewAllowed || !shouldEmitProvisionalToolStart(toolCall.name, earlyArgs, state)) return
      const signature = provisionalToolStartSignature(toolCall, earlyArgs)
      if (emittedToolStarts.get(index) === signature) return
      emittedToolStarts.set(index, signature)
      const newlyCountedVisibleAction = recordVisibleToolStartForNarration(toolCall, earlyArgs, state)
      toolCall.provisionalStartEmitted = true
      // The same streamed tool can legitimately upsert its provisional pill as
      // optional stable arguments arrive. Cadence counts accepted tool IDs, not
      // UI revisions of the same action.
      if (cadenceProgressUpdate && newlyCountedVisibleAction) cadenceProgressVisibleActionsAfter += 1
      // Current-step file writes need to become visible while the model is
      // still generating their arguments. Their provisional start args are
      // already sanitized and the preview is reconciled with the eventual
      // tool result, so these events may safely bypass the model-turn billing
      // buffer. Keep prose and all other actions buffered.
      if (this.bufferedEmissions && STREAMED_FILE_WRITE_TOOLS.has(toolCall.name)) {
        this.exposedBufferedFileTools.set(toolCall.id, toolCall.name)
      }
      this.emit(
        () => this.emitter.toolStart(
          toolCall.id,
          toolCall.name,
          earlyArgs,
          { provisional: true },
        ),
        { immediate: STREAMED_FILE_WRITE_TOOLS.has(toolCall.name) },
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
      const hasStableToolArgs = hasStableToolArgumentEnvelope(toolCalls, state)
      const effectiveInactivityMs = isStreamingToolArgs
        ? Math.max(this.tierTimeouts.inactivityTimeoutMs * 2, FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : hasStableToolArgs
          ? Math.max(this.tierTimeouts.inactivityTimeoutMs, STABLE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : this.tierTimeouts.inactivityTimeoutMs
      const effectiveIterationMs = isStreamingToolArgs
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
      iterator: AsyncIterator<{ choices: Array<{ delta?: Record<string, unknown> }> }>,
    ): Promise<IteratorResult<{ choices: Array<{ delta?: Record<string, unknown> }> }>> => {
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
              const TEXT_ONLY_CAP = progressNarrationTextCap !== null
                ? progressNarrationTextCap
                : inlineFinalAnswerAllowsLongText(state)
                ? INLINE_FINAL_TEXT_STREAM_CAP
                : DEFAULT_TEXT_ONLY_STREAM_CAP
                if (toolCalls.size === 0 && assistantContent.length > TEXT_ONLY_CAP && !stepAdvancedThisIteration) {
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
                lastVisibleActivityTime = Date.now()
                this.emit(() => this.emitter.textDelta(cleaned))
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
            if (firstToolCallIndex === null) firstToolCallIndex = tc.index
            const isPrimaryToolCall = tc.index === firstToolCallIndex
            if (
              !isPrimaryToolCall &&
              !toolCalls.has(tc.index) &&
              toolCalls.size >= maxStreamedToolCalls
            ) continue

            const existing = toolCalls.get(tc.index)
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
              if (isPrimaryToolCall && prepareCadenceProgressUpdate(tc.index, toolCall)) {
                emitProvisionalToolStart(tc.index, toolCall)
              }

              if (STREAMED_FILE_WRITE_TOOLS.has(toolCall.name)) {
                const path = typeof earlyArgs.path === 'string' ? earlyArgs.path : ''
                const contentKey = toolCall.name === 'edit_file' ? 'new_string' : 'content'
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
                      { immediate: true },
                    )
                    lastVisibleActivityTime = Date.now()
                  }
                  if (typeof content === 'string' && content.length > preview.emittedChars) {
                    const pendingChars = content.length - preview.emittedChars
                    if (pendingChars >= FILE_PREVIEW_MIN_DELTA_CHARS) {
                      const deltaContent = content.slice(preview.emittedChars)
                      this.emit(
                        () => this.emitter.fileContentDelta(toolCall.id, deltaContent),
                        { immediate: true },
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
        this.emit(() => this.emitter.textDelta(flushed))
      }
    }

    // Strip leaked tags from accumulated content
    assistantContent = stripSpecialTokens(assistantContent)
    assistantContent = stripThinkingTags(assistantContent)
    assistantContent = stripStepMarkers(assistantContent)
    assistantContent = stripPlanMarkers(assistantContent)

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

    // Valid narration is emitted immediately before its action. Missing,
    // invalid, or duplicate narration stays invisible, while the action still
    // proceeds and cadence is retried on the next ordinary action turn.
    for (const [index, toolCall] of toolCalls) {
      if (!prepareCadenceProgressUpdate(index, toolCall, true)) continue
      emitProvisionalToolStart(index, toolCall)
    }

    for (const [index, preview] of filePreviewState) {
      const toolCall = toolCalls.get(index)
      if (!toolCall) continue
      const contentKey = toolCall.name === 'edit_file' ? 'new_string' : 'content'
      const content = extractPartialStringArg(toolCall.arguments, contentKey)
      if (typeof content === 'string' && content.length > preview.emittedChars) {
        const deltaContent = content.slice(preview.emittedChars)
        this.emit(
          () => this.emitter.fileContentDelta(toolCall.id, deltaContent),
          { immediate: true },
        )
        preview.emittedChars = content.length
      }
    }

    // The cadence lane is display-only. Remove it before provider history,
    // validation, caching, persistence, signatures, or tool execution can see it.
    for (const toolCall of toolCalls.values()) {
      toolCall.arguments = stripCadenceProgressUpdateFromArguments(toolCall.arguments)
    }
    // A prose-only cadence turn still has no executable action and may use the
    // bounded no-progress recovery. A valid native action is never cleared
    // solely because its optional display narration was unusable.
    if (cadenceProgressViolation && toolCalls.size === 0) toolCalls.clear()

    return {
      assistantContent,
      reasoningContent,
      toolCalls,
      stepAdvancedThisIteration,
      leakageDetected: false,
      timedOut: streamTimedOut,
      contentStreamingStartTime,
      usage: resolvedUsage(),
      usageEstimated,
      cadenceProgressUpdate: cadenceProgressUpdate || undefined,
      cadenceProgressVisibleActionsAfter,
      cadenceProgressViolation: cadenceProgressViolation || undefined,
    }
  }
}
