'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StreamingStatus } from '@/types'

interface ToastItem {
  id: string
  message: string
  type: 'info' | 'error' | 'success'
}

interface ActiveTaskConflictModal {
  message: string
  activeConversationId?: string
}

interface ProjectFilesOpenRequest {
  conversationId: string
  filePath?: string
  requestId: number
}

type ComputerPanelOpenSource = 'user' | 'auto'
interface ComputerPanelOpenOptions {
  source?: ComputerPanelOpenSource
}

interface UIStore {
  sidebarExpanded: boolean
  mobileSidebarOpen: boolean
  computerPanelOpen: boolean
  computerPanelAutoOpenSuppressed: boolean
  computerActiveTab: 'activity' | 'webide'
  computerPanelActiveItemId: string | null
  computerPanelFullWidth: boolean
  computerPanelWidth: number
  _prevPanelWidth: number | null
  settingsOpen: boolean
  settingsTab: string
  isStreaming: boolean
  streamingStatus: StreamingStatus
  routeHandoffPending: boolean
  toasts: ToastItem[]
  dismissingToasts: Set<string>
  activeTaskConflictModal: ActiveTaskConflictModal | null
  projectFilesOpenRequest: ProjectFilesOpenRequest | null

  // Selection mode
  selectionMode: boolean
  selectedConversationIds: Set<string>
  toggleSelectionMode: () => void
  toggleConversationSelection: (id: string) => void
  clearSelection: () => void

  // Feature panel states
  conversationSearchOpen: boolean
  shortcutsPanelOpen: boolean
  artifactGalleryOpen: boolean

  // Web IDE state
  webIdeMode: boolean
  webIdeActiveTab: 'preview' | 'code'
  webIdeConversationId: string | null
  webIdeEntryFile: string | null
  webIdePreviewUrl: string | null
  webIdeRefreshKey: number
  webIdeSelectedFile: string | null
  webIdeStreamingFile: { path: string; content: string } | null
  webIdeViewport: 'desktop' | 'tablet' | 'mobile'

  toggleSidebar: () => void
  setMobileSidebarOpen: (open: boolean) => void
  setComputerPanelOpen: (open: boolean, options?: ComputerPanelOpenOptions) => void
  resetComputerPanelAutoOpenSuppression: () => void
  setComputerActiveTab: (tab: 'activity' | 'webide') => void
  setComputerPanelActiveItemId: (id: string | null) => void
  toggleComputerPanel: () => void
  toggleComputerPanelFullWidth: () => void
  setComputerPanelWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsTab: (tab: string) => void
  setStreaming: (streaming: boolean) => void
  setStreamingStatus: (status: StreamingStatus) => void
  setRouteHandoffPending: (pending: boolean) => void
  addToast: (message: string, type?: ToastItem['type']) => void
  removeToast: (id: string) => void
  showActiveTaskConflict: (modal?: Partial<ActiveTaskConflictModal>) => void
  dismissActiveTaskConflict: () => void
  openProjectFiles: (conversationId: string, filePath?: string) => void

  // Feature panel setters
  setConversationSearchOpen: (open: boolean) => void
  setShortcutsPanelOpen: (open: boolean) => void
  setArtifactGalleryOpen: (open: boolean) => void

  // Web IDE actions
  activateWebIde: (conversationId: string, entryFile: string, options?: ComputerPanelOpenOptions) => void
  deactivateWebIde: () => void
  setWebIdeActiveTab: (tab: 'preview' | 'code') => void
  setWebIdePreviewUrl: (url: string | null) => void
  incrementWebIdeRefresh: () => void
  setWebIdeSelectedFile: (path: string | null) => void
  setWebIdeStreamingFile: (file: { path: string; content: string } | null) => void
  appendWebIdeStreamingContent: (content: string) => void
  setWebIdeViewport: (viewport: 'desktop' | 'tablet' | 'mobile') => void
}

// Module-level toast state. Both branches of the previous ternary were
// identical — Maps are safe to construct on the server, so the SSR guard was
// a no-op.
const toastState = {
  id: 0,
  timers: new Map<string, ReturnType<typeof setTimeout>>(),
  recentMessages: new Map<string, number>(),
}
const MAX_TOASTS = 3
const DEDUP_WINDOW_MS = 5000
const UI_PREFERENCES_KEY = 'agent-ui-preferences'
const SIDEBAR_COOKIE = 'agent-sidebar-collapsed'

