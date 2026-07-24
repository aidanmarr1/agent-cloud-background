'use client'

import type { BrowserResult, ComputerPanelItem, Conversation } from '@/types'
import { normalizeConversationForPersistence, normalizeConversationListForPersistence } from '@/lib/conversationSerialization'
import { onStoreHydrated, resetStoreHydration, signalStoreHydrated } from '@/lib/storeHydration'
import type { ChatStore } from './types'
import { clearLegacyChatPersistence, readLegacyChatPersistedState } from './persistence'

type ChatStoreApi = {
  getState: () => ChatStore
  setState: (partial: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)) => void
  subscribe: (listener: (state: ChatStore, previousState: ChatStore) => void) => () => void
}

type ServerConversationRecord = Partial<Conversation> & {
  id?: unknown
  title?: unknown
  starred?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

interface ServerConversationState {
  conversations?: ServerConversationRecord[]
  deletedIds?: string[]
  folders?: string[]
  partial?: boolean
}

interface ServerConversationBodyState {
  conversation?: ServerConversationRecord | null
}

interface ServerConversationSyncResponse {
  ok?: boolean
  conversations?: ServerConversationRecord[]
}

const SAVE_DEBOUNCE_MS = 250
// Cross-tab history refresh remains immediate on focus/visibility. A slower
// background safety poll avoids saturating the same remote database connection
// used by active task leases and event persistence.
const REFRESH_INTERVAL_MS = 30_000
const REFRESH_THROTTLE_MS = 1_500
const SYNC_MANAGER_READY_WAIT_MS = 4_000
const SYNC_MANAGER_READY_POLL_MS = 50
const TASK_RUN_REBASE_RETRY_DELAYS_MS = [0, 75, 150, 300, 600, 1_000, 1_500, 2_500] as const
const SAVE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

let storeApi: ChatStoreApi | null = null
let currentUserId: string | null = null
let unsubscribe: (() => void) | null = null
let suppressStoreListener = false
let hydrated = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlightPromise: Promise<void> | null = null
let saveQueued = false
let legacyImported = false
let legacyImportStarted = false
let refreshInFlight: { generation: number; userId: string } | null = null
let lastRefreshAt = 0
let refreshTimer: ReturnType<typeof setInterval> | null = null
let syncGeneration = 0
let lastSavedFolders = '[]'
let saveRetryAttempt = 0

const knownConversationIds = new Set<string>()
const lastSavedUpdatedAt = new Map<string, number>()

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

function mergeFolders(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((folder) => typeof folder === 'string' && folder.trim()))]
}

function foldersFingerprint(folders: string[]): string {
  return JSON.stringify(folders.filter((folder) => typeof folder === 'string' && folder.trim()))
}

function isCurrentSync(generation: number, userId: string | null): boolean {
  return generation === syncGeneration && userId !== null && currentUserId === userId
}

function isServerSummaryConversation(conversation: Conversation): boolean {
  return conversation.serverSummary === true
}

function conversationVersionIsOlder(candidate: Conversation, existing: Conversation): boolean {
  const candidateRevision = candidate.serverRevision || 0
  const existingRevision = existing.serverRevision || 0
  if (candidateRevision !== existingRevision && (candidateRevision > 0 || existingRevision > 0)) {
    return candidateRevision < existingRevision
  }
  return candidate.updatedAt < existing.updatedAt
}

function conversationVersionIsNewer(candidate: Conversation, existing: Conversation): boolean {
  const candidateRevision = candidate.serverRevision || 0
  const existingRevision = existing.serverRevision || 0
  if (candidateRevision !== existingRevision && (candidateRevision > 0 || existingRevision > 0)) {
    return candidateRevision > existingRevision
  }
  return candidate.updatedAt > existing.updatedAt
}

