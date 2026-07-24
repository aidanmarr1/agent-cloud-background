'use client'

import { useSettingsStore } from '@/store/settings'
import { Bell, CornerDownLeft, Volume2 } from '@/components/icons'
import { Toggle } from '@/components/ui/Toggle'
import { SettingRow } from '@/components/ui/SettingRow'
import { SettingsSection, settingsPanelClass } from './SettingsSection'

export function GeneralTab() {
  const {
    soundEnabled, setSoundEnabled,
    sendWithEnter, setSendWithEnter,
    desktopNotifications, setDesktopNotifications,
  } = useSettingsStore()

  return (
    <SettingsSection
      title="Task interaction"
      description="Choose how task actions feel and when Agent gets your attention."
    >
      <div className={`${settingsPanelClass} divide-y divide-border-secondary`}>
        <SettingRow
          icon={Volume2}
          iconColor={soundEnabled ? 'text-accent-blue' : 'text-text-muted'}
          label="Sound effects"
          description="Play a sound when tasks send, complete, or encounter an error"
        >
          <Toggle enabled={soundEnabled} onChange={setSoundEnabled} label="Sound effects" />
        </SettingRow>
        <SettingRow
          icon={CornerDownLeft}
          iconColor={sendWithEnter ? 'text-accent-blue' : 'text-text-muted'}
          label="Send with Enter"
          description="When off, use ⌘/Ctrl + Enter to send"
        >
          <Toggle enabled={sendWithEnter} onChange={setSendWithEnter} label="Send with Enter" />
        </SettingRow>
        <SettingRow
          icon={Bell}
          iconColor={desktopNotifications ? 'text-accent-blue' : 'text-text-muted'}
          label="Desktop notifications"
          description="Notify you when a response finishes in the background"
        >
          <Toggle enabled={desktopNotifications} onChange={setDesktopNotifications} label="Desktop notifications" />
        </SettingRow>
      </div>
    </SettingsSection>
  )
}
