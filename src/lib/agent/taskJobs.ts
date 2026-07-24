import { randomUUID } from 'crypto'
import type {
  Artifact,
  BrowseResult,
  BrowserResult,
  FileResult,
  SearchResult,
  SSEEvent,
  StepAdvanceStatus,
  TerminalResult,
} from '@/types'
import type { ProgressUpdatePlacement, ToolStartMetadata } from '@/types/events'
import type { CreditLedgerEvent, CreditTokenUsage } from '@/lib/creditPolicy'
import { getTursoSetupStatus, tursoExecute, tursoExecuteIsolated, tursoTransaction } from '@/lib/db/turso'
import { encodeSSE } from '@/lib/stream'
import { userErrorMessage } from '@/lib/errorMessages'
import { releaseActiveTaskLease } from '@/lib/activeTasks'
import { clearLiveDirectivesForRun } from '@/lib/liveDirectives'
import { destroySandbox } from '@/lib/sandbox'
import type { TaskStartConversationInsert } from '@/lib/conversations'
import { ensureTaskWorkerHeartbeatSchema } from './taskWorkerHeartbeat'
import { TASK_ORCHESTRATION_PROTOCOL_VERSION, taskQueueName } from './taskQueue'
import type { AgentEventEmitter } from './SSEEmitter'
import type { InflightToolDrain } from './toolSafety'
import type { BackgroundProbeTaskPayload, ChatTaskPayload, TaskJobPayload } from './chatTaskRunner'
import { isNonIdempotentToolCall } from './toolSafety'
import { drainOrderedEventBatches, utf8ByteWeight } from './TaskEventPersistenceBatch'

export type TaskJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type TaskCancellationResult =
  | { ok: false; status: 'missing'; terminal: false }
  | { ok: true; status: 'stopping'; terminal: false }
  | { ok: true; status: 'done' | 'error' | 'cancelled'; terminal: true }

export interface RecordedTaskEvent {
  seq: number
  event: SSEEvent
  createdAt: number
}

interface RecordedTaskFrame {
  version: number
  event: SSEEvent
  createdAt: number
}

interface TaskJobSubscriber {
  id: string
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  closed: boolean
  keepAliveTimer: ReturnType<typeof setInterval> | null
}

interface TaskJob {
  runId: string
  userId: string
  conversationId: string
  queueName: string
  status: TaskJobStatus
  startedAt: number
  updatedAt: number
  completedAt: number | null
  terminalStatus: 'done' | 'error' | null
  terminalError: string | null
  terminalRecord: RecordedTaskEvent | null
  terminalCommitted: boolean
  closeRequested: boolean
  cancelRequested: boolean
  acceptsLiveDirectives: boolean
  closed: boolean
  nextSeq: number
  nextBrowserFrameVersion: number
  latestBrowserFrame: SSEEvent | null
  events: RecordedTaskEvent[]
  subscribers: Map<string, TaskJobSubscriber>
  abortController: AbortController
  emitter: TaskJobEmitter | null
  promise: Promise<void> | null
  persistChain: Promise<void>
  persistenceFailure: unknown | null
  pendingEventPersistence: RecordedTaskEvent[]
  eventPersistenceQueued: boolean
  pendingTextPersistence: RecordedTaskEvent[]
  pendingTextPersistenceChars: number
  pendingTextPersistenceTimer: ReturnType<typeof setTimeout> | null
  pendingBrowserFramePersistence: RecordedTaskFrame | null
  pendingBrowserFramePersistenceTimer: ReturnType<typeof setTimeout> | null
  terminalCleanupTimer: ReturnType<typeof setTimeout> | null
  requeueRequested: boolean
  requeueReason: 'shutdown' | 'lease_lost' | null
  claimWorkerId: string | null
  claimAttempts: number | null
  inflightToolDrain: InflightToolDrain | null
}

export interface ClaimedTaskJob {
  runId: string
  userId: string
  conversationId: string
  queueName: string
  payload: TaskJobPayload
  workerId: string
  startedAt: number
  attempts: number
  nextSeq?: number
  nextBrowserFrameVersion?: number
}

interface StaleTaskTerminalFence {
  staleTerminalFence: true
  runId: string
  userId: string
  conversationId: string
  expectedStatus: 'queued' | 'running'
  expectedAttempts: number
  terminalStatus: 'done' | 'error'
  terminalError: string | null
  terminalEventPersisted: boolean
}

export interface ActiveTaskJobSummary {
  runId: string
  userId: string
  conversationId: string
  queueName: string
  status: TaskJobStatus
  startedAt: number
  updatedAt: number
  attempts: number
  terminalStatus?: 'done' | 'error' | null
  terminalError?: string | null
  acceptsLiveDirectives: boolean
  cancelRequested: boolean
}

export class TaskConversationConflictError extends Error {
  readonly code = 'CONVERSATION_TASK_ALREADY_ACTIVE'

  constructor(
    readonly existingRunId: string,
    readonly existingStatus: TaskJobStatus,
  ) {
    super('This task is already running. Send direction to the active task or stop it first.')
    this.name = 'TaskConversationConflictError'
  }
}

export class TaskConversationPersistenceConflictError extends Error {
  readonly code = 'CONVERSATION_HISTORY_CHANGED'

  constructor() {
    super('This task changed while it was starting. Refresh it and try again.')
    this.name = 'TaskConversationPersistenceConflictError'
  }
}

export class TaskPreStartCancelledError extends Error {
  readonly code = 'TASK_START_CANCELLED'

  constructor(
    readonly runId: string,
    readonly conversationId: string,
  ) {
    super('This task was stopped before it started.')
    this.name = 'TaskPreStartCancelledError'
  }
}

const TASK_JOB_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024

export class TaskJobPayloadTooLargeError extends Error {
  readonly code = 'TASK_PAYLOAD_TOO_LARGE'

  constructor(
    readonly actualBytes: number,
    readonly maxBytes = TASK_JOB_PAYLOAD_MAX_BYTES,
  ) {
    super(`Task payload is too large to queue (${actualBytes} bytes; maximum ${maxBytes} bytes).`)
    this.name = 'TaskJobPayloadTooLargeError'
  }
}

function serializeTaskJobPayload(payload: TaskJobPayload): string {
  const serialized = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(serialized).byteLength
  if (bytes > TASK_JOB_PAYLOAD_MAX_BYTES) {
    throw new TaskJobPayloadTooLargeError(bytes)
  }
  return serialized
}

class TaskJobClaimLostError extends Error {
  constructor(readonly runId: string) {
    super(`Task job claim was lost for run ${runId}.`)
    this.name = 'TaskJobClaimLostError'
  }
}

interface TaskJobState {
  jobs: Map<string, TaskJob>
}

interface PersistedJobSnapshot {
  runId: string
  userId: string
  conversationId: string
  status: TaskJobStatus
  terminalStatus: 'done' | 'error' | null
  terminalError: string | null
  events: RecordedTaskEvent[]
}

interface PersistedJobStatus {
  status: TaskJobStatus
  terminalStatus: 'done' | 'error' | null
  terminalError: string | null
}

type TaskJobRow = {
  run_id?: unknown
  user_id?: unknown
  conversation_id?: unknown
  queue_name?: unknown
  status?: unknown
  terminal_status?: unknown
  terminal_error?: unknown
  started_at_ms?: unknown
  updated_at_ms?: unknown
  attempts?: unknown
  payload_json?: unknown
  accepts_live_directives?: unknown
  cancel_requested?: unknown
}

const taskJobStateKey = '__agentTaskJobState' as const
const taskJobState: TaskJobState =
  (globalThis as unknown as Record<string, TaskJobState>)[taskJobStateKey] ??
  ((globalThis as unknown as Record<string, TaskJobState>)[taskJobStateKey] = {
    jobs: new Map(),
  })

interface PreStartCancellationTombstone {
  expiresAt: number
}

const preStartCancellationStateKey = '__agentPreStartCancellationState' as const
const preStartCancellationState: Map<string, PreStartCancellationTombstone> =
  (globalThis as unknown as Record<string, Map<string, PreStartCancellationTombstone>>)[preStartCancellationStateKey] ??
  ((globalThis as unknown as Record<string, Map<string, PreStartCancellationTombstone>>)[preStartCancellationStateKey] = new Map())

const TASK_JOB_EVENT_PERSIST_LIMIT_BYTES = 256 * 1024
const TASK_JOB_BROWSER_FRAME_PERSIST_LIMIT_BYTES = 2 * 1024 * 1024
const TASK_JOB_TEXT_FIELD_PERSIST_LIMIT_CHARS = 64 * 1024
const TASK_JOB_INLINE_IMAGE_PLACEHOLDER = '[inline image omitted from persisted task replay]'
const TASK_JOB_TRUNCATED_OBJECT_PLACEHOLDER = '[nested value omitted from persisted task replay]'
const TASK_JOB_OBJECT_FIELD_LIMIT = 160
const TASK_JOB_ARRAY_ITEM_LIMIT = 80
const TASK_JOB_OBJECT_DEPTH_LIMIT = 8
const TASK_JOB_MEMORY_EVENT_LIMIT = 10_000
const TASK_JOB_KEEP_ALIVE_MS = 15_000
const TASK_JOB_DB_POLL_MS = 100
const TASK_JOB_REPLAY_PAGE_SIZE = 500
const TASK_JOB_STATUS_POLL_MS = 2_000
const TASK_JOB_WORKER_LEASE_MS = 60_000
const TASK_JOB_WORKER_REFRESH_MS = 15_000
const TASK_JOB_WORKER_STALE_MS = 60_000
// Cancellation remains responsive without continuously occupying the remote
// database connection. The next check is scheduled after the prior read
// settles, so a slow control-plane response cannot create a near-zero-gap poll
// loop that starves lease renewal and event persistence.
const TASK_JOB_CANCEL_POLL_MS = 750
const TASK_JOB_CANCEL_ACK_TIMEOUT_MS = 3_000
const TASK_JOB_CANCEL_ACK_POLL_MS = 50
const TASK_JOB_CANCEL_EXECUTION_GRACE_MS = 5_000
export const TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS = 30_000
export const TASK_WORKER_CANCEL_PROOF_JITTER_MS = 5_000
const TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS = 5_000
const TASK_JOB_WORKER_MAX_ATTEMPTS = 3
const TASK_JOB_TEXT_PERSIST_DEBOUNCE_MS = 200
// The E2B worker receives push-based CDP screencast frames. Coalesce only the
// cross-process database relay to roughly 4fps so the production Computer
// panel remains visibly live without turning every source frame into a write.
const TASK_JOB_BROWSER_FRAME_PERSIST_INTERVAL_MS = 250
const TASK_JOB_TEXT_PERSIST_CHUNK_CHARS = 4_096
const TASK_JOB_DELTA_PERSIST_BATCH_LIMIT = 64
const TASK_JOB_EVENT_PERSIST_BATCH_LIMIT = 64
const TASK_JOB_EVENT_PERSIST_BATCH_BYTES = 512 * 1024
const TASK_JOB_PERSIST_RETRY_ATTEMPTS = 3
const TASK_JOB_MEMORY_TERMINAL_TTL_MS = 5 * 60 * 1000
const TASK_JOB_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const TASK_JOB_TERMINAL_PRUNE_INTERVAL_MS = 60 * 60 * 1000
const TASK_JOB_TERMINAL_PRUNE_BATCH = 100
const TASK_JOB_STARTUP_PLAN_POLL_MS = 100
const TASK_JOB_STARTUP_PLAN_READ_TIMEOUT_MS = 250
const TASK_JOB_RECOVERY_CONTEXT_LIMIT_CHARS = 6_000
const TASK_JOB_PRESTART_CANCEL_TTL_MS = 15 * 60 * 1000
const TASK_JOB_PRESTART_CANCEL_PRUNE_INTERVAL_MS = 60 * 1000
const STARTUP_PLAN_READ_TIMEOUT = Symbol('startupPlanReadTimeout')

function isInProcessTaskWorkerId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('in-process:')
}

function isCancellationFenceWorkerId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('cancel-fence:')
}

function cancellationWorkerHeartbeatProofWindowMs(heartbeatMs: unknown): number {
  const normalizedHeartbeatMs = Number(heartbeatMs)
  const heartbeatAllowance = Number.isFinite(normalizedHeartbeatMs) && normalizedHeartbeatMs > 0
    ? normalizedHeartbeatMs
    : 0
  return Math.max(
    taskWorkerStaleMs(),
    heartbeatAllowance + TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS + TASK_WORKER_CANCEL_PROOF_JITTER_MS,
  )
}

interface ScheduledCancellationFence {
  dueAt: number
  timer: ReturnType<typeof setTimeout>
}

const scheduledCancellationFences = new Map<string, ScheduledCancellationFence>()

function normalizeStartupPlan(raw: unknown): ChatTaskPayload['startupPlan'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const plan = raw as { items?: unknown; scopes?: unknown }
  if (!Array.isArray(plan.items)) return undefined
  const items = plan.items
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 8)
  if (items.length === 0) return undefined
  const rawScopes = Array.isArray(plan.scopes) ? plan.scopes : null
  const scopes = rawScopes
    ? items.map((_, index) => {
        const scope = rawScopes[index]
        return typeof scope === 'string' && scope.trim() ? scope.trim() : null
      })
    : undefined
  return scopes ? { items, scopes } : { items }
}

function startupPlanDeadlineMs(value: unknown): number | undefined {
  const deadline = Number(value)
  if (!Number.isFinite(deadline) || deadline <= 0) return undefined
  return deadline
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function taskWorkerStaleMs(): number {
  return envPositiveInt('AGENT_TASK_WORKER_STALE_MS', TASK_JOB_WORKER_STALE_MS)
}

function taskJobMemoryTerminalTtlMs(): number {
  return envPositiveInt('AGENT_TASK_MEMORY_TERMINAL_TTL_MS', TASK_JOB_MEMORY_TERMINAL_TTL_MS)
}

function taskJobTerminalRetentionMs(): number {
  return envPositiveInt('AGENT_TASK_TERMINAL_RETENTION_MS', TASK_JOB_TERMINAL_RETENTION_MS)
}

function taskPreStartCancellationTtlMs(): number {
  return envPositiveInt('AGENT_TASK_PRESTART_CANCEL_TTL_MS', TASK_JOB_PRESTART_CANCEL_TTL_MS)
}

let taskJobSchemaPromise: Promise<void> | null = null
let lastTaskJobPruneAt = 0
let lastPreStartCancellationPruneAt = 0

function shouldUseDatabaseTaskJobs(): boolean {
  return getTursoSetupStatus().configured
}

function nowMs(): number {
  return Date.now()
}

function preStartCancellationKey(
  queueName: string,
  userId: string,
  conversationId: string,
  runId: string,
): string {
  return JSON.stringify([queueName, userId, conversationId, runId])
}

function pruneMemoryPreStartCancellations(now = nowMs()): void {
  for (const [key, tombstone] of preStartCancellationState) {
    if (tombstone.expiresAt <= now) preStartCancellationState.delete(key)
  }
}

function hasMemoryPreStartCancellation(
  queueName: string,
  userId: string,
  conversationId: string,
  runId: string,
  now = nowMs(),
): boolean {
  const key = preStartCancellationKey(queueName, userId, conversationId, runId)
  const tombstone = preStartCancellationState.get(key)
  if (!tombstone) return false
  if (tombstone.expiresAt <= now) {
    preStartCancellationState.delete(key)
    return false
  }
  return true
}

function recordMemoryPreStartCancellation(
  queueName: string,
  userId: string,
  conversationId: string,
  runId: string,
  expiresAt: number,
): void {
  pruneMemoryPreStartCancellations()
  const key = preStartCancellationKey(queueName, userId, conversationId, runId)
  const existing = preStartCancellationState.get(key)
  preStartCancellationState.set(key, {
    expiresAt: Math.max(existing?.expiresAt || 0, expiresAt),
  })
}

function taskWorkerMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.AGENT_TASK_WORKER_MAX_ATTEMPTS?.trim() || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TASK_JOB_WORKER_MAX_ATTEMPTS
}

export function shouldUseExternalTaskWorker(): boolean {
  return process.env.AGENT_TASK_WORKER_MODE?.trim() === 'external' && shouldUseDatabaseTaskJobs()
}

function normalizeStatus(value: unknown): TaskJobStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'error' || value === 'cancelled'
    ? value
    : 'error'
}

function normalizeTerminalStatus(value: unknown): 'done' | 'error' | null {
  return value === 'done' || value === 'error' ? value : null
}

function rowToActiveTaskJobSummary(row: TaskJobRow | undefined | null): ActiveTaskJobSummary | null {
  if (!row) return null
  if (
    typeof row.run_id !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    (row.status !== 'queued' && row.status !== 'running' && row.status !== 'done' && row.status !== 'error' && row.status !== 'cancelled')
  ) {
    return null
  }
  const now = nowMs()
  const startedAt = Number(row.started_at_ms)
  const updatedAt = Number(row.updated_at_ms)
  const attempts = Number(row.attempts)
  const payload = parseTaskPayload(row.payload_json)
  const acceptsLiveDirectivesValue = Number(row.accepts_live_directives)
  const acceptsLiveDirectives = payload
    ? payload.kind !== 'background_probe' && payload.directChat === false
    : Number.isFinite(acceptsLiveDirectivesValue) && acceptsLiveDirectivesValue !== 0
  const cancelRequested = row.cancel_requested === 1 || row.cancel_requested === true
  return {
    runId: row.run_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    queueName: typeof row.queue_name === 'string' && row.queue_name ? row.queue_name : 'default',
    status: row.status,
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
    terminalStatus: normalizeTerminalStatus(row.terminal_status),
    terminalError: typeof row.terminal_error === 'string' ? row.terminal_error : null,
    acceptsLiveDirectives: acceptsLiveDirectives && !cancelRequested,
    cancelRequested,
  }
}

async function addTaskJobColumn(sql: string): Promise<void> {
  try {
    await tursoExecute(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate column|already exists/i.test(message)) return
    throw error
  }
}

