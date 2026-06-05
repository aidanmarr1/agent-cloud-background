import { auth } from '@/auth'
import { bindAttachmentsToConversation } from '@/lib/attachments'
import { assertSameOriginRequest, readJsonBody } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'

export const runtime = 'nodejs'
const BIND_BODY_LIMIT_BYTES = 256 * 1024
const MAX_BIND_ATTACHMENT_IDS = 50
const SAFE_CLIENT_ID = /^[a-zA-Z0-9_-]{1,128}$/
const SAFE_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface BindBody {
  attachmentIds?: unknown
  conversationId?: unknown
  messageId?: unknown
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const parsedBody = await readJsonBody(request, BIND_BODY_LIMIT_BYTES)
  if (!parsedBody.success) return parsedBody.response

  const body = parsedBody.data as BindBody | null
  const rawAttachmentIds = Array.isArray(body?.attachmentIds) ? body.attachmentIds : []
  if (rawAttachmentIds.length > MAX_BIND_ATTACHMENT_IDS) {
    return Response.json({ error: 'Too many attachments.' }, { status: 400 })
  }
  const attachmentIds = rawAttachmentIds
    .filter((id): id is string => typeof id === 'string')
  if (attachmentIds.some((id) => !SAFE_ATTACHMENT_ID.test(id))) {
    return Response.json({ error: 'Invalid attachment id.' }, { status: 400 })
  }
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''
  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : null

  if (!conversationId) {
    return Response.json({ error: 'Task id is required.' }, { status: 400 })
  }
  if (messageId && !SAFE_CLIENT_ID.test(messageId)) {
    return Response.json({ error: 'Invalid message id.' }, { status: 400 })
  }

  const access = await assertTaskAccess(request, conversationId, { allowCreate: true, userId: session.user.id })
  if (!access.ok) return access.response

  await bindAttachmentsToConversation({
    userId: session.user.id,
    attachmentIds,
    conversationId,
    messageId,
  })

  return Response.json({ ok: true })
}
