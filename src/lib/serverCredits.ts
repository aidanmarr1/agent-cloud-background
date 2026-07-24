import { randomUUID } from 'crypto'
import {
  ACTIVE_CREDITS_PER_MINUTE,
  E2B_DEFAULT_MEMORY_GIB,
  E2B_DEFAULT_VCPU_COUNT,
  OUT_OF_CREDITS_CODE,
  OUT_OF_CREDITS_MESSAGE,
  TASK_START_CREDITS,
  type CreditCategory,
  type CreditLedgerEvent,
  type CreditTokenUsage,
  e2bSandboxRuntimeCreditCharge,
  finiteCreditNumber,
  roundCreditAmount,
  tokenUsageCreditCharge,
  toolCreditCharge,
} from '@/lib/creditPolicy'
import { tursoExecute, tursoTransaction } from '@/lib/db/turso'

const CREDIT_EVENT_WRITE_ATTEMPTS = 3

export interface ServerCreditLedger {
  version: 1
  entries: CreditLedgerEvent[]
}

export interface ServerTaskCreditSpend {
  conversationId: string
  amount: number
  entryCount: number
  startedAt: number
  updatedAt: number
}

export interface ServerCreditUsageSummary {
  monthlySpent: number
  lifetimeSpent: number
  taskCount: number
  tasks: ServerTaskCreditSpend[]
}

export interface ServerCreditRecord {
  entry: CreditLedgerEvent
  created: boolean
}

export class OutOfCreditsError extends Error {
  readonly code = OUT_OF_CREDITS_CODE
  readonly balanceAfter: number
  readonly requiredCredits: number
  readonly record?: ServerCreditRecord

  constructor(record?: ServerCreditRecord, balanceAfter = 0, requiredCredits = 0) {
    const safeBalance = roundCreditAmount(Math.max(0, finiteCreditNumber(balanceAfter)))
    const safeRequired = roundCreditAmount(Math.max(0, finiteCreditNumber(requiredCredits)))
    super(OUT_OF_CREDITS_MESSAGE)
    this.name = 'OutOfCreditsError'
    this.record = record
    this.balanceAfter = safeBalance
    this.requiredCredits = safeRequired
  }
}

export function isOutOfCreditsError(error: unknown): error is OutOfCreditsError {
  return error instanceof OutOfCreditsError ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === OUT_OF_CREDITS_CODE)
}

export interface ServerCreditSnapshot {
  balance: {
    monthly: number
  }
  ledger: CreditLedgerEvent[]
  usageSummary: ServerCreditUsageSummary
  monthlyAllowance: number
  lastMonthlyRefresh: string
}

type CreditAccountRow = {
  user_id?: unknown
  monthly_allowance?: unknown
  monthly_balance?: unknown
  period_key?: unknown
}

type CreditLedgerRow = {
  id?: unknown
  timestamp?: unknown
  amount?: unknown
  category?: unknown
  reason?: unknown
  conversation_id?: unknown
  tool_name?: unknown
  run_id?: unknown
  balance_after?: unknown
}

type E2BRuntimeSegmentRow = {
  id?: unknown
  user_id?: unknown
  conversation_id?: unknown
  run_id?: unknown
  attempt?: unknown
  provider_sandbox_id?: unknown
  lifecycle_generation?: unknown
  started_at_ms?: unknown
  activated_at_ms?: unknown
  accounted_through_ms?: unknown
  accounted_credits?: unknown
  unpaid_credits?: unknown
  next_sequence?: unknown
  status?: unknown
  ended_at_ms?: unknown
  last_ledger_id?: unknown
}

export interface ServerE2BRuntimeActivation {
  userId: string
  conversationId: string
  runId: string
  attempt: number
  providerSandboxId: string
  lifecycleGeneration: number
  startedAtMs: number
  activatedAtMs?: number
}

export interface ServerE2BRuntimeCheckpoint {
  segmentId: string
  record: ServerCreditRecord | null
  closed: boolean
  outOfCredits: boolean
  balanceAfter: number
  requiredCredits: number
  unpaidCredits: number
}

type CreditSpendRow = {
  monthly_spent?: unknown
  lifetime_spent?: unknown
}

type TaskCreditSpendRow = {
  conversation_id?: unknown
  amount?: unknown
  entry_count?: unknown
  started_at?: unknown
  updated_at?: unknown
}

type AccountCreditOptions = {
  creditAllowance?: number
  creditBalance?: number
  monthlyAllowance?: number
  monthlyBalance?: number
}

export const ACCOUNT_STARTING_CREDITS = 0
export const MINIMUM_PROVIDER_CALL_CREDITS = 0
const SERVER_LEDGER_MAX_ENTRIES = 200
const accountLocks = new Map<string, Promise<void>>()
let creditSchemaPromise: Promise<void> | null = null

function envPositiveNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function monthKey(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 7)
}

function periodStartTimestamp(periodKey: unknown): number {
  const key = typeof periodKey === 'string' ? periodKey : monthKey()
  const date = new Date(`${key}-01T00:00:00.000Z`)
  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? timestamp : new Date(`${monthKey()}-01T00:00:00.000Z`).getTime()
}

