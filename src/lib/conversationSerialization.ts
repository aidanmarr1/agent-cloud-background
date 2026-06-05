import type { ComputerPanelItem, Conversation, Message } from '@/types'

const MAX_CONVERSATIONS = 500
const MAX_MESSAGES_PER_CONVERSATION = 240
const MAX_TEXT_CONTENT_CHARS = 120_000
const MAX_ARTIFACT_CONTENT_CHARS = 120_000
const MAX_PANEL_ITEMS = 50
const MAX_SEARCH_RESULTS = 20
const MAX_BROWSE_CONTENT = 10_000
const MAX_TERMINAL_OUTPUT = 20_000
const MAX_FILE_CONTENT = 20_000

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function truncateStr(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n[truncated]`
}

export function truncateResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  if (Array.isArray(result)) {
    return result.slice(0, MAX_SEARCH_RESULTS)
  }

  const next = { ...(result as Record<string, unknown>) }

  if ('screenshotBase64' in next) {
    delete next.screenshotBase64
  }
  if ('liveFrame' in next) {
    delete next.liveFrame
  }
  if ('liveFrameUpdatedAt' in next) {
    delete next.liveFrameUpdatedAt
  }
  if ('content' in next && typeof next.content === 'string' && !('path' in next)) {
    next.content = truncateStr(next.content, next.stdout !== undefined ? MAX_TERMINAL_OUTPUT : MAX_BROWSE_CONTENT)
  }
  if ('stdout' in next && typeof next.stdout === 'string') {
    next.stdout = truncateStr(next.stdout, MAX_TERMINAL_OUTPUT)
  }
  if ('stderr' in next && typeof next.stderr === 'string') {
    next.stderr = truncateStr(next.stderr, MAX_TERMINAL_OUTPUT)
  }
  if ('path' in next && 'content' in next && typeof next.content === 'string') {
    next.content = truncateStr(next.content, MAX_FILE_CONTENT)
  }

  return next
}

function normalizePanelItems(items: ComputerPanelItem[] | undefined): ComputerPanelItem[] | undefined {
  if (!items?.length) return items
  return items.slice(-MAX_PANEL_ITEMS).map((item) => {
    const next = {
      ...item,
      data: truncateResult(item.data) as ComputerPanelItem['data'],
    }
    delete next.streaming
    return next
  })
}

function normalizeMessage(message: Message): Message {
  const next = cloneJson(message)
  if (typeof next.content === 'string') {
    next.content = truncateStr(next.content, MAX_TEXT_CONTENT_CHARS)
  }
  if (typeof next.reasoning === 'string') {
    next.reasoning = truncateStr(next.reasoning, MAX_TEXT_CONTENT_CHARS)
  }
  if (next.artifacts?.length) {
    next.artifacts = next.artifacts.map((artifact) => ({
      ...artifact,
      content: truncateStr(artifact.content || '', MAX_ARTIFACT_CONTENT_CHARS),
      imageDataUrl: undefined,
    }))
  }
  next.computerPanelData = normalizePanelItems(next.computerPanelData)
  if (next.taskGroups?.length) {
    next.taskGroups = next.taskGroups.map((group) => ({
      ...group,
      subtasks: group.subtasks.map((subtask) => ({
        ...subtask,
        result: truncateResult(subtask.result) as typeof subtask.result,
      })),
    }))
  }
  if (next.steps?.length) {
    next.steps = next.steps.map((step) => ({
      ...step,
      items: step.items.map((item) => {
        if ('result' in item) {
          return { ...item, result: truncateResult(item.result) as typeof item.result }
        }
        return item
      }),
    }))
  }
  return next
}

export function normalizeConversationForPersistence(conversation: Conversation): Conversation {
  const next = cloneJson(conversation)
  delete next.serverSummary
  next.title = truncateStr(String(next.title || 'New task'), 200)
  next.messages = Array.isArray(next.messages)
    ? next.messages.slice(-MAX_MESSAGES_PER_CONVERSATION).map(normalizeMessage)
    : []
  next.createdAt = Number.isFinite(next.createdAt) ? next.createdAt : Date.now()
  next.updatedAt = Number.isFinite(next.updatedAt) ? next.updatedAt : next.createdAt
  return next
}

export function normalizeConversationListForPersistence(conversations: Conversation[]): Conversation[] {
  return conversations
    .slice(0, MAX_CONVERSATIONS)
    .map(normalizeConversationForPersistence)
}
