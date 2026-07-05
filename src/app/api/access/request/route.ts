import { auth } from '@/auth'
import { assertSameOriginRequest, getClientIp, rateLimitResponse } from '@/lib/api'
import { AuthUserError, findUserById } from '@/lib/auth/users'
import { createApprovalRequestForUser } from '@/lib/auth/signupRequests'
import { checkRateLimit } from '@/lib/rateLimit'

export const preferredRegion = ['syd1', 'iad1']

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const ip = getClientIp(request)
  const rate = checkRateLimit(`access-request:${userId}:${ip}`, {
    windowMs: 60 * 60_000,
    maxRequests: 3,
  })
  if (!rate.allowed) {
    return rateLimitResponse(rate.retryAfterMs, 'Too many approval requests. Please try again later.')
  }

  const user = await findUserById(userId)
  if (!user) {
    return Response.json({ error: 'Account not found' }, { status: 404 })
  }
  if (user.accessStatus === 'approved') {
    return Response.json({
      accessStatus: 'approved',
      requestStatus: 'accepted',
      adminEmailSent: false,
    })
  }

  try {
    const result = await createApprovalRequestForUser({ request, userId })
    return Response.json({
      accessStatus: 'pending',
      requestStatus: result.request.status,
      requestId: result.request.id,
      adminEmailSent: result.adminEmailSent,
    }, { status: 201 })
  } catch (error) {
    if (error instanceof AuthUserError) {
      return Response.json({ error: 'Could not request access.' }, { status: 400 })
    }
    return Response.json({ error: 'Could not request access. Please try again.' }, { status: 500 })
  }
}