async function ensureCreditSchema(): Promise<void> {
  if (!creditSchemaPromise) {
    creditSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists credit_accounts (
          user_id text primary key,
          monthly_allowance real not null,
          monthly_balance real not null,
          period_key text not null,
          created_at text not null,
          updated_at text not null
        )
      `)
      await tursoExecute(`
        create table if not exists credit_ledger (
          id text primary key,
          user_id text not null,
          conversation_id text,
          run_id text,
          amount real not null,
          category text not null,
          reason text not null,
          tool_name text,
          timestamp integer not null,
          balance_after real not null
        )
      `)
      await tursoExecute(`
        create table if not exists credit_e2b_runtime_segments (
          id text primary key,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          attempt integer not null,
          provider_sandbox_id text not null,
          lifecycle_generation integer not null,
          started_at_ms integer not null,
          activated_at_ms integer not null,
          accounted_through_ms integer not null,
          accounted_credits real not null default 0,
          unpaid_credits real not null default 0,
          next_sequence integer not null default 1,
          status text not null default 'open',
          ended_at_ms integer,
          last_ledger_id text,
          updated_at_ms integer not null
        )
      `)
      await tursoExecute('create index if not exists credit_ledger_user_time_idx on credit_ledger(user_id, timestamp desc)')
      await tursoExecute('create index if not exists credit_ledger_user_run_idx on credit_ledger(user_id, run_id)')
      await tursoExecute('create index if not exists credit_ledger_user_conversation_idx on credit_ledger(user_id, conversation_id)')
      await tursoExecute('create index if not exists credit_e2b_runtime_owner_idx on credit_e2b_runtime_segments(conversation_id, provider_sandbox_id, lifecycle_generation, status)')
      await tursoExecute('create index if not exists credit_e2b_runtime_run_idx on credit_e2b_runtime_segments(run_id, attempt, status)')
      await tursoExecute('update credit_accounts set monthly_balance = 0 where monthly_balance < 0')
      await tursoExecute('update credit_ledger set balance_after = 0 where balance_after < 0')
      await tursoExecute(`
        create trigger if not exists credit_accounts_nonnegative_insert
        before insert on credit_accounts
        for each row
        when new.monthly_balance < 0
        begin
          select raise(abort, 'credit balance cannot be negative');
        end
      `)
      await tursoExecute(`
        create trigger if not exists credit_accounts_nonnegative_update
        before update of monthly_balance on credit_accounts
        for each row
        when new.monthly_balance < 0
        begin
          select raise(abort, 'credit balance cannot be negative');
        end
      `)
      await tursoExecute(`
        create trigger if not exists credit_ledger_balance_after_nonnegative_insert
        before insert on credit_ledger
        for each row
        when new.balance_after < 0
        begin
          select raise(abort, 'credit ledger balance cannot be negative');
        end
      `)
      await tursoExecute(`
        create trigger if not exists credit_ledger_balance_after_nonnegative_update
        before update of balance_after on credit_ledger
        for each row
        when new.balance_after < 0
        begin
          select raise(abort, 'credit ledger balance cannot be negative');
        end
      `)
    })().catch((error) => {
      creditSchemaPromise = null
      throw error
    })
  }

  return creditSchemaPromise
}

function isMissingCreditSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|schema/i.test(message)
}

async function withCreditSchemaRepair<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isMissingCreditSchemaError(error)) throw error
    await ensureCreditSchema()
    return operation()
  }
}

async function withAccountLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(userId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const chained = previous.catch(() => undefined).then(() => current)
  accountLocks.set(userId, chained)

  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (accountLocks.get(userId) === chained) {
      accountLocks.delete(userId)
    }
  }
}

function toLedgerEvent(row: CreditLedgerRow | undefined | null): CreditLedgerEvent | null {
  if (!row) return null
  if (typeof row.id !== 'string') return null
  const category = typeof row.category === 'string' ? row.category : ''
  if (!['task', 'time', 'tool', 'tokens', 'adjustment'].includes(category)) return null

  return {
    id: row.id,
    timestamp: finiteCreditNumber(row.timestamp, Date.now()),
    amount: roundCreditAmount(finiteCreditNumber(row.amount)),
    category: category as CreditCategory,
    reason: typeof row.reason === 'string' ? row.reason : 'Credit usage',
    conversationId: typeof row.conversation_id === 'string' ? row.conversation_id : undefined,
    toolName: typeof row.tool_name === 'string' ? row.tool_name : undefined,
    runId: typeof row.run_id === 'string' ? row.run_id : undefined,
    source: 'server',
  }
}

async function readAccountRow(userId: string): Promise<CreditAccountRow | null> {
  const result = await tursoExecute(
    'select user_id, monthly_allowance, monthly_balance, period_key from credit_accounts where user_id = ? limit 1',
    [userId],
  )
  return (result.rows[0] as CreditAccountRow | undefined) ?? null
}

async function createAccountIfMissing(
  userId: string,
  options: AccountCreditOptions = {},
): Promise<void> {
  const now = new Date().toISOString()
  const creditAllowance = roundCreditAmount(Math.max(
    0,
    finiteCreditNumber(options.creditAllowance ?? options.monthlyAllowance, ACCOUNT_STARTING_CREDITS),
  ))
  const creditBalance = roundCreditAmount(Math.max(
    0,
    finiteCreditNumber(options.creditBalance ?? options.monthlyBalance, creditAllowance),
  ))
  await tursoExecute(
    `
      insert or ignore into credit_accounts (user_id, monthly_allowance, monthly_balance, period_key, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `,
    [userId, creditAllowance, creditBalance, monthKey(), now, now],
  )
}

export async function initializeAccountCredits(
  userId: string,
  options: AccountCreditOptions = {},
): Promise<void> {
  if (!userId) {
    throw new Error('Missing user id for credit account')
  }

  await ensureCreditSchema()
  await withAccountLock(userId, async () => {
    await createAccountIfMissing(userId, options)
  })
}

async function updateAccountPeriodIfNeeded(userId: string, row: CreditAccountRow): Promise<CreditAccountRow> {
  const currentPeriod = monthKey()
  const storedPeriod = typeof row.period_key === 'string' ? row.period_key : currentPeriod
  if (storedPeriod === currentPeriod) return row

  const now = new Date().toISOString()
  const preservedBalance = roundCreditAmount(Math.max(0, finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS)))
  await tursoExecute(
    `
      update credit_accounts
      set monthly_allowance = ?, monthly_balance = ?, period_key = ?, updated_at = ?
      where user_id = ?
    `,
    [ACCOUNT_STARTING_CREDITS, preservedBalance, currentPeriod, now, userId],
  )

  return {
    user_id: userId,
    monthly_allowance: ACCOUNT_STARTING_CREDITS,
    monthly_balance: preservedBalance,
    period_key: currentPeriod,
  }
}

export async function ensureAccountCredits(userId: string): Promise<ServerCreditSnapshot['balance']> {
  if (!userId) {
    throw new Error('Missing user id for credit account')
  }

  await ensureCreditSchema()
  return withAccountLock(userId, async () => {
    const period = monthKey()
    await createAccountIfMissing(userId)

    const row = await updateAccountPeriodIfNeeded(userId, (await readAccountRow(userId)) || {
      user_id: userId,
      monthly_allowance: ACCOUNT_STARTING_CREDITS,
      monthly_balance: ACCOUNT_STARTING_CREDITS,
      period_key: period,
    })

    return {
      monthly: roundCreditAmount(finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS)),
    }
  })
}

function makeEntry(input: Omit<CreditLedgerEvent, 'timestamp' | 'source'>): CreditLedgerEvent {
  return {
    ...input,
    amount: roundCreditAmount(input.amount),
    timestamp: Date.now(),
    source: 'server',
  }
}

export async function assertServerCreditsAvailable(
  userId: string,
  minimumCredits = MINIMUM_PROVIDER_CALL_CREDITS,
): Promise<ServerCreditSnapshot['balance']> {
  if (!userId) {
    throw new Error('Missing user id for credit account')
  }

  const requiredBalance = roundCreditAmount(Math.max(0, finiteCreditNumber(minimumCredits)))
  try {
    const row = await readAccountRow(userId)
    if (row && row.period_key === monthKey()) {
      const currentBalance = roundCreditAmount(finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS))
      if (currentBalance <= 0 || currentBalance < requiredBalance) {
        throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requiredBalance)
      }
      return { monthly: currentBalance }
    }
  } catch (error) {
    if (isOutOfCreditsError(error)) throw error
    if (!isMissingCreditSchemaError(error)) throw error
  }

  const balance = await ensureAccountCredits(userId)
  const currentBalance = roundCreditAmount(finiteCreditNumber(balance.monthly))
  if (currentBalance <= 0 || currentBalance < requiredBalance) {
    throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requiredBalance)
  }
  return balance
}

async function recordServerCreditEvent(
  userId: string,
  conversationId: string,
  entry: CreditLedgerEvent,
  options: { requireFullAmount?: boolean } = {},
): Promise<ServerCreditRecord> {
  if (!userId) {
    throw new Error('Missing user id for credit event')
  }

  return withAccountLock(userId, async () => {
    const writeCreditEvent = () => withCreditSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const now = new Date().toISOString()
      const currentPeriod = monthKey()
      const [, existingResult, accountResult] = await transaction.batch([
        {
          sql: `
            insert or ignore into credit_accounts (user_id, monthly_allowance, monthly_balance, period_key, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
          `,
          args: [userId, ACCOUNT_STARTING_CREDITS, ACCOUNT_STARTING_CREDITS, currentPeriod, now, now],
        },
        {
          sql: `
            select id, timestamp, amount, category, reason, conversation_id, tool_name, run_id, balance_after
            from credit_ledger
            where user_id = ? and id = ?
            limit 1
          `,
          args: [userId, entry.id],
        },
        {
          sql: 'select user_id, monthly_allowance, monthly_balance, period_key from credit_accounts where user_id = ? limit 1',
          args: [userId],
        },
      ])
      const existing = toLedgerEvent(existingResult.rows[0] as CreditLedgerRow | undefined)
      if (existing) {
        const requestedAmount = roundCreditAmount(finiteCreditNumber(entry.amount))
        const balanceAfter = roundCreditAmount(Math.max(
          0,
          finiteCreditNumber((existingResult.rows[0] as CreditLedgerRow | undefined)?.balance_after),
        ))
        return {
          record: { entry: existing, created: false },
          balanceAfter,
          isCharge: requestedAmount > 0,
          requestedAmount,
        }
      }

      const row = accountResult.rows[0] as CreditAccountRow | undefined
      if (!row) {
        throw new Error('Credit account could not be created.')
      }

      const currentBalance = roundCreditAmount(finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS))
      const requestedAmount = roundCreditAmount(finiteCreditNumber(entry.amount))
      const isCharge = requestedAmount > 0
      if (isCharge && currentBalance <= 0) {
        throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requestedAmount)
      }
      if (isCharge && options.requireFullAmount && currentBalance < requestedAmount) {
        throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requestedAmount)
      }

      const amount = isCharge ? roundCreditAmount(Math.min(requestedAmount, currentBalance)) : requestedAmount
      const storedEntry = { ...entry, amount }
      const accountUpdate = isCharge && requestedAmount > currentBalance
        ? {
            sql: `
              update credit_accounts
              set monthly_allowance = case when period_key <> ? then ? else monthly_allowance end,
                  monthly_balance = 0, period_key = ?, updated_at = ?
              where user_id = ? and monthly_balance = ?
            `,
            args: [currentPeriod, ACCOUNT_STARTING_CREDITS, currentPeriod, now, userId, currentBalance],
          }
        : isCharge
          ? {
              sql: `
                update credit_accounts
                set monthly_allowance = case when period_key <> ? then ? else monthly_allowance end,
                    monthly_balance = round(monthly_balance - ?, 2), period_key = ?, updated_at = ?
                where user_id = ? and monthly_balance >= ?
              `,
              args: [currentPeriod, ACCOUNT_STARTING_CREDITS, amount, currentPeriod, now, userId, amount],
            }
          : {
              sql: `
                update credit_accounts
                set monthly_allowance = case when period_key <> ? then ? else monthly_allowance end,
                    monthly_balance = round(monthly_balance - ?, 2), period_key = ?, updated_at = ?
                where user_id = ?
              `,
              args: [currentPeriod, ACCOUNT_STARTING_CREDITS, amount, currentPeriod, now, userId],
            }
      const [balanceUpdateResult, updatedAccountResult] = await transaction.batch([
        accountUpdate,
        {
          sql: 'select monthly_balance from credit_accounts where user_id = ? limit 1',
          args: [userId],
        },
        {
          sql: `
            insert into credit_ledger (
              id, user_id, conversation_id, run_id, amount, category, reason, tool_name, timestamp, balance_after
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, (select monthly_balance from credit_accounts where user_id = ? limit 1))
          `,
          args: [
            storedEntry.id,
            userId,
            storedEntry.conversationId || conversationId,
            storedEntry.runId || null,
            amount,
            storedEntry.category,
            storedEntry.reason,
            storedEntry.toolName || null,
            storedEntry.timestamp,
            userId,
          ],
        },
      ])
      if (balanceUpdateResult.rowsAffected !== 1) {
        if (isCharge) {
          throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requestedAmount)
        }
        throw new Error('Credit account balance could not be updated.')
      }
      const nextBalance = roundCreditAmount(finiteCreditNumber((updatedAccountResult.rows[0] as CreditAccountRow | undefined)?.monthly_balance))
      if (nextBalance < 0) {
        throw new OutOfCreditsError(undefined, 0, amount)
      }

      return {
        record: { entry: storedEntry, created: true },
        balanceAfter: nextBalance,
        isCharge,
        requestedAmount,
      }
    }))

    let result: Awaited<ReturnType<typeof writeCreditEvent>> | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < CREDIT_EVENT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        result = await writeCreditEvent()
        break
      } catch (error) {
        if (isOutOfCreditsError(error)) throw error
        lastError = error
        if (attempt + 1 < CREDIT_EVENT_WRITE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
        }
      }
    }
    if (!result) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Credit event persistence failed'))
    }

    const paidAmount = roundCreditAmount(Math.max(0, finiteCreditNumber(result.record.entry.amount)))
    if (result.isCharge && paidAmount < result.requestedAmount) {
      throw new OutOfCreditsError(result.record, result.balanceAfter, result.requestedAmount)
    }

    return result.record
  })
}

export async function readServerCreditLedger(
  userId: string,
  options: { ensureAccount?: boolean } = {},
): Promise<ServerCreditLedger> {
  await ensureCreditSchema()
  if (options.ensureAccount !== false) {
    await ensureAccountCredits(userId)
  }
  const result = await tursoExecute(
    `
      select id, timestamp, amount, category, reason, conversation_id, tool_name, run_id
      from credit_ledger
      where user_id = ?
      order by timestamp desc
      limit ?
    `,
    [userId, SERVER_LEDGER_MAX_ENTRIES],
  )
  return {
    version: 1,
    entries: result.rows
      .map((row) => toLedgerEvent(row as CreditLedgerRow))
      .filter((entry): entry is CreditLedgerEvent => !!entry),
  }
}

export async function readServerCreditUsageSummary(
  userId: string,
  row?: CreditAccountRow | null,
): Promise<ServerCreditUsageSummary> {
  await ensureCreditSchema()
  const monthlyPeriodStart = periodStartTimestamp(row?.period_key)

  const spendResult = await tursoExecute(
    `
      select
        coalesce(sum(case when amount > 0 and timestamp >= ? then amount else 0 end), 0) as monthly_spent,
        coalesce(sum(case when amount > 0 then amount else 0 end), 0) as lifetime_spent
      from credit_ledger
      where user_id = ?
    `,
    [monthlyPeriodStart, userId],
  )
  const spend = spendResult.rows[0] as CreditSpendRow | undefined

  const taskResult = await tursoExecute(
    `
      select
        conversation_id,
        coalesce(sum(amount), 0) as amount,
        count(*) as entry_count,
        min(timestamp) as started_at,
        max(timestamp) as updated_at
      from credit_ledger
      where user_id = ?
        and conversation_id is not null
        and conversation_id != ''
        and amount > 0
      group by conversation_id
      order by updated_at desc
    `,
    [userId],
  )

  const tasks = taskResult.rows
    .map((taskRow) => {
      const task = taskRow as TaskCreditSpendRow
      if (typeof task.conversation_id !== 'string' || !task.conversation_id) return null
      const timestamp = finiteCreditNumber(task.updated_at, Date.now())
      return {
        conversationId: task.conversation_id,
        amount: roundCreditAmount(finiteCreditNumber(task.amount)),
        entryCount: Math.max(0, Math.floor(finiteCreditNumber(task.entry_count))),
        startedAt: finiteCreditNumber(task.started_at, timestamp),
        updatedAt: timestamp,
      }
    })
    .filter((task): task is ServerTaskCreditSpend => !!task)

  return {
    monthlySpent: roundCreditAmount(finiteCreditNumber(spend?.monthly_spent)),
    lifetimeSpent: roundCreditAmount(finiteCreditNumber(spend?.lifetime_spent)),
    taskCount: tasks.length,
    tasks,
  }
}

export async function getServerCreditSnapshot(userId: string): Promise<ServerCreditSnapshot> {
  await ensureCreditSchema()
  const balance = await ensureAccountCredits(userId)
  const row = await readAccountRow(userId)
  const ledger = await readServerCreditLedger(userId, { ensureAccount: false })
  const usageSummary = await readServerCreditUsageSummary(userId, row)

  return {
    balance,
    ledger: ledger.entries,
    usageSummary,
    monthlyAllowance: roundCreditAmount(finiteCreditNumber(row?.monthly_allowance, ACCOUNT_STARTING_CREDITS)),
    lastMonthlyRefresh: typeof row?.period_key === 'string' ? row.period_key : monthKey(),
  }
}

export async function chargeServerTaskStart(
  userId: string,
  conversationId: string,
  runId: string,
): Promise<ServerCreditRecord | null> {
  if (TASK_START_CREDITS <= 0) return null

  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId}:task-start`,
    runId,
    conversationId,
    amount: TASK_START_CREDITS,
    category: 'task',
    reason: 'Task started',
  }), { requireFullAmount: true })
}

