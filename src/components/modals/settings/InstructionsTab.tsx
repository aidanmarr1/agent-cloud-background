'use client'

import { useSettingsStore } from '@/store/settings'
import { Eraser } from '@/components/icons'
import { SectionLabel } from '@/components/ui/SectionLabel'

export function InstructionsTab() {
  const { globalInstructions, setGlobalInstructions } = useSettingsStore()

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Global Instructions</SectionLabel>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[12.5px] leading-relaxed text-text-tertiary">These instructions apply to all tasks.</p>
          {globalInstructions.length > 0 && (
            <button
              type="button"
              onClick={() => setGlobalInstructions('')}
              className="flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg border border-border-primary bg-bg-secondary px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
            >
              <Eraser size={12} strokeWidth={2.25} />
              Clear
            </button>
          )}
        </div>
        <textarea
          value={globalInstructions}
          onChange={(e) => setGlobalInstructions(e.target.value)}
          className="h-52 w-full resize-none rounded-2xl border border-border-primary bg-bg-secondary px-4 py-3.5 text-[13px] leading-relaxed text-text-primary outline-none transition-all duration-200 placeholder:text-text-muted hover:border-border-tertiary focus:border-border-tertiary"
          placeholder="Add custom instructions for all tasks…"
        />
        <div className="mt-2 text-right text-[11px] text-text-muted tabular-nums">{globalInstructions.length} characters</div>
      </div>
    </div>
  )
}
