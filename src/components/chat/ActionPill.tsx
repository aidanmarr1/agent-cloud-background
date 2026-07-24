'use client'

import { Search, Compass, Loader2 } from '@/components/icons'
import { StepAction } from '@/types'
import { useUIStore } from '@/store/ui'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'

interface ActionPillProps {
  action: StepAction
}

export function ActionPill({ action }: ActionPillProps) {
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const hasResult = !!action.result
  const label = action.label ? formatVisibleActionLabel(action.label) : ''

  // Legacy task actions predate the model-authored label contract. Do not
  // synthesize visible wording from a query, URL, result title, or generic
  // fallback: only render wording that the original model actually supplied.
  if (!label) return null

  return (
    <button
      onClick={() => {
        if (hasResult) setComputerPanelOpen(true, { source: 'user' })
      }}
      className={`group/action flex min-h-7 w-fit max-w-full items-center gap-1 py-1 text-left transition-colors duration-150 ${
        hasResult
          ? 'cursor-pointer'
          : 'cursor-default'
      }`}
    >
      <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border border-border-tertiary bg-bg-secondary text-text-muted ${action.type === 'browse' ? 'rounded-full' : 'rounded-[5px]'}`}>
        {action.type === 'search' ? (
          <Search size={11} className="text-text-tertiary" strokeWidth={2.25} />
        ) : (
          <Compass size={12} className="text-text-tertiary" weight="bold" />
        )}
      </div>
      <span className="max-w-[420px] truncate text-[14px] leading-5 text-text-secondary transition-colors duration-150 group-hover/action:text-text-primary">
        {label}
      </span>
      {!hasResult && (
        <Loader2 size={11} className="text-text-muted flex-shrink-0" style={{ animation: 'spin 1.5s linear infinite' }} />
      )}
    </button>
  )
}
