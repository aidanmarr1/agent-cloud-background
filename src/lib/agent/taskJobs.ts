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
import type { CreditLedgerEvent, CreditTokenUsage } from '@/lib/creditPolicy'
import { getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'
import { encodeSSE } from '@/lib/stream'
import { userErrorMessage } from '@/lib/errorMessages'
import { releaseActiveTaskLease } from '@/lib/activeTasks'
import { taskQueueName } from './taskQueue'
import type { AgentEventEmitter } from './SSEEmitter'
import type { BackgroundProbeTaskPayload, ChatTaskPayload, TaskJobPayload } from './chatTaskRunner'

export type TaskJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface RecordedTaskEvent {
  seq: number
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
  cancelRequested: boolean
  closed: boolean
  nextSeq: number
  events: RecordedTaskEvent[]
  subscribers: Map<string, TaskJobSubscriber>
  abortController: AbortController
  emitter: TaskJobEmitter | null
  promise: Promise<void> | null
  persistChain: Promise<void>
  requeueRequested: boolean
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
}

export interface ActiveTaskJobSummary {
  runId: string
  userId: string
  conversationId: string
  queueName: string
  status: 'queued' | 'running'
  startedAt: number
  updatedAt: number
  attempts: number
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

type TaskJobRow = {
  run_id?: unknown
  user_id?: unknown
  conversation_id?: unknown
  queue_name?: unknown
  status?: unknown
  started_at_ms?: unknown
  updated_at_ms?: unknown
  attempts?: unknown
}

const taskJobStateKey = '__agentTaskJobState' as const
const taskJobState: TaskJobState =
  (globalThis as unknown as Record<string, TaskJobState>)[taskJobStateKey] ??
  ((globalThis as unknown as Record<string, TaskJobState>)[taskJobStateKey] = {
    jobs: new Map(),
  })

const TASK_JOB_EVENT_PERSIST_LIMIT_BYTES = 256 * 1024
const TASK_JOB_TEXT_FIELD_PERSIST_LIMIT_CHARS = 64 * 1024
const TASK_JOB_INLINE_IMAGE_PLACEHOLDER = '[inline image omitted from persisted task replay]'
const TASK_JOB_TRUNCATED_OBJECT_PLACEHOLDER = '[nested value omitted from persisted task replay]'
const TASK_JOB_OBJECT_FIELD_LIMIT = 160
const TASK_JOB_ARRAY_ITEM_LIMIT = 80
const TASK_JOB_OBJECT_DEPTH_LIMIT = 8
const TASK_JOB_MEMORY_EVENT_LIMIT = 10_000
const TASK_JOB_KEEP_ALIVE_MS = 15_000
const TASK_JOB_DB_POLL_MS = 250
const TASK_JOB_WORKER_LEASE_MS = 60_000
const TASK_JOB_WORKER_REFRESH_MS = 15_000
const TASK_JOB_CANCEL_POLL_MS = 2_000
const TASK_JOB_WORKER_MAX_ATTEMPTS = 3

let taskJobSchemaPromise: Promise<void> | null = null

function shouldUseDatabaseTaskJobs(): boolean {
  return getTursoSetupStatus().configured
}

function nowMs(): number {
  return Date.now()
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
    (row.status !== 'queued' && row.status !== 'running')
  ) {
    return null
  }
  const now = nowMs()
  const startedAt = Number(row.started_at_ms)
  const updatedAt = Number(row.updated_at_ms)
  const attempts = Number(row.attempts)
  return {
    runId: row.run_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    queueName: typeof row.queue_name === 'string' && row.queue_name ? row.queue_name : 'default',
    status: row.status,
    startedAt: Number.isFinite(startedAt) ? startedAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
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
    })().catch((error) => {
      taskJobSchemaPromise = null
      throw error
    })
  }
  return taskJobSchemaPromise
}