async function ensureTaskJobSchema(): Promise<void> {
  if (!taskJobSchemaPromise) {
    taskJobSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists agent_task_jobs (
          run_id text primary key,
          user_id text not null,
          conversation_id text not null,
          status text not null,
          terminal_status text,
          terminal_error text,
          started_at_ms integer not null,
          updated_at_ms integer not null,
          completed_at_ms integer
        )
      `)
      await addTaskJobColumn('alter table agent_task_jobs add column payload_json text')
      await addTaskJobColumn('alter table agent_task_jobs add column worker_id text')
      await addTaskJobColumn('alter table agent_task_jobs add column lease_expires_at_ms integer')
      await addTaskJobColumn('alter table agent_task_jobs add column attempts integer not null default 0')
      await addTaskJobColumn('alter table agent_task_jobs add column cancel_requested integer not null default 0')
      await addTaskJobColumn('alter table agent_task_jobs add column accepts_live_directives integer not null default 1')
      await addTaskJobColumn("alter table agent_task_jobs add column queue_name text not null default 'default'")
      await tursoExecute('create index if not exists agent_task_jobs_user_conversation_idx on agent_task_jobs(user_id, conversation_id, updated_at_ms desc)')
      await tursoExecute('create index if not exists agent_task_jobs_claim_idx on agent_task_jobs(status, lease_expires_at_ms, updated_at_ms)')
      await tursoExecute('create index if not exists agent_task_jobs_queue_claim_idx on agent_task_jobs(queue_name, status, lease_expires_at_ms, updated_at_ms)')
      await tursoExecute(`
        create table if not exists agent_task_events (
          run_id text not null,
          seq integer not null,
          event_json text not null,
          created_at_ms integer not null,
          primary key (run_id, seq)
        )
      `)
      await tursoExecute('create index if not exists agent_task_events_run_seq_idx on agent_task_events(run_id, seq)')
      await tursoExecute(`
        create table if not exists agent_task_live_frames (
          run_id text primary key,
          frame_version integer not null,
          event_json text not null,
          created_at_ms integer not null,
          updated_at_ms integer not null
        )
      `)
      await tursoExecute(`
        create table if not exists agent_task_prestart_cancellations (
          queue_name text not null,
          user_id text not null,
          conversation_id text not null,
          run_id text not null,
          created_at_ms integer not null,
          expires_at_ms integer not null,
          primary key (queue_name, user_id, conversation_id, run_id)
        )
      `)
      await tursoExecute('create index if not exists agent_task_prestart_cancellations_expiry_idx on agent_task_prestart_cancellations(expires_at_ms)')
    })().catch((error) => {
      taskJobSchemaPromise = null
      throw error
    })
  }
  return taskJobSchemaPromise
}

function isMissingTaskJobSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|schema/i.test(message)
}

async function withTaskJobSchemaRepair<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isMissingTaskJobSchemaError(error)) throw error
    await ensureTaskJobSchema()
    return operation()
  }
}

async function maybePruneTerminalTaskJobs(now = nowMs()): Promise<void> {
  if (!shouldUseDatabaseTaskJobs() || now - lastTaskJobPruneAt < TASK_JOB_TERMINAL_PRUNE_INTERVAL_MS) return
  const cutoff = now - taskJobTerminalRetentionMs()
  const queueName = taskQueueName()
  await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    const stale = await transaction.execute({
      sql: `
        select run_id
        from agent_task_jobs
        where status in ('done', 'error', 'cancelled')
          and queue_name = ?
          and terminal_status is not null
          and coalesce(completed_at_ms, updated_at_ms) < ?
        order by coalesce(completed_at_ms, updated_at_ms) asc
        limit ?
      `,
      args: [queueName, cutoff, TASK_JOB_TERMINAL_PRUNE_BATCH],
    })
    const runIds = stale.rows
      .map((row) => typeof row.run_id === 'string' ? row.run_id : '')
      .filter(Boolean)
    if (runIds.length === 0) return
    const placeholders = runIds.map(() => '?').join(', ')
    await transaction.execute({
      sql: `delete from agent_task_events where run_id in (${placeholders})`,
      args: runIds,
    })
    await transaction.execute({
      sql: `delete from agent_task_live_frames where run_id in (${placeholders})`,
      args: runIds,
    })
    await transaction.execute({
      sql: `
        delete from agent_task_jobs
        where run_id in (${placeholders})
          and status in ('done', 'error', 'cancelled')
          and queue_name = ?
          and terminal_status is not null
          and coalesce(completed_at_ms, updated_at_ms) < ?
      `,
      args: [...runIds, queueName, cutoff],
    })
  }))
  lastTaskJobPruneAt = now
}

async function maybePrunePreStartCancellations(now = nowMs()): Promise<void> {
  pruneMemoryPreStartCancellations(now)
  if (
    !shouldUseDatabaseTaskJobs() ||
    now - lastPreStartCancellationPruneAt < TASK_JOB_PRESTART_CANCEL_PRUNE_INTERVAL_MS
  ) return
  await withTaskJobSchemaRepair(() => tursoExecute(
    'delete from agent_task_prestart_cancellations where expires_at_ms <= ?',
    [now],
  ))
  lastPreStartCancellationPruneAt = now
}

let taskJobRetentionMaintenancePromise: Promise<void> | null = null

function scheduleTaskJobRetentionMaintenance(now = nowMs()): void {
  if (taskJobRetentionMaintenancePromise) return
  taskJobRetentionMaintenancePromise = Promise.resolve()
    .then(async () => {
      await maybePrunePreStartCancellations(now).catch((error) => {
        console.warn('[TaskJobs] Pre-start cancellation retention cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      await maybePruneTerminalTaskJobs(now).catch((error) => {
        console.warn('[TaskJobs] Terminal task retention cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
    .finally(() => {
      taskJobRetentionMaintenancePromise = null
    })
}

async function runPersistenceWithRetry(work: () => Promise<void>): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < TASK_JOB_PERSIST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await work()
      return
    } catch (error) {
      if (error instanceof TaskJobClaimLostError) throw error
      lastError = error
      if (attempt + 1 < TASK_JOB_PERSIST_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Task persistence failed'))
}

function handlePersistenceFailure(job: TaskJob, error: unknown): void {
  if (error instanceof TaskJobClaimLostError) {
    job.persistenceFailure = error
    if (!job.requeueRequested && !job.terminalStatus) {
      job.requeueRequested = true
      job.requeueReason = 'lease_lost'
      job.closed = true
      closeJobSubscribers(job)
      job.abortController.abort()
    }
    return
  }

  job.persistenceFailure = error
  console.error('[TaskJobs] Durable event persistence exhausted retries', {
    runId: job.runId,
    error: error instanceof Error ? error.message : String(error),
  })
  if (!job.terminalStatus && !job.closed) {
    recordTaskJobEvent(job, {
      type: 'error',
      message: 'Task progress could not be saved safely. Please try again.',
    })
  }
  job.abortController.abort()
}

function queuePersistence(
  job: TaskJob,
  work: () => Promise<void>,
  onSettled?: () => void,
): void {
  if (!shouldUseDatabaseTaskJobs()) return
  job.persistChain = job.persistChain
    .then(async () => {
      try {
        if (!job.persistenceFailure) await runPersistenceWithRetry(work)
      } catch (error) {
        handlePersistenceFailure(job, error)
      } finally {
        onSettled?.()
      }
    })
}

function publishPersistedRecords(job: TaskJob, records: RecordedTaskEvent[]): void {
  for (const record of records) {
    if (record.event.type === 'done' || record.event.type === 'error') continue
    for (const subscriber of job.subscribers.values()) {
      sendEventToSubscriber(subscriber, record.event)
    }
  }
}

async function persistEventsThenPublish(job: TaskJob, records: RecordedTaskEvent[]): Promise<void> {
  await persistEvents(job, records)
  publishPersistedRecords(job, records)
}

function scheduleEventPersistence(job: TaskJob): void {
  if (!shouldUseDatabaseTaskJobs() || job.eventPersistenceQueued || job.pendingEventPersistence.length === 0) return
  job.eventPersistenceQueued = true
  queuePersistence(job, () => drainOrderedEventBatches(
    job.pendingEventPersistence,
    TASK_JOB_EVENT_PERSIST_BATCH_LIMIT,
    (records) => persistEventsThenPublish(job, records),
    {
      maxBatchWeight: TASK_JOB_EVENT_PERSIST_BATCH_BYTES,
      weightOf: (record) => utf8ByteWeight(stringifyEventForPersistence(record.event)),
    },
  ), () => {
    job.eventPersistenceQueued = false
    // An event can arrive in the microtask between the drain resolving and this
    // completion callback. Give it a fresh chain slot instead of stranding it.
    if (!job.persistenceFailure && job.pendingEventPersistence.length > 0) {
      scheduleEventPersistence(job)
    }
  })
}

function queueEventPersistence(job: TaskJob, records: RecordedTaskEvent[]): void {
  if (!shouldUseDatabaseTaskJobs() || records.length === 0) return
  job.pendingEventPersistence.push(...records)
  scheduleEventPersistence(job)
}

function clearPendingTextPersistenceTimer(job: TaskJob): void {
  if (!job.pendingTextPersistenceTimer) return
  clearTimeout(job.pendingTextPersistenceTimer)
  job.pendingTextPersistenceTimer = null
}

function flushPendingTextPersistence(job: TaskJob): void {
  const records = job.pendingTextPersistence
  if (records.length === 0) return
  clearPendingTextPersistenceTimer(job)
  job.pendingTextPersistence = []
  job.pendingTextPersistenceChars = 0
  queueEventPersistence(job, records)
}

function clearPendingBrowserFramePersistenceTimer(job: TaskJob): void {
  if (!job.pendingBrowserFramePersistenceTimer) return
  clearTimeout(job.pendingBrowserFramePersistenceTimer)
  job.pendingBrowserFramePersistenceTimer = null
}

function flushPendingBrowserFramePersistence(job: TaskJob): void {
  const record = job.pendingBrowserFramePersistence
  if (!record) return
  clearPendingBrowserFramePersistenceTimer(job)
  job.pendingBrowserFramePersistence = null
  queuePersistence(job, () => persistLatestBrowserFrame(job, record))
}

function flushPendingEventPersistence(job: TaskJob): void {
  flushPendingTextPersistence(job)
  flushPendingBrowserFramePersistence(job)
}

async function awaitTaskJobPersistenceIdle(job: TaskJob): Promise<void> {
  while (!job.persistenceFailure) {
    flushPendingEventPersistence(job)
    scheduleEventPersistence(job)
    const observedChain = job.persistChain
    await observedChain
    if (
      observedChain === job.persistChain &&
      !job.eventPersistenceQueued &&
      job.pendingEventPersistence.length === 0 &&
      job.pendingTextPersistence.length === 0 &&
      !job.pendingBrowserFramePersistence
    ) {
      return
    }
  }
}

function queueBrowserFramePersistence(job: TaskJob, record: RecordedTaskFrame): void {
  job.pendingBrowserFramePersistence = record
  if (job.pendingBrowserFramePersistenceTimer) return
  job.pendingBrowserFramePersistenceTimer = setTimeout(() => {
    flushPendingBrowserFramePersistence(job)
  }, TASK_JOB_BROWSER_FRAME_PERSIST_INTERVAL_MS)
  job.pendingBrowserFramePersistenceTimer.unref?.()
}

function batchableEventChars(event: SSEEvent): number | null {
  if (event.type === 'text_delta' || event.type === 'reasoning_delta' || event.type === 'file_content_delta') {
    return event.content.length
  }
  if (event.type === 'terminal_output') return event.data.length
  return null
}

function queueDeltaPersistence(job: TaskJob, record: RecordedTaskEvent): void {
  const event = record.event
  const eventChars = batchableEventChars(event)
  if (eventChars === null) {
    flushPendingTextPersistence(job)
    queueEventPersistence(job, [record])
    return
  }

  const isFirstVisibleText = event.type === 'text_delta' &&
    job.events.filter((entry) => entry.event.type === 'text_delta').length === 1
  if (isFirstVisibleText) {
    flushPendingTextPersistence(job)
    queueEventPersistence(job, [record])
    return
  }

  if (
    job.pendingTextPersistence.length >= TASK_JOB_DELTA_PERSIST_BATCH_LIMIT ||
    job.pendingTextPersistenceChars + eventChars > TASK_JOB_TEXT_PERSIST_CHUNK_CHARS
  ) {
    flushPendingTextPersistence(job)
  }

  job.pendingTextPersistence.push({
    ...record,
    event: { ...event },
  })
  job.pendingTextPersistenceChars += eventChars

  clearPendingTextPersistenceTimer(job)
  job.pendingTextPersistenceTimer = setTimeout(() => {
    flushPendingTextPersistence(job)
  }, TASK_JOB_TEXT_PERSIST_DEBOUNCE_MS)
}

function compactStringForPersistence(value: string, maxChars = TASK_JOB_TEXT_FIELD_PERSIST_LIMIT_CHARS): string {
  if (value.length <= maxChars) return value
  const suffix = `\n\n[truncated ${value.length - maxChars} characters for persisted task replay]`
  const keep = Math.max(0, maxChars - suffix.length)
  return `${value.slice(0, keep)}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactUnknownForPersistence(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) return TASK_JOB_INLINE_IMAGE_PLACEHOLDER
    return compactStringForPersistence(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (typeof value === 'undefined') return null

  if (Array.isArray(value)) {
    const items = value
      .slice(0, TASK_JOB_ARRAY_ITEM_LIMIT)
      .map((item) => compactUnknownForPersistence(item, depth + 1))
    if (value.length > TASK_JOB_ARRAY_ITEM_LIMIT) {
      items.push({
        truncated: true,
        omittedItems: value.length - TASK_JOB_ARRAY_ITEM_LIMIT,
      })
    }
    return items
  }

  if (!isRecord(value)) return TASK_JOB_TRUNCATED_OBJECT_PLACEHOLDER
  if (depth >= TASK_JOB_OBJECT_DEPTH_LIMIT) return TASK_JOB_TRUNCATED_OBJECT_PLACEHOLDER

  const output: Record<string, unknown> = {}
  const entries = Object.entries(value)
  for (const [key, raw] of entries.slice(0, TASK_JOB_OBJECT_FIELD_LIMIT)) {
    const normalizedKey = key.toLowerCase()
    if (
      normalizedKey === 'screenshotbase64' ||
      normalizedKey === 'imagedataurl' ||
      normalizedKey === 'frame'
    ) {
      output[key] = typeof raw === 'string' && raw ? TASK_JOB_INLINE_IMAGE_PLACEHOLDER : raw
      continue
    }
    output[key] = compactUnknownForPersistence(raw, depth + 1)
  }
  if (entries.length > TASK_JOB_OBJECT_FIELD_LIMIT) {
    output.__truncatedFields = entries.length - TASK_JOB_OBJECT_FIELD_LIMIT
  }
  return output
}

function compactArtifactForPersistence(artifact: Artifact): Artifact {
  const { imageDataUrl: _inlineImage, ...durableArtifact } = artifact
  return {
    ...durableArtifact,
    content: compactStringForPersistence(artifact.content),
  }
}

function stripInlineBinaryFromEventValue(value: unknown, depth = 0): unknown {
  if (depth > TASK_JOB_OBJECT_DEPTH_LIMIT || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => stripInlineBinaryFromEventValue(item, depth + 1))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey === 'screenshotbase64' || normalizedKey === 'imagedataurl') continue
    output[key] = stripInlineBinaryFromEventValue(item, depth + 1)
  }
  return output
}

function compactEventForPersistence(event: SSEEvent): SSEEvent {
  switch (event.type) {
    case 'text_delta':
      return { ...event, content: compactStringForPersistence(event.content) }
    case 'progress_update':
      return { ...event, content: compactStringForPersistence(event.content, 300) }
    case 'reasoning_delta':
      return { ...event, content: compactStringForPersistence(event.content) }
    case 'tool_start':
      return {
        ...event,
        args: compactUnknownForPersistence(event.args) as Record<string, unknown>,
      }
    case 'tool_result':
      return {
        ...event,
        result: compactUnknownForPersistence(event.result) as SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult,
      }
    case 'browser_frame':
      return { type: 'heartbeat', timestamp: event.timestamp, seq: event.seq, runId: event.runId }
    case 'terminal_output':
      return { ...event, data: compactStringForPersistence(event.data) }
    case 'file_content_delta':
      return { ...event, content: compactStringForPersistence(event.content) }
    case 'plan':
      return { ...event, items: event.items.map((item) => compactStringForPersistence(item, 8_192)) }
    case 'follow_ups':
      return {
        ...event,
        suggestions: event.suggestions.map((suggestion) => ({
          ...suggestion,
          text: compactStringForPersistence(suggestion.text, 2_048),
        })),
      }
    case 'artifact_created':
      return { ...event, artifact: compactArtifactForPersistence(event.artifact) }
    case 'credit_event':
      return { ...event, entry: compactUnknownForPersistence(event.entry) as CreditLedgerEvent }
    case 'step_advance':
      return {
        ...event,
        reason: event.reason ? compactStringForPersistence(event.reason, 4_096) : event.reason,
      }
    case 'error':
      return { ...event, message: compactStringForPersistence(event.message, 8_192) }
    case 'done':
      return { ...event, usage: compactUnknownForPersistence(event.usage) as CreditTokenUsage | undefined }
    default:
      return event
  }
}

function minimalToolResultForPersistence(name: string): SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult {
  if (name === 'web_search' || name === 'image_search') return []
  if (name === 'execute_command' || name === 'run_code') {
    return {
      command: '',
      stdout: '',
      stderr: 'Tool result was too large to replay after reconnect.',
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    }
  }
  if (name.startsWith('browser_')) {
    return {
      success: true,
      url: '',
      title: '',
      action: 'Tool result was too large to replay after reconnect.',
      content: 'The live browser result was compacted for persisted replay.',
    }
  }
  if (
    name.includes('file') ||
    name === 'read_attachment' ||
    name === 'read_skill' ||
    name === 'export_pdf'
  ) {
    return {
      action: 'read',
      path: '',
      error: 'Tool result was too large to replay after reconnect.',
    }
  }
  return {
    title: name || 'Tool Result',
    content: 'Tool result was too large to replay after reconnect.',
    url: '',
  }
}

function minimalEventForPersistence(event: SSEEvent): SSEEvent {
  switch (event.type) {
    case 'done':
      return { type: 'done', seq: event.seq, runId: event.runId }
    case 'error':
      return {
        type: 'error',
        message: compactStringForPersistence(event.message, 1_024),
        seq: event.seq,
        runId: event.runId,
      }
    case 'progress_update':
      return {
        type: 'progress_update',
        content: compactStringForPersistence(event.content, 300),
        stepIndex: event.stepIndex,
        afterToolId: event.afterToolId,
        remainingVisibleActions: event.remainingVisibleActions,
        seq: event.seq,
        runId: event.runId,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        name: event.name,
        result: minimalToolResultForPersistence(event.name),
        seq: event.seq,
        runId: event.runId,
      }
    case 'tool_start': {
      const method = typeof event.args.method === 'string' ? event.args.method.toUpperCase() : undefined
      const previewBuild = event.args.previewBuild === true ? true : undefined
      const actionLabel = typeof event.args.action_label === 'string'
        ? compactStringForPersistence(event.args.action_label, 256)
        : undefined
      return {
        type: 'tool_start',
        id: compactStringForPersistence(event.id, 256),
        name: compactStringForPersistence(event.name, 256),
        args: {
          ...(method ? { method } : {}),
          ...(previewBuild ? { previewBuild } : {}),
          ...(actionLabel ? { action_label: actionLabel } : {}),
        },
        ...(event.provisional ? { provisional: true } : {}),
        seq: event.seq,
        runId: event.runId,
      }
    }
    case 'artifact_created':
      return {
        type: 'artifact_created',
        artifact: {
          ...event.artifact,
          content: '[artifact content omitted from persisted task replay]',
          imageDataUrl: undefined,
        },
        seq: event.seq,
        runId: event.runId,
      }
    case 'terminal_output':
      return {
        type: 'terminal_output',
        id: event.id,
        stream: event.stream,
        data: '[terminal output omitted from persisted task replay]',
        seq: event.seq,
        runId: event.runId,
      }
    case 'file_content_delta':
      return {
        type: 'file_content_delta',
        id: event.id,
        content: '[file content omitted from persisted task replay]',
        seq: event.seq,
        runId: event.runId,
      }
    default:
      return {
        type: 'heartbeat',
        timestamp: event.type === 'heartbeat' ? event.timestamp : 0,
        seq: event.seq,
        runId: event.runId,
      }
  }
}

function stringifyEventForPersistence(event: SSEEvent): string {
  for (const candidate of [event, compactEventForPersistence(event), minimalEventForPersistence(event)]) {
    try {
      const eventJson = JSON.stringify(candidate)
      if (utf8ByteWeight(eventJson) <= TASK_JOB_EVENT_PERSIST_LIMIT_BYTES) return eventJson
    } catch {
      // Try the next, smaller representation.
    }
  }

  return JSON.stringify({
    type: 'heartbeat',
    timestamp: event.type === 'heartbeat' ? event.timestamp : 0,
    seq: event.seq,
    runId: event.runId,
  } satisfies SSEEvent)
}

async function persistJob(job: TaskJob): Promise<boolean> {
  if (job.claimWorkerId && job.claimAttempts !== null) {
    const result = await withTaskJobSchemaRepair(() => tursoExecute(
      `
        update agent_task_jobs
        set status = ?,
            terminal_status = ?,
            terminal_error = ?,
            worker_id = null,
            lease_expires_at_ms = null,
            updated_at_ms = ?,
            completed_at_ms = ?
        where run_id = ?
          and queue_name = ?
          and worker_id = ?
          and attempts = ?
          and status = 'running'
          and terminal_status is null
      `,
      [
        job.status,
        job.terminalStatus,
        job.terminalError,
        job.updatedAt,
        job.completedAt,
        job.runId,
        job.queueName,
        job.claimWorkerId,
        job.claimAttempts,
      ],
    ))
    return result.rowsAffected === 1
  }

  await withTaskJobSchemaRepair(() => tursoExecute(
    `
      insert into agent_task_jobs (
        run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
        started_at_ms, updated_at_ms, completed_at_ms, accepts_live_directives
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(run_id) do update set
        queue_name = excluded.queue_name,
        status = excluded.status,
        terminal_status = excluded.terminal_status,
        terminal_error = excluded.terminal_error,
        accepts_live_directives = excluded.accepts_live_directives,
        worker_id = case
          when excluded.terminal_status is not null or excluded.status in ('done', 'error', 'cancelled') then null
          else agent_task_jobs.worker_id
        end,
        lease_expires_at_ms = case
          when excluded.terminal_status is not null or excluded.status in ('done', 'error', 'cancelled') then null
          else agent_task_jobs.lease_expires_at_ms
        end,
        updated_at_ms = excluded.updated_at_ms,
        completed_at_ms = excluded.completed_at_ms
    `,
    [
      job.runId,
      job.userId,
      job.conversationId,
      job.queueName,
      job.status,
      job.terminalStatus,
      job.terminalError,
      job.startedAt,
      job.updatedAt,
      job.completedAt,
      job.acceptsLiveDirectives ? 1 : 0,
    ],
  ))
  return true
}

