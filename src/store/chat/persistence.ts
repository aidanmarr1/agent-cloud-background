'use client'

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval'
import type { ChatState } from './types'
export { truncateResult } from '@/lib/conversationSerialization'

export const TASK_STORE_KEY = 'agent-task-store'
export const LEGACY_CHAT_STORE_KEY = 'agent-chat-store'

async function readPersistedValue(name: string): Promise<string | null> {
  const value = await idbGet<string>(name)
  if (value != null) return value

  if (typeof localStorage !== 'undefined') {
    const localValue = localStorage.getItem(name)
    if (localValue != null) {
      await idbSet(name, localValue)
      localStorage.removeItem(name)
      return localValue
    }
  }

  return null
}

function parsePersistedState(raw: string | null): Pick<ChatState, 'conversations' | 'activeId' | 'folders'> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { state?: Partial<ChatState> } | Partial<ChatState>
    const state = ('state' in parsed && parsed.state ? parsed.state : parsed) as Partial<ChatState>
    const conversations = Array.isArray(state.conversations) ? state.conversations : []
    const folders = Array.isArray(state.folders) ? state.folders.filter((folder): folder is string => typeof folder === 'string') : []
    const activeId = typeof state.activeId === 'string' ? state.activeId : null
    return { conversations, activeId, folders }
  } catch {
    return null
  }
}

export async function readLegacyChatPersistedState(): Promise<Pick<ChatState, 'conversations' | 'activeId' | 'folders'> | null> {
  return parsePersistedState(await readPersistedValue(TASK_STORE_KEY)) ||
    parsePersistedState(await readPersistedValue(LEGACY_CHAT_STORE_KEY))
}

export async function clearLegacyChatPersistence(): Promise<void> {
  await Promise.all([
    idbDel(TASK_STORE_KEY),
    idbDel(LEGACY_CHAT_STORE_KEY),
  ])
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(TASK_STORE_KEY)
    localStorage.removeItem(LEGACY_CHAT_STORE_KEY)
  }
}

export async function flushChatPersistence(): Promise<void> {
  // Chat task history is now flushed through the authenticated server sync.
}

// Helper to update the last assistant message in a task thread.
import type { Conversation, Message } from '@/types'

export function updateLastAssistantMessage(
  conversations: Conversation[],
  convId: string,
  updater: (msg: Message) => Message
): Conversation[] {
  return conversations.map((c) => {
    if (c.id !== convId) return c
    const messages = [...c.messages]
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i] = updater(messages[i])
        break
      }
    }
    return { ...c, messages, updatedAt: Date.now() }
  })
}
