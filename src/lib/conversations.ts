import { randomUUID } from 'crypto'
import type { Conversation } from '@/types'
import { getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'
import { normalizeConversationForPersistence, normalizeConversationListForPersistence } from '@/lib/conversationSerialization'

const CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_SYNC_CONVERSATIONS = 500
const MAX_SYNC_FOLDERS = 100
const MAX_FOLDER_CHARS = 80

export interface ConversationSyncInput {
  conversations: Conversation[]
  deletedIds: string[]
  folders?: string[]
}

export interface StoredConversationState {
  conversations: Conversation[]
  deletedIds: string[]
  folders: string[]
}

export interface StoredConversationSummary {
  id: string
  title: string
  starred: boolean
  createdAt: number
  updatedAt: number
  folder?: string
}

export interface StoredConversationIndex {
  conversations: StoredConversationSummary[]
  deletedIds: string[]
  folders: string[]
}

let conversationSchemaPromise: Promise<void> | null = null

function isMissingConversationSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /no such table:\s*(conversations|user_conversation_meta)|no such column|has no column/i.test(message)
}

async function withConversationSchemaFallback<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query()
  } catch (error) {
    if (!isMissingConversationSchemaError(error)) throw error
    await ensureConversationSchema()
    return query()
  }
}

async function addConversationColumn(sql: string): Promise<void> {
  try {
    await tursoExecute(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/duplicate column|already exists/i.test(message)) return
    throw error
  }
}

