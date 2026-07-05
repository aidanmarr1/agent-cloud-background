import { z } from 'zod'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { AuthUserError, createUser } from '@/lib/auth/users'
import { checkRateLimit } from '@/lib/rateLimit'

export const preferredRegion = ['syd1', 'iad1']

const SignupSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(256),
})

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const ip = getClientIp(request)
  const ipRate = checkRateLimit(`signup:ip:${ip}`, { windowMs: 15 * 60_000, maxRequests: 5 })
  if (!ipRate.allowed) {
    return rateLimitResponse(ipRate.retryAfterMs, 'Too many signup attempts. Please try again later.')
  }

  const body = await readJsonBody(request, 64 * 1024)
  if (!body.success) return body.response

  const parsed = SignupSchema.safeParse(body.data)
  if (!parsed.success) {
    return Response.json(
      { error: 'Enter a valid email and a password with at least 8 characters.' },
      { status: 400 },
    )
  }

  const emailRate = checkRateLimit(`signup:email:${parsed.data.email.toLowerCase()}`, {
    windowMs: 60 * 60_000,
    maxRequests: 3,
  })
  if (!emailRate.allowed) {
    return rateLimitResponse(emailRate.retryAfterMs, 'Too many signup attempts. Please try again later.')
  }

  try {
    const user = await createUser({
      ...parsed.data,
      accessStatus: process.env.AGENT_PUBLIC_SIGNUP === 'true' ? 'approved' : 'pending',
    })
    return Response.json({ user }, { status: 201 })
  } catch (error) {
    if (error instanceof AuthUserError) {
      if (error.code === 'EMAIL_IN_USE') {
        return Response.json({ error: 'An account already exists for that email.' }, { status: 409 })
      }

      return Response.json({ error: 'Enter a valid email and password.' }, { status: 400 })
    }

    return Response.json({ error: 'Could not create account. Please try again.' }, { status: 500 })
  }
}
