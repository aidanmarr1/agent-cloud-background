import { v4 as uuidv4 } from 'uuid'
import type { Conversation, ConversationBranch, FileAttachment, Message } from '@/types'
import type { SliceCreator } from './types'
import { clampTaskInput } from '@/lib/inputLimits'

export interface ConversationSlice {
  createConversation: (firstMessage: string, attachments?: FileAttachment[]) => string
  deleteConversation: (id: string) => void
  setActiveId: (id: string | null) => void
  toggleStar: (id: string) => void
  renameConversation: (id: string, title: string) => void
  updateTitle: (id: string, title: string) => void
  setCustomInstructions: (convId: string, instructions: string) => void
  branchConversation: (convId: string, messageId: string) => void
  addTag: (conversationId: string, tag: string) => void
  removeTag: (conversationId: string, tag: string) => void
  setFolder: (conversationId: string, folder: string | undefined) => void
  createFolder: (name: string) => void
  clearConversations: () => void
  deleteConversations: (ids: string[]) => void
  starConversations: (ids: string[]) => void
  searchConversations: (query: string) => string[]
}

export const createConversationSlice: SliceCreator<ConversationSlice> = (set, get) => ({
  createConversation: (firstMessage: string, attachments?: FileAttachment[]) => {
    const id = uuidv4()
    const boundedFirstMessage = clampTaskInput(firstMessage)
    const title = boundedFirstMessage.slice(0, 50) + (boundedFirstMessage.length > 50 ? '...' : '')
    const now = Date.now()
    const msg: Message = {
      id: uuidv4(),
      role: 'user',
      content: boundedFirstMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      timestamp: now,
    }
    const conv: Conversation = {
      id,
      title,
      messages: [msg],
      starred: false,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      conversations: [conv, ...state.conversations],
      activeId: id,
    }))
    return id
  },

  deleteConversation: (id) => {
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }))
  },

  setActiveId: (id) => set({ activeId: id }),

  toggleStar: (id) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, starred: !c.starred } : c
      ),
    }))
  },

  renameConversation: (id, title) => {
    // Alias for updateTitle
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    }))
  },

  updateTitle: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    }))
  },

  setCustomInstructions: (convId, instructions) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === convId ? { ...c, customInstructions: instructions, updatedAt: Date.now() } : c
      ),
    }))
  },

  branchConversation: (convId, messageId) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const idx = c.messages.findIndex((m) => m.id === messageId)
        if (idx < 0) return c
        const truncatedMessages = c.messages.slice(idx + 1)
        if (truncatedMessages.length === 0) return c
        const branch: ConversationBranch = {
          id: uuidv4(),
          parentMessageId: messageId,
          messages: truncatedMessages,
          createdAt: Date.now(),
        }
        return {
          ...c,
          branches: [...(c.branches || []), branch],
          messages: c.messages.slice(0, idx + 1),
          updatedAt: Date.now(),
        }
      }),
    }))
  },

  addTag: (conversationId, tag) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, tags: [...new Set([...(c.tags || []), tag])], updatedAt: Date.now() }
          : c
      ),
    }))
  },

  removeTag: (conversationId, tag) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, tags: (c.tags || []).filter((t) => t !== tag), updatedAt: Date.now() }
          : c
      ),
    }))
  },

  setFolder: (conversationId, folder) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, folder, updatedAt: Date.now() }
          : c
      ),
    }))
  },

  createFolder: (name) => {
    set((state) => ({
      folders: state.folders.includes(name) ? state.folders : [...state.folders, name],
    }))
  },

  clearConversations: () => {
    set({
      conversations: [],
      activeId: null,
      folders: [],
    })
  },

  deleteConversations: (ids) => {
    set((state) => ({
      conversations: state.conversations.filter((c) => !ids.includes(c.id)),
      activeId: ids.includes(state.activeId ?? '') ? null : state.activeId,
    }))
  },

  starConversations: (ids) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        ids.includes(c.id) ? { ...c, starred: true } : c
      ),
    }))
  },

  searchConversations: (query) => {
    const state = get()
    const lower = query.toLowerCase()
    return state.conversations
      .filter((c) =>
        c.title.toLowerCase().includes(lower) ||
        c.messages.some((m) => m.content.toLowerCase().includes(lower))
      )
      .map((c) => c.id)
  },
})
