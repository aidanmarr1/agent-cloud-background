import type { ComputerPanelItem, Conversation, Message } from '@/types'

const MAX_CONVERSATIONS = 500
const MAX_MESSAGES_PER_CONVERSATION = 240
const MAX_TEXT_CONTENT_CHARS = 120_000
const MAX_ARTIFACT_CONTENT_CHARS = 120_000
const MAX_PANEL_ITEMS = 50
const MAX_SEARCH_RESULTS = 15
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
  if (!Array.isArray(items) || !items.length) return Array.isArray(items) ? items : undefined
  return items.slice(-MAX_PANEL_ITEMS).filter(Boolean).map((item) => {
    const next = {
      ...item,
      data: truncateResult(item.data) as ComputerPanelItem['data'],
    }
    delete next.streaming
    return next
  })
}

function mergeArtifacts(
  stored: NonNullable<Message['artifacts']>,
  incoming: NonNullable<Message['artifacts']>,
): NonNullable<Message['artifacts']> {
  const merged = new Map<string, NonNullable<Message['artifacts']>[number]>()
  for (const artifact of [...stored, ...incoming]) {
    const key = artifact.filePath || artifact.id
    const current = merged.get(key)
    if (
      !current ||
      (artifact.content || '').length > (current.content || '').length ||
      (
        (artifact.content || '').length === (current.content || '').length &&
        artifact.createdAt >= current.createdAt
      )
    ) {
      merged.set(key, artifact)
    }
  }
  return [...merged.values()]
}

function mergeTaskGroups(
  stored: NonNullable<Message['taskGroups']>,
  incoming: NonNullable<Message['taskGroups']>,
): NonNullable<Message['taskGroups']> {
  const storedById = new Map(stored.map((group) => [group.id, group]))
  const incomingIds = new Set(incoming.map((group) => group.id))
  const merged = incoming.map((group) => {
    const previous = storedById.get(group.id)
    if (!previous) return group

    const subtasks = new Map(previous.subtasks.map((subtask) => [subtask.id, subtask]))
    for (const subtask of group.subtasks) {
      const existing = subtasks.get(subtask.id)
      subtasks.set(
        subtask.id,
        !existing || JSON.stringify(subtask).length >= JSON.stringify(existing).length
          ? subtask
          : existing,
      )
    }

    const narrations = new Map(previous.narrations.map((narration) => [narration.id, narration]))
    for (const narration of group.narrations) narrations.set(narration.id, narration)

    return {
      ...previous,
      ...group,
      subtasks: [...subtasks.values()],
      narrations: [...narrations.values()].sort((a, b) => a.position - b.position),
      synthesis: group.synthesis.length >= previous.synthesis.length
        ? group.synthesis
        : previous.synthesis,
    }
  })
  for (const group of stored) {
    if (!incomingIds.has(group.id)) merged.push(group)
  }
  return merged.sort((a, b) => a.index - b.index)
}

/**
 * A durable `done` event is authoritative proof that the planned task
 * completed. Presentation state can arrive a render behind that event, so a
 * completed message must never retain pending/running plan rows.
 */
export function normalizeTerminalAssistantPresentation(message: Message): Message {
  if (message.role !== 'assistant' || message.streamTerminalStatus !== 'done') return message
  return {
    ...message,
    taskGroups: message.taskGroups?.map((group) => ({
      ...group,
      status: 'done',
      subtasks: group.subtasks.map((subtask) => (
        subtask.status === 'running' ? { ...subtask, status: 'done' } : subtask
      )),
    })),
    steps: message.steps?.map((step) => ({ ...step, status: 'done' })),
  }
}

export function assistantMessagesShareCursor(left: Message, right: Message): boolean {
  if (left.role !== 'assistant' || right.role !== 'assistant') return false
  const leftRunId = typeof left.streamRunId === 'string' ? left.streamRunId : ''
  const rightRunId = typeof right.streamRunId === 'string' ? right.streamRunId : ''
  const leftSeq = Number.isFinite(left.streamSeq) ? Number(left.streamSeq) : 0
  const rightSeq = Number.isFinite(right.streamSeq) ? Number(right.streamSeq) : 0
  return !!leftRunId && leftRunId === rightRunId && leftSeq === rightSeq
}

/**
 * The cursor orders runtime events, not React/store flushes. At the same
 * terminal cursor, merge richer presentation fields monotonically instead of
 * discarding a later artifact or completed task-group snapshot.
 */
export function mergeSameCursorAssistantPresentation(stored: Message, incoming: Message): Message {
  if (!assistantMessagesShareCursor(stored, incoming)) return incoming
  const terminalStatus = stored.streamTerminalStatus || incoming.streamTerminalStatus
  const merged: Message = {
    ...stored,
    ...incoming,
    content: incoming.content || stored.content,
    streamTerminalStatus: terminalStatus,
    artifacts: mergeArtifacts(stored.artifacts || [], incoming.artifacts || []),
    taskGroups: mergeTaskGroups(stored.taskGroups || [], incoming.taskGroups || []),
  }
  return normalizeTerminalAssistantPresentation(merged)
}

function normalizeMessage(message: Message): Message {
  const next = cloneJson(normalizeTerminalAssistantPresentation(message))
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
  if (Array.isArray(next.taskGroups) && next.taskGroups.length) {
    next.taskGroups = next.taskGroups.map((group) => {
      const subtasks = Array.isArray(group.subtasks) ? group.subtasks : []
      const narrations = Array.isArray(group.narrations) ? group.narrations : []
      return {
        ...group,
        subtasks: subtasks.map((subtask) => ({
          ...subtask,
          result: truncateResult(subtask.result) as typeof subtask.result,
        })),
        narrations,
      }
    })
  }
  if (Array.isArray(next.steps) && next.steps.length) {
    next.steps = next.steps.map((step) => ({
      ...step,
      items: (Array.isArray(step.items) ? step.items : []).map((item) => {
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
  delete next.serverBodyStale
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
