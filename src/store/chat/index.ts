'use client'

import { create } from 'zustand'
import { createConversationSlice } from './conversationSlice'
import { createMessageSlice } from './messageSlice'
import { createTaskSlice } from './taskSlice'
import { createArtifactSlice } from './artifactSlice'
import { clearServerConversations, flushChatServerSync, initializeChatStoreServerSync, loadConversationFromServer } from './serverSync'
import type { ChatStore } from './types'

export type { ChatStore } from './types'
export { clearServerConversations, flushChatServerSync, loadConversationFromServer }

export const useChatStore = create<ChatStore>()((set, get) => ({
  conversations: [],
  activeId: null,
  folders: [],
  ...createConversationSlice(set, get),
  ...createMessageSlice(set, get),
  ...createTaskSlice(set, get),
  ...createArtifactSlice(set, get),
}))

export function initializeChatStoreSync(userId: string): void {
  void initializeChatStoreServerSync(userId, useChatStore).catch((error) => {
    console.error('[ChatSync] Failed to start account task sync:', error)
  })
}
