'use client'

import { useState, useRef } from 'react'
import { Bot, Check, ChevronDown } from '@/components/icons'
import { useUIStore } from '@/store/ui'
import { useClickOutside } from '@/lib/useClickOutside'

export function ModelSelector() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isStreaming = useUIStore((s) => s.isStreaming)

  useClickOutside(ref, () => setOpen(false))

  return (
    <div className="relative z-[90]" ref={ref}>
      <button
        onClick={() => !isStreaming && setOpen(!open)}
        disabled={isStreaming}
        aria-label="Open agent menu"
        aria-expanded={open}
        className={`h-9 flex items-center gap-1.5 px-2 -ml-1 rounded-xl border transition-all duration-200 sm:gap-2 sm:px-3 ${
          open ? 'border-border-primary bg-bg-secondary' : 'border-transparent bg-transparent'
        } ${isStreaming ? 'opacity-50 cursor-not-allowed' : 'hover:border-border-primary hover:bg-bg-secondary'}`}
      >
        <Bot size={15} className="text-text-primary min-[390px]:hidden" strokeWidth={2.2} />
        <span className="hidden text-[14px] font-bold text-text-primary tracking-[0] min-[390px]:inline">
          Agent 1.0
        </span>
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className="fixed left-3 right-3 top-12 z-[100] mt-2 w-auto overflow-hidden rounded-2xl border border-border-primary menu-surface p-1.5 animate-scale-in sm:absolute sm:left-0 sm:right-auto sm:top-full sm:w-[252px]"
          style={{ boxShadow: 'var(--shadow-xl)' }}
        >
          <div className="w-full rounded-xl bg-bg-secondary px-2.5 py-2.5 flex items-start gap-3 text-left">
            <div className="flex h-5 w-5 items-center justify-center flex-shrink-0">
              <Bot size={15} className="text-accent-blue" strokeWidth={2.2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13.5px] font-semibold tracking-[0] text-text-primary">
                  Agent 1.0
                </span>
              </div>
              <div className="text-[11.5px] text-text-muted mt-0.5 leading-snug">
                Tasks, research, files, and builds
              </div>
            </div>
            <Check size={14} className="text-accent-blue mt-2 flex-shrink-0" strokeWidth={2.5} />
          </div>
        </div>
      )}
    </div>
  )
}
