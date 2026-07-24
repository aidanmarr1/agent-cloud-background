import { createHash } from 'crypto'
import type { Transaction } from '@tursodatabase/serverless/compat'
import type { Conversation, LiveDirectiveMessageMarker, Message } from '@/types'
import { getTursoClient, getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'
import { normalizeConversationForPersistence, normalizeConversationListForPersistence } from '@/lib/conversationSerialization'

const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_SYNC_CONVERSATIONS = 500
const MAX_SYNC_FOLDERS = 100
const MAX_FOLDER_CHARS = 80

export interface ConversationSyncInput {
  conversations: Conversation[]
  deletedIds: string[]
  folders?: string[]
}

export interface StoredConversationState {
  conversations: Conversation[]
  deletedIds: string[]
  folders: string[]
}

export interface StoredConversationSummary {
  id: string
  title: string
  starred: boolean
  createdAt: number
  updatedAt: number
  serverRevision: number
  folder?: string
}

export interface StoredConversationIndex {
  conversations: StoredConversationSummary[]
  deletedIds: string[]
  folders: string[]
}

export interface TaskStartConversationInsert {
  sql: string
  args: Array<string | number | null>
}

export interface TaskStartConversationInput {
  conversationId: string
  messages: Array<{
    id?: string
    timestamp?: number
    streamRunId?: string
    streamSeq?: number
    streamTerminalStatus?: 'done' | 'error'
    role: 'user' | 'assistant'
    content: string
    attachments?: Conversation['messages'][number]['attachments']
  }>
  customInstructions?: string
}

export interface AcceptedLiveDirectiveConversationInput {
  directiveId: string
  continuationMessageId: string
  content: string
  createdAt: number
}

export class LiveDirectiveConversationPersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveDirectiveConversationPersistenceError'
  }
}

const REJECTED_LIVE_DIRECTIVE_MESSAGE =
  'This instruction was received, but the task finished before it could be delivered. Send it again as a new message if you still need it.'

let conversationSchemaPromise: Promise<void> | null = null

async function addConversationColumn(sql: string): Promise<void> {
  try {
    await tursoExecute(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate column|already exists/i.test(message)) return
    throw error
  }
}

