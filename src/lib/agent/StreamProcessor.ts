import type { AgentEventEmitter } from './SSEEmitter'
import type { AgentStateData } from './AgentState'
import type { TierTimeouts } from './guards'
import { stripThinkingTags, stripStepMarkers, stripPlanMarkers, stripSpecialTokens, checkForLeakage, unescapeJsonChunk } from './guards'
import { IterationTimeoutError, InactivityTimeoutError, ContentOnlyTimeoutError } from './errors'
import { fetchGenerationUsage } from '@/lib/llm'
import { strictActionLabelFromArgs } from '@/lib/stream/ActivityDescriber'
import type { ChatCompletionUsage } from '@/lib/llm'

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

function addStringMetrics(target: Record<string, unknown>, rawArgs: string, key: string): void {
  const value = extractPartialStringArg(rawArgs, key)
  if (!value) return
  target[`${key}CharCount`] = value.length
  target[`${key}LineCount`] = value.split('\n').length
}

function addDisplayContractArgs(args: Record<string, unknown>, parsed: Record<string, unknown> | null, rawArgs: string): void {
  const actionLabel = parsed ? parsed.action_label : extractStringArg(rawArgs, 'action_label')
  if (typeof actionLabel === 'string' && actionLabel) args.action_label = actionLabel

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

function shouldEmitProvisionalToolStart(toolName: string, args: Record<string, unknown>): boolean {
  if (!strictActionLabelFromArgs(args)) return false

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
    const toolCalls: Map<number, ToolCallData> = new Map()
    let firstToolCallIndex: number | null = null
    let usage: StreamUsage | null = null
    let insideThinkBlock = false
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

    const inactivityCheck = setInterval(() => {
      const now = Date.now()
      // During active tool argument streaming (e.g., create_file), extend the inactivity window
      // because the model may pause between large argument chunks
      const isStreamingToolArgs = [...toolCalls.values()].some(tc => tc.name === 'create_file' || tc.name === 'append_file' || tc.name === 'edit_file')
      const effectiveInactivityMs = isStreamingToolArgs
        ? this.tierTimeouts.inactivityTimeoutMs * 2  // Double tolerance during file writes
        : this.tierTimeouts.inactivityTimeoutMs
      const inactivityExpired = now - lastChunkTime > effectiveInactivityMs
      const visibleInactivityExpired = now - lastVisibleActivityTime > effectiveInactivityMs
      const iterationExpired = now - iterationStartTime > this.tierTimeouts.iterationTimeoutMs
      // Content-only timeout: only fire if the model is producing ONLY text (no tool calls
      // at all) and has stalled. Never fire if tool calls are being streamed.
      const streamStalled = now - lastChunkTime > 5_000 // No new chunks for 5s (was 3s, too aggressive)
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
    }, this.tierTimeouts.checkIntervalMs)

    const resolvedUsage = async (): Promise<StreamUsage | null> =>
      usage ?? streamUsageFromCompletionUsage(await fetchGenerationUsage(generationId || undefined))

    try {
      for await (const chunk of response) {
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
          // Reasoning is intentionally discarded. The request asks OpenRouter
          // to exclude it, but this keeps the UI clean if a provider still
          // sends reasoning_content.
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
              const cleaned = stripPlanMarkers(safeContent)
              assistantContent += safeContent
              if (contentStreamingStartTime === null && safeContent.length > 0) {
                contentStreamingStartTime = Date.now()
              }
              accumulatedForLeakCheck += safeContent

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
              // If the model has produced N+ chars of text with NO tool calls,
              // stop displaying more text but keep draining the stream. OpenRouter
              // sends billable usage in the final chunk; aborting here causes
              // false "provider did not return billable usage" failures.
              // Higher cap for local models — they need more room to emit <next_step/> after summaries.
              // BUT skip the cap entirely if <next_step/> was already detected (let the model finish).
              const TEXT_ONLY_CAP = 800
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
          lastVisibleActivityTime = Date.now()
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
              if (shouldEmitProvisionalToolStart(toolCall.name, earlyArgs)) {
                const signature = provisionalToolStartSignature(toolCall, earlyArgs)
                if (emittedToolStarts.get(tc.index) !== signature) {
                  emittedToolStarts.set(tc.index, signature)
                  recordVisibleToolStartForNarration(toolCall, earlyArgs, state)
                  this.emitter.toolStart(toolCall.id, toolCall.name, earlyArgs)
                }
              }

              if (toolCall.name === 'create_file' || toolCall.name === 'append_file' || toolCall.name === 'edit_file') {
                const path = typeof earlyArgs.path === 'string' ? earlyArgs.path : ''
                const contentKey = toolCall.name === 'edit_file' ? 'new_string' : 'content'
                const content = extractPartialStringArg(toolCall.arguments, contentKey)
                const hasDisplayLabel = typeof earlyArgs.action_label === 'string' && earlyArgs.action_label.length > 0
                if (path && hasDisplayLabel) {
                  const preview = filePreviewState.get(tc.index) || { path, emittedChars: 0, started: false }
                  if (!preview.started || preview.path !== path) {
                    preview.path = path
                    preview.started = true
                    preview.emittedChars = 0
                    this.emitter.fileContentStart(toolCall.id, path, toolCall.name)
                  }
                  if (typeof content === 'string' && content.length > preview.emittedChars) {
                    this.emitter.fileContentDelta(toolCall.id, content.slice(preview.emittedChars))
                    preview.emittedChars = content.length
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
        if (timeoutReason === 'iteration') {
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
    if (contentBuffer) {
      let flushed = stripSpecialTokens(contentBuffer)
      flushed = stripThinkingTags(flushed)
      flushed = stripStepMarkers(flushed)
      flushed = stripPlanMarkers(flushed)
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