export async function chargeServerActiveTime(
  userId: string,
  conversationId: string,
  runId: string,
  tick: number,
  elapsedMs: number,
  attempt = 1,
): Promise<ServerCreditRecord | null> {
  const amount = roundCreditAmount((Math.max(0, elapsedMs) / 60_000) * ACTIVE_CREDITS_PER_MINUTE)
  if (amount <= 0) return null

  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId}:active:${Math.max(1, Math.floor(attempt))}:${tick}`,
    runId,
    conversationId,
    amount,
    category: 'time',
    reason: 'Active agent processing',
  }))
}

function normalizeE2BRuntimeAttempt(attempt: number): number {
  return Math.max(1, Math.floor(finiteCreditNumber(attempt, 1)))
}

function e2bRuntimeSegmentId(runId: string, attempt: number): string {
  return `e2b-runtime:${runId}:${normalizeE2BRuntimeAttempt(attempt)}`
}

function requiredE2BRuntimeString(value: string, label: string): string {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 512) {
    throw new Error(`Invalid ${label} for E2B runtime billing.`)
  }
  return normalized
}

function e2bRuntimeAmount(startedAtMs: number, endedAtMs: number): number {
  return e2bSandboxRuntimeCreditCharge({
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    vcpuCount: envPositiveNumber('AGENT_E2B_VCPU_COUNT', E2B_DEFAULT_VCPU_COUNT),
    memoryGiB: envPositiveNumber('AGENT_E2B_MEMORY_GIB', E2B_DEFAULT_MEMORY_GIB),
  })
}

function runtimeRowString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function runtimeRowInteger(value: unknown, fallback = 0): number {
  const parsed = Math.floor(finiteCreditNumber(value, fallback))
  return Number.isFinite(parsed) ? parsed : fallback
}

async function readE2BRuntimeSegment(segmentId: string): Promise<E2BRuntimeSegmentRow | null> {
  const result = await tursoExecute(
    `
      select id, user_id, conversation_id, run_id, attempt, provider_sandbox_id,
             lifecycle_generation, started_at_ms, activated_at_ms, accounted_through_ms,
             accounted_credits, unpaid_credits, next_sequence, status, ended_at_ms,
             last_ledger_id
      from credit_e2b_runtime_segments
      where id = ?
      limit 1
    `,
    [segmentId],
  )
  return (result.rows[0] as E2BRuntimeSegmentRow | undefined) ?? null
}

/**
 * Activates billing only after the provider sandbox is confirmed usable. The
 * provider identity and lifecycle generation are checked against the durable
 * sandbox row so a stale worker cannot attach billing to a newer sandbox.
 * Browser startup is deliberately independent from this boundary because
 * terminal/file-only tasks do not require Chromium. No credits are debited by activation itself.
 */
export async function activateServerE2BRuntimeBilling(
  input: ServerE2BRuntimeActivation,
): Promise<string> {
  const userId = requiredE2BRuntimeString(input.userId, 'user id')
  const conversationId = requiredE2BRuntimeString(input.conversationId, 'conversation id')
  const runId = requiredE2BRuntimeString(input.runId, 'run id')
  const providerSandboxId = requiredE2BRuntimeString(input.providerSandboxId, 'provider sandbox id')
  const attempt = normalizeE2BRuntimeAttempt(input.attempt)
  const lifecycleGeneration = Math.max(0, runtimeRowInteger(input.lifecycleGeneration))
  const activatedAtMs = Math.min(Date.now(), Math.max(0, runtimeRowInteger(input.activatedAtMs, Date.now())))
  const startedAtMs = Math.min(activatedAtMs, Math.max(0, runtimeRowInteger(input.startedAtMs, activatedAtMs)))
  const segmentId = e2bRuntimeSegmentId(runId, attempt)

  await ensureCreditSchema()
  const writeActivation = () => withCreditSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    const ownership = await transaction.execute({
      sql: `
        select provider_sandbox_id, lifecycle_generation, lifecycle_state
        from agent_cloud_sandboxes
        where conversation_id = ? and provider = 'e2b'
        limit 1
      `,
      args: [conversationId],
    })
    const owner = ownership.rows[0]
    if (
      owner?.provider_sandbox_id !== providerSandboxId ||
      runtimeRowInteger(owner?.lifecycle_generation, -1) !== lifecycleGeneration ||
      owner?.lifecycle_state !== 'active'
    ) {
      throw new Error('E2B sandbox ownership changed before runtime billing activation.')
    }

    const existingResult = await transaction.execute({
      sql: `
        select id, user_id, conversation_id, run_id, attempt, provider_sandbox_id,
               lifecycle_generation, started_at_ms, status
        from credit_e2b_runtime_segments
        where id = ?
        limit 1
      `,
      args: [segmentId],
    })
    const existing = existingResult.rows[0] as E2BRuntimeSegmentRow | undefined
    if (existing) {
      const sameIdentity =
        existing.user_id === userId &&
        existing.conversation_id === conversationId &&
        existing.run_id === runId &&
        runtimeRowInteger(existing.attempt) === attempt &&
        existing.provider_sandbox_id === providerSandboxId &&
        runtimeRowInteger(existing.lifecycle_generation, -1) === lifecycleGeneration &&
        runtimeRowInteger(existing.started_at_ms, -1) === startedAtMs
      if (!sameIdentity) {
        throw new Error('E2B runtime billing idempotency key was reused for different ownership.')
      }
      if (existing.status !== 'open') {
        throw new Error('E2B runtime billing segment was already closed.')
      }
      return
    }

    await transaction.execute({
      sql: `
        insert into credit_e2b_runtime_segments (
          id, user_id, conversation_id, run_id, attempt, provider_sandbox_id,
          lifecycle_generation, started_at_ms, activated_at_ms, accounted_through_ms,
          accounted_credits, unpaid_credits, next_sequence, status, ended_at_ms,
          last_ledger_id, updated_at_ms
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 'open', null, null, ?)
      `,
      args: [
        segmentId,
        userId,
        conversationId,
        runId,
        attempt,
        providerSandboxId,
        lifecycleGeneration,
        startedAtMs,
        activatedAtMs,
        startedAtMs,
        activatedAtMs,
      ],
    })
  }))
  let activated = false
  let activationError: unknown = null
  for (let writeAttempt = 0; writeAttempt < CREDIT_EVENT_WRITE_ATTEMPTS; writeAttempt += 1) {
    try {
      await writeActivation()
      activated = true
      break
    } catch (error) {
      activationError = error
      if (writeAttempt + 1 < CREDIT_EVENT_WRITE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 75 * (writeAttempt + 1)))
      }
    }
  }
  if (!activated) {
    throw activationError instanceof Error
      ? activationError
      : new Error(String(activationError || 'E2B runtime billing activation failed'))
  }

  // Graceful handoff can reconnect to the same provider sandbox under a newer
  // durable generation. Only a strictly older attempt of this same run and
  // provider can be superseded here, so a stale attempt can never close a newer
  // segment. Replaced provider sandboxes are settled by lifecycle cleanup.
  const older = await tursoExecute(
    `
      select id
      from credit_e2b_runtime_segments
      where run_id = ?
        and conversation_id = ?
        and provider_sandbox_id = ?
        and attempt < ?
        and status = 'open'
      order by attempt asc
    `,
    [runId, conversationId, providerSandboxId, attempt],
  )
  for (const row of older.rows) {
    if (typeof row.id !== 'string' || !row.id) continue
    await checkpointServerE2BRuntimeBilling(row.id, startedAtMs, {
      close: true,
      requirePaid: false,
      allowHandoffOwnership: true,
    })
  }

  return segmentId
}

/**
 * Atomically advances a durable E2B segment, debits the account, and writes the
 * corresponding ledger entry. Cumulative pricing prevents checkpoint rounding
 * drift; the durable sequence makes transaction retries and lost ACKs exactly
 * idempotent.
 */
export async function checkpointServerE2BRuntimeBilling(
  segmentId: string,
  endedAtMs = Date.now(),
  options: {
    close?: boolean
    requirePaid?: boolean
    allowFencedOwnership?: boolean
    allowHandoffOwnership?: boolean
  } = {},
): Promise<ServerE2BRuntimeCheckpoint> {
  const safeSegmentId = requiredE2BRuntimeString(segmentId, 'runtime segment id')
  await ensureCreditSchema()
  const firstRead = await withCreditSchemaRepair(() => readE2BRuntimeSegment(safeSegmentId))
  if (!firstRead) throw new Error('E2B runtime billing segment was not found.')
  const userId = requiredE2BRuntimeString(runtimeRowString(firstRead.user_id), 'runtime segment user id')

  const result = await withAccountLock(userId, async () => {
    const writeCheckpoint = () => withCreditSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const selected = await transaction.execute({
        sql: `
          select id, user_id, conversation_id, run_id, attempt, provider_sandbox_id,
                 lifecycle_generation, started_at_ms, activated_at_ms, accounted_through_ms,
                 accounted_credits, unpaid_credits, next_sequence, status, ended_at_ms,
                 last_ledger_id
          from credit_e2b_runtime_segments
          where id = ?
          limit 1
        `,
        args: [safeSegmentId],
      })
      const row = selected.rows[0] as E2BRuntimeSegmentRow | undefined
      if (!row || row.user_id !== userId) {
        throw new Error('E2B runtime billing segment ownership changed.')
      }

      const startedAt = Math.max(0, runtimeRowInteger(row.started_at_ms))
      const previousThrough = Math.max(startedAt, runtimeRowInteger(row.accounted_through_ms, startedAt))
      const requestedEnd = Math.max(startedAt, runtimeRowInteger(endedAtMs, Date.now()))
      const targetEnd = Math.min(Date.now(), Math.max(previousThrough, requestedEnd))
      const previousAssessed = roundCreditAmount(Math.max(0, finiteCreditNumber(row.accounted_credits)))
      const targetAssessed = e2bRuntimeAmount(startedAt, targetEnd)
      const requestedAmount = roundCreditAmount(Math.max(0, targetAssessed - previousAssessed))
      const previousUnpaid = roundCreditAmount(Math.max(0, finiteCreditNumber(row.unpaid_credits)))
      const statusClosed = row.status === 'closed'

      const readLastRecord = async (): Promise<ServerCreditRecord | null> => {
        if (typeof row.last_ledger_id !== 'string' || !row.last_ledger_id) return null
        const ledger = await transaction.execute({
          sql: `
            select id, timestamp, amount, category, reason, conversation_id, tool_name, run_id, balance_after
            from credit_ledger
            where user_id = ? and id = ?
            limit 1
          `,
          args: [userId, row.last_ledger_id],
        })
        const event = toLedgerEvent(ledger.rows[0] as CreditLedgerRow | undefined)
        return event ? { entry: event, created: false } : null
      }

      if (statusClosed) {
        if (options.close !== true) {
          throw new Error('E2B runtime billing segment was closed by a newer lifecycle owner.')
        }
        const record = await readLastRecord()
        const account = await transaction.execute({
          sql: 'select monthly_balance from credit_accounts where user_id = ? limit 1',
          args: [userId],
        })
        const balanceAfter = roundCreditAmount(Math.max(
          0,
          finiteCreditNumber((account.rows[0] as CreditAccountRow | undefined)?.monthly_balance),
        ))
        return {
          segmentId: safeSegmentId,
          record,
          closed: true,
          outOfCredits: previousUnpaid > 0,
          balanceAfter,
          requiredCredits: previousUnpaid,
          unpaidCredits: previousUnpaid,
        } satisfies ServerE2BRuntimeCheckpoint
      }

      const ownershipResult = await transaction.execute({
        sql: `
          select provider_sandbox_id, lifecycle_generation, lifecycle_source_generation, lifecycle_state
          from agent_cloud_sandboxes
          where conversation_id = ? and provider = 'e2b'
          limit 1
        `,
        args: [runtimeRowString(row.conversation_id)],
      })
      const ownership = ownershipResult.rows[0]
      const segmentGeneration = runtimeRowInteger(row.lifecycle_generation, -1)
      const ownsActiveSandbox =
        ownership?.provider_sandbox_id === row.provider_sandbox_id &&
        ownership?.lifecycle_state === 'active' &&
        runtimeRowInteger(ownership.lifecycle_generation, -1) === segmentGeneration
      const ownsFencedSandbox =
        options.allowFencedOwnership === true &&
        ownership?.provider_sandbox_id === row.provider_sandbox_id &&
        (ownership?.lifecycle_state === 'resetting' || ownership?.lifecycle_state === 'destroying') &&
        runtimeRowInteger(ownership.lifecycle_source_generation, -1) === segmentGeneration
      const ownsHandoffSandbox =
        options.allowHandoffOwnership === true &&
        ownership?.provider_sandbox_id === row.provider_sandbox_id &&
        ownership?.lifecycle_state === 'active' &&
        runtimeRowInteger(ownership.lifecycle_generation, -1) >= segmentGeneration
      const ownsExpectedLifecycle = options.allowFencedOwnership === true
        ? ownsFencedSandbox
        : options.allowHandoffOwnership === true
          ? ownsHandoffSandbox
          : ownsActiveSandbox
      if (!ownsExpectedLifecycle) {
        throw new Error('E2B sandbox ownership changed before runtime checkpoint.')
      }

      let balanceAfter = 0
      let paidAmount = 0
      let record: ServerCreditRecord | null = null
      let lastLedgerId = typeof row.last_ledger_id === 'string' ? row.last_ledger_id : null
      const sequence = Math.max(1, runtimeRowInteger(row.next_sequence, 1))

      if (requestedAmount > 0) {
        const now = new Date().toISOString()
        await transaction.execute({
          sql: `
            insert or ignore into credit_accounts (
              user_id, monthly_allowance, monthly_balance, period_key, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?)
          `,
          args: [userId, ACCOUNT_STARTING_CREDITS, ACCOUNT_STARTING_CREDITS, monthKey(), now, now],
        })
        const accountResult = await transaction.execute({
          sql: 'select user_id, monthly_allowance, monthly_balance, period_key from credit_accounts where user_id = ? limit 1',
          args: [userId],
        })
        let account = accountResult.rows[0] as CreditAccountRow | undefined
        if (!account) throw new Error('Credit account could not be created.')
        const currentPeriod = monthKey()
        if (account.period_key !== currentPeriod) {
          const preservedBalance = roundCreditAmount(Math.max(
            0,
            finiteCreditNumber(account.monthly_balance, ACCOUNT_STARTING_CREDITS),
          ))
          await transaction.execute({
            sql: `
              update credit_accounts
              set monthly_allowance = ?, monthly_balance = ?, period_key = ?, updated_at = ?
              where user_id = ?
            `,
            args: [ACCOUNT_STARTING_CREDITS, preservedBalance, currentPeriod, now, userId],
          })
          account = {
            user_id: userId,
            monthly_allowance: ACCOUNT_STARTING_CREDITS,
            monthly_balance: preservedBalance,
            period_key: currentPeriod,
          }
        }

        const currentBalance = roundCreditAmount(Math.max(
          0,
          finiteCreditNumber(account.monthly_balance, ACCOUNT_STARTING_CREDITS),
        ))
        paidAmount = roundCreditAmount(Math.min(requestedAmount, currentBalance))
        balanceAfter = currentBalance
        if (paidAmount > 0) {
          const debit = paidAmount === currentBalance
            ? await transaction.execute({
                sql: `
                  update credit_accounts
                  set monthly_balance = 0, updated_at = ?
                  where user_id = ? and monthly_balance = ?
                `,
                args: [now, userId, currentBalance],
              })
            : await transaction.execute({
                sql: `
                  update credit_accounts
                  set monthly_balance = round(monthly_balance - ?, 2), updated_at = ?
                  where user_id = ? and monthly_balance >= ?
                `,
                args: [paidAmount, now, userId, paidAmount],
              })
          if (debit.rowsAffected !== 1) {
            throw new Error('Concurrent credit debit prevented E2B runtime accounting.')
          }
          balanceAfter = roundCreditAmount(Math.max(0, currentBalance - paidAmount))
          lastLedgerId = `credit:${runtimeRowString(row.run_id)}:e2b-runtime:${normalizeE2BRuntimeAttempt(runtimeRowInteger(row.attempt, 1))}:${sequence}`
          const elapsedSeconds = Math.max(0, Math.round((targetEnd - startedAt) / 1000))
          const event: CreditLedgerEvent = {
            id: lastLedgerId,
            timestamp: targetEnd,
            amount: paidAmount,
            category: 'tool',
            reason: `E2B sandbox runtime (${elapsedSeconds}s total)`,
            conversationId: runtimeRowString(row.conversation_id),
            toolName: 'e2b_sandbox',
            runId: runtimeRowString(row.run_id),
            source: 'server',
          }
          await transaction.execute({
            sql: `
              insert into credit_ledger (
                id, user_id, conversation_id, run_id, amount, category, reason,
                tool_name, timestamp, balance_after
              )
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              event.id,
              userId,
              event.conversationId || null,
              event.runId || null,
              event.amount,
              event.category,
              event.reason,
              event.toolName || null,
              event.timestamp,
              balanceAfter,
            ],
          })
          record = { entry: event, created: true }
        }
      } else {
        const account = await transaction.execute({
          sql: 'select monthly_balance from credit_accounts where user_id = ? limit 1',
          args: [userId],
        })
        balanceAfter = roundCreditAmount(Math.max(
          0,
          finiteCreditNumber((account.rows[0] as CreditAccountRow | undefined)?.monthly_balance),
        ))
      }

      const unpaidCredits = roundCreditAmount(previousUnpaid + Math.max(0, requestedAmount - paidAmount))
      const closed = options.close === true
      const advanced = await transaction.execute({
        sql: `
          update credit_e2b_runtime_segments
          set accounted_through_ms = ?,
              accounted_credits = ?,
              unpaid_credits = ?,
              next_sequence = ?,
              status = ?,
              ended_at_ms = case when ? = 1 then ? else ended_at_ms end,
              last_ledger_id = ?,
              updated_at_ms = ?
          where id = ?
            and status = 'open'
            and accounted_through_ms = ?
            and next_sequence = ?
        `,
        args: [
          targetEnd,
          targetAssessed,
          unpaidCredits,
          sequence + (record ? 1 : 0),
          closed ? 'closed' : 'open',
          closed ? 1 : 0,
          closed ? targetEnd : null,
          lastLedgerId,
          Date.now(),
          safeSegmentId,
          previousThrough,
          sequence,
        ],
      })
      if (advanced.rowsAffected !== 1) {
        throw new Error('Concurrent E2B runtime checkpoint prevented accounting advancement.')
      }

      return {
        segmentId: safeSegmentId,
        record,
        closed,
        outOfCredits: unpaidCredits > 0,
        balanceAfter,
        requiredCredits: roundCreditAmount(Math.max(requestedAmount, unpaidCredits)),
        unpaidCredits,
      } satisfies ServerE2BRuntimeCheckpoint
    }))

    let checkpoint: ServerE2BRuntimeCheckpoint | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < CREDIT_EVENT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        checkpoint = await writeCheckpoint()
        break
      } catch (error) {
        lastError = error
        if (attempt + 1 < CREDIT_EVENT_WRITE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
        }
      }
    }
    if (!checkpoint) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError || 'E2B runtime checkpoint failed'))
    }
    return checkpoint
  })

  if (options.requirePaid !== false && result.outOfCredits) {
    throw new OutOfCreditsError(result.record ?? undefined, result.balanceAfter, result.requiredCredits)
  }
  return result
}

