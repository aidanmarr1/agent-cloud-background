import { auth } from '@/auth'
import { assertSameOriginRequest } from '@/lib/api'
import { findUserById } from '@/lib/auth/users'

export const preferredRegion = ['syd1', 'iad1']

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const user = await findUserById(userId)
  if (!user) {
    return Response.json({ error: 'Account not found' }, { status: 404 })
  }

  return Response.json({
    accessStatus: 'approved',
    requestStatus: null,
  })
}
