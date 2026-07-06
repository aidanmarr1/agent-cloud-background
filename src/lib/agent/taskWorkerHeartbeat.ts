import { hostname } from 'os'
import { tursoExecute } from '@/lib/db/turso'
import { taskQueueName } from '@/lib/agent/taskQueue'

export interface TaskWorkerHeartbeatInput {
  workerId: string
  queueName?: string
  startedAtMs: number
  pollMs: number
  heartbeatMs: number
  status: 'starting' | 'idle' | 'running' | 'stopping' | 'stopped'
  currentRunId?: string | null
  completedTasks: number
  taskWorkerMode?: string | null
  sandboxProvider?: string | null
  deploymentVersion?: string | null
  e2bApiKeyConfigured?: boolean
  e2bBrowserRuntimeConfigured?: boolean
  e2bPauseOnTaskEnd?: boolean
}

export interface TaskWorkerHeartbeat {
  workerId: string
  queueName: string
  startedAtMs: number
  lastSeenAtMs: number
  pollMs: number
  heartbeatMs: number
  status: string
  currentRunId: string | null
  completedTasks: number
  processId: number
  hostname: string
  taskWorkerMode: string | null
  sandboxProvider: string | null
  deploymentVersion: string | null
  e2bApiKeyConfigured: boolean
  e2bBrowserRuntimeConfigured: boolean
  e2bPauseOnTaskEnd: boolean
}

function envBoolEnabled(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  return value !== 'false' && value !== '0'
}

export function isLikelyLocalWorkerHostname(value: string | null | undefined): boolean {
  const host = (value || '').trim().toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  if (host.endsWith('.local') || host.endsWith('.localdomain')) return true
  if (host.includes('macbook') || host.includes('imac') || host.includes('mac-mini')) return true
  return false
}

export function workerHeartbeatIsHosted(worker: { hostname?: string | null }): boolean {
  if (envBoolEnabled('AGENT_ALLOW_LOCAL_WORKER_HEARTBEAT', false)) return true
  return !isLikelyLocalWorkerHostname(worker.hostname)
}

let schemaReady: Promise<void> | null = null

async function addTaskWorkerHeartbeatColumn(sql: string): Promise<void> {
  try {
    await tursoExecute(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate column|already exists/i.test(message)) return
    throw error
  }
}

async function ensureTaskWorkerHeartbeatSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await tursoExecute(`
        create table if not exists agent_task_workers (
          worker_id text primary key,
          queue_name text not null default 'default',
          started_at_ms integer not null,
          last_seen_at_ms integer not null,
          poll_ms integer not null,
          heartbeat_ms integer not null,
          status text not null,
          current_run_id text,
          completed_tasks integer not null default 0,
          process_id integer not null,
          hostname text not null
        )
      `)
      await addTaskWorkerHeartbeatColumn("alter table agent_task_workers add column queue_name text not null default 'default'")
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column task_worker_mode text')
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column sandbox_provider text')
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column deployment_version text')
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column e2b_api_key_configured integer not null default 0')
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column e2b_browser_runtime_configured integer not null default 0')
      await addTaskWorkerHeartbeatColumn('alter table agent_task_workers add column e2b_pause_on_task_end integer not null default 0')
      await tursoExecute('create index if not exists agent_task_workers_seen_idx on agent_task_workers(last_seen_at_ms desc)')
      await tursoExecute('create index if not exists agent_task_workers_queue_seen_idx on agent_task_workers(queue_name, last_seen_at_ms desc)')
    })()
  }
  await schemaReady
}

function isMissingHeartbeatSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|no such column|schema/i.test(message)
}

function rowBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function rowToHeartbeat(row: Record<string, unknown> | undefined): TaskWorkerHeartbeat | null {
  if (!row || typeof row.worker_id !== 'string') return null

  return {
    workerId: row.worker_id,
    queueName: typeof row.queue_name === 'string' && row.queue_name ? row.queue_name : 'default',
    startedAtMs: Number(row.started_at_ms || 0),
    lastSeenAtMs: Number(row.last_seen_at_ms || 0),
    pollMs: Number(row.poll_ms || 0),
    heartbeatMs: Number(row.heartbeat_ms || 0),
    status: typeof row.status === 'string' ? row.status : 'unknown',
    currentRunId: typeof row.current_run_id === 'string' ? row.current_run_id : null,
    completedTasks: Number(row.completed_tasks || 0),
    processId: Number(row.process_id || 0),
    hostname: typeof row.hostname === 'string' ? row.hostname : '',
    taskWorkerMode: typeof row.task_worker_mode === 'string' ? row.task_worker_mode : null,
    sandboxProvider: typeof row.sandbox_provider === 'string' ? row.sandbox_provider : null,
    deploymentVersion: typeof row.deployment_version === 'string' ? row.deployment_version : null,
    e2bApiKeyConfigured: rowBool(row.e2b_api_key_configured),
    e2bBrowserRuntimeConfigured: rowBool(row.e2b_browser_runtime_configured),
    e2bPauseOnTaskEnd: rowBool(row.e2b_pause_on_task_end),
  }
}

export async function recordTaskWorkerHeartbeat(input: TaskWorkerHeartbeatInput): Promise<void> {
  if (!input.workerId) throw new Error('Missing worker id')
  await ensureTaskWorkerHeartbeatSchema()
  const now = Date.now()
  const queueName = input.queueName || taskQueueName()
  await tursoExecute(
    `
      insert into agent_task_workers (
        worker_id, queue_name, started_at_ms, last_seen_at_ms, poll_ms, heartbeat_ms,
        status, current_run_id, completed_tasks, process_id, hostname,
        task_worker_mode, sandbox_provider, deployment_version, e2b_api_key_configured,
        e2b_browser_runtime_configured, e2b_pause_on_task_end
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(worker_id) do update set
        queue_name = excluded.queue_name,
        last_seen_at_ms = excluded.last_seen_at_ms,
        poll_ms = excluded.poll_ms,
        heartbeat_ms = excluded.heartbeat_ms,
        status = excluded.status,
        current_run_id = excluded.current_run_id,
        completed_tasks = excluded.completed_tasks,
        process_id = excluded.process_id,
        hostname = excluded.hostname,
        task_worker_mode = excluded.task_worker_mode,
        sandbox_provider = excluded.sandbox_provider,
        deployment_version = excluded.deployment_version,
        e2b_api_key_configured = excluded.e2b_api_key_configured,
        e2b_browser_runtime_configured = excluded.e2b_browser_runtime_configured,
        e2b_pause_on_task_end = excluded.e2b_pause_on_task_end
    `,
    [
      input.workerId,
      queueName,
      input.startedAtMs,
      now,
      input.pollMs,
      input.heartbeatMs,
      input.status,
      input.currentRunId || null,
      input.completedTasks,
      process.pid,
      hostname(),
      input.taskWorkerMode || null,
      input.sandboxProvider || null,
      input.deploymentVersion || null,
      input.e2bApiKeyConfigured ? 1 : 0,
      input.e2bBrowserRuntimeConfigured ? 1 : 0,
      input.e2bPauseOnTaskEnd ? 1 : 0,
    ],
  )
}

export async function markTaskWorkerStopped(workerId: string): Promise<void> {
  if (!workerId) return
  await ensureTaskWorkerHeartbeatSchema()
  const queueName = taskQueueName()
  await tursoExecute(
    `
      update agent_task_workers
      set status = 'stopped',
          current_run_id = null,
          last_seen_at_ms = ?
      where worker_id = ? and queue_name = ?
    `,
    [Date.now(), workerId, queueName],
  )
}

export async function getRecentTaskWorkerHeartbeats(maxAgeMs: number): Promise<TaskWorkerHeartbeat[]> {
  const threshold = Date.now() - Math.max(1, maxAgeMs)
  const queueName = taskQueueName()
  const readRecent = () => tursoExecute(
      `
        select *
        from agent_task_workers
        where last_seen_at_ms >= ?
          and queue_name = ?
          and status != 'stopped'
        order by last_seen_at_ms desc
        limit 20
      `,
      [threshold, queueName],
    )
  let result: Awaited<ReturnType<typeof tursoExecute>>
  try {
    result = await readRecent()
  } catch (error) {
    if (!isMissingHeartbeatSchemaError(error)) throw error
    await ensureTaskWorkerHeartbeatSchema()
    result = await readRecent()
  }
  return result.rows
    .map((row) => rowToHeartbeat(row as Record<string, unknown>))
    .filter((row): row is TaskWorkerHeartbeat => row !== null)
}