function finiteNumber(value: unknown, fallback: number): number {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function serverRecordToConversation(record: ServerConversationRecord, summary: boolean): Conversation | null {
  if (!record || typeof record.id !== 'string' || !record.id.trim()) return null
  const now = Date.now()
  const createdAt = finiteNumber(record.createdAt, now)
  const updatedAt = finiteNumber(record.updatedAt, createdAt)
  const serverRevision = finiteNumber(record.serverRevision, 0)
  const hasMessages = Array.isArray(record.messages)
  const conversation: Conversation = {
    id: record.id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : 'New task',
    messages: hasMessages ? record.messages as Conversation['messages'] : [],
    starred: record.starred === true,
    createdAt,
    updatedAt,
    serverRevision: Number.isInteger(serverRevision) && serverRevision > 0 ? serverRevision : undefined,
    customInstructions: typeof record.customInstructions === 'string' ? record.customInstructions : undefined,
    branches: Array.isArray(record.branches) ? record.branches as Conversation['branches'] : undefined,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    folder: typeof record.folder === 'string' ? record.folder : undefined,
  }

  if (summary || record.serverSummary === true || !hasMessages) {
    return { ...conversation, serverSummary: true }
  }
  return normalizeConversationForPersistence(conversation)
}

function normalizeServerConversations(records: ServerConversationRecord[] | undefined, partial: boolean): Conversation[] {
  if (!Array.isArray(records)) return []
  return records
    .map((record) => serverRecordToConversation(record, partial && !Array.isArray(record.messages)))
    .filter((conversation): conversation is Conversation => conversation !== null)
}

function mergeNewerSummaryMetadata(
  existing: Conversation,
  summary: Conversation,
  serverBodyStale: boolean,
): Conversation {
  return {
    ...existing,
    title: summary.title,
    starred: summary.starred,
    folder: summary.folder,
    createdAt: Math.min(existing.createdAt, summary.createdAt),
    updatedAt: summary.updatedAt,
    serverRevision: summary.serverRevision ?? existing.serverRevision,
    serverSummary: true,
    ...(serverBodyStale ? { serverBodyStale: true } : {}),
  }
}

function latestLocalBrowserFrame(
  conversation: Conversation,
): { messageId: string; item: ComputerPanelItem; data: BrowserResult } | null {
  for (let messageIndex = conversation.messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = conversation.messages[messageIndex]
    const panelItems = message.computerPanelData || []
    for (let itemIndex = panelItems.length - 1; itemIndex >= 0; itemIndex--) {
      const item = panelItems[itemIndex]
      if (item.id !== 'browser_live' || item.type !== 'browser') continue
      const data = item.data as BrowserResult
      if (typeof data.screenshotBase64 !== 'string' || !data.screenshotBase64) continue
      return { messageId: message.id, item, data }
    }
  }
  return null
}

function preserveLocalBrowserFrame(
  conversation: Conversation,
  local: Conversation,
): Conversation {
  const frame = latestLocalBrowserFrame(local)
  if (!frame) return conversation

  let targetMessageIndex = conversation.messages.findIndex((message) => message.id === frame.messageId)
  if (targetMessageIndex < 0) {
    for (let index = conversation.messages.length - 1; index >= 0; index--) {
      if (conversation.messages[index].computerPanelData?.some((item) => item.id === 'browser_live')) {
        targetMessageIndex = index
        break
      }
    }
  }
  if (targetMessageIndex < 0) {
    for (let index = conversation.messages.length - 1; index >= 0; index--) {
      if (conversation.messages[index].role === 'assistant') {
        targetMessageIndex = index
        break
      }
    }
  }
  if (targetMessageIndex < 0) return conversation

  const messages = [...conversation.messages]
  const targetMessage = messages[targetMessageIndex]
  const panelItems = [...(targetMessage.computerPanelData || [])]
  const existingIndex = panelItems.findIndex((item) => item.id === 'browser_live')
  if (existingIndex < 0) {
    panelItems.push(frame.item)
  } else {
    const existing = panelItems[existingIndex]
    panelItems[existingIndex] = {
      ...existing,
      timestamp: Math.max(existing.timestamp, frame.item.timestamp),
      streaming: frame.item.streaming,
      data: {
        ...(existing.data as BrowserResult),
        screenshotBase64: frame.data.screenshotBase64,
        liveFrame: frame.data.liveFrame,
        liveFrameUpdatedAt: frame.data.liveFrameUpdatedAt,
      },
    }
  }
  messages[targetMessageIndex] = { ...targetMessage, computerPanelData: panelItems }
  return { ...conversation, messages }
}

function mergeConversations(local: Conversation[], remote: Conversation[], deletedIds: string[] = []): Conversation[] {
  const deleted = new Set(deletedIds)
  const byId = new Map<string, Conversation>()

  for (const conversation of local) {
    if (!deleted.has(conversation.id)) byId.set(conversation.id, conversation)
  }

  for (const conversation of remote) {
    if (deleted.has(conversation.id)) continue
    const existing = byId.get(conversation.id)
    if (!existing) {
      byId.set(conversation.id, conversation)
      continue
    }

    if (isServerSummaryConversation(conversation)) {
      const summaryIsNewer = conversationVersionIsNewer(conversation, existing)
      if (summaryIsNewer) {
        if (isServerSummaryConversation(existing)) {
          byId.set(
            conversation.id,
            existing.serverBodyStale
              ? mergeNewerSummaryMetadata(existing, conversation, true)
              : conversation,
          )
        } else {
          // Keep the existing body available in memory until the route loads
          // the replacement, but fence it from persistence immediately. The
          // newer summary proves this local body is stale.
          byId.set(conversation.id, mergeNewerSummaryMetadata(existing, conversation, true))
        }
      } else if (isServerSummaryConversation(existing) && !conversationVersionIsOlder(conversation, existing)) {
        byId.set(
          conversation.id,
          existing.serverBodyStale
            ? mergeNewerSummaryMetadata(existing, conversation, true)
            : conversation,
        )
      }
      continue
    }

    if (isServerSummaryConversation(existing)) {
      const wouldBypassStaleFence = existing.serverBodyStale && conversationVersionIsOlder(conversation, existing)
      if (!wouldBypassStaleFence) {
        byId.set(conversation.id, preserveLocalBrowserFrame(conversation, existing))
      }
      continue
    }

    if (!conversationVersionIsOlder(conversation, existing)) {
      byId.set(conversation.id, preserveLocalBrowserFrame(conversation, existing))
    }
  }

  return sortConversations(Array.from(byId.values()))
}

function noteServerState(conversations: Conversation[], deletedIds: string[] = []): void {
  for (const conversation of conversations) {
    knownConversationIds.add(conversation.id)
    lastSavedUpdatedAt.set(conversation.id, conversation.updatedAt)
  }
  for (const id of deletedIds) {
    knownConversationIds.delete(id)
    lastSavedUpdatedAt.delete(id)
  }
}

async function fetchServerState(): Promise<ServerConversationState> {
  const response = await fetch('/api/conversations', {
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load task history.')
  }
  return response.json() as Promise<ServerConversationState>
}

async function fetchServerConversation(
  conversationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Conversation | null> {
  const response = await fetch(`/api/conversations?id=${encodeURIComponent(conversationId)}`, {
    cache: 'no-store',
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load task.')
  }
  const body = await response.json() as ServerConversationBodyState
  return body.conversation ? serverRecordToConversation(body.conversation, false) : null
}

function conversationContainsRun(conversation: Conversation, runId: string): boolean {
  return conversation.messages.some((message) => (
    message.role === 'assistant' && message.streamRunId === runId
  ))
}

async function waitForTaskRunRebaseRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw Object.assign(new Error('Task stream stopped.'), { name: 'AbortError' })
  }
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(Object.assign(new Error('Task stream stopped.'), { name: 'AbortError' }))
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function conversationForServerSync(conversation: Conversation): Conversation {
  return normalizeConversationForPersistence({
    ...conversation,
    messages: conversation.messages.filter((message) => !message.pendingStartRunId),
  })
}

function getChangedConversations(state: ChatStore): Conversation[] {
  return state.conversations
    .filter((conversation) => (
      !isServerSummaryConversation(conversation) &&
      conversation.serverBodyStale !== true &&
      (
        !knownConversationIds.has(conversation.id) ||
        (lastSavedUpdatedAt.get(conversation.id) ?? -1) !== conversation.updatedAt
      )
    ))
    .map(conversationForServerSync)
}

function getDeletedIds(state: ChatStore): string[] {
  const currentIds = new Set(state.conversations.map((conversation) => conversation.id))
  return Array.from(knownConversationIds).filter((id) => !currentIds.has(id))
}

function localAssistantHasStrictlyNewerCursor(server: Conversation['messages'][number], local: Conversation['messages'][number]): boolean {
  if (server.role !== 'assistant' || local.role !== 'assistant') return false
  const serverRunId = typeof server.streamRunId === 'string' ? server.streamRunId : ''
  const localRunId = typeof local.streamRunId === 'string' ? local.streamRunId : ''
  const serverSeq = Number.isFinite(server.streamSeq) ? Number(server.streamSeq) : 0
  const localSeq = Number.isFinite(local.streamSeq) ? Number(local.streamSeq) : 0
  if (!localRunId || localSeq <= 0) return false
  if (!serverRunId) return true
  return localRunId === serverRunId && localSeq > serverSeq
}

function localAssistantHasMonotonicTerminalState(
  server: Conversation['messages'][number],
  local: Conversation['messages'][number],
): boolean {
  if (
    server.role !== 'assistant' ||
    local.role !== 'assistant' ||
    !local.streamTerminalStatus ||
    server.streamTerminalStatus
  ) return false
  const serverRunId = typeof server.streamRunId === 'string' ? server.streamRunId : ''
  const localRunId = typeof local.streamRunId === 'string' ? local.streamRunId : ''
  const serverSeq = Number.isFinite(server.streamSeq) ? Number(server.streamSeq) : 0
  const localSeq = Number.isFinite(local.streamSeq) ? Number(local.streamSeq) : 0
  return !!localRunId && localRunId === serverRunId && localSeq >= serverSeq
}

function mergeCanonicalRunRebase(
  server: Conversation,
  current: Conversation,
  runId: string,
): { conversation: Conversation; localAdvanced: boolean } {
  const localById = new Map(current.messages.map((message) => [message.id, message]))
  let localAdvanced = false
  const messages = server.messages.map((serverMessage) => {
    if (serverMessage.role !== 'assistant' || serverMessage.streamRunId !== runId) return serverMessage
    const localMessage = localById.get(serverMessage.id)
    if (
      !localMessage ||
      localMessage.role !== 'assistant' ||
      localMessage.streamRunId !== runId ||
      (
        !localAssistantHasStrictlyNewerCursor(serverMessage, localMessage) &&
        !localAssistantHasMonotonicTerminalState(serverMessage, localMessage)
      )
    ) {
      return serverMessage
    }

    localAdvanced = true
    const { pendingStartRunId: _pendingStartRunId, ...durableLocalMessage } = localMessage
    void _pendingStartRunId
    return {
      ...durableLocalMessage,
      streamTerminalStatus: serverMessage.streamTerminalStatus || durableLocalMessage.streamTerminalStatus,
      liveDirective: serverMessage.liveDirective || durableLocalMessage.liveDirective,
    }
  })

  return {
    conversation: preserveLocalBrowserFrame(
      localAdvanced
        ? normalizeConversationForPersistence({
            ...server,
            messages,
            updatedAt: Math.max(current.updatedAt, server.updatedAt + 1),
          })
        : server,
      current,
    ),
    localAdvanced,
  }
}

function withoutPendingStartMarker(
  message: Conversation['messages'][number],
): Conversation['messages'][number] {
  if (!message.pendingStartRunId) return message
  const { pendingStartRunId: _pendingStartRunId, ...acceptedMessage } = message
  void _pendingStartRunId
  return acceptedMessage
}

export function mergeSyncAcknowledgement(
  current: Conversation,
  server: Conversation,
  submitted: Conversation,
): { conversation: Conversation; localAdvanced: boolean } {
  const persistenceVersionUnchanged = (
    current.updatedAt === submitted.updatedAt &&
    current.serverRevision === submitted.serverRevision
  )
  const contentUnchanged = persistenceVersionUnchanged || (
    JSON.stringify(conversationForServerSync(current)) === JSON.stringify(submitted)
  )
  if (contentUnchanged) {
    const serverIds = new Set(server.messages.map((message) => message.id))
    const rebasedMessages = submitted.messages.filter((message) => !serverIds.has(message.id))
    const rebasedIds = new Set(rebasedMessages.map((message) => message.id))
    const pendingMessages = current.messages.filter((message) => (
      !!message.pendingStartRunId &&
      !serverIds.has(message.id) &&
      !rebasedIds.has(message.id)
    ))
    if (rebasedMessages.length > 0) {
      // The server intentionally rejects unknown IDs submitted from a stale
      // base revision. Keep the local suffix, adopt the returned canonical
      // revision, and schedule one compare-and-swap retry against that base.
      // Optimistic task-start messages never enter `submitted` because
      // conversationForServerSync filters their pendingStartRunId markers.
      return {
        conversation: preserveLocalBrowserFrame(
          normalizeConversationForPersistence({
            ...server,
            messages: [...server.messages, ...rebasedMessages, ...pendingMessages],
            updatedAt: Math.max(current.updatedAt, server.updatedAt + 1),
          }),
          current,
        ),
        localAdvanced: true,
      }
    }
    if (pendingMessages.length > 0) {
      return {
        conversation: preserveLocalBrowserFrame(
          {
            ...server,
            messages: [...server.messages, ...pendingMessages],
          },
          current,
        ),
        localAdvanced: false,
      }
    }
    return {
      conversation: preserveLocalBrowserFrame(server, current),
      localAdvanced: false,
    }
  }

  // `submitted` is the merge base for this acknowledgement. If a message was
  // submitted but disappeared from `current` while the request was in flight,
  // that absence is a local deletion (for example, branching/truncation). Keep
  // server-only IDs, but do not resurrect the acknowledged base message.
  const currentIds = new Set(current.messages.map((message) => message.id))
  const locallyDeletedIds = new Set(
    submitted.messages
      .filter((message) => !currentIds.has(message.id))
      .map((message) => message.id),
  )
  const messages = server.messages.filter((message) => !locallyDeletedIds.has(message.id))
  const indexById = new Map(messages.map((message, index) => [message.id, index]))
  for (const localMessage of current.messages) {
    const serverIndex = indexById.get(localMessage.id)
    if (serverIndex === undefined) {
      indexById.set(localMessage.id, messages.length)
      messages.push(localMessage)
      continue
    }
    const serverMessage = messages[serverIndex]
    if (serverMessage.role !== localMessage.role) continue
    // The canonical response proves that this exact message ID is durable.
    // Never copy its local-only optimistic marker back onto the acknowledged
    // message, or the next upload would filter the entire accepted message out.
    const durableLocalMessage = withoutPendingStartMarker(localMessage)

    if (serverMessage.liveDirective?.outcome === 'rejected') {
      messages[serverIndex] = { ...serverMessage, pinned: durableLocalMessage.pinned }
    } else if (
      serverMessage.role === 'assistant' &&
      (
        localAssistantHasStrictlyNewerCursor(serverMessage, durableLocalMessage) ||
        localAssistantHasMonotonicTerminalState(serverMessage, durableLocalMessage)
      )
    ) {
      messages[serverIndex] = {
        ...durableLocalMessage,
        liveDirective: serverMessage.liveDirective || durableLocalMessage.liveDirective,
      }
    } else if (serverMessage.role === 'user' && !serverMessage.liveDirective) {
      messages[serverIndex] = durableLocalMessage
    } else {
      messages[serverIndex] = { ...serverMessage, pinned: durableLocalMessage.pinned }
    }
  }

  return {
    conversation: preserveLocalBrowserFrame(
      normalizeConversationForPersistence({
        ...server,
        ...current,
        messages,
        serverRevision: server.serverRevision,
        updatedAt: Math.max(current.updatedAt, server.updatedAt + 1),
      }),
      current,
    ),
    localAdvanced: true,
  }
}

export function conversationPersistenceVersionsMatch(
  current: Conversation[],
  previous: Conversation[],
): boolean {
  if (current.length !== previous.length) return false
  const previousById = new Map(previous.map((conversation) => [conversation.id, conversation]))
  return current.every((conversation) => {
    const prior = previousById.get(conversation.id)
    return !!prior &&
      conversation.updatedAt === prior.updatedAt &&
      conversation.serverRevision === prior.serverRevision &&
      conversation.serverSummary === prior.serverSummary &&
      conversation.serverBodyStale === prior.serverBodyStale
  })
}

async function postSyncNow(): Promise<void> {
  if (!storeApi || !hydrated) return
  if (saveInFlightPromise) {
    saveQueued = true
    await saveInFlightPromise
    if (storeApi && hydrated) await postSyncNow()
    return
  }

  const api = storeApi
  const userId = currentUserId
  const generation = syncGeneration
  if (!userId) return
  const state = api.getState()
  const conversations = getChangedConversations(state)
  const deletedIds = getDeletedIds(state)
  const folders = state.folders
  const nextFoldersFingerprint = foldersFingerprint(folders)

  if (
    conversations.length === 0 &&
    deletedIds.length === 0 &&
    nextFoldersFingerprint === lastSavedFolders
  ) {
    saveRetryAttempt = 0
    if (legacyImported) {
      await clearLegacyChatPersistence().catch(() => undefined)
      legacyImported = false
    }
    return
  }

  const operation = (async () => {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations, deletedIds, folders }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' ? body.error : 'Could not save task history.')
    }
    const responseBody = await response.json().catch(() => null) as ServerConversationSyncResponse | null
    if (!isCurrentSync(generation, userId)) return
    const reconciled = normalizeServerConversations(responseBody?.conversations, false)
    const submittedById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
    const reconciledById = new Map(reconciled.map((conversation) => [conversation.id, conversation]))
    let localAdvanced = false
    try {
      suppressStoreListener = true
      api.setState((currentState) => ({
        conversations: sortConversations(currentState.conversations.map((current) => {
          const server = reconciledById.get(current.id)
          const submitted = submittedById.get(current.id)
          if (!server || !submitted) return current
          const merged = mergeSyncAcknowledgement(current, server, submitted)
          if (merged.localAdvanced) localAdvanced = true
          return merged.conversation
        })),
      }))
    } finally {
      suppressStoreListener = false
    }
    noteServerState(reconciled, deletedIds)
    lastSavedFolders = nextFoldersFingerprint
    if (localAdvanced) scheduleSave(0)
    if (legacyImported) {
      await clearLegacyChatPersistence().catch(() => undefined)
      legacyImported = false
    }
  })()
  saveInFlightPromise = operation
  try {
    await operation
    if (isCurrentSync(generation, userId)) saveRetryAttempt = 0
  } catch (error) {
    if (isCurrentSync(generation, userId)) scheduleSaveRetry()
    throw error
  } finally {
    if (saveInFlightPromise === operation) {
      saveInFlightPromise = null
      if (saveQueued && isCurrentSync(generation, userId)) {
        saveQueued = false
        scheduleSave(0)
      }
    }
  }
}

function scheduleSave(delay = SAVE_DEBOUNCE_MS): void {
  if (!hydrated) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void postSyncNow().catch((error) => {
      console.error('[ChatSync] Failed to save task history:', error)
    })
  }, delay)
}

