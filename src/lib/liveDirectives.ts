import { createHash, randomUUID } from 'crypto'
import type { Transaction } from '@tursodatabase/serverless/compat'
import { taskQueueName } from '@/lib/agent/taskQueue'
import {
  ensureConversationSchema,
  persistAcceptedLiveDirectiveInConversation,
  persistRejectedLiveDirectiveOutcomeInConversation,
} from '@/lib/conversations'
import { getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'
import { MAX_TASK_INPUT_CHARS, clampTaskInput } from '@/lib/inputLimits'

export const MAX_LIVE_DIRECTIVE_CHARS = MAX_TASK_INPUT_CHARS
export const MAX_QUEUED_LIVE_DIRECTIVES = 12

const LIVE_DIRECTIVE_RETENTION_MS = 24 * 60 * 60 * 1000
const LIVE_DIRECTIVE_REJECTED_CODE = 'TASK_FINISHED_BEFORE_DIRECTIVE_DELIVERY'
const LIVE_DIRECTIVE_REJECTED_MESSAGE =
  'The task finished before this live instruction could be delivered. Send it again as a new message if you still need it.'

export class LiveDirectiveTargetInactiveError extends Error {
  readonly code = 'NO_ACTIVE_TASK_FOR_DIRECTIVE'

  constructor() {
    super('That task is no longer running. Send a new message instead.')
    this.name = 'LiveDirectiveTargetInactiveError'
  }
}

export class LiveDirectiveQueueFullError extends Error {
  readonly code = 'LIVE_DIRECTIVE_QUEUE_FULL'

  constructor() {
    super('Too many live instructions are waiting. Let the task catch up, then try again.')
    this.name = 'LiveDirectiveQueueFullError'
  }
}

export class LiveDirectiveIdConflictError extends Error {
  readonly code = 'LIVE_DIRECTIVE_ID_CONFLICT'

  constructor() {
    super('That live instruction id is already associated with different content.')
    this.name = 'LiveDirectiveIdConflictError'
  }
}

export type LiveDirectiveStatus = 'accepted' | 'delivered' | 'rejected'

export interface LiveDirectiveReceipt {
  id: string
  conversationId: string
  continuationMessageId: string
  content: string
  createdAt: number
  userId: string
  runId: string
  queueName: string
  status: LiveDirectiveStatus
  outcomeCode?: string
  outcomeMessage?: string
  outcomeAt?: number
}

export interface LiveDirective {
  id: string
  conversationId: string
  content: string
  createdAt: number
  userId?: string
  runId?: string
  queueName?: string
  claimedAttempt?: number
  continuationMessageId?: string
  status?: LiveDirectiveStatus
}

interface LiveDirectiveState {
  queues: Map<string, LiveDirective[]>
  sealedRuns: Map<string, number>
  receipts: Map<string, LiveDirectiveReceipt>
}

interface DrainLiveDirectiveOptions {
  /**
   * Atomically close directive acceptance when no unclaimed directive exists.
   * This is used immediately before task completion so an instruction cannot be
   * accepted after the final drain and then discarded by terminal cleanup.
   */
  sealWhenEmpty?: boolean
}

interface ClearLiveDirectiveOptions {
  userId?: string
  runId?: string
  exceptRunId?: string
}

const stateKey = '__agentLiveDirectiveState' as const
const liveDirectiveState: LiveDirectiveState =
  (globalThis as unknown as Record<string, LiveDirectiveState>)[stateKey] ??
  ((globalThis as unknown as Record<string, LiveDirectiveState>)[stateKey] = {
    queues: new Map(),
    sealedRuns: new Map(),
    receipts: new Map(),
  })
if (!(liveDirectiveState.sealedRuns instanceof Map)) {
  const legacySeals = liveDirectiveState.sealedRuns as unknown as Set<string> | undefined
  liveDirectiveState.sealedRuns = new Map(
    legacySeals instanceof Set
      ? [...legacySeals].map((key) => [key, Date.now()] as const)
      : [],
  )
}
liveDirectiveState.receipts ??= new Map()

let liveDirectiveSchemaPromise: Promise<void> | null = null

async function addLiveDirectiveColumn(sql: string): Promise<void> {
  try {
    await tursoExecute(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate column|already exists/i.test(message)) return
    throw error
  }
}

export function normalizeLiveDirectiveContent(content: string): string {
  return clampTaskInput(content
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim())
}

export function liveDirectiveContinuationMessageId(directiveId: string): string {
  const digest = createHash('sha256')
    .update('agent-live-directive-continuation\u0000')
    .update(directiveId)
    .digest()
  // Use a deterministic RFC 4122-shaped UUID so retries address the same
  // continuation while the result remains valid wherever chat message ids are
  // schema-checked as UUIDs.
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function pruneMemoryLiveDirectiveSeals(now = Date.now()): void {
  for (const [key, sealedAt] of liveDirectiveState.sealedRuns) {
    if (now - sealedAt > LIVE_DIRECTIVE_RETENTION_MS) {
      liveDirectiveState.sealedRuns.delete(key)
    }
  }
}

function receiptFromRow(row: Record<string, unknown>): LiveDirectiveReceipt | null {
  const status = row.status
  const createdAt = Number(row.created_at_ms)
  if (
    typeof row.id !== 'string' ||
    typeof row.queue_name !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    typeof row.run_id !== 'string' ||
    typeof row.continuation_message_id !== 'string' ||
    typeof row.content !== 'string' ||
    (status !== 'accepted' && status !== 'delivered' && status !== 'rejected') ||
    !Number.isFinite(createdAt)
  ) {
    return null
  }
  const outcomeAt = Number(row.outcome_at_ms)
  return {
    id: row.id,
    queueName: row.queue_name,
    userId: row.user_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    continuationMessageId: row.continuation_message_id,
    content: row.content,
    status,
    createdAt,
    outcomeCode: typeof row.outcome_code === 'string' ? row.outcome_code : undefined,
    outcomeMessage: typeof row.outcome_message === 'string' ? row.outcome_message : undefined,
    outcomeAt: Number.isFinite(outcomeAt) ? outcomeAt : undefined,
  }
}

function directiveFromReceipt(receipt: LiveDirectiveReceipt): LiveDirective {
  return {
    id: receipt.id,
    queueName: receipt.queueName,
    userId: receipt.userId,
    conversationId: receipt.conversationId,
    runId: receipt.runId,
    continuationMessageId: receipt.continuationMessageId,
    content: receipt.content,
    createdAt: receipt.createdAt,
    status: receipt.status,
  }
}

function shouldUseDatabaseLiveDirectives(): boolean {
  return getTursoSetupStatus().configured
}

async function ensureLiveDirectiveSchema(): Promise<void> {
  if (!liveDirectiveSchemaPromise) {
    liveDirectiveSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists agent_live_directives (
          id text primary key,
          queue_name text not null,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          content text not null,
          created_at_ms integer not null,
          claimed_attempt integer,
          claimed_at_ms integer
        )
      `)
      await addLiveDirectiveColumn('alter table agent_live_directives add column claimed_attempt integer')
      await addLiveDirectiveColumn('alter table agent_live_directives add column claimed_at_ms integer')
      await tursoExecute(`
        create index if not exists agent_live_directives_scope_idx
        on agent_live_directives(queue_name, user_id, conversation_id, run_id, created_at_ms)
      `)
      await tursoExecute('create index if not exists agent_live_directives_created_idx on agent_live_directives(created_at_ms)')
      await tursoExecute(`
        create table if not exists agent_live_directive_seals (
          queue_name text not null,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          sealed_at_ms integer not null,
          sealed_attempt integer not null default 1,
          primary key (queue_name, user_id, conversation_id, run_id)
        )
      `)
      await addLiveDirectiveColumn('alter table agent_live_directive_seals add column sealed_attempt integer not null default 1')
      await tursoExecute('create index if not exists agent_live_directive_seals_created_idx on agent_live_directive_seals(sealed_at_ms)')
      await tursoExecute(`
        create table if not exists agent_live_directive_receipts (
          id text primary key,
          queue_name text not null,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          continuation_message_id text not null,
          content text not null,
          status text not null,
          outcome_code text,
          outcome_message text,
          created_at_ms integer not null,
          outcome_at_ms integer
        )
      `)
      await tursoExecute(`
        create index if not exists agent_live_directive_receipts_scope_idx
        on agent_live_directive_receipts(queue_name, user_id, conversation_id, run_id, created_at_ms)
      `)
      await tursoExecute('create index if not exists agent_live_directive_receipts_created_idx on agent_live_directive_receipts(created_at_ms)')
    })().catch((error) => {
      liveDirectiveSchemaPromise = null
      throw error
    })
  }
  return liveDirectiveSchemaPromise
}

function isMissingLiveDirectiveSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|schema/i.test(message)
}

async function withLiveDirectiveSchemaRepair<T>(operation: () => Promise<T>): Promise<T> {
  try {
    await ensureLiveDirectiveSchema()
    return await operation()
  } catch (error) {
    if (!isMissingLiveDirectiveSchemaError(error)) throw error
    liveDirectiveSchemaPromise = null
    await ensureLiveDirectiveSchema()
    return operation()
  }
}

function directiveMatchesScope(
  directive: LiveDirective,
  userId?: string,
  runId?: string,
): boolean {
  if (userId !== undefined && directive.userId !== userId) return false
  if (runId !== undefined && directive.runId !== runId) return false
  return true
}

function memoryQueueLength(conversationId: string, userId?: string, runId?: string): number {
  return (liveDirectiveState.queues.get(conversationId) || [])
    .filter((directive) => directiveMatchesScope(directive, userId, runId))
    .length
}

function liveDirectiveRunKey(conversationId: string, userId?: string, runId?: string): string | null {
  if (!userId || !runId) return null
  return `${taskQueueName()}\u0000${userId}\u0000${conversationId}\u0000${runId}`
}

export async function getLiveDirectiveReceipt(
  directiveId: string,
  userId: string,
  conversationId: string,
): Promise<LiveDirectiveReceipt | null> {
  if (shouldUseDatabaseLiveDirectives()) {
    return withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const result = await transaction.execute({
        sql: `
          select id, queue_name, user_id, conversation_id, run_id,
                 continuation_message_id, content, status, outcome_code,
                 outcome_message, created_at_ms, outcome_at_ms
          from agent_live_directive_receipts
          where id = ? and user_id = ? and conversation_id = ?
          limit 1
        `,
        args: [directiveId, userId, conversationId],
      })
      const row = result.rows[0]
      const receipt = row ? receiptFromRow(row as Record<string, unknown>) : null
      if (!receipt || receipt.status !== 'accepted') return receipt

      const activeJob = await transaction.execute({
        sql: `
          select 1 as active
          from agent_task_jobs
          where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
            and status in ('queued', 'running')
            and terminal_status is null
            and cancel_requested = 0
          limit 1
        `,
        args: [receipt.runId, receipt.queueName, receipt.userId, receipt.conversationId],
      })
      if (activeJob.rows[0]) return receipt

      // Terminal cleanup is best effort at several call sites. Reconcile an
      // accepted-but-undeliverable receipt on lookup so a transient cleanup
      // failure cannot leave the user with an eternal "accepted" outcome.
      await rejectPendingDatabaseDirectives(transaction, {
        queueName: receipt.queueName,
        userId: receipt.userId,
        conversationId: receipt.conversationId,
        runId: receipt.runId,
      })
      const rejectedAt = Date.now()
      const directlyRejected = await transaction.execute({
        sql: `
          update agent_live_directive_receipts
          set status = 'rejected', outcome_code = ?, outcome_message = ?, outcome_at_ms = ?
          where id = ? and status = 'accepted'
        `,
        args: [
          LIVE_DIRECTIVE_REJECTED_CODE,
          LIVE_DIRECTIVE_REJECTED_MESSAGE,
          rejectedAt,
          receipt.id,
        ],
      })
      if (directlyRejected.rowsAffected === 1) {
        await persistRejectedLiveDirectiveOutcomeInConversation(
          transaction,
          receipt.userId,
          receipt.conversationId,
          receipt.id,
          receipt.continuationMessageId,
          rejectedAt,
        )
      }
      const reconciled = await transaction.execute({
        sql: `
          select id, queue_name, user_id, conversation_id, run_id,
                 continuation_message_id, content, status, outcome_code,
                 outcome_message, created_at_ms, outcome_at_ms
          from agent_live_directive_receipts
          where id = ? and user_id = ? and conversation_id = ?
          limit 1
        `,
        args: [directiveId, userId, conversationId],
      })
      const reconciledRow = reconciled.rows[0]
      return reconciledRow ? receiptFromRow(reconciledRow as Record<string, unknown>) : null
    }))
  }
  const receipt = liveDirectiveState.receipts.get(directiveId)
  return receipt?.userId === userId && receipt.conversationId === conversationId ? receipt : null
}

async function rejectPendingDatabaseDirectives(
  transaction: Transaction,
  scope: {
    queueName: string
    userId: string
    conversationId?: string
    runId?: string
    exceptRunId?: string
    workerAttempt?: number
  },
): Promise<void> {
  const conditions = ['d.queue_name = ?', 'd.user_id = ?']
  const args: Array<string | number> = [scope.queueName, scope.userId]
  if (scope.conversationId) {
    conditions.push('d.conversation_id = ?')
    args.push(scope.conversationId)
  }
  if (scope.runId) {
    conditions.push('d.run_id = ?')
    args.push(scope.runId)
  }
  if (scope.exceptRunId) {
    conditions.push('d.run_id != ?')
    args.push(scope.exceptRunId)
  }
  if (scope.workerAttempt) {
    conditions.push('(d.claimed_attempt is null or d.claimed_attempt < ?)')
    args.push(scope.workerAttempt)
  } else {
    conditions.push('d.claimed_attempt is null')
  }

  const selected = await transaction.execute({
    sql: `
      select d.id, d.conversation_id, r.continuation_message_id
      from agent_live_directives d
      left join agent_live_directive_receipts r on r.id = d.id
      where ${conditions.join(' and ')}
    `,
    args,
  })
  const rejectedAt = Date.now()
  const rejected = selected.rows.flatMap((row) => (
    typeof row.id === 'string' && typeof row.conversation_id === 'string'
      ? [{
          id: row.id,
          conversationId: row.conversation_id,
          continuationMessageId: typeof row.continuation_message_id === 'string'
            ? row.continuation_message_id
            : liveDirectiveContinuationMessageId(row.id),
        }]
      : []
  ))
  if (rejected.length === 0) return

  const ids = rejected.map((entry) => entry.id)
  await transaction.execute({
    sql: `
      update agent_live_directive_receipts
      set status = 'rejected', outcome_code = ?, outcome_message = ?, outcome_at_ms = ?
      where status = 'accepted' and id in (${ids.map(() => '?').join(', ')})
    `,
    args: [LIVE_DIRECTIVE_REJECTED_CODE, LIVE_DIRECTIVE_REJECTED_MESSAGE, rejectedAt, ...ids],
  })
  await transaction.execute({
    sql: `delete from agent_live_directives where id in (${ids.map(() => '?').join(', ')})`,
    args: ids,
  })
  for (const entry of rejected) {
    await persistRejectedLiveDirectiveOutcomeInConversation(
      transaction,
      scope.userId,
      entry.conversationId,
      entry.id,
      entry.continuationMessageId,
      rejectedAt,
    )
  }
}

function rejectPendingMemoryDirectives(
  predicate: (directive: LiveDirective) => boolean,
): void {
  const rejectedAt = Date.now()
  for (const [conversationId, queue] of liveDirectiveState.queues) {
    const remaining: LiveDirective[] = []
    for (const directive of queue) {
      if (!predicate(directive)) {
        remaining.push(directive)
        continue
      }
      const receipt = liveDirectiveState.receipts.get(directive.id)
      if (receipt?.status === 'accepted') {
        liveDirectiveState.receipts.set(directive.id, {
          ...receipt,
          status: 'rejected',
          outcomeCode: LIVE_DIRECTIVE_REJECTED_CODE,
          outcomeMessage: LIVE_DIRECTIVE_REJECTED_MESSAGE,
          outcomeAt: rejectedAt,
        })
      }
    }
    if (remaining.length > 0) liveDirectiveState.queues.set(conversationId, remaining)
    else liveDirectiveState.queues.delete(conversationId)
  }
}

export async function openLiveDirectiveRun(
  conversationId: string,
  userId?: string,
  runId?: string,
  workerAttempt = 1,
): Promise<void> {
  if (!userId || !runId) return
  const queueName = taskQueueName()
  const normalizedAttempt = Number.isFinite(Number(workerAttempt))
    ? Math.max(1, Math.floor(Number(workerAttempt)))
    : 1
  if (shouldUseDatabaseLiveDirectives()) {
    await withLiveDirectiveSchemaRepair(() => tursoExecute(
      `
        delete from agent_live_directive_seals
        where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
          and sealed_attempt <= ?
          and exists (
            select 1 from agent_task_jobs
            where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
              and (attempts = ? or (attempts = 0 and worker_id is null and ? = 1))
          )
      `,
      [
        queueName,
        userId,
        conversationId,
        runId,
        normalizedAttempt,
        runId,
        queueName,
        userId,
        conversationId,
        normalizedAttempt,
        normalizedAttempt,
      ],
    ))
    return
  }
  const key = liveDirectiveRunKey(conversationId, userId, runId)
  pruneMemoryLiveDirectiveSeals()
  if (key) liveDirectiveState.sealedRuns.delete(key)
}

export async function sealLiveDirectiveRun(
  conversationId: string,
  userId?: string,
  runId?: string,
  workerAttempt = 1,
): Promise<boolean> {
  if (!userId || !runId) return false
  const queueName = taskQueueName()
  const normalizedAttempt = Number.isFinite(Number(workerAttempt))
    ? Math.max(1, Math.floor(Number(workerAttempt)))
    : 1
  if (shouldUseDatabaseLiveDirectives()) {
    return withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const ownership = await transaction.execute({
        sql: `
          select 1 as owned
          from agent_task_jobs
          where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
            and terminal_status is null and cancel_requested = 0
            and (
              (status = 'running' and attempts = ?)
              or (status in ('queued', 'running') and attempts = 0 and worker_id is null and ? = 1)
            )
          limit 1
        `,
        args: [runId, queueName, userId, conversationId, normalizedAttempt, normalizedAttempt],
      })
      if (!ownership.rows[0]) return false
      await transaction.execute({
        sql: `
          insert into agent_live_directive_seals (
            queue_name, user_id, conversation_id, run_id, sealed_at_ms, sealed_attempt
          ) values (?, ?, ?, ?, ?, ?)
          on conflict(queue_name, user_id, conversation_id, run_id)
          do update set
            sealed_at_ms = excluded.sealed_at_ms,
            sealed_attempt = excluded.sealed_attempt
        `,
        args: [queueName, userId, conversationId, runId, Date.now(), normalizedAttempt],
      })
      await rejectPendingDatabaseDirectives(transaction, {
        queueName,
        userId,
        conversationId,
        runId,
        workerAttempt: normalizedAttempt,
      })
      return true
    }))
  }
  const key = liveDirectiveRunKey(conversationId, userId, runId)
  pruneMemoryLiveDirectiveSeals()
  if (key) liveDirectiveState.sealedRuns.set(key, Date.now())
  rejectPendingMemoryDirectives((directive) => (
    directive.conversationId === conversationId &&
    directive.userId === userId &&
    directive.runId === runId &&
    directive.claimedAttempt === undefined
  ))
  return true
}

export async function enqueueLiveDirective(
  conversationId: string,
  content: string,
  userId?: string,
  runId?: string,
  clientDirectiveId?: string,
): Promise<LiveDirective> {
  const normalized = normalizeLiveDirectiveContent(content)
  if (!normalized) {
    throw new Error('Live directive cannot be empty.')
  }

  const queueName = taskQueueName()
  const directiveId = clientDirectiveId || randomUUID()
  const continuationMessageId = liveDirectiveContinuationMessageId(directiveId)
  const directive: LiveDirective = {
    id: directiveId,
    conversationId,
    content: normalized,
    createdAt: Date.now(),
    userId,
    runId,
    queueName,
    continuationMessageId,
    status: 'accepted',
  }

  if (shouldUseDatabaseLiveDirectives()) {
    if (!userId || !runId) {
      throw new Error('Durable live directives require a user id and run id.')
    }
    // Schema DDL must finish before the atomic acceptance transaction begins.
    await ensureConversationSchema()
    return withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      await transaction.execute({
        sql: `
          delete from agent_live_directive_receipts
          where created_at_ms < ?
            and not exists (
              select 1 from agent_live_directives where agent_live_directives.id = agent_live_directive_receipts.id
            )
        `,
        args: [directive.createdAt - LIVE_DIRECTIVE_RETENTION_MS],
      })

      const existingResult = await transaction.execute({
        sql: `
          select id, queue_name, user_id, conversation_id, run_id,
                 continuation_message_id, content, status, outcome_code,
                 outcome_message, created_at_ms, outcome_at_ms
          from agent_live_directive_receipts
          where id = ?
          limit 1
        `,
        args: [directiveId],
      })
      const existingReceipt = existingResult.rows[0]
        ? receiptFromRow(existingResult.rows[0] as Record<string, unknown>)
        : null
      if (existingReceipt) {
        if (
          existingReceipt.queueName !== queueName ||
          existingReceipt.userId !== userId ||
          existingReceipt.conversationId !== conversationId ||
          existingReceipt.runId !== runId ||
          existingReceipt.content !== normalized
        ) {
          throw new LiveDirectiveIdConflictError()
        }
        return directiveFromReceipt(existingReceipt)
      }

      const activeJob = await transaction.execute({
        sql: `
          select case when attempts < 1 then 1 else attempts end as current_attempt
          from agent_task_jobs
          where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
            and status in ('queued', 'running')
            and terminal_status is null
            and cancel_requested = 0
          limit 1
        `,
        args: [runId, queueName, userId, conversationId],
      })
      const currentAttempt = Number(activeJob.rows[0]?.current_attempt)
      if (!Number.isFinite(currentAttempt) || currentAttempt < 1) {
        throw new LiveDirectiveTargetInactiveError()
      }

      const seal = await transaction.execute({
        sql: `
          select 1 as sealed
          from agent_live_directive_seals
          where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
            and sealed_attempt >= ?
          limit 1
        `,
        args: [queueName, userId, conversationId, runId, currentAttempt],
      })
      if (seal.rows[0]) throw new LiveDirectiveTargetInactiveError()

      const pendingCountResult = await transaction.execute({
        sql: `
          select count(*) as count
          from agent_live_directives
          where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
            and (claimed_attempt is null or claimed_attempt < ?)
        `,
        args: [queueName, userId, conversationId, runId, currentAttempt],
      })
      if (Number(pendingCountResult.rows[0]?.count) >= MAX_QUEUED_LIVE_DIRECTIVES) {
        throw new LiveDirectiveQueueFullError()
      }

      await transaction.execute({
        sql: `
          insert into agent_live_directive_receipts (
            id, queue_name, user_id, conversation_id, run_id,
            continuation_message_id, content, status, created_at_ms
          ) values (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
        `,
        args: [
          directiveId,
          queueName,
          userId,
          conversationId,
          runId,
          continuationMessageId,
          normalized,
          directive.createdAt,
        ],
      })
      await transaction.execute({
        sql: `
          insert into agent_live_directives (
            id, queue_name, user_id, conversation_id, run_id, content, created_at_ms
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
        args: [directiveId, queueName, userId, conversationId, runId, normalized, directive.createdAt],
      })
      await persistAcceptedLiveDirectiveInConversation(transaction, userId, conversationId, {
        directiveId,
        continuationMessageId,
        content: normalized,
        createdAt: directive.createdAt,
      })
      return directive
    }))
  }

  const existingReceipt = liveDirectiveState.receipts.get(directiveId)
  if (existingReceipt) {
    if (
      existingReceipt.queueName !== queueName ||
      existingReceipt.userId !== userId ||
      existingReceipt.conversationId !== conversationId ||
      existingReceipt.runId !== runId ||
      existingReceipt.content !== normalized
    ) {
      throw new LiveDirectiveIdConflictError()
    }
    return directiveFromReceipt(existingReceipt)
  }
  pruneMemoryLiveDirectiveSeals()
  const runKey = liveDirectiveRunKey(conversationId, userId, runId)
  if (runKey && liveDirectiveState.sealedRuns.has(runKey)) {
    throw new LiveDirectiveTargetInactiveError()
  }
  const existing = liveDirectiveState.queues.get(conversationId) ?? []
  const sameScope = existing.filter((entry) => directiveMatchesScope(entry, userId, runId))
  if (sameScope.length >= MAX_QUEUED_LIVE_DIRECTIVES) {
    throw new LiveDirectiveQueueFullError()
  }
  liveDirectiveState.queues.set(
    conversationId,
    [...existing, directive],
  )
  if (userId && runId) {
    liveDirectiveState.receipts.set(directiveId, {
      id: directiveId,
      queueName,
      userId,
      conversationId,
      runId,
      continuationMessageId,
      content: normalized,
      createdAt: directive.createdAt,
      status: 'accepted',
    })
  }
  return directive
}

