'use client'

import { Maximize2, X } from '@/components/icons'
import { useUIStore } from '@/store/ui'

export function PanelHeader() {
  const setComputerPanelOpen = useUIStore((s) => s.setComputerPanelOpen)
  const toggleComputerPanelFullWidth = useUIStore((s) => s.toggleComputerPanelFullWidth)
  const computerPanelFullWidth = useUIStore((s) => s.computerPanelFullWidth)
  const isStreaming = useUIStore((s) => s.isStreaming)
  const streamingStatus = useUIStore((s) => s.streamingStatus)

  const statusLabels: Record<string, string> = {
    startup: 'Initializing computer',
    searching: 'Searching',
    browsing: 'Browsing',
    coding: 'Writing code',
    writing: 'Writing',
    analyzing: 'Analyzing',
    running: 'Running code',
    thinking: 'Thinking',
    stopping: 'Stopping',
  }

  const isLive = Boolean(isStreaming && streamingStatus)
  const headerText = isLive && streamingStatus
      ? statusLabels[streamingStatus] || "Agent's Computer"
      : "Agent's Computer"

  return (
    <div className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border-secondary px-4 sm:px-5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-text-primary">
          {headerText}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleComputerPanelFullWidth}
          className="w-8 h-8 rounded-md items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150 hidden md:flex"
          title={computerPanelFullWidth ? 'Reduce width' : 'Expand width'}
        >
          <Maximize2 size={13} strokeWidth={2.25} />
        </button>
        <button
          onClick={() => setComputerPanelOpen(false, { source: 'user' })}
          className="w-8 h-8 rounded-md flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-all duration-150"
          title="Close panel"
        >
          <X size={14} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  )
}
