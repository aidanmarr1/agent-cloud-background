'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useChatStore } from '@/store/chat'
import { rebaseConversationFromServerForRun } from '@/store/chat/serverSync'
import { useUIStore } from '@/store/ui'
import { useSettingsStore } from '@/store/settings'
import type { TaskStep, ComputerPanelItem, FileAttachment, Message } from '@/types'
import { playSend } from '@/lib/useSound'
import { parseSSEStream } from './SSEParser'
import { EventDispatcher } from './eventDispatcher'
import { useCreditStore } from '@/store/credits'
import { OUT_OF_CREDITS_CODE, OUT_OF_CREDITS_MESSAGE } from '@/lib/creditPolicy'
import { isContextualTaskUpdateText } from '@/lib/conversationContext'
import { bindAttachmentsToTask } from '@/lib/attachmentUpload'
import { clampTaskInput, taskInputLimitMessage } from '@/lib/inputLimits'
import { userErrorMessage } from '@/lib/errorMessages'
import { classifyStreamSequence } from './streamSequence'

export interface UseAgentStreamReturn {
  sendMessage: (content: string, isAutoSendOrAttachments?: boolean | FileAttachment[]) => Promise<void>
  handleStop: () => void
  resumeActiveTask: (options?: { includeTerminalReplay?: boolean }) => Promise<boolean>
  streamError: string | null
  clearError: () => void
}

const activeControllers = new Map<string, AbortController>()
const activeRunIds = new Map<string, string>()
const startReservations = new Set<string>()
const cancelledStartReservations = new Set<string>()
const startRequestsAwaitingHeaders = new Set<string>()
const pendingStopRequests = new Map<string, Promise<StopTaskOutcome>>()
const ACTIVE_RUNS_STORAGE_KEY = 'agent-active-task-runs'
const TASK_STREAM_REPLAY_DELAYS_MS = [0, 120, 350, 750, 1_500, 3_000, 5_000] as const
const TASK_STREAM_MAX_DISPATCH_REPLAYS = 3
const TASK_STOP_DISCOVERY_DELAYS_MS = [0, 75, 150, 300, 600, 1_000, 1_000, 1_000] as const
const TASK_STOP_ACK_POLL_MS = 750
const LIVE_DIRECTIVE_RETRY_DELAYS_MS = [0, 200, 650] as const
const TASK_START_RECOVERY_DELAYS_MS = [0, 75, 150, 300, 600, 1_000, 1_500, 2_500] as const
const TASK_START_POST_RETRY_DELAYS_MS = [0, 350, 1_000] as const
const TASK_START_CONFIRMATION_GRACE_MS = 310_000
const TASK_START_REJECTED_CODE = 'TASK_START_REJECTED' as const

type TaskStartRejectedError = Error & { code: typeof TASK_START_REJECTED_CODE }

function taskStartRejectedError(error: unknown, fallback: string): TaskStartRejectedError {
  return Object.assign(new Error(userErrorMessage(error, fallback)), {
    code: TASK_START_REJECTED_CODE,
  })
}

function isTaskStartRejectedError(error: unknown): error is TaskStartRejectedError {
  return error instanceof Error &&
    (error as Partial<TaskStartRejectedError>).code === TASK_START_REJECTED_CODE
}

interface LiveDirectiveResponse {
  ok?: unknown
  directiveId?: unknown
  continuationMessageId?: unknown
  content?: unknown
  status?: unknown
  error?: unknown
}

async function postLiveDirectiveWithRetry(input: {
  conversationId: string
  content: string
  directiveId: string
}): Promise<{
  directiveId: string
  continuationMessageId: string
  content: string
}> {
  let lastError: unknown = new Error('Could not send the live instruction.')
  for (const delayMs of LIVE_DIRECTIVE_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    }
    try {
      const response = await fetch('/api/chat/directive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await response.json().catch(() => null) as LiveDirectiveResponse | null
      if (!response.ok) {
        const error = new Error(userErrorMessage(body?.error ?? body, 'Could not send the live instruction.'))
        if (response.status < 500 && response.status !== 408) throw error
        lastError = error
        continue
      }
      if (
        body?.ok !== true ||
        typeof body.directiveId !== 'string' ||
        body.directiveId !== input.directiveId ||
        typeof body.continuationMessageId !== 'string' ||
        (body.status !== 'accepted' && body.status !== 'delivered')
      ) {
        lastError = new Error('The live instruction response was incomplete. Please try again.')
        continue
      }
      return {
        directiveId: body.directiveId,
        continuationMessageId: body.continuationMessageId,
        content: typeof body.content === 'string' ? body.content : input.content,
      }
    } catch (error) {
      lastError = error
      if (error instanceof TypeError) continue
      throw error
    }
  }
  throw lastError
}

async function waitForReplayDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(Object.assign(new Error('Task stream stopped.'), { name: 'AbortError' }))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

async function postTaskStartWithStableRunId(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown = new Error('The task start request could not be sent.')
  for (const delayMs of TASK_START_POST_RETRY_DELAYS_MS) {
    await waitForReplayDelay(delayMs, signal)
    try {
      return await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
    }
  }
  throw lastError
}

interface ActiveRunRecord {
  runId: string
  conversationId: string
  lastSeq: number
  startedAt: number
  assistantMessageId?: string
  status?: string
  terminal?: boolean
  terminalError?: string
}

interface ActiveTaskResponse {
  active?: boolean
  runId?: unknown
  conversationId?: unknown
  startedAt?: unknown
  status?: unknown
  terminal?: unknown
  terminalError?: unknown
}

interface StopTaskResponse {
  ok?: unknown
  status?: unknown
  terminal?: unknown
  terminalError?: unknown
  error?: unknown
}

type StopTaskOutcome =
  | { kind: 'terminal'; runId: string; status: string; terminalError?: string }
  | { kind: 'not-started' }
  | { kind: 'failed'; runId?: string; message: string }

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
  try {
    window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(records))
  } catch {
    // Streaming must continue when storage is disabled or over quota. The
    // in-memory run maps still protect the active tab; persistence is best effort.
  }
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
  const sameRun = previous?.runId === patch.runId
  records[conversationId] = {
    conversationId,
    lastSeq: sameRun ? previous.lastSeq : 0,
    startedAt: sameRun ? previous.startedAt : Date.now(),
    assistantMessageId: sameRun ? previous.assistantMessageId : undefined,
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
  options: { includeTerminalReplay?: boolean; persist?: boolean; runId?: string } = {},
): Promise<ActiveRunRecord | null | undefined> {
  try {
    const query = new URLSearchParams({ conversationId })
    if (options.includeTerminalReplay) query.set('includeTerminalReplay', '1')
    if (options.runId) query.set('runId', options.runId)
    const response = await fetch(`/api/chat/active?${query.toString()}`, { cache: 'no-store' })
    if (!response.ok) return undefined
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
    const existing = getStoredActiveRun(conversationId)
    const record: ActiveRunRecord = {
      runId: data.runId,
      conversationId,
      lastSeq: existing?.runId === data.runId ? existing.lastSeq : 0,
      startedAt,
      assistantMessageId: existing?.runId === data.runId ? existing.assistantMessageId : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      terminal: data.terminal === true,
      terminalError: typeof data.terminalError === 'string' ? data.terminalError : undefined,
    }
    if (options.persist !== false) saveStoredActiveRun(conversationId, record)
    return record
  } catch {
    return undefined
  }
}

