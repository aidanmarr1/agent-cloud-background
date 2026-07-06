'use client'

import { SettingsModal } from '@/components/modals/SettingsModal'
import { ShortcutsPanel } from '@/components/modals/ShortcutsPanel'
import { ActiveTaskConflictModal } from '@/components/modals/ActiveTaskConflictModal'
import { AccountDeletedGate } from '@/components/auth/AccountDeletedGate'
import { CommandPalette } from '@/components/ui/CommandPalette'
import { KeyboardShortcuts } from '@/components/ui/KeyboardShortcuts'
import { Toast } from '@/components/ui/Toast'
import { useUIStore } from '@/store/ui'

export function RootOverlays({
  initialAccountDeleted = false,
}: {
  initialAccountDeleted?: boolean
}) {
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const shortcutsPanelOpen = useUIStore((s) => s.shortcutsPanelOpen)

  return (
    <>
      {settingsOpen && <SettingsModal />}
      {shortcutsPanelOpen && <ShortcutsPanel />}
      <ActiveTaskConflictModal />
      <AccountDeletedGate initialAccountDeleted={initialAccountDeleted} />
      <KeyboardShortcuts />
      <CommandPalette />
      <Toast />
    </>
  )
}
