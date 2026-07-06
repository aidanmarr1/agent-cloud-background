'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'
import { useSettingsStore } from '@/store/settings'
import type { TaskStep, ComputerPanelItem, FileAttachment } from '@/types'
import { playSend } from '@/lib/useSound'
import { parseSSEStream } from './SSEParser'
import { EventDispatcher } from './eventDispatcher'
import { useCreditStore } from '@/store/credits'
import { OUT_OF_CREDITS_CODE, OUT_OF_CREDITS_MESSAGE } from '@/lib/creditPolicy'
import { isContextualTaskUpdateText } from '@/lib/conversationContext'
import { bindAttachmentsToTask } from '@/lib/attachmentUpload'
import { clampTaskInput, taskInputLimitMessage } from '@/lib/inputLimits'
import { userErrorMessage } from '@/lib/errorMessages'

export interface UseAgentStreamReturn {
  sendMessage: (content: string, isAutoSendOrAttachments?: boolean | FileAttachment[]) => Promise<void>
  handleStop: () => void
  resumeActiveTask: (options?: { includeTerminalReplay?: boolean }) => Promise<boolean>
  streamError: string | null
  clearError: () => void
}

const activeControllers = new Map<string, AbortController>()
const activeRunIds = new Map<string, string>()
const ACTIVE_RUNS_STORAGE_KEY = 'agent-active-task-runs'

interface ActiveRunRecord {
  runId: string
  conversationId: string
  lastSeq: number
  startedAt: number
  assistantMessageId?: string
}

interface ActiveTaskResponse {
  active?: boolean
  runId?: unknown
  conversationId?: unknown
  startedAt?: unknown
}

function readActiveRunMap(): Record<string, ActiveRunRecord> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ACTIVE_RUNS_STORAGE_KEY) || '{}') as Record<string, ActiveRunRecord>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeActiveRunMap(records: Record<string, ActiveRunRecord>): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(records))
}

function getStoredActiveRun(conversationId: string): ActiveRunRecord | null {
  const runId = activeRunIds.get(conversationId)
  const records = readActiveRunMap()
  const record = records[conversationId]
  if (runId && (!record || record.runId !== runId)) {
    return {
      runId,
      conversationId,
      lastSeq: 0,
      startedAt: Date.now(),
    }
  }
  return record?.runId ? record : null
}

function saveStoredActiveRun(conversationId: string, patch: Partial<ActiveRunRecord> & { runId: string }): void {
  activeRunIds.set(conversationId, patch.runId)
  const records = readActiveRunMap()
  const previous = records[conversationId]
  records[conversationId] = {
    conversationId,
    lastSeq: previous?.lastSeq ?? 0,
    startedAt: previous?.startedAt ?? Date.now(),
    assistantMessageId: previous?.assistantMessageId,
    ...patch,
  }
  writeActiveRunMap(records)
}

function clearStoredActiveRun(conversationId: string, runId?: string): void {
  const current = getStoredActiveRun(conversationId)
  if (runId && current?.runId && current.runId !== runId) return
  activeRunIds.delete(conversationId)
  const records = readActiveRunMap()
  delete records[conversationId]
  writeActiveRunMap(records)
}

async function fetchServerActiveRun(
  conversationId: string,
  options: { includeTerminalReplay?: boolean } = {},
): Promise<ActiveRunRecord | null> {
  try {
    const query = new URLSearchParams({ conversationId })
    if (options.includeTerminalReplay) query.set('includeTerminalReplay', '1')
    const response = await fetch(`/api/chat/active?${query.toString()}`)
    if (!response.ok) return null
    const data = await response.json().catch(() => null) as ActiveTaskResponse | null
    if (
      !data?.active ||
      typeof data.runId !== 'string' ||
      typeof data.conversationId !== 'string' ||
      data.conversationId !== conversationId
    ) {
      return null
    }

    const startedAt = typeof data.startedAt === 'number' && Number.isFinite(data.startedAt)
      ? data.startedAt
      : Date.now()
    const record: ActiveRunRecord = {
      runId: data.runId,
      conversationId,
      lastSeq: 0,
      startedAt,
    }
    saveStoredActiveRun(conversationId, record)
    return record
  } catch {
    return null
  }
}