export async function ensureConversationSchema(): Promise<void> {
  if (!conversationSchemaPromise) {
    conversationSchemaPromise = (async () => {
      // A fresh route isolate used to pay seven serial network round trips here
      // before it could read the conversation. The serverless compat client's
      // batch() deliberately returns one aggregate ResultSet, so it cannot be
      // used for a later row-producing PRAGMA. Use one sequence round trip for
      // idempotent DDL, then one normal query for the legacy-column inspection.
      await getTursoClient().executeMultiple(`
        create table if not exists conversations (
          user_id text not null,
          id text not null,
          title text not null,
          body_json text not null,
          starred integer not null default 0,
          folder text,
          server_placeholder integer not null default 0,
          revision integer not null default 1,
          created_at_ms integer not null,
          updated_at_ms integer not null,
          deleted_at_ms integer,
          created_at text not null,
          updated_at text not null,
          primary key (user_id, id)
        );
        create index if not exists conversations_user_updated_idx
          on conversations(user_id, deleted_at_ms, updated_at_ms desc);
        create index if not exists conversations_user_deleted_idx
          on conversations(user_id, deleted_at_ms);
        create table if not exists user_conversation_meta (
          user_id text primary key,
          folders_json text not null,
          updated_at_ms integer not null,
          updated_at text not null
        );
      `)

      const tableInfo = await tursoExecute('pragma table_info(conversations)')

      const columns = new Set(tableInfo.rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'))
      // Legacy databases still need these repairs. Each helper preserves the
      // duplicate-column recovery needed when two cold isolates migrate at once.
      if (!columns.has('server_placeholder')) {
        await addConversationColumn('alter table conversations add column server_placeholder integer not null default 0')
      }
      if (!columns.has('revision')) {
        await addConversationColumn('alter table conversations add column revision integer not null default 1')
      }

    })().catch((error) => {
      conversationSchemaPromise = null
      throw error
    })
  }

  return conversationSchemaPromise
}

function titleFromMessages(messages: Array<{ role: string; content: string }>): string {
  const firstUserContent = messages.find((message) => message.role === 'user')?.content?.trim() || 'New task'
  return `${firstUserContent.slice(0, 50)}${firstUserContent.length > 50 ? '...' : ''}`
}

export function taskStartMessageFallbackId(
  conversationId: string,
  message: TaskStartConversationInput['messages'][number],
  index: number,
): string {
  const attachmentIdentity = (message.attachments || []).map((attachment) => ({
    id: attachment.id || null,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
  }))
  const digest = createHash('sha256')
    .update(JSON.stringify({
      conversationId,
      index,
      role: message.role,
      content: message.content,
      timestamp: Number.isFinite(message.timestamp) ? Number(message.timestamp) : null,
      attachments: attachmentIdentity,
    }))
    .digest('hex')
    .slice(0, 32)
  const uuidHex = digest.split('')
  uuidHex[12] = '5'
  uuidHex[16] = ['8', '9', 'a', 'b'][Number.parseInt(uuidHex[16], 16) % 4]
  const normalized = uuidHex.join('')
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join('-')
}

export function mergeConversationMessagesForTaskStart(
  existingMessages: Message[],
  incomingMessages: Message[],
): Message[] {
  const mergedMessages = [...existingMessages]
  const indexById = new Map(mergedMessages.map((message, index) => [message.id, index]))
  let lastExistingIndex = -1
  let newSuffixStarted = false
  let matchedExistingCount = 0
  const incomingIds = new Set<string>()

  for (const message of incomingMessages) {
    if (incomingIds.has(message.id)) {
      throw new Error('The task request contains a duplicate message id. Refresh the task and try again.')
    }
    incomingIds.add(message.id)
    const existingIndex = indexById.get(message.id)
    if (existingIndex === undefined) {
      if (!newSuffixStarted && existingMessages.length > 0 && matchedExistingCount !== existingMessages.length) {
        throw new Error('The saved task has newer messages. Refresh the task before starting another run.')
      }
      newSuffixStarted = true
      indexById.set(message.id, mergedMessages.length)
      mergedMessages.push(message)
      continue
    }

    if (newSuffixStarted || existingIndex <= lastExistingIndex) {
      throw new Error('The task message order no longer matches the saved history. Refresh the task and try again.')
    }
    matchedExistingCount += 1
    lastExistingIndex = existingIndex
    const current = mergedMessages[existingIndex]
    if (current.role !== message.role) {
      throw new Error('A task message id is already used by a different message role. Refresh the task and try again.')
    }
    if (current.role === 'user' && current.content !== message.content) {
      throw new Error('A saved user message changed while starting the task. Refresh the task and try again.')
    }
    if (current.role === 'assistant') {
      const currentRunId = typeof current.streamRunId === 'string' ? current.streamRunId : ''
      const incomingRunId = typeof message.streamRunId === 'string' ? message.streamRunId : ''
      if (currentRunId && incomingRunId && currentRunId !== incomingRunId) {
        throw new Error('A saved assistant message belongs to a different task run. Refresh the task and try again.')
      }
      const establishesAcceptedRun = (
        !currentRunId &&
        !!incomingRunId &&
        Number.isFinite(message.streamSeq) &&
        Number(message.streamSeq) === 0 &&
        message.content === current.content
      )
      if (establishesAcceptedRun) {
        mergedMessages[existingIndex] = {
          ...current,
          streamRunId: incomingRunId,
          streamSeq: 0,
        }
      } else if (
        incomingAssistantHasStrictlyNewerCursor(current, message) ||
        incomingAssistantHasMonotonicTerminalState(current, message)
      ) {
        mergedMessages[existingIndex] = {
          ...current,
          content: message.content,
          streamRunId: message.streamRunId,
          streamSeq: message.streamSeq,
          streamTerminalStatus: message.streamTerminalStatus,
        }
      } else if (message.content !== current.content) {
        if (message.content.startsWith(current.content)) {
          // Older clients did not send stream cursors in task-start history.
          // A strict text extension is still monotonic; retain all rich server
          // fields while preserving the completed suffix before the next run.
          mergedMessages[existingIndex] = {
            ...current,
            content: message.content,
          }
        } else if (!current.content.startsWith(message.content)) {
          throw new Error('A saved assistant message diverged from the task request. Refresh the task and try again.')
        }
      }
    }
    // The request is a compact, model-facing projection. The durable body
    // remains canonical for existing IDs so stale tabs cannot replace rich
    // assistant state, attachment references, stream cursors, or accepted
    // directive markers. Only an ordered suffix of genuinely new IDs is
    // appended above.
  }

  if (existingMessages.length > 0 && matchedExistingCount !== existingMessages.length) {
    throw new Error('The saved task has newer messages. Refresh the task before starting another run.')
  }
  return mergedMessages
}

function nextConversationUpdateTime(conversation: Conversation, requestedAt: number): number {
  const current = Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : 0
  return Math.max(Date.now(), requestedAt, current + 1)
}

function normalizedServerRevision(value: unknown): number {
  const revision = Number(value)
  return Number.isInteger(revision) && revision > 0 ? revision : 1
}

function liveDirectiveMarker(message: Message): LiveDirectiveMessageMarker | null {
  const marker = message.liveDirective
  if (
    !marker ||
    typeof marker.directiveId !== 'string' ||
    (marker.part !== 'instruction' && marker.part !== 'continuation') ||
    !Number.isFinite(marker.acceptedAt)
  ) {
    return null
  }
  if (marker.part === 'instruction' && (message.role !== 'user' || message.id !== marker.directiveId)) {
    return null
  }
  if (marker.part === 'continuation' && message.role !== 'assistant') return null
  return marker
}

function sameLiveDirectiveMarker(message: Message | undefined, expected: LiveDirectiveMessageMarker): boolean {
  if (!message) return false
  const marker = liveDirectiveMarker(message)
  return !!marker && marker.directiveId === expected.directiveId && marker.part === expected.part
}

function incomingAssistantHasStrictlyNewerCursor(stored: Message, incoming: Message): boolean {
  if (incoming.role !== 'assistant') return false
  const incomingRunId = typeof incoming.streamRunId === 'string' ? incoming.streamRunId : ''
  const incomingSeq = Number.isFinite(incoming.streamSeq) ? Number(incoming.streamSeq) : 0
  if (!incomingRunId || incomingSeq <= 0) return false

  const storedRunId = typeof stored.streamRunId === 'string' ? stored.streamRunId : ''
  const storedSeq = Number.isFinite(stored.streamSeq) ? Number(stored.streamSeq) : 0
  if (!storedRunId) return true
  return storedRunId === incomingRunId && incomingSeq > storedSeq
}

function incomingAssistantHasMonotonicTerminalState(stored: Message, incoming: Message): boolean {
  if (incoming.role !== 'assistant' || !incoming.streamTerminalStatus || stored.streamTerminalStatus) return false
  const storedRunId = typeof stored.streamRunId === 'string' ? stored.streamRunId : ''
  const incomingRunId = typeof incoming.streamRunId === 'string' ? incoming.streamRunId : ''
  const storedSeq = Number.isFinite(stored.streamSeq) ? Number(stored.streamSeq) : 0
  const incomingSeq = Number.isFinite(incoming.streamSeq) ? Number(incoming.streamSeq) : 0
  return !!incomingRunId && incomingRunId === storedRunId && incomingSeq >= storedSeq
}

function sameAssistantCanonicalState(left: Message, right: Message): boolean {
  const { pinned: _leftPinned, ...leftCanonical } = left
  const { pinned: _rightPinned, ...rightCanonical } = right
  void _leftPinned
  void _rightPinned
  return JSON.stringify(leftCanonical) === JSON.stringify(rightCanonical)
}

/**
 * Client clocks are not a safe authority for streamed assistant state. Keep
 * the stored same-ID assistant unless the incoming body proves monotonic
 * progress with a strictly higher cursor for that run. Conversation metadata
 * and message pinning remain client-owned and continue to use normal LWW.
 */
export function mergeConversationWithMonotonicAssistantState(
  stored: Conversation,
  incoming: Conversation,
): Conversation {
  const storedAssistants = new Map(
    stored.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.id, message]),
  )
  let correctedStaleAssistant = false
  const messages = incoming.messages.map((message) => {
    const storedAssistant = storedAssistants.get(message.id)
    if (!storedAssistant) return message
    if (
      incomingAssistantHasStrictlyNewerCursor(storedAssistant, message) ||
      incomingAssistantHasMonotonicTerminalState(storedAssistant, message)
    ) return message

    if (!sameAssistantCanonicalState(storedAssistant, message)) {
      correctedStaleAssistant = true
    }
    return {
      ...storedAssistant,
      pinned: message.pinned,
    }
  })

  return {
    ...incoming,
    messages,
    ...(correctedStaleAssistant
      ? {
          updatedAt: Math.max(
            (Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : 0) + 1,
            (Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0) + 1,
          ),
        }
      : {}),
  }
}

