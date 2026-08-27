'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, ChevronRight, Sparkles, Zap } from '@/components/icons'
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
    void syncFromServer()
  }, [refreshAllowances, syncFromServer])

  useEffect(() => {
    if (open) void syncFromServer()
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
        aria-haspopup="dialog"
        aria-controls="agent-credits-popover"
        aria-label={`Credit balance: ${formatCredits(total)} credits`}
        className={`h-9 rounded-lg border border-border-primary bg-bg-primary px-2.5 text-text-secondary transition-all duration-150 hover:border-border-tertiary hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35 active:scale-[0.97] ${
          activeSession ? 'text-text-primary' : ''
        }`}
      >
        <span className="flex items-center gap-2">
          <span className="relative flex h-5 w-5 items-center justify-center">
            <Sparkles size={13} className="text-text-secondary" strokeWidth={2.2} />
            {activeSession && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-text-secondary shadow-[0_0_0_2px_var(--bg-secondary)]" />
            )}
          </span>
          <span className="hidden text-[13px] font-semibold tabular-nums sm:inline">
            {formatCredits(total)}
          </span>
          <span className="text-[12.5px] font-semibold tabular-nums sm:hidden">
            {formatCompact(total)}
          </span>
        </span>
      </button>

      {open && (
        <div
          id="agent-credits-popover"
          role="dialog"
          aria-label="Agent credit details"
          className="fixed left-3 right-3 top-12 z-[100] mt-2 w-auto overflow-hidden rounded-2xl border border-border-primary menu-surface animate-scale-in sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-[316px]"
        >
          <div className="border-b border-border-primary px-4 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11.5px] font-semibold text-text-tertiary">Available credits</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[30px] font-semibold leading-none tabular-nums text-text-primary tracking-[0]">
                    {formatCredits(total)}
                  </span>
                  <span className="text-[11.5px] font-medium text-text-muted">Agent Credits</span>
                </div>
              </div>
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-bg-secondary text-accent-blue">
                <Zap size={15} strokeWidth={2.2} />
              </span>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-text-tertiary">
              Admins add credits. Tasks spend them as the agent works.
            </p>
          </div>

          <div className="px-2 py-2.5">
            <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-muted">Recent usage</div>
              {taskUsage.length > 0 && (
                <div className="text-[10.5px] font-medium text-text-muted">Latest {taskUsage.length}</div>
              )}
            </div>
            {taskUsage.length > 0 ? (
              <div>
                {taskUsage.map((task, index) => (
                  <div
                    key={task.conversationId}
                    className={`flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-bg-hover ${
                      index > 0 ? 'border-t border-border-secondary' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-text-secondary">
                        {task.running ? 'Current task' : taskTitles.get(task.conversationId) || 'Task'}
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-text-muted">
                        {task.running
                          ? 'In progress'
                          : task.adjusted
                            ? 'Adjusted'
                            : new Date(task.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-baseline gap-1.5 text-right">
                      <span className={`text-[12.5px] font-semibold tabular-nums ${task.amount <= 0 ? 'text-text-secondary' : 'text-text-primary'}`}>
                        {task.amount <= 0 ? '' : '−'}{Math.abs(Number.isFinite(task.amount) ? task.amount : 0).toFixed(1)}
                      </span>
                      <span className="text-[10px] font-medium text-text-muted">credits</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-2 py-4 text-[12px] text-text-tertiary">
                Usage appears here as the agent works.
              </div>
            )}
          </div>

          <div className="border-t border-border-primary p-1.5">
            <button
              type="button"
              onClick={openUsageSettings}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] font-semibold text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/35"
            >
              <BarChart3 size={14} className="text-text-muted" strokeWidth={2.2} />
              Open Usage
              <ChevronRight size={12} className="ml-auto text-text-muted" strokeWidth={2.2} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
