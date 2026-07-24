import { createHash, randomUUID } from 'crypto'
import { extname } from 'path'
import { tursoExecute } from '@/lib/db/turso'
import { deleteObject, getObject, putObject } from '@/lib/storage'
import { isExtractableDocument } from '@/lib/attachmentTypes'
import { writeSandboxFileBytes } from '@/lib/sandbox'

export type AttachmentKind = 'image' | 'text' | 'archive' | 'skill' | 'file'

export interface AttachmentRecord {
  id: string
  userId: string
  conversationId: string | null
  messageId: string | null
  fileName: string
  mimeType: string
  size: number
  storageKey: string
  sha256: string
  kind: AttachmentKind
  createdAt: string
  deletedAt: string | null
}

interface AttachmentRow {
  id?: unknown
  user_id?: unknown
  conversation_id?: unknown
  message_id?: unknown
  file_name?: unknown
  mime_type?: unknown
  size?: unknown
  storage_key?: unknown
  sha256?: unknown
  kind?: unknown
  created_at?: unknown
  deleted_at?: unknown
}

export interface PublicAttachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  persisted: true
  createdAt: string
  content?: string
  contentEncoding?: 'text'
}

type MessageAttachment = {
  id?: string
  name: string
  type: string
  size: number
  content?: string
  contentEncoding?: 'text' | 'data-url'
  url?: string
  sandboxPath?: string
  persisted?: boolean
  preview?: string
}

type MessageWithAttachments = {
  attachments?: MessageAttachment[]
}

export class AttachmentReferenceError extends Error {
  constructor(
    readonly attachmentIds: string[],
    readonly code: 'ATTACHMENT_NOT_PERSISTED' | 'ATTACHMENT_NOT_AVAILABLE' = 'ATTACHMENT_NOT_AVAILABLE',
  ) {
    super(code === 'ATTACHMENT_NOT_PERSISTED'
      ? 'Every attachment must finish uploading before this task can start. Remove any failed upload and try again.'
      : 'One or more attachments are no longer available. Remove them and upload the files again.')
    this.name = 'AttachmentReferenceError'
  }
}

const SAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'text/markdown',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'text/yaml',
  'application/x-agent-skill',
  'application/vnd.agent.archive-text',
])

let attachmentSchemaPromise: Promise<void> | null = null