function mergeDurableLiveDirectiveMessage(stored: Message, incoming: Message | undefined): Message {
  const marker = liveDirectiveMarker(stored)
  if (!marker || !incoming || !sameLiveDirectiveMarker(incoming, marker)) return stored

  if (marker.part === 'instruction') {
    // The accepted instruction itself is immutable. A client may still add
    // harmless presentation state such as pinning, but cannot rewrite the
    // server-accepted role, text, timestamp, or marker.
    return {
      ...incoming,
      id: stored.id,
      role: stored.role,
      content: stored.content,
      timestamp: stored.timestamp,
      liveDirective: marker,
    }
  }

  if (marker.outcome === 'rejected') {
    // Rejection is a terminal server outcome. In particular, a tab that still
    // has the original blank continuation must never turn it back into a
    // pending-looking assistant segment.
    return stored
  }

  const storedSeq = Number.isFinite(stored.streamSeq) ? Number(stored.streamSeq) : 0
  const incomingSeq = Number.isFinite(incoming.streamSeq) ? Number(incoming.streamSeq) : 0
  const storedHasCursor = typeof stored.streamRunId === 'string' && stored.streamRunId.length > 0
  const incomingHasCursor = typeof incoming.streamRunId === 'string' && incoming.streamRunId.length > 0
  const incomingIsOlder = (
    storedHasCursor &&
    (!incomingHasCursor || (
      incoming.streamRunId === stored.streamRunId &&
      incomingSeq < storedSeq
    ))
  )
  const preferred = incomingIsOlder ? stored : incoming
  return {
    ...preferred,
    id: stored.id,
    role: stored.role,
    liveDirective: marker,
  }
}

/**
 * Reconciles a full client snapshot with server-accepted live instructions.
 * Only markers already present in the stored body are authoritative. Ordinary
 * messages continue to follow the client's full-snapshot semantics, while
 * durable directive messages are reinserted in their server order if a stale
 * tab omitted them.
 */
export function mergeConversationWithDurableLiveDirectives(
  stored: Conversation,
  incoming: Conversation,
): Conversation {
  const originalIncomingById = new Map(incoming.messages.map((message) => [message.id, message]))
  const monotonicIncoming = mergeConversationWithMonotonicAssistantState(stored, incoming)
  const protectedMessages = stored.messages.filter((message) => liveDirectiveMarker(message) !== null)
  if (protectedMessages.length === 0) return monotonicIncoming

  const protectedIds = new Set(protectedMessages.map((message) => message.id))
  const incomingById = new Map(monotonicIncoming.messages.map((message) => [message.id, message]))
  const messages = monotonicIncoming.messages.filter((message) => !protectedIds.has(message.id))
  const storedIndexById = new Map(stored.messages.map((message, index) => [message.id, index]))

  for (const storedMessage of protectedMessages) {
    const storedIndex = storedIndexById.get(storedMessage.id) ?? stored.messages.length
    let mergedMessage = mergeDurableLiveDirectiveMessage(
      storedMessage,
      incomingById.get(storedMessage.id),
    )
    const marker = liveDirectiveMarker(storedMessage)

    if (marker?.part === 'continuation') {
      const instructionIndex = stored.messages.findIndex((message) => {
        const candidate = liveDirectiveMarker(message)
        return candidate?.directiveId === marker.directiveId && candidate.part === 'instruction'
      })
      const incomingInstruction = instructionIndex >= 0
        ? originalIncomingById.get(stored.messages[instructionIndex].id)
        : undefined
      const incomingOmittedPair = (
        !sameLiveDirectiveMarker(originalIncomingById.get(storedMessage.id), marker) &&
        !(incomingInstruction && sameLiveDirectiveMarker(incomingInstruction, {
          ...marker,
          part: 'instruction',
        }))
      )

      if (incomingOmittedPair && instructionIndex > 0) {
        const predecessor = stored.messages[instructionIndex - 1].role === 'assistant'
          ? stored.messages[instructionIndex - 1]
          : undefined
        const predecessorIndex = predecessor
          ? messages.findIndex((message) => message.id === predecessor.id && message.role === 'assistant')
          : -1
        if (predecessorIndex >= 0) {
          const incomingPredecessor = messages[predecessorIndex]
          const storedSeq = Number.isFinite(mergedMessage.streamSeq) ? Number(mergedMessage.streamSeq) : 0
          const incomingSeq = Number.isFinite(incomingPredecessor.streamSeq)
            ? Number(incomingPredecessor.streamSeq)
            : 0
          const storedHasCursor = typeof mergedMessage.streamRunId === 'string' && mergedMessage.streamRunId.length > 0
          const incomingHasCursor = (
            typeof incomingPredecessor.streamRunId === 'string' &&
            incomingPredecessor.streamRunId.length > 0
          )
          const incomingUiIsCurrent = !storedHasCursor || (
            incomingHasCursor &&
            incomingPredecessor.streamRunId === mergedMessage.streamRunId &&
            incomingSeq >= storedSeq
          )
          if (incomingUiIsCurrent && marker.outcome !== 'rejected') {
            mergedMessage = {
              ...mergedMessage,
              streamTerminalStatus: incomingPredecessor.streamTerminalStatus,
              steps: incomingPredecessor.steps,
              taskGroups: incomingPredecessor.taskGroups,
              artifacts: incomingPredecessor.artifacts,
              computerPanelData: incomingPredecessor.computerPanelData,
              ...(incomingHasCursor
                ? {
                    streamRunId: incomingPredecessor.streamRunId,
                    streamSeq: incomingSeq,
                  }
                : {}),
            }
          }
          // A stale tab still treats the predecessor as the active assistant.
          // Mirror the acceptance split so only the continuation owns active
          // progress UI, while preserving predecessor text and reasoning.
          messages[predecessorIndex] = {
            ...incomingPredecessor,
            streamRunId: undefined,
            streamSeq: undefined,
            streamTerminalStatus: undefined,
            steps: incomingPredecessor.steps?.length ? [] : incomingPredecessor.steps,
            taskGroups: incomingPredecessor.taskGroups?.length ? [] : incomingPredecessor.taskGroups,
            artifacts: incomingPredecessor.artifacts?.length ? [] : incomingPredecessor.artifacts,
            computerPanelData: incomingPredecessor.computerPanelData?.length
              ? []
              : incomingPredecessor.computerPanelData,
            followUps: undefined,
          }
        }
      }
    }

    let insertionIndex = -1
    for (let index = storedIndex - 1; index >= 0; index -= 1) {
      const predecessorIndex = messages.findIndex((message) => message.id === stored.messages[index].id)
      if (predecessorIndex >= 0) {
        insertionIndex = predecessorIndex + 1
        break
      }
    }
    if (insertionIndex < 0) {
      for (let index = storedIndex + 1; index < stored.messages.length; index += 1) {
        const successorIndex = messages.findIndex((message) => message.id === stored.messages[index].id)
        if (successorIndex >= 0) {
          insertionIndex = successorIndex
          break
        }
      }
    }
    if (insertionIndex < 0) insertionIndex = messages.length
    messages.splice(insertionIndex, 0, mergedMessage)
  }

  return {
    ...monotonicIncoming,
    messages,
    // Force a subsequent index refresh to materialize the merged body in the
    // uploading tab instead of treating its stale timestamp as fully saved.
    updatedAt: Math.max(
      (Number.isFinite(monotonicIncoming.updatedAt) ? monotonicIncoming.updatedAt : 0) + 1,
      (Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0) + 1,
    ),
  }
}