async function persistFinalJobState(job: TaskJob): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return true
  if (job.persistenceFailure) return false
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!job.terminalRecord) return await persistJob(job)
      return await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
        if (job.claimWorkerId && job.claimAttempts !== null) {
          const ownership = await transaction.execute({
            sql: `
              select cancel_requested
              from agent_task_jobs
              where run_id = ?
                and queue_name = ?
                and worker_id = ?
                and attempts = ?
                and status = 'running'
                and terminal_status is null
              limit 1
            `,
            args: [job.runId, job.queueName, job.claimWorkerId, job.claimAttempts],
          })
          const cancelRequested = ownership.rows[0]?.cancel_requested
          if (cancelRequested === 1 || cancelRequested === true) {
            markTaskJobCancelled(job)
          }
        }

        const terminalRecord = job.terminalRecord
        if (!terminalRecord) return false
        const terminalEvent = eventInsertStatement(job, terminalRecord)
        const terminalInserted = await transaction.execute(terminalEvent)
        if (job.claimWorkerId && terminalInserted.rowsAffected !== 1) {
          const existing = await transaction.execute({
            sql: 'select event_json from agent_task_events where run_id = ? and seq = ? limit 1',
            args: [job.runId, terminalRecord.seq],
          })
          if (existing.rows[0]?.event_json !== terminalEvent.args[2]) return false
        }

        if (job.claimWorkerId && job.claimAttempts !== null) {
          const finalized = await transaction.execute({
            sql: `
              update agent_task_jobs
              set status = ?,
                  terminal_status = ?,
                  terminal_error = ?,
                  worker_id = null,
                  lease_expires_at_ms = null,
                  updated_at_ms = ?,
                  completed_at_ms = ?
              where run_id = ?
                and queue_name = ?
                and worker_id = ?
                and attempts = ?
                and status = 'running'
                and terminal_status is null
            `,
            args: [
              job.status,
              job.terminalStatus,
              job.terminalError,
              job.updatedAt,
              job.completedAt,
              job.runId,
              job.queueName,
              job.claimWorkerId,
              job.claimAttempts,
            ],
          })
          if (finalized.rowsAffected === 1) {
            await transaction.execute({
              sql: 'delete from agent_task_live_frames where run_id = ?',
              args: [job.runId],
            })
            return true
          }

          const current = await transaction.execute({
            sql: `
              select status, terminal_status
              from agent_task_jobs
              where run_id = ? and queue_name = ?
              limit 1
            `,
            args: [job.runId, job.queueName],
          })
          const row = current.rows[0]
          const alreadyFinal = row?.status === job.status && row?.terminal_status === job.terminalStatus
          if (alreadyFinal) {
            await transaction.execute({
              sql: 'delete from agent_task_live_frames where run_id = ?',
              args: [job.runId],
            })
          }
          return alreadyFinal
        }

        await transaction.execute({
          sql: `
            insert into agent_task_jobs (
              run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
              started_at_ms, updated_at_ms, completed_at_ms, accepts_live_directives
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(run_id) do update set
              queue_name = excluded.queue_name,
              status = excluded.status,
              terminal_status = excluded.terminal_status,
              terminal_error = excluded.terminal_error,
              accepts_live_directives = excluded.accepts_live_directives,
              worker_id = null,
              lease_expires_at_ms = null,
              updated_at_ms = excluded.updated_at_ms,
              completed_at_ms = excluded.completed_at_ms
          `,
          args: [
            job.runId,
            job.userId,
            job.conversationId,
            job.queueName,
            job.status,
            job.terminalStatus,
            job.terminalError,
            job.startedAt,
            job.updatedAt,
            job.completedAt,
            job.acceptsLiveDirectives ? 1 : 0,
          ],
        })
        await transaction.execute({
          sql: 'delete from agent_task_live_frames where run_id = ?',
          args: [job.runId],
        })
        return true
      }))
    } catch (error) {
      lastError = error
      console.error('[TaskJobs] Final persistence failed', {
        runId: job.runId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      })
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Final persistence failed'))
}

function eventInsertStatement(job: TaskJob, record: RecordedTaskEvent): { sql: string; args: Array<string | number> } {
  const baseArgs: Array<string | number> = [
    job.runId,
    record.seq,
    stringifyEventForPersistence(record.event),
    record.createdAt,
  ]
  if (!job.claimWorkerId || job.claimAttempts === null) {
    return {
      sql: `
        insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
        values (?, ?, ?, ?)
      `,
      args: baseArgs,
    }
  }
  return {
    sql: `
      insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
      select ?, ?, ?, ?
      where exists (
        select 1
        from agent_task_jobs
        where run_id = ?
          and queue_name = ?
          and worker_id = ?
          and attempts = ?
          and status = 'running'
          and terminal_status is null
      )
    `,
    args: [
      ...baseArgs,
      job.runId,
      job.queueName,
      job.claimWorkerId,
      job.claimAttempts,
    ],
  }
}

function eventBatchInsertStatement(
  job: TaskJob,
  records: RecordedTaskEvent[],
): { sql: string; args: Array<string | number>; eventJsonBySeq: Map<number, string> } {
  const eventJsonBySeq = new Map<number, string>()
  const eventArgs: Array<string | number> = []
  for (const record of records) {
    const eventJson = stringifyEventForPersistence(record.event)
    eventJsonBySeq.set(record.seq, eventJson)
    eventArgs.push(job.runId, record.seq, eventJson, record.createdAt)
  }
  const values = records.map(() => '(?, ?, ?, ?)').join(', ')

  if (!job.claimWorkerId || job.claimAttempts === null) {
    return {
      sql: `
        insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
        values ${values}
      `,
      args: eventArgs,
      eventJsonBySeq,
    }
  }

  return {
    sql: `
      with pending_events(run_id, seq, event_json, created_at_ms) as (
        values ${values}
      )
      insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
      select pending_events.run_id,
             pending_events.seq,
             pending_events.event_json,
             pending_events.created_at_ms
      from pending_events
      where exists (
        select 1
        from agent_task_jobs
        where run_id = ?
          and queue_name = ?
          and worker_id = ?
          and attempts = ?
          and status = 'running'
          and terminal_status is null
      )
    `,
    args: [
      ...eventArgs,
      job.runId,
      job.queueName,
      job.claimWorkerId,
      job.claimAttempts,
    ],
    eventJsonBySeq,
  }
}

async function persistEvents(job: TaskJob, records: RecordedTaskEvent[]): Promise<void> {
  if (records.length === 0) return
  const statement = eventBatchInsertStatement(job, records)
  // A single INSERT...SELECT statement is atomic and preserves every bound
  // parameter. Do not use the serverless compatibility client's batch() here:
  // that API drops statement arguments and collapses all results in the
  // currently installed driver.
  const inserted = await withTaskJobSchemaRepair(() => tursoExecuteIsolated(statement))
  if (!job.claimWorkerId) return
  if (inserted.rowsAffected === records.length) return

  // A zero-row insert is either an idempotent replay or a lost worker claim.
  // Verify only this rare path; normal progress stays one durable round trip.
  const existing = await withTaskJobSchemaRepair(() => tursoExecuteIsolated({
    sql: `
      select seq, event_json
      from agent_task_events
      where run_id = ?
        and seq in (${records.map(() => '?').join(', ')})
    `,
    args: [job.runId, ...records.map((record) => record.seq)],
  }))
  const existingBySeq = new Map(
    existing.rows.map((row) => [Number(row.seq), row.event_json]),
  )
  for (const record of records) {
    if (existingBySeq.get(record.seq) !== statement.eventJsonBySeq.get(record.seq)) {
      throw new TaskJobClaimLostError(job.runId)
    }
  }
}

function stringifyBrowserFrameForPersistence(record: RecordedTaskFrame): string | null {
  const serialized = JSON.stringify(record.event)
  if (utf8ByteWeight(serialized) <= TASK_JOB_BROWSER_FRAME_PERSIST_LIMIT_BYTES) return serialized
  return null
}

async function persistLatestBrowserFrame(job: TaskJob, record: RecordedTaskFrame): Promise<void> {
  const eventJson = stringifyBrowserFrameForPersistence(record)
  if (!eventJson) return
  await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    if (job.claimWorkerId && job.claimAttempts !== null) {
      const ownership = await transaction.execute({
        sql: `
          select 1 as owned
          from agent_task_jobs
          where run_id = ?
            and queue_name = ?
            and worker_id = ?
            and attempts = ?
            and status = 'running'
            and terminal_status is null
          limit 1
        `,
        args: [job.runId, job.queueName, job.claimWorkerId, job.claimAttempts],
      })
      if (!ownership.rows[0]) throw new TaskJobClaimLostError(job.runId)
    }

    await transaction.execute({
      sql: `
        insert into agent_task_live_frames (run_id, frame_version, event_json, created_at_ms, updated_at_ms)
        values (?, ?, ?, ?, ?)
        on conflict(run_id) do update set
          frame_version = excluded.frame_version,
          event_json = excluded.event_json,
          created_at_ms = excluded.created_at_ms,
          updated_at_ms = excluded.updated_at_ms
        where excluded.frame_version > agent_task_live_frames.frame_version
      `,
      args: [job.runId, record.version, eventJson, record.createdAt, nowMs()],
    })
  }))
}

function parseTaskPayload(raw: unknown): TaskJobPayload | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const payload = JSON.parse(raw) as Partial<TaskJobPayload>
    if (!payload || typeof payload !== 'object') return null

    if (payload.kind === 'background_probe') {
      const delayMs = Number((payload as Partial<BackgroundProbeTaskPayload>).delayMs)
      if (!Number.isFinite(delayMs) || delayMs < 0) return null
      const message = (payload as Partial<BackgroundProbeTaskPayload>).message
      return {
        kind: 'background_probe',
        delayMs: Math.min(30_000, Math.max(0, Math.round(delayMs))),
        message: typeof message === 'string' ? message.slice(0, 500) : undefined,
      }
    }

    if (payload.kind && payload.kind !== 'chat') return null
    const chatPayload = payload as Partial<ChatTaskPayload>
    if (!Array.isArray(chatPayload.messages)) return null
    if (typeof chatPayload.model !== 'string') return null
    if (typeof chatPayload.startIsolatedTaskSandbox !== 'boolean') return null
    if (typeof chatPayload.directChat !== 'boolean') return null
    const recoveryMode = chatPayload.recoveryMode === 'graceful_handoff' || chatPayload.recoveryMode === 'stale_lease'
      ? chatPayload.recoveryMode
      : undefined
    const recoverySourceAttempt = Number(chatPayload.recoverySourceAttempt)
    return {
      kind: 'chat',
      messages: chatPayload.messages as ChatTaskPayload['messages'],
      model: chatPayload.model,
      customInstructions: typeof chatPayload.customInstructions === 'string' ? chatPayload.customInstructions : undefined,
      startFreshSandbox: chatPayload.startFreshSandbox === true,
      startIsolatedTaskSandbox: chatPayload.startIsolatedTaskSandbox,
      directChat: chatPayload.directChat,
      skipStartupAcknowledgement: chatPayload.skipStartupAcknowledgement === true,
      startupPlan: normalizeStartupPlan(chatPayload.startupPlan),
      startupPlanExpected: chatPayload.startupPlanExpected === true,
      startupPlanDeadlineMs: startupPlanDeadlineMs(chatPayload.startupPlanDeadlineMs),
      recoveryMode,
      recoverySourceAttempt: Number.isFinite(recoverySourceAttempt) && recoverySourceAttempt >= 1
        ? Math.floor(recoverySourceAttempt)
        : undefined,
      recoveryContext: typeof chatPayload.recoveryContext === 'string'
        ? chatPayload.recoveryContext.slice(0, 8_000)
        : undefined,
    }
  } catch {
    return null
  }
}

interface TaskRecoveryAssessment {
  unsafeUnmatchedTool: { id: string; name: string } | null
  context: string | undefined
  hasPersistedTextDelta: boolean
}

function isNonIdempotentPersistedToolStart(name: string, args: unknown): boolean {
  return isNonIdempotentToolCall(name, args)
}

function persistedToolResultSummary(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} result${result.length === 1 ? '' : 's'}`
  if (!isRecord(result)) return ''
  const fields: string[] = []
  for (const key of ['success', 'action', 'path', 'url', 'title', 'exitCode', 'error']) {
    const value = result[key]
    if (typeof value === 'string' && value.trim()) {
      fields.push(`${key}=${JSON.stringify(value.trim().slice(0, 180))}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      fields.push(`${key}=${String(value)}`)
    }
    if (fields.length >= 4) break
  }
  return fields.join(', ')
}

function assessTaskRecoveryEvents(rows: Array<Record<string, unknown>>): TaskRecoveryAssessment {
  type PendingStart = { id: string; name: string; args: unknown; seq: number; provisional: boolean }
  const pendingById = new Map<string, PendingStart>()
  const summaries: string[] = []
  let hasPersistedTextDelta = false
  const ordered = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq))

  for (const row of ordered) {
    let event: SSEEvent
    try {
      event = JSON.parse(String(row.event_json)) as SSEEvent
    } catch {
      continue
    }
    if (event.type === 'tool_start') {
      // Streaming may publish provisional argument updates with the same ID;
      // they describe one action, not multiple executions.
      pendingById.set(event.id, {
        id: event.id,
        name: event.name,
        args: event.args,
        seq: Number(row.seq) || 0,
        provisional: event.provisional === true,
      })
      continue
    }
    if (
      (event.type === 'text_delta' || event.type === 'progress_update') &&
      event.content.length > 0
    ) {
      hasPersistedTextDelta = true
      continue
    }
    if (event.type === 'tool_result') {
      const pendingStart = pendingById.get(event.id)
      pendingById.delete(event.id)
      const result = isRecord(event.result) ? event.result : null
      const abandonedProvisional =
        pendingStart?.provisional === true &&
        (
          result?.superseded === true ||
          result?.discarded === true ||
          (
            typeof result?.error === 'string' &&
            /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(result.error)
          )
        )
      if (abandonedProvisional) continue
      const detail = persistedToolResultSummary(event.result)
      summaries.push(`Completed ${event.name}${detail ? ` (${detail})` : ''}.`)
      continue
    }
    if (event.type === 'artifact_created') {
      const artifact = event.artifact as Artifact & { path?: string; name?: string }
      const label = artifact.path || artifact.name || artifact.filePath || artifact.fileName || artifact.id
      summaries.push(`Saved artifact${label ? ` ${JSON.stringify(String(label).slice(0, 220))}` : ''}.`)
    }
  }

  const pending = Array.from(pendingById.values())
    // Streamed previews are useful UI, but they precede the durable execution
    // checkpoint. A crash with only this marker proves no side effect ran.
    .filter((start) => !start.provisional)
    .sort((a, b) => a.seq - b.seq)
  const unsafe = pending.find((start) => isNonIdempotentPersistedToolStart(start.name, start.args)) || null
  for (const start of pending.filter((candidate) => candidate !== unsafe).slice(-8)) {
    summaries.push(`Unfinished read-only action ${start.name}; verify whether it needs to be rerun.`)
  }

  const context = summaries.length
    ? summaries.slice(-30).join(' ').slice(0, TASK_JOB_RECOVERY_CONTEXT_LIMIT_CHARS)
    : undefined
  return {
    unsafeUnmatchedTool: unsafe ? { id: unsafe.id, name: unsafe.name } : null,
    context,
    hasPersistedTextDelta,
  }
}

function uncertainNonIdempotentActionMessage(
  assessment: TaskRecoveryAssessment,
  prefix: 'cancelled' | 'interrupted',
): string | null {
  const toolName = assessment.unsafeUnmatchedTool?.name.trim().slice(0, 120)
  if (!toolName) return null
  const opening = prefix === 'cancelled' ? 'Task stopped' : 'Task execution was interrupted'
  return `${opening}, but the previous ${toolName} action may have completed before its result was saved. Check the current state before retrying that action.`
}

