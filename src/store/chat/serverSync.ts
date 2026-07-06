'use client'

import type { Conversation } from '@/types'
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

const SAVE_DEBOUNCE_MS = 250
const REFRESH_INTERVAL_MS = 5_000
const REFRESH_THROTTLE_MS = 1_500
const SYNC_MANAGER_READY_WAIT_MS = 4_000
const SYNC_MANAGER_READY_POLL_MS = 50

let storeApi: ChatStoreApi | null = null
let currentUserId: string | null = null
let unsubscribe: (() => void) | null = null
let suppressStoreListener = false
let hydrated = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveInFlight = false
let saveQueued = false
let legacyImported = false
let legacyImportStarted = false
let refreshInFlight = false
let lastRefreshAt = 0
let refreshTimer: ReturnType<typeof setInterval> | null = null

const knownConversationIds = new Set<string>()
const lastSavedUpdatedAt = new Map<string, number>()

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

function mergeFolders(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((folder) => typeof folder === 'string' && folder.trim()))]
}

function isServerSummaryConversation(conversation: Conversation): boolean {
  return conversation.serverSummary === true
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
  const hasMessages = Array.isArray(record.messages)
  const conversation: Conversation = {
    id: record.id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title : 'New task',
    messages: hasMessages ? record.messages as Conversation['messages'] : [],
    starred: record.starred === true,
    createdAt,
    updatedAt,
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
      if (conversation.updatedAt > existing.updatedAt) {
        if (isServerSummaryConversation(existing)) {
          byId.set(conversation.id, conversation)
        } else {
          const { serverSummary: _serverSummary, ...existingBody } = existing
          void _serverSummary
          byId.set(conversation.id, {
            ...existingBody,
            title: conversation.title,
            starred: conversation.starred,
            folder: conversation.folder,
            createdAt: Math.min(existing.createdAt, conversation.createdAt),
            updatedAt: conversation.updatedAt,
          })
        }
      } else if (isServerSummaryConversation(existing) && conversation.updatedAt >= existing.updatedAt) {
        byId.set(conversation.id, conversation)
      }
      continue
    }

    if (isServerSummaryConversation(existing) || conversation.updatedAt >= existing.updatedAt) {
      byId.set(conversation.id, conversation)
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

async function fetchServerConversation(conversationId: string): Promise<Conversation | null> {
  const response = await fetch(`/api/conversations?id=${encodeURIComponent(conversationId)}`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null
    throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load task.')
  }
  const body = await response.json() as ServerConversationBodyState
  return body.conversation ? serverRecordToConversation(body.conversation, false) : null
}

function getChangedConversations(state: ChatStore): Conversation[] {
  return normalizeConversationListForPersistence(state.conversations.filter((conversation) => (
    !isServerSummaryConversation(conversation) &&
    (
      !knownConversationIds.has(conversation.id) ||
      (lastSavedUpdatedAt.get(conversation.id) ?? -1) !== conversation.updatedAt
    )
  )))
}

function getDeletedIds(state: ChatStore): string[] {
  const currentIds = new Set(state.conversations.map((conversation) => conversation.id))
  return Array.from(knownConversationIds).filter((id) => !currentIds.has(id))
}

async function postSyncNow(): Promise<void> {
  if (!storeApi || !hydrated) return
  if (saveInFlight) {
    saveQueued = true
    return
  }

  const state = storeApi.getState()
  const conversations = getChangedConversations(state)
  const deletedIds = getDeletedIds(state)
  const folders = state.folders

  if (conversations.length === 0 && deletedIds.length === 0) {
    if (legacyImported) {
      await clearLegacyChatPersistence().catch(() => undefined)
      legacyImported = false
    }
    return
  }

  saveInFlight = true
  try {
    const response = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations, deletedIds, folders }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' ? body.error : 'Could not save task history.')
    }
    noteServerState(conversations, deletedIds)
    if (legacyImported) {
      await clearLegacyChatPersistence().catch(() => undefined)
      legacyImported = false
    }
  } finally {
    saveInFlight = false
  }

  if (saveQueued) {
    saveQueued = false
    scheduleSave(0)
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
  const now = Date.now()
  if (!force && now - lastRefreshAt < REFRESH_THROTTLE_MS) return

  refreshInFlight = true
  lastRefreshAt = now
  try {
    const serverState = await fetchServerState()
    const remoteConversations = normalizeServerConversations(serverState.conversations, serverState.partial === true)
    const deletedIds = serverState.deletedIds || []
    const remoteFolders = serverState.folders || []

    noteServerState(remoteConversations, deletedIds)

    suppressStoreListener = true
    storeApi.setState((state) => ({
      conversations: mergeConversations(state.conversations, remoteConversations, deletedIds),
      folders: mergeFolders(remoteFolders, state.folders),
    }))
    suppressStoreListener = false
  } catch (error) {
    console.error('[ChatSync] Failed to refresh task history:', error)
  } finally {
    refreshInFlight = false
  }
}

async function importLegacyState(userId: string): Promise<void> {
  if (!storeApi || legacyImportStarted) return
  legacyImportStarted = true
  try {
    const legacyState = await readLegacyChatPersistedState()
    if (!legacyState || currentUserId !== userId || !storeApi) return

    const legacyConversations = normalizeConversationListForPersistence(legacyState.conversations || [])
    const legacyFolders = legacyState.folders || []
    if (legacyConversations.length === 0 && legacyFolders.length === 0) return

    legacyImported = legacyConversations.length > 0
    suppressStoreListener = true
    storeApi.setState((state) => {
      const conversations = mergeConversations(state.conversations, legacyConversations)
      return {
        conversations,
        folders: mergeFolders(state.folders, legacyFolders),
        activeId: state.activeId || legacyState.activeId || conversations[0]?.id || null,
      }
    })
    suppressStoreListener = false
    scheduleSave(0)
  } catch (error) {
    console.error('[ChatSync] Failed to import legacy local task history:', error)
  }
}

function startListeners(): void {
  if (!storeApi || unsubscribe) return

  unsubscribe = storeApi.subscribe((state, previous) => {
    if (suppressStoreListener || !hydrated) return
    if (state.conversations === previous.conversations && state.folders === previous.folders) return
    scheduleSave()
  })

  window.addEventListener('beforeunload', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void postSyncNow().catch(() => undefined)
  })
  window.addEventListener('focus', () => {
    void refreshFromServer().catch(() => undefined)
  })
  document.addEventListener('visibilitychange', () => {
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
  })

  refreshTimer = setInterval(() => {
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
  knownConversationIds.clear()
  lastSavedUpdatedAt.clear()
  hydrated = false
  legacyImported = false
  legacyImportStarted = false
  saveInFlight = false
  saveQueued = false
}

export async function initializeChatStoreServerSync(userId: string, api: ChatStoreApi): Promise<void> {
  if (currentUserId && currentUserId !== userId) {
    stopSync()
    resetStoreHydration()
    api.setState({ conversations: [], activeId: null, folders: [] })
  }
  currentUserId = userId
  storeApi = api
  if (hydrated) return

  try {
    const serverState = await fetchServerState()
    const serverConversations = normalizeServerConversations(serverState.conversations, serverState.partial === true)
    const deletedIds = serverState.deletedIds || []
    const mergedConversations = mergeConversations(api.getState().conversations, serverConversations, deletedIds)
    const folders = mergeFolders(serverState.folders || [], api.getState().folders)
    const activeId = api.getState().activeId || mergedConversations[0]?.id || null

    knownConversationIds.clear()
    lastSavedUpdatedAt.clear()
    noteServerState(serverConversations, deletedIds)

    suppressStoreListener = true
    api.setState({ conversations: mergedConversations, folders, activeId })
    suppressStoreListener = false
  } catch (error) {
    console.error('[ChatSync] Failed to hydrate task history from the account database:', error)
  } finally {
    hydrated = true
    signalStoreHydrated()
    startListeners()
    scheduleSave(0)
    void importLegacyState(userId)
  }
}

export async function loadConversationFromServer(conversationId: string): Promise<boolean> {
  if (!storeApi || !hydrated) return false
  const current = storeApi.getState().conversations.find((conversation) => conversation.id === conversationId)
  if (!current || !isServerSummaryConversation(current)) return true

  try {
    const conversation = await fetchServerConversation(conversationId)
    if (!conversation) return false
    noteServerState([conversation])

    suppressStoreListener = true
    storeApi.setState((state) => ({
      conversations: sortConversations(state.conversations.map((existing) => {
        if (existing.id !== conversationId) return existing
        if (isServerSummaryConversation(existing) || conversation.updatedAt >= existing.updatedAt) {
          return conversation
        }
        return existing
      })),
    }))
    suppressStoreListener = false
    return true
  } catch (error) {
    console.error('[ChatSync] Failed to load task body:', error)
    return false
  }
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
}
