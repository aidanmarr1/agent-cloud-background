'use client'

import { v4 as uuidv4 } from 'uuid'
import type { SSEEvent, TaskStep, TaskGroup, Subtask, SubtaskType, SearchResult, BrowseResult, BrowserResult, FileResult, ImageSearchPanelItem, TerminalResult, Artifact, ComputerPanelItem } from '@/types'
import { useUIStore } from '@/store/ui'
import { useChatStore } from '@/store/chat'
import { useSettingsStore } from '@/store/settings'
import { cleanThinkingTags, normalizeMarkdownForDisplay, sanitizeNarrationText, stripToolActionNarration } from '@/lib/stream/cleaners'
import {
  toolNameToSubtaskType,
  BROWSER_TOOLS,
  FILE_TOOLS,
  BROWSE_TOOLS,
  isInternalActivityTool,
  isHiddenSubtaskActivity,
  isIncompleteBrowserClickActivity,
  isBrowserPreflightBlockResult,
} from '@/lib/stream/constants'
import { runtimeVisibleActionLabel, strictActionLabelFromArgs } from '@/lib/stream/ActivityDescriber'
import { playComplete, playError } from '@/lib/useSound'
import { sendDesktopNotification } from '@/lib/notifications'
import { useCreditStore } from '@/store/credits'
import {
  OUT_OF_CREDITS_MESSAGE,
  type CreditLedgerEvent,
  type CreditTokenUsage,
} from '@/lib/creditPolicy'
import { NarrationBuffer } from './narrationBuffer'
import { mapToolResultToPanel, isBrowserTool } from './panelMapper'
import { WebIdeHandler } from './webIdeIntegration'
import { BatchScheduler } from './batchScheduler'
import { extractTaskAcknowledgment } from '@/lib/stream/taskMessageContent'
import { userErrorMessage } from '@/lib/errorMessages'

const MAX_TERMINAL_STDOUT = 50_000
const MAX_TERMINAL_STDERR = 50_000
const MAX_PREPLAN_BUF = 10_000
const MIN_TOOLS_BETWEEN_NARRATION_FLUSHES = 3
const MAX_TOOLS_BETWEEN_NARRATION_FLUSHES = 4
const TOOLS_BETWEEN_NARRATION_FLUSHES = MIN_TOOLS_BETWEEN_NARRATION_FLUSHES
const SERVER_CREDIT_ACCOUNTING = true

type ToolStartEvent = { id: string; name: string; args: Record<string, unknown> }

function isDeferredBrowseToolStart(name: string): boolean {
  void name
  return false
}

function isStaleFutureWorkAck(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  return /^(?:next|now|then|after that|moving forward|from here|at this point)[,\s]+(?:i(?:'|\u2019)?ll|i will|let me|i(?:'|\u2019)?m going to|i am going to)\b.{0,120}\b(build|create|write|research|implement|fix|add|start|run|check|verify|open|browse|search|continue|make)\b/.test(normalized)
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function hasSentenceEnd(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim())
}

