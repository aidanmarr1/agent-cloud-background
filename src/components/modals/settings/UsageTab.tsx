'use client'

import { useEffect, useMemo } from 'react'
import { BarChart3, Clock, Sparkles } from '@/components/icons'
import { SectionLabel } from '@/components/ui/SectionLabel'
import {
  getTaskUsageSummaries,
  getTotalCredits,
  type CreditLedgerEntry,
  type CreditTaskSpendSummary,
  useCreditStore,
} from '@/store/credits'
import { useChatStore } from '@/store/chat'

type DisplayTaskSpend = CreditTaskSpendSummary & {
  running: boolean
}

type CreditActivityRow =
  | {
      kind: 'task'
      id: string
      title: string
      amount: number
      entryCount: number
      timestamp: number
      startedAt: number
      running: boolean
    }
  | {
      kind: 'credit'
      id: string
      title: string
      amount: number
      timestamp: number
      reason: string
      sourceLabel: string
    }

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function formatCredits(value: number): string {
  return Math.max(0, Math.floor(finiteNumber(value))).toLocaleString()
}

function formatSpend(value: number): string {
  const safeValue = Math.max(0, finiteNumber(value))
  if (safeValue >= 100) return Math.round(safeValue).toLocaleString()
  return safeValue.toFixed(1)
}

