'use client'

import { useEffect, useState } from 'react'
import { useUIStore } from '@/store/ui'
import type { StreamingStatus } from '@/types'

const statusLabels: Record<Exclude<StreamingStatus, null>, string> = {
  startup: 'Initializing computer',
  thinking: 'Thinking',
  searching: 'Searching',
  browsing: 'Browsing',
  coding: 'Building',
  writing: 'Thinking',
  running: 'Running',
  analyzing: 'Analyzing',
  stopping: 'Stopping',
}

function statusLabel(status: Exclude<StreamingStatus, null>, elapsedMs: number): string {
  if (status === 'startup') {
    return elapsedMs < 750 ? 'Initializing computer' : 'Creating plan'
  }
  return statusLabels[status] || 'Thinking'
}

export function TypingIndicator() {
  const streamingStatus = useUIStore((s) => s.streamingStatus)
  const status = streamingStatus ?? 'thinking'
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    setElapsedMs(0)
    const startedAt = Date.now()
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)
    return () => window.clearInterval(id)
  }, [status])

  const label = statusLabel(status, elapsedMs)

  return (
    <div
      className="w-full animate-fade-in py-1.5"
      role="status"
      aria-live="polite"
    >
      <div className="task-activity-row inline-flex max-w-full items-center gap-1 py-1.5 text-text-secondary transition-all duration-300 ease-[var(--ease-out-expo)]">
        <span className="task-activity-marker relative flex h-5 w-5 flex-shrink-0 items-center justify-start">
          <span className="h-2 w-2 rounded-full bg-status-live" style={{ animation: 'pulse-dot 1.8s ease-in-out infinite' }} />
        </span>
        <span className="inline-grid min-w-[9.5rem] overflow-hidden align-middle">
          <span
            key={label}
            className="col-start-1 row-start-1 truncate chat-task-body text-[15px] font-medium tracking-[0] text-text-secondary animate-fade-in"
          >
            {label}
          </span>
        </span>
      </div>
    </div>
  )
}