function queuePersistence(job: TaskJob, work: () => Promise<void>): void {
  if (!shouldUseDatabaseTaskJobs()) return
  job.persistChain = job.persistChain
    .then(work, work)
    .catch((error) => {
      console.error('[TaskJobs] Persistence failed', {
        runId: job.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
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
  return {
    ...artifact,
    content: compactStringForPersistence(artifact.content),
    imageDataUrl: artifact.imageDataUrl ? TASK_JOB_INLINE_IMAGE_PLACEHOLDER : undefined,
  }
}

function compactEventForPersistence(event: SSEEvent): SSEEvent {
  switch (event.type) {
    case 'text_delta':
      return { ...event, content: compactStringForPersistence(event.content) }
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
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        name: event.name,
        result: minimalToolResultForPersistence(event.name),
        seq: event.seq,
        runId: event.runId,
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
      return { type: 'heartbeat', timestamp: nowMs(), seq: event.seq, runId: event.runId }
  }
}

function stringifyEventForPersistence(event: SSEEvent): string {
  for (const candidate of [event, compactEventForPersistence(event), minimalEventForPersistence(event)]) {
    try {
      const eventJson = JSON.stringify(candidate)
      if (eventJson.length <= TASK_JOB_EVENT_PERSIST_LIMIT_BYTES) return eventJson
    } catch {
      // Try the next, smaller representation.
    }
  }

  return JSON.stringify({ type: 'heartbeat', timestamp: nowMs(), seq: event.seq, runId: event.runId } satisfies SSEEvent)
}

async function persistJob(job: TaskJob): Promise<void> {
  await ensureTaskJobSchema()
  await tursoExecute(
    `
      insert into agent_task_jobs (
        run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
        started_at_ms, updated_at_ms, completed_at_ms
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(run_id) do update set
        queue_name = excluded.queue_name,
        status = excluded.status,
        terminal_status = excluded.terminal_status,
        terminal_error = excluded.terminal_error,
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
    ],
  )
}

async function persistEvent(job: TaskJob, record: RecordedTaskEvent): Promise<void> {
  await ensureTaskJobSchema()
  const eventJson = stringifyEventForPersistence(record.event)
  await tursoExecute(
    `
      insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
      values (?, ?, ?, ?)
    `,
    [job.runId, record.seq, eventJson, record.createdAt],
  )
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
    return {
      kind: 'chat',
      messages: chatPayload.messages as ChatTaskPayload['messages'],
      model: chatPayload.model,
      customInstructions: typeof chatPayload.customInstructions === 'string' ? chatPayload.customInstructions : undefined,
      startFreshSandbox: chatPayload.startFreshSandbox === true,
      startIsolatedTaskSandbox: chatPayload.startIsolatedTaskSandbox,
      directChat: chatPayload.directChat,
    }
  } catch {
    return null
  }
}

async function nextPersistedEventSeq(runId: string): Promise<number> {
  if (!shouldUseDatabaseTaskJobs()) return 1
  await ensureTaskJobSchema()
  const rows = await tursoExecute(
    'select max(seq) as max_seq from agent_task_events where run_id = ?',
    [runId],
  )
  const maxSeq = Number(rows.rows[0]?.max_seq)
  return Number.isFinite(maxSeq) ? Math.max(1, maxSeq + 1) : 1
}

async function insertPersistedErrorEvent(runId: string, message: string): Promise<void> {
  if (!shouldUseDatabaseTaskJobs()) return
  await ensureTaskJobSchema()
  const seq = await nextPersistedEventSeq(runId)
  const event = { type: 'error', message: userErrorMessage(message, 'The task stopped before it finished. Please try again.'), seq, runId } as SSEEvent
  await tursoExecute(
    `
      insert or ignore into agent_task_events (run_id, seq, event_json, created_at_ms)
      values (?, ?, ?, ?)
    `,
    [runId, seq, JSON.stringify(event), nowMs()],
  )
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

function recordTaskJobEvent(job: TaskJob, event: SSEEvent): void {
  if (job.closed) return

  const seq = job.nextSeq++
  const createdAt = nowMs()
  const eventWithMeta = { ...event, seq, runId: job.runId } as SSEEvent
  const record: RecordedTaskEvent = { seq, event: eventWithMeta, createdAt }

  if (event.type === 'done') {
    job.terminalStatus = 'done'
    job.terminalError = null
  } else if (event.type === 'error') {
    job.terminalStatus = 'error'
    job.terminalError = event.message
  }

  job.updatedAt = createdAt
  job.events.push(record)
  if (job.events.length > TASK_JOB_MEMORY_EVENT_LIMIT) {
    job.events.splice(0, job.events.length - TASK_JOB_MEMORY_EVENT_LIMIT)
  }

  queuePersistence(job, () => persistEvent(job, record))
  for (const subscriber of job.subscribers.values()) {
    sendEventToSubscriber(subscriber, eventWithMeta)
  }
}

class TaskJobEmitter implements AgentEventEmitter {
  constructor(private job: TaskJob) {}

  get isClosed(): boolean {
    return this.job.closed
  }

  get terminalStatus(): 'done' | 'error' | null {
    return this.job.terminalStatus
  }

  heartbeat(): void {
    recordTaskJobEvent(this.job, { type: 'heartbeat', timestamp: nowMs() })
  }

  textDelta(content: string): void {
    recordTaskJobEvent(this.job, { type: 'text_delta', content })
  }

  reasoningDelta(content: string): void {
    recordTaskJobEvent(this.job, { type: 'reasoning_delta', content })
  }

  reasoningDone(): void {
    recordTaskJobEvent(this.job, { type: 'reasoning_done' })
  }

  toolStart(id: string, name: string, args: Record<string, unknown>): void {
    recordTaskJobEvent(this.job, { type: 'tool_start', id, name, args })
  }

  toolResult(id: string, name: string, result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult): void {
    recordTaskJobEvent(this.job, { type: 'tool_result', id, name, result })
  }

  browserFrame(frame: string): void {
    recordTaskJobEvent(this.job, { type: 'browser_frame', frame, timestamp: nowMs() })
  }

  terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string): void {
    recordTaskJobEvent(this.job, { type: 'terminal_output', id, stream, data })
  }

  fileContentStart(id: string, path: string, toolName?: string): void {
    recordTaskJobEvent(this.job, { type: 'file_content_start', id, path, toolName })
  }

  fileContentDelta(id: string, content: string): void {
    recordTaskJobEvent(this.job, { type: 'file_content_delta', id, content })
  }

  plan(items: string[]): void {
    recordTaskJobEvent(this.job, { type: 'plan', items })
  }

  artifactCreated(artifact: Artifact): void {
    recordTaskJobEvent(this.job, { type: 'artifact_created', artifact })
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
    this.job.closed = true
    closeJobSubscribers(this.job)
  }
}

async function runTaskJob(
  job: TaskJob,
  runner: (emitter: AgentEventEmitter, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const emitter = new TaskJobEmitter(job)
  job.emitter = emitter
  job.status = 'running'
  job.updatedAt = nowMs()
  queuePersistence(job, () => persistJob(job))

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
      await job.persistChain.catch(() => undefined)
      emitter.close()
      return
    }

    job.status = job.cancelRequested
      ? 'cancelled'
      : job.terminalStatus === 'done'
        ? 'done'
        : 'error'
    job.completedAt = nowMs()
    job.updatedAt = job.completedAt
    queuePersistence(job, () => persistJob(job))
    await job.persistChain.catch(() => undefined)
    emitter.close()
  }
}

export async function startTaskJob(input: {
  runId: string
  userId: string
  conversationId: string
  runner: (emitter: AgentEventEmitter, signal: AbortSignal) => Promise<void>
}): Promise<{ runId: string; status: TaskJobStatus }> {
  const existing = taskJobState.jobs.get(input.runId)
  if (existing) return { runId: existing.runId, status: existing.status }

  const startedAt = nowMs()
  const job: TaskJob = {
    runId: input.runId,
    userId: input.userId,
    conversationId: input.conversationId,
    queueName: taskQueueName(),
    status: 'queued',
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    terminalStatus: null,
    terminalError: null,
    cancelRequested: false,
    closed: false,
    nextSeq: 1,
    events: [],
    subscribers: new Map(),
    abortController: new AbortController(),
    emitter: null,
    promise: null,
    persistChain: Promise.resolve(),
    requeueRequested: false,
  }

  taskJobState.jobs.set(job.runId, job)
  if (shouldUseDatabaseTaskJobs()) {
    await persistJob(job)
  }

  job.promise = runTaskJob(job, input.runner)
  void job.promise
  return { runId: job.runId, status: job.status }
}

export async function enqueueTaskJob(input: {
  runId: string
  userId: string
  conversationId: string
  payload: TaskJobPayload
}): Promise<{ runId: string; status: TaskJobStatus }> {
  if (!shouldUseDatabaseTaskJobs()) {
    throw new Error('External task worker mode requires Turso to be configured.')
  }

  await ensureTaskJobSchema()
  const createdAt = nowMs()
  const queueName = taskQueueName()
  await tursoExecute(
    `
      insert into agent_task_jobs (
        run_id, user_id, conversation_id, queue_name, status, terminal_status, terminal_error,
        started_at_ms, updated_at_ms, completed_at_ms, payload_json, worker_id,
        lease_expires_at_ms, attempts, cancel_requested
      )
      values (?, ?, ?, ?, 'queued', null, null, ?, ?, null, ?, null, null, 0, 0)
      on conflict(run_id) do nothing
    `,
    [
      input.runId,
      input.userId,
      input.conversationId,
      queueName,
      createdAt,
      createdAt,
      JSON.stringify(input.payload),
    ],
  )
  return { runId: input.runId, status: 'queued' }
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
      !job.cancelRequested &&
      !job.terminalStatus &&
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
      attempts: 0,
    }
  }

  if (!shouldUseDatabaseTaskJobs()) return null

  await ensureTaskJobSchema()
  const result = await tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, started_at_ms, updated_at_ms, attempts
      from agent_task_jobs
      where user_id = ?
        and conversation_id = ?
        and queue_name = ?
        and status in ('queued', 'running')
        and terminal_status is null
        and cancel_requested = 0
      order by updated_at_ms desc
      limit 1
    `,
    [userId, conversationId, queueName],
  )
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
      !job.cancelRequested &&
      !job.terminalStatus &&
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
      attempts: 0,
    }
  }

  if (!shouldUseDatabaseTaskJobs()) return null

  await ensureTaskJobSchema()
  const result = await tursoExecute(
    `
      select run_id, user_id, conversation_id, queue_name, status, started_at_ms, updated_at_ms, attempts
      from agent_task_jobs
      where user_id = ?
        and queue_name = ?
        and status in ('queued', 'running')
        and terminal_status is null
        and cancel_requested = 0
      order by updated_at_ms desc
      limit 1
    `,
    [userId, queueName],
  )
  return rowToActiveTaskJobSummary(result.rows[0] as TaskJobRow | undefined)
}

export async function claimNextTaskJob(workerId: string, leaseMs = TASK_JOB_WORKER_LEASE_MS): Promise<ClaimedTaskJob | null> {
  if (!workerId) throw new Error('Missing worker id')
  if (!shouldUseDatabaseTaskJobs()) {
    throw new Error('Task worker requires Turso to be configured.')
  }

  await ensureTaskJobSchema()
  const now = nowMs()
  const leaseExpiresAt = now + leaseMs
  const queueName = taskQueueName()
  const maxAttempts = taskWorkerMaxAttempts()

  type ClaimResult = ClaimedTaskJob | { exhausted: true; runId: string; userId: string } | null
  const result = await tursoTransaction('write', async (transaction): Promise<ClaimResult> => {
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
          and lease_expires_at_ms is not null
          and lease_expires_at_ms <= ?
      `,
      args: [now, queueName, now],
    })

    const selected = await transaction.execute({
      sql: `
        select run_id, user_id, conversation_id, queue_name, payload_json, started_at_ms, attempts
        from agent_task_jobs
        where status = 'queued'
          and queue_name = ?
          and terminal_status is null
          and cancel_requested = 0
          and payload_json is not null
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
      await transaction.execute({
        sql: `
          update agent_task_jobs
          set status = 'error',
              terminal_status = 'error',
              terminal_error = 'Task payload could not be read.',
              updated_at_ms = ?,
              completed_at_ms = ?
          where run_id = ? and queue_name = ?
        `,
        args: [now, now, row.run_id, queueName],
      })
      return null
    }

    const attempts = Math.max(0, Number(row.attempts || 0)) + 1
    if (attempts > maxAttempts) {
      const terminalError = `Task stopped after ${maxAttempts} worker claim attempt${maxAttempts === 1 ? '' : 's'}.`
      const exhausted = await transaction.execute({
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
            and status = 'queued'
            and queue_name = ?
            and terminal_status is null
            and cancel_requested = 0
        `,
        args: [terminalError, now, now, row.run_id, queueName],
      })
      if (exhausted.rowsAffected !== 1) return null
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
      return { exhausted: true, runId: row.run_id, userId: row.user_id }
    }

    const claimed = await transaction.execute({
      sql: `
        update agent_task_jobs
        set status = 'running',
            worker_id = ?,
            lease_expires_at_ms = ?,
            attempts = ?,
            updated_at_ms = ?
        where run_id = ?
          and status = 'queued'
          and queue_name = ?
          and cancel_requested = 0
      `,
      args: [workerId, leaseExpiresAt, attempts, now, row.run_id, queueName],
    })

    if (claimed.rowsAffected !== 1) return null

    return {
      runId: row.run_id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      queueName,
      payload,
      workerId,
      startedAt: Number.isFinite(Number(row.started_at_ms)) ? Number(row.started_at_ms) : now,
      attempts,
    }
  })

  if (result && 'exhausted' in result) {
    await releaseActiveTaskLease(result.userId, result.runId).catch((error) => {
      console.error('[TaskJobs] Failed to release active task lease after worker retry exhaustion', {
        runId: result.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return null
  }

  return result
}

export async function refreshTaskJobClaim(runId: string, workerId: string, leaseMs = TASK_JOB_WORKER_LEASE_MS): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  await ensureTaskJobSchema()
  const now = nowMs()
  const queueName = taskQueueName()
  const result = await tursoExecute(
    `
      update agent_task_jobs
      set lease_expires_at_ms = ?,
          updated_at_ms = ?
      where run_id = ?
        and worker_id = ?
        and queue_name = ?
        and status = 'running'
        and cancel_requested = 0
    `,
    [now + leaseMs, now, runId, workerId, queueName],
  )
  return result.rowsAffected === 1
}

export async function releaseTaskJobClaim(runId: string, workerId: string): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  await ensureTaskJobSchema()
  const now = nowMs()
  const queueName = taskQueueName()
  const result = await tursoExecute(
    `
      update agent_task_jobs
      set status = 'queued',
          worker_id = null,
          lease_expires_at_ms = null,
          updated_at_ms = ?
      where run_id = ?
        and worker_id = ?
        and queue_name = ?
        and status = 'running'
        and terminal_status is null
        and cancel_requested = 0
    `,
    [now, runId, workerId, queueName],
  )
  return result.rowsAffected === 1
}

async function taskJobCancelRequested(runId: string, workerId: string): Promise<boolean> {
  if (!shouldUseDatabaseTaskJobs()) return false
  await ensureTaskJobSchema()
  const queueName = taskQueueName()
  const rows = await tursoExecute(
    `
      select cancel_requested, status
      from agent_task_jobs
      where run_id = ? and worker_id = ? and queue_name = ?
      limit 1
    `,
    [runId, workerId, queueName],
  )
  const row = rows.rows[0]
  return row?.cancel_requested === 1 || row?.cancel_requested === true || row?.status === 'cancelled'
}

export async function runClaimedTaskJob(
  claim: ClaimedTaskJob,
  runner: (emitter: AgentEventEmitter, signal: AbortSignal) => Promise<void>,
  options: { shutdownSignal?: AbortSignal } = {},
): Promise<'completed' | 'requeued'> {
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
    cancelRequested: false,
    closed: false,
    nextSeq: await nextPersistedEventSeq(claim.runId),
    events: [],
    subscribers: new Map(),
    abortController: new AbortController(),
    emitter: null,
    promise: null,
    persistChain: Promise.resolve(),
    requeueRequested: false,
  }

  taskJobState.jobs.set(job.runId, job)
  let releaseClaimPromise: Promise<boolean> | null = null

  const releaseClaimOnce = () => {
    releaseClaimPromise ??= releaseTaskJobClaim(claim.runId, claim.workerId).catch((error) => {
      console.error('[TaskJobs] Failed to release worker lease during shutdown', {
        runId: claim.runId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    })
    return releaseClaimPromise
  }

  const releaseClaimForShutdown = () => {
    if (job.requeueRequested || job.terminalStatus) return
    job.requeueRequested = true
    job.closed = true
    closeJobSubscribers(job)
    job.abortController.abort()
  }

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

  const refreshTimer = setInterval(() => {
    void refreshTaskJobClaim(claim.runId, claim.workerId).then((refreshed) => {
      if (!refreshed && !job.requeueRequested && !job.terminalStatus) {
        job.cancelRequested = true
        job.abortController.abort()
        job.emitter?.error('The task worker lost its job lease.')
      }
    }).catch((error) => {
      console.error('[TaskJobs] Failed to refresh worker lease', {
        runId: claim.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, TASK_JOB_WORKER_REFRESH_MS)

  const cancelTimer = setInterval(() => {
    void taskJobCancelRequested(claim.runId, claim.workerId).then((cancelRequested) => {
      if (cancelRequested && !job.requeueRequested && !job.terminalStatus) {
        job.cancelRequested = true
        job.abortController.abort()
        job.emitter?.error('Task stopped.')
      }
    }).catch((error) => {
      console.error('[TaskJobs] Failed to poll task cancellation', {
        runId: claim.runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, TASK_JOB_CANCEL_POLL_MS)

  try {
    await runTaskJob(job, runner)
  } finally {
    clearInterval(refreshTimer)
    clearInterval(cancelTimer)
    options.shutdownSignal?.removeEventListener('abort', releaseClaimForShutdown)
    if (job.requeueRequested) await releaseClaimOnce()
    taskJobState.jobs.delete(job.runId)
  }
  return job.requeueRequested ? 'requeued' : 'completed'
}

export async function cancelTaskJob(userId: string, runId: string): Promise<boolean> {
  const queueName = taskQueueName()
  const job = taskJobState.jobs.get(runId)
  const releaseCancelledLease = () => releaseActiveTaskLease(userId, runId).catch((error) => {
    console.error('[TaskJobs] Failed to release active task lease during cancellation', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  if (job) {
    if (job.userId !== userId || job.queueName !== queueName) return false
    job.cancelRequested = true
    job.abortController.abort()
    if (!job.terminalStatus) {
      job.emitter?.error('Task stopped.')
    }
    job.emitter?.close()
    await releaseCancelledLease()
    return true
  }

  const snapshot = await loadPersistedTaskJobSnapshot(userId, runId, 0)
  if (!snapshot) return false
  if (snapshot.status !== 'running' && snapshot.status !== 'queued') {
    await releaseCancelledLease()
    return true
  }

  await ensureTaskJobSchema()
  const now = nowMs()
  if (snapshot.status === 'queued') {
    await tursoExecute(
      `
        update agent_task_jobs
        set status = 'cancelled',
            terminal_status = 'error',
            terminal_error = 'Task stopped.',
            cancel_requested = 1,
            updated_at_ms = ?,
            completed_at_ms = ?
        where user_id = ? and run_id = ? and queue_name = ?
      `,
      [now, now, userId, runId, queueName],
    )
    await insertPersistedErrorEvent(runId, 'Task stopped.')
    await releaseCancelledLease()
    return true
  }

  await tursoExecute(
    `
      update agent_task_jobs
      set status = 'cancelled',
          terminal_status = 'error',
          terminal_error = 'Task stopped.',
          cancel_requested = 1,
          updated_at_ms = ?,
          completed_at_ms = ?
      where user_id = ? and run_id = ? and queue_name = ?
    `,
    [now, now, userId, runId, queueName],
  )
  await insertPersistedErrorEvent(runId, 'Task stopped.')
  await releaseCancelledLease()
  return true
}

export async function cleanupInternalTaskJob(userId: string, runId: string): Promise<boolean> {
  if (!userId.startsWith('internal-background-smoke-') || !runId.startsWith('background-smoke-')) {
    return false
  }
  if (!shouldUseDatabaseTaskJobs()) return false

  await ensureTaskJobSchema()
  const queueName = taskQueueName()
  return tursoTransaction('write', async (transaction) => {
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
  })
}

async function loadPersistedTaskJobSnapshot(
  userId: string,
  runId: string,
  afterSeq: number,
): Promise<PersistedJobSnapshot | null> {
  if (!shouldUseDatabaseTaskJobs()) return null
  await ensureTaskJobSchema()
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

  const eventRows = await tursoExecute(
    `
      select seq, event_json, created_at_ms
      from agent_task_events
      where run_id = ? and seq > ?
      order by seq asc
    `,
    [runId, Math.max(0, afterSeq)],
  )

  const events = eventRows.rows
    .map((eventRow) => {
      try {
        const seq = Number(eventRow.seq)
        const event = JSON.parse(String(eventRow.event_json)) as SSEEvent
        const createdAt = Number(eventRow.created_at_ms)
        if (!Number.isFinite(seq)) return null
        return {
          seq,
          event: { ...event, seq, runId } as SSEEvent,
          createdAt: Number.isFinite(createdAt) ? createdAt : nowMs(),
        }
      } catch {
        return null
      }
    })
    .filter((event): event is RecordedTaskEvent => event !== null)

  return {
    runId,
    userId,
    conversationId: row.conversation_id,
    status: normalizeStatus(row.status),
    terminalStatus: normalizeTerminalStatus(row.terminal_status),
    terminalError: typeof row.terminal_error === 'string' ? row.terminal_error : null,
    events,
  }
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
  let activeController: ReadableStreamDefaultController<Uint8Array> | null = null
  let activePollTimer: ReturnType<typeof setInterval> | null = null
  let activeHeartbeatTimer: ReturnType<typeof setInterval> | null = null

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

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      activeController = controller
      const encoder = new TextEncoder()
      let lastSeq = Math.max(0, Math.floor(input.afterSeq || 0))
      let closed = false

      const close = () => {
        if (closed) return
        closed = true
        cleanupSubscriber()
        cleanupTimers()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }

      input.signal?.addEventListener('abort', close, { once: true })

      try {
        const job = taskJobState.jobs.get(input.runId)
        if (job) {
          if (job.userId !== input.userId || job.queueName !== taskQueueName() || (input.conversationId && job.conversationId !== input.conversationId)) {
            controller.enqueue(encoder.encode(encodeSSE({ type: 'error', message: 'Task access denied' })))
            close()
            return
          }

          replayEvents(controller, encoder, job.events.filter((record) => record.seq > lastSeq))
          if (job.closed || job.terminalStatus) {
            close()
            return
          }
          activeSubscriber = attachSubscriber(job, controller, encoder)
          return
        }

        const replayPersistedEvents = async (): Promise<boolean> => {
          const snapshot = await loadPersistedTaskJobSnapshot(input.userId, input.runId, lastSeq)
          if (!snapshot) {
            controller.enqueue(encoder.encode(encodeSSE({ type: 'error', message: 'The task is no longer available.' })))
            return true
          }
          if (input.conversationId && snapshot.conversationId !== input.conversationId) {
            controller.enqueue(encoder.encode(encodeSSE({ type: 'error', message: 'Task access denied' })))
            return true
          }

          replayEvents(controller, encoder, snapshot.events)
          for (const record of snapshot.events) {
            lastSeq = Math.max(lastSeq, record.seq)
          }

          const hasTerminalEvent = snapshot.events.some((record) => record.event.type === 'done' || record.event.type === 'error')
          if (hasTerminalEvent || snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled') {
            if (!hasTerminalEvent && snapshot.terminalStatus === 'error') {
              controller.enqueue(encoder.encode(encodeSSE({
                type: 'error',
                message: snapshot.terminalError || 'The task stopped before it finished. Please try again.',
                runId: input.runId,
              })))
            }
            return true
          }

          return false
        }

        const snapshot = await loadPersistedTaskJobSnapshot(input.userId, input.runId, lastSeq)
        if (!snapshot) {
          controller.enqueue(encoder.encode(encodeSSE({ type: 'error', message: 'The task is no longer available.' })))
          close()
          return
        }
        if (input.conversationId && snapshot.conversationId !== input.conversationId) {
          controller.enqueue(encoder.encode(encodeSSE({ type: 'error', message: 'Task access denied' })))
          close()
          return
        }

        replayEvents(controller, encoder, snapshot.events)
        for (const record of snapshot.events) {
          lastSeq = Math.max(lastSeq, record.seq)
        }
        const hasTerminalEvent = snapshot.events.some((record) => record.event.type === 'done' || record.event.type === 'error')
        if (hasTerminalEvent || snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'cancelled') {
          if (!hasTerminalEvent && snapshot.terminalStatus === 'error') {
            controller.enqueue(encoder.encode(encodeSSE({
              type: 'error',
              message: snapshot.terminalError || 'The task stopped before it finished. Please try again.',
              runId: input.runId,
            })))
          }
          close()
          return
        }

        activeHeartbeatTimer = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(encodeSSE({ type: 'heartbeat', timestamp: nowMs(), runId: input.runId })))
          }
        }, TASK_JOB_KEEP_ALIVE_MS)
        activePollTimer = setInterval(() => {
          void replayPersistedEvents().then((terminal) => {
            if (terminal) close()
          }).catch((error) => {
            controller.enqueue(encoder.encode(encodeSSE({
              type: 'error',
              message: userErrorMessage(error, 'Could not reconnect to the task.'),
              runId: input.runId,
            })))
            close()
          })
        }, TASK_JOB_DB_POLL_MS)
      } catch (error) {
        controller.enqueue(encoder.encode(encodeSSE({
          type: 'error',
          message: userErrorMessage(error, 'Could not reconnect to the task.'),
          runId: input.runId,
        })))
        close()
      }
    },
    cancel() {
      cleanupSubscriber()
      cleanupTimers()
      activeController = null
    },
  })
}

export function clearTaskJobsForTest(): void {
  for (const job of taskJobState.jobs.values()) {
    job.abortController.abort()
    closeJobSubscribers(job)
  }
  taskJobState.jobs.clear()
}
