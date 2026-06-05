import { z } from 'zod'
import { checkRateLimit } from '@/lib/rateLimit'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'
import {
  enqueueLiveDirective,
  getLiveDirectiveQueueLength,
} from '@/lib/liveDirectives'
import { auth } from '@/auth'
import { assertInviteAccessApproved } from '@/lib/inviteAccess'
import { clampTaskInput } from '@/lib/inputLimits'

const DIRECTIVE_JSON_BODY_LIMIT_BYTES = 32 * 1024

const LiveDirectiveRequestSchema = z.object({
  conversationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'task id must contain only alphanumeric, hyphens, underscores'),
  content: z.string().trim().min(1).transform((value) => clampTaskInput(value)),
})

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const ip = getClientIp(request)
  const rateCheck = checkRateLimit(`chat-directive:${ip}`, { maxRequests: 120, windowMs: 60_000 })
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfterMs)
  }

  const body = await readJsonBody(request, DIRECTIVE_JSON_BODY_LIMIT_BYTES)
  if (!body.success) return body.response

  const validation = LiveDirectiveRequestSchema.safeParse(body.data)
  if (!validation.success) {
    return Response.json({ error: validation.error.issues[0]?.message || 'Invalid live directive' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }
  const inviteAccessError = await assertInviteAccessApproved(userId)
  if (inviteAccessError) return inviteAccessError

  const { conversationId, content } = validation.data
  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  const directive = enqueueLiveDirective(conversationId, content, userId)
  return Response.json({
    ok: true,
    directiveId: directive.id,
    queued: getLiveDirectiveQueueLength(conversationId),
  })
}