export async function drainLiveDirectives(
  conversationId: string,
  userId?: string,
  runId?: string,
  workerAttempt?: number,
  options: DrainLiveDirectiveOptions = {},
): Promise<LiveDirective[]> {
  if (shouldUseDatabaseLiveDirectives()) {
    const normalizedAttempt = Math.floor(Number(workerAttempt ?? 1))
    if (!userId || !runId || !Number.isFinite(normalizedAttempt) || normalizedAttempt < 1) return []
    const queueName = taskQueueName()
    return withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      const ownership = await transaction.execute({
        sql: `
          select 1 as owned
          from agent_task_jobs
          where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
            and terminal_status is null and cancel_requested = 0
            and (
              (status = 'running' and attempts = ?)
              or (status in ('queued', 'running') and attempts = 0 and worker_id is null and ? = 1)
            )
          limit 1
        `,
        args: [runId, queueName, userId, conversationId, normalizedAttempt, normalizedAttempt],
      })
      if (!ownership.rows[0]) return []

      const selected = await transaction.execute({
        sql: `
          select id, queue_name, user_id, conversation_id, run_id, content, created_at_ms
          from agent_live_directives
          where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
            and (claimed_attempt is null or claimed_attempt < ?)
          order by created_at_ms asc, id asc
          limit ?
        `,
        args: [queueName, userId, conversationId, runId, normalizedAttempt, MAX_QUEUED_LIVE_DIRECTIVES],
      })
      const directives = selected.rows.flatMap((row): LiveDirective[] => {
        const createdAt = Number(row.created_at_ms)
        if (
          typeof row.id !== 'string' ||
          typeof row.content !== 'string' ||
          !Number.isFinite(createdAt)
        ) {
          return []
        }
        return [{
          id: row.id,
          queueName,
          userId,
          conversationId,
          runId,
          content: row.content,
          createdAt,
          claimedAttempt: normalizedAttempt,
        }]
      })
      if (directives.length === 0) {
        if (options.sealWhenEmpty) {
          await transaction.execute({
            sql: `
              insert into agent_live_directive_seals (
                queue_name, user_id, conversation_id, run_id, sealed_at_ms, sealed_attempt
              ) values (?, ?, ?, ?, ?, ?)
              on conflict(queue_name, user_id, conversation_id, run_id)
              do update set
                sealed_at_ms = excluded.sealed_at_ms,
                sealed_attempt = excluded.sealed_attempt
            `,
            args: [queueName, userId, conversationId, runId, Date.now(), normalizedAttempt],
          })
        }
        return []
      }

      const ids = directives.map((directive) => directive.id)
      const claimed = await transaction.execute({
        sql: `
          update agent_live_directives
          set claimed_attempt = ?, claimed_at_ms = ?
          where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
            and (claimed_attempt is null or claimed_attempt < ?)
            and id in (${ids.map(() => '?').join(', ')})
        `,
        args: [normalizedAttempt, Date.now(), queueName, userId, conversationId, runId, normalizedAttempt, ...ids],
      })
      if (claimed.rowsAffected !== directives.length) {
        throw new Error('Live directive claim lost its atomic scope.')
      }
      await transaction.execute({
        sql: `
          update agent_live_directive_receipts
          set status = 'delivered', outcome_code = 'DELIVERED_TO_AGENT',
              outcome_message = 'The live instruction was delivered to the running task.',
              outcome_at_ms = ?
          where id in (${ids.map(() => '?').join(', ')}) and status = 'accepted'
        `,
        args: [Date.now(), ...ids],
      })
      return directives
    }))
  }

  const queue = liveDirectiveState.queues.get(conversationId)
  if (!queue?.length) {
    if (options.sealWhenEmpty) {
      const runKey = liveDirectiveRunKey(conversationId, userId, runId)
      pruneMemoryLiveDirectiveSeals()
      if (runKey) liveDirectiveState.sealedRuns.set(runKey, Date.now())
    }
    return []
  }

  const drained: LiveDirective[] = []
  const remaining: LiveDirective[] = []
  for (const directive of queue) {
    if (directiveMatchesScope(directive, userId, runId)) {
      const delivered = { ...directive, claimedAttempt: workerAttempt ?? 1, status: 'delivered' as const }
      drained.push(delivered)
      const receipt = liveDirectiveState.receipts.get(directive.id)
      if (receipt?.status === 'accepted') {
        liveDirectiveState.receipts.set(directive.id, {
          ...receipt,
          status: 'delivered',
          outcomeCode: 'DELIVERED_TO_AGENT',
          outcomeMessage: 'The live instruction was delivered to the running task.',
          outcomeAt: Date.now(),
        })
      }
    } else {
      remaining.push(directive)
    }
  }

  if (remaining.length > 0) {
    liveDirectiveState.queues.set(conversationId, remaining)
  } else {
    liveDirectiveState.queues.delete(conversationId)
  }

  if (drained.length === 0 && options.sealWhenEmpty) {
    const runKey = liveDirectiveRunKey(conversationId, userId, runId)
    pruneMemoryLiveDirectiveSeals()
    if (runKey) liveDirectiveState.sealedRuns.set(runKey, Date.now())
  }

  return drained
}

