import type { Conversation } from '@/types'
import type { ConversationSlice } from './conversationSlice'
import type { MessageSlice } from './messageSlice'
import type { TaskSlice } from './taskSlice'
import type { ArtifactSlice } from './artifactSlice'

export interface ChatState {
  conversations: Conversation[]
  activeId: string | null
  folders: string[]
}

export type ChatStore = ChatState & ConversationSlice & MessageSlice & TaskSlice & ArtifactSlice

export type SliceCreator<T> = (
  set: (partial: Partial<ChatStore> | ((state: ChatStore) => Partial<ChatStore>)) => void,
  get: () => ChatStore,
) => T
