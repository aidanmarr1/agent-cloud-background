import { createHash, randomUUID } from 'crypto'
import { constants } from 'fs'
import { lstat, open, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative } from 'path'
import { tursoExecute } from '@/lib/db/turso'
import { deleteObject, getObject, putObject } from '@/lib/storage'
import {
  fileExistsInActiveSandbox,
  getSandboxDirPath,
  isCloudSandboxProviderEnabled,
  MAX_SANDBOX_FILE_SIZE,
  readSandboxFileBytes,
  resolveAndVerify,
  writeSandboxFileBytes,
} from '@/lib/sandbox'

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g
const MAX_TASK_FILE_PATH_CHARS = 600

export interface TaskFileRecord {
  userId: string
  conversationId: string
  path: string
  fileName: string
  mimeType: string
  size: number
  storageKey: string
  sha256: string
  createdAt: string
  updatedAt: string
  updatedAtMs: number
  deletedAt: string | null
}

export interface PublicTaskFile {
  name: string
  path: string
  size: number
  modifiedAt: number
  mimeType: string
}

interface TaskFileRow {
  user_id?: unknown
  conversation_id?: unknown
  path?: unknown
  file_name?: unknown
  mime_type?: unknown
  size?: unknown
  storage_key?: unknown
  sha256?: unknown
  created_at?: unknown
  updated_at?: unknown
  updated_at_ms?: unknown
  deleted_at?: unknown
}

let taskFileSchemaPromise: Promise<void> | null = null