function scheduleSaveRetry(): void {
  const retryIndex = Math.min(saveRetryAttempt, SAVE_RETRY_DELAYS_MS.length - 1)
  saveRetryAttempt += 1
  scheduleSave(SAVE_RETRY_DELAYS_MS[retryIndex])
}

async function waitForStoreHydration(): Promise<void> {
  if (hydrated) return
  if (!storeApi) return
  await new Promise<void>((resolve) => {
    let unsubscribeHydration: (() => void) | null = null
    unsubscribeHydration = onStoreHydrated(() => {
      unsubscribeHydration?.()
      resolve()
    })
  })
}

async function waitForSyncManagerReady(): Promise<void> {
  if (storeApi) return
  const startedAt = Date.now()
  await new Promise<void>((resolve) => {
    const timer = window.setInterval(() => {
      if (storeApi || Date.now() - startedAt >= SYNC_MANAGER_READY_WAIT_MS) {
        window.clearInterval(timer)
        resolve()
      }
    }, SYNC_MANAGER_READY_POLL_MS)
  })
}

async function refreshFromServer(force = false): Promise<void> {
  if (!storeApi || !hydrated || refreshInFlight) return
  const api = storeApi
  const userId = currentUserId
  const generation = syncGeneration
  if (!userId) return
  const now = Date.now()
  if (!force && now - lastRefreshAt < REFRESH_THROTTLE_MS) return

  const refreshToken = { generation, userId }
  refreshInFlight = refreshToken
  lastRefreshAt = now
  try {
    const serverState = await fetchServerState()
    const remoteConversations = normalizeServerConversations(serverState.conversations, serverState.partial === true)
    const deletedIds = serverState.deletedIds || []
    const remoteFolders = serverState.folders || []
    if (!isCurrentSync(generation, userId)) return

    noteServerState(remoteConversations, deletedIds)
    lastSavedFolders = foldersFingerprint(remoteFolders)

    try {
      suppressStoreListener = true
      api.setState((state) => {
        const conversations = mergeConversations(state.conversations, remoteConversations, deletedIds)
        const activeId = state.activeId && conversations.some((conversation) => conversation.id === state.activeId)
          ? state.activeId
          : conversations[0]?.id || null
        return {
          conversations,
          activeId,
          folders: mergeFolders(remoteFolders, state.folders),
        }
      })
    } finally {
      suppressStoreListener = false
    }
    if (foldersFingerprint(api.getState().folders) !== lastSavedFolders) {
      scheduleSave()
    }
  } catch (error) {
    console.error('[ChatSync] Failed to refresh task history:', error)
  } finally {
    // A refresh from a signed-out/previous account must never clear the token
    // belonging to a newer sync generation.
    if (refreshInFlight === refreshToken) refreshInFlight = null
  }
}