async function loadTaskRecoveryAssessment(runId: string): Promise<TaskRecoveryAssessment> {
  if (!shouldUseDatabaseTaskJobs()) {
    return { unsafeUnmatchedTool: null, context: undefined, hasPersistedTextDelta: false }
  }
  const rows = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select seq, event_json
      from agent_task_events
      where run_id = ?
        and (
          event_json like '%"type":"tool_start"%'
          or event_json like '%"type":"tool_result"%'
          or event_json like '%"type":"artifact_created"%'
          or event_json like '%"type":"text_delta"%'
          or event_json like '%"type":"progress_update"%'
        )
      order by seq asc
    `,
    [runId],
  ))
  return assessTaskRecoveryEvents(rows.rows as Array<Record<string, unknown>>)
}

async function applyCancellationTerminalSafety(job: TaskJob): Promise<void> {
  if (!job.cancelRequested || !job.terminalRecord) return
  markTaskJobCancelled(job)

  try {
    const assessment = shouldUseDatabaseTaskJobs()
      ? await loadTaskRecoveryAssessment(job.runId)
      : assessTaskRecoveryEvents(job.events.map((record) => ({
          seq: record.seq,
          event_json: JSON.stringify(record.event),
        })))
    const uncertainty = uncertainNonIdempotentActionMessage(assessment, 'cancelled')
    if (uncertainty) replaceTerminalRecordWithError(job, uncertainty)
  } catch (error) {
    // A cancellation must never claim that execution stopped cleanly when the
    // durable pre-action/result pairing cannot be checked.
    console.error('[TaskJobs] Failed to assess cancellation action certainty', {
      runId: job.runId,
      error: error instanceof Error ? error.message : String(error),
    })
    replaceTerminalRecordWithError(
      job,
      'Task stopped, but its final action state could not be verified. Check the current state before retrying the last action.',
    )
  }
}

async function nextPersistedEventSeq(runId: string): Promise<number> {
  if (!shouldUseDatabaseTaskJobs()) return 1
  const rows = await withTaskJobSchemaRepair(() => tursoExecute(
    'select max(seq) as max_seq from agent_task_events where run_id = ?',
    [runId],
  ))
  const maxSeq = Number(rows.rows[0]?.max_seq)
  return Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
}

function sendEventToSubscriber(subscriber: TaskJobSubscriber, event: SSEEvent): void {
  if (subscriber.closed) return
  try {
    subscriber.controller.enqueue(subscriber.encoder.encode(encodeSSE(event)))
  } catch {
    closeSubscriber(subscriber)
  }
}

function closeSubscriber(subscriber: TaskJobSubscriber): void {
  if (subscriber.closed) return
  subscriber.closed = true
  if (subscriber.keepAliveTimer) {
    clearInterval(subscriber.keepAliveTimer)
    subscriber.keepAliveTimer = null
  }
  try {
    subscriber.controller.close()
  } catch {
    // The stream may already be closed by the runtime.
  }
}

function closeJobSubscribers(job: TaskJob): void {
  for (const subscriber of job.subscribers.values()) {
    closeSubscriber(subscriber)
  }
  job.subscribers.clear()
}

function scheduleTerminalJobCleanup(job: TaskJob): void {
  if (job.terminalCleanupTimer || !job.terminalStatus || !job.terminalCommitted) return
  job.terminalCleanupTimer = setTimeout(() => {
    job.terminalCleanupTimer = null
    if (
      job.closed &&
      job.terminalStatus &&
      job.subscribers.size === 0 &&
      taskJobState.jobs.get(job.runId) === job
    ) {
      taskJobState.jobs.delete(job.runId)
    }
  }, taskJobMemoryTerminalTtlMs())
  job.terminalCleanupTimer.unref?.()
}

function recordTaskJobEvent(job: TaskJob, event: SSEEvent): void {
  if (job.persistenceFailure) return
  if (job.closed) return
  if (job.terminalStatus) return
  if (
    (event.type === 'text_delta' || event.type === 'progress_update') &&
    event.content.length === 0
  ) return

  if (event.type === 'browser_frame') {
    const createdAt = nowMs()
    const frameEvent = { ...event, runId: job.runId } as SSEEvent
    const frameVersion = Math.max(job.nextBrowserFrameVersion, createdAt)
    job.nextBrowserFrameVersion = frameVersion + 1
    const frame: RecordedTaskFrame = {
      version: frameVersion,
      event: frameEvent,
      createdAt,
    }
    job.updatedAt = createdAt
    job.latestBrowserFrame = frameEvent
    // Frames are ephemeral and deliberately do not consume the durable event
    // sequence. Flush older deltas before publishing the independently-versioned
    // latest frame so reconnect never advances a durable cursor past a gap.
    flushPendingTextPersistence(job)
    queueBrowserFramePersistence(job, frame)
    for (const subscriber of job.subscribers.values()) {
      sendEventToSubscriber(subscriber, frameEvent)
    }
    return
  }

  const seq = job.nextSeq++
  const createdAt = nowMs()
  const eventWithMeta = { ...event, seq, runId: job.runId } as SSEEvent
  const record: RecordedTaskEvent = { seq, event: eventWithMeta, createdAt }

  if (event.type === 'done') {
    job.terminalStatus = 'done'
    job.terminalError = null
    job.terminalRecord = record
  } else if (event.type === 'error') {
    job.terminalStatus = 'error'
    job.terminalError = event.message
    job.terminalRecord = record
  }

  job.updatedAt = createdAt
  job.events.push(record)
  // Without durable replay there is nowhere to recover an evicted sequence.
  // Keep the full active run so reconnects cannot be handed a permanent gap;
  // DB-backed runs may cap their process-local mirror because replay comes from
  // agent_task_events.
  if (shouldUseDatabaseTaskJobs() && job.events.length > TASK_JOB_MEMORY_EVENT_LIMIT) {
    job.events.splice(0, job.events.length - TASK_JOB_MEMORY_EVENT_LIMIT)
  }

  if (batchableEventChars(eventWithMeta) !== null) {
    flushPendingBrowserFramePersistence(job)
    queueDeltaPersistence(job, record)
  } else if (event.type === 'done' || event.type === 'error') {
    // The terminal event and terminal job row are committed together in
    // persistFinalJobState so a crash cannot leave a retryable row behind a
    // durable done/error cursor.
    flushPendingEventPersistence(job)
  } else {
    flushPendingEventPersistence(job)
    queueEventPersistence(job, [record])
  }
  if (!shouldUseDatabaseTaskJobs() && event.type !== 'done' && event.type !== 'error') {
    publishPersistedRecords(job, [record])
  }
}

class TaskJobEmitter implements AgentEventEmitter {
  constructor(private job: TaskJob) {}

  private scopedId(id: string): string {
    return this.job.claimAttempts && this.job.claimAttempts > 1
      ? `attempt:${this.job.claimAttempts}:${id}`
      : id
  }

  get isClosed(): boolean {
    return this.job.closed
  }

  get terminalStatus(): 'done' | 'error' | null {
    return this.job.terminalStatus
  }

  async flush(): Promise<void> {
    flushPendingEventPersistence(this.job)
    await this.job.persistChain
    await awaitTaskJobPersistenceIdle(this.job)
    if (this.job.persistenceFailure) {
      throw this.job.persistenceFailure
    }
    if (this.job.requeueReason === 'lease_lost') {
      throw new TaskJobClaimLostError(this.job.runId)
    }
  }

  heartbeat(): void {
    recordTaskJobEvent(this.job, { type: 'heartbeat', timestamp: nowMs() })
  }

  textDelta(content: string): void {
    recordTaskJobEvent(this.job, { type: 'text_delta', content })
  }

  progressUpdate(content: string, placement: ProgressUpdatePlacement = {}): void {
    recordTaskJobEvent(this.job, {
      type: 'progress_update',
      content,
      ...placement,
      afterToolId: placement.afterToolId
        ? this.scopedId(placement.afterToolId)
        : undefined,
    })
  }

  reasoningDelta(content: string): void {
    recordTaskJobEvent(this.job, { type: 'reasoning_delta', content })
  }

  reasoningDone(): void {
    recordTaskJobEvent(this.job, { type: 'reasoning_done' })
  }

  toolStart(id: string, name: string, args: Record<string, unknown>, metadata: ToolStartMetadata = {}): void {
    recordTaskJobEvent(this.job, {
      type: 'tool_start',
      id: this.scopedId(id),
      name,
      args,
      ...(metadata.provisional ? { provisional: true } : {}),
    })
  }

  toolResult(id: string, name: string, result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult): void {
    recordTaskJobEvent(this.job, {
      type: 'tool_result',
      id: this.scopedId(id),
      name,
      result: stripInlineBinaryFromEventValue(result) as SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult,
    })
  }

  browserFrame(frame: string): void {
    recordTaskJobEvent(this.job, { type: 'browser_frame', frame, timestamp: nowMs() })
  }

  terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string): void {
    recordTaskJobEvent(this.job, { type: 'terminal_output', id: this.scopedId(id), stream, data })
  }

  fileContentStart(id: string, path: string, toolName?: string): void {
    recordTaskJobEvent(this.job, { type: 'file_content_start', id: this.scopedId(id), path, toolName })
  }

  fileContentDelta(id: string, content: string): void {
    recordTaskJobEvent(this.job, { type: 'file_content_delta', id: this.scopedId(id), content })
  }

  plan(items: string[]): void {
    recordTaskJobEvent(this.job, { type: 'plan', items })
  }

  artifactCreated(artifact: Artifact): void {
    const { imageDataUrl: _inlineImage, ...durableArtifact } = artifact
    recordTaskJobEvent(this.job, {
      type: 'artifact_created',
      artifact: this.job.claimAttempts && this.job.claimAttempts > 1
        ? { ...durableArtifact, id: this.scopedId(artifact.id) }
        : durableArtifact,
    })
  }

  creditEvent(entry: CreditLedgerEvent): void {
    recordTaskJobEvent(this.job, { type: 'credit_event', entry })
  }

  stepAdvance(status: StepAdvanceStatus = 'done', reason?: string): void {
    recordTaskJobEvent(this.job, { type: 'step_advance', status, reason })
  }

  done(usage?: CreditTokenUsage): void {
    recordTaskJobEvent(this.job, { type: 'done', usage })
  }

  error(message: unknown): void {
    recordTaskJobEvent(this.job, {
      type: 'error',
      message: userErrorMessage(message, 'The task stopped before it finished. Please try again.'),
    })
  }

  close(): void {
    if (this.job.closed) return
    if (this.job.terminalStatus && !this.job.terminalCommitted) {
      this.job.closeRequested = true
      return
    }
    this.job.closed = true
    closeJobSubscribers(this.job)
  }
}

function replaceTerminalRecordWithError(job: TaskJob, message: string): void {
  if (!job.terminalRecord) return
  const replacementEvent = {
    type: 'error',
    message,
    seq: job.terminalRecord.seq,
    runId: job.runId,
  } satisfies SSEEvent
  job.terminalStatus = 'error'
  job.terminalError = message
  job.terminalRecord = {
    ...job.terminalRecord,
    event: replacementEvent,
  }
  const eventIndex = job.events.findIndex((record) => record.seq === job.terminalRecord?.seq)
  if (eventIndex >= 0) job.events[eventIndex] = job.terminalRecord
}

function markTaskJobCancelled(job: TaskJob): void {
  job.cancelRequested = true
  job.status = 'cancelled'
  replaceTerminalRecordWithError(job, 'Task stopped.')
}

function downgradeSuccessfulTerminalAfterPersistenceFailure(job: TaskJob): void {
  if (!job.persistenceFailure || job.terminalStatus !== 'done' || !job.terminalRecord) return
  replaceTerminalRecordWithError(job, 'Task progress could not be saved safely. Please try again.')
}

async function stageContiguousPersistenceFailureTerminal(job: TaskJob): Promise<void> {
  if (!job.persistenceFailure) return
  const seq = await nextPersistedEventSeq(job.runId)
  const createdAt = nowMs()
  const message = 'Task progress could not be saved safely. Please try again.'
  const event = {
    type: 'error',
    message,
    seq,
    runId: job.runId,
  } satisfies SSEEvent
  const record: RecordedTaskEvent = { seq, event, createdAt }

  clearPendingTextPersistenceTimer(job)
  clearPendingBrowserFramePersistenceTimer(job)
  job.pendingEventPersistence = []
  job.eventPersistenceQueued = false
  job.pendingTextPersistence = []
  job.pendingTextPersistenceChars = 0
  job.pendingBrowserFramePersistence = null
  job.events = job.events.filter((candidate) => candidate.seq < seq)
  job.events.push(record)
  job.nextSeq = seq + 1
  job.terminalStatus = 'error'
  job.terminalError = message
  job.terminalRecord = record
  job.updatedAt = createdAt
  // The failed/later records are deliberately abandoned. Final persistence is
  // now allowed only for this exact max(persisted seq)+1 terminal record.
  job.persistenceFailure = null
}

async function runTaskJob(
  job: TaskJob,
  runner: (emitter: AgentEventEmitter, signal: AbortSignal) => Promise<void>,
  options: {
    persistStart?: boolean
    beforeFinalCommit?: () => Promise<void>
  } = {},
): Promise<void> {
  const emitter = new TaskJobEmitter(job)
  job.emitter = emitter
  job.status = 'running'
  job.updatedAt = nowMs()
  if (options.persistStart !== false) {
    queuePersistence(job, async () => {
      await persistJob(job)
    })
  }

  try {
    await runner(emitter, job.abortController.signal)
    if (!job.requeueRequested && !emitter.terminalStatus) {
      emitter.error('The task stopped before it finished. Please try again.')
    }
  } catch (error) {
    if (!job.requeueRequested && !emitter.terminalStatus) {
      emitter.error(job.cancelRequested ? 'Task stopped.' : userErrorMessage(error, 'The task stopped before it finished. Please try again.'))
    }
  } finally {
    if (job.requeueRequested) {
      job.status = 'queued'
      job.updatedAt = nowMs()
      flushPendingEventPersistence(job)
      await job.persistChain.catch(() => undefined)
      await awaitTaskJobPersistenceIdle(job).catch(() => undefined)
      emitter.close()
      return
    }

    // Persist all non-terminal progress before cleanup. The staged done/error
    // record is intentionally excluded and remains invisible until the final
    // job-row transaction below succeeds.
    flushPendingEventPersistence(job)
    await job.persistChain.catch(() => undefined)
    await awaitTaskJobPersistenceIdle(job).catch(() => undefined)
    if (job.persistenceFailure) {
      await stageContiguousPersistenceFailureTerminal(job).catch((error) => {
        job.persistenceFailure = error
      })
    }
    downgradeSuccessfulTerminalAfterPersistenceFailure(job)

    if (options.beforeFinalCommit) {
      try {
        await options.beforeFinalCommit()
      } catch (error) {
        if (!job.claimWorkerId) throw error
        console.error('[TaskJobs] Pre-terminal execution fence failed; leaving the claim non-terminal', {
          runId: job.runId,
          workerId: job.claimWorkerId,
          attempts: job.claimAttempts,
          error: error instanceof Error ? error.message : String(error),
        })
        job.requeueRequested = true
        job.requeueReason = 'lease_lost'
        job.closed = true
        closeJobSubscribers(job)
        return
      }
    }

    // Cancellation may arrive after done/error has been staged but before the
    // destructive cleanup barrier commits it. Convert that provisional terminal
    // to cancellation and preserve uncertainty for any unmatched non-idempotent
    // action before the terminal row/event become visible.
    await applyCancellationTerminalSafety(job)

    if (job.persistenceFailure) {
      if (job.claimWorkerId) {
        job.requeueRequested = true
        job.requeueReason = 'lease_lost'
        job.closed = true
        closeJobSubscribers(job)
        return
      }
      let retryAttempt = 0
      while (job.persistenceFailure) {
        await stageContiguousPersistenceFailureTerminal(job).catch((error) => {
          job.persistenceFailure = error
        })
        if (!job.persistenceFailure) break
        retryAttempt += 1
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * (2 ** Math.min(6, retryAttempt - 1)))))
      }
    }

    job.completedAt = nowMs()
    job.updatedAt = job.completedAt
    job.status = job.cancelRequested
      ? 'cancelled'
      : job.terminalStatus === 'done'
        ? 'done'
        : 'error'
    const finalized = await persistFinalJobState(job)
    if (!finalized && job.claimWorkerId) {
      job.requeueRequested = true
      job.requeueReason = 'lease_lost'
      job.closed = true
      closeJobSubscribers(job)
    } else if (finalized) {
      job.terminalCommitted = true
      if (job.terminalRecord) {
        for (const subscriber of job.subscribers.values()) {
          sendEventToSubscriber(subscriber, job.terminalRecord.event)
        }
      }
      await clearLiveDirectivesForRun(job.userId, job.runId).catch((error) => {
        console.warn('[TaskJobs] Terminal live directive cleanup failed', {
          runId: job.runId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      emitter.close()
      scheduleTerminalJobCleanup(job)
    }
  }
}

async function reserveInProcessTaskJob(
  job: TaskJob,
  conversationInsert?: TaskStartConversationInsert | null,
): Promise<{ created: boolean; status: TaskJobStatus }> {
  const reservationNow = nowMs()
  return withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    const stoppedBeforeStart = await transaction.execute({
      sql: `
        select 1 as cancelled
        from agent_task_prestart_cancellations
        where queue_name = ?
          and user_id = ?
          and conversation_id = ?
          and run_id = ?
          and expires_at_ms > ?
        limit 1
      `,
      args: [job.queueName, job.userId, job.conversationId, job.runId, reservationNow],
    })
    if (stoppedBeforeStart.rows[0]) {
      throw new TaskPreStartCancelledError(job.runId, job.conversationId)
    }

    const activeForConversation = await transaction.execute({
      sql: `
        select run_id, status
        from agent_task_jobs
        where user_id = ?
          and conversation_id = ?
          and run_id != ?
          and status in ('queued', 'running')
          and terminal_status is null
        order by updated_at_ms desc
        limit 1
      `,
      args: [job.userId, job.conversationId, job.runId],
    })
    const activeRow = activeForConversation.rows[0]
    if (typeof activeRow?.run_id === 'string') {
      throw new TaskConversationConflictError(activeRow.run_id, normalizeStatus(activeRow.status))
    }

    const inserted = await transaction.execute({
      sql: `
        insert into agent_task_jobs (
          run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
          started_at_ms, updated_at_ms, completed_at_ms, payload_json, worker_id,
          lease_expires_at_ms, attempts, cancel_requested, accepts_live_directives
        )
        values (?, ?, ?, ?, 'running', null, null, ?, ?, null, null, ?, ?, 1, 0, ?)
        on conflict(run_id) do nothing
      `,
      args: [
        job.runId,
        job.userId,
        job.conversationId,
        job.queueName,
        job.startedAt,
        job.updatedAt,
        job.claimWorkerId,
        job.startedAt + TASK_JOB_WORKER_LEASE_MS,
        job.acceptsLiveDirectives ? 1 : 0,
      ],
    })
    if (inserted.rowsAffected === 1) {
      if (conversationInsert) {
        const conversationResult = await transaction.execute(conversationInsert)
        if (conversationResult.rowsAffected !== 1) {
          throw new TaskConversationPersistenceConflictError()
        }
      }
      return { created: true, status: 'queued' as const }
    }

    const existing = await transaction.execute({
      sql: `
        select user_id, conversation_id, queue_name, status
        from agent_task_jobs
        where run_id = ?
        limit 1
      `,
      args: [job.runId],
    })
    const row = existing.rows[0]
    if (
      !row ||
      row.user_id !== job.userId ||
      row.conversation_id !== job.conversationId ||
      row.queue_name !== job.queueName
    ) {
      throw new Error('Task run id is already owned by a different task.')
    }
    return { created: false, status: normalizeStatus(row.status) }
  }))
}

export async function startTaskJob(input: {
  runId: string
  userId: string
  conversationId: string
  runner: (
    emitter: AgentEventEmitter,
    signal: AbortSignal,
    context: {
      registerPreTerminalCleanup: (cleanup: () => Promise<void>) => void
      registerInflightToolDrain: (drain: InflightToolDrain) => void
    },
  ) => Promise<void>
  acceptsLiveDirectives?: boolean
  conversationInsert?: TaskStartConversationInsert | null
}): Promise<{ runId: string; status: TaskJobStatus }> {
  const queueName = taskQueueName()
  const existing = taskJobState.jobs.get(input.runId)
  if (existing) {
    if (existing.requeueRequested || (existing.closed && !existing.terminalCommitted)) {
      taskJobState.jobs.delete(input.runId)
    } else {
      return { runId: existing.runId, status: existing.status }
    }
  }
  if (hasMemoryPreStartCancellation(queueName, input.userId, input.conversationId, input.runId)) {
    throw new TaskPreStartCancelledError(input.runId, input.conversationId)
  }
  const activeForConversation = Array.from(taskJobState.jobs.values()).find((job) => (
    job.userId === input.userId &&
    job.conversationId === input.conversationId &&
    !job.requeueRequested &&
    !job.closed &&
    (job.status === 'queued' || job.status === 'running')
  ))
  if (activeForConversation) {
    throw new TaskConversationConflictError(activeForConversation.runId, activeForConversation.status)
  }

  const startedAt = nowMs()
  const databaseBacked = shouldUseDatabaseTaskJobs()
  const inProcessWorkerId = databaseBacked ? `in-process:${randomUUID()}` : null
  const job: TaskJob = {
    runId: input.runId,
    userId: input.userId,
    conversationId: input.conversationId,
    queueName,
    status: databaseBacked ? 'running' : 'queued',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    terminalStatus: null,
    terminalError: null,
    terminalRecord: null,
    terminalCommitted: false,
    closeRequested: false,
    cancelRequested: false,
    acceptsLiveDirectives: input.acceptsLiveDirectives !== false,
    closed: false,
    nextSeq: 1,
    nextBrowserFrameVersion: 1,
    latestBrowserFrame: null,
    events: [],
    subscribers: new Map(),
    abortController: new AbortController(),
    emitter: null,
    promise: null,
    persistChain: Promise.resolve(),
    persistenceFailure: null,
    pendingEventPersistence: [],
    eventPersistenceQueued: false,
    pendingTextPersistence: [],
    pendingTextPersistenceChars: 0,
    pendingTextPersistenceTimer: null,
    pendingBrowserFramePersistence: null,
    pendingBrowserFramePersistenceTimer: null,
    terminalCleanupTimer: null,
    requeueRequested: false,
    requeueReason: null,
    claimWorkerId: inProcessWorkerId,
    claimAttempts: databaseBacked ? 1 : null,
    inflightToolDrain: null,
  }

  if (shouldUseDatabaseTaskJobs()) {
    const reservation = await reserveInProcessTaskJob(job, input.conversationInsert)
    if (!reservation.created) return { runId: job.runId, status: reservation.status }
    scheduleTaskJobRetentionMaintenance(startedAt)
  }

  taskJobState.jobs.set(job.runId, job)
  const preTerminalCleanups: Array<() => Promise<void>> = []
  const stopForLocalClaimLoss = () => {
    if (job.requeueRequested || job.terminalCommitted) return
    job.requeueRequested = true
    job.requeueReason = 'lease_lost'
    job.closed = true
    closeJobSubscribers(job)
    job.abortController.abort()
    if (taskJobState.jobs.get(job.runId) === job) taskJobState.jobs.delete(job.runId)
  }

  let localRefreshInFlight = false
  const localRefreshTimer = databaseBacked && job.claimWorkerId && job.claimAttempts !== null
    ? setInterval(() => {
        if (localRefreshInFlight || job.terminalCommitted || job.requeueRequested) return
        localRefreshInFlight = true
        void refreshTaskJobClaim(
          job.runId,
          job.claimWorkerId!,
          TASK_JOB_WORKER_LEASE_MS,
          job.claimAttempts!,
        ).then((refreshed) => {
          if (!refreshed) stopForLocalClaimLoss()
        }).catch((error) => {
          console.error('[TaskJobs] Failed to refresh in-process task lease', {
            runId: job.runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }).finally(() => {
          localRefreshInFlight = false
        })
      }, TASK_JOB_WORKER_REFRESH_MS)
    : null

  let localCancelPollInFlight = false
  const localCancelTimer = databaseBacked && job.claimWorkerId && job.claimAttempts !== null
    ? setInterval(() => {
        if (localCancelPollInFlight || job.terminalCommitted || job.requeueRequested) return
        localCancelPollInFlight = true
        void taskJobControlState(job.runId, job.claimWorkerId!, job.claimAttempts!).then((controlState) => {
          if (controlState === 'cancelled') {
            job.cancelRequested = true
            job.abortController.abort()
          } else if (controlState === 'lost') {
            stopForLocalClaimLoss()
          }
        }).catch((error) => {
          console.error('[TaskJobs] Failed to poll in-process task cancellation', {
            runId: job.runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }).finally(() => {
          localCancelPollInFlight = false
        })
      }, TASK_JOB_CANCEL_POLL_MS)
    : null

  const runLocalPreTerminalBarrier = async () => {
    let failedAttempts = 0
    while (true) {
      try {
        if (job.claimWorkerId && job.claimAttempts !== null) {
          const ownedBeforeCleanup = await refreshTaskJobClaim(
            job.runId,
            job.claimWorkerId,
            TASK_JOB_WORKER_LEASE_MS,
            job.claimAttempts,
          )
          if (!ownedBeforeCleanup) throw new TaskJobClaimLostError(job.runId)
        }
        const initialDrain = job.inflightToolDrain
          ? await job.inflightToolDrain(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS)
          : { settled: true, pendingCount: 0, nonIdempotentPending: false, pendingToolNames: [] }
        const runCleanups = async () => {
          for (const cleanup of preTerminalCleanups) await cleanup()
        }
        await runCleanups()
        if (!initialDrain.settled && job.inflightToolDrain) {
          const finalDrain = await job.inflightToolDrain(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS)
          if (!finalDrain.settled) {
            throw new Error(`Task cleanup is waiting for ${finalDrain.pendingCount} in-flight operation(s): ${finalDrain.pendingToolNames.join(', ')}`)
          }
          // An abort-raced operation may have recreated workspace state after
          // the first destroy. Once every handler is settled, clean once more
          // so terminal visibility cannot leave a late sandbox behind.
          await runCleanups()
        }
        if (job.claimWorkerId && job.claimAttempts !== null) {
          const controlState = await taskJobControlState(job.runId, job.claimWorkerId, job.claimAttempts)
          if (controlState === 'lost') throw new TaskJobClaimLostError(job.runId)
          if (controlState === 'cancelled') markTaskJobCancelled(job)
          const ownedAfterCleanup = await refreshTaskJobClaim(
            job.runId,
            job.claimWorkerId,
            TASK_JOB_WORKER_LEASE_MS,
            job.claimAttempts,
          )
          if (!ownedAfterCleanup) throw new TaskJobClaimLostError(job.runId)
        }
        return
      } catch (error) {
        if (error instanceof TaskJobClaimLostError) throw error
        failedAttempts += 1
        console.error('[TaskJobs] In-process pre-terminal fence failed; terminal state remains hidden while cleanup retries', {
          runId: job.runId,
          attempt: failedAttempts,
          error: error instanceof Error ? error.message : String(error),
        })
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 500 * (2 ** Math.min(6, failedAttempts - 1)))))
      }
    }
  }
  job.promise = runTaskJob(job, (emitter, signal) => input.runner(emitter, signal, {
    registerPreTerminalCleanup: (cleanup) => {
      preTerminalCleanups.push(cleanup)
    },
    registerInflightToolDrain: (drain) => {
      job.inflightToolDrain = drain
    },
  }), {
    persistStart: !databaseBacked,
    beforeFinalCommit: runLocalPreTerminalBarrier,
  })
  void job.promise.catch((error) => {
    console.error('[TaskJobs] In-process task finalization failed', {
      runId: job.runId,
      error: error instanceof Error ? error.message : String(error),
    })
    // DB-backed streams read only durable events. Never fabricate an
    // unsequenced in-memory terminal here; leave the exact claim nonterminal so
    // lease-expiry recovery can destroy the sandbox and append a contiguous
    // durable error.
    job.closed = true
    closeJobSubscribers(job)
  }).finally(() => {
    if (localRefreshTimer) clearInterval(localRefreshTimer)
    if (localCancelTimer) clearInterval(localCancelTimer)
    if (
      (job.requeueRequested || (job.closed && !job.terminalCommitted)) &&
      taskJobState.jobs.get(job.runId) === job
    ) {
      taskJobState.jobs.delete(job.runId)
    }
  })
  return { runId: job.runId, status: job.status }
}

export async function enqueueTaskJob(input: {
  runId: string
  userId: string
  conversationId: string
  payload: TaskJobPayload
  initialEvents?: SSEEvent[]
  conversationInsert?: TaskStartConversationInsert | null
}): Promise<{ runId: string; status: TaskJobStatus }> {
  if (!shouldUseDatabaseTaskJobs()) {
    throw new Error('External task worker mode requires Turso to be configured.')
  }

  const serializedPayload = serializeTaskJobPayload(input.payload)
  const createdAt = nowMs()
  const queueName = taskQueueName()
  if (hasMemoryPreStartCancellation(queueName, input.userId, input.conversationId, input.runId, createdAt)) {
    throw new TaskPreStartCancelledError(input.runId, input.conversationId)
  }
  const status = await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction): Promise<TaskJobStatus> => {
    const stoppedBeforeStart = await transaction.execute({
      sql: `
        select 1 as cancelled
        from agent_task_prestart_cancellations
        where queue_name = ?
          and user_id = ?
          and conversation_id = ?
          and run_id = ?
          and expires_at_ms > ?
        limit 1
      `,
      args: [queueName, input.userId, input.conversationId, input.runId, createdAt],
    })
    if (stoppedBeforeStart.rows[0]) {
      throw new TaskPreStartCancelledError(input.runId, input.conversationId)
    }

    const activeForConversation = await transaction.execute({
      sql: `
        select run_id, status
        from agent_task_jobs
        where user_id = ?
          and conversation_id = ?
          and run_id != ?
          and status in ('queued', 'running')
          and terminal_status is null
        order by updated_at_ms desc
        limit 1
      `,
      args: [input.userId, input.conversationId, input.runId],
    })
    const activeRow = activeForConversation.rows[0]
    if (typeof activeRow?.run_id === 'string') {
      throw new TaskConversationConflictError(activeRow.run_id, normalizeStatus(activeRow.status))
    }

    const inserted = await transaction.execute({
      sql: `
          insert into agent_task_jobs (
            run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
            started_at_ms, updated_at_ms, completed_at_ms, payload_json, worker_id,
            lease_expires_at_ms, attempts, cancel_requested, accepts_live_directives
          )
          values (?, ?, ?, ?, 'queued', null, null, ?, ?, null, ?, null, null, 0, 0, ?)
          on conflict(run_id) do nothing
        `,
      args: [
          input.runId,
          input.userId,
          input.conversationId,
          queueName,
          createdAt,
          createdAt,
          serializedPayload,
          input.payload.kind !== 'background_probe' && input.payload.directChat === false ? 1 : 0,
        ],
    })

    if (inserted.rowsAffected === 1) {
      if (input.conversationInsert) {
        const conversationResult = await transaction.execute(input.conversationInsert)
        if (conversationResult.rowsAffected !== 1) {
          throw new TaskConversationPersistenceConflictError()
        }
      }
      let seq = 1
      for (const rawEvent of input.initialEvents || []) {
        const event = { ...rawEvent, seq, runId: input.runId } as SSEEvent
        await transaction.execute({
          sql: `
              insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
              values (?, ?, ?, ?)
            `,
          args: [input.runId, seq, stringifyEventForPersistence(event), createdAt],
        })
        seq++
      }
      return 'queued'
    }

    const existing = await transaction.execute({
      sql: `
        select user_id, conversation_id, queue_name, status
        from agent_task_jobs
        where run_id = ?
        limit 1
      `,
      args: [input.runId],
    })
    const row = existing.rows[0]
    if (
      !row ||
      row.user_id !== input.userId ||
      row.conversation_id !== input.conversationId ||
      row.queue_name !== queueName
    ) {
      throw new Error('Task run id is already owned by a different task.')
    }
    return normalizeStatus(row.status)
  }))
  // Retention removes only expired cancellation markers and already-terminal
  // jobs. It is maintenance, not part of accepting this run, so it must not
  // delay the durable queue/conversation commit or the initial SSE response.
  scheduleTaskJobRetentionMaintenance(createdAt)
  return { runId: input.runId, status }
}

async function loadPersistedTaskPayload(runId: string): Promise<TaskJobPayload | null> {
  if (!shouldUseDatabaseTaskJobs()) return null
  const queueName = taskQueueName()
  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select payload_json
      from agent_task_jobs
      where run_id = ? and queue_name = ?
      limit 1
    `,
    [runId, queueName],
  ))
  const raw = result.rows[0]?.payload_json
  return parseTaskPayload(raw)
}

