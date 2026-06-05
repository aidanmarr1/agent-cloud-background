'use client'

import { useSettingsStore } from '@/store/settings'
import { Activity, EyeOff, Monitor, Moon, Sun } from '@/components/icons'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { SettingRow } from '@/components/ui/SettingRow'
import { Toggle } from '@/components/ui/Toggle'

export function AppearanceTab() {
  const {
    theme, setTheme,
    reduceMotion, setReduceMotion,
    reduceTransparency, setReduceTransparency,
  } = useSettingsStore()

  return (
    <div className="space-y-8">
      <div>
        <SectionLabel>Theme</SectionLabel>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            { id: 'light' as const, label: 'Light', icon: Sun },
            { id: 'dark' as const, label: 'Dark', icon: Moon },
            { id: 'system' as const, label: 'Auto', icon: Monitor },
          ].map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              onClick={() => setTheme(id)}
              data-no-focus-ring
              className={`flex h-24 flex-col items-center justify-center gap-2 rounded-xl border text-[13px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-tertiary ${
                theme === id
                  ? 'border-text-tertiary bg-bg-primary text-text-primary'
                  : 'border-border-primary bg-bg-card text-text-secondary hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
              aria-pressed={theme === id}
            >
              <Icon size={20} className={theme === id ? 'text-text-primary' : 'text-text-muted'} strokeWidth={2.25} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border-secondary pt-7">
        <SectionLabel>Display</SectionLabel>
        <div className="mt-4 divide-y divide-border-secondary border-y border-border-secondary">
          <SettingRow
            icon={Activity}
            iconColor={reduceMotion ? 'text-accent-blue' : 'text-text-muted'}
            label="Reduce motion"
            description="Minimize entrance animations, hover movement, and looping effects"
          >
            <Toggle enabled={reduceMotion} onChange={setReduceMotion} label="Toggle reduced motion" />
          </SettingRow>
          <SettingRow
            icon={EyeOff}
            iconColor={reduceTransparency ? 'text-accent-blue' : 'text-text-muted'}
            label="Reduce transparency"
            description="Remove blur effects behind modals, menus, and elevated surfaces"
          >
            <Toggle enabled={reduceTransparency} onChange={setReduceTransparency} label="Toggle reduced transparency" />
          </SettingRow>
        </div>
      </div>
    </div>
  )
}
