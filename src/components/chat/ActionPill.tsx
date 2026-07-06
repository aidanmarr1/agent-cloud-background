'use client'

import { Search, Globe, Loader2 } from '@/components/icons'
import { StepAction, BrowseResult } from '@/types'
import { useUIStore } from '@/store/ui'
import { formatVisibleActionLabel } from '@/lib/stream/ActivityDescriber'

interface ActionPillProps {
  action: StepAction
}

function getFaviconUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`
  } catch {
    return null
  }
}

export function ActionPill({ action }: ActionPillProps) {
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const hasResult = !!action.result

  const favicon = action.type === 'browse' && action.url ? getFaviconUrl(action.url) : null

  const getLabel = () => {
    if (action.type === 'search') {
      return formatVisibleActionLabel(action.query || 'Searching…')
    }
    const browseResult = action.result as BrowseResult | undefined
    if (browseResult?.title && browseResult.title !== 'Error loading page') {
      return formatVisibleActionLabel(browseResult.title)
    }
    if (action.url) {
      try {
        const u = new URL(action.url)
        return formatVisibleActionLabel(u.hostname.replace('www.', ''))
      } catch {
        return formatVisibleActionLabel(action.url)
      }
    }
    return formatVisibleActionLabel('Browsing…')
  }

  return (
    <button
      onClick={() => {
        if (hasResult) setComputerPanelOpen(true, { source: 'user' })
      }}
      className={`flex items-center gap-2 rounded-xl pl-2 pr-2.5 h-9 text-left transition-all duration-200 w-fit border ${
        hasResult
          ? 'bg-bg-secondary hover:bg-bg-secondary border-border-primary hover:border-border-tertiary cursor-pointer'
          : 'bg-bg-secondary border-border-secondary'
      }`}
    >
      <div className="w-6 h-6 rounded-md bg-bg-primary border border-border-primary flex items-center justify-center flex-shrink-0 overflow-hidden">
        {favicon ? (
          <img
            src={favicon}
            alt=""
            width={14}
            height={14}
            className="rounded-sm"
            onError={(e) => {
              const img = e.target as HTMLImageElement
              img.style.display = 'none'
            }}
          />
        ) : action.type === 'search' ? (
          <Search size={11} className="text-text-tertiary" strokeWidth={2.25} />
        ) : (
          <Globe size={11} className="text-text-tertiary" strokeWidth={2.25} />
        )}
      </div>
      <span className="chat-action-pill text-text-secondary truncate max-w-[260px] font-medium">
        {getLabel()}
      </span>
      {!hasResult && (
        <Loader2 size={11} className="text-text-muted flex-shrink-0" style={{ animation: 'spin 1.5s linear infinite' }} />
      )}
    </button>
  )
}