export async function getLiveDirectiveQueueLength(
  conversationId: string,
  userId?: string,
  runId?: string,
): Promise<number> {
  if (shouldUseDatabaseLiveDirectives()) {
    if (!userId || !runId) return 0
    const queueName = taskQueueName()
    const result = await withLiveDirectiveSchemaRepair(() => tursoExecute(
      `
        select count(*) as count
        from agent_live_directives
        where queue_name = ? and user_id = ? and conversation_id = ? and run_id = ?
          and (
            claimed_attempt is null
            or claimed_attempt < coalesce((
              select case when attempts < 1 then 1 else attempts end
              from agent_task_jobs
              where run_id = ? and queue_name = ? and user_id = ? and conversation_id = ?
              limit 1
            ), 1)
          )
      `,
      [queueName, userId, conversationId, runId, runId, queueName, userId, conversationId],
    ))
    const count = Number(result.rows[0]?.count)
    return Number.isFinite(count) ? Math.max(0, count) : 0
  }
  return memoryQueueLength(conversationId, userId, runId)
}

export async function clearLiveDirectives(
  conversationId?: string,
  options: ClearLiveDirectiveOptions = {},
): Promise<void> {
  if (!conversationId) {
    liveDirectiveState.queues.clear()
    liveDirectiveState.sealedRuns.clear()
    liveDirectiveState.receipts.clear()
    return
  }

  const { userId, runId, exceptRunId } = options
  if (shouldUseDatabaseLiveDirectives()) {
    if (!userId) return
    const queueName = taskQueueName()
    const conditions = ['queue_name = ?', 'user_id = ?', 'conversation_id = ?']
    const args: Array<string> = [queueName, userId, conversationId]
    if (runId) {
      conditions.push('run_id = ?')
      args.push(runId)
    }
    if (exceptRunId) {
      conditions.push('run_id != ?')
      args.push(exceptRunId)
    }
    await withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      await rejectPendingDatabaseDirectives(transaction, {
        queueName,
        userId,
        conversationId,
        runId,
        exceptRunId,
      })
      await transaction.execute({
        sql: `delete from agent_live_directives where ${conditions.join(' and ')}`,
        args,
      })
    }))
    return
  }

  const queue = liveDirectiveState.queues.get(conversationId)
  if (!queue?.length) return
  rejectPendingMemoryDirectives((directive) => (
    directive.conversationId === conversationId &&
    (userId === undefined || directive.userId === userId) &&
    (runId === undefined || directive.runId === runId) &&
    (exceptRunId === undefined || directive.runId !== exceptRunId)
  ))
  const currentQueue = liveDirectiveState.queues.get(conversationId)
  if (!currentQueue?.length) return
  const remaining = currentQueue.filter((directive) => {
    if (userId !== undefined && directive.userId !== userId) return true
    if (runId !== undefined && directive.runId !== runId) return true
    if (exceptRunId !== undefined && directive.runId === exceptRunId) return true
    return false
  })
  if (remaining.length > 0) liveDirectiveState.queues.set(conversationId, remaining)
  else liveDirectiveState.queues.delete(conversationId)
}