function writeSidebarCookie(collapsed: boolean) {
  if (typeof document === 'undefined') return
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? '1' : '0'}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      sidebarExpanded: false,
      mobileSidebarOpen: false,
      computerPanelOpen: false,
      computerPanelAutoOpenSuppressed: false,
      computerActiveTab: 'activity',
      computerPanelActiveItemId: null,
      computerPanelFullWidth: false,
      computerPanelWidth: 30,
      _prevPanelWidth: null,
      settingsOpen: false,
      settingsTab: 'general',
      isStreaming: false,
      streamingStatus: null,
      routeHandoffPending: false,
      toasts: [],
      dismissingToasts: new Set(),
      activeTaskConflictModal: null,
      projectFilesOpenRequest: null,

      selectionMode: false,
      selectedConversationIds: new Set<string>(),
      toggleSelectionMode: () => set((s) => ({
        selectionMode: !s.selectionMode,
        selectedConversationIds: s.selectionMode ? new Set<string>() : s.selectedConversationIds,
      })),
      toggleConversationSelection: (id) => set((s) => {
        const next = new Set(s.selectedConversationIds)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return { selectedConversationIds: next }
      }),
      clearSelection: () => set({ selectedConversationIds: new Set<string>() }),

      conversationSearchOpen: false,
      shortcutsPanelOpen: false,
      artifactGalleryOpen: false,

      webIdeMode: false,
      webIdeActiveTab: 'preview',
      webIdeConversationId: null,
      webIdeEntryFile: null,
      webIdePreviewUrl: null,
      webIdeRefreshKey: 0,
      webIdeSelectedFile: null,
      webIdeStreamingFile: null,
      webIdeViewport: 'desktop',

      toggleSidebar: () => set((s) => {
        const sidebarExpanded = !s.sidebarExpanded
        writeSidebarCookie(sidebarExpanded)
        return { sidebarExpanded }
      }),
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      setComputerPanelOpen: (open, options) => set((s) => {
        const source = options?.source ?? 'user'
        if (source === 'auto') {
          if (open && s.computerPanelAutoOpenSuppressed) return {}
          return { computerPanelOpen: open }
        }
        return {
          computerPanelOpen: open,
          computerPanelAutoOpenSuppressed: open ? false : true,
        }
      }),
      resetComputerPanelAutoOpenSuppression: () => set({ computerPanelAutoOpenSuppressed: false }),
      setComputerActiveTab: (tab) => set({ computerActiveTab: tab }),
      setComputerPanelActiveItemId: (id) => set({ computerPanelActiveItemId: id }),
      toggleComputerPanel: () => set((s) => {
        const computerPanelOpen = !s.computerPanelOpen
        return {
          computerPanelOpen,
          computerPanelAutoOpenSuppressed: computerPanelOpen ? false : true,
        }
      }),
      toggleComputerPanelFullWidth: () => set((s) => {
        if (s.computerPanelFullWidth) {
          return { computerPanelFullWidth: false, computerPanelWidth: s._prevPanelWidth ?? 30 }
        }
        return { computerPanelFullWidth: true, _prevPanelWidth: s.computerPanelWidth, computerPanelWidth: 55 }
      }),
      setComputerPanelWidth: (width) => set({ computerPanelWidth: width, computerPanelFullWidth: false }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setSettingsTab: (tab) => set({ settingsTab: tab }),
      setStreaming: (streaming) => set((s) => ({
        isStreaming: streaming,
        ...(streaming ? {} : { streamingStatus: null as StreamingStatus }),
      })),
      setStreamingStatus: (status) => set({ streamingStatus: status }),
      setRouteHandoffPending: (pending) => set({ routeHandoffPending: pending }),
      addToast: (message, type = 'info') => {
        // Deduplication: skip if same message was shown within DEDUP_WINDOW_MS
        const now = Date.now()
        const lastShown = toastState.recentMessages.get(message)
        if (lastShown && now - lastShown < DEDUP_WINDOW_MS) return

        // Clean stale dedup entries to prevent unbounded growth
        if (toastState.recentMessages.size > 50) {
          for (const [msg, ts] of toastState.recentMessages) {
            if (now - ts >= DEDUP_WINDOW_MS) toastState.recentMessages.delete(msg)
          }
        }

        toastState.recentMessages.set(message, now)

        const id = String(++toastState.id)
        set((s) => {
          // Enforce max toast limit by dropping oldest if needed
          const updated = [...s.toasts, { id, message, type }]
          if (updated.length > MAX_TOASTS) {
            // Clear timers for dropped toasts to prevent leaks
            const dropped = updated.slice(0, updated.length - MAX_TOASTS)
            for (const t of dropped) {
              const timer = toastState.timers.get(t.id)
              if (timer) { clearTimeout(timer); toastState.timers.delete(t.id) }
            }
            return { toasts: updated.slice(-MAX_TOASTS) }
          }
          return { toasts: updated }
        })
        const timer = setTimeout(() => {
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
          toastState.recentMessages.delete(message)
          toastState.timers.delete(id)
        }, 4000)
        toastState.timers.set(id, timer)
      },
      removeToast: (id) => {
        const timer = toastState.timers.get(id)
        if (timer) { clearTimeout(timer); toastState.timers.delete(id) }
        // Cancelling the auto-dismiss timer above also cancels its recentMessages cleanup,
        // so we have to delete the dedup entry here — otherwise the same message is silently
        // suppressed for the next DEDUP_WINDOW_MS even though the user explicitly dismissed it.
        const dismissed = useUIStore.getState().toasts.find((t) => t.id === id)
        if (dismissed) toastState.recentMessages.delete(dismissed.message)
        set((s) => ({ dismissingToasts: new Set([...s.dismissingToasts, id]) }))
        setTimeout(() => {
          set((s) => {
            const next = new Set(s.dismissingToasts)
            next.delete(id)
            return { toasts: s.toasts.filter((t) => t.id !== id), dismissingToasts: next }
          })
        }, 200)
      },
      showActiveTaskConflict: (modal = {}) => set({
        activeTaskConflictModal: {
          message: modal.message || 'A task is already running. Finish or stop the current task before starting another.',
          activeConversationId: modal.activeConversationId,
        },
      }),
      dismissActiveTaskConflict: () => set({ activeTaskConflictModal: null }),
      openProjectFiles: (conversationId, filePath) => set({
        projectFilesOpenRequest: {
          conversationId,
          filePath,
          requestId: Date.now(),
        },
      }),

      setConversationSearchOpen: (open) => set({ conversationSearchOpen: open }),
      setShortcutsPanelOpen: (open) => set({ shortcutsPanelOpen: open }),
      setArtifactGalleryOpen: (open) => set({ artifactGalleryOpen: open }),

      activateWebIde: (conversationId, entryFile, options) => set((s) => {
        const source = options?.source ?? 'auto'
        const shouldOpenPanel = source === 'user' || !s.computerPanelAutoOpenSuppressed
        return {
          webIdeMode: true,
          computerPanelOpen: shouldOpenPanel ? true : s.computerPanelOpen,
          computerActiveTab: 'webide',
          webIdeActiveTab: 'code',
          webIdeConversationId: conversationId,
          webIdeEntryFile: entryFile,
          webIdePreviewUrl: null,
          webIdeRefreshKey: 0,
        }
      }),
      deactivateWebIde: () => set({
        webIdeMode: false,
        computerActiveTab: 'activity',
        webIdePreviewUrl: null,
        webIdeSelectedFile: null,
        webIdeStreamingFile: null,
      }),
      setWebIdeActiveTab: (tab) => set({ webIdeActiveTab: tab }),
      setWebIdePreviewUrl: (url) => set({ webIdePreviewUrl: url }),
      incrementWebIdeRefresh: () => set((s) => ({ webIdeRefreshKey: s.webIdeRefreshKey + 1 })),
      setWebIdeSelectedFile: (path) => set({ webIdeSelectedFile: path }),
      setWebIdeStreamingFile: (file) => set({ webIdeStreamingFile: file }),
      appendWebIdeStreamingContent: (content) => set((s) => {
        if (!s.webIdeStreamingFile) return s
        return {
          webIdeStreamingFile: {
            ...s.webIdeStreamingFile,
            content: s.webIdeStreamingFile.content + content,
          },
        }
      }),
      setWebIdeViewport: (viewport) => set({ webIdeViewport: viewport }),
    }),
    {
      name: UI_PREFERENCES_KEY,
      skipHydration: true,
      merge: (persistedState, currentState) => {
        const saved = persistedState as Partial<UIStore> | null
        return {
          ...currentState,
          sidebarExpanded: saved?.sidebarExpanded ?? currentState.sidebarExpanded,
          computerPanelFullWidth: saved?.computerPanelFullWidth ?? currentState.computerPanelFullWidth,
          computerPanelWidth: saved?.computerPanelWidth ?? currentState.computerPanelWidth,
          _prevPanelWidth: saved?._prevPanelWidth ?? currentState._prevPanelWidth,
          webIdeViewport: saved?.webIdeViewport ?? currentState.webIdeViewport,
          isStreaming: currentState.isStreaming,
          streamingStatus: currentState.streamingStatus,
          toasts: [],
          dismissingToasts: new Set<string>(),
          activeTaskConflictModal: null,
          projectFilesOpenRequest: null,
        }
      },
      partialize: (state) => ({
        sidebarExpanded: state.sidebarExpanded,
        computerPanelFullWidth: state.computerPanelFullWidth,
        computerPanelWidth: state.computerPanelWidth,
        _prevPanelWidth: state._prevPanelWidth,
        webIdeViewport: state.webIdeViewport,
      }),
    }
  )
)
