'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  ACTIVE_CREDITS_PER_MINUTE,
  CREDIT_RATES,
  TASK_START_CREDITS,
  type CreditCategory,
  type CreditLedgerEvent,
  type CreditTokenUsage,
  finiteCreditNumber,
  roundCreditAmount,
  tokenUsageCreditCharge,
  toolCreditCharge,
} from '@/lib/creditPolicy'
import { dispatchAccountDeletedEvent } from '@/lib/accountDeletedEvent'

export type CreditBucket = 'monthly'
export type { CreditCategory, CreditLedgerEvent } from '@/lib/creditPolicy'
export type CreditSessionStatus = 'running' | 'done' | 'stopped' | 'error'

export interface CreditBalance {
  monthly: number
}

export interface CreditLedgerEntry {
  id: string
  timestamp: number
  amount: number
  category: CreditCategory
  reason: string
  conversationId?: string
  toolName?: string
  bucketDebits: Partial<Record<CreditBucket, number>>
  balanceAfter: number
}

export interface ActiveCreditSession {
  conversationId: string
  startedAt: number
  lastHeartbeatAt: number
  spent: number
  toolCount: number
  accountingMode: 'client' | 'server'
  status: 'running'
}

export interface TaskUsageSummary {
  conversationId: string
  startedAt: number
  updatedAt: number
  amount: number
  entryCount: number
  running: boolean
  adjusted: boolean
}

export interface CreditTaskSpendSummary {
  conversationId: string
  amount: number
  entryCount: number
  startedAt: number
  updatedAt: number
}

export interface CreditUsageSummary {
  monthlySpent: number
  lifetimeSpent: number
  taskCount: number
  tasks: CreditTaskSpendSummary[]
}

export interface CreditServerSnapshot {
  balance: CreditBalance
  ledger: CreditLedgerEvent[]
  usageSummary?: CreditUsageSummary
  monthlyAllowance: number
  lastMonthlyRefresh: string
}

interface CreditStore {
  balance: CreditBalance
  ledger: CreditLedgerEntry[]
  usageSummary: CreditUsageSummary | null
  activeSession: ActiveCreditSession | null
  lastMonthlyRefresh: string
  monthlyAllowance: number
  refreshAllowances: (now?: number) => void
  startTask: (conversationId: string, options?: { chargeStart?: boolean; accountingMode?: 'client' | 'server' }) => void
  heartbeat: (conversationId: string, now?: number) => void
  chargeTool: (conversationId: string, toolName: string) => void
  chargeTokens: (conversationId: string, usage: CreditTokenUsage | number) => void
  hydrateFromServer: (snapshot: CreditServerSnapshot) => void
  syncFromServer: (options?: { force?: boolean }) => Promise<void>
  applyServerCreditEvent: (entry: CreditLedgerEvent) => void
  finishTask: (conversationId: string, status: CreditSessionStatus) => void
  getTotalCredits: () => number
}