export async function clearLiveDirectivesForRun(userId: string, runId: string): Promise<void> {
  if (!userId || !runId) return
  if (shouldUseDatabaseLiveDirectives()) {
    const queueName = taskQueueName()
    await withLiveDirectiveSchemaRepair(() => tursoTransaction('write', async (transaction) => {
      await rejectPendingDatabaseDirectives(transaction, {
        queueName,
        userId,
        runId,
      })
      await transaction.execute({
        sql: 'delete from agent_live_directives where queue_name = ? and user_id = ? and run_id = ?',
        args: [queueName, userId, runId],
      })
      await transaction.execute({
        sql: 'delete from agent_live_directive_seals where queue_name = ? and user_id = ? and run_id = ?',
        args: [queueName, userId, runId],
      })
    }))
    return
  }

  rejectPendingMemoryDirectives((directive) => (
    directive.userId === userId && directive.runId === runId
  ))
  for (const [conversationId, queue] of liveDirectiveState.queues) {
    const remaining = queue.filter((directive) => directive.userId !== userId || directive.runId !== runId)
    if (remaining.length > 0) liveDirectiveState.queues.set(conversationId, remaining)
    else liveDirectiveState.queues.delete(conversationId)
  }
  // Keep the terminal seal. Without a database, the route's active-task check
  // and this cleanup are not one transaction; removing the seal lets an
  // instruction accepted in that gap disappear forever. openLiveDirectiveRun
  // clears the seal only when the exact run is deliberately reopened.
}

export const clearLiveDirectivesForTest = clearLiveDirectives