/** Close only segments attached to the exact sandbox ownership fence. */
export async function reconcileServerE2BRuntimeBillingForSandbox(input: {
  conversationId: string
  providerSandboxId: string
  lifecycleGeneration: number
  endedAtMs?: number
}): Promise<ServerE2BRuntimeCheckpoint[]> {
  const conversationId = requiredE2BRuntimeString(input.conversationId, 'conversation id')
  const providerSandboxId = requiredE2BRuntimeString(input.providerSandboxId, 'provider sandbox id')
  const lifecycleGeneration = Math.max(0, runtimeRowInteger(input.lifecycleGeneration))
  const endedAtMs = Math.min(Date.now(), Math.max(0, runtimeRowInteger(input.endedAtMs, Date.now())))
  await ensureCreditSchema()
  const segments = await withCreditSchemaRepair(() => tursoExecute(
    `
      select id
      from credit_e2b_runtime_segments
      where conversation_id = ?
        and provider_sandbox_id = ?
        and lifecycle_generation = ?
        and status = 'open'
      order by activated_at_ms asc, attempt asc
    `,
    [conversationId, providerSandboxId, lifecycleGeneration],
  ))
  const checkpoints: ServerE2BRuntimeCheckpoint[] = []
  for (const row of segments.rows) {
    if (typeof row.id !== 'string' || !row.id) continue
    checkpoints.push(await checkpointServerE2BRuntimeBilling(row.id, endedAtMs, {
      close: true,
      requirePaid: false,
      allowFencedOwnership: true,
    }))
  }
  return checkpoints
}