function formatDateTime(timestamp: number): string {
  const safeTimestamp = finiteNumber(timestamp, Date.now())
  return new Date(safeTimestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function activityPeriodLabel(periodKey: string): string {
  const base = new Date(`${periodKey}-01T00:00:00.000Z`)
  if (Number.isNaN(base.getTime())) return 'Recent activity'
  return `Since ${base.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function creditSourceTitle(_entry: CreditLedgerEntry): string {
  return 'Agent Admin credited account'
}

function creditSourceLabel(_entry: CreditLedgerEntry): string {
  return 'Agent Admin'
}

export function UsageTab() {
  const balance = useCreditStore((s) => s.balance)
  const ledger = useCreditStore((s) => s.ledger)
  const usageSummary = useCreditStore((s) => s.usageSummary)
  const activeSession = useCreditStore((s) => s.activeSession)
  const lastCreditPeriod = useCreditStore((s) => s.lastMonthlyRefresh)
  const syncFromServer = useCreditStore((s) => s.syncFromServer)
  const conversations = useChatStore((s) => s.conversations)

  useEffect(() => {
    void syncFromServer()
  }, [syncFromServer])

  const taskTitles = useMemo(() => {
    const titles = new Map<string, string>()
    for (const conversation of conversations) {
      titles.set(conversation.id, conversation.title || 'Task')
    }
    return titles
  }, [conversations])

  const creditPeriodStart = new Date(`${lastCreditPeriod}-01T00:00:00.000Z`).getTime()
  const periodLedger = Number.isNaN(creditPeriodStart)
    ? ledger
    : ledger.filter((entry) => entry.timestamp >= creditPeriodStart)
  const fallbackRecentSpent = periodLedger.reduce((sum, entry) => (
    entry.amount > 0 ? sum + entry.amount : sum
  ), 0)
  const fallbackLifetimeSpent = ledger.reduce((sum, entry) => (
    entry.amount > 0 ? sum + entry.amount : sum
  ), 0)

  const taskRows = useMemo<DisplayTaskSpend[]>(() => {
    const baseTasks: DisplayTaskSpend[] = usageSummary
      ? usageSummary.tasks.map((task) => ({
          ...task,
          running: activeSession?.conversationId === task.conversationId,
        }))
      : getTaskUsageSummaries(ledger, activeSession)
          .filter((task) => task.amount > 0)
          .map((task) => ({
            conversationId: task.conversationId,
            amount: task.amount,
            entryCount: task.entryCount,
            startedAt: task.startedAt,
            updatedAt: task.updatedAt,
            running: task.running,
          }))

    if (activeSession && !baseTasks.some((task) => task.conversationId === activeSession.conversationId)) {
      baseTasks.push({
        conversationId: activeSession.conversationId,
        amount: Math.max(0, finiteNumber(activeSession.spent)),
        entryCount: 0,
        startedAt: activeSession.startedAt,
        updatedAt: activeSession.lastHeartbeatAt,
        running: true,
      })
    }

    return baseTasks
      .filter((task) => task.running || task.amount > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [activeSession, ledger, usageSummary])

  const activityRows = useMemo<CreditActivityRow[]>(() => {
    const creditRows: CreditActivityRow[] = ledger
      .filter((entry) => entry.amount < 0)
      .map((entry) => ({
        kind: 'credit' as const,
        id: entry.id,
        title: creditSourceTitle(entry),
        amount: Math.abs(entry.amount),
        timestamp: entry.timestamp,
        reason: entry.reason || 'Credits added',
        sourceLabel: creditSourceLabel(entry),
      }))

    const spendRows: CreditActivityRow[] = taskRows.map((task) => ({
      kind: 'task' as const,
      id: task.conversationId,
      title: task.running ? 'Current task' : taskTitles.get(task.conversationId) || 'Task',
      amount: task.amount,
      entryCount: task.entryCount,
      timestamp: task.updatedAt,
      startedAt: task.startedAt,
      running: task.running,
    }))

    return [...creditRows, ...spendRows].sort((a, b) => b.timestamp - a.timestamp)
  }, [ledger, taskRows, taskTitles])

  const recentSpent = usageSummary?.monthlySpent ?? fallbackRecentSpent
  const lifetimeSpent = usageSummary?.lifetimeSpent ?? fallbackLifetimeSpent
  const totalCredits = getTotalCredits(balance)
  const taskCount = usageSummary?.taskCount ?? taskRows.length

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Spend overview</SectionLabel>
        <div className="grid gap-3 md:grid-cols-[1.25fr_0.85fr]">
          <div className="rounded-2xl border border-border-primary bg-bg-secondary p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[12px] font-semibold text-text-tertiary">Recent spend</div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-[34px] font-semibold leading-none tracking-[0] text-text-primary tabular-nums">
                    {formatSpend(recentSpent)}
                  </span>
                  <span className="text-[12px] font-medium text-text-tertiary">credits</span>
                </div>
              </div>
              <Sparkles size={17} className="mt-0.5 text-text-secondary" strokeWidth={2.25} />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-[11.5px] text-text-tertiary">
              <span>{activityPeriodLabel(lastCreditPeriod)}</span>
              <span>Agent Credits</span>
            </div>
          </div>

          <div className="grid gap-3">
            <div className="rounded-2xl border border-border-primary bg-bg-secondary p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold text-text-tertiary">Overall spend</div>
                  <div className="mt-2 text-[24px] font-semibold leading-none tracking-[0] text-text-primary tabular-nums">
                    {formatSpend(lifetimeSpent)}
                  </div>
                  <div className="mt-1 text-[11.5px] text-text-tertiary">Since account creation</div>
                </div>
                <BarChart3 size={16} className="mt-0.5 text-text-secondary" strokeWidth={2.25} />
              </div>
            </div>

            <div className="rounded-2xl border border-border-primary bg-bg-secondary p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[12px] font-semibold text-text-tertiary">Credits available</div>
                  <div className="mt-2 text-[24px] font-semibold leading-none tracking-[0] text-text-primary tabular-nums">
                    {formatCredits(totalCredits)}
                  </div>
                  <div className="mt-1 text-[11.5px] text-text-tertiary">Current Agent Credits</div>
                </div>
                <Clock size={16} className="mt-0.5 text-text-secondary" strokeWidth={2.25} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <SectionLabel>Task spend</SectionLabel>
        <div className="overflow-hidden rounded-2xl border border-border-primary bg-bg-secondary">
          <div className="flex flex-col gap-3 border-b border-border-primary px-4 py-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-[14px] font-semibold tracking-[0] text-text-primary">Task spend and credit grants</div>
              <div className="mt-1 text-[12px] leading-relaxed text-text-tertiary">
                Agent Admin credits and task totals, ordered by latest activity.
              </div>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-[22px] font-semibold leading-none tracking-[0] text-text-primary tabular-nums">
                {formatSpend(lifetimeSpent)}
              </div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                total spent
              </div>
            </div>
          </div>

          {activityRows.length > 0 ? (
            <div className="divide-y divide-border-primary">
              {activityRows.map((row) => {
                if (row.kind === 'credit') {
                  return (
                    <div
                      key={row.id}
                      className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_148px] sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-[13px] font-semibold tracking-[0] text-text-primary">{row.title}</span>
                          <span className="rounded-full border border-border-primary px-2 py-0.5 text-[10.5px] font-semibold text-text-tertiary">
                            {row.sourceLabel}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-tertiary">
                          <span>{formatDateTime(row.timestamp)}</span>
                          <span className="text-text-muted">/</span>
                          <span>{row.reason}</span>
                          <span className="text-text-muted">/</span>
                          <span className="break-all font-mono text-[10.5px] text-text-muted">Ledger trace: {row.id}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:justify-end">
                        <span className="rounded-full border border-[var(--success-border)] bg-[var(--success-bg)] px-2.5 py-1 text-[13px] font-semibold tabular-nums text-[var(--success-text)]">
                          +{formatSpend(row.amount)}
                        </span>
                      </div>
                    </div>
                  )
                }

                const usageLabel = row.entryCount === 1 ? '1 usage entry' : `${row.entryCount.toLocaleString()} usage entries`

                return (
                  <div
                    key={row.id}
                    className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_148px] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold tracking-[0] text-text-primary">{row.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-tertiary">
                        <span>{row.running ? 'Running now' : formatDateTime(row.timestamp)}</span>
                        <span className="text-text-muted">/</span>
                        <span>{row.running && row.entryCount === 0 ? 'Live usage' : usageLabel}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      {row.running && (
                        <span className="rounded-full border border-border-primary px-2.5 py-1 text-[11px] font-semibold text-accent-active">
                          Live
                        </span>
                      )}
                      <span className="text-[14px] font-semibold tabular-nums text-text-primary">
                        {formatSpend(row.amount)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="px-4 py-8 text-center">
              <div className="mx-auto mb-3 h-px w-10 bg-border-tertiary" />
              <div className="text-[13px] font-semibold text-text-primary">No credit activity yet</div>
              <div className="mt-1 text-[12px] text-text-tertiary">
                Credit changes and task totals appear here after Agent starts working.
              </div>
            </div>
          )}
        </div>
        <div className="mt-2.5 flex flex-col gap-1 text-[11.5px] text-text-tertiary sm:flex-row sm:items-center sm:justify-between">
          <span>
            {activityRows.length.toLocaleString()} {activityRows.length === 1 ? 'ledger entry' : 'ledger entries'} across {taskCount.toLocaleString()} {taskCount === 1 ? 'task' : 'tasks'}
          </span>
          <span>Totals sync from the server credit ledger.</span>
        </div>
      </div>
    </div>
  )
}
