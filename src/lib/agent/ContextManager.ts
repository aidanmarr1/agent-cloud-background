/**
 * Context Window Manager with pluggable compression strategies.
 *
 * Extracts the inline 40+ line context trimming from AgentLoop into a
 * dedicated manager with importance scoring, semantic preservation,
 * and working memory extraction.
 *
 * The manager tracks the full message history and decides what to keep,
 * compress, or discard based on configurable strategies.
 */

import type { ChatMessageParam } from '@/lib/llm'
import type { AgentStateData } from './AgentState'
import { getWorkSummary, getToolHealthSummary } from './AgentState'
import {
  MAX_CONTEXT_MESSAGES,
  CONTEXT_TRIM_SUMMARY_MAX_CHARS,
} from './config'

// ── Types ───────────────────────────────────────────────────────────────────

type ChatMessage = ChatMessageParam

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object') {
          const p = part as { type?: string; text?: string }
          if (p.type === 'text') return p.text || ''
          if (p.type === 'image_url') return '[image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function isBrowserVisualSnapshot(content: unknown): boolean {
  return contentToText(content).includes('BROWSER VISUAL SNAPSHOT')
}

function textPreview(text: string, maxChars: number, suffix = '...[compacted]'): string {
  if (text.length <= maxChars) return text
  if (text.includes(suffix)) return text
  return text.slice(0, maxChars).trimEnd() + suffix
}

function compactToolArguments(raw: string, toolName?: string, maxChars = 220): string {
  if (!raw || raw.length <= maxChars) return raw

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const compact: Record<string, unknown> = {}
    for (const key of ['path', 'output_path', 'source_path', 'url', 'query', 'method', 'index', 'selector', 'action_label', 'plan_step_index']) {
      if (parsed[key] !== undefined) compact[key] = parsed[key]
    }
    if (toolName === 'edit_file') {
      if (parsed.old_string !== undefined) compact.old_string = '[compacted]'
      if (parsed.new_string !== undefined) compact.new_string = '[compacted]'
    } else if (toolName === 'create_file' || toolName === 'append_file') {
      if (parsed.content !== undefined) compact.content = '[compacted]'
    }
    const encoded = JSON.stringify(compact)
    return encoded.length <= maxChars ? encoded : encoded.slice(0, maxChars) + '...'
  } catch {
    return raw.slice(0, maxChars) + '...'
  }
}

interface MessageMetadata {
  importance: number       // 0-10, higher = more important to keep
  category: MessageCategory
  toolNames?: string[]
  fileNames?: string[]
  hasStepProgress: boolean
}

type MessageCategory =
  | 'system'
  | 'user_input'
  | 'assistant_content'
  | 'assistant_tool_call'
  | 'tool_result'
  | 'policy_injection'
  | 'plan_progress'
  | 'context_summary'

// ── Context Manager ─────────────────────────────────────────────────────────

export class ContextManager {
  private messages: ChatMessage[] = []
  private metadata: MessageMetadata[] = []
  private maxMessages: number
  private summaryMaxChars: number

  constructor(opts?: {
    maxMessages?: number
    summaryMaxChars?: number
  }) {
    this.maxMessages = opts?.maxMessages ?? MAX_CONTEXT_MESSAGES
    this.summaryMaxChars = opts?.summaryMaxChars ?? CONTEXT_TRIM_SUMMARY_MAX_CHARS
  }

  /**
   * Initialize with system prompt and user messages.
   */
  initialize(systemPrompt: ChatMessage, userMessages: ChatMessage[]): void {
    this.messages = [systemPrompt, ...userMessages]
    this.metadata = [
      { importance: 10, category: 'system', hasStepProgress: false },
      ...userMessages.map(() => ({
        importance: 9,
        category: 'user_input' as MessageCategory,
        hasStepProgress: false,
      })),
    ]
  }