export function getTaskUsageSummaries(
  ledger: CreditLedgerEntry[],
  activeSession?: ActiveCreditSession | null,
): TaskUsageSummary[] {
  const summaries = new Map<string, TaskUsageSummary>()

  for (const entry of ledger) {
    const conversationId = entry.conversationId
    if (!conversationId) continue

    const existing = summaries.get(conversationId)
    const amount = roundCredits(entry.amount)
    const timestamp = finiteCreditNumber(entry.timestamp, Date.now())
    if (!existing) {
      summaries.set(conversationId, {
        conversationId,
        startedAt: timestamp,
        updatedAt: timestamp,
        amount,
        entryCount: 1,
        running: activeSession?.conversationId === conversationId,
        adjusted: entry.category === 'adjustment',
      })
    } else {
      existing.startedAt = Math.min(existing.startedAt, timestamp)
      existing.updatedAt = Math.max(existing.updatedAt, timestamp)
      existing.amount = roundCredits(existing.amount + amount)
      existing.entryCount += 1
      existing.running = existing.running || activeSession?.conversationId === conversationId
      existing.adjusted = existing.adjusted || entry.category === 'adjustment'
    }
  }

  if (activeSession && !summaries.has(activeSession.conversationId)) {
    summaries.set(activeSession.conversationId, {
      conversationId: activeSession.conversationId,
      startedAt: finiteCreditNumber(activeSession.startedAt, Date.now()),
      updatedAt: finiteCreditNumber(activeSession.lastHeartbeatAt, Date.now()),
      amount: roundCredits(finiteCreditNumber(activeSession.spent)),
      entryCount: 0,
      running: true,
      adjusted: false,
    })
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      ...summary,
      amount: roundCredits(summary.amount),
      running: activeSession?.conversationId === summary.conversationId || summary.running,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

const STORE_KEY = 'agent-credit-store'
const MONTHLY_ALLOWANCE = 1000
const MAX_HEARTBEAT_MS = 30_000
const MAX_LEDGER_ENTRIES = 200
const CREDIT_SYNC_MIN_INTERVAL_MS = 30_000
const CREDIT_SYNC_TIMEOUT_MS = 4_000

let creditSyncInFlight: Promise<void> | null = null
let lastCreditSyncAttemptAt = 0

function monthKey(time: number): string {
  return new Date(time).toISOString().slice(0, 7)
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function roundCredits(value: number): number {
  return roundCreditAmount(finiteCreditNumber(value))
}

function totalBalance(balance: CreditBalance): number {
  return roundCredits(finiteCreditNumber(balance.monthly))
}

function toolCharge(toolName: string): number {
  return toolCreditCharge(toolName)
}

function consumeFromBalance(balance: CreditBalance, amount: number) {
  const nextBalance: CreditBalance = {
    monthly: roundCredits(finiteCreditNumber(balance.monthly)),
  }
  const bucketDebits: Partial<Record<CreditBucket, number>> = {}
  let remaining = roundCredits(Math.max(0, amount))

  const available = Math.max(0, nextBalance.monthly)
  const debit = roundCredits(Math.min(available, remaining))
  if (debit > 0) {
    nextBalance.monthly = roundCredits(nextBalance.monthly - debit)
    bucketDebits.monthly = roundCredits((bucketDebits.monthly ?? 0) + debit)
    remaining = roundCredits(remaining - debit)
  }

  if (remaining > 0) {
    nextBalance.monthly = 0
  }

  return { nextBalance, bucketDebits }
}

function charge(
  state: Pick<CreditStore, 'balance' | 'ledger' | 'activeSession'>,
  amount: number,
  category: CreditCategory,
  reason: string,
  conversationId?: string,
  toolName?: string,
  eventId?: string,
  timestamp = Date.now(),
) {
  const normalizedAmount = roundCredits(amount)
  if (normalizedAmount <= 0) return state
  if (eventId && state.ledger.some((entry) => entry.id === eventId)) return state

  const { nextBalance, bucketDebits } = consumeFromBalance(state.balance, normalizedAmount)
  const activeSession = state.activeSession && state.activeSession.conversationId === conversationId
    ? {
        ...state.activeSession,
        spent: roundCredits(finiteCreditNumber(state.activeSession.spent) + normalizedAmount),
        toolCount: category === 'tool' ? state.activeSession.toolCount + 1 : state.activeSession.toolCount,
      }
    : state.activeSession

  const entry: CreditLedgerEntry = {
    id: eventId ?? createId('credit'),
    timestamp,
    amount: normalizedAmount,
    category,
    reason,
    conversationId,
    toolName,
    bucketDebits,
    balanceAfter: totalBalance(nextBalance),
  }

  return {
    balance: nextBalance,
    activeSession,
    ledger: [entry, ...state.ledger].slice(0, MAX_LEDGER_ENTRIES),
  }
}

function applyServerEntry(
  state: Pick<CreditStore, 'balance' | 'ledger' | 'activeSession'>,
  entry: CreditLedgerEvent,
) {
  const normalizedAmount = roundCredits(entry.amount)
  if (normalizedAmount === 0) return state
  if (state.ledger.some((item) => item.id === entry.id)) return state

  if (normalizedAmount < 0) {
    const adjustment = Math.abs(normalizedAmount)
    const nextBalance: CreditBalance = {
      ...state.balance,
      monthly: roundCredits(finiteCreditNumber(state.balance.monthly) + adjustment),
    }
    const session = state.activeSession
    const activeSession: ActiveCreditSession | null =
      session && session.conversationId === entry.conversationId
        ? {
            ...session,
            spent: Math.max(0, roundCredits(finiteCreditNumber(session.spent) - adjustment)),
          }
        : session
    const ledgerEntry: CreditLedgerEntry = {
      ...entry,
      amount: normalizedAmount,
      bucketDebits: { monthly: normalizedAmount },
      balanceAfter: totalBalance(nextBalance),
    }
    return {
      balance: nextBalance,
      activeSession,
      ledger: [ledgerEntry, ...state.ledger].slice(0, MAX_LEDGER_ENTRIES),
    }
  }

  return charge(
    state,
    normalizedAmount,
    entry.category,
    entry.reason,
    entry.conversationId,
    entry.toolName,
    entry.id,
    entry.timestamp,
  )
}

function serverLedgerEntry(entry: CreditLedgerEvent, balanceAfter: number): CreditLedgerEntry {
  const amount = roundCredits(entry.amount)
  return {
    id: entry.id,
    timestamp: finiteCreditNumber(entry.timestamp, Date.now()),
    amount,
    category: entry.category,
    reason: entry.reason,
    conversationId: entry.conversationId,
    toolName: entry.toolName,
    bucketDebits: { monthly: amount },
    balanceAfter,
  }
}

function normalizeServerUsageSummary(summary: CreditServerSnapshot['usageSummary'] | null): CreditUsageSummary | null {
  if (!summary) return null
  const tasks = Array.isArray(summary.tasks)
    ? summary.tasks
        .map((task) => {
          if (!task || typeof task.conversationId !== 'string' || !task.conversationId) return null
          const updatedAt = finiteCreditNumber(task.updatedAt, Date.now())
          return {
            conversationId: task.conversationId,
            amount: roundCredits(finiteCreditNumber(task.amount)),
            entryCount: Math.max(0, Math.floor(finiteCreditNumber(task.entryCount))),
            startedAt: finiteCreditNumber(task.startedAt, updatedAt),
            updatedAt,
          }
        })
        .filter((task): task is CreditTaskSpendSummary => !!task)
    : []

  return {
    monthlySpent: roundCredits(finiteCreditNumber(summary.monthlySpent)),
    lifetimeSpent: roundCredits(finiteCreditNumber(summary.lifetimeSpent)),
    taskCount: Math.max(tasks.length, Math.floor(finiteCreditNumber(summary.taskCount))),
    tasks,
  }
}

const now = Date.now()

export const CREDIT_POLICY = {
  monthlyAllowance: MONTHLY_ALLOWANCE,
  taskStartCredits: TASK_START_CREDITS,
  activeCreditsPerMinute: ACTIVE_CREDITS_PER_MINUTE,
  model: CREDIT_RATES.model,
  modelInputUsdPer1M: CREDIT_RATES.modelInputUsdPer1M,
  modelOutputUsdPer1M: CREDIT_RATES.modelOutputUsdPer1M,
  modelLongContextThresholdTokens: CREDIT_RATES.modelLongContextThresholdTokens,
  modelLongContextInputUsdPer1M: CREDIT_RATES.modelLongContextInputUsdPer1M,
  modelLongContextOutputUsdPer1M: CREDIT_RATES.modelLongContextOutputUsdPer1M,
  tokenCreditsPer1K: CREDIT_RATES.outputTokenCreditsPer1K,
  inputTokenCreditsPer1K: CREDIT_RATES.inputTokenCreditsPer1K,
  outputTokenCreditsPer1K: CREDIT_RATES.outputTokenCreditsPer1K,
  webSearchCredits: CREDIT_RATES.webSearchCredits,
  browserStepCredits: CREDIT_RATES.browserStepCredits,
  creditsPerUsd: CREDIT_RATES.creditsPerUsd,
}

export const useCreditStore = create<CreditStore>()(
  persist(
    (set, get) => ({
      balance: {
        monthly: MONTHLY_ALLOWANCE,
      },
      ledger: [],
      usageSummary: null,
      activeSession: null,
      lastMonthlyRefresh: monthKey(now),
      monthlyAllowance: MONTHLY_ALLOWANCE,

      refreshAllowances: (time = Date.now()) => set((state) => {
        const nextMonthly = monthKey(time)
        const nextBalance = {
          monthly: roundCredits(finiteCreditNumber(state.balance.monthly, MONTHLY_ALLOWANCE)),
        }
        const updates: Partial<CreditStore> = {}

        if (!state.lastMonthlyRefresh) {
          updates.lastMonthlyRefresh = nextMonthly
        }

        const balanceRepaired = nextBalance.monthly !== state.balance.monthly
        if (!updates.lastMonthlyRefresh && !balanceRepaired) return state
        return { ...updates, balance: nextBalance }
      }),

      startTask: (conversationId, options) => {
        get().refreshAllowances()
        set((state) => {
          const startedAt = Date.now()
          const accountingMode = options?.accountingMode ?? (options?.chargeStart === false ? 'server' : 'client')
          const baseState = state.activeSession?.conversationId === conversationId
            ? state
            : {
                ...state,
                activeSession: {
                  conversationId,
                  startedAt,
                  lastHeartbeatAt: startedAt,
                  spent: 0,
                  toolCount: 0,
                  accountingMode,
                  status: 'running' as const,
                },
              }

          if (options?.chargeStart === false) return baseState

          return charge(
            baseState,
            TASK_START_CREDITS,
            'task',
            'Task started',
            conversationId,
          )
        })
      },

      heartbeat: (conversationId, time = Date.now()) => set((state) => {
        const session = state.activeSession
        if (!session || session.conversationId !== conversationId) return state
        const elapsedMs = Math.max(0, Math.min(time - finiteCreditNumber(session.lastHeartbeatAt, time), MAX_HEARTBEAT_MS))
        if (elapsedMs <= 0) return state
        const amount = roundCredits((elapsedMs / 60_000) * ACTIVE_CREDITS_PER_MINUTE)
        const charged = charge(
          {
            ...state,
            activeSession: { ...session, lastHeartbeatAt: time },
          },
          amount,
          'time',
          'Active agent processing',
          conversationId,
        )
        return charged
      }),

      chargeTool: (conversationId, toolName) => set((state) => charge(
        state,
        toolCharge(toolName),
        'tool',
        toolName.replace(/_/g, ' '),
        conversationId,
        toolName,
      )),

      chargeTokens: (conversationId, usage) => set((state) => charge(
        state,
        tokenUsageCreditCharge(usage),
        'tokens',
        'Model token usage',
        conversationId,
      )),

      hydrateFromServer: (snapshot) => set((state) => {
        const balance: CreditBalance = {
          monthly: roundCredits(finiteCreditNumber(snapshot.balance?.monthly, MONTHLY_ALLOWANCE)),
        }
        const balanceAfter = totalBalance(balance)
        const ledger = (snapshot.ledger || [])
          .filter((entry) => Number.isFinite(finiteCreditNumber(entry.amount, Number.NaN)))
          .map((entry) => serverLedgerEntry(entry, balanceAfter))
          .slice(0, MAX_LEDGER_ENTRIES)

        return {
          balance,
          ledger,
          usageSummary: normalizeServerUsageSummary(snapshot.usageSummary),
          activeSession: state.activeSession,
          monthlyAllowance: roundCredits(finiteCreditNumber(snapshot.monthlyAllowance, MONTHLY_ALLOWANCE)) || MONTHLY_ALLOWANCE,
          lastMonthlyRefresh: snapshot.lastMonthlyRefresh || monthKey(now),
        }
      }),

      syncFromServer: async (options) => {
        if (creditSyncInFlight) return creditSyncInFlight

        const nowMs = Date.now()
        if (!options?.force && nowMs - lastCreditSyncAttemptAt < CREDIT_SYNC_MIN_INTERVAL_MS) return
        lastCreditSyncAttemptAt = nowMs

        creditSyncInFlight = (async () => {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), CREDIT_SYNC_TIMEOUT_MS)

          try {
            const response = await fetch('/api/credits', {
              cache: 'no-store',
              signal: controller.signal,
            })
            if (!response.ok) {
              if (response.status === 404 && typeof window !== 'undefined') {
                const body = await response.json().catch(() => null) as { accountDeleted?: unknown } | null
                if (body?.accountDeleted === true) {
                  dispatchAccountDeletedEvent()
                }
              }
              return
            }
            const snapshot = await response.json() as CreditServerSnapshot
            get().hydrateFromServer(snapshot)
          } catch {
            // The server ledger is authoritative; leave the current display cache in place if sync fails.
          } finally {
            clearTimeout(timeoutId)
            creditSyncInFlight = null
          }
        })()

        return creditSyncInFlight
      },

      applyServerCreditEvent: (entry) => set((state) => applyServerEntry(state, entry)),

      finishTask: (conversationId, _status) => {
        const session = get().activeSession
        if (session?.conversationId === conversationId && session.accountingMode === 'client') {
          get().heartbeat(conversationId)
        }
        set((state) => {
          if (state.activeSession?.conversationId !== conversationId) return state
          return { activeSession: null }
        })
      },

      getTotalCredits: () => totalBalance(get().balance),
    }),
    {
      name: STORE_KEY,
      version: 3,
      partialize: (state) => ({
        balance: state.balance,
        ledger: state.ledger,
        usageSummary: state.usageSummary,
        lastMonthlyRefresh: state.lastMonthlyRefresh,
        monthlyAllowance: state.monthlyAllowance,
      }),
      migrate: (persistedState): {
        balance: CreditBalance
        ledger: CreditLedgerEntry[]
        usageSummary: CreditUsageSummary | null
        lastMonthlyRefresh: string
        monthlyAllowance: number
      } => {
        const state = persistedState as Partial<CreditStore> & {
          balance?: Partial<CreditBalance> & {
            event?: number
            daily?: number
            addon?: number
            free?: number
          }
          lastDailyRefresh?: string
          dailyAllowance?: number
        }
        const monthlyBalance = roundCredits(finiteCreditNumber(
          state.balance?.monthly ??
          state.balance?.free ??
          state.balance?.daily ??
          MONTHLY_ALLOWANCE,
          MONTHLY_ALLOWANCE,
        ))
        const ledger = Array.isArray(state.ledger)
          ? state.ledger
              .map((entry) => {
                if (!entry || typeof entry.id !== 'string') return null
                const category = typeof entry.category === 'string' ? entry.category : ''
                if (!['task', 'time', 'tool', 'tokens', 'adjustment'].includes(category)) return null
                const normalized: CreditLedgerEntry = {
                  id: entry.id,
                  timestamp: finiteCreditNumber(entry.timestamp, Date.now()),
                  amount: roundCredits(finiteCreditNumber(entry.amount)),
                  category: category as CreditCategory,
                  reason: typeof entry.reason === 'string' ? entry.reason : 'Credit usage',
                  bucketDebits: entry.bucketDebits && typeof entry.bucketDebits === 'object' ? entry.bucketDebits : {},
                  balanceAfter: roundCredits(finiteCreditNumber(entry.balanceAfter, monthlyBalance)),
                }
                if (typeof entry.conversationId === 'string') normalized.conversationId = entry.conversationId
                if (typeof entry.toolName === 'string') normalized.toolName = entry.toolName
                return normalized
              })
              .filter((entry): entry is CreditLedgerEntry => !!entry)
              .slice(0, MAX_LEDGER_ENTRIES)
          : []

        return {
          balance: { monthly: monthlyBalance },
          ledger,
          usageSummary: normalizeServerUsageSummary(state.usageSummary),
          lastMonthlyRefresh: state.lastMonthlyRefresh || monthKey(now),
          monthlyAllowance: MONTHLY_ALLOWANCE,
        }
      },
    }
  )
)

export function getTotalCredits(balance: CreditBalance): number {
  return totalBalance(balance)
}