export async function ensureTaskFileSchema(): Promise<void> {
  if (!taskFileSchemaPromise) {
    taskFileSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists task_files (
          user_id text not null,
          conversation_id text not null,
          path text not null,
          file_name text not null,
          mime_type text not null,
          size integer not null,
          storage_key text not null,
          sha256 text not null,
          created_at text not null,
          updated_at text not null,
          updated_at_ms integer not null,
          deleted_at text,
          primary key (user_id, conversation_id, path)
        )
      `)
      await tursoExecute('create index if not exists task_files_user_task_updated_idx on task_files(user_id, conversation_id, deleted_at, updated_at_ms desc)')
      await tursoExecute('create unique index if not exists task_files_storage_key_idx on task_files(storage_key)')
    })().catch((error) => {
      taskFileSchemaPromise = null
      throw error
    })
  }

  return taskFileSchemaPromise
}

function textFromUnknown(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function validTaskId(value: string): boolean {
  return SAFE_TASK_ID.test(value)
}

function safeSegment(value: string): string {
  return value
    .trim()
    .replace(SAFE_SEGMENT, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'file'
}

function extensionForName(fileName: string): string {
  return extname(fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16)
}

export function normalizeTaskFilePath(path: string): string {
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .trim()

  if (!normalized || normalized.length > MAX_TASK_FILE_PATH_CHARS) {
    throw new Error('Invalid task file path')
  }

  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid task file path')
  }

  return normalized
}

export function taskFileNameFromPath(path: string): string {
  return path.split('/').pop() || path
}

export function inferTaskFileMimeType(path: string): string {
  const ext = extensionForName(path).replace('.', '').toLowerCase()
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'txt':
      return 'text/plain; charset=utf-8'
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'text/javascript; charset=utf-8'
    case 'ts':
    case 'tsx':
    case 'jsx':
      return 'text/plain; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    default:
      return 'application/octet-stream'
  }
}

function rowToTaskFileRecord(row: TaskFileRow | undefined): TaskFileRecord | null {
  if (!row) return null
  const userId = textFromUnknown(row.user_id)
  const conversationId = textFromUnknown(row.conversation_id)
  const path = textFromUnknown(row.path)
  const fileName = textFromUnknown(row.file_name)
  const mimeType = textFromUnknown(row.mime_type)
  const size = numberFromUnknown(row.size)
  const storageKey = textFromUnknown(row.storage_key)
  const sha256 = textFromUnknown(row.sha256)
  const createdAt = textFromUnknown(row.created_at)
  const updatedAt = textFromUnknown(row.updated_at)
  const updatedAtMs = numberFromUnknown(row.updated_at_ms)

  if (!userId || !conversationId || !path || !fileName || !mimeType || size === null || !storageKey || !sha256 || !createdAt || !updatedAt || updatedAtMs === null) {
    return null
  }

  return {
    userId,
    conversationId,
    path,
    fileName,
    mimeType,
    size,
    storageKey,
    sha256,
    createdAt,
    updatedAt,
    updatedAtMs,
    deletedAt: textFromUnknown(row.deleted_at),
  }
}

export function toPublicTaskFile(record: TaskFileRecord): PublicTaskFile {
  return {
    name: record.fileName,
    path: record.path,
    size: record.size,
    modifiedAt: record.updatedAtMs,
    mimeType: record.mimeType,
  }
}

export async function persistTaskFile(input: {
  userId: string
  conversationId: string
  path: string
  body: Buffer
  mimeType?: string
}): Promise<TaskFileRecord> {
  if (!validTaskId(input.conversationId)) throw new Error('Invalid task id')
  const path = normalizeTaskFilePath(input.path)
  if (input.body.byteLength > MAX_SANDBOX_FILE_SIZE) {
    throw new Error('Task file is too large to persist')
  }

  await ensureTaskFileSchema()

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const fileName = taskFileNameFromPath(path)
  const mimeType = input.mimeType || inferTaskFileMimeType(path)
  const sha256 = createHash('sha256').update(input.body).digest('hex')
  const storageKey = [
    'task-files',
    safeSegment(input.userId),
    safeSegment(input.conversationId),
    randomUUID(),
    `${safeSegment(fileName.replace(/\.[^.]+$/, ''))}${extensionForName(fileName)}`,
  ].join('/')

  const existing = await getTaskFileForUser(input.userId, input.conversationId, path, { includeDeleted: true })
  await putObject(storageKey, input.body)

  try {
    await tursoExecute(
      `
        insert into task_files (
          user_id, conversation_id, path, file_name, mime_type, size, storage_key,
          sha256, created_at, updated_at, updated_at_ms, deleted_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
        on conflict(user_id, conversation_id, path) do update set
          file_name = excluded.file_name,
          mime_type = excluded.mime_type,
          size = excluded.size,
          storage_key = excluded.storage_key,
          sha256 = excluded.sha256,
          updated_at = excluded.updated_at,
          updated_at_ms = excluded.updated_at_ms,
          deleted_at = null
      `,
      [
        input.userId,
        input.conversationId,
        path,
        fileName,
        mimeType,
        input.body.byteLength,
        storageKey,
        sha256,
        existing?.createdAt || nowIso,
        nowIso,
        nowMs,
      ],
    )
  } catch (error) {
    await deleteObject(storageKey).catch(() => undefined)
    throw error
  }

  if (existing?.storageKey && existing.storageKey !== storageKey) {
    await deleteObject(existing.storageKey).catch(() => undefined)
  }

  return {
    userId: input.userId,
    conversationId: input.conversationId,
    path,
    fileName,
    mimeType,
    size: input.body.byteLength,
    storageKey,
    sha256,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    updatedAtMs: nowMs,
    deletedAt: null,
  }
}

export async function persistSandboxTaskFile(input: {
  userId: string
  conversationId: string
  path: string
  mimeType?: string
}): Promise<TaskFileRecord | null> {
  const path = normalizeTaskFilePath(input.path)
  if (isCloudSandboxProviderEnabled()) {
    const read = await readSandboxFileBytes(input.conversationId, path)
    if (!read.ok) return null
    return persistTaskFile({
      userId: input.userId,
      conversationId: input.conversationId,
      path,
      body: Buffer.from(read.body),
      mimeType: input.mimeType,
    })
  }

  const sandboxDir = getSandboxDirPath(input.conversationId)
  const resolved = join(sandboxDir, path)
  const rel = relative(sandboxDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  if (!await resolveAndVerify(sandboxDir, resolved)) return null

  const fileStat = await lstat(resolved)
  if (!fileStat.isFile() || fileStat.size > MAX_SANDBOX_FILE_SIZE) return null

  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    const statAfterOpen = await file.stat()
    if (statAfterOpen.size > MAX_SANDBOX_FILE_SIZE) return null
    const body = await file.readFile()
    return persistTaskFile({
      userId: input.userId,
      conversationId: input.conversationId,
      path,
      body,
      mimeType: input.mimeType,
    })
  } finally {
    await file?.close()
  }
}

export async function markTaskFileDeleted(input: {
  userId: string
  conversationId: string
  path: string
}): Promise<void> {
  if (!validTaskId(input.conversationId)) throw new Error('Invalid task id')
  const path = normalizeTaskFilePath(input.path)
  await ensureTaskFileSchema()
  const nowIso = new Date().toISOString()
  await tursoExecute(
    `
      update task_files
      set deleted_at = ?, updated_at = ?, updated_at_ms = ?
      where user_id = ? and conversation_id = ? and path = ? and deleted_at is null
    `,
    [nowIso, nowIso, Date.now(), input.userId, input.conversationId, path],
  )
}

export async function listTaskFilesForUser(userId: string, conversationId: string): Promise<TaskFileRecord[]> {
  if (!validTaskId(conversationId)) throw new Error('Invalid task id')
  await ensureTaskFileSchema()
  const result = await tursoExecute(
    `
      select * from task_files
      where user_id = ? and conversation_id = ? and deleted_at is null
      order by updated_at_ms desc
      limit 5000
    `,
    [userId, conversationId],
  )
  return result.rows
    .map((row) => rowToTaskFileRecord(row as TaskFileRow))
    .filter((record): record is TaskFileRecord => record !== null)
}

export async function getTaskFileForUser(
  userId: string,
  conversationId: string,
  path: string,
  options: { includeDeleted?: boolean } = {},
): Promise<TaskFileRecord | null> {
  if (!validTaskId(conversationId)) throw new Error('Invalid task id')
  const normalizedPath = normalizeTaskFilePath(path)
  await ensureTaskFileSchema()
  const result = await tursoExecute(
    `
      select * from task_files
      where user_id = ? and conversation_id = ? and path = ?
        ${options.includeDeleted ? '' : 'and deleted_at is null'}
      limit 1
    `,
    [userId, conversationId, normalizedPath],
  )
  return rowToTaskFileRecord(result.rows[0] as TaskFileRow | undefined)
}

export async function readTaskFileBody(record: TaskFileRecord): Promise<Buffer> {
  const object = await getObject(record.storageKey)
  return object.body
}

export async function restoreTaskFilesToActiveSandbox(input: {
  userId: string
  conversationId: string
}): Promise<{ total: number; restored: number; failed: number }> {
  const records = await listTaskFilesForUser(input.userId, input.conversationId)
  let restored = 0
  let failed = 0

  for (const record of records) {
    try {
      const body = await readTaskFileBody(record)
      await writeSandboxFileBytes(input.conversationId, record.path, new Uint8Array(body))
      restored += 1
    } catch (error) {
      failed += 1
      console.warn('[AgentDiagnostics] Could not restore persisted task file to sandbox', {
        conversationId: input.conversationId,
        path: record.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { total: records.length, restored, failed }
}

export async function sandboxFileExists(conversationId: string, path: string): Promise<boolean> {
  const normalizedPath = normalizeTaskFilePath(path)
  if (isCloudSandboxProviderEnabled()) {
    return fileExistsInActiveSandbox(conversationId, normalizedPath)
  }

  const sandboxDir = getSandboxDirPath(conversationId)
  const resolved = join(sandboxDir, normalizedPath)
  const rel = relative(sandboxDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  if (!await resolveAndVerify(sandboxDir, resolved)) return false
  try {
    const fileStat = await stat(resolved)
    return fileStat.isFile()
  } catch {
    return false
  }
}