export async function ensureAttachmentSchema(): Promise<void> {
  if (!attachmentSchemaPromise) {
    attachmentSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists attachments (
          id text primary key,
          user_id text not null,
          conversation_id text,
          message_id text,
          file_name text not null,
          mime_type text not null,
          size integer not null,
          storage_key text not null,
          sha256 text not null,
          kind text not null,
          created_at text not null,
          deleted_at text
        )
      `)
      await tursoExecute('create index if not exists attachments_user_created_idx on attachments(user_id, created_at desc)')
      await tursoExecute('create index if not exists attachments_user_conversation_idx on attachments(user_id, conversation_id, created_at desc)')
      await tursoExecute('create unique index if not exists attachments_storage_key_idx on attachments(storage_key)')
    })().catch((error) => {
      attachmentSchemaPromise = null
      throw error
    })
  }

  return attachmentSchemaPromise
}

function textFromUnknown(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function rowToAttachmentRecord(row: AttachmentRow | undefined): AttachmentRecord | null {
  if (!row) return null

  const id = textFromUnknown(row.id)
  const userId = textFromUnknown(row.user_id)
  const fileName = textFromUnknown(row.file_name)
  const mimeType = textFromUnknown(row.mime_type)
  const size = numberFromUnknown(row.size)
  const storageKey = textFromUnknown(row.storage_key)
  const sha256 = textFromUnknown(row.sha256)
  const kind = textFromUnknown(row.kind) as AttachmentKind | null
  const createdAt = textFromUnknown(row.created_at)

  if (!id || !userId || !fileName || !mimeType || size === null || !storageKey || !sha256 || !kind || !createdAt) {
    return null
  }

  return {
    id,
    userId,
    conversationId: textFromUnknown(row.conversation_id),
    messageId: textFromUnknown(row.message_id),
    fileName,
    mimeType,
    size,
    storageKey,
    sha256,
    kind,
    createdAt,
    deletedAt: textFromUnknown(row.deleted_at),
  }
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

function sandboxUploadPath(attachment: MessageAttachment, messageIndex: number, attachmentIndex: number): string {
  const fileName = attachment.name.trim() || 'attachment'
  const ext = extensionForName(fileName)
  const base = safeSegment(fileName.replace(/\.[^.]+$/, ''))
  const unique = safeSegment(attachment.id || `${messageIndex + 1}-${attachmentIndex + 1}`)
  return `uploads/${unique}-${base}${ext}`
}

export function getAttachmentKind(fileName: string, mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/x-agent-skill' || /\.skill$/i.test(fileName)) return 'skill'
  if (mimeType === 'application/vnd.agent.archive-text' || /\(extracted\)|\(folder\)$/i.test(fileName)) return 'archive'
  if (TEXT_MIME_TYPES.has(mimeType) || /^text\//i.test(mimeType)) return 'text'
  return 'file'
}

export function toPublicAttachment(record: AttachmentRecord): PublicAttachment {
  return {
    id: record.id,
    name: record.fileName,
    type: record.mimeType,
    size: record.size,
    url: `/api/attachments/${record.id}`,
    persisted: true,
    createdAt: record.createdAt,
  }
}

export async function createStoredAttachment(input: {
  userId: string
  conversationId?: string | null
  messageId?: string | null
  fileName: string
  mimeType: string
  body: Buffer
}): Promise<AttachmentRecord> {
  await ensureAttachmentSchema()

  const id = randomUUID()
  const now = new Date().toISOString()
  const fileName = input.fileName.trim().slice(0, 240) || 'attachment'
  const mimeType = input.mimeType.trim().slice(0, 120) || 'application/octet-stream'
  const sha256 = createHash('sha256').update(input.body).digest('hex')
  const kind = getAttachmentKind(fileName, mimeType)
  const storageKey = [
    'attachments',
    safeSegment(input.userId),
    id,
    `${safeSegment(fileName.replace(/\.[^.]+$/, ''))}${extensionForName(fileName)}`,
  ].join('/')

  await putObject(storageKey, input.body)

  try {
    await tursoExecute(
      `
        insert into attachments (
          id, user_id, conversation_id, message_id, file_name, mime_type,
          size, storage_key, sha256, kind, created_at, deleted_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
      `,
      [
        id,
        input.userId,
        input.conversationId || null,
        input.messageId || null,
        fileName,
        mimeType,
        input.body.byteLength,
        storageKey,
        sha256,
        kind,
        now,
      ],
    )
  } catch (error) {
    await deleteObject(storageKey).catch(() => undefined)
    throw error
  }

  return {
    id,
    userId: input.userId,
    conversationId: input.conversationId || null,
    messageId: input.messageId || null,
    fileName,
    mimeType,
    size: input.body.byteLength,
    storageKey,
    sha256,
    kind,
    createdAt: now,
    deletedAt: null,
  }
}

export async function listAttachmentsForUser(input: {
  userId: string
  conversationId?: string | null
  limit?: number
}): Promise<AttachmentRecord[]> {
  await ensureAttachmentSchema()
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200))
  const rows = input.conversationId
    ? await tursoExecute(
        `
          select * from attachments
          where user_id = ? and conversation_id = ? and deleted_at is null
          order by created_at desc
          limit ?
        `,
        [input.userId, input.conversationId, limit],
      )
    : await tursoExecute(
        `
          select * from attachments
          where user_id = ? and deleted_at is null
          order by created_at desc
          limit ?
        `,
        [input.userId, limit],
      )

  return rows.rows
    .map((row) => rowToAttachmentRecord(row as AttachmentRow))
    .filter((record): record is AttachmentRecord => record !== null)
}

export async function getAttachmentForUser(userId: string, attachmentId: string): Promise<AttachmentRecord | null> {
  await ensureAttachmentSchema()
  const result = await tursoExecute(
    'select * from attachments where id = ? and user_id = ? and deleted_at is null limit 1',
    [attachmentId, userId],
  )
  return rowToAttachmentRecord(result.rows[0] as AttachmentRow | undefined)
}

export async function assertMessageAttachmentAccessForUser<
  TMessage extends { attachments?: Array<{ id?: string }> },
>(messages: TMessage[], userId: string): Promise<void> {
  const attachments = messages.flatMap((message) => message.attachments || [])
  if (attachments.some((attachment) => !attachment.id?.trim())) {
    throw new AttachmentReferenceError([], 'ATTACHMENT_NOT_PERSISTED')
  }

  const attachmentIds = [...new Set(attachments.map((attachment) => attachment.id!.trim()))]
  if (attachmentIds.length === 0) return

  const records = await Promise.all(attachmentIds.map((attachmentId) => (
    getAttachmentForUser(userId, attachmentId)
  )))
  const missing = attachmentIds.filter((_, index) => !records[index])
  if (missing.length > 0) throw new AttachmentReferenceError(missing)
}

export async function bindAttachmentsToConversation(input: {
  userId: string
  attachmentIds: string[]
  conversationId: string
  messageId?: string | null
}): Promise<void> {
  if (input.attachmentIds.length === 0) return
  await ensureAttachmentSchema()
  const nowMessageId = input.messageId || null

  for (const attachmentId of [...new Set(input.attachmentIds)]) {
    await tursoExecute(
      `
        update attachments
        set conversation_id = coalesce(conversation_id, ?),
            message_id = coalesce(message_id, ?)
        where id = ? and user_id = ? and deleted_at is null
      `,
      [input.conversationId, nowMessageId, attachmentId, input.userId],
    )
  }
}

export async function softDeleteAttachment(userId: string, attachmentId: string): Promise<boolean> {
  const record = await getAttachmentForUser(userId, attachmentId)
  if (!record) return false
  await tursoExecute(
    'update attachments set deleted_at = ? where id = ? and user_id = ?',
    [new Date().toISOString(), attachmentId, userId],
  )
  await deleteObject(record.storageKey).catch(() => undefined)
  return true
}

export async function readAttachmentBody(record: AttachmentRecord): Promise<Buffer> {
  const object = await getObject(record.storageKey)
  return object.body
}

function shouldHydrateInline(record: AttachmentRecord): boolean {
  return record.kind === 'text' ||
    record.kind === 'archive' ||
    record.kind === 'skill' ||
    isExtractableDocument(record.fileName, record.mimeType)
}

async function bodyToInlineContent(record: AttachmentRecord, body: Buffer): Promise<{ content: string; contentEncoding?: 'text' } | null> {
  if (record.kind === 'text' || record.kind === 'archive' || record.kind === 'skill') {
    return { content: body.toString('utf8'), contentEncoding: 'text' }
  }

  const { extractUploadedAttachmentText } = await import('@/lib/attachmentExtraction')
  const extracted = await extractUploadedAttachmentText({
    fileName: record.fileName,
    mimeType: record.mimeType,
    body,
  })
  return extracted ? { content: extracted.content, contentEncoding: 'text' } : null
}

export async function hydrateMessageAttachmentsForUser<
  TMessage extends { attachments?: Array<{ id?: string; name: string; type: string; size: number; content?: string }> },
>(messages: TMessage[], userId: string): Promise<TMessage[]> {
  const hydrated: TMessage[] = []

  for (const message of messages) {
    if (!message.attachments?.length) {
      hydrated.push(message)
      continue
    }

    const nextAttachments = await Promise.all(message.attachments.map(async (attachment) => {
      const attachmentId = attachment.id?.trim()
      if (!attachmentId) throw new AttachmentReferenceError([], 'ATTACHMENT_NOT_PERSISTED')
      const record = await getAttachmentForUser(userId, attachmentId)
      if (!record) throw new AttachmentReferenceError([attachmentId])
      if (!shouldHydrateInline(record)) {
        return {
          ...attachment,
          id: record.id,
          name: record.fileName,
          type: record.mimeType,
          size: record.size,
          content: undefined,
        }
      }
      const body = await readAttachmentBody(record)
      const inline = await bodyToInlineContent(record, body)
      if (!inline) {
        return {
          ...attachment,
          id: record.id,
          name: record.fileName,
          type: record.mimeType,
          size: record.size,
          content: undefined,
        }
      }
      return {
        ...attachment,
        id: record.id,
        name: record.fileName,
        type: record.mimeType,
        size: record.size,
        content: inline.content,
        contentEncoding: inline.contentEncoding,
      }
    }))

    hydrated.push({
      ...message,
      attachments: nextAttachments,
    })
  }

  return hydrated
}

export function withMessageAttachmentSandboxPaths<TMessage extends MessageWithAttachments>(messages: TMessage[]): TMessage[] {
  return messages.map((message, messageIndex) => {
    if (!message.attachments?.length) return message

    const attachments = message.attachments.map((attachment, attachmentIndex) => {
      if (attachment.type === 'application/x-agent-skill') return attachment
      return {
        ...attachment,
        sandboxPath: sandboxUploadPath(attachment, messageIndex, attachmentIndex),
      }
    })

    return {
      ...message,
      attachments,
    }
  })
}

export async function materializeMessageAttachmentsToSandbox<TMessage extends MessageWithAttachments>(
  messages: TMessage[],
  userId: string,
  conversationId: string,
): Promise<void> {
  for (const message of messages) {
    if (!message.attachments?.length) continue

    for (const attachment of message.attachments) {
      const sandboxPath = attachment.sandboxPath
      if (!sandboxPath) continue

      const attachmentId = attachment.id?.trim()
      if (!attachmentId) throw new AttachmentReferenceError([], 'ATTACHMENT_NOT_PERSISTED')
      const record = await getAttachmentForUser(userId, attachmentId)
      if (!record) throw new AttachmentReferenceError([attachmentId])
      const body = await readAttachmentBody(record)
      await writeSandboxFileBytes(conversationId, sandboxPath, body)
    }
  }
}