type TaskRunDiscovery =
  | { kind: 'found'; record: ActiveRunRecord }
  | { kind: 'unknown' }

async function waitForKnownTaskRun(
  conversationId: string,
  runId: string,
  signal: AbortSignal,
  options: { persist?: boolean } = {},
): Promise<TaskRunDiscovery> {
  for (const delayMs of TASK_START_RECOVERY_DELAYS_MS) {
    await waitForReplayDelay(delayMs, signal)
    const record = await fetchServerActiveRun(conversationId, {
      includeTerminalReplay: true,
      persist: false,
      runId,
    })
    if (record?.runId === runId) {
      if (options.persist !== false) saveStoredActiveRun(conversationId, record)
      return { kind: 'found', record }
    }
  }
  // A dropped POST can still be executing server-side while these lookups miss.
  // Preserve the stable run id until the server either exposes that run or a
  // later explicit request proves it never committed.
  return { kind: 'unknown' }
}

async function openKnownTaskRunStream(input: {
  conversationId: string
  runId: string
  signal: AbortSignal
  afterSeq?: number
}): Promise<Response> {
  const discovered = await waitForKnownTaskRun(input.conversationId, input.runId, input.signal)
  if (discovered.kind === 'unknown') {
    throw Object.assign(new Error('The task may have started, but its status could not be confirmed. Reopen this task to reconnect.'), {
      code: 'TASK_START_UNKNOWN',
    })
  }
  const query = new URLSearchParams({
    conversationId: input.conversationId,
    runId: input.runId,
    after: String(Math.max(0, input.afterSeq || 0)),
  })
  const response = await fetch(`/api/chat?${query.toString()}`, {
    method: 'GET',
    signal: input.signal,
  })
  if (!response.ok) {
    throw new Error('The task exists, but reconnecting to it failed. Reopen the task to try again.')
  }
  return response
}

async function waitForStopPoll(delayMs: number): Promise<void> {
  if (delayMs <= 0) return
  await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
}

async function discoverStartingRun(conversationId: string): Promise<ActiveRunRecord | null | undefined> {
  let consecutiveDefinitiveMisses = 0

  for (const delayMs of TASK_STOP_DISCOVERY_DELAYS_MS) {
    await waitForStopPoll(delayMs)
    const record = await fetchServerActiveRun(conversationId, {
      persist: false,
    })
    if (record?.runId) {
      saveStoredActiveRun(conversationId, record)
      return record
    }
    if (record === null) {
      consecutiveDefinitiveMisses += 1
    } else {
      consecutiveDefinitiveMisses = 0
    }
  }

  // Multiple successful misses across the full grace window mean the aborted
  // POST did not create a job. Any unresolved lookup failure stays unknown.
  return consecutiveDefinitiveMisses >= 2 ? null : undefined
}

async function cancelRunUntilTerminal(conversationId: string, runId: string): Promise<StopTaskOutcome> {
  let retryCount = 0

  while (true) {
    try {
      const query = new URLSearchParams({ conversationId, runId })
      const response = await fetch(`/api/chat?${query.toString()}`, { method: 'DELETE' })
      const body = await response.json().catch(() => null) as StopTaskResponse | null
      const status = typeof body?.status === 'string' ? body.status : ''

      if (
        response.ok &&
        body?.ok === true &&
        (body.terminal === true || status === 'cancelled')
      ) {
        return {
          kind: 'terminal',
          runId,
          status: status || 'cancelled',
          terminalError: typeof body.terminalError === 'string' ? body.terminalError : undefined,
        }
      }

      // Compatibility with an older in-process cancellation response. A 200
      // `{ok:true}` was only returned after that runner had settled.
      if (response.status === 200 && body?.ok === true && body.terminal !== false) {
        return {
          kind: 'terminal',
          runId,
          status: status || 'cancelled',
          terminalError: typeof body.terminalError === 'string' ? body.terminalError : undefined,
        }
      }

      if (
        (response.status === 202 && body?.ok !== false) ||
        (response.ok && body?.ok === true && (body.terminal === false || status === 'stopping'))
      ) {
        retryCount += 1
        await waitForStopPoll(TASK_STOP_ACK_POLL_MS)
        continue
      }

      // A response can be lost after the worker commits its terminal event.
      // Consult replayable state before treating a missing DELETE as failure.
      if (response.status === 404 || status === 'missing') {
        const replayable = await fetchServerActiveRun(conversationId, {
          includeTerminalReplay: true,
          persist: false,
        })
        if (replayable?.runId === runId && replayable.terminal) {
          return {
            kind: 'terminal',
            runId,
            status: replayable.status || 'cancelled',
            terminalError: replayable.terminalError,
          }
        }
      }

      if (response.status >= 500 || response.status === 429) {
        retryCount += 1
        await waitForStopPoll(Math.min(2_000, TASK_STOP_ACK_POLL_MS * Math.max(1, retryCount)))
        continue
      }

      return {
        kind: 'failed',
        runId,
        message: userErrorMessage(
          body?.error ?? body,
          'The stop request could not be confirmed. Reopen this task and try again.',
        ),
      }
    } catch {
      // Keep the run fenced and the UI truthful through transient connection
      // loss. Retrying here also prevents a lost DELETE response from orphaning
      // a task that did receive the cancellation request.
      retryCount += 1
      await waitForStopPoll(Math.min(2_000, TASK_STOP_ACK_POLL_MS * Math.max(1, retryCount)))
    }
  }
}

async function stopConversationTask(input: {
  conversationId: string
  runId?: string
  startRequestMayHaveReachedServer: boolean
}): Promise<StopTaskOutcome> {
  let runId = input.runId
  if (!runId && input.startRequestMayHaveReachedServer) {
    const discovered = await discoverStartingRun(input.conversationId)
    if (discovered === undefined) {
      return {
        kind: 'failed',
        message: 'The stop request could not be confirmed. Reopen this task and try again.',
      }
    }
    if (discovered === null) return { kind: 'not-started' }
    runId = discovered.runId
  }

  if (!runId) return { kind: 'not-started' }
  return cancelRunUntilTerminal(input.conversationId, runId)
}

function latestAssistantMessage(conversationId: string) {
  return useChatStore.getState().conversations
    .find(c => c.id === conversationId)
    ?.messages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant')
}

function lastAssistantHasVisibleResponse(conversationId: string): boolean {
  const latest = latestAssistantMessage(conversationId)
  return !!(
    latest?.content?.trim() ||
    latest?.taskGroups?.length ||
    latest?.steps?.length ||
    latest?.computerPanelData?.length ||
    latest?.artifacts?.length
  )
}

