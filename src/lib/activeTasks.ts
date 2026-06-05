import type { InArgs, ResultSet } from '@tursodatabase/serverless/compat'
import { getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'
import { taskQueueName } from '@/lib/agent/taskQueue'
export { ACTIVE_TASK_CONFLICT_CODE, ACTIVE_TASK_CONFLICT_MESSAGE } from '@/lib/activeTaskConstants'

const ACTIVE_TASK_LEASE_MS = 120_000
const ACTIVE_TASK_STALE_DELETE_MS = 24 * 60 * 60 * 1000
const ACTIVE_TASK_ORPHAN_JOB_GRACE_MS = 30_000

export interface ActiveTaskLease {
  userId: string
  queueName: string
  conversationId: string
  runId: string
  startedAt: number
  updatedAt: number
  expiresAt: number
}

export interface ActiveTaskAcquireResult {
  acquired: boolean
  lease: ActiveTaskLease
}

type ActiveTaskRow = {
  user_id?: unknown
  queue_name?: unknown
  conversation_id?: unknown
  run_id?: unknown
  started_at_ms?: unknown
  updated_at_ms?: unknown
  expires_at_ms?: unknown
}

type ActiveTaskJobRow = {
  status?: unknown
  terminal_status?: unknown
  cancel_requested?: unknown
  lease_expires_at_ms?: unknown
}

type TursoExecutor = {
  execute(input: { sql: string; args?: InArgs }): Promise<ResultSet>
}

interface ActiveTaskMemoryState {
  leases: Map<string, ActiveTaskLease>
}

const activeTaskStateKey = '__agentActiveTaskState' as const
const activeTaskState: ActiveTaskMemoryState =
  (globalThis as unknown as Record<string, ActiveTaskMemoryState>)[activeTaskStateKey] ??
  ((globalThis as unknown as Record<string, ActiveTaskMemoryState>)[activeTaskStateKey] = {
    leases: new Map(),
  })

let activeTaskSchemaPromise: Promise<void> | null = null

function nowMs(): number {
  return Date.now()
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function shouldUseDatabaseActiveTasks(): boolean {
  return getTursoSetupStatus().configured
}

function rowToLease(row: ActiveTaskRow | undefined | null): ActiveTaskLease | null {
  if (!row) return null
  if (typeof row.user_id !== 'string' || typeof row.conversation_id !== 'string' || typeof row.run_id !== 'string') {
    return null
  }
  const now = nowMs()
  return {
    userId: row.user_id,
    queueName: typeof row.queue_name === 'string' && row.queue_name ? row.queue_name : 'default',
    conversationId: row.conversation_id,
    runId: row.run_id,
    startedAt: finiteTimestamp(row.started_at_ms, now),
    updatedAt: finiteTimestamp(row.updated_at_ms, now),
    expiresAt: finiteTimestamp(row.expires_at_ms, now),
  }
}

function taskJobStillActive(row: ActiveTaskJobRow | undefined | null, lease: ActiveTaskLease, now: number): boolean {
  if (!row) {
    return now - lease.startedAt < ACTIVE_TASK_ORPHAN_JOB_GRACE_MS || now - lease.updatedAt < ACTIVE_TASK_ORPHAN_JOB_GRACE_MS
  }

  const status = row.status
  const terminalStatus = row.terminal_status
  const cancelRequested = row.cancel_requested === 1 || row.cancel_requested === true
  if (terminalStatus || cancelRequested) return false
  if (status === 'queued') return true
  if (status !== 'running') return false

  const leaseExpiresAt = Number(row.lease_expires_at_ms)
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now
}

async function readTaskJobForLease(
  executor: TursoExecutor,
  lease: ActiveTaskLease,
): Promise<ActiveTaskJobRow | null> {
  try {
    const result = await executor.execute({
      sql: `
        select status, terminal_status, cancel_requested, lease_expires_at_ms
        from agent_task_jobs
        where queue_name = ? and user_id = ? and run_id = ?
        limit 1
      `,
      args: [lease.queueName, lease.userId, lease.runId],
    })
    return result.rows[0] as ActiveTaskJobRow | undefined || null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/no such table|no such column/i.test(message)) return null
    throw error
  }
}

async function deleteActiveTaskLease(
  executor: TursoExecutor,
  lease: ActiveTaskLease,
): Promise<void> {
  await executor.execute({
    sql: 'delete from user_active_task_leases where queue_name = ? and user_id = ? and run_id = ?',
    args: [lease.queueName, lease.userId, lease.runId],
  })
}

async function ensureActiveTaskSchema(): Promise<void> {
  if (!activeTaskSchemaPromise) {
    activeTaskSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists user_active_task_leases (
          queue_name text not null,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          started_at_ms integer not null,
          updated_at_ms integer not null,
          expires_at_ms integer not null,
          primary key (queue_name, user_id)
        )
      `)
      await tursoExecute('create index if not exists user_active_task_leases_expiry_idx on user_active_task_leases(expires_at_ms)')
    })().catch((error) => {
      activeTaskSchemaPromise = null
      throw error
    })
  }
  return activeTaskSchemaPromise
}

export async function acquireActiveTaskLease(
  userId: string,
  conversationId: string,
  runId: string,
): Promise<ActiveTaskAcquireResult> {
  if (!userId || !conversationId || !runId) {
    throw new Error('Missing active task lease identity')
  }

  const startedAt = nowMs()
  const expiresAt = startedAt + ACTIVE_TASK_LEASE_MS
  const queueName = taskQueueName()
  const memoryKey = `${queueName}:${userId}`

  if (!shouldUseDatabaseActiveTasks()) {
    const existing = activeTaskState.leases.get(memoryKey)
    if (existing && existing.expiresAt > startedAt) return { acquired: false, lease: existing }

    const lease = { userId, queueName, conversationId, runId, startedAt, updatedAt: startedAt, expiresAt }
    activeTaskState.leases.set(memoryKey, lease)
    return { acquired: true, lease }
  }

  await ensureActiveTaskSchema()
  return tursoTransaction('write', async (transaction) => {
    await transaction.execute({
      sql: 'delete from user_active_task_leases where expires_at_ms <= ? or updated_at_ms <= ?',
      args: [startedAt, startedAt - ACTIVE_TASK_STALE_DELETE_MS],
    })
    const inserted = await transaction.execute({
      sql: `
        insert or ignore into user_active_task_leases (
          queue_name, user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
        )
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [queueName, userId, conversationId, runId, startedAt, startedAt, expiresAt],
    })

    let lease: ActiveTaskLease | null = inserted.rowsAffected === 1
      ? { userId, queueName, conversationId, runId, startedAt, updatedAt: startedAt, expiresAt }
      : null

    if (!lease) {
      const active = await transaction.execute({
        sql: `
          select queue_name, user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
          from user_active_task_leases
          where queue_name = ? and user_id = ?
          limit 1
        `,
        args: [queueName, userId],
      })
      lease = rowToLease(active.rows[0] as ActiveTaskRow | undefined)

      if (lease) {
        const jobRow = await readTaskJobForLease(transaction, lease)
        if (!taskJobStillActive(jobRow, lease, startedAt)) {
          await deleteActiveTaskLease(transaction, lease)
          const replacement = await transaction.execute({
            sql: `
              insert or ignore into user_active_task_leases (
                queue_name, user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
              )
              values (?, ?, ?, ?, ?, ?, ?)
            `,
            args: [queueName, userId, conversationId, runId, startedAt, startedAt, expiresAt],
          })
          if (replacement.rowsAffected === 1) {
            lease = { userId, queueName, conversationId, runId, startedAt, updatedAt: startedAt, expiresAt }
            return { acquired: true, lease }
          }

          const activeAfterCleanup = await transaction.execute({
            sql: `
              select queue_name, user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
              from user_active_task_leases
              where queue_name = ? and user_id = ?
              limit 1
            `,
            args: [queueName, userId],
          })
          lease = rowToLease(activeAfterCleanup.rows[0] as ActiveTaskRow | undefined)
        }
      }
    }

    if (!lease) {
      throw new Error('Active task lease could not be read.')
    }
    return { acquired: inserted.rowsAffected === 1, lease }
  })
}

