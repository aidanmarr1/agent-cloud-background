import { isContextualTaskUpdate } from '@/lib/conversationContext'
import type { AgentLoopOptions } from './AgentLoop'

const FRESH_TASK_CONTEXT_MESSAGES = 1
const CONTEXTUAL_TASK_CONTEXT_MESSAGES = 6
const HISTORICAL_CONTEXT_CHARS = 1_200

function compactHistoricalAgentMessage(
  message: AgentLoopOptions['messages'][number],
  isLatest: boolean,
): AgentLoopOptions['messages'][number] {
  if (isLatest) return message
  const content = message.content.length > HISTORICAL_CONTEXT_CHARS
    ? `${message.content.slice(0, HISTORICAL_CONTEXT_CHARS)}\n...[historical message compacted]`
    : message.content
  return { ...message, content, attachments: undefined }
}

export function scopeAgentTaskMessages(
  messages: AgentLoopOptions['messages'],
): AgentLoopOptions['messages'] {
  const latestUserIndex = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && message.content.trim())
    .at(-1)?.index ?? messages.length - 1

  if (!isContextualTaskUpdate(messages)) {
    return messages.slice(Math.max(0, latestUserIndex)).slice(-FRESH_TASK_CONTEXT_MESSAGES)
  }

  const recent = messages.slice(Math.max(0, messages.length - CONTEXTUAL_TASK_CONTEXT_MESSAGES))
  const lastIndex = recent.length - 1
  return recent.map((message, index) => compactHistoricalAgentMessage(message, index === lastIndex))
}