/**
 * A full snapshot based on an older server revision may add metadata or a new
 * suffix, but it cannot prove that omitted stored messages were intentionally
 * deleted. Keep the canonical stored sequence, apply already-reconciled
 * same-ID assistant progress, and require unknown IDs to be rebased onto the
 * returned current revision before a later compare-and-swap may add them.
 */
export function mergeConversationForRevisionConflict(
  stored: Conversation,
  reconciledIncoming: Conversation,
): Conversation {
  const incomingById = new Map(reconciledIncoming.messages.map((message) => [message.id, message]))
  const messages = stored.messages.map((storedMessage) => {
    const incomingMessage = incomingById.get(storedMessage.id)
    if (!incomingMessage || incomingMessage.role !== storedMessage.role) return storedMessage
    if (storedMessage.role === 'assistant') return incomingMessage

    const storedMarker = liveDirectiveMarker(storedMessage)
    if (storedMarker) {
      return {
        ...storedMessage,
        pinned: incomingMessage.pinned,
        liveDirective: storedMarker,
      }
    }
    // Same-ID user text is canonical until a client proves it edited the
    // current revision. Presentation-only pinning remains safe to accept.
    return {
      ...storedMessage,
      pinned: incomingMessage.pinned,
    }
  })
  // Unknown IDs from a stale base are not yet accepted. The sync response
  // rebases the current client state onto this revision; a subsequent CAS may
  // then add legitimate local IDs. This prevents optimistic, ultimately
  // rejected task starts from becoming phantom durable turns.
  return {
    ...reconciledIncoming,
    messages,
    updatedAt: Math.max(
      (Number.isFinite(reconciledIncoming.updatedAt) ? reconciledIncoming.updatedAt : 0) + 1,
      (Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0) + 1,
    ),
  }
}

/**
 * Mirrors the client-side active-turn split. Keeping this pure makes the
 * durable representation deterministic and lets an idempotent retry detect
 * that its user message was already committed with the queue entry.
 */
export function appendAcceptedLiveDirectiveToConversation(
  conversation: Conversation,
  input: AcceptedLiveDirectiveConversationInput,
): Conversation {
  const existingUserMessage = conversation.messages.find((message) => message.id === input.directiveId)
  if (existingUserMessage) {
    if (existingUserMessage.role !== 'user' || existingUserMessage.content !== input.content) {
      throw new LiveDirectiveConversationPersistenceError('The live instruction id is already used by another message.')
    }
    return conversation
  }
  if (conversation.messages.some((message) => message.id === input.continuationMessageId)) {
    throw new LiveDirectiveConversationPersistenceError('The live instruction continuation id is already in use.')
  }

  const messages = [...conversation.messages]
  const userMessage: Conversation['messages'][number] = {
    id: input.directiveId,
    role: 'user',
    content: input.content,
    timestamp: input.createdAt,
    liveDirective: {
      directiveId: input.directiveId,
      part: 'instruction',
      acceptedAt: input.createdAt,
    },
  }
  const assistantMessage: Conversation['messages'][number] = {
    id: input.continuationMessageId,
    role: 'assistant',
    content: '',
    timestamp: input.createdAt,
    liveDirective: {
      directiveId: input.directiveId,
      part: 'continuation',
      acceptedAt: input.createdAt,
    },
    steps: [],
    artifacts: [],
    computerPanelData: [],
  }

  const lastIndex = messages.length - 1
  const current = messages[lastIndex]
  if (current?.role === 'assistant') {
    messages[lastIndex] = {
      ...current,
      streamRunId: undefined,
      streamSeq: undefined,
      streamTerminalStatus: undefined,
      steps: current.steps?.length ? [] : current.steps,
      taskGroups: current.taskGroups?.length ? [] : current.taskGroups,
      artifacts: current.artifacts?.length ? [] : current.artifacts,
      computerPanelData: current.computerPanelData?.length ? [] : current.computerPanelData,
      followUps: undefined,
    }
    messages.push(userMessage, {
      ...assistantMessage,
      streamRunId: current.streamRunId,
      streamSeq: current.streamSeq,
      streamTerminalStatus: current.streamTerminalStatus,
      steps: current.steps,
      taskGroups: current.taskGroups,
      artifacts: current.artifacts,
      computerPanelData: current.computerPanelData,
    })
    return {
      ...conversation,
      messages,
      updatedAt: nextConversationUpdateTime(conversation, input.createdAt),
    }
  }

  messages.push(userMessage, assistantMessage)
  return {
    ...conversation,
    messages,
    updatedAt: nextConversationUpdateTime(conversation, input.createdAt),
  }
}