function isIncompleteStartupAcknowledgment(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (wordCount(trimmed) <= 3 && !hasSentenceEnd(trimmed)) return true
  return /(?:\b(?:i(?:'|\u2019)?ll|i will|i(?:'|\u2019)?m going to|research|about|with|for|and|or|to|of|the|a|an|then|next|while|including|across|from|using|by)\b|[-,:;(/])$/i.test(trimmed) &&
    wordCount(trimmed) < 12
}

function acknowledgmentQuality(text: string): number {
  const trimmed = text.trim()
  if (!trimmed || isStaleFutureWorkAck(trimmed) || isIncompleteStartupAcknowledgment(trimmed)) return -1
  return trimmed.length + (hasSentenceEnd(trimmed) ? 500 : 0)
}

function selectBestStartupAcknowledgment(cached: string, current: string): string {
  const candidates = [cached, current]
    .map(candidate => candidate.trim())
    .filter(Boolean)

  let best = ''
  let bestScore = -1
  for (const candidate of candidates) {
    const score = acknowledgmentQuality(candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return bestScore >= 0 ? best : ''
}

function cleanStartupAcknowledgmentText(text: string): string {
  return normalizeMarkdownForDisplay(cleanThinkingTags(text))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeDuplicatedSavedReport(text: string, savedFileCount: number): boolean {
  if (savedFileCount <= 0) return false
  const trimmed = text.trim()
  if (!trimmed) return false
  return trimmed.length > 700 ||
    /^#{1,6}\s+/m.test(trimmed) ||
    /\b(?:Executive Summary|References|Conclusion|Research Report|Final Report)\b/i.test(trimmed)
}

function capStr(s: string, max: number): string {
  if (s.length <= max) return s
  return '[truncated]\n' + s.slice(s.length - (max - 12))
}

function stripPreflightBlockLeadIn(content?: string): string | undefined {
  const cleaned = content
    ?.replace(/^\s*(?:BROWSER_ACTION_PREFLIGHT_BLOCKED:\s*)?(?:Click|Action|Browser action|Repeated no-progress target|No live browser page|Index \[\d+\]|Element \[\d+\]|Selector "[^"]+"|browser_(?:click_at|type|select|fill_form))[\s\S]*?(?:fresh (?:\[N\] )?(?:elements )?list|blocked before execution|requires [^{]*\{index: N\}|Use browser_|Do not reuse an index)[\s\S]*?(?=\n\n|$)/i, '')
    .trim()
  return cleaned || undefined
}

function browserPanelDataForPreflightBlock(data: BrowserResult): BrowserResult {
  return {
    ...data,
    success: true,
    recoverable: true,
    error: undefined,
    action: 'Browser state refreshed',
    content: stripPreflightBlockLeadIn(data.content),
  }
}

function stableBrowserPanelData(data: BrowserResult, previous?: BrowserResult): BrowserResult {
  const hasNewScreenshot = !!data.screenshotBase64
  const screenshotBase64 = data.screenshotBase64 || previous?.screenshotBase64
  return {
    ...data,
    screenshotBase64,
    liveFrame: data.liveFrame || (!hasNewScreenshot ? previous?.liveFrame : undefined),
    liveFrameUpdatedAt: screenshotBase64
      ? data.liveFrameUpdatedAt || previous?.liveFrameUpdatedAt || Date.now()
      : data.liveFrameUpdatedAt || previous?.liveFrameUpdatedAt,
  }
}

function isHiddenInternalToolResult(name: string, result: unknown): boolean {
  if (isInternalActivityTool(name)) return true
  if (!result || typeof result !== 'object') return false
  const error = (result as { error?: unknown }).error
  if (typeof error !== 'string') return false

  return /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(error)
}

function panelFocusIdForTool(name: string, id: string): string {
  if (BROWSER_TOOLS.includes(name)) return 'browser_live'
  if (name === 'execute_command' || name === 'run_code') return id + '_live'
  return id
}

function concisePanelSubject(value: unknown, max = 90): string {
  const subject = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!subject) return ''
  return subject.length > max ? subject.slice(0, max).replace(/\s+\S*$/, '') + '...' : subject
}

function completedSearchPanelTitle(toolName: string, previousTitle?: string): string | null {
  if (!previousTitle) return null
  if (toolName === 'web_search') {
    if (/^Searching:\s*/i.test(previousTitle)) return previousTitle.replace(/^Searching:\s*/i, 'Search results: ')
    if (!/^Search in progress$/i.test(previousTitle)) return previousTitle
  }
  if (toolName === 'image_search') {
    if (/^Searching images:\s*/i.test(previousTitle)) return previousTitle.replace(/^Searching images:\s*/i, 'Image results: ')
    if (!/^Image lookup in progress$/i.test(previousTitle)) return previousTitle
  }
  return null
}

function isComputerPanelTool(name: string): boolean {
  return name === 'web_search' ||
    name === 'image_search' ||
    name === 'execute_command' ||
    name === 'run_code' ||
    BROWSER_TOOLS.includes(name) ||
    FILE_TOOLS.includes(name) ||
    BROWSE_TOOLS.includes(name)
}

function hasStreamingLiveBrowser(conversationId: string): boolean {
  const latestPanelItems = useChatStore.getState().conversations
    .find(c => c.id === conversationId)?.messages.slice(-1)[0]?.computerPanelData || []
  return latestPanelItems.some(item => item.id === 'browser_live' && item.streaming)
}

function isCreditCutoffMessage(message: string): boolean {
  return message === OUT_OF_CREDITS_MESSAGE ||
    /\b(?:credits ran out|out of credits)\b/i.test(message)
}

export interface StoreActions {
  appendToLastMessage: (convId: string, text: string) => void
  appendReasoning: (convId: string, text: string) => void
  setSteps: (convId: string, steps: TaskStep[]) => void
  setTaskGroups: (convId: string, groups: TaskGroup[]) => void
  updateTaskGroupStatus: (convId: string, idx: number, status: TaskGroup['status']) => void
  addSubtaskToGroup: (convId: string, idx: number, subtask: Subtask) => void
  updateSubtaskInGroup: (convId: string, idx: number, subtaskId: string, status: Subtask['status'], result?: Subtask['result'], patch?: Partial<Subtask>) => void
  addGroupNarration: (convId: string, idx: number, text: string, position?: number) => void
  setLastMessageContent: (convId: string, content: string) => void
  setFollowUps: (convId: string, suggestions: { text: string }[]) => void
  addArtifact: (convId: string, artifact: Artifact) => void
  addComputerPanelItem: (convId: string, item: ComputerPanelItem) => void
  upsertComputerPanelItem: (convId: string, item: ComputerPanelItem) => void
  removeComputerPanelItem: (convId: string, itemId: string) => void
  setComputerPanelOpen: (open: boolean, options?: { source?: 'user' | 'auto' }) => void
  addToast: (msg: string, type?: 'error' | 'success' | 'info') => void
}

export class EventDispatcher {
  private parsedGroups: TaskGroup[] = []
  private parsedSteps: TaskStep[] = []
  private terminalAccum: Record<string, TerminalResult> = {}
  private currentGroupIdx = -1
  private narrationBuf = new NarrationBuffer()
  private webIde = new WebIdeHandler()
  private planTextParsed = false
  private groupsActive = false
  private hasEmittedFirstMessage = false
  private postLastToolText = ''
  private prePlanBuf = ''
  private startupAcknowledgment = ''
  private toolsSinceLastNarration = 0
  private pendingNarrationTools: Array<{ toolName: string; result: unknown }> = []
  private toolStartsById = new Map<string, ToolStartEvent>()
  private deferredBrowseToolStarts = new Map<string, ToolStartEvent>()
  private lastNarrationText = ''
  private seenToolStartIds = new Set<string>()
  private chargedToolIds = new Set<string>()
  private terminalStatus: 'done' | 'error' | 'stopped' | null = null
  private terminalErrorMessage: string | null = null

  // --- Batching: coalesce rapid state updates into single frames ---
  private batch = new BatchScheduler()
  private pendingText = ''        // Buffered text_delta content

  constructor(
    private conversationId: string,
    private actions: StoreActions,
    private setStreamError: (err: string | null) => void,
  ) {}

  dispatch(event: SSEEvent): void {
    switch (event.type) {
      case 'heartbeat':
        break
      case 'reasoning_delta':
        break
      case 'reasoning_done':
        break
      case 'text_delta':
        this.handleTextDelta(event.content)
        break
      case 'follow_ups':
        this.actions.setFollowUps(this.conversationId, event.suggestions)
        break
      case 'plan':
        this.handlePlan(event.items)
        break
      case 'artifact_created':
        this.actions.addArtifact(this.conversationId, event.artifact)
        break
      case 'credit_event':
        this.handleCreditEvent(event.entry)
        break
      case 'tool_start':
        this.handleToolStart(event)
        break
      case 'tool_result':
        this.handleToolResult(event)
        break
      case 'browser_frame':
        this.handleBrowserFrame(event.frame, event.timestamp)
        break
      case 'file_content_start':
        this.webIde.handleFileContentStart(
          event.id, event.path, event.toolName, this.conversationId,
          this.actions.upsertComputerPanelItem,
          () => this.actions.setComputerPanelOpen(true, { source: 'auto' }),
        )
        break
      case 'file_content_delta':
        this.webIde.handleFileContentDelta(
          event.id, event.content, this.conversationId,
          // Wrap in batch scheduler so rapid deltas don't freeze the UI
          (convId, item) => {
            this.batch.schedule(`file_delta_${event.id}`, () => {
              this.webIde.flushPendingWebIdeContent()
              this.actions.upsertComputerPanelItem(convId, item)
            })
          },
        )
        break
      case 'terminal_output':
        this.handleTerminalOutput(event)
        break
      case 'step_advance':
        this.handleStepAdvance(event)
        break
      case 'error':
        this.terminalStatus = 'error'
        this.terminalErrorMessage = userErrorMessage(event.message, 'The task stopped before it finished. Please try again.')
        this.handleError(this.terminalErrorMessage)
        break
      case 'done':
        this.terminalStatus = 'done'
        this.handleDone(event.usage)
        break
    }
  }

  private handleBrowserFrame(frame: string, timestamp: number): void {
    const existingItems = useChatStore.getState().conversations
      .find(c => c.id === this.conversationId)?.messages.slice(-1)[0]?.computerPanelData
    const prevItem = existingItems?.find(i => i.id === 'browser_live')
    const prev = prevItem?.data as BrowserResult | undefined

    this.actions.upsertComputerPanelItem(this.conversationId, {
      id: 'browser_live',
      type: 'browser',
      title: prevItem?.title || 'Browser',
      data: {
        ...(prev || {
          success: true,
          url: '',
          title: '',
          action: 'Browsing',
        }),
        success: true,
        recoverable: undefined,
        error: undefined,
        screenshotPath: undefined,
        screenshotUrl: undefined,
        screenshotBase64: frame,
        liveFrame: true,
        liveFrameUpdatedAt: timestamp,
      } as BrowserResult,
      timestamp,
      streaming: true,
    })
    this.actions.setComputerPanelOpen(true, { source: 'auto' })
  }

  hasTerminalEvent(): boolean {
    return this.terminalStatus !== null
  }

  getTerminalStatus(): 'done' | 'error' | 'stopped' | null {
    return this.terminalStatus
  }

  getTerminalErrorMessage(): string | null {
    return this.terminalErrorMessage
  }

  private setThinkingIfNoVisibleActionRunning(): void {
    const uiState = useUIStore.getState()
    if (!uiState.isStreaming) return

    const group = this.currentGroupIdx >= 0 ? this.parsedGroups[this.currentGroupIdx] : undefined
    const hasRunningVisibleSubtask = group?.subtasks.some((subtask) =>
      subtask.status === 'running' && !isHiddenSubtaskActivity(subtask)
    ) ?? false

    if (!hasRunningVisibleSubtask) {
      uiState.setStreamingStatus('thinking')
    }
  }

  private handleTextDelta(content: string): void {
    if (!this.groupsActive || !this.hasEmittedFirstMessage) {
      // Before groups are active OR before the first message has been emitted,
      // route text to the main message (renders with full markdown via AgentMessage)
      this.prePlanBuf += content
      if (this.prePlanBuf.length > MAX_PREPLAN_BUF) {
        this.prePlanBuf = this.prePlanBuf.slice(this.prePlanBuf.length - MAX_PREPLAN_BUF)
      }
      // Buffer and flush via rAF instead of calling appendToLastMessage on every chunk
      this.batch.schedule('text_delta', () => {
        const partialTag = this.prePlanBuf.match(/<[^>]{0,40}$/)
        const safe = partialTag ? this.prePlanBuf.slice(0, partialTag.index) : this.prePlanBuf
        if (safe) {
          const cleaned = cleanThinkingTags(safe)
          if (cleaned) this.actions.appendToLastMessage(this.conversationId, cleaned)
          this.prePlanBuf = this.prePlanBuf.slice(safe.length)
        }
      })
    } else if (this.currentGroupIdx >= 0) {
      this.setThinkingIfNoVisibleActionRunning()
      this.narrationBuf.append(content)
    }
    this.postLastToolText += content
  }

  private lastAssistantContent(): string {
    const conv = useChatStore.getState().conversations.find(c => c.id === this.conversationId)
    const lastMsg = conv?.messages ? [...conv.messages].reverse().find(m => m.role === 'assistant') : null
    return lastMsg?.content || ''
  }

  private cleanAcknowledgmentCandidate(content: string): string {
    const raw = extractTaskAcknowledgment(cleanThinkingTags(content))
    return cleanStartupAcknowledgmentText(raw)
  }

  private captureStartupAcknowledgment(): void {
    const candidate = this.cleanAcknowledgmentCandidate(this.lastAssistantContent())
    if (
      candidate &&
      !isStaleFutureWorkAck(candidate) &&
      !isIncompleteStartupAcknowledgment(candidate) &&
      acknowledgmentQuality(candidate) >= acknowledgmentQuality(this.startupAcknowledgment)
    ) {
      this.startupAcknowledgment = candidate
    }
  }

  private handlePlan(items: string[]): void {
    if (this.planTextParsed || !items || items.length === 0) return

    this.batch.flushSync()

    if (this.prePlanBuf) {
      const cleaned = cleanThinkingTags(this.prePlanBuf)
      if (cleaned.trim()) this.actions.appendToLastMessage(this.conversationId, cleaned)
      this.prePlanBuf = ''
    }
    this.captureStartupAcknowledgment()

    const existingSubtasks = this.parsedGroups.length > 0 ? [...this.parsedGroups[0].subtasks] : []
    this.parsedGroups.length = 0
    this.parsedSteps.length = 0

    items.forEach((title: string, i: number) => {
      this.parsedSteps.push({ index: i, title, status: 'pending', items: [] })
      this.parsedGroups.push({
        id: uuidv4(),
        index: i,
        title,
        status: i === 0 ? 'running' : 'pending',
        subtasks: i === 0 ? existingSubtasks : [],
        narrations: [],
        synthesis: '',
        startedAt: i === 0 ? Date.now() : undefined,
      })
    })

    this.actions.setSteps(this.conversationId, [...this.parsedSteps])
    this.currentGroupIdx = 0
    this.planTextParsed = true
    this.groupsActive = true
    this.actions.setTaskGroups(this.conversationId, [...this.parsedGroups])
    // The plan is visible; the model is now deciding the first concrete action.
    useUIStore.getState().setStreamingStatus('thinking')
  }

  private prepareToolStart(event: ToolStartEvent): boolean {
    const firstStartForId = !this.seenToolStartIds.has(event.id)
    this.seenToolStartIds.add(event.id)

    if (this.prePlanBuf) {
      const cleaned = cleanThinkingTags(this.prePlanBuf)
      if (cleaned.trim()) this.actions.appendToLastMessage(this.conversationId, cleaned)
      this.prePlanBuf = ''
    }
    // First tool call means the acknowledgment is complete
    this.hasEmittedFirstMessage = true
    this.captureStartupAcknowledgment()
    if (firstStartForId) {
      if (this.narrationBuf.length > 0) {
        if (this.flushNarration()) this.pendingNarrationTools = []
        else this.discardNarrationBuffer()
      }
      this.postLastToolText = ''
      this.chargeToolEvent(event.id, event.name)
    } else if (this.narrationBuf.length > 0) {
      // A later execution-time tool_start may refine a provisional label.
      // It should not count as another tool call, but flushing keeps narration
      // ordered before the refined pill state if any text slipped in.
      if (this.flushNarration()) this.pendingNarrationTools = []
      else this.discardNarrationBuffer()
    }

    return firstStartForId
  }

  private handleToolStart(event: ToolStartEvent): void {
    if (isInternalActivityTool(event.name)) return
    this.toolStartsById.set(event.id, event)
    const strictActionLabel = strictActionLabelFromArgs(event.args)
    const visibleActionLabel = strictActionLabel || runtimeVisibleActionLabel(event.name, event.args)
    if (!visibleActionLabel) return

    const isHiddenActivity = isIncompleteBrowserClickActivity({ toolName: event.name, label: visibleActionLabel })
    if (isHiddenActivity) {
      // Internal visual context and incomplete preflight browser actions should
      // not create visible task pills, panel focus changes, or credit charges.
      return
    }

    if (isDeferredBrowseToolStart(event.name)) {
      this.prepareToolStart(event)
      this.deferredBrowseToolStarts.set(event.id, event)
      useUIStore.getState().setStreamingStatus('analyzing')
      return
    }

    this.prepareToolStart(event)

    // Update streaming status
    const tn = event.name
    const s = tn === 'web_search' || tn === 'image_search' ? 'searching' as const
      : tn.startsWith('browser_') ? 'browsing' as const
      : tn === 'execute_command' || tn === 'run_code' ? 'running' as const
      : tn === 'create_file' || tn === 'edit_file' || tn === 'append_file' || tn === 'export_pdf' ? 'coding' as const
      : 'analyzing' as const
    const uiState = useUIStore.getState()
    uiState.setStreamingStatus(s)
    const browserLiveActive = hasStreamingLiveBrowser(this.conversationId)
    const shouldFocusComputerPanel = isComputerPanelTool(event.name) &&
      (BROWSER_TOOLS.includes(event.name) || !browserLiveActive)
    if (shouldFocusComputerPanel) {
      uiState.setComputerActiveTab('activity')
      uiState.setComputerPanelActiveItemId(panelFocusIdForTool(event.name, event.id))
    }

    if (this.currentGroupIdx >= 0 && this.currentGroupIdx < this.parsedGroups.length) {
      if (this.parsedGroups[this.currentGroupIdx].status === 'pending') {
        this.parsedGroups[this.currentGroupIdx] = { ...this.parsedGroups[this.currentGroupIdx], status: 'running', startedAt: Date.now() }
        this.actions.updateTaskGroupStatus(this.conversationId, this.currentGroupIdx, 'running')
      }

      const subtask: Subtask = {
        id: event.id,
        toolName: event.name,
        type: (toolNameToSubtaskType[event.name] || 'browse') as SubtaskType,
        label: visibleActionLabel,
        query: event.args.query as string | undefined,
        url: event.args.url as string | undefined,
        command: event.args.command as string | undefined,
        filePath: (event.args.path || event.args.output_path || event.args.source_path || event.args.directory) as string | undefined,
        labelSource: strictActionLabel ? 'model' : 'system',
        status: 'running',
        startedAt: Date.now(),
      }
      const grp = this.parsedGroups[this.currentGroupIdx]
      const existingIdx = grp.subtasks.findIndex((s) => s.id === event.id)
      if (existingIdx >= 0) {
        const existing = grp.subtasks[existingIdx]
        const updatedSubtasks = grp.subtasks.map((s, idx) =>
          idx === existingIdx
            ? {
                ...existing,
                type: subtask.type,
                label: subtask.label || existing.label,
                query: subtask.query ?? existing.query,
                url: subtask.url ?? existing.url,
                command: subtask.command ?? existing.command,
                filePath: subtask.filePath ?? existing.filePath,
                labelSource: subtask.labelSource || existing.labelSource,
                status: existing.status === 'done' ? 'done' as const : 'running' as const,
                startedAt: existing.startedAt || subtask.startedAt,
              }
            : s
        )
        this.parsedGroups[this.currentGroupIdx] = { ...grp, subtasks: updatedSubtasks }
        this.actions.setTaskGroups(this.conversationId, [...this.parsedGroups])
      } else {
        const closedSubtasks = grp.subtasks.map((s) =>
          s.status === 'running' ? { ...s, status: 'done' as const } : s
        )
        this.parsedGroups[this.currentGroupIdx] = { ...grp, subtasks: [...closedSubtasks, subtask] }
        this.actions.setTaskGroups(this.conversationId, [...this.parsedGroups])
      }
      if (isComputerPanelTool(event.name)) {
        this.actions.setComputerPanelOpen(true, { source: 'auto' })
      }

      if ((event.name === 'create_file' || event.name === 'append_file' || event.name === 'edit_file') && event.args.path) {
        this.webIde.handleFileContentStart(
          event.id,
          event.args.path as string,
          event.name,
          this.conversationId,
          this.actions.upsertComputerPanelItem,
          () => this.actions.setComputerPanelOpen(true, { source: 'auto' }),
        )
      }

      // Streaming previews for specific tools — use event.id so handleToolResult can upsert over them
      if ((event.name === 'create_file' || event.name === 'append_file' || event.name === 'edit_file') && (event.args.content || event.args.new_string)) {
        const filePath = event.args.path as string || ''
        const fileName = filePath.split('/').pop() || 'file'
        const fileContent = String(event.name === 'edit_file' ? event.args.new_string : event.args.content)
        const isAppend = event.name === 'append_file'
        const isEdit = event.name === 'edit_file'
        const action = isEdit ? 'edited' as const : isAppend ? 'appended' as const : 'created' as const
        const titleVerb = isEdit ? 'Editing' : isAppend ? 'Appending' : 'Writing'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `${titleVerb}: ${fileName}`,
          data: { action, path: filePath, content: fileContent.slice(0, 5000) } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      if (event.name === 'export_pdf') {
        const filePath = (event.args.output_path || event.args.source_path || 'document.pdf') as string
        const fileName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '.pdf') || 'document.pdf'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Exporting: ${fileName}`,
          data: { action: 'exported' as const, path: filePath, content: '' } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      if (event.name === 'web_search') {
        const query = concisePanelSubject(event.args.query)
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'search',
          title: query ? `Searching: ${query}` : 'Search in progress',
          data: [] as SearchResult[],
          timestamp: Date.now(),
          streaming: true,
        })
      }

      if (event.name === 'image_search') {
        const query = concisePanelSubject(event.args.query)
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'image_search',
          title: query ? `Searching images: ${query}` : 'Image lookup in progress',
          data: [] as ImageSearchPanelItem[],
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // edit_file — show which file is being edited
      if (event.name === 'edit_file') {
        const filePath = (event.args.path as string) || ''
        const fileName = filePath.split('/').pop() || 'file'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Editing: ${fileName}`,
          data: { action: 'edited' as const, path: filePath, content: '' } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      if (event.name === 'append_file') {
        const filePath = (event.args.path as string) || ''
        const fileName = filePath.split('/').pop() || 'file'
        const fileContent = String(event.args.content || '')
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Appending: ${fileName}`,
          data: { action: 'appended' as const, path: filePath, content: fileContent.slice(0, 5000) } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // read_file
      if (event.name === 'read_file') {
        const filePath = (event.args.path as string) || ''
        const fileName = filePath.split('/').pop() || 'file'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Reading: ${fileName}`,
          data: { action: 'read' as const, path: filePath, content: '' } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // read_skill
      if (event.name === 'read_skill') {
        const skillName = (event.args.name as string) || (event.args.path as string) || 'selected skill'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Reading skill: ${skillName}`,
          data: { action: 'read' as const, path: `${skillName}.skill`, content: '' } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // delete_file
      if (event.name === 'delete_file') {
        const filePath = (event.args.path as string) || ''
        const fileName = filePath.split('/').pop() || 'file'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Deleting: ${fileName}`,
          data: { action: 'deleted' as const, path: filePath } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // list_files
      if (event.name === 'list_files') {
        const dirPath = (event.args.path as string) || '.'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'file',
          title: `Listing: ${dirPath}`,
          data: { action: 'listed' as const, path: dirPath, files: [] } as FileResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // execute_command — streaming preview (terminal_output events will update the _live item)
      if (event.name === 'execute_command') {
        const cmd = (event.args.command as string) || ''
        const shortCmd = cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id + '_live',
          type: 'terminal',
          title: 'Terminal',
          data: { command: shortCmd, stdout: '', stderr: '', exitCode: -1, durationMs: 0, timedOut: false } as TerminalResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // run_code — streaming preview
      if (event.name === 'run_code') {
        const lang = (event.args.language as string) || 'code'
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id + '_live',
          type: 'terminal',
          title: 'Code Output',
          data: { command: `[${lang}]`, stdout: '', stderr: '', exitCode: -1, durationMs: 0, timedOut: false } as TerminalResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // youtube_transcript
      if (event.name === 'youtube_transcript') {
        const url = (event.args.url as string) || ''
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'browse',
          title: 'Loading transcript...',
          data: { title: 'YouTube Transcript', content: '', url } as BrowseResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // read_document
      if (event.name === 'read_document') {
        const source = (event.args.url as string) || (event.args.source as string) || ''
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'browse',
          title: 'Reading document...',
          data: { title: 'Document', content: '', url: source } as BrowseResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      // http_request
      if (event.name === 'http_request') {
        const url = (event.args.url as string) || ''
        let domain = url
        try { domain = new URL(url).hostname } catch { /* use raw */ }
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: event.id,
          type: 'browse',
          title: `Fetching ${domain}...`,
          data: { title: domain, content: '', url } as BrowseResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }

      if (BROWSER_TOOLS.includes(event.name)) {
        const bUrl = (event.args.url as string) || ''
        const existingItems = useChatStore.getState().conversations
          .find(c => c.id === this.conversationId)?.messages.slice(-1)[0]?.computerPanelData
        const prev = existingItems?.find(i => i.id === 'browser_live')?.data as BrowserResult | undefined
        this.actions.upsertComputerPanelItem(this.conversationId, {
          id: 'browser_live',
          type: 'browser',
          title: 'Browser',
          data: {
            success: true,
            url: bUrl || prev?.url || '',
            title: prev?.title || '',
            screenshotBase64: prev?.screenshotBase64,
            liveFrame: prev?.liveFrame,
            liveFrameUpdatedAt: prev?.liveFrameUpdatedAt,
            action: visibleActionLabel,
          } as BrowserResult,
          timestamp: Date.now(),
          streaming: true,
        })
      }
    }
  }

  private handleToolResult(event: { id: string; name: string; result: unknown }): void {
    // Tool results can arrive in the same frame as the final file_content_delta.
    // Flush queued Web IDE deltas before clearing streaming state, otherwise the
    // live editor can visibly drop the tail of a generated file.
    this.batch.flushSync()

    const deferredStart = this.deferredBrowseToolStarts.get(event.id)
    if (deferredStart) this.deferredBrowseToolStarts.delete(event.id)
    const startedEvent = deferredStart || this.toolStartsById.get(event.id)

    if (isHiddenInternalToolResult(event.name, event.result)) {
      this.actions.removeComputerPanelItem(this.conversationId, panelFocusIdForTool(event.name, event.id))
      this.removeHiddenTool(event.id)
      this.setThinkingIfNoVisibleActionRunning()
      return
    }

    this.chargeToolEvent(event.id, event.name, event.result)

    const isBrowserPreflightBlock = isBrowserTool(event.name) && isBrowserPreflightBlockResult(event.result)
    let panelItem = mapToolResultToPanel(
      event as { id: string; name: string; result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult },
      this.conversationId,
    )
    const existingItems = useChatStore.getState().conversations
      .find(c => c.id === this.conversationId)?.messages.slice(-1)[0]?.computerPanelData
    const previousPanelItem = existingItems?.find(i => i.id === panelFocusIdForTool(event.name, event.id))
    const searchTitle = completedSearchPanelTitle(event.name, previousPanelItem?.title)
    if (searchTitle) {
      panelItem = { ...panelItem, title: searchTitle }
    }
    if ((event.name === 'http_request' || event.name === 'read_document') && previousPanelItem?.type === 'browse') {
      const previousBrowse = previousPanelItem.data as BrowseResult | undefined
      const nextBrowse = panelItem.data as BrowseResult | undefined
      if (nextBrowse && typeof nextBrowse === 'object' && previousBrowse?.url && !nextBrowse.url) {
        panelItem = {
          ...panelItem,
          data: {
            ...nextBrowse,
            url: previousBrowse.url,
          } satisfies BrowseResult,
        }
      }
    }
    const effectiveResult = this.withPreservedFilePanelContent(event, panelItem.data)
    if (effectiveResult !== event.result) {
      panelItem = {
        ...panelItem,
        data: effectiveResult as SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult,
      }
    }

    if (isBrowserTool(event.name)) {
      if (!isBrowserPreflightBlock) {
        useUIStore.getState().setComputerActiveTab('activity')
      }
      const previousBrowser = existingItems?.find(i => i.id === 'browser_live')?.data as BrowserResult | undefined
      const data = isBrowserPreflightBlock
        ? browserPanelDataForPreflightBlock(panelItem.data as BrowserResult)
        : panelItem.data
      this.actions.upsertComputerPanelItem(this.conversationId, {
        ...panelItem,
        id: 'browser_live',
        data: stableBrowserPanelData(data as BrowserResult, previousBrowser),
      })
    } else if (this.terminalAccum[event.id + '_live']) {
      // Terminal tools: update the existing _live item with final result (no duplicate)
      this.actions.upsertComputerPanelItem(this.conversationId, { ...panelItem, id: event.id + '_live' })
    } else {
      // Upsert so streaming placeholders (created in handleToolStart with same event.id) get replaced
      this.actions.upsertComputerPanelItem(this.conversationId, panelItem)
    }
    if (!isBrowserPreflightBlock) {
      if (isComputerPanelTool(event.name)) {
        const uiState = useUIStore.getState()
        uiState.setComputerActiveTab('activity')
        uiState.setComputerPanelActiveItemId(panelFocusIdForTool(event.name, event.id))
      }
      this.actions.setComputerPanelOpen(true, { source: 'auto' })
    }

    // WebIDE handling
    this.webIde.handleToolResult(event.id, event.name, event.result)
    this.webIde.deleteAccum(event.id)
    delete this.terminalAccum[event.id + '_live']

    // TaskGroup: update subtask
    if (this.currentGroupIdx >= 0) {
      // Update local cache immutably to stay in sync with store
      const group = this.parsedGroups[this.currentGroupIdx]
      if (group) {
        const existingSubtask = group.subtasks.find(s => s.id === event.id)
        const deferredLabel = startedEvent
          ? (strictActionLabelFromArgs(startedEvent.args) || runtimeVisibleActionLabel(event.name, startedEvent.args))
          : runtimeVisibleActionLabel(event.name, {}, panelItem.title)

        let updatedSubtasks = group.subtasks
        if (existingSubtask) {
          this.actions.updateSubtaskInGroup(this.conversationId, this.currentGroupIdx, event.id, 'done', effectiveResult as Subtask['result'])
          updatedSubtasks = group.subtasks.map(s =>
            s.id === event.id ? { ...s, status: 'done' as const, result: effectiveResult as Subtask['result'] } : s
          )
        } else if (deferredLabel) {
          const subtask: Subtask = {
            id: event.id,
            toolName: event.name,
            type: (toolNameToSubtaskType[event.name] || 'browse') as SubtaskType,
            label: deferredLabel,
            query: startedEvent?.args.query as string | undefined,
            url: (startedEvent?.args.url || startedEvent?.args.source) as string | undefined,
            command: startedEvent?.args.command as string | undefined,
            filePath: (startedEvent?.args.path || startedEvent?.args.output_path || startedEvent?.args.source_path || startedEvent?.args.directory) as string | undefined,
            labelSource: startedEvent && strictActionLabelFromArgs(startedEvent.args) ? 'model' : 'system',
            status: 'done',
            startedAt: Date.now(),
            result: effectiveResult as Subtask['result'],
          }
          updatedSubtasks = [
            ...group.subtasks.map((s) => s.status === 'running' ? { ...s, status: 'done' as const } : s),
            subtask,
          ]
          this.actions.setTaskGroups(this.conversationId, [
            ...this.parsedGroups.slice(0, this.currentGroupIdx),
            { ...group, subtasks: updatedSubtasks },
            ...this.parsedGroups.slice(this.currentGroupIdx + 1),
          ])
        }
        this.parsedGroups[this.currentGroupIdx] = { ...group, subtasks: updatedSubtasks }
      }

      const updatedGroup = this.parsedGroups[this.currentGroupIdx]
      if (updatedGroup) {
        this.recordNarrationOpportunity({ ...event, result: effectiveResult })
      }
    }

    // A completed visible tool hands control back to the model. Keep the UI in
    // Thinking until the next visible event starts: tool_start, text, done, or error.
    this.toolStartsById.delete(event.id)
    this.setThinkingIfNoVisibleActionRunning()
  }

  private removeHiddenTool(eventId: string): void {
    this.toolStartsById.delete(eventId)
    if (this.currentGroupIdx < 0) return
    const group = this.parsedGroups[this.currentGroupIdx]
    if (!group) return
    const existing = group.subtasks.find((subtask) => subtask.id === eventId)
    if (!existing) return

    const updatedSubtasks = group.subtasks.filter((subtask) => subtask.id !== eventId)
    this.parsedGroups[this.currentGroupIdx] = { ...group, subtasks: updatedSubtasks }
    this.actions.setTaskGroups(this.conversationId, [...this.parsedGroups])
  }

  private withPreservedFilePanelContent(
    event: { id: string; name: string; result: unknown },
    mappedData: unknown,
  ): unknown {
    if (!['create_file', 'append_file', 'edit_file'].includes(event.name)) return event.result

    const result = (mappedData || event.result) as FileResult | undefined
    if (!result || typeof result !== 'object' || !result.path) return event.result
    if (typeof result.content === 'string' && result.content.length > 0) return result

    const knownContent = this.findKnownFileContent(event.id, result.path)
    if (knownContent === undefined) return result

    return {
      ...result,
      content: knownContent,
    } satisfies FileResult
  }

  private findKnownFileContent(eventId: string, filePath: string): string | undefined {
    const conversation = useChatStore.getState().conversations.find(c => c.id === this.conversationId)
    const assistantMessages = conversation?.messages.filter(m => m.role === 'assistant') || []

    for (let mi = assistantMessages.length - 1; mi >= 0; mi--) {
      const message = assistantMessages[mi]
      const panelItems = message.computerPanelData || []
      const exactPanelItem = [...panelItems].reverse().find(item => item.id === eventId && item.type === 'file')
      const exactData = exactPanelItem?.data as FileResult | undefined
      if (exactData?.path === filePath && typeof exactData.content === 'string') return exactData.content

      for (let ii = panelItems.length - 1; ii >= 0; ii--) {
        const item = panelItems[ii]
        if (item.type !== 'file') continue
        const data = item.data as FileResult | undefined
        if (data?.path === filePath && typeof data.content === 'string') return data.content
      }

      const artifacts = message.artifacts || []
      for (let ai = artifacts.length - 1; ai >= 0; ai--) {
        const artifact = artifacts[ai]
        if (artifact.filePath === filePath && typeof artifact.content === 'string') return artifact.content
      }
    }

    return undefined
  }

  private recordNarrationOpportunity(event: { name: string; result: unknown }): void {
    if (this.currentGroupIdx < 0 || !this.isNarrationFlushTool(event.name)) return

    this.pendingNarrationTools.push({ toolName: event.name, result: event.result })
    this.toolsSinceLastNarration++
    if (this.pendingNarrationTools.length > 8) {
      this.pendingNarrationTools = this.pendingNarrationTools.slice(-8)
    }

    if (this.toolsSinceLastNarration >= TOOLS_BETWEEN_NARRATION_FLUSHES) {
      const emittedModelNarration = this.flushNarration()
      if (emittedModelNarration) {
        this.pendingNarrationTools = []
      }
    }
  }

  private isNarrationFlushTool(toolName: string): boolean {
    return toolName !== 'browser_screenshot' && toolName !== 'browser_resize'
  }

  private clearPendingNarrationTools(force = false): boolean {
    if (this.currentGroupIdx < 0 || this.pendingNarrationTools.length === 0) return false
    if (!force && this.pendingNarrationTools.length < TOOLS_BETWEEN_NARRATION_FLUSHES) return false
    this.pendingNarrationTools = []
    return false
  }

  private handleTerminalOutput(event: { id: string; stream: 'stdout' | 'stderr'; data: string }): void {
    const liveKey = event.id + '_live'
    if (!this.terminalAccum[liveKey]) {
      this.terminalAccum[liveKey] = { command: '', stdout: '', stderr: '', exitCode: -1, durationMs: 0, timedOut: false }
    }
    if (event.stream === 'stdout') {
      this.terminalAccum[liveKey].stdout += event.data
      this.terminalAccum[liveKey].stdout = capStr(this.terminalAccum[liveKey].stdout, MAX_TERMINAL_STDOUT)
    } else {
      this.terminalAccum[liveKey].stderr += event.data
      this.terminalAccum[liveKey].stderr = capStr(this.terminalAccum[liveKey].stderr, MAX_TERMINAL_STDERR)
    }

    // Batch both updates into a single frame instead of 2 immediate store writes
    this.batch.schedule(`terminal_${event.id}`, () => {
      if (this.currentGroupIdx >= 0) {
        const group = this.parsedGroups[this.currentGroupIdx]
        if (group?.subtasks.find(s => s.id === event.id && s.status === 'running')) {
          this.actions.updateSubtaskInGroup(this.conversationId, this.currentGroupIdx, event.id, 'running', { ...this.terminalAccum[liveKey] })
        }
      }

      this.actions.upsertComputerPanelItem(this.conversationId, {
        id: liveKey,
        type: 'terminal',
        title: 'Terminal',
        data: { ...this.terminalAccum[liveKey] },
        timestamp: Date.now(),
        streaming: true,
      })
    })
  }

  private handleStepAdvance(event: { status?: 'done' | 'incomplete'; reason?: string }): void {
    if (this.flushNarration(true)) this.pendingNarrationTools = []
    else {
      this.discardNarrationBuffer()
      if (event.status === 'incomplete') this.clearPendingNarrationTools(true)
    }

    if (event.status === 'incomplete') {
      const message = userErrorMessage(event.reason, 'Current task step did not complete. Later steps were not started.')
      this.markRunningGroups('error', message)
      this.setStreamError(message)
      this.actions.addToast(message, 'error')
      playError()
      return
    }

    const status = 'done'
    if (this.currentGroupIdx >= 0 && this.currentGroupIdx < this.parsedGroups.length) {
      this.parsedGroups[this.currentGroupIdx] = { ...this.parsedGroups[this.currentGroupIdx], status }
      this.actions.updateTaskGroupStatus(this.conversationId, this.currentGroupIdx, status)
      if (this.currentGroupIdx + 1 < this.parsedGroups.length) {
        this.currentGroupIdx++
        this.parsedGroups[this.currentGroupIdx] = { ...this.parsedGroups[this.currentGroupIdx], status: 'running', startedAt: Date.now() }
        this.actions.updateTaskGroupStatus(this.conversationId, this.currentGroupIdx, 'running')
      }
    }
    this.setThinkingIfNoVisibleActionRunning()
  }

  private handleError(message: unknown): void {
    const safeMessage = userErrorMessage(message, 'The task stopped before it finished. Please try again.')
    if (isCreditCutoffMessage(safeMessage)) {
      void useCreditStore.getState().syncFromServer({ force: true })
    }
    this.batch.flushSync()  // Flush batched updates before error handling
    this.webIde.cleanup()
    if (this.flushNarration()) this.pendingNarrationTools = []
    else {
      this.discardNarrationBuffer()
      this.clearPendingNarrationTools(true)
    }
    this.markRunningGroups('error', safeMessage)
    this.terminalAccum = {}
    this.setStreamError(safeMessage)
    this.actions.addToast(safeMessage, 'error')
    playError()
  }

  private markRunningGroups(status: 'done' | 'error', errorMessage?: string): void {
    let changed = false
    this.deferredBrowseToolStarts.clear()
    this.toolStartsById.clear()
    for (let gi = 0; gi < this.parsedGroups.length; gi++) {
      const group = this.parsedGroups[gi]
      if (group.status === 'running') {
        const subtasks = group.subtasks.map((subtask) =>
          subtask.status === 'running'
            ? { ...subtask, status, ...(status === 'error' ? { errorMessage } : {}) }
            : subtask
        )
        this.parsedGroups[gi] = { ...group, status, subtasks }
        changed = true
      }
    }
    if (changed) this.actions.setTaskGroups(this.conversationId, [...this.parsedGroups])
  }

  private chargeToolEvent(id: string, name: string, result?: unknown): void {
    if (SERVER_CREDIT_ACCOUNTING) return
    if (this.chargedToolIds.has(id) || isInternalActivityTool(name)) return
    if (result !== undefined && this.isNonBillablePreflightResult(result)) return
    this.chargedToolIds.add(id)
    useCreditStore.getState().chargeTool(this.conversationId, name)
  }

  private isNonBillablePreflightResult(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false
    const error = (result as { error?: unknown }).error
    if (typeof error !== 'string') return false

    return /^(?:BLOCKED:|BROWSER_ACTION_PREFLIGHT_BLOCKED|INTERNAL_RECOVERY:|Tool ".+" is temporarily disabled|Search is permanently disabled|You've used ".+" \d+ times this step|A file with a very similar name|".+" already (?:exists|has a recovered partial write)|browser_click_at requires|browser_fill_form requires|browser_select requires|browser_type requires)/.test(error)
  }

  private handleDone(usage?: CreditTokenUsage): void {
    this.batch.flushSync()  // Flush batched updates before completion
    if (usage && !SERVER_CREDIT_ACCOUNTING) {
      useCreditStore.getState().chargeTokens(this.conversationId, usage)
    }
    this.webIde.cleanup()
    if (this.flushNarration()) this.pendingNarrationTools = []
    else {
      this.discardNarrationBuffer()
      this.clearPendingNarrationTools(true)
    }
    this.terminalAccum = {}

    this.markRunningGroups('done')

    if (this.groupsActive) {
      // Build a clean programmatic summary from task metadata.
      // Only collect created files from the LAST task group (the deliverable step).
      // Earlier groups are research steps — any files there are intermediate notes,
      // not deliverables, and should not appear in the final UI.
      const createdFiles: string[] = []
      let sourceCount = 0
      const lastGroupIdx = this.parsedGroups.length - 1
      for (let gi = 0; gi < this.parsedGroups.length; gi++) {
        const g = this.parsedGroups[gi]
        for (const s of g.subtasks) {
          if (gi === lastGroupIdx && (s.type === 'create_file' || s.type === 'append_file' || s.type === 'export_pdf') && s.status === 'done') {
            const match = s.label?.match(/(?:Writing|Appending to|Appending|Exporting)[:\s]+(.+?)(?:\s+\(\d+\s+lines?\))?$/i)
            if (match) createdFiles.push(match[1])
            else if (s.filePath) createdFiles.push(s.filePath.split('/').pop() || s.filePath)
          }
          if ((s.type === 'search' || s.type === 'browse') && s.status === 'done') {
            sourceCount++
          }
        }
      }
      const uniqueFiles = [...new Set(createdFiles)]

      // Get the current message content and extract the durable startup ACK.
      // Some providers insert blank lines inside the acknowledgement while
      // streaming, so do not truncate at the first paragraph boundary.
      const conv = useChatStore.getState().conversations.find(c => c.id === this.conversationId)
      const lastMsg = conv?.messages ? [...conv.messages].reverse().find(m => m.role === 'assistant') : null
      const currentContent = lastMsg?.content || ''
      const currentAck = this.cleanAcknowledgmentCandidate(currentContent)
      const ack = selectBestStartupAcknowledgment(this.startupAcknowledgment, currentAck)

      // Build a short natural fallback only when the model did not provide
      // a useful final answer. Artifact cards already show deliverables.
      let summary = ''
      if (uniqueFiles.length > 0) {
        // Extract topic context from the deliverable group title (last group with a create_file)
        let topicHint = ''
        for (let i = this.parsedGroups.length - 1; i >= 0; i--) {
          const g = this.parsedGroups[i]
          if (g.subtasks.some(s => s.type === 'create_file' || s.type === 'append_file' || s.type === 'export_pdf')) {
            // Strip leading verbs like "Write a...", "Create a...", "Compile a..."
            const cleaned = g.title
              .replace(/^(?:write|create|compile|generate|produce|build|draft|prepare)\s+(?:a\s+)?(?:comprehensive\s+|detailed\s+|concise\s+|quick\s+|brief\s+)?(?:markdown\s+)?(?:report|document|file|analysis|summary)\s*/i, '')
              .replace(/^(?:covering|summarizing|about|on|detailing|outlining)\s*/i, '')
              .trim()
            if (cleaned.length > 10) {
              topicHint = cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
              // Trim trailing ellipsis from truncated titles
              topicHint = topicHint.replace(/\.{2,}$/, '')
              if (topicHint.length > 150) topicHint = topicHint.slice(0, 150).replace(/,?\s+\S*$/, '')
            }
            break
          }
        }

        const fileSentence = uniqueFiles.length === 1
          ? `The completed file, \`${uniqueFiles[0]}\`, is attached below.`
          : `The completed files are attached below: ${uniqueFiles.map(fileName => `\`${fileName}\``).join(', ')}.`

        const summaryLines = [
          topicHint
            ? `Here’s the completed ${topicHint}.`
            : 'Here’s the completed deliverable.',
          sourceCount > 0
            ? `I grounded it with ${sourceCount} completed search/browse ${sourceCount === 1 ? 'check' : 'checks'}.`
            : null,
          fileSentence,
        ].filter((line): line is string => line !== null)

        summary = summaryLines.join('\n\n')
      }

      const postToolAnswer = normalizeMarkdownForDisplay(stripToolActionNarration(cleanThinkingTags(this.postLastToolText)))
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const suppressDuplicateReportText = looksLikeDuplicatedSavedReport(postToolAnswer, uniqueFiles.length)

      // Set content cleanly: ACK + model synthesis when available; use the
      // generated handoff only as a fallback for file-deliverable tasks.
      let finalContent = ack
      if (postToolAnswer && postToolAnswer !== ack && !suppressDuplicateReportText) {
        finalContent = ack ? `${ack}\n\n${postToolAnswer}` : postToolAnswer
      } else if (summary) {
        finalContent = ack ? `${ack}\n\n${summary}` : summary
      }
      const cleanedExistingContent = normalizeMarkdownForDisplay(cleanThinkingTags(currentContent)).trim()
      if (finalContent.trim()) {
        this.actions.setLastMessageContent(this.conversationId, finalContent)
      } else if (cleanedExistingContent) {
        this.actions.setLastMessageContent(this.conversationId, cleanedExistingContent)
      }

      // Ensure document artifacts exist for created files.
      // The server emits artifact_created, but as a safety net, verify they're on the message.
      const currentArtifacts = lastMsg?.artifacts || []
      for (const fileName of uniqueFiles) {
        const alreadyExists = currentArtifacts.some(a => a.fileName === fileName)
        if (!alreadyExists) {
          // Find the computer panel item with the file content
          const panelItems = lastMsg?.computerPanelData || []
          const panelFile = panelItems.find(p => p.type === 'file' && p.title?.includes(fileName))
          const fileData = panelFile?.data as { path?: string; content?: string } | undefined
          this.actions.addArtifact(this.conversationId, {
            id: `artifact_done_${Date.now()}_${fileName}`,
            fileName,
            filePath: fileData?.path || fileName,
            content: fileData?.content || '',
            type: 'document',
            deliverable: true,
            purpose: 'deliverable',
            createdAt: Date.now(),
          })
        }
      }
    }

    playComplete()
    if (typeof document !== 'undefined' && !document.hasFocus()) {
      const settings = useSettingsStore.getState()
      if (settings.desktopNotifications) {
        sendDesktopNotification('Agent', 'Your response is ready')
      }
    }
  }

  private handleCreditEvent(entry: CreditLedgerEvent): void {
    useCreditStore.getState().applyServerCreditEvent(entry)
  }

  private normalizeNarrationText(text: string, maxSentences = 2): string | null {
    return sanitizeNarrationText(text, { maxSentences, maxLength: 300 })
  }

  private lastNarrationPosition(group: TaskGroup): number {
    return group.narrations.reduce((max, narration) => Math.max(max, narration.position), 0)
  }

  private narrationInsertionPosition(group: TaskGroup, force = false): number | null {
    if (force) return group.subtasks.length
    const lastPosition = this.lastNarrationPosition(group)
    const visibleGap = group.subtasks.length - lastPosition
    if (visibleGap < MIN_TOOLS_BETWEEN_NARRATION_FLUSHES) return null
    // Even if the backend had to recover from a missed narration window, keep
    // the update at the current frontier. Never insert it between completed
    // tool pills.
    if (visibleGap > MAX_TOOLS_BETWEEN_NARRATION_FLUSHES) return group.subtasks.length
    return group.subtasks.length
  }

  private addNarration(narrationText: string, force = false): boolean {
    if (this.currentGroupIdx < 0) return false
    const currentGroup = this.parsedGroups[this.currentGroupIdx]
    if (!currentGroup) return false
    const currentPosition = this.narrationInsertionPosition(currentGroup, force)
    if (currentPosition === null) return false

    if (currentGroup.narrations.some(narration => narration.position === currentPosition)) {
      return false
    }

    const dedupeKey = narrationText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const lastKey = this.lastNarrationText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (dedupeKey && dedupeKey === lastKey) return false

    this.lastNarrationText = narrationText
    this.pendingNarrationTools = []
    this.actions.addGroupNarration(this.conversationId, this.currentGroupIdx, narrationText, currentPosition)
    this.parsedGroups[this.currentGroupIdx] = {
      ...currentGroup,
      narrations: [...currentGroup.narrations, {
        id: 'local_' + Date.now(),
        text: narrationText,
        position: currentPosition,
      }],
    }
    this.toolsSinceLastNarration = Math.max(0, currentGroup.subtasks.length - currentPosition)
    return true
  }

  private flushNarration(force = false): boolean {
    if (!force && !this.isNarrationCadenceReady()) return false
    const text = this.narrationBuf.flush()
    if (!text || this.currentGroupIdx < 0) return false
    const narrationText = this.normalizeNarrationText(text)
    return narrationText ? this.addNarration(narrationText, force) : false
  }

  private discardNarrationBuffer(): void {
    if (this.narrationBuf.length > 0) this.narrationBuf.flush()
  }

  private isNarrationCadenceReady(): boolean {
    if (this.currentGroupIdx < 0) return false
    const currentGroup = this.parsedGroups[this.currentGroupIdx]
    if (!currentGroup) return false
    return this.narrationInsertionPosition(currentGroup) !== null
  }

  /** Mark all running groups and clean up on abort/error */
  finalizeOnAbort(status: 'done' | 'error' | 'stopped' = 'stopped', message?: unknown): void {
    this.terminalStatus = status
    const safeMessage = message ? userErrorMessage(message, 'The task stopped before it finished. Please try again.') : undefined
    if (status === 'error' && safeMessage) this.terminalErrorMessage = safeMessage
    this.batch.flushSync()  // Flush batched updates before abort
    this.webIde.cleanup()
    if (this.flushNarration()) this.pendingNarrationTools = []
    else {
      this.discardNarrationBuffer()
      this.clearPendingNarrationTools(true)
    }
    this.markRunningGroups(status === 'done' ? 'done' : 'error', safeMessage)
    this.terminalAccum = {}
  }
}