export async function ensureConversationSchema(): Promise<void> {
  if (!conversationSchemaPromise) {
    conversationSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists conversations (
          user_id text not null,
          id text not null,
          title text not null,
          body_json text not null,
          starred integer not null default 0,
          folder text,
          server_placeholder integer not null default 0,
          created_at_ms integer not null,
          updated_at_ms integer not null,
          deleted_at_ms integer,
          created_at text not null,
          updated_at text not null,
          primary key (user_id, id)
        )
      `)
      await addConversationColumn('alter table conversations add column server_placeholder integer not null default 0')
      await tursoExecute('create index if not exists conversations_user_updated_idx on conversations(user_id, deleted_at_ms, updated_at_ms desc)')
      await tursoExecute('create index if not exists conversations_user_deleted_idx on conversations(user_id, deleted_at_ms)')
      await tursoExecute(`
        create table if not exists user_conversation_meta (
          user_id text primary key,
          folders_json text not null,
          updated_at_ms integer not null,
          updated_at text not null
        )
      `)
    })().catch((error) => {
      conversationSchemaPromise = null
      throw error
    })
  }

  return conversationSchemaPromise
}

function titleFromMessages(messages: Array<{ role: string; content: string }>): string {
  const firstUserContent = messages.find((message) => message.role === 'user')?.content?.trim() || 'New task'
  return `${firstUserContent.slice(0, 50)}${firstUserContent.length > 50 ? '...' : ''}`
}

export async function ensureUserConversationForTaskStart(
  userId: string,
  input: {
    conversationId: string
    messages: Array<{
      role: 'user' | 'assistant'
      content: string
      attachments?: Conversation['messages'][number]['attachments']
    }>
    customInstructions?: string
  },
): Promise<void> {
  if (!getTursoSetupStatus().configured) return
  if (!validConversationId(input.conversationId)) return

  await ensureConversationSchema()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const conversation = normalizeConversationForPersistence({
    id: input.conversationId,
    title: titleFromMessages(input.messages),
    starred: false,
    createdAt: nowMs,
    updatedAt: nowMs,
    customInstructions: input.customInstructions,
    messages: input.messages.map((message, index) => ({
      id: randomUUID(),
      role: message.role,
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      timestamp: nowMs + index,
    })),
  })

  const bodyJson = JSON.stringify({
    ...conversation,
    serverStartPlaceholder: true,
  })

  await tursoExecute(
    `
      insert or ignore into conversations (
        user_id, id, title, body_json, starred, folder, server_placeholder,
        created_at_ms, updated_at_ms, deleted_at_ms, created_at, updated_at
      )
      values (?, ?, ?, ?, 0, null, 1, ?, ?, null, ?, ?)
    `,
    [
      userId,
      conversation.id,
      conversation.title,
      bodyJson,
      conversation.createdAt,
      conversation.updatedAt,
      nowIso,
      nowIso,
    ],
  )
}

function validConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id)
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const folders: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const folder = item.trim().slice(0, MAX_FOLDER_CHARS)
    if (folder && !folders.includes(folder)) folders.push(folder)
    if (folders.length >= MAX_SYNC_FOLDERS) break
  }
  return folders
}

function parseConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== 'object') return null
  const conversation = value as Partial<Conversation>
  if (!validConversationId(conversation.id)) return null
  if (!Array.isArray(conversation.messages)) return null

  return normalizeConversationForPersistence({
    id: conversation.id,
    title: typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title
      : 'New task',
    messages: conversation.messages as Conversation['messages'],
    starred: conversation.starred === true,
    createdAt: Number.isFinite(conversation.createdAt) ? Number(conversation.createdAt) : Date.now(),
    updatedAt: Number.isFinite(conversation.updatedAt) ? Number(conversation.updatedAt) : Date.now(),
    customInstructions: typeof conversation.customInstructions === 'string' ? conversation.customInstructions : undefined,
    branches: Array.isArray(conversation.branches) ? conversation.branches : undefined,
    tags: Array.isArray(conversation.tags) ? conversation.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    folder: typeof conversation.folder === 'string' ? conversation.folder : undefined,
  })
}

export function parseConversationSyncPayload(value: unknown): ConversationSyncInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as { conversations?: unknown; deletedIds?: unknown; folders?: unknown }
  if (!Array.isArray(input.conversations)) return null

  const conversations = input.conversations
    .slice(0, MAX_SYNC_CONVERSATIONS)
    .map(parseConversation)
    .filter((conversation): conversation is Conversation => conversation !== null)

  const deletedIds = Array.isArray(input.deletedIds)
    ? input.deletedIds.filter(validConversationId)
    : []

  return {
    conversations: normalizeConversationListForPersistence(conversations),
    deletedIds: [...new Set(deletedIds)],
    folders: Array.isArray(input.folders) ? normalizeFolders(input.folders) : undefined,
  }
}

function parseStoredConversation(raw: unknown): Conversation | null {
  if (typeof raw !== 'string') return null
  try {
    return parseConversation(JSON.parse(raw))
  } catch {
    return null
  }
}

function parseStoredConversationSummary(row: Record<string, unknown>): StoredConversationSummary | null {
  const id = row.id
  if (!validConversationId(id)) return null
  const createdAt = Number(row.created_at_ms)
  const updatedAt = Number(row.updated_at_ms)

  return {
    id,
    title: typeof row.title === 'string' && row.title.trim() ? row.title : 'New task',
    starred: row.starred === 1 || row.starred === true,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    folder: typeof row.folder === 'string' && row.folder.trim() ? row.folder : undefined,
  }
}

function parseStoredFolders(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  try {
    return normalizeFolders(JSON.parse(raw || '[]'))
  } catch {
    return []
  }
}

export async function getUserConversationIndex(userId: string): Promise<StoredConversationIndex> {
  return withConversationSchemaFallback(async () => {
    const [conversationRows, metaRows, deletedRows] = await Promise.all([
      tursoExecute(
        `
          select id, title, starred, folder, created_at_ms, updated_at_ms
          from conversations
          where user_id = ? and deleted_at_ms is null
          order by updated_at_ms desc
          limit ?
        `,
        [userId, MAX_SYNC_CONVERSATIONS],
      ),
      tursoExecute('select folders_json from user_conversation_meta where user_id = ? limit 1', [userId]),
      tursoExecute('select id from conversations where user_id = ? and deleted_at_ms is not null', [userId]),
    ])

    const conversations = conversationRows.rows
      .map((row) => parseStoredConversationSummary(row as Record<string, unknown>))
      .filter((conversation): conversation is StoredConversationSummary => conversation !== null)

    const folders = parseStoredFolders(metaRows.rows[0]?.folders_json)

    const deletedIds = deletedRows.rows
      .map((row) => row.id)
      .filter(validConversationId)

    return { conversations, deletedIds, folders }
  })
}

export async function getUserConversationById(userId: string, id: string): Promise<Conversation | null> {
  if (!validConversationId(id)) return null
  return withConversationSchemaFallback(async () => {
    const rows = await tursoExecute(
      `
        select body_json
        from conversations
        where user_id = ? and id = ? and deleted_at_ms is null
        limit 1
      `,
      [userId, id],
    )
    return parseStoredConversation(rows.rows[0]?.body_json)
  })
}

export async function getUserConversationState(userId: string): Promise<StoredConversationState> {
  return withConversationSchemaFallback(async () => {
    const [conversationRows, metaRows, deletedRows] = await Promise.all([
      tursoExecute(
        `
          select body_json
          from conversations
          where user_id = ? and deleted_at_ms is null
          order by updated_at_ms desc
          limit ?
        `,
        [userId, MAX_SYNC_CONVERSATIONS],
      ),
      tursoExecute('select folders_json from user_conversation_meta where user_id = ? limit 1', [userId]),
      tursoExecute('select id from conversations where user_id = ? and deleted_at_ms is not null', [userId]),
    ])

    const conversations = conversationRows.rows
      .map((row) => parseStoredConversation(row.body_json))
      .filter((conversation): conversation is Conversation => conversation !== null)

    const folders = parseStoredFolders(metaRows.rows[0]?.folders_json)

    const deletedIds = deletedRows.rows
      .map((row) => row.id)
      .filter(validConversationId)

    return { conversations, deletedIds, folders }
  })
}

export async function syncUserConversations(userId: string, input: ConversationSyncInput): Promise<void> {
  return withConversationSchemaFallback(async () => {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    await tursoTransaction('write', async (transaction) => {
      for (const conversation of input.conversations) {
        const createdAtMs = Math.max(0, Math.round(conversation.createdAt || nowMs))
        const updatedAtMs = Math.max(createdAtMs, Math.round(conversation.updatedAt || nowMs))
        const updatedAtIso = new Date(updatedAtMs).toISOString()
        await transaction.execute({
          sql: `
            insert into conversations (
              user_id, id, title, body_json, starred, folder, server_placeholder,
              created_at_ms, updated_at_ms, deleted_at_ms, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, 0, ?, ?, null, ?, ?)
            on conflict(user_id, id) do update set
              title = excluded.title,
              body_json = excluded.body_json,
              starred = excluded.starred,
              folder = excluded.folder,
              server_placeholder = 0,
              created_at_ms = min(conversations.created_at_ms, excluded.created_at_ms),
              updated_at_ms = excluded.updated_at_ms,
              deleted_at_ms = null,
              updated_at = excluded.updated_at
            where (
                excluded.updated_at_ms >= conversations.updated_at_ms
                and excluded.updated_at_ms >= coalesce(conversations.deleted_at_ms, 0)
              )
              or conversations.server_placeholder = 1
          `,
          args: [
            userId,
            conversation.id,
            conversation.title,
            JSON.stringify(conversation),
            conversation.starred ? 1 : 0,
            conversation.folder || null,
            createdAtMs,
            updatedAtMs,
            new Date(createdAtMs).toISOString(),
            updatedAtIso,
          ],
        })
      }

      for (const id of input.deletedIds) {
        await transaction.execute({
          sql: `
            update conversations
            set deleted_at_ms = ?,
                updated_at_ms = max(updated_at_ms, ?),
                updated_at = ?
            where user_id = ? and id = ? and coalesce(deleted_at_ms, 0) < ?
          `,
          args: [nowMs, nowMs, nowIso, userId, id, nowMs],
        })
      }

      if (input.folders) {
        await transaction.execute({
          sql: `
            insert into user_conversation_meta (user_id, folders_json, updated_at_ms, updated_at)
            values (?, ?, ?, ?)
            on conflict(user_id) do update set
              folders_json = excluded.folders_json,
              updated_at_ms = excluded.updated_at_ms,
              updated_at = excluded.updated_at
          `,
          args: [userId, JSON.stringify(normalizeFolders(input.folders)), nowMs, nowIso],
        })
      }
    })
  })
}

export async function clearUserConversations(userId: string): Promise<void> {
  return withConversationSchemaFallback(async () => {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    await tursoTransaction('write', async (transaction) => {
      await transaction.execute({
        sql: `
          update conversations
          set deleted_at_ms = ?,
              updated_at_ms = max(updated_at_ms, ?),
              updated_at = ?
          where user_id = ? and deleted_at_ms is null
        `,
        args: [nowMs, nowMs, nowIso, userId],
      })
      await transaction.execute({
        sql: `
          insert into user_conversation_meta (user_id, folders_json, updated_at_ms, updated_at)
          values (?, '[]', ?, ?)
          on conflict(user_id) do update set
            folders_json = '[]',
            updated_at_ms = excluded.updated_at_ms,
            updated_at = excluded.updated_at
        `,
        args: [userId, nowMs, nowIso],
      })
    })
  })
}