function lastAssistantHasVisibleResponse(conversationId: string): boolean {
  const latest = useChatStore.getState().conversations
    .find(c => c.id === conversationId)
    ?.messages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant')
  return !!(
    latest?.content?.trim() ||
    latest?.taskGroups?.length ||
    latest?.steps?.length ||
    latest?.computerPanelData?.length ||
    latest?.artifacts?.length
  )
}

function markActiveAssistantInterrupted(conversationId: string, label: string): void {
  useChatStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      const messages = [...conversation.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role !== 'assistant') continue
        const alreadyMarked = message.content.includes(label)
        messages[i] = {
          ...message,
          content: alreadyMarked ? message.content : `${message.content}${message.content.trim() ? '\n\n' : ''}${label}`,
          taskGroups: message.taskGroups?.map((group) => ({
            ...group,
            status: group.status === 'running' ? 'incomplete' : group.status,
            subtasks: group.subtasks.map((subtask) => (
              subtask.status === 'running'
                ? { ...subtask, status: 'error', errorMessage: 'Interrupted by a newer user message.' }
                : subtask
            )),
          })),
          steps: message.steps?.map((step) => (
            step.status === 'running' ? { ...step, status: 'incomplete' } : step
          )),
        }
        break
      }
      return { ...conversation, messages, updatedAt: Date.now() }
    }),
  }))
}

export function hasActiveAgentStream(conversationId: string): boolean {
  return activeControllers.has(conversationId)
}

function createStoreDispatcher(conversationId: string, setStreamError: (message: string | null) => void): EventDispatcher {
  const chat = useChatStore.getState()
  const ui = useUIStore.getState()
  return new EventDispatcher(conversationId, {
    appendToLastMessage: chat.appendToLastMessage,
    appendReasoning: chat.appendReasoning,
    setSteps: chat.setSteps,
    setTaskGroups: chat.setTaskGroups,
    updateTaskGroupStatus: chat.updateTaskGroupStatus,
    addSubtaskToGroup: chat.addSubtaskToGroup,
    updateSubtaskInGroup: chat.updateSubtaskInGroup,
    addGroupNarration: chat.addGroupNarration,
    setLastMessageContent: chat.setLastMessageContent,
    setFollowUps: chat.setFollowUps,
    addArtifact: chat.addArtifact,
    addComputerPanelItem: chat.addComputerPanelItem,
    upsertComputerPanelItem: chat.upsertComputerPanelItem,
    removeComputerPanelItem: chat.removeComputerPanelItem,
    setComputerPanelOpen: ui.setComputerPanelOpen,
    addToast: ui.addToast,
  }, setStreamError)
}

async function generateTitleForConversation(conversationId: string): Promise<void> {
  const conv = useChatStore.getState().conversations.find(c => c.id === conversationId)
  if (!conv) return
  const userMsg = conv.messages.find(m => m.role === 'user')
  if (!userMsg) return
  const assistantMsg = conv.messages.find(m => m.role === 'assistant')

  try {
    const res = await fetch('/api/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        messages: [
          { role: 'user', content: userMsg.content },
          ...(assistantMsg?.content ? [{ role: 'assistant', content: assistantMsg.content }] : []),
        ],
      }),
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.title && data.title !== 'New task') {
      useChatStore.getState().updateTitle(conversationId, data.title)
    }
  } catch {
    // Title generation is non-critical.
  }
}

