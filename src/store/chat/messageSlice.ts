import type { Message, FollowUpSuggestion } from '@/types'
import type { SliceCreator } from './types'
import { clampTaskInput } from '@/lib/inputLimits'

function clampUserMessage(message: Message): Message {
  return message.role === 'user'
    ? { ...message, content: clampTaskInput(message.content) }
    : message
}

export interface MessageSlice {
  addMessage: (convId: string, message: Message) => void
  addLiveDirectiveExchange: (convId: string, userMessage: Message, assistantMessage: Message) => void
  appendToLastMessage: (convId: string, text: string) => void
  appendReasoning: (convId: string, text: string) => void
  truncateAfterMessage: (convId: string, messageId: string) => void
  setLastMessageContent: (convId: string, content: string) => void
  setFollowUps: (convId: string, suggestions: FollowUpSuggestion[]) => void
  toggleMessagePin: (convId: string, messageId: string) => void
}

export const createMessageSlice: SliceCreator<MessageSlice> = (set) => ({
  addMessage: (convId, message) => {
    const boundedMessage = clampUserMessage(message)
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === convId
          ? { ...c, messages: [...c.messages, boundedMessage], updatedAt: Date.now() }
          : c
      ),
    }))
  },

  addLiveDirectiveExchange: (convId, userMessage, assistantMessage) => {
    const boundedUserMessage = clampUserMessage(userMessage)
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c

        const messages = [...c.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          const current = messages[i]
          if (current.role !== 'assistant') continue

          const continuation: Message = {
            ...assistantMessage,
            steps: current.steps,
            taskGroups: current.taskGroups,
            artifacts: current.artifacts,
            computerPanelData: current.computerPanelData,
          }

          messages[i] = {
            ...current,
            steps: current.steps?.length ? [] : current.steps,
            taskGroups: current.taskGroups?.length ? [] : current.taskGroups,
            artifacts: current.artifacts?.length ? [] : current.artifacts,
            computerPanelData: current.computerPanelData?.length ? [] : current.computerPanelData,
            followUps: undefined,
          }
          messages.splice(i + 1, 0, boundedUserMessage, continuation)
          return { ...c, messages, updatedAt: Date.now() }
        }

        return { ...c, messages: [...messages, boundedUserMessage, assistantMessage], updatedAt: Date.now() }
      }),
    }))
  },

  appendToLastMessage: (convId, text) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const messages = [...c.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (message.role !== 'assistant') continue
          messages[i] = { ...message, content: message.content + text }
          break
        }
        return { ...c, messages, updatedAt: Date.now() }
      }),
    }))
  },

  appendReasoning: (convId, text) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const messages = [...c.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (message.role !== 'assistant') continue
          messages[i] = { ...message, reasoning: (message.reasoning || '') + text }
          break
        }
        return { ...c, messages, updatedAt: Date.now() }
      }),
    }))
  },

  truncateAfterMessage: (convId, messageId) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const idx = c.messages.findIndex((m) => m.id === messageId)
        if (idx < 0) return c
        return { ...c, messages: c.messages.slice(0, idx + 1), updatedAt: Date.now() }
      }),
    }))
  },

  setLastMessageContent: (convId, content) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const messages = [...c.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages[i] = { ...messages[i], content }
            break
          }
        }
        return { ...c, messages, updatedAt: Date.now() }
      }),
    }))
  },

  setFollowUps: (convId, suggestions) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        const messages = [...c.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages[i] = { ...messages[i], followUps: suggestions }
            break
          }
        }
        return { ...c, messages, updatedAt: Date.now() }
      }),
    }))
  },

  toggleMessagePin: (convId, messageId) => {
    set((state) => ({
      conversations: state.conversations.map((c) => {
        if (c.id !== convId) return c
        return {
          ...c,
          messages: c.messages.map((m) =>
            m.id === messageId ? { ...m, pinned: !m.pinned } : m
          ),
          updatedAt: Date.now(),
        }
      }),
    }))
  },
})