export async function attachTaskJobStartupPlan(
  runId: string,
  startupPlan: ChatTaskPayload['startupPlan'] | null | undefined,
): Promise<boolean> {
  const normalized = normalizeStartupPlan(startupPlan)
  if (!shouldUseDatabaseTaskJobs()) return false
  const queueName = taskQueueName()
  const rows = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select payload_json
      from agent_task_jobs
      where run_id = ? and queue_name = ?
      limit 1
    `,
    [runId, queueName],
  ))
  const payload = parseTaskPayload(rows.rows[0]?.payload_json)
  if (!payload || payload.kind === 'background_probe') return false
  const nextPayload: ChatTaskPayload = {
    ...payload,
    startupPlanExpected: false,
    ...(normalized ? { startupPlan: normalized } : {}),
  }
  const updated = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      update agent_task_jobs
      set payload_json = ?
      where run_id = ?
        and queue_name = ?
        and terminal_status is null
        and status in ('queued', 'running')
    `,
    [JSON.stringify(nextPayload), runId, queueName],
  ))
  return updated.rowsAffected === 1
}

export async function waitForTaskJobStartupPlan(
  runId: string,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<ChatTaskPayload['startupPlan'] | undefined> {
  const deadlineMs = options.deadlineMs && Number.isFinite(options.deadlineMs)
    ? options.deadlineMs
    : Date.now()
  while (!options.signal?.aborted) {
    const remainingMs = Math.max(1, deadlineMs - Date.now())
    const payload = await Promise.race([
      loadPersistedTaskPayload(runId),
      new Promise<typeof STARTUP_PLAN_READ_TIMEOUT>((resolve) => {
        setTimeout(() => resolve(STARTUP_PLAN_READ_TIMEOUT), Math.min(TASK_JOB_STARTUP_PLAN_READ_TIMEOUT_MS, remainingMs))
      }),
    ])
    if (payload === STARTUP_PLAN_READ_TIMEOUT) {
      if (Date.now() > deadlineMs) break
      await new Promise(resolve => setTimeout(resolve, TASK_JOB_STARTUP_PLAN_POLL_MS))
      continue
    }
    if (payload?.kind !== 'background_probe') {
      const chatPayload = payload as ChatTaskPayload | null
      const plan = normalizeStartupPlan(chatPayload?.startupPlan)
      if (plan) return plan
      if (chatPayload?.startupPlanExpected === false) break
    }
    if (Date.now() > deadlineMs) break
    await new Promise(resolve => setTimeout(resolve, TASK_JOB_STARTUP_PLAN_POLL_MS))
  }
  return undefined
}

export async function findActiveTaskJobForConversation(
  userId: string,
  conversationId: string,
): Promise<ActiveTaskJobSummary | null> {
  const queueName = taskQueueName()
  const inMemory = Array.from(taskJobState.jobs.values())
    .filter((job) => (
      job.userId === userId &&
      job.conversationId === conversationId &&
      job.queueName === queueName &&
      !job.requeueRequested &&
      !job.closed &&
      !job.terminalStatus &&
      !job.terminalCommitted &&
      (job.status === 'queued' || job.status === 'running')
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (inMemory) {
    return {
      runId: inMemory.runId,
      userId: inMemory.userId,
      conversationId: inMemory.conversationId,
      queueName: inMemory.queueName,
      status: inMemory.status === 'running' ? 'running' : 'queued',
      startedAt: inMemory.startedAt,
      updatedAt: inMemory.updatedAt,
      attempts: inMemory.claimAttempts ?? 0,
      acceptsLiveDirectives: inMemory.acceptsLiveDirectives && !inMemory.cancelRequested,
      cancelRequested: inMemory.cancelRequested,
    }
  }

  if (!shouldUseDatabaseTaskJobs()) return null

  const loadActive = () => withTaskJobSchemaRepair(() => tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, started_at_ms, updated_at_ms, attempts,
             payload_json, accepts_live_directives, cancel_requested
      from agent_task_jobs
      where user_id = ?
        and conversation_id = ?
        and queue_name = ?
        and status in ('queued', 'running')
        and terminal_status is null
      order by updated_at_ms desc
      limit 1
    `,
    [userId, conversationId, queueName],
  ))
  const result = await loadActive()
  const active = rowToActiveTaskJobSummary(result.rows[0] as TaskJobRow | undefined)
  if (!active) return null

  // Stale-task reconciliation is only relevant when an active candidate was
  // found. The common new-task path now needs one remote read instead of an
  // unconditional reconciliation read followed by the actual lookup.
  const reconciled = await reconcileExpiredDurableTaskJob({ userId, conversationId }).catch((error) => {
    console.error('[TaskJobs] Failed to reconcile an expired in-process conversation task', {
      userId,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  })
  if (!reconciled) return active

  const refreshed = await loadActive()
  return rowToActiveTaskJobSummary(refreshed.rows[0] as TaskJobRow | undefined)
}

export async function findReplayableTaskJobForConversation(
  userId: string,
  conversationId: string,
): Promise<ActiveTaskJobSummary | null> {
  const active = await findActiveTaskJobForConversation(userId, conversationId)
  if (active) return active
  if (!shouldUseDatabaseTaskJobs()) return null

  const queueName = taskQueueName()
  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
             started_at_ms, updated_at_ms, attempts, payload_json, accepts_live_directives, cancel_requested
      from agent_task_jobs
      where user_id = ?
        and conversation_id = ?
        and queue_name = ?
        and exists (
          select 1
          from agent_task_events
          where agent_task_events.run_id = agent_task_jobs.run_id
        )
      order by updated_at_ms desc
      limit 1
    `,
    [userId, conversationId, queueName],
  ))
  return rowToActiveTaskJobSummary(result.rows[0] as TaskJobRow | undefined)
}

export async function findTaskJobForRun(
  userId: string,
  conversationId: string,
  runId: string,
): Promise<ActiveTaskJobSummary | null> {
  const queueName = taskQueueName()
  const inMemory = taskJobState.jobs.get(runId)
  if (
    inMemory &&
    inMemory.userId === userId &&
    inMemory.conversationId === conversationId &&
    inMemory.queueName === queueName &&
    !inMemory.requeueRequested &&
    ((!inMemory.closed && !inMemory.terminalCommitted) || inMemory.terminalCommitted)
  ) {
    const terminalVisible = inMemory.terminalCommitted
    return {
      runId: inMemory.runId,
      userId: inMemory.userId,
      conversationId: inMemory.conversationId,
      queueName: inMemory.queueName,
      status: terminalVisible
        ? inMemory.status
        : inMemory.status === 'queued' ? 'queued' : 'running',
      startedAt: inMemory.startedAt,
      updatedAt: inMemory.updatedAt,
      attempts: inMemory.claimAttempts ?? 0,
      terminalStatus: terminalVisible ? inMemory.terminalStatus : null,
      terminalError: terminalVisible ? inMemory.terminalError : null,
      acceptsLiveDirectives: inMemory.acceptsLiveDirectives && !inMemory.cancelRequested && !terminalVisible,
      cancelRequested: inMemory.cancelRequested,
    }
  }

  if (!shouldUseDatabaseTaskJobs()) return null
  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
             started_at_ms, updated_at_ms, attempts, payload_json, accepts_live_directives, cancel_requested
      from agent_task_jobs
      where user_id = ?
        and conversation_id = ?
        and run_id = ?
        and queue_name = ?
      limit 1
    `,
    [userId, conversationId, runId, queueName],
  ))
  return rowToActiveTaskJobSummary(result.rows[0] as TaskJobRow | undefined)
}

export async function findActiveTaskJobForUser(
  userId: string,
): Promise<ActiveTaskJobSummary | null> {
  const queueName = taskQueueName()
  const inMemory = Array.from(taskJobState.jobs.values())
    .filter((job) => (
      job.userId === userId &&
      job.queueName === queueName &&
      !job.requeueRequested &&
      !job.closed &&
      !job.terminalStatus &&
      !job.terminalCommitted &&
      (job.status === 'queued' || job.status === 'running')
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (inMemory) {
    return {
      runId: inMemory.runId,
      userId: inMemory.userId,
      conversationId: inMemory.conversationId,
      queueName: inMemory.queueName,
      status: inMemory.status === 'running' ? 'running' : 'queued',
      startedAt: inMemory.startedAt,
      updatedAt: inMemory.updatedAt,
      attempts: inMemory.claimAttempts ?? 0,
      acceptsLiveDirectives: inMemory.acceptsLiveDirectives && !inMemory.cancelRequested,
      cancelRequested: inMemory.cancelRequested,
    }
  }

  if (!shouldUseDatabaseTaskJobs()) return null

  await reconcileExpiredDurableTaskJob({ userId }).catch((error) => {
    console.error('[TaskJobs] Failed to reconcile an expired in-process user task', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, started_at_ms, updated_at_ms, attempts,
             payload_json, accepts_live_directives, cancel_requested
      from agent_task_jobs
      where user_id = ?
        and queue_name = ?
        and status in ('queued', 'running')
        and terminal_status is null
      order by updated_at_ms desc
      limit 1
    `,
    [userId, queueName],
  ))
  return rowToActiveTaskJobSummary(result.rows[0] as TaskJobRow | undefined)
}