export function appendRejectedLiveDirectiveOutcomeToConversation(
  conversation: Conversation,
  directiveId: string,
  continuationMessageId: string,
  rejectedAt: number,
): Conversation {
  const userIndex = conversation.messages.findIndex((message) => (
    message.id === directiveId && message.role === 'user'
  ))
  if (userIndex < 0) return conversation
  const continuationIndex = conversation.messages.findIndex((message) => (
    message.id === continuationMessageId && message.role === 'assistant'
  ))
  const currentContinuation = continuationIndex >= 0 ? conversation.messages[continuationIndex] : undefined

  const messages = [...conversation.messages]
  const currentUser = messages[userIndex]
  const requestedAcceptedAt = liveDirectiveMarker(currentUser)?.acceptedAt ?? currentUser.timestamp
  const acceptedAt = Number.isFinite(requestedAcceptedAt) ? requestedAcceptedAt : rejectedAt
  messages[userIndex] = {
    ...currentUser,
    liveDirective: {
      directiveId,
      part: 'instruction',
      acceptedAt,
    },
  }
  const currentContent = currentContinuation?.content.trim() || ''
  const rejectionContent = currentContent.includes(REJECTED_LIVE_DIRECTIVE_MESSAGE)
    ? currentContinuation?.content || REJECTED_LIVE_DIRECTIVE_MESSAGE
    : currentContent
      ? `${currentContinuation?.content}\n\n${REJECTED_LIVE_DIRECTIVE_MESSAGE}`
      : REJECTED_LIVE_DIRECTIVE_MESSAGE
  const rejectionMessage: Conversation['messages'][number] = {
    ...(currentContinuation || {
      id: continuationMessageId,
      role: 'assistant' as const,
      timestamp: rejectedAt,
      steps: [],
      artifacts: [],
      computerPanelData: [],
    }),
    content: rejectionContent,
    liveDirective: {
      directiveId,
      part: 'continuation',
      acceptedAt,
      outcome: 'rejected',
      outcomeAt: rejectedAt,
    },
  }
  if (continuationIndex >= 0) messages[continuationIndex] = rejectionMessage
  else messages.splice(userIndex + 1, 0, rejectionMessage)

  return {
    ...conversation,
    messages,
    updatedAt: nextConversationUpdateTime(conversation, rejectedAt),
  }
}

