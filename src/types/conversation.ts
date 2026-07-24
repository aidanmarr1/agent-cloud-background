import type { TaskStep, TaskGroup } from './tasks'
import type { FollowUpSuggestion } from './events'
import type { Artifact } from './artifacts'
import type { ComputerPanelItem } from './ui'

export interface ConversationBranch {
  id: string
  parentMessageId: string
  messages: Message[]
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  starred: boolean
  createdAt: number
  updatedAt: number
  /** Monotonic server revision used to reconcile concurrent full snapshots. */
  serverRevision?: number
  serverSummary?: boolean
  /** Local body is older than a server summary and must never be uploaded. */
  serverBodyStale?: boolean
  customInstructions?: string
  branches?: ConversationBranch[]
  tags?: string[]
  folder?: string
}

export interface LiveDirectiveMessageMarker {
  directiveId: string
  part: 'instruction' | 'continuation'
  acceptedAt: number
  outcome?: 'rejected'
  outcomeAt?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /**
   * Cursor for the durable SSE run that produced this assistant message.
   * Keeping the cursor on the message makes replay progress persist atomically
   * with the rendered task state instead of relying only on localStorage.
   */
  streamRunId?: string
  streamSeq?: number
  /** Persisted proof that this stream cursor already observed its terminal event. */
  streamTerminalStatus?: 'done' | 'error'
  /** Local-only optimistic start marker; server sync must omit these messages until acceptance. */
  pendingStartRunId?: string
  /**
   * Server-issued marker for a live instruction that was durably accepted.
   * Conversation sync uses this to keep accepted instructions and their
   * continuation segment from being erased by a stale tab.
   */
  liveDirective?: LiveDirectiveMessageMarker
  reasoning?: string
  attachments?: FileAttachment[]
  timestamp: number
  steps?: TaskStep[]
  taskGroups?: TaskGroup[]
  plan?: string[]
  followUps?: FollowUpSuggestion[]
  artifacts?: Artifact[]
  computerPanelData?: ComputerPanelItem[]
  pinned?: boolean
}

export interface FileAttachment {
  id?: string
  name: string
  type: string
  size: number
  content?: string
  contentEncoding?: 'text' | 'data-url'
  url?: string
  sandboxPath?: string
  persisted?: boolean
  preview?: string
}