export async function claimNextTaskJob(workerId: string, leaseMs = TASK_JOB_WORKER_LEASE_MS): Promise<ClaimedTaskJob | null> {
  if (!workerId) throw new Error('Missing worker id')
  if (!shouldUseDatabaseTaskJobs()) {
    throw new Error('Task worker requires Turso to be configured.')
  }

  const now = nowMs()
  const leaseExpiresAt = now + leaseMs
  const queueName = taskQueueName()
  const maxAttempts = taskWorkerMaxAttempts()
  const workerFreshAfterMs = now - taskWorkerStaleMs()
  await ensureTaskJobSchema().catch((error) => {
    console.error('[TaskJobs] Cannot safely claim tasks before the full task schema is ready', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  })
  await ensureTaskWorkerHeartbeatSchema().catch((error) => {
    console.error('[TaskJobs] Cannot safely claim tasks without worker heartbeat fencing', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  })
  const claimantHeartbeat = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select 1 as ready
      from agent_task_workers
      where worker_id = ?
        and queue_name = ?
        and status = 'idle'
        and current_run_id is null
        and last_seen_at_ms >= ?
        and orchestration_protocol_version = ?
      limit 1
    `,
    [workerId, queueName, workerFreshAfterMs, TASK_ORCHESTRATION_PROTOCOL_VERSION],
  ))
  if (!claimantHeartbeat.rows[0]) {
    throw new Error(`Worker "${workerId}" must publish a fresh idle heartbeat before claiming a task.`)
  }
  const protectLiveWorkerClaims = true

  type ClaimResult = ClaimedTaskJob |
    { terminal: true; runId: string; userId: string } |
    { cancellationFence: true; runId: string; userId: string; conversationId: string } |
    StaleTaskTerminalFence |
    null
  const result = await tursoTransaction('write', async (transaction): Promise<ClaimResult> => {
    const staleTerminalCandidates = await transaction.execute({
      sql: `
        select run_id, user_id, conversation_id, attempts,
          (select event_json
           from agent_task_events
           where agent_task_events.run_id = agent_task_jobs.run_id
           order by seq desc
           limit 1) as latest_event_json
        from agent_task_jobs
        where status = 'running'
          and queue_name = ?
          and terminal_status is null
          and cancel_requested = 0
          and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
          and (
            worker_id is null
            or not exists (
              select 1
              from agent_task_workers
              where agent_task_workers.worker_id = agent_task_jobs.worker_id
                and agent_task_workers.queue_name = agent_task_jobs.queue_name
                and agent_task_workers.current_run_id = agent_task_jobs.run_id
                and agent_task_workers.status = 'running'
                and agent_task_workers.last_seen_at_ms >= ?
            )
          )
          and coalesce((
            select case
              when json_valid(agent_task_events.event_json)
                then json_extract(agent_task_events.event_json, '$.type')
              else ''
            end
            from agent_task_events
            where agent_task_events.run_id = agent_task_jobs.run_id
            order by agent_task_events.seq desc
            limit 1
          ), '') in ('done', 'error')
        order by updated_at_ms asc
        limit 1
      `,
      args: [queueName, now, workerFreshAfterMs],
    })
    for (const candidate of staleTerminalCandidates.rows) {
      if (
        typeof candidate.run_id !== 'string' ||
        typeof candidate.user_id !== 'string' ||
        typeof candidate.conversation_id !== 'string'
      ) continue
      let terminalEvent: SSEEvent | null = null
      try {
        terminalEvent = JSON.parse(String(candidate.latest_event_json)) as SSEEvent
      } catch {
        terminalEvent = null
      }
      if (terminalEvent?.type !== 'done' && terminalEvent?.type !== 'error') continue
      const terminalStatus = terminalEvent.type
      const terminalError = terminalEvent.type === 'error' ? terminalEvent.message : null
      return {
        staleTerminalFence: true,
        runId: candidate.run_id,
        userId: candidate.user_id,
        conversationId: candidate.conversation_id,
        expectedStatus: 'running',
        expectedAttempts: Math.max(0, Number(candidate.attempts || 0)),
        terminalStatus,
        terminalError,
        terminalEventPersisted: true,
      }
    }

    if (protectLiveWorkerClaims) {
      const staleCancelled = await transaction.execute({
        sql: `
          select run_id, user_id, conversation_id
          from agent_task_jobs
          where status = 'running'
            and queue_name = ?
            and terminal_status is null
            and cancel_requested = 1
            and payload_json is not null
            and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
            and (
              worker_id is null
              or worker_id like 'cancel-fence:%'
              or exists (
                select 1
                from agent_task_workers
                where agent_task_workers.worker_id = agent_task_jobs.worker_id
                  and agent_task_workers.queue_name = agent_task_jobs.queue_name
                  and (
                    agent_task_workers.status = 'stopped'
                    or agent_task_workers.current_run_id is null
                    or agent_task_workers.current_run_id != agent_task_jobs.run_id
                    or agent_task_workers.last_seen_at_ms < (
                      ? - max(?, agent_task_workers.heartbeat_ms + ? + ?)
                    )
                  )
              )
            )
          order by updated_at_ms asc
          limit 1
        `,
        args: [
          queueName,
          now,
          now,
          taskWorkerStaleMs(),
          TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS,
          TASK_WORKER_CANCEL_PROOF_JITTER_MS,
        ],
      })
      const staleRow = staleCancelled.rows[0]
      if (
        typeof staleRow?.run_id === 'string' &&
        typeof staleRow.user_id === 'string' &&
        typeof staleRow.conversation_id === 'string'
      ) {
        return {
          cancellationFence: true,
          runId: staleRow.run_id,
          userId: staleRow.user_id,
          conversationId: staleRow.conversation_id,
        }
      }
    }

    if (protectLiveWorkerClaims) {
      await transaction.execute({
        sql: `
          update agent_task_jobs
          set status = 'queued',
              worker_id = null,
              lease_expires_at_ms = null,
              updated_at_ms = ?
          where status = 'running'
            and queue_name = ?
            and terminal_status is null
            and cancel_requested = 0
            and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
            and (
              worker_id is null
              or not exists (
                select 1
                from agent_task_workers
                where agent_task_workers.worker_id = agent_task_jobs.worker_id
                  and agent_task_workers.queue_name = agent_task_jobs.queue_name
                  and agent_task_workers.current_run_id = agent_task_jobs.run_id
                  and agent_task_workers.status = 'running'
                  and agent_task_workers.last_seen_at_ms >= ?
              )
            )
            and coalesce((
              select case
                when json_valid(agent_task_events.event_json)
                  then json_extract(agent_task_events.event_json, '$.type')
                else ''
              end
              from agent_task_events
              where agent_task_events.run_id = agent_task_jobs.run_id
              order by agent_task_events.seq desc
              limit 1
            ), '') not in ('done', 'error')
        `,
        args: [now, queueName, now, workerFreshAfterMs],
      })
    }

    const selected = await transaction.execute({
      sql: `
        select run_id, user_id, conversation_id, queue_name, payload_json, started_at_ms, attempts,
               coalesce((select max(seq) from agent_task_events where run_id = agent_task_jobs.run_id), 0) as max_seq,
               coalesce((select frame_version from agent_task_live_frames where run_id = agent_task_jobs.run_id), 0) as max_frame_version
        from agent_task_jobs
        where status = 'queued'
          and queue_name = ?
          and terminal_status is null
          and cancel_requested = 0
        order by updated_at_ms asc
        limit 1
      `,
      args: [queueName],
    })

    const row = selected.rows[0]
    if (!row || typeof row.run_id !== 'string' || typeof row.user_id !== 'string' || typeof row.conversation_id !== 'string') {
      return null
    }

    const payload = parseTaskPayload(row.payload_json)
    if (!payload) {
      const terminalError = 'Task payload could not be read.'
      const priorAttempts = Math.max(0, Number(row.attempts || 0))
      if (priorAttempts > 0) {
        return {
          staleTerminalFence: true,
          runId: row.run_id,
          userId: row.user_id,
          conversationId: row.conversation_id,
          expectedStatus: 'queued',
          expectedAttempts: priorAttempts,
          terminalStatus: 'error',
          terminalError,
          terminalEventPersisted: false,
        }
      }
      const invalid = await transaction.execute({
        sql: `
          update agent_task_jobs
          set status = 'error',
              terminal_status = 'error',
              terminal_error = ?,
              worker_id = null,
              lease_expires_at_ms = null,
              updated_at_ms = ?,
              completed_at_ms = ?
          where run_id = ?
            and queue_name = ?
            and status = 'queued'
            and terminal_status is null
        `,
        args: [terminalError, now, now, row.run_id, queueName],
      })
      if (invalid.rowsAffected !== 1) return null
      const seqRows = await transaction.execute({
        sql: 'select max(seq) as max_seq from agent_task_events where run_id = ?',
        args: [row.run_id],
      })
      const maxSeq = Number(seqRows.rows[0]?.max_seq)
      const seq = Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
      const event = { type: 'error', message: terminalError, seq, runId: row.run_id } satisfies SSEEvent
      await transaction.execute({
        sql: `
          insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
          values (?, ?, ?, ?)
        `,
        args: [row.run_id, seq, JSON.stringify(event), now],
      })
      await transaction.execute({
        sql: 'delete from agent_task_live_frames where run_id = ?',
        args: [row.run_id],
      })
      return { terminal: true, runId: row.run_id, userId: row.user_id }
    }

    const attempts = Math.max(0, Number(row.attempts || 0)) + 1
    if (attempts > maxAttempts) {
      const terminalError = `Task stopped after ${maxAttempts} worker claim attempt${maxAttempts === 1 ? '' : 's'}.`
      return {
        staleTerminalFence: true,
        runId: row.run_id,
        userId: row.user_id,
        conversationId: row.conversation_id,
        expectedStatus: 'queued',
        expectedAttempts: Math.max(0, Number(row.attempts || 0)),
        terminalStatus: 'error',
        terminalError,
        terminalEventPersisted: false,
      }
    }

    let recoveryAssessment: TaskRecoveryAssessment = {
      unsafeUnmatchedTool: null,
      context: undefined,
      hasPersistedTextDelta: false,
    }
    if (attempts > 1 && payload.kind !== 'background_probe') {
      const recoveryRows = await transaction.execute({
        sql: `
          select seq, event_json
          from agent_task_events
          where run_id = ?
            and (
              event_json like '%"type":"tool_start"%'
              or event_json like '%"type":"tool_result"%'
              or event_json like '%"type":"artifact_created"%'
              or event_json like '%"type":"text_delta"%'
            )
          order by seq asc
        `,
        args: [row.run_id],
      })
      recoveryAssessment = assessTaskRecoveryEvents(
        recoveryRows.rows as Array<Record<string, unknown>>,
      )

      if (payload.directChat && recoveryAssessment.hasPersistedTextDelta) {
        const completed = await transaction.execute({
          sql: `
            update agent_task_jobs
            set status = 'done',
                terminal_status = 'done',
                terminal_error = null,
                worker_id = null,
                lease_expires_at_ms = null,
                updated_at_ms = ?,
                completed_at_ms = ?
            where run_id = ?
              and status = 'queued'
              and queue_name = ?
              and terminal_status is null
              and cancel_requested = 0
          `,
          args: [now, now, row.run_id, queueName],
        })
        if (completed.rowsAffected !== 1) return null
        const maxSeq = Number(row.max_seq)
        const seq = Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
        const event = { type: 'done', seq, runId: row.run_id } satisfies SSEEvent
        await transaction.execute({
          sql: `
            insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
            values (?, ?, ?, ?)
          `,
          args: [row.run_id, seq, JSON.stringify(event), now],
        })
        await transaction.execute({
          sql: 'delete from agent_task_live_frames where run_id = ?',
          args: [row.run_id],
        })
        return { terminal: true, runId: row.run_id, userId: row.user_id }
      }

      if (recoveryAssessment.unsafeUnmatchedTool) {
        const toolName = recoveryAssessment.unsafeUnmatchedTool.name
        const terminalError = `Task paused safely after worker recovery because the previous ${toolName} action may have completed but did not save a result. Check the current state before starting a new task so the action is not repeated.`
        return {
          staleTerminalFence: true,
          runId: row.run_id,
          userId: row.user_id,
          conversationId: row.conversation_id,
          expectedStatus: 'queued',
          expectedAttempts: Math.max(0, Number(row.attempts || 0)),
          terminalStatus: 'error',
          terminalError,
          terminalEventPersisted: false,
        }
      }
    }

    const gracefulHandoff = attempts > 1 && payload.kind !== 'background_probe' &&
      payload.recoveryMode === 'graceful_handoff' &&
      payload.recoverySourceAttempt === attempts - 1
    const claimedPayload: TaskJobPayload = attempts > 1 && payload.kind !== 'background_probe'
      ? {
          ...payload,
          startFreshSandbox: false,
          startIsolatedTaskSandbox: false,
          recoveryMode: gracefulHandoff ? 'graceful_handoff' : 'stale_lease',
          recoverySourceAttempt: payload.recoverySourceAttempt,
          recoveryContext: recoveryAssessment.context || payload.recoveryContext,
        }
      : payload

    const claimed = await transaction.execute({
      sql: `
        update agent_task_jobs
        set status = 'running',
            worker_id = ?,
            lease_expires_at_ms = ?,
            attempts = ?,
            payload_json = ?,
            updated_at_ms = ?
        where run_id = ?
          and status = 'queued'
          and queue_name = ?
          and terminal_status is null
          and cancel_requested = 0
      `,
      args: [workerId, leaseExpiresAt, attempts, JSON.stringify(claimedPayload), now, row.run_id, queueName],
    })

    if (claimed.rowsAffected !== 1) return null

    return {
      runId: row.run_id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      queueName,
      payload: claimedPayload,
      workerId,
      startedAt: Number.isFinite(Number(row.started_at_ms)) ? Number(row.started_at_ms) : now,
      attempts,
      nextSeq: Number.isFinite(Number(row.max_seq)) ? Math.max(1, Number(row.max_seq) + 1) : 1,
      nextBrowserFrameVersion: Number.isFinite(Number(row.max_frame_version))
        ? Math.max(1, Number(row.max_frame_version) + 1)
        : 1,
    }
  })

  if (result && 'staleTerminalFence' in result) {
    const finalized = await fenceAndFinalizeStaleTask(result)
    if (finalized) {
      await clearLiveDirectivesForRun(result.userId, result.runId).catch(() => undefined)
      await releaseActiveTaskLease(result.userId, result.runId).catch(() => undefined)
    }
    return null
  }

  if (result && 'cancellationFence' in result) {
    const finalized = await fenceAndFinalizeTaskCancellation(result.userId, result.runId)
    if (finalized) {
      await clearLiveDirectivesForRun(result.userId, result.runId).catch(() => undefined)
      await releaseActiveTaskLease(result.userId, result.runId).catch(() => undefined)
    }
    return null
  }

  if (result && 'terminal' in result) {
    await clearLiveDirectivesForRun(result.userId, result.runId).catch((error) => {
      console.warn('[TaskJobs] Failed to clear terminal task directives', {
        runId: result.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await releaseActiveTaskLease(result.userId, result.runId).catch((error) => {
      console.error('[TaskJobs] Failed to release active task lease after terminal queue cleanup', {
        runId: result.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return null
  }

  return result
}

export async function refreshTaskJobClaim(
  runId: string,
  workerId: string,
  leaseMs = TASK_JOB_WORKER_LEASE_MS,
  expectedAttempts?: number,
): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  const now = nowMs()
  const leaseExpiresAt = now + leaseMs
  // In-process work shares the web process and cannot be safely hard-killed.
  // Its owner keeps the full claim alive through cooperative abort + cleanup so
  // another instance cannot publish a terminal row while the promise still runs.
  const cancellationLeaseExpiresAt = now + TASK_JOB_CANCEL_EXECUTION_GRACE_MS
  const queueName = taskQueueName()
  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      update agent_task_jobs
      set lease_expires_at_ms = case
            when cancel_requested = 1 and worker_id like 'in-process:%'
              then max(coalesce(lease_expires_at_ms, ?), ?)
            when cancel_requested = 1
              then min(coalesce(lease_expires_at_ms, ?), ?)
            else ?
          end,
          updated_at_ms = ?
      where run_id = ?
        and worker_id = ?
        and queue_name = ?
        and status = 'running'
        and terminal_status is null
        and (? is null or attempts = ?)
    `,
    [
      leaseExpiresAt,
      leaseExpiresAt,
      cancellationLeaseExpiresAt,
      cancellationLeaseExpiresAt,
      leaseExpiresAt,
      now,
      runId,
      workerId,
      queueName,
      expectedAttempts ?? null,
      expectedAttempts ?? null,
    ],
  ))
  return result.rowsAffected === 1
}

export async function releaseTaskJobClaim(
  runId: string,
  workerId: string,
  expectedAttempts?: number,
  handoffPayload?: TaskJobPayload,
): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  const now = nowMs()
  const queueName = taskQueueName()
  const result = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      update agent_task_jobs
      set status = 'queued',
          worker_id = null,
          lease_expires_at_ms = null,
          payload_json = coalesce(?, payload_json),
          updated_at_ms = ?
      where run_id = ?
        and worker_id = ?
        and queue_name = ?
        and status = 'running'
        and terminal_status is null
        and cancel_requested = 0
        and (? is null or attempts = ?)
    `,
    [handoffPayload ? JSON.stringify(handoffPayload) : null, now, runId, workerId, queueName, expectedAttempts ?? null, expectedAttempts ?? null],
  ))
  return result.rowsAffected === 1
}

async function taskJobControlState(
  runId: string,
  workerId: string,
  expectedAttempts: number,
): Promise<'owned' | 'cancelled' | 'lost'> {
  if (!shouldUseDatabaseTaskJobs()) return 'lost'
  const queueName = taskQueueName()
  const rows = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select cancel_requested, status, terminal_status, worker_id, attempts
      from agent_task_jobs
      where run_id = ? and queue_name = ?
      limit 1
    `,
    [runId, queueName],
  ))
  const row = rows.rows[0]
  if (!row) return 'lost'
  if (row.cancel_requested === 1 || row.cancel_requested === true || row.status === 'cancelled') return 'cancelled'
  if (
    row.status !== 'running' ||
    row.terminal_status ||
    row.worker_id !== workerId ||
    Number(row.attempts) !== expectedAttempts
  ) {
    return 'lost'
  }
  return 'owned'
}

interface StaleTaskFenceReservation {
  conversationId: string
}

