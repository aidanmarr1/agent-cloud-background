'use client'

import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronDown } from '@/components/icons'

export function ModelSelector() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`-ml-1 flex h-9 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150 hover:bg-bg-secondary focus-visible:ring-2 focus-visible:ring-border-tertiary focus-visible:ring-offset-1 focus-visible:ring-offset-bg-primary sm:px-2.5 ${open ? 'bg-bg-secondary' : ''}`}
        data-no-focus-ring=""
        aria-label="Choose agent mode"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-border-primary bg-bg-card min-[390px]:hidden">
          <Bot size={14} className="text-text-primary" strokeWidth={2.2} aria-hidden="true" />
        </span>
        <span className="hidden text-[14px] font-semibold tracking-[-0.01em] text-text-primary min-[390px]:inline sm:text-[15px]">
          Agent 1.0
        </span>
        <ChevronDown
          size={12}
          className={`hidden text-text-muted transition-transform duration-150 min-[390px]:block ${open ? 'rotate-180' : ''}`}
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Agent mode"
          className="absolute left-0 top-[calc(100%+6px)] z-[120] w-[268px] rounded-2xl border border-border-primary bg-bg-card p-1.5 shadow-[var(--shadow-menu)] animate-fade-in"
        >
          <button
            type="button"
            role="option"
            aria-selected="true"
            onClick={() => setOpen(false)}
            className="flex min-h-[62px] w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-text-primary">
                Agent 1.0
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-[1.4] text-text-muted">
                For research, websites, files, and everyday tasks.
              </span>
            </span>
            <Check size={14} className="mt-0.5 flex-shrink-0 text-text-secondary" strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}
