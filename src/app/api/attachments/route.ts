import { auth } from '@/auth'
import {
  type PublicAttachment,
  createStoredAttachment,
  listAttachmentsForUser,
  toPublicAttachment,
} from '@/lib/attachments'
import { extractUploadedAttachmentText } from '@/lib/attachmentExtraction'
import { assertSameOriginRequest } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'

export const runtime = 'nodejs'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1024 * 1024
const SAFE_CLIENT_ID = /^[a-zA-Z0-9_-]{1,128}$/

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init)
}

export async function GET(request: Request) {
  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return jsonResponse({ error: 'Authentication required.' }, { status: 401 })
  }

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId')?.trim() || null
  const attachments = await listAttachmentsForUser({
    userId: session.user.id,
    conversationId,
  })

  return jsonResponse({ attachments: attachments.map(toPublicAttachment) })
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return jsonResponse({ error: 'Authentication required.' }, { status: 401 })
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
    return jsonResponse({ error: 'Upload is larger than 50 MB.' }, { status: 413 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonResponse({ error: 'Invalid multipart upload.' }, { status: 400 })
  }
  const conversationId = form.get('conversationId')
  const messageId = form.get('messageId')
  const files = form.getAll('files').filter((value): value is File => value instanceof File)
  const normalizedConversationId = typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : null
  const normalizedMessageId = typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null
  if (normalizedConversationId) {
    const access = await assertTaskAccess(request, normalizedConversationId, { allowCreate: true, userId: session.user.id })
    if (!access.ok) return access.response
  }
  if (normalizedMessageId && !SAFE_CLIENT_ID.test(normalizedMessageId)) {
    return jsonResponse({ error: 'Invalid message id.' }, { status: 400 })
  }

  if (files.length === 0) {
    return jsonResponse({ error: 'No files were provided.' }, { status: 400 })
  }
  if (files.length > 12) {
    return jsonResponse({ error: 'Too many files in one upload.' }, { status: 400 })
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  if (totalSize > MAX_ATTACHMENT_UPLOAD_BYTES) {
    return jsonResponse({ error: 'Upload is larger than 50 MB.' }, { status: 413 })
  }

  const attachments: Array<PublicAttachment & { content?: string; contentEncoding?: 'text' }> = []
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return jsonResponse({ error: `"${file.name}" is larger than 25 MB.` }, { status: 413 })
    }
    const body = Buffer.from(await file.arrayBuffer())
    const record = await createStoredAttachment({
      userId: session.user.id,
      conversationId: normalizedConversationId,
      messageId: normalizedMessageId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      body,
    })
    const publicAttachment: PublicAttachment & { content?: string; contentEncoding?: 'text' } = toPublicAttachment(record)
    const extracted = await extractUploadedAttachmentText({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      body,
    })
    if (extracted) {
      publicAttachment.content = extracted.content
      publicAttachment.contentEncoding = 'text'
    }
    attachments.push(publicAttachment)
  }

  return jsonResponse({ attachments }, { status: 201 })
}
