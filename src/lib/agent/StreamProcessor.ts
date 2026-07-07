import type { AgentEventEmitter } from './SSEEmitter'
import type { AgentStateData } from './AgentState'
import { stepOpenedSourceDomains } from './AgentState'
import type { TierTimeouts } from './guards'
import { stripThinkingTags, stripStepMarkers, stripPlanMarkers, stripSpecialTokens, stripTextModeToolCallBlocks, stripInternalPolicyScaffolding, checkForLeakage, unescapeJsonChunk } from './guards'
import { IterationTimeoutError, InactivityTimeoutError, ContentOnlyTimeoutError } from './errors'
import { fetchGenerationUsage } from '@/lib/llm'
import { formatVisibleActionLabel, runtimeVisibleActionLabel, strictActionLabelFromArgs } from '@/lib/stream/ActivityDescriber'
import type { ChatCompletionUsage } from '@/lib/llm'
import { NARRATION_THRESHOLD_DEFAULT } from './config'

export interface ToolCallData {
  id: string
  name: string
  arguments: string
}

export interface StreamUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
}

export interface StreamResult {
  assistantContent: string
  reasoningContent: string
  toolCalls: Map<number, ToolCallData>
  stepAdvancedThisIteration: boolean
  leakageDetected: boolean
  timedOut: boolean
  contentStreamingStartTime: number | null
  usage: StreamUsage | null
}