export async function chargeServerE2BRuntime(
  userId: string,
  conversationId: string,
  runId: string,
  startedAtMs: number,
  endedAtMs = Date.now(),
  attempt = 1,
): Promise<ServerCreditRecord | null> {
  const elapsedMs = Math.max(0, finiteCreditNumber(endedAtMs) - finiteCreditNumber(startedAtMs))
  const amount = e2bSandboxRuntimeCreditCharge({
    elapsedMs,
    vcpuCount: envPositiveNumber('AGENT_E2B_VCPU_COUNT', E2B_DEFAULT_VCPU_COUNT),
    memoryGiB: envPositiveNumber('AGENT_E2B_MEMORY_GIB', E2B_DEFAULT_MEMORY_GIB),
  })
  if (amount <= 0) return null

  const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000))
  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId}:e2b-runtime:${Math.max(1, Math.floor(attempt))}`,
    runId,
    conversationId,
    amount,
    category: 'tool',
    reason: `E2B sandbox runtime (${elapsedSeconds}s)`,
    toolName: 'e2b_sandbox',
  }))
}

export async function chargeServerTool(
  userId: string,
  conversationId: string,
  toolName: string,
  toolCallId: string,
  runId?: string,
): Promise<ServerCreditRecord | null> {
  const amount = toolCreditCharge(toolName)
  if (amount <= 0) return null

  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId || 'standalone'}:${toolCallId}:tool:${toolName}`,
    runId,
    conversationId,
    amount,
    category: 'tool',
    reason: toolName.replace(/_/g, ' '),
    toolName,
  }), { requireFullAmount: true })
}

