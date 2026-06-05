import { createHash } from 'crypto'
import { constants } from 'fs'
import { chmod, lstat, mkdir, open, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getTursoSetupStatus, tursoExecute } from '@/lib/db/turso'

const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const ACCESS_ROOT = join(tmpdir(), 'agent-task-access')

type AccessResult =
  | { ok: true; sessionHash: string; headers: Record<string, string> }
  | { ok: false; response: Response }

interface TaskAccessState {
  taskOwners: Map<string, string>
}

const stateKey = '__agentTaskAccessState' as const
const taskAccessState: TaskAccessState =
  (globalThis as unknown as Record<string, TaskAccessState>)[stateKey] ??
  ((globalThis as unknown as Record<string, TaskAccessState>)[stateKey] = {
    taskOwners: new Map(),
  })

let taskAccessSchemaPromise: Promise<void> | null = null

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function accountOwnerHash(userId: string): string {
  return hashSecret(`account:${userId}`)
}

function forbidden(message: string): Response {
  return Response.json({ error: message }, { status: 403 })
}

function unauthorized(): Response {
  return Response.json({ error: 'Authentication required' }, { status: 401 })
}

function unavailable(): Response {
  return Response.json({ error: 'Task access is temporarily unavailable' }, { status: 503 })
}

function shouldUseDatabaseTaskAccess(): boolean {
  return getTursoSetupStatus().configured
}

async function ensureDatabaseTaskAccessSchema(): Promise<void> {
  if (!taskAccessSchemaPromise) {
    taskAccessSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists task_access (
          task_id text primary key,
          owner_hash text not null,
          created_at text not null,
          updated_at text not null
        )
      `)
      await tursoExecute('create index if not exists task_access_owner_idx on task_access(owner_hash)')
    })().catch((error) => {
      taskAccessSchemaPromise = null
      throw error
    })
  }

  return taskAccessSchemaPromise
}

function accessMarkerPath(taskId: string): string {
  return join(ACCESS_ROOT, `${taskId}.owner`)
}

function taskSandboxPath(taskId: string): string {
  return join(tmpdir(), `agent-sandbox-${taskId}`)
}

async function ensureAccessRoot(): Promise<boolean> {
  try {
    const info = await lstat(ACCESS_ROOT)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    await chmod(ACCESS_ROOT, 0o700).catch(() => {})
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(ACCESS_ROOT, { recursive: true, mode: 0o700 })
    return true
  }
}

async function readPersistedOwner(taskId: string): Promise<string | null> {
  if (shouldUseDatabaseTaskAccess()) {
    await ensureDatabaseTaskAccessSchema()
    const result = await tursoExecute(
      'select owner_hash from task_access where task_id = ? limit 1',
      [taskId],
    )
    const ownerHash = result.rows[0]?.owner_hash
    return typeof ownerHash === 'string' && /^[a-f0-9]{64}$/i.test(ownerHash) ? ownerHash : null
  }

  try {
    if (!await ensureAccessRoot()) return null
    const file = await open(accessMarkerPath(taskId), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const value = await file.readFile('utf-8')
      const trimmed = value.trim()
      return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function persistOwner(taskId: string, ownerHash: string): Promise<string> {
  if (shouldUseDatabaseTaskAccess()) {
    await ensureDatabaseTaskAccessSchema()
    const now = new Date().toISOString()
    await tursoExecute(
      `
        insert or ignore into task_access (task_id, owner_hash, created_at, updated_at)
        values (?, ?, ?, ?)
      `,
      [taskId, ownerHash, now, now],
    )
    return (await readPersistedOwner(taskId)) || ''
  }

  if (!await ensureAccessRoot()) return ''
  const markerPath = accessMarkerPath(taskId)

  try {
    const file = await open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(ownerHash, 'utf-8')
      return ownerHash
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return (await readPersistedOwner(taskId)) || ''
  }
}

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId)
}

export function getTaskOwnerForTest(taskId: string): string | undefined {
  return taskAccessState.taskOwners.get(taskId)
}

export function clearTaskAccessMemoryForTest(): void {
  taskAccessState.taskOwners.clear()
}

export async function clearTaskAccessForTest(): Promise<void> {
  taskAccessState.taskOwners.clear()
  if (shouldUseDatabaseTaskAccess()) {
    await ensureDatabaseTaskAccessSchema()
    await tursoExecute(
      "delete from task_access where task_id like ? or task_id like ?",
      ['task-%-smoke', 'security-smoke-%'],
    )
    return
  }
  await rm(ACCESS_ROOT, { recursive: true, force: true })
}

export async function assertTaskAccess(
  _request: Request,
  taskId: string,
  options: { allowCreate?: boolean; userId?: string } = {},
): Promise<AccessResult> {
  if (!isValidTaskId(taskId)) {
    return { ok: false, response: Response.json({ error: 'Invalid task id' }, { status: 400 }) }
  }

  if (!options.userId) {
    return { ok: false, response: unauthorized() }
  }

  const ownerHash = accountOwnerHash(options.userId)
  let owner = taskAccessState.taskOwners.get(taskId)

  if (!owner) {
    try {
      owner = await readPersistedOwner(taskId) || undefined
    } catch {
      return { ok: false, response: unavailable() }
    }
    if (owner) taskAccessState.taskOwners.set(taskId, owner)
  }

  if (owner && owner !== ownerHash) {
    return { ok: false, response: forbidden('Task access denied') }
  }

  if (!owner) {
    if (!options.allowCreate) {
      return { ok: false, response: forbidden('Task access denied') }
    }
    let persistedOwner: string
    try {
      persistedOwner = await persistOwner(taskId, ownerHash)
    } catch {
      return { ok: false, response: unavailable() }
    }
    if (persistedOwner && persistedOwner !== ownerHash) {
      taskAccessState.taskOwners.set(taskId, persistedOwner)
      return { ok: false, response: forbidden('Task access denied') }
    }
    if (!persistedOwner) {
      return { ok: false, response: forbidden('Task access denied') }
    }
    taskAccessState.taskOwners.set(taskId, ownerHash)
    await rm(taskSandboxPath(taskId), { recursive: true, force: true }).catch(() => {})
  }

  return { ok: true, sessionHash: ownerHash, headers: {} }
}