const FILE_PREVIEW_MIN_DELTA_CHARS = 160
const PROGRESS_NARRATION_TEXT_STREAM_CAP = 420
const DEFAULT_TEXT_ONLY_STREAM_CAP = 800
const INLINE_FINAL_TEXT_STREAM_CAP = 6000
const FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 14_000
const FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS = 3_000
const DISPLAY_FUTURE_ACTION_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:let\s+me|i(?:'|’)?ll|i\s+will|i(?:'|’)?m\s+going\s+to)\b[^.!?\n]*(?:research|search|look|gather|read|open|try|check|verify|move|continue|get|fetch|use|do|ground)\b[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_FUTURE_ACTION_TAIL_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:l|le|let(?:\s+m(?:e)?)?|i(?:'|’)?(?:l(?:l)?|$)|i\s*(?:w(?:ill?)?|a(?:m)?|$)|i(?:'|’)?m(?:\s+g(?:oing?)?)?)\b[^.!?\n]*$/i
const DISPLAY_INTERNAL_TASK_REFLECTION_RE =
  /(?:^|(?<=[.!?]\s))\s*The user (?:has asked|asked|wants|requested)\b[^.!?\n]*(?:current plan|plan step|step \d|i(?:'|’)?ll|i\s+will)[^.!?\n]*(?:[.!?]|$)/gi
const DISPLAY_OPERATIONAL_COMMAND_SENTENCE_RE =
  /(?:^|(?<=[.!?]\s))\s*(?:extract|read|review|open|search|gather|scroll|find|get|try|check|verify|compare|continue|use)\b[^.!?\n]*(?:content|details|page|source|sources|docs?|documentation|article|pricing|features?|query|results?|information|evidence|next|instead)\b[^.!?\n]*(?:[.!?]|$)/g

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

function streamUsageFromCompletionUsage(usage: ChatCompletionUsage | null): StreamUsage | null {
  if (!usage) return null
  return normalizeUsage(usage)
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

function fileActionLabelFallback(toolName: string, path: string): string {
  const fileName = path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'file'
  const compactName = fileName.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  const subject = compactName.split(' ').slice(0, 5).join(' ') || 'file'
  const verb = toolName === 'append_file'
    ? 'Continue'
    : toolName === 'edit_file'
      ? 'Edit'
      : 'Write'
  return formatVisibleActionLabel(`${verb} ${subject}`)
}

function addProvisionalFileActionLabel(args: Record<string, unknown>, toolName: string): void {
  if (strictActionLabelFromArgs(args)) return
  if (toolName !== 'create_file' && toolName !== 'append_file' && toolName !== 'edit_file') return
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return
  args.action_label = fileActionLabelFallback(toolName, path)
}

function addProvisionalRuntimeDisplayContract(
  args: Record<string, unknown>,
  toolName: string,
  state: AgentStateData,
): void {
  if (
    state.currentPlanItems &&
    state.currentStepIdx < state.currentPlanItems.length &&
    args.plan_step_index === undefined
  ) {
    args.plan_step_index = state.currentStepIdx + 1
  }

  if (!strictActionLabelFromArgs(args)) {
    const fallback = state.currentPlanItems?.[state.currentStepIdx] || 'Continue active step'
    args.action_label = runtimeVisibleActionLabel(toolName, args, fallback)
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
      addProvisionalFileActionLabel(args, toolName)
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
    case 'youtube_transcript':
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

  return args
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
): void {
  if (toolCall.name === 'browser_screenshot' || toolCall.name === 'browser_resize') return
  if (!strictActionLabelFromArgs(args)) return
  if (state.visibleNarrationToolStartIds.has(toolCall.id)) return
  state.visibleNarrationToolStartIds.add(toolCall.id)
  state.visibleToolActionsSinceLastNarration++
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
  return { text: cleaned, hold }
}

function containsFalseCapabilityRefusal(text: string): boolean {
  return /(?:i (?:cannot|can't|am unable to|am not able to).{0,140}(?:access|browse|interact|perform|retrieve|search|download|images?|photos?|pictures?|real[- ]world)|i do not have (?:the )?capabilit(?:y|ies).{0,120}(?:browse|search|retrieve|images?|photos?|pictures?)|i can only provide text[- ]based information|please use (?:a )?(?:search engine|google images|bing images)|as (?:an? )?(?:ai|text[- ]based ai|language model).{0,120}(?:cannot|can't|unable))/i.test(text)
}

export class StreamProcessor {
  private emitter: AgentEventEmitter
  private tierTimeouts: TierTimeouts

  constructor(emitter: AgentEventEmitter, tierTimeouts: TierTimeouts) {
    this.emitter = emitter
    this.tierTimeouts = tierTimeouts
  }

  setTierTimeouts(tierTimeouts: TierTimeouts): void {
    this.tierTimeouts = tierTimeouts
  }

  async processStream(
    response: AsyncIterable<{ choices: Array<{ delta?: Record<string, unknown> }> }>,
    state: AgentStateData,
  ): Promise<StreamResult> {
    const emittedToolStarts: Map<number, string> = new Map()
    const filePreviewState: Map<number, { path: string; emittedChars: number; started: boolean }> = new Map()
    let assistantContent = ''
    let reasoningContent = ''
    let contentBuffer = ''
    let visibleTextBuffer = ''
    const toolCalls: Map<number, ToolCallData> = new Map()
    let firstToolCallIndex: number | null = null
    let usage: StreamUsage | null = null
    let insideThinkBlock = false
    let insideTextModeToolCallBlock = false
    let reasoningPhaseEnded = false
    let accumulatedForLeakCheck = ''
    let leakageDetected = false
    let stepAdvancedThisIteration = false
    let suppressTextOnlyOverflow = false
    let generationId: string | null = null

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
      // During active tool argument streaming (e.g., create_file), extend the inactivity window
      // because the model may pause between large argument chunks
      const isStreamingToolArgs = [...toolCalls.values()].some(tc => tc.name === 'create_file' || tc.name === 'append_file' || tc.name === 'edit_file')
      const effectiveInactivityMs = isStreamingToolArgs
        ? Math.max(this.tierTimeouts.inactivityTimeoutMs * 2, FILE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS)
        : this.tierTimeouts.inactivityTimeoutMs
      const effectiveIterationMs = isStreamingToolArgs
        ? Math.max(this.tierTimeouts.iterationTimeoutMs, FILE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS)
        : this.tierTimeouts.iterationTimeoutMs
      const inactivityExpired = now - lastChunkTime > effectiveInactivityMs
      const visibleInactivityExpired = now - lastVisibleActivityTime > effectiveInactivityMs
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
        const raced = await Promise.race([
          nextPromise.then(value => ({ type: 'chunk' as const, value })),
          new Promise<{ type: 'poll' }>(resolve => {
            setTimeout(() => resolve({ type: 'poll' }), streamPollMs)
          }),
        ])

        if (raced.type === 'chunk') return raced.value

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

    const resolvedUsage = async (): Promise<StreamUsage | null> => {
      if (usage) return usage
      try {
        return streamUsageFromCompletionUsage(await fetchGenerationUsage(generationId || undefined))
      } catch (error) {
        console.warn('[StreamProcessor] Usage metadata lookup failed; continuing without usage.', {
          status: (error as { status?: number })?.status,
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
        if (!generationId && typeof chunkAny.id === 'string') {
          generationId = chunkAny.id
        }
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
          const content = delta.content as string
          if (suppressTextOnlyOverflow) {
            continue
          }
          if (reasoningContent && !reasoningPhaseEnded) {
            reasoningPhaseEnded = true
            this.emitter.reasoningDone()
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
              continue
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
                  contentStreamingStartTime, usage: await resolvedUsage(),
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
                continue
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
                this.emitter.textDelta(deflection)
                this.emitter.done()
                this.emitter.close()
                clearInterval(inactivityCheck)
                return {
                  assistantContent, reasoningContent, toolCalls,
                  stepAdvancedThisIteration, leakageDetected: true, timedOut: false,
                  contentStreamingStartTime, usage: await resolvedUsage(),
                }
              }

              // Only emit to user AFTER leakage check passes
              if (cleaned) {
                lastVisibleActivityTime = Date.now()
                this.emitter.textDelta(cleaned)
              }
              contentBuffer = contentBuffer.slice(safeContent.length)
            }
          }
        }

        // Tool calls
        if (delta.tool_calls) {
          const tcs = delta.tool_calls as Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
          for (const tc of tcs) {
            if (firstToolCallIndex === null) firstToolCallIndex = tc.index
            if (tc.index !== firstToolCallIndex) continue

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
              addProvisionalRuntimeDisplayContract(earlyArgs, toolCall.name, state)
              const currentStepPreview = isCurrentPlanStepPreview(earlyArgs, state)
              const revisionPreviewAllowed = pendingDeliverableRevisionAllowsPreview(toolCall.name, earlyArgs, state)
              if (currentStepPreview && revisionPreviewAllowed && shouldEmitProvisionalToolStart(toolCall.name, earlyArgs, state)) {
                const signature = provisionalToolStartSignature(toolCall, earlyArgs)
                if (emittedToolStarts.get(tc.index) !== signature) {
                  emittedToolStarts.set(tc.index, signature)
                  recordVisibleToolStartForNarration(toolCall, earlyArgs, state)
                  this.emitter.toolStart(toolCall.id, toolCall.name, earlyArgs)
                  lastVisibleActivityTime = Date.now()
                }
              }

              if (toolCall.name === 'create_file' || toolCall.name === 'append_file' || toolCall.name === 'edit_file') {
                const path = typeof earlyArgs.path === 'string' ? earlyArgs.path : ''
                const contentKey = toolCall.name === 'edit_file' ? 'new_string' : 'content'
                const content = extractPartialStringArg(toolCall.arguments, contentKey)
                const hasDisplayLabel = typeof earlyArgs.action_label === 'string' && earlyArgs.action_label.length > 0
                if (currentStepPreview && revisionPreviewAllowed && path && hasDisplayLabel) {
                  const preview = filePreviewState.get(tc.index) || { path, emittedChars: 0, started: false }
                  if (!preview.started || preview.path !== path) {
                    preview.path = path
                    preview.started = true
                    preview.emittedChars = 0
                    this.emitter.fileContentStart(toolCall.id, path, toolCall.name)
                    lastVisibleActivityTime = Date.now()
                  }
                  if (typeof content === 'string' && content.length > preview.emittedChars) {
                    const pendingChars = content.length - preview.emittedChars
                    if (pendingChars >= FILE_PREVIEW_MIN_DELTA_CHARS) {
                      this.emitter.fileContentDelta(toolCall.id, content.slice(preview.emittedChars))
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
      // - Iteration timeout (hard limit exceeded) → fatal, always throw
      // - Inactivity/content-only during tool streaming → graceful, return partial results
      //   so the tool pipeline can process whatever content was streamed
      if (toolCalls.size > 0) {
        if ((timeoutReason as 'inactivity' | 'iteration' | 'content_only' | null) === 'iteration') {
          throw new IterationTimeoutError(elapsed)
        }
        // Non-fatal timeout during tool streaming — fall through to return partial results
        // This prevents killing create_file/append_file operations mid-write
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
      this.emitter.reasoningDone()
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
          this.emitter.textDelta(deflection)
          this.emitter.done()
          this.emitter.close()
          return {
            assistantContent, reasoningContent, toolCalls,
            stepAdvancedThisIteration, leakageDetected: true, timedOut: false,
            contentStreamingStartTime, usage: await resolvedUsage(),
          }
        }
        assistantContent += flushed
        this.emitter.textDelta(flushed)
      }
    }

    // Strip leaked tags from accumulated content
    assistantContent = stripSpecialTokens(assistantContent)
    assistantContent = stripThinkingTags(assistantContent)
    assistantContent = stripStepMarkers(assistantContent)
    assistantContent = stripPlanMarkers(assistantContent)

    for (const [index, preview] of filePreviewState) {
      const toolCall = toolCalls.get(index)
      if (!toolCall) continue
      const contentKey = toolCall.name === 'edit_file' ? 'new_string' : 'content'
      const content = extractPartialStringArg(toolCall.arguments, contentKey)
      if (typeof content === 'string' && content.length > preview.emittedChars) {
        this.emitter.fileContentDelta(toolCall.id, content.slice(preview.emittedChars))
        preview.emittedChars = content.length
      }
    }

    return {
      assistantContent,
      reasoningContent,
      toolCalls,
      stepAdvancedThisIteration,
      leakageDetected: false,
      timedOut: streamTimedOut,
      contentStreamingStartTime,
      usage: await resolvedUsage(),
    }
  }
}