async function consumeTaskResponseForConversation(input: {
  conversationId: string
  response: Response
  controller: AbortController
  dispatcher: EventDispatcher
  runId?: string
  assistantMessageId?: string
  isFirstResponse?: boolean
  allowTerminalReplay?: boolean
  setStreamError: (message: string | null) => void
}): Promise<void> {
  const { conversationId, setStreamError } = input
  const addToast = useUIStore.getState().addToast
  let response = input.response
  let runId = input.runId || response.headers.get('x-agent-run-id') || undefined
  let allowTerminalReplay = input.allowTerminalReplay !== false
  if (runId) {
    saveStoredActiveRun(conversationId, {
      runId,
      assistantMessageId: input.assistantMessageId,
    })
  }

  let dispatchErrors = 0
  let highestDispatchedSeq = 0

  while (true) {
    const headerRunId = response.headers.get('x-agent-run-id') || undefined
    if (!runId && headerRunId) runId = headerRunId
    if (runId) {
      saveStoredActiveRun(conversationId, {
        runId,
        assistantMessageId: input.assistantMessageId,
      })
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('The task could not start. Please try again.')

    for await (const event of parseSSEStream(reader)) {
      if (!runId && typeof event.runId === 'string') {
        runId = event.runId
      }
      const seq = Number(event.seq)
      if (runId && Number.isFinite(seq) && seq > 0) {
        if (seq <= highestDispatchedSeq) continue
        highestDispatchedSeq = seq
        saveStoredActiveRun(conversationId, {
          runId,
          lastSeq: seq,
          assistantMessageId: input.assistantMessageId,
        })
      }
      try {
        input.dispatcher.dispatch(event)
        dispatchErrors = 0
      } catch (dispatchErr) {
        dispatchErrors++
        console.error('[useAgentStream] dispatch error:', event.type, dispatchErr)
        if (dispatchErrors === 5) {
          console.error('[useAgentStream] Repeated dispatch errors; keeping stream alive so the backend task can finish')
          addToast('Some live updates were missed, but the task is still running.', 'error')
        }
      }
      if (input.dispatcher.hasTerminalEvent()) break
    }

    if (input.dispatcher.hasTerminalEvent()) break

    const activeRun = runId ? getStoredActiveRun(conversationId) : null
    if (
      allowTerminalReplay &&
      activeRun &&
      activeRun.runId === runId &&
      input.controller.signal.reason !== 'user-stop'
    ) {
      allowTerminalReplay = false
      const query = new URLSearchParams({
        conversationId,
        runId: activeRun.runId,
        after: String(Math.max(highestDispatchedSeq, activeRun.lastSeq || 0)),
      })
      const replayResponse = await fetch(`/api/chat?${query.toString()}`, {
        method: 'GET',
        signal: input.controller.signal,
      })
      if (replayResponse.ok) {
        response = replayResponse
        continue
      }
    }
    break
  }

  if (!input.dispatcher.hasTerminalEvent()) {
    const activeRun = runId ? getStoredActiveRun(conversationId) : null
    if (activeRun?.runId === runId && input.controller.signal.reason !== 'user-stop') {
      setStreamError('Disconnected from the running task. Reopen this task to reconnect.')
      return
    }
    const msg = 'The task stopped before it finished. Please try again.'
    input.dispatcher.finalizeOnAbort('error', msg)
    setStreamError(msg)
    addToast(msg, 'error')
    return
  }

  if (runId) {
    clearStoredActiveRun(conversationId, runId)
  }

  const latest = useChatStore.getState().conversations
    .find(c => c.id === conversationId)
    ?.messages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant')
  const hasVisibleResponse = !!(
    latest?.content?.trim() ||
    latest?.taskGroups?.length ||
    latest?.steps?.length ||
    latest?.computerPanelData?.length ||
    latest?.artifacts?.length
  )
  if (!hasVisibleResponse) {
    const msg = input.dispatcher.getTerminalStatus() === 'error'
      ? userErrorMessage(input.dispatcher.getTerminalErrorMessage(), 'The task stopped before it finished. Please try again.')
      : 'The task stopped before it finished. Please try again.'
    input.dispatcher.finalizeOnAbort('error', msg)
    useChatStore.getState().setLastMessageContent(conversationId, msg)
    setStreamError(msg)
    addToast(msg, 'error')
  } else if (input.isFirstResponse) {
    void generateTitleForConversation(conversationId)
  }
}

export async function startInitialAgentTask(conversationId: string): Promise<void> {
  const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
  if (!conversation || activeControllers.has(conversationId) || getStoredActiveRun(conversationId)) return

  const assistantMsg = {
    id: uuidv4(),
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    steps: [] as TaskStep[],
    artifacts: [],
    computerPanelData: [] as ComputerPanelItem[],
  }
  useChatStore.getState().addMessage(conversationId, assistantMsg)

  const allMessages = conversation.messages.map(m => ({
    role: m.role,
    content: m.role === 'user' ? clampTaskInput(m.content) : m.content,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
  }))
  const globalInstructions = useSettingsStore.getState().globalInstructions || ''
  const conversationInstructions = conversation.customInstructions || ''
  const customInstructions = [globalInstructions, conversationInstructions].filter(Boolean).join('\n\n') || undefined
  const latestUserContent = clampTaskInput([...conversation.messages].reverse().find(m => m.role === 'user')?.content || '')
  const startFreshSandbox = !isContextualTaskUpdateText(latestUserContent)
  const currentModel = useSettingsStore.getState().model
  const controller = new AbortController()
  const dispatcher = createStoreDispatcher(conversationId, (message) => {
    if (message) useUIStore.getState().addToast(message, 'error')
  })

  useUIStore.getState().resetComputerPanelAutoOpenSuppression()
  useUIStore.getState().setStreaming(true)
  useUIStore.getState().setStreamingStatus('startup')
  useCreditStore.getState().startTask(conversationId, {
    chargeStart: false,
    accountingMode: 'server',
  })
  activeControllers.set(conversationId, controller)

  const startupTimer = window.setTimeout(() => {
    if (activeControllers.get(conversationId) === controller && useUIStore.getState().streamingStatus === 'startup') {
      useUIStore.getState().setStreamingStatus('thinking')
    }
  }, 1500)

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: allMessages, model: currentModel, conversationId, customInstructions, startFreshSandbox }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
      if (response.status === 402 || errorBody?.code === OUT_OF_CREDITS_CODE) {
        await useCreditStore.getState().syncFromServer({ force: true })
        throw new Error(userErrorMessage(errorBody?.error ?? errorBody, OUT_OF_CREDITS_MESSAGE))
      }
      throw new Error(userErrorMessage(errorBody?.error ?? errorBody, 'The task could not start. Please try again.'))
    }
    const responseRunId = response.headers.get('x-agent-run-id') || undefined
    await consumeTaskResponseForConversation({
      conversationId,
      response,
      controller,
      dispatcher,
      runId: responseRunId,
      assistantMessageId: assistantMsg.id,
      isFirstResponse: true,
      setStreamError: (message) => {
        if (message) useUIStore.getState().addToast(message, 'error')
      },
    })
  } catch (error) {
    if (activeControllers.get(conversationId) !== controller) return
    if ((error as Error).name !== 'AbortError') {
      const msg = userErrorMessage(error, 'The task could not finish. Please try again.')
      dispatcher.finalizeOnAbort('error', msg)
      useUIStore.getState().addToast(msg, 'error')
    }
  } finally {
    window.clearTimeout(startupTimer)
    if (activeControllers.get(conversationId) === controller) {
      useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
      useUIStore.getState().setStreaming(false)
      activeControllers.delete(conversationId)
      if (dispatcher.hasTerminalEvent()) activeRunIds.delete(conversationId)
    }
  }
}

