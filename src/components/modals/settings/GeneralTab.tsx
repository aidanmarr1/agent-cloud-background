'use client'

import { useSettingsStore } from '@/store/settings'
import { Bell, CornerDownLeft, Globe2, Monitor, Moon, Sun, Volume2 } from '@/components/icons'
import { Toggle } from '@/components/ui/Toggle'
import { SettingRow } from '@/components/ui/SettingRow'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { CustomSelect } from '@/components/ui/CustomSelect'

const languageOptions = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
]

const themeOptions = [
  { id: 'light' as const, label: 'Light', icon: Sun },
  { id: 'dark' as const, label: 'Dark', icon: Moon },
  { id: 'system' as const, label: 'Auto', icon: Monitor },
]

export function GeneralTab() {
  const {
    theme, setTheme,
    language, setLanguage,
    soundEnabled, setSoundEnabled,
    sendWithEnter, setSendWithEnter,
    desktopNotifications, setDesktopNotifications,
  } = useSettingsStore()

  return (
    <div className="space-y-8">
      <div>
        <SectionLabel>Appearance</SectionLabel>
        <div className="mt-4 divide-y divide-border-secondary border-y border-border-secondary">
          <SettingRow
            icon={Globe2}
            iconColor="text-accent-blue"
            label="Language"
            description="Controls labels and interface text"
          >
            <div className="relative w-full sm:w-48">
              <CustomSelect
                value={language}
                onChange={setLanguage}
                options={languageOptions}
                label="Language"
              />
            </div>
          </SettingRow>
        </div>

        <div className="mt-6">
          <div className="text-[15px] font-semibold text-text-primary tracking-[0]">Theme</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {themeOptions.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                onClick={() => setTheme(id)}
                data-no-focus-ring
                className={`flex h-24 flex-col items-center justify-center gap-2 rounded-xl border text-[13px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-tertiary ${
                  theme === id
                    ? 'border-text-primary bg-bg-primary text-text-primary'
                    : 'border-border-primary bg-bg-primary text-text-secondary hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary'
                }`}
                aria-pressed={theme === id}
              >
                <Icon size={20} className={theme === id ? 'text-text-primary' : 'text-text-muted'} strokeWidth={2.25} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-border-secondary pt-7">
        <SectionLabel>Communication preferences</SectionLabel>
        <div className="mt-4 divide-y divide-border-secondary border-y border-border-secondary">
          <SettingRow
            icon={Volume2}
            iconColor={soundEnabled ? 'text-accent-blue' : 'text-text-muted'}
            label="Sound effects"
            description="Play sounds on send, complete, and error"
          >
            <Toggle enabled={soundEnabled} onChange={setSoundEnabled} label="Toggle sound effects" />
          </SettingRow>
          <SettingRow
            icon={CornerDownLeft}
            iconColor={sendWithEnter ? 'text-accent-blue' : 'text-text-muted'}
            label="Send with Enter"
            description="Off: use ⌘+Enter to send instead"
          >
            <Toggle enabled={sendWithEnter} onChange={setSendWithEnter} label="Toggle send with Enter" />
          </SettingRow>
          <SettingRow
            icon={Bell}
            iconColor={desktopNotifications ? 'text-accent-blue' : 'text-text-muted'}
            label="Desktop notifications"
            description="Get notified when responses complete"
          >
            <Toggle enabled={desktopNotifications} onChange={setDesktopNotifications} label="Toggle desktop notifications" />
          </SettingRow>
        </div>
      </div>
    </div>
  )
}
