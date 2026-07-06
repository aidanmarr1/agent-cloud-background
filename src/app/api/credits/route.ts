import { auth } from '@/auth'
import { getServerCreditSnapshot } from '@/lib/serverCredits'
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

  const snapshot = await getServerCreditSnapshot(userId)

  return Response.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}
