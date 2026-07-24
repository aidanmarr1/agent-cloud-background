'use client'

import { useSettingsStore } from '@/store/settings'
import { Activity, Check, EyeOff, Monitor, Moon, Sun } from '@/components/icons'
import { SettingRow } from '@/components/ui/SettingRow'
import { Toggle } from '@/components/ui/Toggle'
import { SettingsSection, settingsPanelClass } from './SettingsSection'

const themeOptions = [
  { id: 'light' as const, label: 'Light', description: 'Always light', icon: Sun },
  { id: 'dark' as const, label: 'Dark', description: 'Always dark', icon: Moon },
  { id: 'system' as const, label: 'Auto', description: 'Match your device', icon: Monitor },
]

export function AppearanceTab() {
  const {
    theme, setTheme,
    reduceMotion, setReduceMotion,
    reduceTransparency, setReduceTransparency,
  } = useSettingsStore()

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Theme"
        description="Choose how Agent looks on this device."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {themeOptions.map(({ id, label, description, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => setTheme(id)}
              className={`relative flex min-h-[86px] flex-col items-center justify-center gap-2 rounded-xl border px-3.5 py-3 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/30 ${
                theme === id
                  ? 'border-text-secondary bg-bg-secondary text-text-primary'
                  : 'border-border-primary bg-transparent text-text-secondary hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
              aria-pressed={theme === id}
            >
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center">
                <Icon size={19} className={theme === id ? 'text-text-primary' : 'text-text-muted'} strokeWidth={2.25} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold">{label}</span>
                <span className="sr-only">{description}</span>
              </span>
              {theme === id && (
                <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-text-primary text-primary-foreground">
                  <Check size={10} strokeWidth={2.8} />
                </span>
              )}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Visual accessibility"
        description="Reduce visual effects that can make the interface harder to follow."
      >
        <div className={`${settingsPanelClass} divide-y divide-border-secondary`}>
          <SettingRow
            icon={Activity}
            iconColor={reduceMotion ? 'text-accent-blue' : 'text-text-muted'}
            label="Reduce motion"
            description="Minimize entrance animations, hover movement, and looping effects"
          >
            <Toggle enabled={reduceMotion} onChange={setReduceMotion} label="Reduce motion" />
          </SettingRow>
          <SettingRow
            icon={EyeOff}
            iconColor={reduceTransparency ? 'text-accent-blue' : 'text-text-muted'}
            label="Reduce transparency"
            description="Remove blur effects behind modals, menus, and elevated surfaces"
          >
            <Toggle enabled={reduceTransparency} onChange={setReduceTransparency} label="Reduce transparency" />
          </SettingRow>
        </div>
      </SettingsSection>
    </div>
  )
}