async function importLegacyState(userId: string, generation: number): Promise<void> {
  if (!storeApi || legacyImportStarted) return
  legacyImportStarted = true
  try {
    const legacyState = await readLegacyChatPersistedState()
    if (!legacyState || !isCurrentSync(generation, userId) || !storeApi) return

    const legacyConversations = normalizeConversationListForPersistence(legacyState.conversations || [])
    const legacyFolders = legacyState.folders || []
    if (legacyConversations.length === 0 && legacyFolders.length === 0) return

    legacyImported = legacyConversations.length > 0
    try {
      suppressStoreListener = true
      storeApi.setState((state) => {
        const conversations = mergeConversations(state.conversations, legacyConversations)
        return {
          conversations,
          folders: mergeFolders(state.folders, legacyFolders),
          activeId: state.activeId || legacyState.activeId || conversations[0]?.id || null,
        }
      })
    } finally {
      suppressStoreListener = false
    }
    scheduleSave(0)
  } catch (error) {
    console.error('[ChatSync] Failed to import legacy local task history:', error)
  }
}

function handleBeforeUnload(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void postSyncNow().catch(() => undefined)
}

function handleWindowFocus(): void {
  void refreshFromServer().catch(() => undefined)
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    void refreshFromServer().catch(() => undefined)
  }
  if (document.visibilityState === 'hidden') {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void postSyncNow().catch(() => undefined)
  }
}

