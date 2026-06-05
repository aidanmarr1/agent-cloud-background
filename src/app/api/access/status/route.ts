import { auth } from '@/auth'
import { findUserById } from '@/lib/auth/users'
import { findSignupRequestForUser } from '@/lib/auth/signupRequests'

export async function GET() {
  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const user = await findUserById(userId)
  if (!user) {
    return Response.json({
      error: 'Account not found',
      accountDeleted: true,
    }, {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
      },
    })
  }

  const request = await findSignupRequestForUser({
    userId: user.id,
    email: user.email,
  }).catch(() => null)

  return Response.json({
    accessStatus: user.accessStatus,
    creditsLocked: user.accessStatus !== 'approved',
    requestStatus: request?.status ?? null,
    requested: request?.status === 'pending',
    approvedAt: request?.status === 'accepted' ? request.decidedAt : null,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
