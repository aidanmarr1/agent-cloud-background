'use client'

import { Sparkles } from '@/components/icons'

export function LaunchCard() {
  return (
    <div className="mx-auto mt-6 w-full max-w-[810px] px-3">
      <aside
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border-primary bg-bg-secondary px-3 py-2.5 sm:px-3.5"
        aria-label="The launch of Agent 1.0 uses Agent Credits"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-primary bg-bg-primary text-text-muted">
          <Sparkles size={14} strokeWidth={2.1} aria-hidden />
        </span>

        <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-2">
          <span className="block text-[12.5px] font-semibold leading-tight text-text-primary">
            Agent 1.0 is here
          </span>
          <span className="hidden text-text-muted sm:inline" aria-hidden>·</span>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-text-tertiary sm:mt-0">
            Agent Credits power your first tasks.
          </span>
        </div>

        <span className="hidden shrink-0 rounded-md border border-border-primary bg-bg-primary px-2 py-1 text-[9.5px] font-medium uppercase tracking-[0.08em] text-text-muted sm:inline-flex">
          Launch update
        </span>
      </aside>
    </div>
  )
}