function startListeners(): void {
  if (!storeApi || unsubscribe) return

  unsubscribe = storeApi.subscribe((state, previous) => {
    if (suppressStoreListener || !hydrated) return
    if (state.conversations === previous.conversations && state.folders === previous.folders) return
    if (
      state.folders === previous.folders &&
      conversationPersistenceVersionsMatch(state.conversations, previous.conversations)
    ) return
    scheduleSave()
  })

  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('focus', handleWindowFocus)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    void refreshFromServer().catch(() => undefined)
  }, REFRESH_INTERVAL_MS)
}

function stopSync(): void {
  unsubscribe?.()
  unsubscribe = null
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('focus', handleWindowFocus)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  knownConversationIds.clear()
  lastSavedUpdatedAt.clear()
  lastSavedFolders = '[]'
  hydrated = false
  suppressStoreListener = false
  legacyImported = false
  legacyImportStarted = false
  saveInFlightPromise = null
  saveQueued = false
  refreshInFlight = null
  lastRefreshAt = 0
  saveRetryAttempt = 0
}

export async function initializeChatStoreServerSync(userId: string, api: ChatStoreApi): Promise<void> {
  if (currentUserId && currentUserId !== userId) {
    syncGeneration++
    stopSync()
    resetStoreHydration()
    api.setState({ conversations: [], activeId: null, folders: [] })
  }
  currentUserId = userId
  storeApi = api
  if (hydrated) return
  const generation = ++syncGeneration

  try {
    const serverState = await fetchServerState()
    if (!isCurrentSync(generation, userId)) return
    const serverConversations = normalizeServerConversations(serverState.conversations, serverState.partial === true)
    const deletedIds = serverState.deletedIds || []
    const mergedConversations = mergeConversations(api.getState().conversations, serverConversations, deletedIds)
    const folders = mergeFolders(serverState.folders || [], api.getState().folders)
    const requestedActiveId = api.getState().activeId
    const activeId = requestedActiveId && mergedConversations.some((conversation) => conversation.id === requestedActiveId)
      ? requestedActiveId
      : mergedConversations[0]?.id || null

    knownConversationIds.clear()
    lastSavedUpdatedAt.clear()
    noteServerState(serverConversations, deletedIds)
    lastSavedFolders = foldersFingerprint(serverState.folders || [])

    try {
      suppressStoreListener = true
      api.setState({ conversations: mergedConversations, folders, activeId })
    } finally {
      suppressStoreListener = false
    }
  } catch (error) {
    if (isCurrentSync(generation, userId)) {
      console.error('[ChatSync] Failed to hydrate task history from the account database:', error)
    }
  } finally {
    if (!isCurrentSync(generation, userId)) return
    hydrated = true
    signalStoreHydrated()
    startListeners()
    scheduleSave(0)
    void importLegacyState(userId, generation)
  }
}