export function useAgentStream(conversationId: string): UseAgentStreamReturn {
  // Individual selectors — subscribing to the whole store re-renders this hook
  // (and every component using it) on every unrelated state change.
  const addMessage = useChatStore((s) => s.addMessage)
  const addLiveDirectiveExchange = useChatStore((s) => s.addLiveDirectiveExchange)
  const appendToLastMessage = useChatStore((s) => s.appendToLastMessage)
  const appendReasoning = useChatStore((s) => s.appendReasoning)
  const setSteps = useChatStore((s) => s.setSteps)
  const setTaskGroups = useChatStore((s) => s.setTaskGroups)
  const updateTaskGroupStatus = useChatStore((s) => s.updateTaskGroupStatus)
  const addSubtaskToGroup = useChatStore((s) => s.addSubtaskToGroup)
  const updateSubtaskInGroup = useChatStore((s) => s.updateSubtaskInGroup)
  const addGroupNarration = useChatStore((s) => s.addGroupNarration)
  const setLastMessageContent = useChatStore((s) => s.setLastMessageContent)
  const setFollowUps = useChatStore((s) => s.setFollowUps)
  const addArtifact = useChatStore((s) => s.addArtifact)
  const addComputerPanelItem = useChatStore((s) => s.addComputerPanelItem)
  const upsertComputerPanelItem = useChatStore((s) => s.upsertComputerPanelItem)
  const removeComputerPanelItem = useChatStore((s) => s.removeComputerPanelItem)
  const updateTitle = useChatStore((s) => s.updateTitle)

  const setStreaming = useUIStore((s) => s.setStreaming)
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const addToast = useUIStore((s) => s.addToast)

  const abortRef = useRef<AbortController | null>(null)
  const sendingRef = useRef(false)
  const [streamError, setStreamError] = useState<string | null>(null)

  useEffect(() => {
    abortRef.current = activeControllers.get(conversationId) ?? null
    return () => {
      abortRef.current = null
    }
  }, [conversationId])

  const generateTitle = useCallback(async () => {
    const conv = useChatStore.getState().conversations.find(c => c.id === conversationId)
    if (!conv) return
    const msgs = conv.messages
    const userMsg = msgs.find(m => m.role === 'user')
    if (!userMsg) return
    const assistantMsg = msgs.find(m => m.role === 'assistant')

    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          messages: [
            { role: 'user', content: userMsg.content },
            ...(assistantMsg?.content ? [{ role: 'assistant', content: assistantMsg.content }] : []),
          ],
        }),
      })
      if (!res.ok) return // Rate limited (429) or server error — title is non-critical
      const data = await res.json()
      if (data.title && data.title !== 'New task') {
        updateTitle(conversationId, data.title)
      }
    } catch {
      // Title generation is non-critical
    }
  }, [conversationId, updateTitle])

  const handleStop = useCallback(() => {
    const controller = activeControllers.get(conversationId) ?? abortRef.current
    const runId = activeRunIds.get(conversationId) ?? getStoredActiveRun(conversationId)?.runId
    if (runId) {
      const query = new URLSearchParams({ conversationId, runId })
      void fetch(`/api/chat?${query.toString()}`, { method: 'DELETE' }).catch(() => undefined)
      clearStoredActiveRun(conversationId, runId)
    }
    if (controller) markActiveAssistantInterrupted(conversationId, '*Task stopped.*')
    controller?.abort('user-stop')
    useCreditStore.getState().finishTask(conversationId, 'stopped')
    activeControllers.delete(conversationId)
    activeRunIds.delete(conversationId)
    abortRef.current = null
    setStreaming(false)
  }, [conversationId, setStreaming])

  const createDispatcher = useCallback(() => new EventDispatcher(conversationId, {
    appendToLastMessage, appendReasoning,
    setSteps, setTaskGroups, updateTaskGroupStatus,
    addSubtaskToGroup, updateSubtaskInGroup, addGroupNarration,
    setLastMessageContent, setFollowUps, addArtifact,
    addComputerPanelItem, upsertComputerPanelItem, removeComputerPanelItem,
    setComputerPanelOpen, addToast,
  }, setStreamError), [
    conversationId,
    appendToLastMessage, appendReasoning,
    setSteps, setTaskGroups, updateTaskGroupStatus,
    addSubtaskToGroup, updateSubtaskInGroup, addGroupNarration,
    setLastMessageContent, setFollowUps, addArtifact,
    addComputerPanelItem, upsertComputerPanelItem, removeComputerPanelItem,
    setComputerPanelOpen, addToast,
  ])

  const consumeTaskResponse = useCallback(async (input: {
    response: Response
    controller: AbortController
    dispatcher: EventDispatcher
    runId?: string
    assistantMessageId?: string
    isFirstResponse?: boolean
    allowTerminalReplay?: boolean
  }) => {
    let response = input.response
    let runId = input.runId || response.headers.get('x-agent-run-id') || undefined
    let allowTerminalReplay = input.allowTerminalReplay !== false
    if (runId) {
      saveStoredActiveRun(conversationId, {
        runId,
        assistantMessageId: input.assistantMessageId,
      })
    }

    let dispatchErrors = 0
    let highestDispatchedSeq = 0

    while (true) {
      const headerRunId = response.headers.get('x-agent-run-id') || undefined
      if (!runId && headerRunId) runId = headerRunId
      if (runId) {
        saveStoredActiveRun(conversationId, {
          runId,
          assistantMessageId: input.assistantMessageId,
        })
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('The task could not start. Please try again.')

      for await (const event of parseSSEStream(reader)) {
        if (!runId && typeof event.runId === 'string') {
          runId = event.runId
        }
        const seq = Number(event.seq)
        if (runId && Number.isFinite(seq) && seq > 0) {
          if (seq <= highestDispatchedSeq) continue
          highestDispatchedSeq = seq
          saveStoredActiveRun(conversationId, {
            runId,
            lastSeq: seq,
            assistantMessageId: input.assistantMessageId,
          })
        }
        try {
          input.dispatcher.dispatch(event)
          dispatchErrors = 0
        } catch (dispatchErr) {
          dispatchErrors++
          console.error('[useAgentStream] dispatch error:', event.type, dispatchErr)
          if (dispatchErrors === 5) {
            console.error('[useAgentStream] Repeated dispatch errors; keeping stream alive so the backend task can finish')
            addToast('Some live updates were missed, but the task is still running.', 'error')
          }
        }
        if (input.dispatcher.hasTerminalEvent()) break
      }

      if (input.dispatcher.hasTerminalEvent()) break

      const activeRun = runId ? getStoredActiveRun(conversationId) : null
      if (
        allowTerminalReplay &&
        activeRun &&
        activeRun.runId === runId &&
        input.controller.signal.reason !== 'user-stop'
      ) {
        allowTerminalReplay = false
        const query = new URLSearchParams({
          conversationId,
          runId: activeRun.runId,
          after: String(Math.max(highestDispatchedSeq, activeRun.lastSeq || 0)),
        })
        const replayResponse = await fetch(`/api/chat?${query.toString()}`, {
          method: 'GET',
          signal: input.controller.signal,
        })
        if (replayResponse.ok) {
          response = replayResponse
          continue
        }
      }
      break
    }

    if (!input.dispatcher.hasTerminalEvent()) {
      const activeRun = runId ? getStoredActiveRun(conversationId) : null
      if (activeRun?.runId === runId && input.controller.signal.reason !== 'user-stop') {
        setStreamError('Disconnected from the running task. Reopen this task to reconnect.')
        return
      }
      const msg = 'The task stopped before it finished. Please try again.'
      input.dispatcher.finalizeOnAbort('error', msg)
      setStreamError(msg)
      addToast(msg, 'error')
      return
    }

    if (runId) {
      clearStoredActiveRun(conversationId, runId)
    }

    const latest = useChatStore.getState().conversations
      .find(c => c.id === conversationId)
      ?.messages
      .slice()
      .reverse()
      .find(m => m.role === 'assistant')
    const hasVisibleResponse = !!(
      latest?.content?.trim() ||
      latest?.taskGroups?.length ||
      latest?.steps?.length ||
      latest?.computerPanelData?.length ||
      latest?.artifacts?.length
    )
    if (!hasVisibleResponse) {
      const msg = input.dispatcher.getTerminalStatus() === 'error'
        ? userErrorMessage(input.dispatcher.getTerminalErrorMessage(), 'The task stopped before it finished. Please try again.')
        : 'The task stopped before it finished. Please try again.'
      input.dispatcher.finalizeOnAbort('error', msg)
      setLastMessageContent(conversationId, msg)
      setStreamError(msg)
      addToast(msg, 'error')
    } else if (input.isFirstResponse) {
      generateTitle()
    }
  }, [conversationId, addToast, generateTitle, setLastMessageContent])

  const sendMessage = useCallback(
    async (content: string, isAutoSendOrAttachments: boolean | FileAttachment[] = false) => {
      const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
      if (!conversation) return

      const isAutoSend = typeof isAutoSendOrAttachments === 'boolean' ? isAutoSendOrAttachments : false
      const attachments = Array.isArray(isAutoSendOrAttachments) ? isAutoSendOrAttachments : undefined
      const boundedContent = clampTaskInput(content)
      if (boundedContent.length !== content.length) {
        const msg = taskInputLimitMessage()
        addToast(msg, 'error')
      }

      setStreamError(null)
      let existingController = activeControllers.get(conversationId) ?? abortRef.current
      let storedActiveRun = getStoredActiveRun(conversationId)
      if (existingController?.signal.aborted) {
        activeControllers.delete(conversationId)
        if (abortRef.current === existingController) abortRef.current = null
        existingController = null
      }
      if (!existingController && storedActiveRun && !isAutoSend) {
        const serverActiveRun = await fetchServerActiveRun(conversationId)
        if (serverActiveRun?.runId) {
          storedActiveRun = serverActiveRun
        } else {
          clearStoredActiveRun(conversationId, storedActiveRun.runId)
          storedActiveRun = null
        }
      }
      if (existingController && isAutoSend) {
        // Auto-send can be re-fired by remounts, route refreshes, or React dev
        // strict effects. It must not abort the task it originally started.
        return
      }
      if ((existingController && !isAutoSend) || (storedActiveRun && !isAutoSend)) {
        if (attachments && attachments.length > 0) {
          const msg = 'Text instructions can be sent while a task is running. Attachments can be added after the current task finishes.'
          setStreamError(msg)
          addToast(msg, 'error')
          throw new Error(msg)
        }

        const directive = boundedContent.trim()
        if (!directive) return

        sendingRef.current = true
        try {
          const response = await fetch('/api/chat/directive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId, content: directive }),
          })
          if (!response.ok) {
            const errorBody = await response.json().catch(() => null) as { error?: unknown } | null
            throw new Error(userErrorMessage(errorBody?.error ?? errorBody, 'Could not send the live instruction.'))
          }

          const now = Date.now()
          addLiveDirectiveExchange(
            conversationId,
            {
              id: uuidv4(),
              role: 'user' as const,
              content: directive,
              timestamp: now,
            },
            {
              id: uuidv4(),
              role: 'assistant' as const,
              content: '',
              timestamp: now,
              steps: [] as TaskStep[],
              artifacts: [],
              computerPanelData: [] as ComputerPanelItem[],
            }
          )
          playSend()
        } catch (error) {
          const msg = userErrorMessage(error, 'Could not send the live instruction.')
          setStreamError(msg)
          addToast(msg, 'error')
          throw error
        } finally {
          sendingRef.current = false
        }
        return
      }

      if (storedActiveRun && isAutoSend) {
        return
      }

      // Abort any existing stream before starting a replacement run. Live
      // mid-task instructions are handled above through /api/chat/directive.
      if (existingController) {
        markActiveAssistantInterrupted(conversationId, '*Interrupted by new message.*')
        existingController.abort()
        useCreditStore.getState().finishTask(conversationId, 'stopped')
        activeControllers.delete(conversationId)
        abortRef.current = null
      }
      sendingRef.current = true

      let userMsg: { id: string; role: 'user'; content: string; attachments?: FileAttachment[]; timestamp: number } | undefined
      if (!isAutoSend) {
        userMsg = {
          id: uuidv4(),
          role: 'user' as const,
          content: boundedContent,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          timestamp: Date.now(),
        }
        addMessage(conversationId, userMsg)
        if (attachments && attachments.length > 0) {
          await bindAttachmentsToTask(attachments, conversationId, userMsg.id)
            .catch((error) => {
              const msg = error instanceof Error && error.message
                ? error.message
                : "Your attachments couldn't be linked to this task."
              addToast(msg, 'error')
              throw error
            })
        }
        playSend()
      }

      const assistantMsg = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        steps: [] as TaskStep[],
        artifacts: [],
        computerPanelData: [] as ComputerPanelItem[],
      }
      addMessage(conversationId, assistantMsg)

      const messagesToSend = isAutoSend
        ? conversation.messages
        : [...conversation.messages, userMsg!]
      const allMessages = messagesToSend.map(m => ({
        role: m.role,
        content: m.role === 'user' ? clampTaskInput(m.content) : m.content,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      }))

      const globalInstructions = useSettingsStore.getState().globalInstructions || ''
      const conversationInstructions = conversation.customInstructions || ''
      const customInstructions = [globalInstructions, conversationInstructions].filter(Boolean).join('\n\n') || undefined

      const latestUserContent = isAutoSend
        ? clampTaskInput([...conversation.messages].reverse().find(m => m.role === 'user')?.content || '')
        : boundedContent
      const isFirstTaskAutoStart = conversation.messages.length === 1 && conversation.messages[0]?.role === 'user'
      const startFreshSandbox = isFirstTaskAutoStart || (!isAutoSend && !isContextualTaskUpdateText(latestUserContent))

      // Read model fresh from store to avoid stale closure
      const currentModel = useSettingsStore.getState().model

      useUIStore.getState().resetComputerPanelAutoOpenSuppression()
      setStreaming(true)
      useUIStore.getState().setStreamingStatus(startFreshSandbox ? 'startup' : 'thinking')
      useCreditStore.getState().startTask(conversationId, {
        chargeStart: false,
        accountingMode: 'server',
      })

      const dispatcher = createDispatcher()

      const isFirstResponse = conversation.messages.length <= 1

      const controller = new AbortController()
      abortRef.current = controller
      activeControllers.set(conversationId, controller)

      const startupTimer = window.setTimeout(() => {
        if (abortRef.current === controller && useUIStore.getState().streamingStatus === 'startup') {
          useUIStore.getState().setStreamingStatus('thinking')
        }
      }, 1500)

      try {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('Task stopped.'), { name: 'AbortError' })
        }

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: allMessages, model: currentModel, conversationId, customInstructions, startFreshSandbox }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null) as {
            error?: unknown
            code?: unknown
            activeConversationId?: unknown
          } | null
          if (
            response.status === 402 ||
            errorBody?.code === OUT_OF_CREDITS_CODE
          ) {
            await useCreditStore.getState().syncFromServer({ force: true })
            throw new Error(userErrorMessage(errorBody?.error ?? errorBody, OUT_OF_CREDITS_MESSAGE))
          }
          throw new Error(userErrorMessage(errorBody?.error ?? errorBody, 'The task could not start. Please try again.'))
        }
        const responseRunId = response.headers.get('x-agent-run-id') || undefined
        await consumeTaskResponse({
          response,
          controller,
          dispatcher,
          runId: responseRunId,
          assistantMessageId: assistantMsg.id,
          isFirstResponse,
        })
      } catch (error) {
        // If a newer send has started, this closure's controller is no longer
        // active — bail out so we don't append to the new message or wipe
        // its streaming state.
        if (activeControllers.get(conversationId) !== controller) return
        if ((error as Error).name === 'AbortError') {
          if (controller.signal.reason === 'user-stop') {
            dispatcher.finalizeOnAbort('stopped', 'Task stopped.')
            appendToLastMessage(conversationId, '\n\n*Task stopped.*')
          }
        } else {
          const msg = userErrorMessage(error, 'The task could not finish. Please try again.')
          dispatcher.finalizeOnAbort('error', msg)
          setStreamError(msg)
          addToast(msg, 'error')
        }
      } finally {
        window.clearTimeout(startupTimer)
        if (activeControllers.get(conversationId) === controller) {
          useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
          sendingRef.current = false
          setStreaming(false)
          activeControllers.delete(conversationId)
          if (dispatcher.hasTerminalEvent()) activeRunIds.delete(conversationId)
          abortRef.current = null
        }
      }
    },
    [
      conversationId,
      addMessage, addLiveDirectiveExchange, appendToLastMessage,
      setStreaming, addToast,
      createDispatcher, consumeTaskResponse,
    ]
  )

  const resumeActiveTask = useCallback(async (options: { includeTerminalReplay?: boolean } = {}): Promise<boolean> => {
    const record = getStoredActiveRun(conversationId) || await fetchServerActiveRun(conversationId, options)
    if (!record?.runId) return false
    if (activeControllers.has(conversationId)) return true

    const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
    if (!conversation) return false

    let assistantMessageId = [...conversation.messages].reverse().find(message => message.role === 'assistant')?.id
    if (!assistantMessageId) {
      const assistantMsg = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        steps: [] as TaskStep[],
        artifacts: [],
        computerPanelData: [] as ComputerPanelItem[],
      }
      assistantMessageId = assistantMsg.id
      addMessage(conversationId, assistantMsg)
    }

    const controller = new AbortController()
    abortRef.current = controller
    activeControllers.set(conversationId, controller)
    activeRunIds.set(conversationId, record.runId)
    setStreamError(null)
    setStreaming(true)
    useUIStore.getState().setStreamingStatus('thinking')
    useCreditStore.getState().startTask(conversationId, {
      chargeStart: false,
      accountingMode: 'server',
    })

    const dispatcher = createDispatcher()
    const afterSeq = lastAssistantHasVisibleResponse(conversationId) ? record.lastSeq : 0

    try {
      const query = new URLSearchParams({
        conversationId,
        runId: record.runId,
        after: String(afterSeq),
      })
      const response = await fetch(`/api/chat?${query.toString()}`, {
        method: 'GET',
        signal: controller.signal,
      })
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: unknown } | null
        throw new Error(userErrorMessage(errorBody?.error ?? errorBody, 'Could not reconnect to the task.'))
      }

      await consumeTaskResponse({
        response,
        controller,
        dispatcher,
        runId: record.runId,
        assistantMessageId,
      })
      return true
    } catch (error) {
      if (activeControllers.get(conversationId) !== controller) return false
      if ((error as Error).name !== 'AbortError') {
        const msg = userErrorMessage(error, 'Could not reconnect to the task.')
        setStreamError(msg)
        addToast(msg, 'error')
      }
      return false
    } finally {
      if (activeControllers.get(conversationId) === controller) {
        useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
        setStreaming(false)
        activeControllers.delete(conversationId)
        if (dispatcher.hasTerminalEvent()) activeRunIds.delete(conversationId)
        abortRef.current = null
      }
    }
  }, [
    conversationId,
    addMessage,
    setStreaming,
    createDispatcher,
    consumeTaskResponse,
    addToast,
  ])

  const clearError = useCallback(() => setStreamError(null), [])

  return { sendMessage, handleStop, resumeActiveTask, streamError, clearError }
}
