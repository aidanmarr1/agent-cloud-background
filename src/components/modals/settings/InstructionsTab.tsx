'use client'

import { useSettingsStore } from '@/store/settings'
import { Eraser } from '@/components/icons'
import { SettingsSection } from './SettingsSection'

export function InstructionsTab() {
  const { globalInstructions, setGlobalInstructions } = useSettingsStore()

  return (
    <SettingsSection
      title="Global instructions"
      description="Set persistent guidance that Agent should follow in every task."
      action={globalInstructions.length > 0 ? (
        <button
          type="button"
          onClick={() => setGlobalInstructions('')}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border-primary bg-bg-secondary px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
          aria-label="Clear global instructions"
        >
          <Eraser size={12} strokeWidth={2.25} />
          Clear
        </button>
      ) : undefined}
    >
      <div>
        <label htmlFor="global-instructions" className="sr-only">Global instructions</label>
        <textarea
          id="global-instructions"
          value={globalInstructions}
          onChange={(e) => setGlobalInstructions(e.target.value)}
          className="h-64 w-full resize-none rounded-xl border border-border-primary bg-bg-card px-4 py-3.5 text-[13px] leading-relaxed text-text-primary outline-none transition-colors duration-150 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-tertiary focus:ring-2 focus:ring-accent-blue/15 sm:h-72"
          placeholder="For example: Keep responses concise, ask before making destructive changes, and explain technical decisions in plain language."
          aria-describedby="global-instructions-count"
        />
        <div className="mt-2 flex items-center justify-between gap-4 text-[11px] text-text-muted">
          <span>Saved automatically</span>
          <span id="global-instructions-count" className="tabular-nums">{globalInstructions.length.toLocaleString()} characters</span>
        </div>
      </div>
    </SettingsSection>
  )
}
