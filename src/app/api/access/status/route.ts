import { auth } from '@/auth'
import { findUserById } from '@/lib/auth/users'

export const preferredRegion = ['syd1', 'iad1']

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

  return Response.json({
    accessStatus: 'approved',
    creditsLocked: false,
    requestStatus: null,
    requested: false,
    approvedAt: null,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
