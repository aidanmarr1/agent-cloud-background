import { auth } from '@/auth'
import { getAttachmentForUser, readAttachmentBody, softDeleteAttachment } from '@/lib/attachments'
import { assertSameOriginRequest } from '@/lib/api'

export const runtime = 'nodejs'

function safeDownloadName(name: string): string {
  return name.replace(/[\r\n"]/g, '_')
}

const INLINE_MIME_TYPES = new Set<string>()
const SAFE_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function safeMimeType(value: string): string {
  const mimeType = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType)
    ? mimeType
    : 'application/octet-stream'
}

function quotedEtag(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

function requestHasEtag(request: Request, etag: string): boolean {
  const value = request.headers.get('if-none-match')
  if (!value) return false
  return value
    .split(',')
    .map((entry) => entry.trim())
    .includes(etag)
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const { id } = await params
  if (!SAFE_ATTACHMENT_ID.test(id)) {
    return Response.json({ error: 'Invalid attachment id.' }, { status: 400 })
  }
  const record = await getAttachmentForUser(session.user.id, id)
  if (!record) {
    return Response.json({ error: 'Attachment not found.' }, { status: 404 })
  }

  const mimeType = safeMimeType(record.mimeType)
  const canInline = INLINE_MIME_TYPES.has(mimeType)
  const etag = quotedEtag(record.sha256)
  const baseHeaders = {
    'Content-Type': canInline ? mimeType : 'application/octet-stream',
    'Content-Disposition': `${canInline ? 'inline' : 'attachment'}; filename="${safeDownloadName(record.fileName)}"`,
    'Cache-Control': canInline ? 'private, max-age=31536000, immutable' : 'private, max-age=300',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
    ...(canInline ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'" }),
  }

  if (requestHasEtag(request, etag)) {
    return new Response(null, {
      status: 304,
      headers: baseHeaders,
    })
  }

  const body = await readAttachmentBody(record)
  return new Response(new Uint8Array(body), {
    headers: {
      ...baseHeaders,
      'Content-Length': String(body.byteLength),
    },
  })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = assertSameOriginRequest(_request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const { id } = await params
  if (!SAFE_ATTACHMENT_ID.test(id)) {
    return Response.json({ error: 'Invalid attachment id.' }, { status: 400 })
  }
  const deleted = await softDeleteAttachment(session.user.id, id)
  if (!deleted) {
    return Response.json({ error: 'Attachment not found.' }, { status: 404 })
  }

  return Response.json({ ok: true })
}
