import { auth } from '@/auth'
import { getServerCreditSnapshot } from '@/lib/serverCredits'
import { getUserForAccess } from '@/lib/inviteAccess'

export const preferredRegion = ['syd1', 'iad1']

export async function GET() {
  const session = await auth().catch(() => null)
  const userId = session?.user?.id

  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const user = await getUserForAccess(userId)
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

  if (user.accessStatus !== 'approved') {
    return Response.json({
      balance: { monthly: 0 },
      ledger: [],
      usageSummary: {
        monthlySpent: 0,
        lifetimeSpent: 0,
        taskCount: 0,
        tasks: [],
      },
      monthlyAllowance: 0,
      lastMonthlyRefresh: new Date().toISOString().slice(0, 7),
      accessStatus: 'pending',
      creditsLocked: true,
    }, {
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
