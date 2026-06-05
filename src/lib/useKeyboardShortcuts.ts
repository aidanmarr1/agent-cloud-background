import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUIStore } from '@/store/ui'

export function useKeyboardShortcuts() {
  const router = useRouter()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const target = e.target as HTMLElement | null
      const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

      if (meta && e.key === 'n') {
        e.preventDefault()
        router.push('/')
      }

      // Cmd+K is handled by the CommandPalette component

      if (meta && e.key === ',') {
        e.preventDefault()
        useUIStore.getState().setSettingsOpen(true)
      }

      // Cmd+F: open current-task search (prevent browser find)
      if (meta && e.key === 'f') {
        e.preventDefault()
        useUIStore.getState().setConversationSearchOpen(true)
      }

      // Cmd+Shift+C: toggle computer panel
      if (meta && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        useUIStore.getState().toggleComputerPanel()
      }

      // Cmd+Shift+E: toggle sidebar
      if (meta && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        useUIStore.getState().toggleSidebar()
      }

      // ? key: toggle shortcuts panel (only when not in an input)
      if (e.key === '?' && !inInput) {
        e.preventDefault()
        const ui = useUIStore.getState()
        ui.setShortcutsPanelOpen(!ui.shortcutsPanelOpen)
      }

      if (e.key === 'Escape') {
        const ui = useUIStore.getState()
        if (ui.conversationSearchOpen) {
          ui.setConversationSearchOpen(false)
        } else if (ui.shortcutsPanelOpen) {
          ui.setShortcutsPanelOpen(false)
        } else if (ui.settingsOpen) {
          ui.setSettingsOpen(false)
        } else if (ui.computerPanelOpen) {
          ui.setComputerPanelOpen(false, { source: 'user' })
        } else if (ui.sidebarExpanded) {
          ui.toggleSidebar()
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [router])
}