export function stopChatStoreServerSync(options: { clearStore?: boolean } = {}): void {
  syncGeneration++
  const api = storeApi
  stopSync()
  resetStoreHydration()
  currentUserId = null
  storeApi = null
  if (options.clearStore !== false) {
    api?.setState({ conversations: [], activeId: null, folders: [] })
  }
}

export async function loadConversationFromServer(
  conversationId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (!storeApi || !hydrated) return false
  const api = storeApi
  const userId = currentUserId
  const generation = syncGeneration
  if (!userId) return false
  const current = api.getState().conversations.find((conversation) => conversation.id === conversationId)
  if (!current) return false
  if (!options.force && !isServerSummaryConversation(current)) return true

  try {
    const conversation = await fetchServerConversation(conversationId)
    if (!isCurrentSync(generation, userId)) return false
    if (!conversation) return false
    let materialized = false

    try {
      suppressStoreListener = true
      api.setState((state) => ({
        conversations: sortConversations(state.conversations.map((existing) => {
          if (existing.id !== conversationId) return existing
          if (
            existing.serverBodyStale &&
            conversationVersionIsOlder(conversation, existing)
          ) {
            // The summary index is newer than the body response (for example,
            // during a replica lag window). Keep the upload fence and retry
            // rather than replacing it with another stale body.
            return existing
          }
          if (
            isServerSummaryConversation(existing) ||
            !conversationVersionIsOlder(conversation, existing)
          ) {
            materialized = true
            return conversation
          }
          return existing
        })),
      }))
    } finally {
      suppressStoreListener = false
    }
    if (materialized) noteServerState([conversation])
    return materialized
  } catch (error) {
    console.error('[ChatSync] Failed to load task body:', error)
    return false
  }
}

