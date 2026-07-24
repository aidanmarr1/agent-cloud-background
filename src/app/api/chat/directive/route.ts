import { z } from 'zod'
import { checkRateLimit } from '@/lib/rateLimit'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'
import { findActiveTaskJobForConversation } from '@/lib/agent/taskJobs'
import {
  enqueueLiveDirective,
  getLiveDirectiveReceipt,
  getLiveDirectiveQueueLength,
  liveDirectiveContinuationMessageId,
  LiveDirectiveIdConflictError,
  LiveDirectiveQueueFullError,
  LiveDirectiveTargetInactiveError,
  normalizeLiveDirectiveContent,
  type LiveDirectiveReceipt,
} from '@/lib/liveDirectives'
import { auth } from '@/auth'
import { clampTaskInput } from '@/lib/inputLimits'

const DIRECTIVE_JSON_BODY_LIMIT_BYTES = 32 * 1024

const LiveDirectiveRequestSchema = z.object({
  conversationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'task id must contain only alphanumeric, hyphens, underscores'),
  content: z.string().trim().min(1).transform((value) => clampTaskInput(value)),
  directiveId: z.string().uuid(),
})

async function directiveReceiptResponse(receipt: LiveDirectiveReceipt, idempotent: boolean): Promise<Response> {
  const queued = await getLiveDirectiveQueueLength(receipt.conversationId, receipt.userId, receipt.runId)
    .catch(() => undefined)
  const payload = {
    ok: receipt.status !== 'rejected',
    directiveId: receipt.id,
    continuationMessageId: receipt.continuationMessageId,
    content: receipt.content,
    status: receipt.status,
    outcomeCode: receipt.outcomeCode,
    outcomeMessage: receipt.outcomeMessage,
    idempotent,
    queued,
  }
  if (receipt.status === 'rejected') {
    return Response.json({
      ...payload,
      error: receipt.outcomeMessage || 'The live instruction could not be delivered.',
      code: receipt.outcomeCode || 'LIVE_DIRECTIVE_REJECTED',
    }, { status: 409 })
  }
  return Response.json(payload)
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const ip = getClientIp(request)
  const rateCheck = checkRateLimit(`chat-directive:${ip}`, { maxRequests: 120, windowMs: 60_000 })
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfterMs)
  }

  const body = await readJsonBody(request, DIRECTIVE_JSON_BODY_LIMIT_BYTES)
  if (!body.success) return body.response

  const validation = LiveDirectiveRequestSchema.safeParse(body.data)
  if (!validation.success) {
    return Response.json({ error: validation.error.issues[0]?.message || 'Invalid live directive' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }
  const { conversationId, content, directiveId } = validation.data
  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  const normalizedContent = normalizeLiveDirectiveContent(content)
  if (!normalizedContent) {
    return Response.json({ error: 'Live instruction cannot be empty.' }, { status: 400 })
  }
  const existingReceipt = await getLiveDirectiveReceipt(directiveId, userId, conversationId)
  if (existingReceipt) {
    if (existingReceipt.content !== normalizedContent) {
      return Response.json({
        error: 'That live instruction id is already associated with different content.',
        code: 'LIVE_DIRECTIVE_ID_CONFLICT',
      }, { status: 409 })
    }
    return directiveReceiptResponse(existingReceipt, true)
  }

  const activeJob = await findActiveTaskJobForConversation(userId, conversationId)
  if (!activeJob) {
    return Response.json({
      error: 'That task is no longer running. Send a new message instead.',
      code: 'NO_ACTIVE_TASK_FOR_DIRECTIVE',
    }, { status: 409 })
  }
  if (!activeJob.acceptsLiveDirectives) {
    return Response.json({
      error: 'This task cannot accept live instructions. Send a new message instead.',
      code: 'TASK_DOES_NOT_ACCEPT_LIVE_DIRECTIVES',
    }, { status: 409 })
  }

  let directive
  try {
    directive = await enqueueLiveDirective(conversationId, normalizedContent, userId, activeJob.runId, directiveId)
  } catch (error) {
    if (
      error instanceof LiveDirectiveTargetInactiveError ||
      error instanceof LiveDirectiveQueueFullError ||
      error instanceof LiveDirectiveIdConflictError
    ) {
      return Response.json({
        error: error.message,
        code: error.code,
      }, { status: 409 })
    }
    throw error
  }
  return directiveReceiptResponse({
    id: directive.id,
    queueName: directive.queueName || '',
    userId,
    conversationId,
    runId: activeJob.runId,
    continuationMessageId: directive.continuationMessageId || liveDirectiveContinuationMessageId(directive.id),
    content: directive.content,
    createdAt: directive.createdAt,
    status: directive.status || 'accepted',
  }, false)
}