function parseLiveDirectiveConversationBody(raw: unknown, conversationId: string): Conversation {
  if (typeof raw !== 'string') {
    throw new LiveDirectiveConversationPersistenceError('The task history is unavailable for this instruction.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new LiveDirectiveConversationPersistenceError('The task history could not be read for this instruction.')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { id?: unknown }).id !== conversationId ||
    !Array.isArray((parsed as { messages?: unknown }).messages)
  ) {
    throw new LiveDirectiveConversationPersistenceError('The task history is invalid for this instruction.')
  }
  return parsed as Conversation
}

export async function persistAcceptedLiveDirectiveInConversation(
  transaction: Transaction,
  userId: string,
  conversationId: string,
  input: AcceptedLiveDirectiveConversationInput,
): Promise<void> {
  const selected = await transaction.execute({
    sql: `
      select body_json, revision
      from conversations
      where user_id = ? and id = ? and deleted_at_ms is null
      limit 1
    `,
    args: [userId, conversationId],
  })
  const originalBody = selected.rows[0]?.body_json
  const currentRevision = normalizedServerRevision(selected.rows[0]?.revision)
  const conversation = {
    ...parseLiveDirectiveConversationBody(originalBody, conversationId),
    serverRevision: currentRevision,
  }
  const appended = appendAcceptedLiveDirectiveToConversation(conversation, input)
  if (appended === conversation) return
  const updated = { ...appended, serverRevision: currentRevision + 1 }

  const updatedAtIso = new Date(updated.updatedAt).toISOString()
  const persisted = await transaction.execute({
    sql: `
      update conversations
      set body_json = ?, revision = ?, updated_at_ms = ?, updated_at = ?
      where user_id = ? and id = ? and deleted_at_ms is null and body_json = ?
    `,
    args: [
      JSON.stringify(updated),
      updated.serverRevision,
      updated.updatedAt,
      updatedAtIso,
      userId,
      conversationId,
      typeof originalBody === 'string' ? originalBody : '',
    ],
  })
  if (persisted.rowsAffected !== 1) {
    throw new LiveDirectiveConversationPersistenceError('The task history changed while accepting this instruction. Please retry.')
  }
}

export async function persistRejectedLiveDirectiveOutcomeInConversation(
  transaction: Transaction,
  userId: string,
  conversationId: string,
  directiveId: string,
  continuationMessageId: string,
  rejectedAt: number,
): Promise<void> {
  const selected = await transaction.execute({
    sql: `
      select body_json, revision
      from conversations
      where user_id = ? and id = ? and deleted_at_ms is null
      limit 1
    `,
    args: [userId, conversationId],
  })
  const originalBody = selected.rows[0]?.body_json
  const currentRevision = normalizedServerRevision(selected.rows[0]?.revision)
  if (typeof originalBody !== 'string') return

  let conversation: Conversation
  try {
    conversation = {
      ...parseLiveDirectiveConversationBody(originalBody, conversationId),
      serverRevision: currentRevision,
    }
  } catch {
    // A terminal cleanup must not be held open by an independently corrupted
    // history record. The durable directive receipt still exposes the outcome.
    return
  }

  const rejected = appendRejectedLiveDirectiveOutcomeToConversation(
    conversation,
    directiveId,
    continuationMessageId,
    rejectedAt,
  )
  if (rejected === conversation) return
  const updated = { ...rejected, serverRevision: currentRevision + 1 }
  await transaction.execute({
    sql: `
      update conversations
      set body_json = ?, revision = ?, updated_at_ms = ?, updated_at = ?
      where user_id = ? and id = ? and deleted_at_ms is null and body_json = ?
    `,
    args: [
      JSON.stringify(updated),
      updated.serverRevision,
      updated.updatedAt,
      new Date(updated.updatedAt).toISOString(),
      userId,
      conversationId,
      originalBody,
    ],
  })
}

export async function prepareUserConversationForTaskStartInsert(
  userId: string,
  input: TaskStartConversationInput,
): Promise<TaskStartConversationInsert | null> {
  if (!getTursoSetupStatus().configured) return null
  if (!validConversationId(input.conversationId)) return null

  // Schema work must finish before the caller opens its task-reservation
  // transaction. The returned insert itself is executed inside that transaction.
  await ensureConversationSchema()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const incomingMessages: Conversation['messages'] = input.messages.map((message, index) => ({
    id: message.id || taskStartMessageFallbackId(input.conversationId, message, index),
    role: message.role,
    content: message.content,
    ...(typeof message.streamRunId === 'string' && message.streamRunId
      ? { streamRunId: message.streamRunId }
      : {}),
    ...(Number.isFinite(message.streamSeq) ? { streamSeq: Number(message.streamSeq) } : {}),
    ...(message.streamTerminalStatus === 'done' || message.streamTerminalStatus === 'error'
      ? { streamTerminalStatus: message.streamTerminalStatus }
      : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    timestamp: Number.isFinite(message.timestamp) ? Number(message.timestamp) : nowMs + index,
  }))
  const selected = await tursoExecute(
    `
      select body_json, revision
      from conversations
      where user_id = ? and id = ? and deleted_at_ms is null
      limit 1
    `,
    [userId, input.conversationId],
  )
  const originalBody = selected.rows[0]?.body_json
  const currentRevision = normalizedServerRevision(selected.rows[0]?.revision)

  if (typeof originalBody === 'string') {
    let existing: Conversation
    try {
      existing = {
        ...parseLiveDirectiveConversationBody(originalBody, input.conversationId),
        serverRevision: currentRevision,
      }
    } catch {
      throw new Error('The saved task history could not be read safely. Refresh the task and try again.')
    }

    const mergedMessages = mergeConversationMessagesForTaskStart(existing.messages, incomingMessages)
    const conversation = normalizeConversationForPersistence({
      ...existing,
      customInstructions: input.customInstructions ?? existing.customInstructions,
      messages: mergedMessages,
      updatedAt: Math.max(nowMs, existing.updatedAt + 1),
      serverRevision: currentRevision + 1,
    })
    const bodyJson = JSON.stringify(conversation)
    return {
      sql: `
        update conversations
        set body_json = ?, server_placeholder = 0, revision = ?, updated_at_ms = ?, updated_at = ?
        where user_id = ?
          and id = ?
          and deleted_at_ms is null
          and body_json = ?
      `,
      args: [
        bodyJson,
        conversation.serverRevision || currentRevision + 1,
        conversation.updatedAt,
        new Date(conversation.updatedAt).toISOString(),
        userId,
        input.conversationId,
        originalBody,
      ],
    }
  }

  const conversation = normalizeConversationForPersistence({
    id: input.conversationId,
    title: titleFromMessages(input.messages),
    starred: false,
    createdAt: nowMs,
    updatedAt: nowMs,
    serverRevision: 1,
    customInstructions: input.customInstructions,
    messages: incomingMessages,
  })

  const bodyJson = JSON.stringify({
    ...conversation,
    serverStartPlaceholder: true,
  })

  return {
    sql: `
      insert into conversations (
        user_id, id, title, body_json, starred, folder, server_placeholder, revision,
        created_at_ms, updated_at_ms, deleted_at_ms, created_at, updated_at
      )
      values (?, ?, ?, ?, 0, null, 1, 1, ?, ?, null, ?, ?)
      on conflict(user_id, id) do nothing
    `,
    args: [
      userId,
      conversation.id,
      conversation.title,
      bodyJson,
      conversation.createdAt,
      conversation.updatedAt,
      nowIso,
      nowIso,
    ],
  }
}

export async function ensureUserConversationForTaskStart(
  userId: string,
  input: TaskStartConversationInput,
): Promise<void> {
  const insert = await prepareUserConversationForTaskStartInsert(userId, input)
  if (!insert) return
  await tursoExecute(insert.sql, insert.args)
}

function validConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id)
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const folders: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const folder = item.trim().slice(0, MAX_FOLDER_CHARS)
    if (folder && !folders.includes(folder)) folders.push(folder)
    if (folders.length >= MAX_SYNC_FOLDERS) break
  }
  return folders
}

function parseConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== 'object') return null
  const conversation = value as Partial<Conversation>
  if (!validConversationId(conversation.id)) return null
  if (!Array.isArray(conversation.messages)) return null

  return normalizeConversationForPersistence({
    id: conversation.id,
    title: typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title
      : 'New task',
    messages: (conversation.messages as Conversation['messages']).filter((message) => !message.pendingStartRunId),
    starred: conversation.starred === true,
    createdAt: Number.isFinite(conversation.createdAt) ? Number(conversation.createdAt) : Date.now(),
    updatedAt: Number.isFinite(conversation.updatedAt) ? Number(conversation.updatedAt) : Date.now(),
    serverRevision: Number.isInteger(conversation.serverRevision) && Number(conversation.serverRevision) > 0
      ? Number(conversation.serverRevision)
      : undefined,
    customInstructions: typeof conversation.customInstructions === 'string' ? conversation.customInstructions : undefined,
    branches: Array.isArray(conversation.branches) ? conversation.branches : undefined,
    tags: Array.isArray(conversation.tags) ? conversation.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    folder: typeof conversation.folder === 'string' ? conversation.folder : undefined,
  })
}

