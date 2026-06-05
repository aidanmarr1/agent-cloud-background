import { z } from 'zod'
import { auth } from '@/auth'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { AuthUserError, changeUserPassword } from '@/lib/auth/users'
import { checkRateLimit } from '@/lib/rateLimit'

const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
})

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const ip = getClientIp(request)
  const ipRate = checkRateLimit(`password-change:ip:${ip}`, { windowMs: 15 * 60_000, maxRequests: 10 })
  if (!ipRate.allowed) {
    return rateLimitResponse(ipRate.retryAfterMs, 'Too many password attempts. Please try again later.')
  }

  const userRate = checkRateLimit(`password-change:user:${userId}`, { windowMs: 15 * 60_000, maxRequests: 6 })
  if (!userRate.allowed) {
    return rateLimitResponse(userRate.retryAfterMs, 'Too many password attempts. Please try again later.')
  }

  const body = await readJsonBody(request, 16 * 1024)
  if (!body.success) return body.response

  const parsed = PasswordChangeSchema.safeParse(body.data)
  if (!parsed.success) {
    return Response.json({ error: 'Enter your current password and a new password with at least 8 characters.' }, { status: 400 })
  }

  try {
    await changeUserPassword({
      userId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    })
  } catch (error) {
    if (error instanceof AuthUserError) {
      if (error.code === 'INVALID_CREDENTIALS') {
        return Response.json({ error: 'Current password is incorrect.' }, { status: 400 })
      }
      return Response.json({ error: 'Enter a valid new password with at least 8 characters.' }, { status: 400 })
    }

    return Response.json({ error: 'Could not update password. Please try again.' }, { status: 500 })
  }

  return Response.json({ ok: true })
}