async function fenceAndFinalizeStaleTask(fence: StaleTaskTerminalFence): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  const queueName = taskQueueName()
  const fenceWorkerId = `terminal-fence:${randomUUID()}`
  const reservationNow = nowMs()
  const reservation = await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction): Promise<StaleTaskFenceReservation | 'terminal' | null> => {
    const state = await transaction.execute({
      sql: `
        select conversation_id, status, terminal_status, cancel_requested, worker_id,
               lease_expires_at_ms, attempts
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      args: [fence.userId, fence.runId, queueName],
    })
    const row = state.rows[0]
    if (!row) return null
    if (row.terminal_status || row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
      return 'terminal'
    }
    if (
      row.status !== fence.expectedStatus ||
      Number(row.attempts) !== fence.expectedAttempts ||
      (row.cancel_requested !== 0 && row.cancel_requested !== false) ||
      row.conversation_id !== fence.conversationId
    ) {
      return null
    }

    const previousWorkerId = typeof row.worker_id === 'string' ? row.worker_id : null
    const rawLeaseExpiresAt = Number(row.lease_expires_at_ms)
    const previousLeaseExpiresAt = Number.isFinite(rawLeaseExpiresAt) ? rawLeaseExpiresAt : null
    if (fence.expectedStatus === 'running') {
      if (previousLeaseExpiresAt !== null && previousLeaseExpiresAt > reservationNow) return null
      if (previousWorkerId) {
        const liveWorker = await transaction.execute({
          sql: `
            select 1 as live
            from agent_task_workers
            where worker_id = ?
              and queue_name = ?
              and current_run_id = ?
              and status = 'running'
              and last_seen_at_ms >= ?
            limit 1
          `,
          args: [previousWorkerId, queueName, fence.runId, reservationNow - taskWorkerStaleMs()],
        })
        if (liveWorker.rows[0]) return null
      }
    }

    const reserved = await transaction.execute({
      sql: `
        update agent_task_jobs
        set status = 'running',
            worker_id = ?,
            lease_expires_at_ms = ?,
            updated_at_ms = ?
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and status = ?
          and terminal_status is null
          and cancel_requested = 0
          and attempts = ?
          and ((? is null and worker_id is null) or worker_id = ?)
      `,
      args: [
        fenceWorkerId,
        reservationNow + TASK_JOB_WORKER_LEASE_MS,
        reservationNow,
        fence.userId,
        fence.runId,
        queueName,
        fence.expectedStatus,
        fence.expectedAttempts,
        previousWorkerId,
        previousWorkerId,
      ],
    })
    if (reserved.rowsAffected !== 1) return null
    return {
      conversationId: row.conversation_id,
    }
  }))

  if (reservation === 'terminal') return true
  if (!reservation) return false

  try {
    await destroySandbox(reservation.conversationId)
  } catch (error) {
    console.error('[TaskJobs] Stale task execution fence failed', {
      runId: fence.runId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Keep the short-lived terminal-fence lease installed. Immediate release
    // would make this same undeletable sandbox win every claim poll and starve
    // unrelated queued work. Once the lease expires, recovery retries safely.
    return false
  }

  const finalizedAt = nowMs()
  return withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    let terminalError = fence.terminalError
    if (fence.terminalStatus === 'error' && !fence.terminalEventPersisted) {
      const recoveryRows = await transaction.execute({
        sql: `
          select seq, event_json
          from agent_task_events
          where run_id = ?
            and (
              event_json like '%"type":"tool_start"%'
              or event_json like '%"type":"tool_result"%'
              or event_json like '%"type":"artifact_created"%'
              or event_json like '%"type":"text_delta"%'
            )
          order by seq asc
        `,
        args: [fence.runId],
      })
      terminalError = uncertainNonIdempotentActionMessage(
        assessTaskRecoveryEvents(recoveryRows.rows as Array<Record<string, unknown>>),
        'interrupted',
      ) || terminalError
    }

    const finalized = await transaction.execute({
      sql: `
        update agent_task_jobs
        set status = ?,
            terminal_status = ?,
            terminal_error = ?,
            worker_id = null,
            lease_expires_at_ms = null,
            updated_at_ms = ?,
            completed_at_ms = ?
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and status = 'running'
          and terminal_status is null
          and worker_id = ?
          and attempts = ?
      `,
      args: [
        fence.terminalStatus,
        fence.terminalStatus,
        terminalError,
        finalizedAt,
        finalizedAt,
        fence.userId,
        fence.runId,
        queueName,
        fenceWorkerId,
        fence.expectedAttempts,
      ],
    })
    if (finalized.rowsAffected !== 1) {
      const current = await transaction.execute({
        sql: `
          select status, terminal_status
          from agent_task_jobs
          where user_id = ? and run_id = ? and queue_name = ?
          limit 1
        `,
        args: [fence.userId, fence.runId, queueName],
      })
      const row = current.rows[0]
      return !!row && (row.status === 'done' || row.status === 'error' || row.status === 'cancelled' || !!row.terminal_status)
    }

    if (!fence.terminalEventPersisted) {
      const seqRows = await transaction.execute({
        sql: 'select max(seq) as max_seq from agent_task_events where run_id = ?',
        args: [fence.runId],
      })
      const maxSeq = Number(seqRows.rows[0]?.max_seq)
      const seq = Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
      const event = fence.terminalStatus === 'done'
        ? { type: 'done', seq, runId: fence.runId } satisfies SSEEvent
        : { type: 'error', message: terminalError || 'Task stopped.', seq, runId: fence.runId } satisfies SSEEvent
      await transaction.execute({
        sql: `
          insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
          values (?, ?, ?, ?)
        `,
        args: [fence.runId, seq, JSON.stringify(event), finalizedAt],
      })
    }
    await transaction.execute({
      sql: 'delete from agent_task_live_frames where run_id = ?',
      args: [fence.runId],
    })
    return true
  }))
}

interface CancellationFenceReservation {
  conversationId: string
  attempts: number
  inProcessRecovery: boolean
}

async function fenceAndFinalizeTaskCancellation(userId: string, runId: string): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  const localJob = taskJobState.jobs.get(runId)
  if (localJob && !localJob.terminalCommitted) return false
  const queueName = taskQueueName()
  const fenceWorkerId = `cancel-fence:${randomUUID()}`
  const reservationNow = nowMs()
  const reservation = await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction): Promise<CancellationFenceReservation | 'terminal' | null> => {
    const state = await transaction.execute({
      sql: `
        select conversation_id, status, terminal_status, cancel_requested, worker_id,
               lease_expires_at_ms, attempts
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      args: [userId, runId, queueName],
    })
    const row = state.rows[0]
    if (!row) return null
    if (row.terminal_status || row.status === 'done' || row.status === 'error' || row.status === 'cancelled') {
      return 'terminal'
    }
    const attempts = Number(row.attempts)
    if (
      row.status !== 'running' ||
      (row.cancel_requested !== 1 && row.cancel_requested !== true) ||
      typeof row.conversation_id !== 'string' ||
      !Number.isFinite(attempts)
    ) return null
    const leaseExpiresAt = Number(row.lease_expires_at_ms)
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > reservationNow) return null

    const expectedWorkerId = typeof row.worker_id === 'string' ? row.worker_id : null
    const inProcessRecovery = isInProcessTaskWorkerId(expectedWorkerId)

    if (expectedWorkerId && !inProcessRecovery && !isCancellationFenceWorkerId(expectedWorkerId)) {
      const workerState = await transaction.execute({
        sql: `
          select status, current_run_id, last_seen_at_ms, heartbeat_ms
          from agent_task_workers
          where worker_id = ? and queue_name = ?
          limit 1
        `,
        args: [expectedWorkerId, queueName],
      })
      const worker = workerState.rows[0]
      // Every external claimant must publish a fresh boot-unique heartbeat
      // before claim. Missing heartbeat state therefore cannot prove a hard
      // stop and must fail closed instead of exposing a terminal cancellation.
      if (!worker) return null
      const lastSeenAtMs = Number(worker.last_seen_at_ms)
      const exactWorkerStillLive = (
        worker.status !== 'stopped' &&
        worker.current_run_id === runId &&
        Number.isFinite(lastSeenAtMs) &&
        lastSeenAtMs >= reservationNow - cancellationWorkerHeartbeatProofWindowMs(worker.heartbeat_ms)
      )
      if (exactWorkerStillLive) return null
    }

    const reserved = await transaction.execute({
      sql: `
        update agent_task_jobs
        set worker_id = ?,
            lease_expires_at_ms = ?,
            updated_at_ms = ?
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and status = 'running'
          and terminal_status is null
          and cancel_requested = 1
          and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
          and ((? is null and worker_id is null) or worker_id = ?)
          and attempts = ?
      `,
      args: [
        fenceWorkerId,
        reservationNow + TASK_JOB_WORKER_LEASE_MS,
        reservationNow,
        userId,
        runId,
        queueName,
        reservationNow,
        expectedWorkerId,
        expectedWorkerId,
        attempts,
      ],
    })
    if (reserved.rowsAffected !== 1) return null
    return { conversationId: row.conversation_id, attempts, inProcessRecovery }
  }))

  if (reservation === 'terminal') return true
  if (!reservation) return false

  try {
    await destroySandbox(reservation.conversationId)
  } catch (error) {
    console.error('[TaskJobs] Cancellation execution fence failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Retain the short cancel-fence lease so one cleanup failure cannot hot-loop
    // ahead of every unrelated queue item. Recovery retries after lease expiry.
    return false
  }

  const now = nowMs()
  return withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    const recoveryRows = await transaction.execute({
      sql: `
        select seq, event_json
        from agent_task_events
        where run_id = ?
          and (
            event_json like '%"type":"tool_start"%'
            or event_json like '%"type":"tool_result"%'
            or event_json like '%"type":"artifact_created"%'
            or event_json like '%"type":"text_delta"%'
          )
        order by seq asc
      `,
      args: [runId],
    })
    const recoveryTerminalError = reservation.inProcessRecovery
      ? 'Task stop could not be confirmed because its in-process execution host became unreachable. Workspace state was reset, but late external side effects could not be ruled out. Check the current state before retrying.'
      : 'Task stopped after its dedicated worker became unreachable. Workspace state was reset, but late external side effects could not be ruled out. Check the current state before retrying.'
    const terminalError = uncertainNonIdempotentActionMessage(
      assessTaskRecoveryEvents(recoveryRows.rows as Array<Record<string, unknown>>),
      'cancelled',
    ) || recoveryTerminalError
    const forced = await transaction.execute({
      sql: `
        update agent_task_jobs
        set status = 'cancelled',
            terminal_status = 'error',
            terminal_error = ?,
            worker_id = null,
            lease_expires_at_ms = null,
            updated_at_ms = ?,
            completed_at_ms = ?
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and status = 'running'
          and terminal_status is null
          and cancel_requested = 1
          and worker_id = ?
          and attempts = ?
      `,
      args: [terminalError, now, now, userId, runId, queueName, fenceWorkerId, reservation.attempts],
    })
    if (forced.rowsAffected === 1) {
      const seqRows = await transaction.execute({
        sql: 'select max(seq) as max_seq from agent_task_events where run_id = ?',
        args: [runId],
      })
      const maxSeq = Number(seqRows.rows[0]?.max_seq)
      const seq = Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
      const event = { type: 'error', message: terminalError, seq, runId } satisfies SSEEvent
      await transaction.execute({
        sql: `
          insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
          values (?, ?, ?, ?)
        `,
        args: [runId, seq, JSON.stringify(event), now],
      })
      await transaction.execute({
        sql: 'delete from agent_task_live_frames where run_id = ?',
        args: [runId],
      })
      return true
    }
    const current = await transaction.execute({
      sql: `
        select status, terminal_status
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      args: [userId, runId, queueName],
    })
    const currentRow = current.rows[0]
    return !!currentRow && (
      currentRow.status === 'done' ||
      currentRow.status === 'error' ||
      currentRow.status === 'cancelled' ||
      !!currentRow.terminal_status
    )
  }))
}

async function reconcileExpiredDurableTaskJob(input: {
  userId: string
  runId?: string
  conversationId?: string
}): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  const queueName = taskQueueName()
  const observedAt = nowMs()
  const rows = await withTaskJobSchemaRepair(() => tursoExecute(
    `
      select run_id, user_id, conversation_id, status, attempts, cancel_requested
      from agent_task_jobs
      where user_id = ?
        and queue_name = ?
        and terminal_status is null
        and (? is null or run_id = ?)
        and (? is null or conversation_id = ?)
        and (
          (
            status = 'running'
            and cancel_requested = 1
            and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
          )
          or (
            payload_json is null
            and attempts > 0
            and (
              status = 'queued'
              or (
                status = 'running'
                and (lease_expires_at_ms is null or lease_expires_at_ms <= ?)
              )
            )
          )
        )
      order by case when cancel_requested = 1 then 0 else 1 end, updated_at_ms asc
      limit 1
    `,
    [
      input.userId,
      queueName,
      input.runId ?? null,
      input.runId ?? null,
      input.conversationId ?? null,
      input.conversationId ?? null,
      observedAt,
      observedAt,
    ],
  ))
  const row = rows.rows[0]
  if (
    typeof row?.run_id !== 'string' ||
    typeof row.user_id !== 'string' ||
    typeof row.conversation_id !== 'string' ||
    (row.status !== 'queued' && row.status !== 'running')
  ) {
    return false
  }

  const cancelRequested = row.cancel_requested === 1 || row.cancel_requested === true
  const finalized = cancelRequested && row.status === 'running'
    ? await fenceAndFinalizeTaskCancellation(row.user_id, row.run_id)
    : await fenceAndFinalizeStaleTask({
        staleTerminalFence: true,
        runId: row.run_id,
        userId: row.user_id,
        conversationId: row.conversation_id,
        expectedStatus: row.status,
        expectedAttempts: Math.max(0, Number(row.attempts || 0)),
        terminalStatus: 'error',
        terminalError: 'Task execution host stopped before cleanup finished. Workspace state was reset; please try the task again.',
        terminalEventPersisted: false,
      })

  if (finalized) {
    await clearLiveDirectivesForRun(row.user_id, row.run_id).catch(() => undefined)
    await releaseActiveTaskLease(row.user_id, row.run_id).catch(() => undefined)
  }
  return finalized
}

function scheduleCancellationFence(userId: string, runId: string, dueAt: number): void {
  if (!shouldUseDatabaseTaskJobs()) return
  const key = `${taskQueueName()}:${userId}:${runId}`
  const existing = scheduledCancellationFences.get(key)
  if (existing && existing.dueAt <= dueAt) return
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(() => {
    scheduledCancellationFences.delete(key)
    void reconcileExpiredDurableTaskJob({ userId, runId }).then(async (finalized) => {
      if (finalized) return
      const pending = await withTaskJobSchemaRepair(() => tursoExecute(
        `
          select jobs.lease_expires_at_ms, jobs.worker_id,
                 workers.status as worker_status,
                 workers.current_run_id as worker_current_run_id,
                 workers.last_seen_at_ms as worker_last_seen_at_ms,
                 workers.heartbeat_ms as worker_heartbeat_ms
          from agent_task_jobs as jobs
          left join agent_task_workers as workers
            on workers.worker_id = jobs.worker_id
           and workers.queue_name = jobs.queue_name
          where jobs.user_id = ?
            and jobs.run_id = ?
            and jobs.queue_name = ?
            and jobs.status = 'running'
            and jobs.terminal_status is null
            and jobs.cancel_requested = 1
          limit 1
        `,
        [userId, runId, taskQueueName()],
      ))
      const row = pending.rows[0]
      if (!row) return
      const leaseExpiresAt = Number(row.lease_expires_at_ms)
      const workerLastSeenAt = Number(row.worker_last_seen_at_ms)
      const exactExternalWorkerIsLive = (
        typeof row.worker_id === 'string' &&
        !isInProcessTaskWorkerId(row.worker_id) &&
        !isCancellationFenceWorkerId(row.worker_id) &&
        row.worker_status !== 'stopped' &&
        row.worker_current_run_id === runId &&
        Number.isFinite(workerLastSeenAt)
      )
      const heartbeatProofAt = exactExternalWorkerIsLive
        ? workerLastSeenAt + cancellationWorkerHeartbeatProofWindowMs(row.worker_heartbeat_ms)
        : 0
      scheduleCancellationFence(
        userId,
        runId,
        Math.max(
          nowMs() + 5_000,
          Number.isFinite(leaseExpiresAt) ? leaseExpiresAt : 0,
          heartbeatProofAt,
        ),
      )
    }).catch((error) => {
      console.error('[TaskJobs] Scheduled cancellation fence failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Transient DB/provider failures must not turn a durable cancellation
      // into a permanently stopping row after the browser disconnects.
      scheduleCancellationFence(userId, runId, nowMs() + 5_000)
    })
  }, Math.max(0, dueAt - nowMs()) + 25)
  timer.unref?.()
  scheduledCancellationFences.set(key, { dueAt, timer })
}

export async function runClaimedTaskJob(
  claim: ClaimedTaskJob,
  runner: (
    emitter: AgentEventEmitter,
    signal: AbortSignal,
    context: {
      shouldPreserveSandboxOnAbort: () => boolean
      registerPreTerminalCleanup: (cleanup: () => Promise<void>) => void
      registerInflightToolDrain: (drain: InflightToolDrain) => void
      markHandoffUnsafe: (reason: string) => void
    },
  ) => Promise<void>,
  options: { shutdownSignal?: AbortSignal; onCancellationObserved?: () => void } = {},
): Promise<'completed' | 'requeued' | 'lease_lost' | 'unsafe_handoff'> {
  const startedAt = claim.startedAt || nowMs()
  const job: TaskJob = {
    runId: claim.runId,
    userId: claim.userId,
    conversationId: claim.conversationId,
    queueName: claim.queueName,
    status: 'running',
    startedAt,
    updatedAt: nowMs(),
    completedAt: null,
    terminalStatus: null,
    terminalError: null,
    terminalRecord: null,
    terminalCommitted: false,
    closeRequested: false,
    cancelRequested: false,
    acceptsLiveDirectives: claim.payload.kind !== 'background_probe' && claim.payload.directChat === false,
    closed: false,
    nextSeq: Number.isFinite(Number(claim.nextSeq)) ? Math.max(1, Number(claim.nextSeq)) : await nextPersistedEventSeq(claim.runId),
    nextBrowserFrameVersion: Number.isFinite(Number(claim.nextBrowserFrameVersion))
      ? Math.max(1, Number(claim.nextBrowserFrameVersion))
      : 1,
    latestBrowserFrame: null,
    events: [],
    subscribers: new Map(),
    abortController: new AbortController(),
    emitter: null,
    promise: null,
    persistChain: Promise.resolve(),
    persistenceFailure: null,
    pendingEventPersistence: [],
    eventPersistenceQueued: false,
    pendingTextPersistence: [],
    pendingTextPersistenceChars: 0,
    pendingTextPersistenceTimer: null,
    pendingBrowserFramePersistence: null,
    pendingBrowserFramePersistenceTimer: null,
    terminalCleanupTimer: null,
    requeueRequested: false,
    requeueReason: null,
    claimWorkerId: claim.workerId,
    claimAttempts: claim.attempts,
    inflightToolDrain: null,
  }

  taskJobState.jobs.set(job.runId, job)
  let releaseClaimPromise: Promise<boolean> | null = null
  const preTerminalCleanups: Array<() => Promise<void>> = []
  let releaseRequeueClaim = true
  let unsafeHandoff = false
  let handoffUnsafeReason: string | null = null

  const drainInflightTools = async (timeoutMs: number) => {
    if (!job.inflightToolDrain) {
      return { settled: true, pendingCount: 0, nonIdempotentPending: false, pendingToolNames: [] }
    }
    return job.inflightToolDrain(timeoutMs)
  }

  const establishTerminalExecutionFence = async () => {
    const ownedBeforeCleanup = await refreshTaskJobClaim(
      claim.runId,
      claim.workerId,
      TASK_JOB_WORKER_LEASE_MS,
      claim.attempts,
    )
    if (!ownedBeforeCleanup) throw new TaskJobClaimLostError(claim.runId)

    const initialDrain = await drainInflightTools(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS)
    const runCleanups = async () => {
      if (job.cancelRequested && preTerminalCleanups.length === 0) {
        // Cancellation can arrive before the runner has initialized its sandbox
        // cleanup callback. Destroying by conversation id is safe here because
        // this attempt still owns the durable job claim and no successor can run.
        await destroySandbox(claim.conversationId)
      }
      for (const cleanup of preTerminalCleanups) await cleanup()
    }
    await runCleanups()

    if (!initialDrain.settled) {
      const finalDrain = await drainInflightTools(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS)
      if (!finalDrain.settled) {
        throw new Error(`Task execution fence could not settle ${finalDrain.pendingCount} in-flight operation(s): ${finalDrain.pendingToolNames.join(', ')}`)
      }
      await runCleanups()
    }

    const controlState = await taskJobControlState(claim.runId, claim.workerId, claim.attempts)
    if (controlState === 'lost') throw new TaskJobClaimLostError(claim.runId)
    if (controlState === 'cancelled') markTaskJobCancelled(job)
    const ownedAfterCleanup = await refreshTaskJobClaim(
      claim.runId,
      claim.workerId,
      TASK_JOB_WORKER_LEASE_MS,
      claim.attempts,
    )
    if (!ownedAfterCleanup) throw new TaskJobClaimLostError(claim.runId)
  }

  const releaseClaimOnce = () => {
    const handoffPayload = job.requeueReason === 'shutdown' && claim.payload.kind !== 'background_probe'
      ? {
          ...claim.payload,
          startFreshSandbox: false,
          startIsolatedTaskSandbox: false,
          recoveryMode: 'graceful_handoff' as const,
          recoverySourceAttempt: claim.attempts,
        }
      : undefined
    releaseClaimPromise ??= releaseTaskJobClaim(
      claim.runId,
      claim.workerId,
      claim.attempts,
      handoffPayload,
    ).catch((error) => {
      console.error('[TaskJobs] Failed to release worker lease during shutdown', {
        runId: claim.runId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    })
    return releaseClaimPromise
  }

  const stopForRequeue = (reason: 'shutdown' | 'lease_lost') => {
    if (job.requeueRequested || job.terminalStatus) return
    job.requeueRequested = true
    job.requeueReason = reason
    job.closed = true
    closeJobSubscribers(job)
    job.abortController.abort()
  }
  const releaseClaimForShutdown = () => stopForRequeue('shutdown')

  if (options.shutdownSignal?.aborted) {
    releaseClaimForShutdown()
  } else {
    options.shutdownSignal?.addEventListener('abort', releaseClaimForShutdown, { once: true })
  }

  if (job.requeueRequested) {
    await releaseClaimOnce()
    taskJobState.jobs.delete(job.runId)
    return 'requeued'
  }

  const initialControlState = await taskJobControlState(claim.runId, claim.workerId, claim.attempts)
  if (initialControlState === 'lost') {
    taskJobState.jobs.delete(job.runId)
    return 'lease_lost'
  }
  if (initialControlState === 'cancelled') {
    job.cancelRequested = true
    job.abortController.abort()
    options.onCancellationObserved?.()
  }

  let refreshInFlight = false
  const refreshTimer = setInterval(() => {
    if (refreshInFlight || job.cancelRequested || job.terminalCommitted || job.requeueRequested) return
    refreshInFlight = true
    void refreshTaskJobClaim(claim.runId, claim.workerId, TASK_JOB_WORKER_LEASE_MS, claim.attempts).then((refreshed) => {
      if (!refreshed && !job.requeueRequested && !job.terminalStatus) {
        stopForRequeue('lease_lost')
      }
    }).catch((error) => {
      console.error('[TaskJobs] Failed to refresh worker lease', {
        runId: claim.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }).finally(() => {
      refreshInFlight = false
    })
  }, TASK_JOB_WORKER_REFRESH_MS)

  let cancelTimer: ReturnType<typeof setTimeout> | null = null
  let cancelPollingStopped = false
  const scheduleCancellationPoll = () => {
    if (cancelPollingStopped) return
    cancelTimer = setTimeout(() => {
      cancelTimer = null
      if (cancelPollingStopped) return
      void taskJobControlState(claim.runId, claim.workerId, claim.attempts).then((controlState) => {
        if (controlState === 'cancelled' && !job.requeueRequested && !job.terminalCommitted) {
          job.cancelRequested = true
          job.abortController.abort()
          options.onCancellationObserved?.()
        } else if (controlState === 'lost' && !job.requeueRequested && !job.terminalStatus) {
          stopForRequeue('lease_lost')
        }
      }).catch((error) => {
        console.error('[TaskJobs] Failed to poll task cancellation', {
          runId: claim.runId,
          error: error instanceof Error ? error.message : String(error),
        })
      }).finally(() => {
        scheduleCancellationPoll()
      })
    }, TASK_JOB_CANCEL_POLL_MS)
    cancelTimer.unref?.()
  }
  scheduleCancellationPoll()

  try {
    await runTaskJob(job, (emitter, signal) => job.cancelRequested
      ? Promise.resolve()
      : runner(emitter, signal, {
      shouldPreserveSandboxOnAbort: () => job.requeueReason === 'shutdown' || job.requeueReason === 'lease_lost',
      registerPreTerminalCleanup: (cleanup) => {
        preTerminalCleanups.push(cleanup)
      },
      registerInflightToolDrain: (drain) => {
        job.inflightToolDrain = drain
      },
      markHandoffUnsafe: (reason) => {
        handoffUnsafeReason = reason || 'runner_marked_unsafe'
      },
    }), {
      persistStart: false,
      beforeFinalCommit: async () => {
        try {
          await establishTerminalExecutionFence()
        } catch (error) {
          releaseRequeueClaim = false
          unsafeHandoff = true
          throw error
        }
      },
    })
    if (job.requeueReason === 'shutdown') {
      const drained = await drainInflightTools(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS)
      if (!drained.settled || handoffUnsafeReason) {
        // Do not publish a reusable handoff while an old tool promise can still
        // mutate it. Leave the lease in place to expire; the next attempt will
        // be classified stale and will reset/replace the sandbox.
        releaseRequeueClaim = false
        unsafeHandoff = true
        job.requeueReason = 'lease_lost'
        if (handoffUnsafeReason) {
          console.warn('[TaskJobs] Graceful handoff rejected by runner safety fence', {
            runId: job.runId,
            reason: handoffUnsafeReason,
          })
        }
      }
    }
  } finally {
    clearInterval(refreshTimer)
    cancelPollingStopped = true
    if (cancelTimer) clearTimeout(cancelTimer)
    options.shutdownSignal?.removeEventListener('abort', releaseClaimForShutdown)
    if (job.requeueRequested && releaseRequeueClaim) await releaseClaimOnce()
    taskJobState.jobs.delete(job.runId)
  }
  if (unsafeHandoff) return 'unsafe_handoff'
  if (job.requeueReason === 'lease_lost') return 'lease_lost'
  return job.requeueRequested ? 'requeued' : 'completed'
}

function taskCancellationTerminalStatus(
  status: unknown,
  terminalStatus?: unknown,
): 'done' | 'error' | 'cancelled' | null {
  if (status === 'done' || status === 'error' || status === 'cancelled') return status
  if (terminalStatus === 'done' || terminalStatus === 'error') return terminalStatus
  return null
}

export async function cancelTaskJob(
  userId: string,
  runId: string,
  conversationId?: string,
): Promise<TaskCancellationResult> {
  const queueName = taskQueueName()
  const job = taskJobState.jobs.get(runId)
  const releaseCancelledLease = async () => {
    await clearLiveDirectivesForRun(userId, runId).catch((error) => {
      console.warn('[TaskJobs] Failed to clear cancelled task directives', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await releaseActiveTaskLease(userId, runId).catch((error) => {
      console.error('[TaskJobs] Failed to release active task lease during cancellation', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  if (job) {
    if (
      job.userId !== userId ||
      job.queueName !== queueName ||
      (conversationId !== undefined && job.conversationId !== conversationId)
    ) return { ok: false, status: 'missing', terminal: false }
    if (job.terminalCommitted) {
      await releaseCancelledLease()
      return {
        ok: true,
        status: taskCancellationTerminalStatus(job.status, job.terminalStatus) || 'cancelled',
        terminal: true,
      }
    }
    // A done/error event is only provisional until cleanup and the terminal
    // row/event transaction commit. Cancellation must still abort and fence
    // the exact claim while that barrier is pending or hung.
    job.cancelRequested = true
    // Signal local execution before any network write. A transient cancellation
    // persistence failure must not leave side effects running merely because
    // the DELETE response itself fails.
    job.abortController.abort()
    if (shouldUseDatabaseTaskJobs()) {
      const cancellationNow = nowMs()
      const cancellationDeadline = cancellationNow + TASK_JOB_CANCEL_EXECUTION_GRACE_MS
      await withTaskJobSchemaRepair(() => tursoExecute(
        `
          update agent_task_jobs
          set cancel_requested = 1,
              lease_expires_at_ms = case
                when worker_id like 'in-process:%' then max(coalesce(lease_expires_at_ms, ?), ?)
                else min(coalesce(lease_expires_at_ms, ?), ?)
              end,
              updated_at_ms = ?
          where user_id = ?
            and run_id = ?
            and queue_name = ?
            and status = 'running'
            and terminal_status is null
        `,
        [
          cancellationNow + TASK_JOB_WORKER_LEASE_MS,
          cancellationNow + TASK_JOB_WORKER_LEASE_MS,
          cancellationDeadline,
          cancellationDeadline,
          cancellationNow,
          userId,
          runId,
          queueName,
        ],
      ))
      scheduleCancellationFence(userId, runId, cancellationDeadline)
    }
    const settled = await Promise.race([
      (job.promise || Promise.resolve()).then(() => true, () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), TASK_JOB_CANCEL_ACK_TIMEOUT_MS)),
    ])
    if (settled && job.terminalCommitted) {
      await releaseCancelledLease()
      return {
        ok: true,
        status: taskCancellationTerminalStatus(job.status, job.terminalStatus) || 'cancelled',
        terminal: true,
      }
    }
    const fenced = await fenceAndFinalizeTaskCancellation(userId, runId).catch(() => false)
    if (fenced) {
      await releaseCancelledLease()
      return { ok: true, status: 'cancelled', terminal: true }
    }
    return { ok: true, status: 'stopping', terminal: false }
  }

  if (!shouldUseDatabaseTaskJobs()) {
    if (conversationId) {
      recordMemoryPreStartCancellation(
        queueName,
        userId,
        conversationId,
        runId,
        nowMs() + taskPreStartCancellationTtlMs(),
      )
      return { ok: true, status: 'cancelled', terminal: true }
    }
    return { ok: false, status: 'missing', terminal: false }
  }

  const now = nowMs()
  await maybePrunePreStartCancellations(now).catch((error) => {
    console.warn('[TaskJobs] Pre-start cancellation retention cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  type CancelResult =
    | { kind: 'missing' }
    | { kind: 'prestart_cancelled'; expiresAt: number }
    | { kind: 'terminal'; status: 'done' | 'error' | 'cancelled' }
    | { kind: 'requested' }
  const cancelResult = await withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction): Promise<CancelResult> => {
    const selected = await transaction.execute({
      sql: `
        select status, terminal_status, cancel_requested, worker_id, attempts, payload_json
        from agent_task_jobs
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and (? is null or conversation_id = ?)
        limit 1
      `,
      args: [userId, runId, queueName, conversationId ?? null, conversationId ?? null],
    })
    const row = selected.rows[0]
    if (!row) {
      if (!conversationId) return { kind: 'missing' }
      const expiresAt = now + taskPreStartCancellationTtlMs()
      await transaction.execute({
        sql: `
          insert into agent_task_prestart_cancellations (
            queue_name, user_id, conversation_id, run_id, created_at_ms, expires_at_ms
          )
          values (?, ?, ?, ?, ?, ?)
          on conflict(queue_name, user_id, conversation_id, run_id) do update set
            created_at_ms = min(agent_task_prestart_cancellations.created_at_ms, excluded.created_at_ms),
            expires_at_ms = max(agent_task_prestart_cancellations.expires_at_ms, excluded.expires_at_ms)
        `,
        args: [queueName, userId, conversationId, runId, now, expiresAt],
      })
      return { kind: 'prestart_cancelled', expiresAt }
    }
    const selectedTerminalStatus = taskCancellationTerminalStatus(row.status, row.terminal_status)
    if (selectedTerminalStatus) {
      return { kind: 'terminal', status: selectedTerminalStatus }
    }

    if (row.status === 'queued') {
      const priorAttempts = Math.max(0, Number(row.attempts || 0))
      const mayHaveExecuted = priorAttempts > 0 || row.payload_json === null || row.payload_json === undefined
      if (mayHaveExecuted) {
        // Stale retries and graceful handoffs can be queued even though their
        // sandbox has already executed work. Convert them into an immediately
        // expired cancellation claim so the destroy-before-terminal fence is
        // mandatory. A payload-less row is an in-process run and is equally
        // unsafe to treat as pristine from another server instance.
        const requested = await transaction.execute({
          sql: `
            update agent_task_jobs
            set status = 'running',
                cancel_requested = 1,
                worker_id = null,
                lease_expires_at_ms = ?,
                updated_at_ms = ?
            where user_id = ?
              and run_id = ?
              and queue_name = ?
              and status = 'queued'
              and terminal_status is null
              and attempts = ?
          `,
          args: [now, now, userId, runId, queueName, priorAttempts],
        })
        if (requested.rowsAffected === 1) return { kind: 'requested' }
      }

      const cancelled = await transaction.execute({
        sql: `
          update agent_task_jobs
          set status = 'cancelled',
              terminal_status = 'error',
              terminal_error = 'Task stopped.',
              cancel_requested = 1,
              worker_id = null,
              lease_expires_at_ms = null,
              updated_at_ms = ?,
              completed_at_ms = ?
          where user_id = ?
            and run_id = ?
            and queue_name = ?
            and status = 'queued'
            and terminal_status is null
        `,
        args: [now, now, userId, runId, queueName],
      })
      if (cancelled.rowsAffected === 1) {
        const seqRows = await transaction.execute({
          sql: 'select max(seq) as max_seq from agent_task_events where run_id = ?',
          args: [runId],
        })
        const maxSeq = Number(seqRows.rows[0]?.max_seq)
        const seq = Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
        const event = { type: 'error', message: 'Task stopped.', seq, runId } satisfies SSEEvent
        await transaction.execute({
          sql: `
            insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
            values (?, ?, ?, ?)
          `,
          args: [runId, seq, JSON.stringify(event), now],
        })
        await transaction.execute({
          sql: 'delete from agent_task_live_frames where run_id = ?',
          args: [runId],
        })
        return { kind: 'terminal', status: 'cancelled' }
      }
    } else if (row.status === 'running') {
      const requested = await transaction.execute({
        sql: `
          update agent_task_jobs
          set cancel_requested = 1,
              lease_expires_at_ms = case
                when worker_id like 'in-process:%' then max(coalesce(lease_expires_at_ms, ?), ?)
                else min(coalesce(lease_expires_at_ms, ?), ?)
              end,
              updated_at_ms = ?
          where user_id = ?
            and run_id = ?
            and queue_name = ?
            and status = 'running'
            and terminal_status is null
        `,
        args: [
          now + TASK_JOB_WORKER_LEASE_MS,
          now + TASK_JOB_WORKER_LEASE_MS,
          now + TASK_JOB_CANCEL_EXECUTION_GRACE_MS,
          now + TASK_JOB_CANCEL_EXECUTION_GRACE_MS,
          now,
          userId,
          runId,
          queueName,
        ],
      })
      if (requested.rowsAffected === 1) return { kind: 'requested' }
    }

    const current = await transaction.execute({
      sql: `
        select status, terminal_status
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      args: [userId, runId, queueName],
    })
    const currentRow = current.rows[0]
    if (!currentRow) return { kind: 'missing' }
    const currentTerminalStatus = taskCancellationTerminalStatus(currentRow.status, currentRow.terminal_status)
    return currentTerminalStatus
      ? { kind: 'terminal', status: currentTerminalStatus }
      : { kind: 'requested' }
  }))

  if (cancelResult.kind === 'missing') return { ok: false, status: 'missing', terminal: false }
  if (cancelResult.kind === 'prestart_cancelled') {
    recordMemoryPreStartCancellation(
      queueName,
      userId,
      conversationId!,
      runId,
      cancelResult.expiresAt,
    )
    return { ok: true, status: 'cancelled', terminal: true }
  }
  if (cancelResult.kind === 'terminal') {
    await releaseCancelledLease()
    return { ok: true, status: cancelResult.status, terminal: true }
  }

  // The request may finish before the bounded execution-grace lease expires.
  // Keep an autonomous exact-run fence scheduled so cleanup does not depend on
  // the browser remaining connected or issuing another DELETE/poll request.
  scheduleCancellationFence(userId, runId, now + TASK_JOB_CANCEL_EXECUTION_GRACE_MS)

  const fencedImmediately = await fenceAndFinalizeTaskCancellation(userId, runId).catch((error) => {
    console.error('[TaskJobs] Immediate cancellation fence failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  })
  if (fencedImmediately) {
    await releaseCancelledLease()
    return { ok: true, status: 'cancelled', terminal: true }
  }

  const deadline = nowMs() + TASK_JOB_CANCEL_ACK_TIMEOUT_MS
  while (nowMs() < deadline) {
    const status = await loadPersistedTaskJobStatus(userId, runId)
    if (!status || status.status === 'done' || status.status === 'error' || status.status === 'cancelled' || status.terminalStatus) {
      await releaseCancelledLease()
      return {
        ok: true,
        status: status
          ? taskCancellationTerminalStatus(status.status, status.terminalStatus) || 'cancelled'
          : 'cancelled',
        terminal: true,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_JOB_CANCEL_ACK_POLL_MS))
  }
  const fencedAfterWait = await fenceAndFinalizeTaskCancellation(userId, runId).catch((error) => {
    console.error('[TaskJobs] Delayed cancellation fence failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  })
  if (fencedAfterWait) {
    await releaseCancelledLease()
    return { ok: true, status: 'cancelled', terminal: true }
  }
  return { ok: true, status: 'stopping', terminal: false }
}

export async function cleanupInternalTaskJob(userId: string, runId: string): Promise<boolean> {
  if (!userId.startsWith('internal-background-smoke-') || !runId.startsWith('background-smoke-')) {
    return false
  }
  if (!shouldUseDatabaseTaskJobs()) return false

  const queueName = taskQueueName()
  return withTaskJobSchemaRepair(() => tursoTransaction('write', async (transaction) => {
    const jobRows = await transaction.execute({
      sql: `
        select status
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      args: [userId, runId, queueName],
    })
    const status = jobRows.rows[0]?.status
    if (status !== 'done' && status !== 'error' && status !== 'cancelled') return false

    await transaction.execute({
      sql: 'delete from agent_task_events where run_id = ?',
      args: [runId],
    })
    await transaction.execute({
      sql: 'delete from agent_task_live_frames where run_id = ?',
      args: [runId],
    })
    const deleted = await transaction.execute({
      sql: `
        delete from agent_task_jobs
        where user_id = ?
          and run_id = ?
          and queue_name = ?
          and status in ('done', 'error', 'cancelled')
      `,
      args: [userId, runId, queueName],
    })
    return deleted.rowsAffected === 1
  }))
}

function persistedEventFromRow(row: Record<string, unknown> | undefined, runId: string): RecordedTaskEvent | null {
  if (!row) return null
  try {
    const seq = Number(row.seq)
    const event = JSON.parse(String(row.event_json)) as SSEEvent
    const createdAt = Number(row.created_at_ms)
    if (!Number.isFinite(seq)) return null
    return {
      seq,
      event: { ...event, seq, runId } as SSEEvent,
      createdAt: Number.isFinite(createdAt) ? createdAt : nowMs(),
    }
  } catch {
    return null
  }
}

async function loadPersistedTaskEvents(runId: string, afterSeq: number): Promise<RecordedTaskEvent[]> {
  if (!shouldUseDatabaseTaskJobs()) return []
  return withTaskJobSchemaRepair(async () => {
    const eventRows = await tursoExecute(
      `
        select seq, event_json, created_at_ms
        from agent_task_events
        where run_id = ? and seq > ?
        order by seq asc
        limit ?
      `,
      [runId, Math.max(0, afterSeq), TASK_JOB_REPLAY_PAGE_SIZE],
    )
    return eventRows.rows
      .map((eventRow) => persistedEventFromRow(eventRow as Record<string, unknown>, runId))
      .filter((event): event is RecordedTaskEvent => event !== null)
  })
}

async function loadPersistedBrowserFrame(
  runId: string,
  afterVersion: number,
): Promise<RecordedTaskFrame | null> {
  if (!shouldUseDatabaseTaskJobs()) return null
  return withTaskJobSchemaRepair(async () => {
    const rows = await tursoExecute(
      `
        select frame_version, event_json, created_at_ms
        from agent_task_live_frames
        where run_id = ? and frame_version > ?
        limit 1
      `,
      [runId, Math.max(0, afterVersion)],
    )
    const row = rows.rows[0]
    if (!row) return null
    try {
      const version = Number(row.frame_version)
      const createdAt = Number(row.created_at_ms)
      const event = JSON.parse(String(row.event_json)) as SSEEvent
      if (!Number.isFinite(version) || event.type !== 'browser_frame') return null
      return {
        version,
        event: { ...event, runId } as SSEEvent,
        createdAt: Number.isFinite(createdAt) ? createdAt : nowMs(),
      }
    } catch {
      return null
    }
  })
}

async function loadPersistedTaskJobStatus(
  userId: string,
  runId: string,
): Promise<PersistedJobStatus | null> {
  if (!shouldUseDatabaseTaskJobs()) return null
  return withTaskJobSchemaRepair(async () => {
    const queueName = taskQueueName()
    const jobRows = await tursoExecute(
      `
        select status, terminal_status, terminal_error
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      [userId, runId, queueName],
    )
    const row = jobRows.rows[0]
    if (!row) return null
    return {
      status: normalizeStatus(row.status),
      terminalStatus: normalizeTerminalStatus(row.terminal_status),
      terminalError: typeof row.terminal_error === 'string' ? row.terminal_error : null,
    }
  })
}

async function loadPersistedTaskJobSnapshot(
  userId: string,
  runId: string,
  afterSeq: number,
): Promise<PersistedJobSnapshot | null> {
  if (!shouldUseDatabaseTaskJobs()) return null
  return withTaskJobSchemaRepair(async () => {
    const queueName = taskQueueName()
    const jobRows = await tursoExecute(
      `
        select run_id, user_id, conversation_id, status, terminal_status, terminal_error
        from agent_task_jobs
        where user_id = ? and run_id = ? and queue_name = ?
        limit 1
      `,
      [userId, runId, queueName],
    )
    const row = jobRows.rows[0]
    if (!row || typeof row.run_id !== 'string' || typeof row.user_id !== 'string' || typeof row.conversation_id !== 'string') {
      return null
    }

    return {
      runId,
      userId,
      conversationId: row.conversation_id,
      status: normalizeStatus(row.status),
      terminalStatus: normalizeTerminalStatus(row.terminal_status),
      terminalError: typeof row.terminal_error === 'string' ? row.terminal_error : null,
      events: await loadPersistedTaskEvents(runId, afterSeq),
    }
  })
}

function replayEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  events: RecordedTaskEvent[],
): void {
  for (const record of events) {
    controller.enqueue(encoder.encode(encodeSSE(record.event)))
  }
}

function attachSubscriber(job: TaskJob, controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder): TaskJobSubscriber {
  const subscriber: TaskJobSubscriber = {
    id: randomUUID(),
    controller,
    encoder,
    closed: false,
    keepAliveTimer: null,
  }
  subscriber.keepAliveTimer = setInterval(() => {
    sendEventToSubscriber(subscriber, { type: 'heartbeat', timestamp: nowMs(), runId: job.runId })
  }, TASK_JOB_KEEP_ALIVE_MS)
  job.subscribers.set(subscriber.id, subscriber)
  return subscriber
}

export function createTaskJobEventStream(input: {
  userId: string
  runId: string
  conversationId?: string
  afterSeq?: number
  signal?: AbortSignal
}): ReadableStream<Uint8Array> {
  let activeSubscriber: TaskJobSubscriber | null = null
  let activePollTimer: ReturnType<typeof setInterval> | null = null
  let activeHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let activeAbortCleanup: (() => void) | null = null
  let streamClosed = false

  const cleanupSubscriber = () => {
    if (!activeSubscriber) return
    activeSubscriber.closed = true
    if (activeSubscriber.keepAliveTimer) clearInterval(activeSubscriber.keepAliveTimer)
    const job = taskJobState.jobs.get(input.runId)
    job?.subscribers.delete(activeSubscriber.id)
    activeSubscriber = null
  }

  const cleanupTimers = () => {
    if (activePollTimer) {
      clearInterval(activePollTimer)
      activePollTimer = null
    }
    if (activeHeartbeatTimer) {
      clearInterval(activeHeartbeatTimer)
      activeHeartbeatTimer = null
    }
  }

  const cleanupAbortListener = () => {
    activeAbortCleanup?.()
    activeAbortCleanup = null
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let lastSeq = Math.max(0, Math.floor(input.afterSeq || 0))
      let lastFrameVersion = 0

      const close = () => {
        if (streamClosed) return
        streamClosed = true
        cleanupSubscriber()
        cleanupTimers()
        cleanupAbortListener()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }

      const failTransport = (error: unknown) => {
        if (streamClosed) return
        streamClosed = true
        cleanupSubscriber()
        cleanupTimers()
        cleanupAbortListener()
        controller.error(error instanceof Error ? error : new Error(String(error)))
      }

      if (input.signal) {
        input.signal.addEventListener('abort', close, { once: true })
        activeAbortCleanup = () => input.signal?.removeEventListener('abort', close)
        if (input.signal.aborted) {
          close()
          return
        }
      }

      // Flush the SSE response immediately after the route's durable task
      // reservation has completed. Without a body chunk, Next may hold the
      // response headers while the durable replay path performs its initial
      // reconciliation and snapshot reads. Heartbeats are deliberately
      // unsequenced transport events, so this does not advance the replay
      // cursor or replace the persisted initial event.
      controller.enqueue(encoder.encode(encodeSSE({
        type: 'heartbeat',
        timestamp: nowMs(),
        runId: input.runId,
      })))

      const terminalError = (message: string): SSEEvent => ({
        type: 'error',
        message,
        seq: lastSeq + 1,
        runId: input.runId,
      })

      const terminalDone = (): SSEEvent => ({
        type: 'done',
        seq: lastSeq + 1,
        runId: input.runId,
      })

      try {
        // DB-backed jobs always replay through the durable poller, even when
        // their runner lives in this process. This prevents an attaching
        // subscriber from observing provisional job.events before commit.
        const job = shouldUseDatabaseTaskJobs() ? undefined : taskJobState.jobs.get(input.runId)
        if (job) {
          if (job.userId !== input.userId || job.queueName !== taskQueueName() || (input.conversationId && job.conversationId !== input.conversationId)) {
            controller.enqueue(encoder.encode(encodeSSE(terminalError('Task access denied'))))
            close()
            return
          }

          replayEvents(controller, encoder, job.events.filter((record) => (
            record.seq > lastSeq &&
            (record.event.type !== 'done' && record.event.type !== 'error' || job.terminalCommitted)
          )))
          if (job.latestBrowserFrame && !job.terminalStatus) {
            controller.enqueue(encoder.encode(encodeSSE(job.latestBrowserFrame)))
          }
          if (job.closed || (job.terminalStatus && job.terminalCommitted)) {
            close()
            return
          }
          activeSubscriber = attachSubscriber(job, controller, encoder)
          return
        }

        let pollInFlight = false
        let lastStatusPollAt = 0
        const replayPersistedEvents = async (): Promise<boolean> => {
          const events = await loadPersistedTaskEvents(input.runId, lastSeq)
          if (streamClosed) return true
          replayEvents(controller, encoder, events)
          for (const record of events) {
            lastSeq = Math.max(lastSeq, record.seq)
          }

          const hasTerminalEvent = events.some((record) => record.event.type === 'done' || record.event.type === 'error')
          if (hasTerminalEvent) return true
          // Drain every durable page before consulting terminal row fallback;
          // otherwise a completed job could close the stream ahead of older
          // events that have not been replayed yet.
          if (events.length >= TASK_JOB_REPLAY_PAGE_SIZE) return false

          const frame = await loadPersistedBrowserFrame(input.runId, lastFrameVersion)
          if (streamClosed) return true
          if (frame) {
            controller.enqueue(encoder.encode(encodeSSE(frame.event)))
            lastFrameVersion = frame.version
          }

          const now = nowMs()
          if (now - lastStatusPollAt < TASK_JOB_STATUS_POLL_MS) return false
          lastStatusPollAt = now

          await reconcileExpiredDurableTaskJob({
            userId: input.userId,
            runId: input.runId,
            conversationId: input.conversationId,
          })
          if (streamClosed) return true
          const status = await loadPersistedTaskJobStatus(input.userId, input.runId)
          if (streamClosed) return true
          if (!status) {
            controller.enqueue(encoder.encode(encodeSSE(terminalError('The task is no longer available.'))))
            return true
          }

          if (status.status === 'done' || status.status === 'error' || status.status === 'cancelled') {
            const event = status.status === 'done' && status.terminalStatus !== 'error'
              ? terminalDone()
              : terminalError(status.terminalError || (status.status === 'cancelled'
                  ? 'Task stopped.'
                  : 'The task stopped before it finished. Please try again.'))
            controller.enqueue(encoder.encode(encodeSSE(event)))
            return true
          }

          return false
        }

        await reconcileExpiredDurableTaskJob({
          userId: input.userId,
          runId: input.runId,
          conversationId: input.conversationId,
        })
        if (streamClosed) return
        const snapshot = await loadPersistedTaskJobSnapshot(input.userId, input.runId, lastSeq)
        if (streamClosed) return
        if (!snapshot) {
          controller.enqueue(encoder.encode(encodeSSE(terminalError('The task is no longer available.'))))
          close()
          return
        }
        if (input.conversationId && snapshot.conversationId !== input.conversationId) {
          controller.enqueue(encoder.encode(encodeSSE(terminalError('Task access denied'))))
          close()
          return
        }
        lastStatusPollAt = nowMs()

        replayEvents(controller, encoder, snapshot.events)
        for (const record of snapshot.events) {
          lastSeq = Math.max(lastSeq, record.seq)
        }
        const hasTerminalEvent = snapshot.events.some((record) => record.event.type === 'done' || record.event.type === 'error')
        const replayPageFull = snapshot.events.length >= TASK_JOB_REPLAY_PAGE_SIZE
        if (!hasTerminalEvent && !replayPageFull && snapshot.status !== 'done' && snapshot.status !== 'error' && snapshot.status !== 'cancelled') {
          const frame = await loadPersistedBrowserFrame(input.runId, lastFrameVersion)
          if (streamClosed) return
          if (frame) {
            controller.enqueue(encoder.encode(encodeSSE(frame.event)))
            lastFrameVersion = frame.version
          }
        }
        if (hasTerminalEvent || (!replayPageFull && (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled'))) {
          if (!hasTerminalEvent) {
            const event = snapshot.status === 'done' && snapshot.terminalStatus !== 'error'
              ? terminalDone()
              : terminalError(snapshot.terminalError || (snapshot.status === 'cancelled'
                  ? 'Task stopped.'
                  : 'The task stopped before it finished. Please try again.'))
            controller.enqueue(encoder.encode(encodeSSE(event)))
          }
          close()
          return
        }

        activeHeartbeatTimer = setInterval(() => {
          if (!streamClosed) {
            controller.enqueue(encoder.encode(encodeSSE({ type: 'heartbeat', timestamp: nowMs(), runId: input.runId })))
          }
        }, TASK_JOB_KEEP_ALIVE_MS)
        activePollTimer = setInterval(() => {
          if (streamClosed || pollInFlight) return
          pollInFlight = true
          void replayPersistedEvents().then((terminal) => {
            if (terminal) close()
          }).catch((error) => {
            failTransport(error)
          }).finally(() => {
            pollInFlight = false
          })
        }, TASK_JOB_DB_POLL_MS)
      } catch (error) {
        failTransport(error)
      }
    },
    cancel() {
      streamClosed = true
      cleanupSubscriber()
      cleanupTimers()
      cleanupAbortListener()
    },
  })
}

export function clearTaskJobsForTest(): void {
  for (const scheduled of scheduledCancellationFences.values()) {
    clearTimeout(scheduled.timer)
  }
  scheduledCancellationFences.clear()
  preStartCancellationState.clear()
  lastPreStartCancellationPruneAt = 0
  for (const job of taskJobState.jobs.values()) {
    job.abortController.abort()
    if (job.terminalCleanupTimer) clearTimeout(job.terminalCleanupTimer)
    clearPendingTextPersistenceTimer(job)
    clearPendingBrowserFramePersistenceTimer(job)
    closeJobSubscribers(job)
  }
  taskJobState.jobs.clear()
}
