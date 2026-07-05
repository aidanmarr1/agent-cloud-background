import { auth } from '@/auth'
import { assertSameOriginRequest, readJsonBody } from '@/lib/api'
import {
  clearUserConversations,
  getUserConversationById,
  getUserConversationIndex,
  parseConversationSyncPayload,
  syncUserConversations,
} from '@/lib/conversations'

export const runtime = 'nodejs'
export const preferredRegion = ['syd1', 'iad1']

const CONVERSATION_SYNC_BODY_LIMIT_BYTES = 30 * 1024 * 1024

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function requireUserId(): Promise<string | Response> {
  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }
  return userId
}

export async function GET(request: Request) {
  const userId = await requireUserId()
  if (userId instanceof Response) return noStore(userId)

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('id')
  if (conversationId) {
    const conversation = await getUserConversationById(userId, conversationId)
    return noStore(Response.json({ conversation }))
  }

  const state = await getUserConversationIndex(userId)
  return noStore(Response.json({ ...state, partial: true }))
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const userId = await requireUserId()
  if (userId instanceof Response) return noStore(userId)

  const body = await readJsonBody(request, CONVERSATION_SYNC_BODY_LIMIT_BYTES)
  if (!body.success) return noStore(body.response)

  const payload = parseConversationSyncPayload(body.data)
  if (!payload) {
    return noStore(Response.json({ error: 'Invalid conversation sync payload' }, { status: 400 }))
  }

  await syncUserConversations(userId, payload)
  return noStore(Response.json({ ok: true }))
}

export async function DELETE(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const userId = await requireUserId()
  if (userId instanceof Response) return noStore(userId)

  await clearUserConversations(userId)
  return noStore(Response.json({ ok: true }))
}