function markActiveAssistantInterrupted(conversationId: string, label: string, reason: string): void {
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
          taskGroups: Array.isArray(message.taskGroups)
            ? message.taskGroups.map((group) => ({
                ...group,
                status: group.status === 'running' ? 'incomplete' : group.status,
                subtasks: (Array.isArray(group.subtasks) ? group.subtasks : []).map((subtask) => (
                  subtask.status === 'running'
                    ? { ...subtask, status: 'error', errorMessage: reason }
                    : subtask
                )),
                narrations: Array.isArray(group.narrations) ? group.narrations : [],
              }))
            : message.taskGroups,
          steps: Array.isArray(message.steps)
            ? message.steps.map((step) => (
                step.status === 'running' ? { ...step, status: 'incomplete' } : step
              ))
            : message.steps,
        }
        break
      }
      return { ...conversation, messages, updatedAt: Date.now() }
    }),
  }))
}

export function hasActiveAgentStream(conversationId: string): boolean {
  return activeControllers.has(conversationId) || pendingStopRequests.has(conversationId)
}

function setConversationStreaming(conversationId: string, streaming: boolean): void {
  if (useChatStore.getState().activeId === conversationId) {
    useUIStore.getState().setStreaming(streaming)
  }
}

// Removing the marker makes these messages eligible for durable sync. Call
// only after a successful POST or exact-run recovery proves the start committed.
function acceptPendingTaskStart(conversationId: string, runId: string): void {
  useChatStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      let changed = false
      const messages = conversation.messages.map((message) => {
        if (message.pendingStartRunId !== runId) return message
        changed = true
        const { pendingStartRunId: _pendingStartRunId, ...acceptedMessage } = message
        void _pendingStartRunId
        return acceptedMessage
      })
      return changed ? { ...conversation, messages, updatedAt: Date.now() } : conversation
    }),
  }))
}

function hasPendingTaskStartMarkers(conversationId: string, runId: string): boolean {
  return useChatStore.getState().conversations
    .find((conversation) => conversation.id === conversationId)
    ?.messages
    .some((message) => message.pendingStartRunId === runId) === true
}

function rollbackRejectedTaskStart(conversationId: string, runId: string): void {
  useChatStore.getState().rollbackPendingTaskStart(conversationId, runId)
  clearStoredActiveRun(conversationId, runId)
}

function assistantMessageForRun(conversationId: string, runId: string): Message | undefined {
  return useChatStore.getState().conversations
    .find((conversation) => conversation.id === conversationId)
    ?.messages
    .slice()
    .reverse()
    .find((message) => message.role === 'assistant' && message.streamRunId === runId)
}

async function rebaseToConflictingTaskRun(input: {
  conversationId: string
  requestedRunId: string
  conflictRunId: string
  signal: AbortSignal
}): Promise<{ record: ActiveRunRecord; assistantMessage: Message }> {
  rollbackRejectedTaskStart(input.conversationId, input.requestedRunId)
  try {
    const discovered = await waitForKnownTaskRun(
      input.conversationId,
      input.conflictRunId,
      input.signal,
      { persist: false },
    )
    if (discovered.kind === 'unknown') {
      throw taskStartRejectedError(
        null,
        'Another tab is running this task, but that exact run is not visible yet. Reopen the task to reconnect.',
      )
    }

    const rebased = await rebaseConversationFromServerForRun(
      input.conversationId,
      input.conflictRunId,
      { signal: input.signal },
    )
    const assistantMessage = rebased
      ? assistantMessageForRun(input.conversationId, input.conflictRunId)
      : undefined
    if (!assistantMessage) {
      throw taskStartRejectedError(
        null,
        'Another tab is running this task, but its committed history is still unavailable. Reopen the task to reconnect.',
      )
    }

    return { record: discovered.record, assistantMessage }
  } catch (error) {
    if ((error as Error).name === 'AbortError' || isTaskStartRejectedError(error)) throw error
    throw taskStartRejectedError(
      error,
      'Another tab is running this task, but its committed history could not be loaded. Reopen the task to reconnect.',
    )
  }
}

function markAssistantStreamTerminal(
  conversationId: string,
  messageId: string,
  runId: string,
  status: 'done' | 'error',
): void {
  useChatStore.setState((state) => ({
    conversations: state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      let changed = false
      const messages = conversation.messages.map((message) => {
        if (
          message.id !== messageId ||
          message.role !== 'assistant' ||
          message.streamRunId !== runId ||
          message.streamTerminalStatus === status
        ) {
          return message
        }
        changed = true
        return { ...message, streamTerminalStatus: status }
      })
      return changed ? { ...conversation, messages, updatedAt: Date.now() } : conversation
    }),
  }))
}

