import { auth } from '@/auth'
import { assertSameOriginRequest } from '@/lib/api'
import { getActiveTaskLeaseForUser } from '@/lib/activeTasks'
import { findActiveTaskJobForConversation } from '@/lib/agent/taskJobs'
import { assertInviteAccessApproved } from '@/lib/inviteAccess'
import { assertTaskAccess } from '@/lib/taskAccess'

export const runtime = 'nodejs'

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/

export async function GET(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId') || ''
  if (!SAFE_TASK_ID.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const inviteAccessError = await assertInviteAccessApproved(userId)
  if (inviteAccessError) return inviteAccessError

  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  const job = await findActiveTaskJobForConversation(userId, conversationId)
  if (job) {
    return Response.json({
      active: true,
      source: 'job',
      runId: job.runId,
      conversationId: job.conversationId,
      queueName: job.queueName,
      status: job.status,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
    })
  }

  const lease = await getActiveTaskLeaseForUser(userId)
  if (!lease || lease.conversationId !== conversationId) {
    return Response.json({ active: false })
  }

  return Response.json({
    active: true,
    source: 'lease',
    runId: lease.runId,
    conversationId: lease.conversationId,
    queueName: lease.queueName,
    startedAt: lease.startedAt,
    updatedAt: lease.updatedAt,
    expiresAt: lease.expiresAt,
  })
}
