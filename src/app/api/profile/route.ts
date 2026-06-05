import { auth } from '@/auth'
import { createStoredAttachment, softDeleteAttachment } from '@/lib/attachments'
import { assertSameOriginRequest } from '@/lib/api'
import { findUserById, setUserProfileImageAttachment } from '@/lib/auth/users'
import { optimizeProfileImage } from '@/lib/profileImage'

export const runtime = 'nodejs'

const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PROFILE_UPLOAD_BYTES = 6 * 1024 * 1024
const PROFILE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init)
}

function publicUser(user: {
  id: string
  name: string | null
  email: string
  image: string | null
  imageAttachmentId: string | null
} | null) {
  if (!user) return null
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    imageAttachmentId: user.imageAttachmentId,
  }
}

function safeImageMimeType(value: string): string | null {
  const mimeType = value.split(';')[0].trim().toLowerCase()
  return PROFILE_IMAGE_MIME_TYPES.has(mimeType) ? mimeType : null
}

export async function GET() {
  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return jsonResponse({ error: 'Authentication required.' }, { status: 401 })
  }

  const user = publicUser(await findUserById(session.user.id))
  if (!user) {
    return jsonResponse({ error: 'Profile not found.' }, { status: 404 })
  }

  return jsonResponse({ user })
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return jsonResponse({ error: 'Authentication required.' }, { status: 401 })
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10)
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return jsonResponse({ error: 'Upload size must be declared.' }, { status: 411 })
  }
  if (contentLength > MAX_PROFILE_UPLOAD_BYTES) {
    return jsonResponse({ error: 'Profile image is larger than 5 MB.' }, { status: 413 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return jsonResponse({ error: 'Invalid multipart upload.' }, { status: 400 })
  }

  const file = form.get('image')
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'Profile image file is required.' }, { status: 400 })
  }
  if (file.size <= 0) {
    return jsonResponse({ error: 'Profile image is empty.' }, { status: 400 })
  }
  if (file.size > MAX_PROFILE_IMAGE_BYTES) {
    return jsonResponse({ error: 'Profile image is larger than 5 MB.' }, { status: 413 })
  }

  const mimeType = safeImageMimeType(file.type || '')
  if (!mimeType) {
    return jsonResponse({ error: 'Use a PNG, JPEG, WebP, or GIF image.' }, { status: 415 })
  }

  const body = Buffer.from(await file.arrayBuffer())
  let optimizedImage: Awaited<ReturnType<typeof optimizeProfileImage>>
  try {
    optimizedImage = await optimizeProfileImage({
      body,
      fileName: file.name || 'profile-image',
    })
  } catch {
    return jsonResponse({ error: 'Could not prepare profile picture.' }, { status: 422 })
  }

  const record = await createStoredAttachment({
    userId: session.user.id,
    conversationId: null,
    messageId: null,
    fileName: optimizedImage.fileName,
    mimeType: optimizedImage.mimeType,
    body: optimizedImage.body,
  })

  try {
    const { user, previousAttachmentId } = await setUserProfileImageAttachment({
      userId: session.user.id,
      attachmentId: record.id,
    })
    if (previousAttachmentId && previousAttachmentId !== record.id) {
      await softDeleteAttachment(session.user.id, previousAttachmentId).catch(() => undefined)
    }
    return jsonResponse({ user: publicUser(user) }, { status: 201 })
  } catch (error) {
    await softDeleteAttachment(session.user.id, record.id).catch(() => undefined)
    throw error
  }
}

export async function DELETE(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return jsonResponse({ error: 'Authentication required.' }, { status: 401 })
  }

  const current = await findUserById(session.user.id)
  if (!current) {
    return jsonResponse({ error: 'Profile not found.' }, { status: 404 })
  }

  const { user, previousAttachmentId } = await setUserProfileImageAttachment({
    userId: session.user.id,
    attachmentId: null,
  })
  if (previousAttachmentId) {
    await softDeleteAttachment(session.user.id, previousAttachmentId).catch(() => undefined)
  }

  return jsonResponse({ user: publicUser(user) })
}