  /**
   * Add a message to the context with automatic importance scoring.
   */
  push(message: ChatMessage, importanceOverride?: number): void {
    const meta = this.scoreMessage(message)
    if (importanceOverride !== undefined) {
      meta.importance = importanceOverride
    }
    this.messages.push(message)
    this.metadata.push(meta)

    // Proactively compress old tool results to reduce context size.
    // The agent has already processed these — full content is no longer needed.
    this.compressOldMessages()
  }

  /**
   * Compress old messages to reduce context size sent to the LLM.
   * - Truncates old tool result content (agent already processed it)
   * - Truncates create_file/append_file/edit_file arguments (full file content in context is wasteful)
   */
  private compressOldMessages(): void {
    const RECENT = 2
    const MAX_OLD_RESULT = 180
    const MAX_OLD_ARGS = 120
    const MAX_OLD_ASSISTANT_CONTENT = 260

    for (let i = 3; i < this.messages.length - RECENT; i++) {
      const msg = this.messages[i] as unknown as {
        role: string
        content?: unknown
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
      const contentText = contentToText(msg.content)

      // Keep only recent browser screenshots as multimodal context. Older
      // screenshots are costly and stale once the page has changed.
      if (msg.role === 'user' && isBrowserVisualSnapshot(msg.content) && Array.isArray(msg.content)) {
        msg.content = 'BROWSER VISUAL SNAPSHOT omitted from older context. Use the latest browser screenshot and elements list instead.'
        this.metadata[i].importance = Math.min(this.metadata[i].importance, 2)
        continue
      }

      // Compress old tool results
      if (msg.role === 'tool' && contentText.length > MAX_OLD_RESULT) {
        msg.content = textPreview(contentText, MAX_OLD_RESULT, '...[compressed]')
        this.metadata[i].importance = Math.min(this.metadata[i].importance, 3)
      }

      if (
        msg.role === 'assistant' &&
        typeof msg.content === 'string' &&
        contentText.length > MAX_OLD_ASSISTANT_CONTENT &&
        !this.metadata[i].hasStepProgress
      ) {
        msg.content = textPreview(contentText, MAX_OLD_ASSISTANT_CONTENT, '...[assistant narration compacted]')
        this.metadata[i].importance = Math.min(this.metadata[i].importance, 3)
      }

      // Compress create_file/append_file/edit_file arguments — the full file content
      // is the single biggest context bloat source
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.function?.arguments || tc.function.arguments.length <= MAX_OLD_ARGS) continue
          const name = tc.function.name
          if (name === 'create_file' || name === 'append_file' || name === 'edit_file') {
            // Preserve the file path but drop the content
            tc.function.arguments = compactToolArguments(tc.function.arguments, name, MAX_OLD_ARGS)
          }
        }
      }
    }
  }

  /**
   * Collapse stale browser/page payloads at phase boundaries. Step transitions
   * should carry findings and state forward, not the previous phase's full
   * screenshots, element dumps, and page text. Those payloads were the main
   * source of 40k-90k token transition calls.
   */
  compactForStepTransition(state: AgentStateData): void {
    let compacted = 0
    const keepRecentToolResults = 1
    let recentToolResultsSeen = 0

    for (let i = this.messages.length - 1; i >= 3; i--) {
      const msg = this.messages[i] as unknown as {
        role: string
        content?: unknown
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
      const meta = this.metadata[i]
      const contentText = contentToText(msg.content)

      if (msg.role === 'user' && isBrowserVisualSnapshot(msg.content)) {
        msg.content = 'BROWSER VISUAL SNAPSHOT compacted at step transition. Use current page text/elements or call browser_screenshot only if this new phase requires visual inspection.'
        meta.importance = Math.min(meta.importance, 2)
        compacted++
        continue
      }

      if (msg.role === 'tool') {
        recentToolResultsSeen++
        const max = recentToolResultsSeen <= keepRecentToolResults ? 520 : 220
        if (contentText.length > max) {
          msg.content = textPreview(contentText, max, '...[step-transition compacted]')
          meta.importance = Math.min(meta.importance, recentToolResultsSeen <= keepRecentToolResults ? 4 : 3)
          compacted++
        }
        continue
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          if (!tc.function?.arguments) continue
          const before = tc.function.arguments
          tc.function.arguments = compactToolArguments(before, tc.function.name, 180)
          if (tc.function.arguments !== before) compacted++
        }
      }

      if (msg.role === 'system' && contentText.length > 1200 && !contentText.includes('ALL PLAN STEPS ARE COMPLETE')) {
        msg.content = textPreview(contentText, 900, '...[old system guidance compacted]')
        meta.importance = Math.min(meta.importance, 4)
        compacted++
      }
    }

    this.fixToolCallOrdering()
    if (compacted > 0) {
      console.log(`[Context] Step transition compacted ${compacted} stale payloads (step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0})`)
    }
  }

  /**
   * Last-mile cost guard before each model call. It removes hidden image payloads
   * and stale page dumps that survive message-count trimming because they are
   * still "recent", which otherwise creates very expensive thinking turns.
   */
  compactForModelCall(state: AgentStateData): void {
    let compacted = 0
    const keepRecentAssistantMessages = 2
    let recentAssistantMessagesSeen = 0
    const keepLatestVisual =
      state.taskStrategy === 'browse' ||
      state.currentPhase === 'build' ||
      state.websiteBrowserCheckAttempted ||
      state.websiteResponsiveCheckPrompted
    let latestVisualKept = false

    for (let i = this.messages.length - 1; i >= 3; i--) {
      const msg = this.messages[i] as unknown as {
        role: string
        content?: unknown
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      }
      const meta = this.metadata[i]
      const contentText = contentToText(msg.content)

      if (msg.role === 'user' && isBrowserVisualSnapshot(msg.content)) {
        const shouldKeep = keepLatestVisual && !latestVisualKept
        if (shouldKeep) {
          latestVisualKept = true
          continue
        }
        msg.content = 'BROWSER VISUAL SNAPSHOT compacted before model call to control token cost. Use the latest retained snapshot or call browser_screenshot if needed.'
        meta.importance = Math.min(meta.importance, 2)
        compacted++
        continue
      }

      if (msg.role === 'tool' && contentText.length > 900) {
        msg.content = textPreview(contentText, 900, '...[model-call compacted]')
        meta.importance = Math.min(meta.importance, 4)
        compacted++
      }

      if (msg.role === 'assistant') {
        recentAssistantMessagesSeen++
        if (
          recentAssistantMessagesSeen > keepRecentAssistantMessages &&
          typeof msg.content === 'string' &&
          contentText.length > 420 &&
          !meta.hasStepProgress
        ) {
          msg.content = textPreview(contentText, 420, '...[stale assistant narration compacted]')
          meta.importance = Math.min(meta.importance, 3)
          compacted++
        }
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          if (!tc.function?.arguments || tc.function.arguments.length <= 260) continue
          const before = tc.function.arguments
          tc.function.arguments = compactToolArguments(before, tc.function.name, 220)
          if (tc.function.arguments !== before) compacted++
        }
      }
    }

    if (compacted > 0) {
      this.fixToolCallOrdering()
      console.log(`[Context] Model-call compacted ${compacted} expensive payloads`)
    }
  }

  /**
   * Get the current message array for API calls.
   */
  getMessages(): ChatMessage[] {
    return this.messages
  }

  /**
   * Get message count.
   */
  get length(): number {
    return this.messages.length
  }

  /**
   * Check if context needs trimming and perform it if so.
   * Returns true if trimming occurred.
   */
  trimIfNeeded(state: AgentStateData): boolean {
    if (this.messages.length <= this.maxMessages) return false
    this.trim(state)
    return true
  }

  /**
   * Core trimming algorithm with importance-aware compression.
   */
  private trim(state: AgentStateData): void {
    const systemMsg = this.messages[0]
    const userMsgs = this.messages.slice(1, 3)
    const userMeta = this.metadata.slice(1, 3)

    // Keep only the configured recent window, always preserving first 3 (system + user)
    let cutPoint = this.messages.length - this.maxMessages
    if (cutPoint <= 3) return

    // Don't cut in the middle of a tool call sequence — walk backward,
    // but never below index 4 to avoid an infinite loop or deleting system/user msgs
    const minCutPoint = 4
    while (cutPoint > minCutPoint) {
      const msg = this.messages[cutPoint] as unknown as { role: string }
      if (msg.role === 'tool') {
        cutPoint--
      } else {
        break
      }
    }

    // Don't cut after an assistant message with tool_calls (orphaned tool results)
    if (cutPoint > minCutPoint) {
      const msgAtCut = this.messages[cutPoint] as unknown as {
        role: string
        tool_calls?: unknown[]
      }
      if (msgAtCut?.role === 'assistant' && msgAtCut.tool_calls?.length) {
        cutPoint--
      }
    }
    cutPoint = Math.max(minCutPoint, cutPoint)

    // Score and partition the trimmed section
    const trimmedMessages = this.messages.slice(3, cutPoint)
    const trimmedMeta = this.metadata.slice(3, cutPoint)

    const preserved: ChatMessage[] = []
    const preservedMeta: MessageMetadata[] = []
    const toolNames: string[] = []
    const fileNames: string[] = []

    for (let i = 0; i < trimmedMessages.length; i++) {
      const msg = trimmedMessages[i]
      const meta = trimmedMeta[i]

      // Always preserve high-importance messages
      if (meta.importance >= 8) {
        preserved.push(msg)
        preservedMeta.push(meta)
        continue
      }

      // Preserve plan progress markers
      if (meta.hasStepProgress) {
        preserved.push(msg)
        preservedMeta.push(meta)
        continue
      }

      // Do not preserve historical full tool results just because they were
      // successful. Findings are carried by WorkingMemory/work summaries; keeping
      // every old page extract was the primary source of runaway context cost.

      // Track tool names and file creates for summary
      if (meta.toolNames) toolNames.push(...meta.toolNames)
      if (meta.fileNames) fileNames.push(...meta.fileNames)
    }

    const recentMessages = this.messages.slice(Math.max(3, cutPoint))
    const recentMeta = this.metadata.slice(Math.max(3, cutPoint))

    // Rebuild context
    this.messages = [systemMsg, ...userMsgs]
    this.metadata = [this.metadata[0], ...userMeta]

    // Inject context summary
    if (trimmedMessages.length > 5) {
      const summary = this.buildContextSummary(state, trimmedMessages.length, toolNames, fileNames)
      this.messages.push({ role: 'system', content: summary } as ChatMessage)
      this.metadata.push({
        importance: 7,
        category: 'context_summary',
        hasStepProgress: false,
      })
    }

    // Add preserved + recent
    this.messages.push(...preserved, ...recentMessages)
    this.metadata.push(...preservedMeta, ...recentMeta)

    // Post-trim validation: fix orphaned tool_calls / tool results
    // OpenAI-compatible APIs require assistant messages with tool_calls to be immediately followed
    // by tool messages for each tool_call_id
    this.fixToolCallOrdering()

    console.log(`[Context] Trimmed ${trimmedMessages.length - preserved.length} messages, preserved ${preserved.length}`)
  }

  /**
   * Build a rich context summary from agent state.
   */
  private buildContextSummary(
    state: AgentStateData,
    trimmedCount: number,
    toolNames: string[],
    fileNames: string[],
  ): string {
    const workSummary = getWorkSummary(state)
    const toolHealthSummary = getToolHealthSummary(state)

    const parts: string[] = [
      `[Context compressed: ${trimmedCount} messages trimmed.]`,
    ]
    if (fileNames.length > 0) {
      parts.push(`Created files: ${[...new Set(fileNames)].join(', ')}.`)
    }

    const contextParts = [`WORK COMPLETED SO FAR:\n${workSummary}`]
    if (toolHealthSummary) {
      contextParts.push(`\n${toolHealthSummary}`)
    }

    // Reasoning chain preservation: extract key decisions from trimmed messages
    const decisions = this.extractDecisions(state)
    if (decisions) {
      contextParts.push(`\nKEY DECISIONS:\n${decisions}`)
    }

    // Working memory snapshot — preserve accumulated facts across compression
    const memorySnapshot = state.workingMemory?.render({ maxFacts: 8, maxChars: 1200 })
    if (memorySnapshot) {
      contextParts.push(`\n${memorySnapshot}`)
    }

    // Goal tracker context — preserve goal status across compression
    const goalContext = state.goalTracker?.renderForContext()
    if (goalContext) {
      contextParts.push(`\n${goalContext}`)
    }

    contextParts.push(
      '\nCRITICAL: Do NOT repeat any of the above searches, URL visits, or file creations. Build on what you already have.'
    )

    const fullSummary = parts.join(' ') + '\n\n' + contextParts.join('\n')

    if (fullSummary.length > this.summaryMaxChars) {
      return fullSummary.slice(0, this.summaryMaxChars) + '\n...[summary truncated]'
    }

    return fullSummary
  }

  /**
   * Extract key decision rationale from trimmed context.
   * Preserves why certain approaches were chosen or abandoned.
   */
  private extractDecisions(state: AgentStateData): string | null {
    const decisions: string[] = []

    // Extract from failure log — what was tried and failed
    if (state.failureLog && state.failureLog.length > 0) {
      const uniqueFailures = new Map<string, string>()
      for (const f of state.failureLog.slice(-5)) {
        if (!uniqueFailures.has(f.tool)) {
          uniqueFailures.set(f.tool, f.error.slice(0, 80))
        }
      }
      for (const [tool, error] of uniqueFailures) {
        decisions.push(`- ${tool} failed: ${error} — avoid retrying same approach`)
      }
    }

    // Replan history
    if (state.replanCount > 0) {
      decisions.push(`- Plan was revised ${state.replanCount} time(s) based on new information`)
    }

    return decisions.length > 0 ? decisions.join('\n') : null
  }

  /**
   * Score a message's importance based on its content and role.
   */
  private scoreMessage(message: ChatMessage): MessageMetadata {
    const msg = message as unknown as {
      role: string
      content?: unknown
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
      tool_call_id?: string
    }

    const content = contentToText(msg.content)
    const hasStepProgress = content.includes('PLAN PROGRESS') || content.includes('<next_step')

    // System messages with injected guidance
    if (msg.role === 'system') {
      if (hasStepProgress) {
        return { importance: 8, category: 'plan_progress', hasStepProgress: true }
      }
      if (content.includes('CRITICAL') || content.includes('ALL PLAN STEPS')) {
        return { importance: 7, category: 'policy_injection', hasStepProgress: false }
      }
      return { importance: 5, category: 'policy_injection', hasStepProgress: false }
    }

    // User messages are always important
    if (msg.role === 'user') {
      if (isBrowserVisualSnapshot(msg.content)) {
        return { importance: 5, category: 'tool_result', hasStepProgress: false }
      }
      return { importance: 9, category: 'user_input', hasStepProgress: false }
    }

    // Assistant messages with tool calls
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const toolNames = msg.tool_calls
        .map(tc => tc.function?.name)
        .filter(Boolean) as string[]
      const fileNames: string[] = []
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === 'create_file' || tc.function?.name === 'append_file' || tc.function?.name === 'export_pdf') {
          try {
            const args = JSON.parse(tc.function.arguments || '{}')
            if (args.path) fileNames.push(args.path)
            if (args.output_path) fileNames.push(args.output_path)
          } catch { /* skip */ }
        }
      }

      return {
        importance: 6,
        category: 'assistant_tool_call',
        toolNames,
        fileNames: fileNames.length > 0 ? fileNames : undefined,
        hasStepProgress: false,
      }
    }

    // Tool results — score based on success vs error to preserve findings, not failures
    if (msg.role === 'tool') {
      const isError = content.includes('"error"') || content.startsWith('Error') || content.includes('BLOCKED')
      if (isError) {
        // Errors are less valuable — trim them first to keep actual research
        return { importance: 3, category: 'tool_result', hasStepProgress: false }
      }
      const importance = content.length > 500 ? 6 : 5
      return { importance, category: 'tool_result', hasStepProgress: false }
    }

    // Regular assistant content
    if (msg.role === 'assistant') {
      // Narration decay: short assistant messages without tool calls are narrations —
      // their findings are already captured in step findings, so they can be trimmed first
      if (content.length < 300 && !msg.tool_calls?.length) {
        return { importance: 2, category: 'assistant_content', hasStepProgress }
      }
      const importance = content.length > 200 ? 6 : 4
      return { importance, category: 'assistant_content', hasStepProgress }
    }

    return { importance: 3, category: 'assistant_content', hasStepProgress: false }
  }

  /**
   * Inject a working memory summary into context after trimming.
   * Consolidates memory injection so it happens in one place, not scattered across AgentLoop.
   */
  injectMemorySummary(memory: { getSummary: () => string }): void {
    const summary = memory.getSummary()
    if (!summary || summary.length < 20) return

    // Avoid duplicate injection — check if we already have a recent memory summary
    const lastFew = this.messages.slice(-5)
    const alreadyInjected = lastFew.some(m => {
      const content = (m as { content?: string }).content || ''
      return content.includes('WORKING MEMORY')
    })
    if (alreadyInjected) return

    this.push({
      role: 'system',
      content: `WORKING MEMORY (key findings preserved from trimmed context):\n${summary}`,
    } as ChatMessage, 8) // High importance — survives future trims
  }

  /**
   * Fix tool_calls / tool result ordering after context trimming.
   * Removes orphaned assistant messages with tool_calls that lack matching tool results,
   * and orphaned tool results that lack a preceding assistant message with matching tool_call_id.
   */
  private fixToolCallOrdering(): void {
    const toRemove = new Set<number>()

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i] as unknown as {
        role: string
        tool_calls?: Array<{ id: string }>
        tool_call_id?: string
      }

      // Check assistant messages with tool_calls
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id))
        // Look at the immediately following messages for matching tool results
        let j = i + 1
        while (j < this.messages.length) {
          const next = this.messages[j] as unknown as { role: string; tool_call_id?: string }
          if (next.role === 'tool' && next.tool_call_id) {
            expectedIds.delete(next.tool_call_id)
            j++
          } else if (next.role === 'system') {
            // System messages can appear between tool results (step advance, etc.)
            j++
          } else {
            break
          }
        }
        // If any tool_call_ids are missing their results, remove the assistant message
        if (expectedIds.size > 0) {
          toRemove.add(i)
          // Also remove the partial tool results that were found
          for (let k = i + 1; k < j; k++) {
            const m = this.messages[k] as unknown as { role: string }
            if (m.role === 'tool') toRemove.add(k)
          }
        }
      }

      // Check orphaned tool results (no preceding assistant with matching tool_calls)
      if (msg.role === 'tool' && msg.tool_call_id) {
        let hasParent = false
        for (let k = i - 1; k >= 0; k--) {
          const prev = this.messages[k] as unknown as {
            role: string
            tool_calls?: Array<{ id: string }>
          }
          if (prev.role === 'assistant' && prev.tool_calls?.some(tc => tc.id === msg.tool_call_id)) {
            hasParent = true
            break
          }
          // Stop searching if we hit another assistant or user message without tool_calls
          if (prev.role === 'user' || (prev.role === 'assistant' && !prev.tool_calls?.length)) break
        }
        if (!hasParent) toRemove.add(i)
      }
    }

    if (toRemove.size > 0) {
      this.messages = this.messages.filter((_, i) => !toRemove.has(i))
      this.metadata = this.metadata.filter((_, i) => !toRemove.has(i))
      console.log(`[Context] Removed ${toRemove.size} orphaned tool_calls/results after trimming`)
    }
  }
}