function createStoreDispatcher(
  conversationId: string,
  setStreamError: (message: string | null) => void,
  initialMessage?: Message,
): EventDispatcher {
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
  }, setStreamError, initialMessage)
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
  afterSeq?: number
  isFirstResponse?: boolean
  allowTerminalReplay?: boolean
  setStreamError: (message: string | null) => void
}): Promise<void> {
  const { conversationId, setStreamError } = input
  const addToast = useUIStore.getState().addToast
  let response = input.response
  let runId = input.runId || response.headers.get('x-agent-run-id') || undefined
  let replayAttempt = 0
  const replayEnabled = input.allowTerminalReplay !== false
  const saveRunIdentity = (nextRunId: string) => {
    const current = getStoredActiveRun(conversationId)
    saveStoredActiveRun(conversationId, {
      runId: nextRunId,
      assistantMessageId: current?.runId === nextRunId
        ? current.assistantMessageId || input.assistantMessageId
        : input.assistantMessageId,
    })
  }
  if (runId) {
    saveRunIdentity(runId)
  }

  let dispatchErrors = 0
  let highestDispatchedSeq = Math.max(0, input.afterSeq || 0)

  streamLoop: while (true) {
    const headerRunId = response.headers.get('x-agent-run-id') || undefined
    if (!runId && headerRunId) runId = headerRunId
    if (runId) {
      saveRunIdentity(runId)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('The task could not start. Please try again.')

    try {
      for await (const event of parseSSEStream(reader)) {
        const eventRunId = typeof event.runId === 'string' ? event.runId : undefined
        if (!runId && eventRunId) {
          runId = eventRunId
        } else if (runId && eventRunId && eventRunId !== runId) {
          console.error('[useAgentStream] Ignoring event from a different task run', {
            conversationId,
            expectedRunId: runId,
            receivedRunId: eventRunId,
          })
          continue
        }
        const sequence = classifyStreamSequence(event, runId, highestDispatchedSeq)
        if (sequence.kind === 'ignore') continue
        if (sequence.kind === 'reconnect') {
          throw new Error(
            sequence.receivedSeq === null
              ? `Task stream event ${sequence.expectedSeq} did not include a valid sequence.`
              : `Task stream sequence gap: expected ${sequence.expectedSeq}, received ${sequence.receivedSeq}.`,
          )
        }
        const seq = sequence.seq
        try {
          input.dispatcher.dispatch(event)
          if (runId && seq !== null) {
            highestDispatchedSeq = seq
            const dispatchedRunId = runId
            input.dispatcher.afterPendingUpdates(() => {
              const committedAssistantMessageId = latestAssistantMessage(conversationId)?.id || input.assistantMessageId
              if (committedAssistantMessageId) {
                useChatStore.getState().setAssistantStreamCursor(
                  conversationId,
                  committedAssistantMessageId,
                  dispatchedRunId,
                  seq,
                )
                if (event.type === 'done' || event.type === 'error') {
                  markAssistantStreamTerminal(
                    conversationId,
                    committedAssistantMessageId,
                    dispatchedRunId,
                    event.type,
                  )
                }
              }
              saveStoredActiveRun(conversationId, {
                runId: dispatchedRunId,
                lastSeq: seq,
                assistantMessageId: committedAssistantMessageId,
              })
            })
          }
          dispatchErrors = 0
          replayAttempt = 0
        } catch (dispatchErr) {
          dispatchErrors++
          console.error('[useAgentStream] dispatch error:', event.type, dispatchErr)
          if (dispatchErrors === TASK_STREAM_MAX_DISPATCH_REPLAYS + 1) {
            console.error('[useAgentStream] Repeated dispatch errors; leaving the durable cursor at the last complete event')
            addToast('Some live updates were missed, but the task is still running.', 'error')
          }
          // Replaying immediately is safer than consuming later events after a
          // failed store mutation. The durable cursor remains unchanged.
          throw dispatchErr
        }
        if (input.dispatcher.hasTerminalEvent()) break
      }
    } catch (readError) {
      if (input.controller.signal.aborted) throw readError
      console.warn('[useAgentStream] Live task connection was interrupted; attempting replay', readError)
    }

    if (input.dispatcher.hasTerminalEvent()) break

    const activeRun = runId ? getStoredActiveRun(conversationId) : null
    if (
      replayEnabled &&
      dispatchErrors <= TASK_STREAM_MAX_DISPATCH_REPLAYS &&
      activeRun &&
      activeRun.runId === runId &&
      input.controller.signal.reason !== 'user-stop'
    ) {
      input.dispatcher.flushPendingUpdates()
      const query = new URLSearchParams({
        conversationId,
        runId: activeRun.runId,
        after: String(highestDispatchedSeq),
      })
      while (!input.controller.signal.aborted) {
        const replayDelayMs = TASK_STREAM_REPLAY_DELAYS_MS[
          Math.min(replayAttempt, TASK_STREAM_REPLAY_DELAYS_MS.length - 1)
        ] ?? TASK_STREAM_REPLAY_DELAYS_MS[TASK_STREAM_REPLAY_DELAYS_MS.length - 1]
        replayAttempt += 1
        await waitForReplayDelay(replayDelayMs, input.controller.signal)
        try {
          const replayResponse = await fetch(`/api/chat?${query.toString()}`, {
            method: 'GET',
            signal: input.controller.signal,
          })
          if (replayResponse.ok) {
            response = replayResponse
            continue streamLoop
          }
          if ([400, 401, 403, 404].includes(replayResponse.status)) break
        } catch (replayError) {
          if (input.controller.signal.aborted) throw replayError
        }
      }
    }
    break
  }

  input.dispatcher.flushPendingUpdates()
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

async function replayCompletedRunAfterStop(
  conversationId: string,
  runId: string,
  setStreamError: (message: string | null) => void,
): Promise<boolean> {
  const assistantMessage = latestAssistantMessage(conversationId)
  if (!assistantMessage) return false
  const stored = getStoredActiveRun(conversationId)
  const afterSeq = assistantMessage.streamRunId === runId
    ? Math.max(0, assistantMessage.streamSeq || 0)
    : stored?.runId === runId
      ? Math.max(0, stored.lastSeq)
      : 0
  saveStoredActiveRun(conversationId, {
    runId,
    assistantMessageId: assistantMessage.id,
    status: 'done',
    terminal: true,
  })
  const query = new URLSearchParams({
    conversationId,
    runId,
    after: String(afterSeq),
  })
  const replayController = new AbortController()
  const response = await fetch(`/api/chat?${query.toString()}`, {
    method: 'GET',
    signal: replayController.signal,
  })
  if (!response.ok) return false

  const dispatcher = createStoreDispatcher(conversationId, setStreamError, assistantMessage)
  await consumeTaskResponseForConversation({
    conversationId,
    response,
    controller: replayController,
    dispatcher,
    runId,
    assistantMessageId: assistantMessage.id,
    afterSeq,
    isFirstResponse: false,
    allowTerminalReplay: false,
    setStreamError,
  })
  return dispatcher.hasTerminalEvent()
}

export async function startInitialAgentTask(conversationId: string): Promise<void> {
  const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
  if (
    !conversation ||
    conversation.serverSummary === true ||
    conversation.serverBodyStale === true ||
    activeControllers.has(conversationId) ||
    pendingStopRequests.has(conversationId) ||
    startReservations.has(conversationId) ||
    getStoredActiveRun(conversationId)
  ) return
  startReservations.add(conversationId)
  cancelledStartReservations.delete(conversationId)

  const requestedRunId = uuidv4()
  const assistantMsg: Message = {
    id: uuidv4(),
    role: 'assistant' as const,
    content: '',
    timestamp: Date.now(),
    pendingStartRunId: requestedRunId,
    steps: [] as TaskStep[],
    artifacts: [],
    computerPanelData: [] as ComputerPanelItem[],
  }
  useChatStore.getState().addMessage(conversationId, assistantMsg)

  const allMessages = conversation.messages.map(m => ({
    id: m.id,
    timestamp: m.timestamp,
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
  let dispatcher = createStoreDispatcher(conversationId, (message) => {
    if (message) useUIStore.getState().addToast(message, 'error')
  })

  if (useChatStore.getState().activeId === conversationId) {
    useUIStore.getState().resetComputerPanelAutoOpenSuppression()
    setConversationStreaming(conversationId, true)
    useUIStore.getState().setStreamingStatus('startup')
  }
  useCreditStore.getState().startTask(conversationId, {
    chargeStart: false,
    accountingMode: 'server',
  })
  activeControllers.set(conversationId, controller)

  const startupTimer = window.setTimeout(() => {
    if (
      activeControllers.get(conversationId) === controller &&
      useChatStore.getState().activeId === conversationId &&
      useUIStore.getState().streamingStatus === 'startup'
    ) {
      useUIStore.getState().setStreamingStatus('thinking')
    }
  }, 1500)

  try {
    const latestUserMessage = [...conversation.messages].reverse().find((message) => message.role === 'user')
    if (latestUserMessage?.attachments?.length) {
      try {
        await bindAttachmentsToTask(latestUserMessage.attachments, conversationId, latestUserMessage.id)
      } catch (error) {
        rollbackRejectedTaskStart(conversationId, requestedRunId)
        throw taskStartRejectedError(error, "Your attachments couldn't be linked to this task.")
      }
    }
    if (cancelledStartReservations.delete(conversationId)) {
      throw Object.assign(new Error('Task stopped.'), { name: 'AbortError' })
    }
    saveStoredActiveRun(conversationId, {
      runId: requestedRunId,
      assistantMessageId: assistantMsg.id,
      status: 'starting',
    })
    startRequestsAwaitingHeaders.add(conversationId)
    let response: Response
    try {
      response = await postTaskStartWithStableRunId({
        runId: requestedRunId,
        assistantMessageId: assistantMsg.id,
        messages: allMessages,
        model: currentModel,
        conversationId,
        customInstructions,
        startFreshSandbox,
      }, controller.signal)
    } catch (postError) {
      startRequestsAwaitingHeaders.delete(conversationId)
      if (controller.signal.aborted) throw postError
      try {
        const replayResponse = await openKnownTaskRunStream({
          conversationId,
          runId: requestedRunId,
          signal: controller.signal,
        })
        acceptPendingTaskStart(conversationId, requestedRunId)
        await consumeTaskResponseForConversation({
          conversationId,
          response: replayResponse,
          controller,
          dispatcher,
          runId: requestedRunId,
          assistantMessageId: assistantMsg.id,
          isFirstResponse: true,
          setStreamError: (message) => {
            if (message) useUIStore.getState().addToast(message, 'error')
          },
        })
        return
      } catch (recoveryError) {
        throw recoveryError
      }
    }
    startRequestsAwaitingHeaders.delete(conversationId)
    startReservations.delete(conversationId)
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as {
        error?: unknown
        code?: unknown
        conversationId?: unknown
        runId?: unknown
        status?: unknown
      } | null
      if (response.status === 402 || errorBody?.code === OUT_OF_CREDITS_CODE) {
        rollbackRejectedTaskStart(conversationId, requestedRunId)
        await useCreditStore.getState().syncFromServer({ force: true })
        throw taskStartRejectedError(errorBody?.error ?? errorBody, OUT_OF_CREDITS_MESSAGE)
      }
      if (errorBody?.code === 'TASK_START_CANCELLED') {
        rollbackRejectedTaskStart(conversationId, requestedRunId)
        throw taskStartRejectedError(errorBody?.error ?? errorBody, 'This task was stopped before it started.')
      }
      if (
        response.status === 409 &&
        typeof errorBody?.runId === 'string'
      ) {
        const conflictRunId = errorBody.runId
        const reconnectingRequestedRun = conflictRunId === requestedRunId
        let activeAssistant = assistantMsg
        let conflictRecord: ActiveRunRecord | undefined
        if (!reconnectingRequestedRun) {
          const conflict = await rebaseToConflictingTaskRun({
            conversationId,
            requestedRunId,
            conflictRunId,
            signal: controller.signal,
          })
          conflictRecord = conflict.record
          activeAssistant = conflict.assistantMessage
          dispatcher = createStoreDispatcher(conversationId, (message) => {
            if (message) useUIStore.getState().addToast(message, 'error')
          }, activeAssistant)
        }
        saveStoredActiveRun(conversationId, {
          runId: conflictRunId,
          assistantMessageId: activeAssistant.id,
          status: typeof errorBody?.status === 'string' ? errorBody.status : conflictRecord?.status,
        })
        const replayResponse = await openKnownTaskRunStream({
          conversationId,
          runId: conflictRunId,
          signal: controller.signal,
        })
        if (reconnectingRequestedRun) {
          acceptPendingTaskStart(conversationId, requestedRunId)
        }
        await consumeTaskResponseForConversation({
          conversationId,
          response: replayResponse,
          controller,
          dispatcher,
          runId: conflictRunId,
          assistantMessageId: activeAssistant.id,
          isFirstResponse: true,
          setStreamError: (message) => {
            if (message) useUIStore.getState().addToast(message, 'error')
          },
        })
        return
      }
      rollbackRejectedTaskStart(conversationId, requestedRunId)
      throw taskStartRejectedError(errorBody?.error ?? errorBody, 'The task could not start. Please try again.')
    }
    const responseRunId = response.headers.get('x-agent-run-id') || requestedRunId
    if (responseRunId !== requestedRunId) {
      rollbackRejectedTaskStart(conversationId, requestedRunId)
      throw taskStartRejectedError(null, 'The task started with an unexpected run id. Please reopen the task before trying again.')
    }
    acceptPendingTaskStart(conversationId, requestedRunId)
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
    if (controller.signal.reason === 'user-stop') return
    if ((error as Error).name !== 'AbortError') {
      const msg = userErrorMessage(error, 'The task could not finish. Please try again.')
      if (!isTaskStartRejectedError(error)) {
        dispatcher.finalizeOnAbort('error', msg)
        if (!lastAssistantHasVisibleResponse(conversationId)) {
          useChatStore.getState().setLastMessageContent(conversationId, msg)
        }
      }
      useUIStore.getState().addToast(msg, 'error')
    }
  } finally {
    startRequestsAwaitingHeaders.delete(conversationId)
    startReservations.delete(conversationId)
    cancelledStartReservations.delete(conversationId)
    window.clearTimeout(startupTimer)
    if (activeControllers.get(conversationId) === controller && !pendingStopRequests.has(conversationId)) {
      useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
      setConversationStreaming(conversationId, false)
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
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const addToast = useUIStore((s) => s.addToast)

  const abortRef = useRef<AbortController | null>(null)
  const directiveSendingRef = useRef(false)
  const resumeActiveTaskRef = useRef<((options?: { includeTerminalReplay?: boolean }) => Promise<boolean>) | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)

  useEffect(() => {
    abortRef.current = activeControllers.get(conversationId) ?? null
    directiveSendingRef.current = false
    setStreamError(null)
    if (pendingStopRequests.has(conversationId)) {
      setConversationStreaming(conversationId, true)
      if (useChatStore.getState().activeId === conversationId) {
        useUIStore.getState().setStreamingStatus('stopping')
      }
    }
    return () => {
      abortRef.current = null
    }
  }, [conversationId])

  const handleStop = useCallback(() => {
    if (pendingStopRequests.has(conversationId)) return
    const controller = activeControllers.get(conversationId) ?? abortRef.current
    const runId = activeRunIds.get(conversationId) ?? getStoredActiveRun(conversationId)?.runId
    const optimisticRunId = useChatStore.getState().conversations
      .find((conversation) => conversation.id === conversationId)
      ?.messages
      .slice()
      .reverse()
      .find((message) => !!message.pendingStartRunId)
      ?.pendingStartRunId
    const hasStartReservation = startReservations.has(conversationId)
    if (!controller && !runId && !hasStartReservation) return
    if (hasStartReservation) {
      cancelledStartReservations.add(conversationId)
    }
    const stopRequest = stopConversationTask({
      conversationId,
      runId,
      startRequestMayHaveReachedServer: startRequestsAwaitingHeaders.has(conversationId),
    })
    pendingStopRequests.set(conversationId, stopRequest)
    setConversationStreaming(conversationId, true)
    if (useChatStore.getState().activeId === conversationId) {
      useUIStore.getState().setStreamingStatus('stopping')
    }
    controller?.abort('user-stop')

    void stopRequest.then(async (outcome) => {
      if (pendingStopRequests.get(conversationId) !== stopRequest) return
      if (outcome.kind === 'terminal' || outcome.kind === 'not-started') {
        const stoppedRunId = outcome.kind === 'terminal' ? outcome.runId : runId || optimisticRunId
        let terminalStartCommitted = outcome.kind === 'terminal'
        if (stoppedRunId) {
          if (outcome.kind === 'terminal' && hasPendingTaskStartMarkers(conversationId, stoppedRunId)) {
            terminalStartCommitted = await rebaseConversationFromServerForRun(conversationId, stoppedRunId)
              .catch(() => false)
            if (!terminalStartCommitted) rollbackRejectedTaskStart(conversationId, stoppedRunId)
          } else if (outcome.kind === 'terminal') {
            acceptPendingTaskStart(conversationId, stoppedRunId)
          } else {
            rollbackRejectedTaskStart(conversationId, stoppedRunId)
          }
        }
        const completedBeforeStop = outcome.kind === 'terminal' && terminalStartCommitted && outcome.status === 'done'
        const terminalWarning = outcome.kind === 'terminal' &&
          terminalStartCommitted &&
          typeof outcome.terminalError === 'string' &&
          outcome.terminalError.trim() &&
          outcome.terminalError.trim() !== 'Task stopped.'
          ? outcome.terminalError.trim()
          : null
        const completedReplayLoaded = completedBeforeStop
          ? await replayCompletedRunAfterStop(conversationId, outcome.runId, setStreamError).catch(() => false)
          : false
        if (!completedBeforeStop || completedReplayLoaded) {
          clearStoredActiveRun(conversationId, outcome.kind === 'terminal' ? outcome.runId : undefined)
        }
        if (terminalStartCommitted) {
          markActiveAssistantInterrupted(
            conversationId,
            completedBeforeStop
              ? completedReplayLoaded
                ? '*Task finished while stopping.*'
                : '*Task finished; reopen to load its final updates.*'
              : terminalWarning
                ? `*Task stopped with a recovery warning.*\n\n${terminalWarning}`
                : '*Task stopped.*',
            completedBeforeStop
              ? completedReplayLoaded
                ? 'The task finished before cancellation completed.'
                : 'The task finished, but its final updates have not loaded yet.'
              : terminalWarning || 'Stopped by the user.',
          )
        }
        useCreditStore.getState().finishTask(conversationId, completedBeforeStop ? 'done' : 'stopped')
        void useCreditStore.getState().syncFromServer({ force: true })
        setStreamError(terminalWarning)
        if (completedBeforeStop && !completedReplayLoaded) {
          addToast('The task finished. Reopen it to load the final updates.', 'info')
        } else if (terminalWarning) {
          addToast(terminalWarning, 'error')
        }
        return
      }

      markActiveAssistantInterrupted(
        conversationId,
        '*Stop could not be confirmed.*',
        'Cancellation could not be confirmed.',
      )
      useCreditStore.getState().finishTask(conversationId, 'error')
      setStreamError(outcome.message)
      addToast(outcome.message, 'error')
    }).finally(() => {
      if (pendingStopRequests.get(conversationId) !== stopRequest) return
      pendingStopRequests.delete(conversationId)
      if (activeControllers.get(conversationId) === controller) {
        activeControllers.delete(conversationId)
      }
      if (abortRef.current === controller) abortRef.current = null
      setConversationStreaming(conversationId, false)
    })
  }, [addToast, conversationId])

  const createDispatcher = useCallback((initialMessage?: Message) => new EventDispatcher(conversationId, {
    appendToLastMessage, appendReasoning,
    setSteps, setTaskGroups, updateTaskGroupStatus,
    addSubtaskToGroup, updateSubtaskInGroup, addGroupNarration,
    setLastMessageContent, setFollowUps, addArtifact,
    addComputerPanelItem, upsertComputerPanelItem, removeComputerPanelItem,
    setComputerPanelOpen, addToast,
  }, setStreamError, initialMessage), [
    conversationId,
    appendToLastMessage, appendReasoning,
    setSteps, setTaskGroups, updateTaskGroupStatus,
    addSubtaskToGroup, updateSubtaskInGroup, addGroupNarration,
    setLastMessageContent, setFollowUps, addArtifact,
    addComputerPanelItem, upsertComputerPanelItem, removeComputerPanelItem,
    setComputerPanelOpen, addToast,
  ])

  const consumeTaskResponse = useCallback((input: {
    response: Response
    controller: AbortController
    dispatcher: EventDispatcher
    runId?: string
    assistantMessageId?: string
    afterSeq?: number
    isFirstResponse?: boolean
    allowTerminalReplay?: boolean
  }) => consumeTaskResponseForConversation({
    ...input,
    conversationId,
    setStreamError,
  }), [conversationId])

  const sendMessage = useCallback(
    async (content: string, isAutoSendOrAttachments: boolean | FileAttachment[] = false) => {
      const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
      if (!conversation) return
      if (conversation.serverSummary || conversation.serverBodyStale) {
        const message = 'This task is still loading its latest history. Please wait a moment and try again.'
        addToast(message, 'error')
        throw new Error(message)
      }

      const isAutoSend = typeof isAutoSendOrAttachments === 'boolean' ? isAutoSendOrAttachments : false
      const attachments = Array.isArray(isAutoSendOrAttachments) ? isAutoSendOrAttachments : undefined
      if (pendingStopRequests.has(conversationId)) {
        throw new Error('This task is still stopping. Please wait for cancellation to finish.')
      }
      if (startReservations.has(conversationId)) {
        if (isAutoSend) return
        throw new Error('This task is still starting. Your message was not sent twice.')
      }
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
        const serverActiveRun = await fetchServerActiveRun(conversationId, {
          includeTerminalReplay: storedActiveRun.status === 'starting',
          runId: storedActiveRun.runId,
        })
        if (serverActiveRun?.runId) {
          if (serverActiveRun.terminal) {
            await resumeActiveTaskRef.current?.({ includeTerminalReplay: true })
            addToast('The previous task finished and its final updates were loaded. Send your message again.', 'info')
            return
          }
          storedActiveRun = serverActiveRun
        } else if (serverActiveRun === null) {
          if (
            storedActiveRun.status === 'starting' &&
            Date.now() - storedActiveRun.startedAt < TASK_START_CONFIRMATION_GRACE_MS
          ) {
            throw new Error('This task start is still being confirmed. Stop it before starting another message.')
          }
          rollbackRejectedTaskStart(conversationId, storedActiveRun.runId)
          storedActiveRun = null
        } else if (storedActiveRun.status === 'starting') {
          throw new Error('This task start could not be confirmed yet. Reopen the task or stop it before sending another message.')
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
        if (directiveSendingRef.current) {
          throw new Error('The previous live instruction is still being sent.')
        }

        directiveSendingRef.current = true
        try {
          const directiveResult = await postLiveDirectiveWithRetry({
            conversationId,
            content: directive,
            directiveId: uuidv4(),
          })
          const now = Date.now()
          const continuationId = directiveResult.continuationMessageId
          addLiveDirectiveExchange(
            conversationId,
            {
              id: directiveResult.directiveId,
              role: 'user' as const,
              content: directiveResult.content,
              timestamp: now,
              liveDirective: {
                directiveId: directiveResult.directiveId,
                part: 'instruction' as const,
                acceptedAt: now,
              },
            },
            {
              id: continuationId,
              role: 'assistant' as const,
              content: '',
              timestamp: now,
              liveDirective: {
                directiveId: directiveResult.directiveId,
                part: 'continuation' as const,
                acceptedAt: now,
              },
              steps: [] as TaskStep[],
              artifacts: [],
              computerPanelData: [] as ComputerPanelItem[],
            }
          )
          if (storedActiveRun?.runId) {
            saveStoredActiveRun(conversationId, {
              runId: storedActiveRun.runId,
              assistantMessageId: continuationId,
            })
          }
          playSend()
          if (!existingController && storedActiveRun) {
            await resumeActiveTaskRef.current?.()
          }
        } catch (error) {
          const msg = userErrorMessage(error, 'Could not send the live instruction.')
          setStreamError(msg)
          addToast(msg, 'error')
          throw error
        } finally {
          directiveSendingRef.current = false
        }
        return
      }

      if (storedActiveRun && isAutoSend) {
        return
      }

      // Abort any existing stream before starting a replacement run. Live
      // mid-task instructions are handled above through /api/chat/directive.
      if (existingController) {
        markActiveAssistantInterrupted(conversationId, '*Interrupted by new message.*', 'Interrupted by a newer user message.')
        existingController.abort()
        useCreditStore.getState().finishTask(conversationId, 'stopped')
        activeControllers.delete(conversationId)
        abortRef.current = null
      }
      startReservations.add(conversationId)
      cancelledStartReservations.delete(conversationId)
      const requestedRunId = uuidv4()

      let userMsg: Message | undefined
      if (!isAutoSend) {
        userMsg = {
          id: uuidv4(),
          role: 'user' as const,
          content: boundedContent,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          timestamp: Date.now(),
          pendingStartRunId: requestedRunId,
        }
        if (attachments && attachments.length > 0) {
          await bindAttachmentsToTask(attachments, conversationId, userMsg.id)
            .catch((error) => {
              startReservations.delete(conversationId)
              if (cancelledStartReservations.delete(conversationId)) {
                throw Object.assign(new Error('Task stopped.'), { name: 'AbortError' })
              }
              const msg = error instanceof Error && error.message
                ? error.message
                : "Your attachments couldn't be linked to this task."
              addToast(msg, 'error')
              throw error
            })
        }
        if (cancelledStartReservations.delete(conversationId)) {
          startReservations.delete(conversationId)
          throw Object.assign(new Error('Task stopped.'), { name: 'AbortError' })
        }
        addMessage(conversationId, userMsg)
        playSend()
      }

      const assistantMsg: Message = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        pendingStartRunId: requestedRunId,
        steps: [] as TaskStep[],
        artifacts: [],
        computerPanelData: [] as ComputerPanelItem[],
      }
      addMessage(conversationId, assistantMsg)

      const messagesToSend = isAutoSend
        ? conversation.messages
        : [...conversation.messages, userMsg!]
      const allMessages = messagesToSend.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
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

      if (useChatStore.getState().activeId === conversationId) {
        useUIStore.getState().resetComputerPanelAutoOpenSuppression()
        setConversationStreaming(conversationId, true)
        useUIStore.getState().setStreamingStatus(startFreshSandbox ? 'startup' : 'thinking')
      }
      useCreditStore.getState().startTask(conversationId, {
        chargeStart: false,
        accountingMode: 'server',
      })

      let dispatcher = createDispatcher()

      const isFirstResponse = conversation.messages.length <= 1

      const controller = new AbortController()
      abortRef.current = controller
      activeControllers.set(conversationId, controller)

      const startupTimer = window.setTimeout(() => {
        if (
          activeControllers.get(conversationId) === controller &&
          useChatStore.getState().activeId === conversationId &&
          useUIStore.getState().streamingStatus === 'startup'
        ) {
          useUIStore.getState().setStreamingStatus('thinking')
        }
      }, 1500)

      try {
        if (controller.signal.aborted) {
          throw Object.assign(new Error('Task stopped.'), { name: 'AbortError' })
        }

        saveStoredActiveRun(conversationId, {
          runId: requestedRunId,
          assistantMessageId: assistantMsg.id,
          status: 'starting',
        })
        startRequestsAwaitingHeaders.add(conversationId)
        let response: Response
        try {
          response = await postTaskStartWithStableRunId({
            runId: requestedRunId,
            assistantMessageId: assistantMsg.id,
            messages: allMessages,
            model: currentModel,
            conversationId,
            customInstructions,
            startFreshSandbox,
          }, controller.signal)
        } catch (postError) {
          startRequestsAwaitingHeaders.delete(conversationId)
          if (controller.signal.aborted) throw postError
          try {
            const replayResponse = await openKnownTaskRunStream({
              conversationId,
              runId: requestedRunId,
              signal: controller.signal,
            })
            acceptPendingTaskStart(conversationId, requestedRunId)
            await consumeTaskResponse({
              response: replayResponse,
              controller,
              dispatcher,
              runId: requestedRunId,
              assistantMessageId: assistantMsg.id,
              isFirstResponse,
            })
            return
          } catch (recoveryError) {
            throw recoveryError
          }
        }
        startRequestsAwaitingHeaders.delete(conversationId)
        startReservations.delete(conversationId)

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null) as {
            error?: unknown
            code?: unknown
            conversationId?: unknown
            runId?: unknown
            status?: unknown
          } | null
          if (
            response.status === 402 ||
            errorBody?.code === OUT_OF_CREDITS_CODE
          ) {
            rollbackRejectedTaskStart(conversationId, requestedRunId)
            await useCreditStore.getState().syncFromServer({ force: true })
            throw taskStartRejectedError(errorBody?.error ?? errorBody, OUT_OF_CREDITS_MESSAGE)
          }
          if (errorBody?.code === 'TASK_START_CANCELLED') {
            rollbackRejectedTaskStart(conversationId, requestedRunId)
            throw taskStartRejectedError(errorBody?.error ?? errorBody, 'This task was stopped before it started.')
          }
          if (
            response.status === 409 &&
            typeof errorBody?.runId === 'string'
          ) {
            const conflictRunId = errorBody.runId
            const reconnectingRequestedRun = conflictRunId === requestedRunId
            let conflictRecord: ActiveRunRecord | undefined
            if (!reconnectingRequestedRun) {
              const conflict = await rebaseToConflictingTaskRun({
                conversationId,
                requestedRunId,
                conflictRunId,
                signal: controller.signal,
              })
              conflictRecord = conflict.record
              dispatcher = createDispatcher(conflict.assistantMessage)
            }
            let currentAssistant = reconnectingRequestedRun
              ? assistantMsg
              : assistantMessageForRun(conversationId, conflictRunId)
            if (!currentAssistant) {
              throw taskStartRejectedError(
                null,
                'Another tab is running this task, but its committed assistant could not be loaded. Reopen the task to reconnect.',
              )
            }
            saveStoredActiveRun(conversationId, {
              runId: conflictRunId,
              assistantMessageId: currentAssistant?.id,
              status: typeof errorBody?.status === 'string' ? errorBody.status : conflictRecord?.status,
            })
            const afterSeq = currentAssistant?.streamRunId === conflictRunId
              ? currentAssistant.streamSeq || 0
              : 0
            const replayResponse = await openKnownTaskRunStream({
              conversationId,
              runId: conflictRunId,
              signal: controller.signal,
              afterSeq,
            })
            if (reconnectingRequestedRun) {
              acceptPendingTaskStart(conversationId, requestedRunId)
            }
            if (!reconnectingRequestedRun) {
              addToast('Another tab already had this task running. Your new message was not sent; this view is reconnected.', 'error')
            }
            await consumeTaskResponse({
              response: replayResponse,
              controller,
              dispatcher,
              runId: conflictRunId,
              assistantMessageId: currentAssistant?.id,
              afterSeq,
              isFirstResponse,
            })
            return
          }
          rollbackRejectedTaskStart(conversationId, requestedRunId)
          throw taskStartRejectedError(errorBody?.error ?? errorBody, 'The task could not start. Please try again.')
        }
        const responseRunId = response.headers.get('x-agent-run-id') || requestedRunId
        if (responseRunId !== requestedRunId) {
          rollbackRejectedTaskStart(conversationId, requestedRunId)
          throw taskStartRejectedError(null, 'The task started with an unexpected run id. Please reopen the task before trying again.')
        }
        acceptPendingTaskStart(conversationId, requestedRunId)
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
        if (controller.signal.reason === 'user-stop') return
        if ((error as Error).name !== 'AbortError') {
          const msg = userErrorMessage(error, 'The task could not finish. Please try again.')
          if (!isTaskStartRejectedError(error)) {
            dispatcher.finalizeOnAbort('error', msg)
          }
          setStreamError(msg)
          addToast(msg, 'error')
        }
      } finally {
        startRequestsAwaitingHeaders.delete(conversationId)
        startReservations.delete(conversationId)
        cancelledStartReservations.delete(conversationId)
        window.clearTimeout(startupTimer)
        if (activeControllers.get(conversationId) === controller && !pendingStopRequests.has(conversationId)) {
          useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
          setConversationStreaming(conversationId, false)
          activeControllers.delete(conversationId)
          if (dispatcher.hasTerminalEvent()) activeRunIds.delete(conversationId)
          abortRef.current = null
        }
      }
    },
    [
      conversationId,
      addMessage, addLiveDirectiveExchange,
      addToast,
      createDispatcher, consumeTaskResponse,
    ]
  )

  const resumeActiveTask = useCallback(async (options: { includeTerminalReplay?: boolean } = {}): Promise<boolean> => {
    if (pendingStopRequests.has(conversationId)) return true
    if (startReservations.has(conversationId)) return true
    if (activeControllers.has(conversationId)) return true
    const conversation = useChatStore.getState().conversations.find(c => c.id === conversationId)
    if (!conversation) return false
    const latestMessage = conversation.messages[conversation.messages.length - 1]
    const persistedCursorRecord: ActiveRunRecord | null = latestMessage?.role === 'assistant' && latestMessage.streamRunId
      ? {
          runId: latestMessage.streamRunId,
          conversationId,
          lastSeq: Math.max(0, latestMessage.streamSeq || 0),
          startedAt: latestMessage.timestamp,
          assistantMessageId: latestMessage.id,
        }
      : null
    const storedRecord = persistedCursorRecord || getStoredActiveRun(conversationId)
    const serverRecord = await fetchServerActiveRun(conversationId, {
      ...options,
      runId: storedRecord?.runId,
    })
    if (
      !storedRecord?.runId &&
      options.includeTerminalReplay &&
      latestMessage?.role === 'user' &&
      serverRecord?.terminal &&
      serverRecord.startedAt < latestMessage.timestamp
    ) {
      return false
    }
    const record = serverRecord === undefined ? storedRecord : serverRecord
    if (serverRecord === null && storedRecord) {
      if (
        storedRecord.status === 'starting' &&
        Date.now() - storedRecord.startedAt < TASK_START_CONFIRMATION_GRACE_MS
      ) {
        setStreamError('This task start is still being confirmed. Stop it if you need to start over.')
        return true
      }
      rollbackRejectedTaskStart(conversationId, storedRecord.runId)
    }
    if (!record?.runId) return false

    let assistantMessage: Message | undefined = record.assistantMessageId
      ? conversation.messages.find((message) => message.id === record.assistantMessageId && message.role === 'assistant')
      : undefined
    assistantMessage ||= [...conversation.messages].reverse().find(message => message.role === 'assistant')
    if (!assistantMessage) {
      const assistantMsg = {
        id: uuidv4(),
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        steps: [] as TaskStep[],
        artifacts: [],
        computerPanelData: [] as ComputerPanelItem[],
      }
      assistantMessage = assistantMsg
      addMessage(conversationId, assistantMsg)
    }
    const assistantMessageId = assistantMessage.id

    const controller = new AbortController()
    abortRef.current = controller
    activeControllers.set(conversationId, controller)
    activeRunIds.set(conversationId, record.runId)
    setStreamError(null)
    setConversationStreaming(conversationId, true)
    if (useChatStore.getState().activeId === conversationId) {
      useUIStore.getState().setStreamingStatus('thinking')
    }
    useCreditStore.getState().startTask(conversationId, {
      chargeStart: false,
      accountingMode: 'server',
    })

    const persistedCursor = assistantMessage.streamRunId === record.runId
      ? Math.max(0, assistantMessage.streamSeq || 0)
      : null
    const afterSeq = persistedCursor ?? (lastAssistantHasVisibleResponse(conversationId) ? record.lastSeq : 0)
    const dispatcher = createDispatcher(assistantMessage)
    let invalidRun = false

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
        invalidRun = response.status === 404 || response.status === 410
        throw new Error(userErrorMessage(errorBody?.error ?? errorBody, 'Could not reconnect to the task.'))
      }

      await consumeTaskResponse({
        response,
        controller,
        dispatcher,
        runId: record.runId,
        assistantMessageId,
        afterSeq,
      })
      return true
    } catch (error) {
      if (activeControllers.get(conversationId) !== controller) return false
      if (controller.signal.reason === 'user-stop') return false
      if ((error as Error).name !== 'AbortError') {
        if (invalidRun) clearStoredActiveRun(conversationId, record.runId)
        const msg = userErrorMessage(error, 'Could not reconnect to the task.')
        setStreamError(msg)
        addToast(msg, 'error')
      }
      return false
    } finally {
      if (activeControllers.get(conversationId) === controller && !pendingStopRequests.has(conversationId)) {
        useCreditStore.getState().finishTask(conversationId, dispatcher.getTerminalStatus() ?? 'stopped')
        setConversationStreaming(conversationId, false)
        activeControllers.delete(conversationId)
        if (dispatcher.hasTerminalEvent()) activeRunIds.delete(conversationId)
        abortRef.current = null
      }
    }
  }, [
    conversationId,
    addMessage,
    createDispatcher,
    consumeTaskResponse,
    addToast,
  ])

  resumeActiveTaskRef.current = resumeActiveTask

  const clearError = useCallback(() => setStreamError(null), [])

  return { sendMessage, handleStop, resumeActiveTask, streamError, clearError }
}
