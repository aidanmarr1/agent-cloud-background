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
  serverSummary?: boolean
  customInstructions?: string
  branches?: ConversationBranch[]
  tags?: string[]
  folder?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
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
