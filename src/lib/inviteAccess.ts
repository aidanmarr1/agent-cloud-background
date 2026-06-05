import { findUserById, type PublicAuthUser } from '@/lib/auth/users'

export const INVITE_ONLY_ACCESS_CODE = 'INVITE_ONLY_ACCESS_PENDING'
export const INVITE_ONLY_ACCESS_MESSAGE = 'Agent 1.0 is invite-only. Request approval to receive your free 1,000 credits.'

export async function getUserForAccess(userId: string): Promise<(PublicAuthUser & { passwordHash: string }) | null> {
  return findUserById(userId)
}

export function inviteOnlyAccessResponse(): Response {
  return Response.json({
    error: INVITE_ONLY_ACCESS_MESSAGE,
    code: INVITE_ONLY_ACCESS_CODE,
  }, { status: 403 })
}

export async function assertInviteAccessApproved(userId: string): Promise<Response | null> {
  const user = await getUserForAccess(userId)
  if (!user) {
    return Response.json({ error: 'Account not found' }, { status: 404 })
  }
  if (user.accessStatus !== 'approved') {
    return inviteOnlyAccessResponse()
  }
  return null
}
