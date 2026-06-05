import type { Artifact, ComputerPanelItem } from '@/types'
import type { SliceCreator } from './types'
import { updateLastAssistantMessage } from './persistence'

export interface ArtifactSlice {
  addArtifact: (convId: string, artifact: Artifact) => void
  addComputerPanelItem: (convId: string, item: ComputerPanelItem) => void
  upsertComputerPanelItem: (convId: string, item: ComputerPanelItem) => void
  removeComputerPanelItem: (convId: string, itemId: string) => void
}

export const createArtifactSlice: SliceCreator<ArtifactSlice> = (set) => ({
  addArtifact: (convId, artifact) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const artifacts = msg.artifacts || []
        const existingIdx = artifacts.findIndex(a => a.filePath === artifact.filePath)
        if (existingIdx >= 0) {
          const updated = [...artifacts]
          updated[existingIdx] = artifact
          return { ...msg, artifacts: updated }
        }
        return { ...msg, artifacts: [...artifacts, artifact] }
      }),
    }))
  },

  addComputerPanelItem: (convId, item) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const existing = msg.computerPanelData || []
        let items = [...existing, item]
        if (items.length > 50) {
          const nonStreaming = items.filter(i => !i.streaming)
          const streaming = items.filter(i => i.streaming)
          items = [...nonStreaming.slice(nonStreaming.length - (50 - streaming.length)), ...streaming]
          if (items.length > 50) items = items.slice(items.length - 50)
        }
        return { ...msg, computerPanelData: items }
      }),
    }))
  },

  upsertComputerPanelItem: (convId, item) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => {
        const items = msg.computerPanelData || []
        const idx = items.findIndex(i => i.id === item.id)
        if (idx >= 0) {
          if (item.id === 'browser_live') {
            const updated = items.filter((_, i) => i !== idx)
            updated.push(item)
            return { ...msg, computerPanelData: updated }
          }
          const updated = [...items]
          updated[idx] = item
          return { ...msg, computerPanelData: updated }
        }
        return { ...msg, computerPanelData: [...items, item] }
      }),
    }))
  },

  removeComputerPanelItem: (convId, itemId) => {
    set((state) => ({
      conversations: updateLastAssistantMessage(state.conversations, convId, (msg) => ({
        ...msg,
        computerPanelData: (msg.computerPanelData || []).filter((item) => item.id !== itemId),
      })),
    }))
  },
})