export function parseConversationSyncPayload(value: unknown): ConversationSyncInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as { conversations?: unknown; deletedIds?: unknown; folders?: unknown }
  if (!Array.isArray(input.conversations)) return null

  const parsedConversations = input.conversations
    .slice(0, MAX_SYNC_CONVERSATIONS)
    .map(parseConversation)
    .filter((conversation): conversation is Conversation => conversation !== null)
  const conversationsById = new Map<string, Conversation>()
  for (const conversation of normalizeConversationListForPersistence(parsedConversations)) {
    conversationsById.set(conversation.id, conversation)
  }

  const deletedIds = Array.isArray(input.deletedIds)
    ? input.deletedIds.filter(validConversationId)
    : []

  return {
    conversations: [...conversationsById.values()],
    deletedIds: [...new Set(deletedIds)],
    folders: Array.isArray(input.folders) ? normalizeFolders(input.folders) : undefined,
  }
}

function parseStoredConversation(raw: unknown, revision?: unknown): Conversation | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = parseConversation(JSON.parse(raw))
    if (!parsed) return null
    const serverRevision = Number(revision)
    return Number.isInteger(serverRevision) && serverRevision > 0
      ? { ...parsed, serverRevision }
      : parsed
  } catch {
    return null
  }
}

function parseStoredConversationSummary(row: Record<string, unknown>): StoredConversationSummary | null {
  const id = row.id
  if (!validConversationId(id)) return null
  const createdAt = Number(row.created_at_ms)
  const updatedAt = Number(row.updated_at_ms)
  const serverRevision = Number(row.revision)

  return {
    id,
    title: typeof row.title === 'string' && row.title.trim() ? row.title : 'New task',
    starred: row.starred === 1 || row.starred === true,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    serverRevision: Number.isInteger(serverRevision) && serverRevision > 0 ? serverRevision : 1,
    folder: typeof row.folder === 'string' && row.folder.trim() ? row.folder : undefined,
  }
}

function parseStoredFolders(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    return normalizeFolders(JSON.parse(raw || '[]'))
  } catch {
    return []
  }
}

export async function getUserConversationIndex(userId: string): Promise<StoredConversationIndex> {
  await ensureConversationSchema()
  const [conversationRows, metaRows, deletedRows] = await Promise.all([
    tursoExecute(
      `
        select id, title, starred, folder, created_at_ms, updated_at_ms, revision
        from conversations
        where user_id = ? and deleted_at_ms is null
        order by updated_at_ms desc
        limit ?
      `,
      [userId, MAX_SYNC_CONVERSATIONS],
    ),
    tursoExecute('select folders_json from user_conversation_meta where user_id = ? limit 1', [userId]),
    tursoExecute('select id from conversations where user_id = ? and deleted_at_ms is not null', [userId]),
  ])

  const conversations = conversationRows.rows
    .map((row) => parseStoredConversationSummary(row as Record<string, unknown>))
    .filter((conversation): conversation is StoredConversationSummary => conversation !== null)

  const folders = parseStoredFolders(metaRows.rows[0]?.folders_json)

  const deletedIds = deletedRows.rows
    .map((row) => row.id)
    .filter(validConversationId)

  return { conversations, deletedIds, folders }
}

export async function getUserConversationById(userId: string, id: string): Promise<Conversation | null> {
  if (!validConversationId(id)) return null
  await ensureConversationSchema()
  const rows = await tursoExecute(
    `
      select body_json, revision
      from conversations
      where user_id = ? and id = ? and deleted_at_ms is null
      limit 1
    `,
    [userId, id],
  )
  return parseStoredConversation(rows.rows[0]?.body_json, rows.rows[0]?.revision)
}

export async function getUserConversationState(userId: string): Promise<StoredConversationState> {
  await ensureConversationSchema()
  const [conversationRows, metaRows, deletedRows] = await Promise.all([
    tursoExecute(
      `
        select body_json, revision
        from conversations
        where user_id = ? and deleted_at_ms is null
        order by updated_at_ms desc
        limit ?
      `,
      [userId, MAX_SYNC_CONVERSATIONS],
    ),
    tursoExecute('select folders_json from user_conversation_meta where user_id = ? limit 1', [userId]),
    tursoExecute('select id from conversations where user_id = ? and deleted_at_ms is not null', [userId]),
  ])

  const conversations = conversationRows.rows
    .map((row) => parseStoredConversation(row.body_json, row.revision))
    .filter((conversation): conversation is Conversation => conversation !== null)

  const folders = parseStoredFolders(metaRows.rows[0]?.folders_json)

  const deletedIds = deletedRows.rows
    .map((row) => row.id)
    .filter(validConversationId)

  return { conversations, deletedIds, folders }
}

