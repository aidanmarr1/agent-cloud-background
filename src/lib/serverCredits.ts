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
      await tursoExecute('create index if not exists credit_ledger_user_time_idx on credit_ledger(user_id, timestamp desc)')
      await tursoExecute('create index if not exists credit_ledger_user_run_idx on credit_ledger(user_id, run_id)')
      await tursoExecute('create index if not exists credit_ledger_user_conversation_idx on credit_ledger(user_id, conversation_id)')
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
): Promise<ServerCreditRecord> {
  if (!userId) {
    throw new Error('Missing user id for credit event')
  }

  return withAccountLock(userId, async () => {
    const result = await withCreditSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const now = new Date().toISOString()
      await transaction.execute({
        sql: `
          insert or ignore into credit_accounts (user_id, monthly_allowance, monthly_balance, period_key, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)
        `,
        args: [userId, ACCOUNT_STARTING_CREDITS, ACCOUNT_STARTING_CREDITS, monthKey(), now, now],
      })

      const existingResult = await transaction.execute({
        sql: `
          select id, timestamp, amount, category, reason, conversation_id, tool_name, run_id
          from credit_ledger
          where user_id = ? and id = ?
          limit 1
        `,
        args: [userId, entry.id],
      })
      const existing = toLedgerEvent(existingResult.rows[0] as CreditLedgerRow | undefined)
      if (existing) {
        return {
          record: { entry: existing, created: false },
          balanceAfter: Number.POSITIVE_INFINITY,
          isCharge: false,
          requestedAmount: 0,
        }
      }

      const accountResult = await transaction.execute({
        sql: 'select user_id, monthly_allowance, monthly_balance, period_key from credit_accounts where user_id = ? limit 1',
        args: [userId],
      })
      let row = accountResult.rows[0] as CreditAccountRow | undefined
      if (!row) {
        throw new Error('Credit account could not be created.')
      }

      const currentPeriod = monthKey()
      const storedPeriod = typeof row.period_key === 'string' ? row.period_key : currentPeriod
      if (storedPeriod !== currentPeriod) {
        const preservedBalance = roundCreditAmount(Math.max(0, finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS)))
        await transaction.execute({
          sql: `
            update credit_accounts
            set monthly_allowance = ?, monthly_balance = ?, period_key = ?, updated_at = ?
            where user_id = ?
          `,
          args: [ACCOUNT_STARTING_CREDITS, preservedBalance, currentPeriod, now, userId],
        })
        row = {
          user_id: userId,
          monthly_allowance: ACCOUNT_STARTING_CREDITS,
          monthly_balance: preservedBalance,
          period_key: currentPeriod,
        }
      }

      const currentBalance = roundCreditAmount(finiteCreditNumber(row.monthly_balance, ACCOUNT_STARTING_CREDITS))
      const requestedAmount = roundCreditAmount(finiteCreditNumber(entry.amount))
      const isCharge = requestedAmount > 0
      if (isCharge && currentBalance <= 0) {
        throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requestedAmount)
      }

      const amount = isCharge ? roundCreditAmount(Math.min(requestedAmount, currentBalance)) : requestedAmount
      const storedEntry = { ...entry, amount }
      let nextBalance = currentBalance

      if (isCharge) {
        const debitResult = requestedAmount > currentBalance
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
              args: [amount, now, userId, amount],
            })
        if (debitResult.rowsAffected !== 1) {
          throw new OutOfCreditsError(undefined, Math.max(0, currentBalance), requestedAmount)
        }
      } else {
        await transaction.execute({
          sql: 'update credit_accounts set monthly_balance = round(monthly_balance - ?, 2), updated_at = ? where user_id = ?',
          args: [amount, now, userId],
        })
      }
      const updatedAccountResult = await transaction.execute({
        sql: 'select monthly_balance from credit_accounts where user_id = ? limit 1',
        args: [userId],
      })
      nextBalance = roundCreditAmount(finiteCreditNumber((updatedAccountResult.rows[0] as CreditAccountRow | undefined)?.monthly_balance))
      if (nextBalance < 0) {
        throw new OutOfCreditsError(undefined, 0, amount)
      }
      await transaction.execute({
        sql: `
          insert into credit_ledger (
            id, user_id, conversation_id, run_id, amount, category, reason, tool_name, timestamp, balance_after
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          nextBalance,
        ],
      })

      return {
        record: { entry: storedEntry, created: true },
        balanceAfter: nextBalance,
        isCharge,
        requestedAmount,
      }
    }))

    if (result.isCharge && result.balanceAfter <= 0) {
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
  }))
}

export async function chargeServerActiveTime(
  userId: string,
  conversationId: string,
  runId: string,
  tick: number,
  elapsedMs: number,
): Promise<ServerCreditRecord | null> {
  const amount = roundCreditAmount((Math.max(0, elapsedMs) / 60_000) * ACTIVE_CREDITS_PER_MINUTE)
  if (amount <= 0) return null

  return recordServerCreditEvent(userId, conversationId, makeEntry({
    id: `credit:${runId}:active:${tick}`,
    runId,
    conversationId,
    amount,
    category: 'time',
    reason: 'Active agent processing',
  }))
}

export async function chargeServerE2BRuntime(
  userId: string,
  conversationId: string,
  runId: string,
  startedAtMs: number,
  endedAtMs = Date.now(),
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
    id: `credit:${runId}:e2b-runtime`,
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
    id: `credit:${toolCallId}:tool:${toolName}`,
    runId,
    conversationId,
    amount,
    category: 'tool',
    reason: toolName.replace(/_/g, ' '),
    toolName,
  }))
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