/**
 * Replace a conflicted local task with the canonical body that committed an
 * exact run. Unlike an ordinary force-load, this intentionally ignores local
 * timestamps: the run-scoped assistant proves which task-start transaction
 * won. Replica reads may expose the conflicting job before its conversation
 * body, so keep polling until that exact assistant cursor is visible.
 */
export async function rebaseConversationFromServerForRun(
  conversationId: string,
  runId: string,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!storeApi || !hydrated || !runId) return false
  const api = storeApi
  const userId = currentUserId
  const generation = syncGeneration
  if (!userId) return false

  for (const delayMs of TASK_RUN_REBASE_RETRY_DELAYS_MS) {
    await waitForTaskRunRebaseRetry(delayMs, options.signal)
    let conversation: Conversation | null
    try {
      conversation = await fetchServerConversation(conversationId, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) throw error
      continue
    }
    if (!isCurrentSync(generation, userId)) return false
    if (!conversation || !conversationContainsRun(conversation, runId)) continue

    let materialized = false
    let staleRevision = false
    let localAdvanced = false
    let materializedConversation: Conversation | null = null
    try {
      suppressStoreListener = true
      api.setState((state) => ({
        conversations: sortConversations(state.conversations.map((existing) => {
          if (existing.id !== conversationId) return existing
          if ((conversation.serverRevision || 0) < (existing.serverRevision || 0)) {
            staleRevision = true
            return existing
          }
          const merged = mergeCanonicalRunRebase(conversation, existing, runId)
          materialized = true
          localAdvanced = merged.localAdvanced
          materializedConversation = merged.conversation
          return merged.conversation
        })),
      }))
    } finally {
      suppressStoreListener = false
    }
    if (staleRevision) continue
    if (!materialized) return false
    noteServerState([conversation])
    if (localAdvanced && materializedConversation) scheduleSave(0)
    return true
  }

  return false
}

export async function flushChatServerSync(): Promise<void> {
  await waitForSyncManagerReady()
  await waitForStoreHydration()
  if (!storeApi || !hydrated) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await postSyncNow()
}

export async function clearServerConversations(): Promise<void> {
  const response = await fetch('/api/conversations', {
    method: 'DELETE',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : 'Could not clear task history.')
  }
  knownConversationIds.clear()
  lastSavedUpdatedAt.clear()
  lastSavedFolders = '[]'
}