export async function syncUserConversations(userId: string, input: ConversationSyncInput): Promise<Conversation[]> {
  await ensureConversationSchema()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()

  return tursoTransaction('write', async (transaction) => {
    const reconciledConversations: Conversation[] = []
    for (const incomingConversation of input.conversations) {
      const createdAtMs = Math.max(0, Math.round(incomingConversation.createdAt || nowMs))
      const requestedUpdatedAtMs = Math.max(createdAtMs, Math.round(incomingConversation.updatedAt || nowMs))
      const selected = await transaction.execute({
        sql: `
          select body_json, server_placeholder, revision, created_at_ms, updated_at_ms, deleted_at_ms
          from conversations
          where user_id = ? and id = ?
          limit 1
        `,
        args: [userId, incomingConversation.id],
      })
      const currentRow = selected.rows[0]
      const currentUpdatedAtMs = Number(currentRow?.updated_at_ms)
      const currentDeletedAtMs = currentRow?.deleted_at_ms === null || currentRow?.deleted_at_ms === undefined
        ? 0
        : Number(currentRow.deleted_at_ms)
      const currentRevision = currentRow ? normalizedServerRevision(currentRow.revision) : 0
      const incomingRevision = Number(incomingConversation.serverRevision)
      const baseRevisionMatches = !!currentRow && (
        Number.isInteger(incomingRevision) &&
        incomingRevision > 0 &&
        incomingRevision === currentRevision
      )
      const currentIsPlaceholder = Number(currentRow?.server_placeholder) === 1
      const currentIsActive = !!currentRow && (
        currentRow.deleted_at_ms === null || currentRow.deleted_at_ms === undefined
      )
      const incomingCanReplaceCurrent = !currentRow || (
        currentIsActive
          ? baseRevisionMatches || currentIsPlaceholder || (
              requestedUpdatedAtMs >= (Number.isFinite(currentUpdatedAtMs) ? currentUpdatedAtMs : 0)
            )
          : baseRevisionMatches && (
              requestedUpdatedAtMs >= (Number.isFinite(currentDeletedAtMs) ? currentDeletedAtMs : 0)
            )
      )
      if (!incomingCanReplaceCurrent) {
        if (currentIsActive) {
          const current = parseStoredConversation(currentRow?.body_json, currentRevision)
          if (current) reconciledConversations.push(current)
        }
        continue
      }

      let conversation = incomingConversation
      if (currentIsActive && typeof currentRow.body_json === 'string') {
        try {
          const stored = {
            ...parseLiveDirectiveConversationBody(currentRow.body_json, incomingConversation.id),
            serverRevision: currentRevision,
          }
          conversation = mergeConversationWithDurableLiveDirectives(stored, incomingConversation)
          if (!baseRevisionMatches) {
            conversation = mergeConversationForRevisionConflict(stored, conversation)
          }
        } catch {
          // Without a matching revision, a malformed current body cannot be
          // destructively replaced safely. Leave it untouched for explicit
          // repair instead of guessing which messages the stale client lost.
          if (!baseRevisionMatches && !currentIsPlaceholder) continue
        }
      }

      const nextRevision = currentRow ? currentRevision + 1 : 1
      const updatedAtMs = Math.max(createdAtMs, Math.round(conversation.updatedAt || requestedUpdatedAtMs))
      conversation = {
        ...conversation,
        createdAt: currentRow
          ? Math.min(createdAtMs, Number(currentRow.created_at_ms) || createdAtMs)
          : createdAtMs,
        updatedAt: updatedAtMs,
        serverRevision: nextRevision,
      }
      const updatedAtIso = new Date(updatedAtMs).toISOString()
      if (!currentRow) {
        const inserted = await transaction.execute({
          sql: `
            insert into conversations (
              user_id, id, title, body_json, starred, folder, server_placeholder, revision,
              created_at_ms, updated_at_ms, deleted_at_ms, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, null, ?, ?)
            on conflict(user_id, id) do nothing
          `,
          args: [
            userId,
            conversation.id,
            conversation.title,
            JSON.stringify(conversation),
            conversation.starred ? 1 : 0,
            conversation.folder || null,
            createdAtMs,
            updatedAtMs,
            new Date(createdAtMs).toISOString(),
            updatedAtIso,
          ],
        })
        if (inserted.rowsAffected !== 1) {
          throw new Error('The task history changed while it was being saved. Please retry.')
        }
      } else {
        const updated = await transaction.execute({
          sql: `
            update conversations
            set title = ?,
                body_json = ?,
                starred = ?,
                folder = ?,
                server_placeholder = 0,
                revision = ?,
                created_at_ms = min(created_at_ms, ?),
                updated_at_ms = ?,
                deleted_at_ms = null,
                updated_at = ?
            where user_id = ? and id = ? and revision = ?
          `,
          args: [
            conversation.title,
            JSON.stringify(conversation),
            conversation.starred ? 1 : 0,
            conversation.folder || null,
            nextRevision,
            createdAtMs,
            updatedAtMs,
            updatedAtIso,
            userId,
            conversation.id,
            currentRevision,
          ],
        })
        if (updated.rowsAffected !== 1) {
          throw new Error('The task history changed while it was being saved. Please retry.')
        }
      }
      reconciledConversations.push(conversation)
    }

    for (const id of input.deletedIds) {
      await transaction.execute({
        sql: `
          update conversations
          set deleted_at_ms = ?,
              updated_at_ms = max(updated_at_ms, ?),
              revision = revision + 1,
              updated_at = ?
          where user_id = ? and id = ? and coalesce(deleted_at_ms, 0) < ?
        `,
        args: [nowMs, nowMs, nowIso, userId, id, nowMs],
      })
    }

    if (input.folders) {
      await transaction.execute({
        sql: `
          insert into user_conversation_meta (user_id, folders_json, updated_at_ms, updated_at)
          values (?, ?, ?, ?)
          on conflict(user_id) do update set
            folders_json = excluded.folders_json,
            updated_at_ms = excluded.updated_at_ms,
            updated_at = excluded.updated_at
        `,
        args: [userId, JSON.stringify(normalizeFolders(input.folders)), nowMs, nowIso],
      })
    }

    const deleted = new Set(input.deletedIds)
    return reconciledConversations.filter((conversation) => !deleted.has(conversation.id))
  })
}

export async function clearUserConversations(userId: string): Promise<void> {
  await ensureConversationSchema()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  await tursoTransaction('write', async (transaction) => {
    await transaction.execute({
      sql: `
        update conversations
        set deleted_at_ms = ?,
            updated_at_ms = max(updated_at_ms, ?),
            revision = revision + 1,
            updated_at = ?
        where user_id = ? and deleted_at_ms is null
      `,
      args: [nowMs, nowMs, nowIso, userId],
    })
    await transaction.execute({
      sql: `
        insert into user_conversation_meta (user_id, folders_json, updated_at_ms, updated_at)
        values (?, '[]', ?, ?)
        on conflict(user_id) do update set
          folders_json = '[]',
          updated_at_ms = excluded.updated_at_ms,
          updated_at = excluded.updated_at
      `,
      args: [userId, nowMs, nowIso],
    })
  })
}
