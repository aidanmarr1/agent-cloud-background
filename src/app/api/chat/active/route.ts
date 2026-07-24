import { auth } from '@/auth'
import { assertSameOriginRequest } from '@/lib/api'
import { getActiveTaskLeaseForUser } from '@/lib/activeTasks'
import {
  findActiveTaskJobForConversation,
  findReplayableTaskJobForConversation,
  findTaskJobForRun,
  shouldUseExternalTaskWorker,
} from '@/lib/agent/taskJobs'
import { assertTaskAccess } from '@/lib/taskAccess'

export const runtime = 'nodejs'

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/

export async function GET(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const url = new URL(request.url)
  const conversationId = url.searchParams.get('conversationId') || ''
  const requestedRunId = url.searchParams.get('runId') || ''
  const includeTerminalReplay = url.searchParams.get('includeTerminalReplay') === '1'
  if (!SAFE_TASK_ID.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }
  if (requestedRunId && !SAFE_TASK_ID.test(requestedRunId)) {
    return Response.json({ error: 'Invalid run id' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  const exactJob = requestedRunId
    ? await findTaskJobForRun(userId, conversationId, requestedRunId)
    : null
  if (requestedRunId) {
    if (!exactJob) return Response.json({ active: false })
    const terminal = !!exactJob.terminalStatus || ['done', 'error', 'cancelled'].includes(exactJob.status)
    if (terminal && !includeTerminalReplay) return Response.json({ active: false })
    return Response.json({
      active: true,
      source: terminal ? 'replay' : 'job',
      replay: terminal,
      terminal,
      runId: exactJob.runId,
      conversationId: exactJob.conversationId,
      queueName: exactJob.queueName,
      status: exactJob.cancelRequested && !terminal ? 'stopping' : exactJob.status,
      terminalStatus: exactJob.terminalStatus ?? null,
      terminalError: exactJob.terminalError ?? null,
      startedAt: exactJob.startedAt,
      updatedAt: exactJob.updatedAt,
      attempts: exactJob.attempts,
    })
  }

  const job = await findActiveTaskJobForConversation(userId, conversationId)
  if (job) {
    return Response.json({
      active: true,
      source: 'job',
      runId: job.runId,
      conversationId: job.conversationId,
      queueName: job.queueName,
      status: job.cancelRequested ? 'stopping' : job.status,
      terminal: false,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
    })
  }

  if (includeTerminalReplay) {
    const replayable = await findReplayableTaskJobForConversation(userId, conversationId)
    if (replayable) {
      return Response.json({
        active: true,
        source: 'replay',
        replay: true,
        terminal: replayable.status === 'done' || replayable.status === 'error' || replayable.status === 'cancelled' || !!replayable.terminalStatus,
        runId: replayable.runId,
        conversationId: replayable.conversationId,
        queueName: replayable.queueName,
        status: replayable.status,
        terminalStatus: replayable.terminalStatus ?? null,
        terminalError: replayable.terminalError ?? null,
        startedAt: replayable.startedAt,
        updatedAt: replayable.updatedAt,
        attempts: replayable.attempts,
      })
    }
  }

  if (shouldUseExternalTaskWorker()) {
    return Response.json({ active: false })
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
