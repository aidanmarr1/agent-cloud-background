'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Sparkles, Zap } from '@/components/icons'
import { getTaskUsageSummaries, getTotalCredits, useCreditStore } from '@/store/credits'
import { useChatStore } from '@/store/chat'
import { useUIStore } from '@/store/ui'

function formatCredits(value: number): string {
  const rounded = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  return rounded.toLocaleString()
}

function formatCompact(value: number): string {
  const rounded = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  if (rounded >= 1000) {
    const compact = new Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: rounded >= 10_000 ? 0 : 1,
    }).format(rounded)
    return compact
  }
  return String(rounded)
}

export function CreditPill() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const balance = useCreditStore((s) => s.balance)
  const ledger = useCreditStore((s) => s.ledger)
  const activeSession = useCreditStore((s) => s.activeSession)
  const refreshAllowances = useCreditStore((s) => s.refreshAllowances)
  const syncFromServer = useCreditStore((s) => s.syncFromServer)
  const conversations = useChatStore((s) => s.conversations)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const total = getTotalCredits(balance)
  const taskUsage = getTaskUsageSummaries(ledger, activeSession).slice(0, 4)

  const taskTitles = useMemo(() => {
    const titles = new Map<string, string>()
    for (const conversation of conversations) {
      titles.set(conversation.id, conversation.title || 'Task')
    }
    return titles
  }, [conversations])

  useEffect(() => {
    refreshAllowances()
    const timeout = window.setTimeout(() => {
      void syncFromServer({ force: true })
    }, 1_000)
    return () => window.clearTimeout(timeout)
  }, [refreshAllowances, syncFromServer])

  useEffect(() => {
    if (open) void syncFromServer({ force: true })
  }, [open, syncFromServer])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const openUsageSettings = () => {
    setOpen(false)
    setSettingsTab('usage')
    setSettingsOpen(true)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Credit balance: ${formatCredits(total)} credits`}
        className={`h-9 rounded-full border border-border-primary bg-bg-primary px-2.5 text-text-secondary transition-all duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 active:scale-[0.97] ${
          activeSession ? 'text-text-primary' : ''
        }`}
      >
        <span className="flex items-center gap-2">
          <span className="relative flex h-5 w-5 items-center justify-center">
            <Sparkles size={11} className="text-accent-blue" strokeWidth={2.2} />
            {activeSession && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-text-secondary shadow-[0_0_0_2px_var(--bg-secondary)]" />
            )}
          </span>
          <span className="hidden text-[12.5px] font-semibold tabular-nums sm:inline">
            {formatCredits(total)}
          </span>
          <span className="text-[12.5px] font-semibold tabular-nums sm:hidden">
            {formatCompact(total)}
          </span>
          <span className="hidden text-[12px] font-medium text-text-tertiary sm:inline">credits</span>
          <ChevronDown
            size={12}
            strokeWidth={2.25}
            className={`text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-[100] mt-2 w-[316px] overflow-hidden rounded-2xl border border-border-primary menu-surface animate-scale-in"
          style={{ boxShadow: 'var(--shadow-xl)' }}
        >
          <div className="border-b border-border-primary px-4 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">Credits</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-[28px] font-semibold tabular-nums text-text-primary tracking-[0]">
                    {formatCredits(total)}
                  </span>
                  <span className="text-[12px] font-medium text-text-tertiary">available</span>
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-border-primary bg-bg-secondary px-3 py-2 text-[11.5px] leading-relaxed text-text-tertiary">
              <Zap size={13} className="flex-shrink-0 text-accent-blue" strokeWidth={2.2} />
              One monthly credit balance. Task totals update as the agent works.
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">Recent usage</div>
            {taskUsage.length > 0 ? (
              <div className="space-y-1">
                {taskUsage.map((task) => (
                  <div key={task.conversationId} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium text-text-secondary">
                        {task.running ? 'Current task' : taskTitles.get(task.conversationId) || 'Task'}
                      </div>
                      <div className="text-[10.5px] text-text-muted">
                        {task.adjusted ? 'Adjusted' : new Date(task.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className={`text-[12px] font-semibold tabular-nums ${task.amount <= 0 ? 'text-text-secondary' : 'text-text-primary'}`}>
                      {task.amount <= 0 ? '' : '-'}{Math.abs(Number.isFinite(task.amount) ? task.amount : 0).toFixed(1)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border-primary bg-bg-secondary px-3 py-3 text-[12px] text-text-tertiary">
                Usage appears here as the agent works.
              </div>
            )}
            <button
              type="button"
              onClick={openUsageSettings}
              className="mt-2 flex h-9 w-full items-center justify-center rounded-lg border border-border-primary bg-bg-secondary text-[12px] font-semibold text-text-secondary transition-colors duration-150 hover:border-border-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
            >
              Open Usage
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