export async function chargeServerTokenUsage(
  userId: string,
  conversationId: string,
  runId: string,
  usage: CreditTokenUsage | number,
  chargeId = 'tokens',
): Promise<ServerCreditRecord | null> {
  if (typeof usage !== 'object' || usage === null || !Number.isFinite(Number(usage.cost))) {
    throw new Error('The assistant provider did not return billable usage.')
  }

  const amount = tokenUsageCreditCharge(usage)
  if (amount <= 0) return null

  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId}:${chargeId}`,
    runId,
    conversationId,
    amount,
    category: 'tokens',
    reason: 'Model token usage',
  }))
}

export async function topUpServerCredits(
  userId: string,
  amount: number,
  reason = 'Agent Admin credit grant',
): Promise<ServerCreditRecord | null> {
  const normalizedAmount = roundCreditAmount(Math.max(0, finiteCreditNumber(amount)))
  if (!userId) {
    throw new Error('Missing user id for credit top-up')
  }
  if (normalizedAmount <= 0) return null

  return recordServerCreditEvent(userId, 'credit-top-up', makeEntry({
    id: `credit:${randomUUID()}:top-up`,
    amount: -normalizedAmount,
    category: 'adjustment',
    reason,
  }))
}

export function createClientCreditFallbackId(): string {
  return `credit:${randomUUID()}`
}