export async function refreshActiveTaskLease(userId: string, runId: string): Promise<void> {
  if (!userId || !runId) return
  const updatedAt = nowMs()
  const expiresAt = updatedAt + ACTIVE_TASK_LEASE_MS
  const queueName = taskQueueName()
  const memoryKey = `${queueName}:${userId}`

  if (!shouldUseDatabaseActiveTasks()) {
    const existing = activeTaskState.leases.get(memoryKey)
    if (existing?.runId === runId) {
      activeTaskState.leases.set(memoryKey, { ...existing, updatedAt, expiresAt })
    }
    return
  }

  await ensureActiveTaskSchema()
  await tursoExecute(
    `
      update user_active_task_leases
      set updated_at_ms = ?, expires_at_ms = ?
      where queue_name = ? and user_id = ? and run_id = ?
    `,
    [updatedAt, expiresAt, queueName, userId, runId],
  )
}

export async function releaseActiveTaskLease(userId: string, runId: string): Promise<void> {
  if (!userId || !runId) return
  const queueName = taskQueueName()
  const memoryKey = `${queueName}:${userId}`

  if (!shouldUseDatabaseActiveTasks()) {
    const existing = activeTaskState.leases.get(memoryKey)
    if (existing?.runId === runId) activeTaskState.leases.delete(memoryKey)
    return
  }

  await ensureActiveTaskSchema()
  await tursoExecute(
    'delete from user_active_task_leases where queue_name = ? and user_id = ? and run_id = ?',
    [queueName, userId, runId],
  )
}

export async function getActiveTaskLeaseForUser(userId: string): Promise<ActiveTaskLease | null> {
  if (!userId) return null
  const now = nowMs()
  const queueName = taskQueueName()
  const memoryKey = `${queueName}:${userId}`

  if (!shouldUseDatabaseActiveTasks()) {
    const lease = activeTaskState.leases.get(memoryKey)
    return lease && lease.expiresAt > now ? lease : null
  }

  await ensureActiveTaskSchema()
  await tursoExecute(
    'delete from user_active_task_leases where expires_at_ms <= ? or updated_at_ms <= ?',
    [now, now - ACTIVE_TASK_STALE_DELETE_MS],
  )
  const rows = await tursoExecute(
    `
      select queue_name, user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
      from user_active_task_leases
      where queue_name = ? and user_id = ? and expires_at_ms > ?
      limit 1
    `,
    [queueName, userId, now],
  )
  const lease = rowToLease(rows.rows[0] as ActiveTaskRow | undefined)
  if (!lease) return null

  const jobRow = await readTaskJobForLease({
    execute: ({ sql, args }) => tursoExecute(sql, args),
  }, lease)
  if (taskJobStillActive(jobRow, lease, now)) return lease

  await releaseActiveTaskLease(lease.userId, lease.runId)
  return null
}

export function clearActiveTaskLeasesForTest(): void {
  activeTaskState.leases.clear()
}
