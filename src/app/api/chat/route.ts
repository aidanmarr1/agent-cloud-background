import { randomUUID } from 'crypto'
import { ChatRequestSchema } from '@/lib/validation/schemas'
import { validateRequest } from '@/lib/validation/validate'
import { checkRateLimit } from '@/lib/rateLimit'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'
import { shouldUseDirectChat } from '@/lib/directChatRouting'
import { isContextualTaskUpdate } from '@/lib/conversationContext'
import {
  prepareUserConversationForTaskStartInsert,
  type TaskStartConversationInsert,
  type TaskStartConversationInput,
} from '@/lib/conversations'
import { auth } from '@/auth'
import {
  assertMessageAttachmentAccessForUser,
  AttachmentReferenceError,
  hydrateMessageAttachmentsForUser,
} from '@/lib/attachments'
import {
  assertServerCreditsAvailable,
  isOutOfCreditsError,
} from '@/lib/serverCredits'
import { OUT_OF_CREDITS_CODE, OUT_OF_CREDITS_MESSAGE } from '@/lib/creditPolicy'
import type { AgentLoopOptions } from '@/lib/agent/AgentLoop'
import { scopeAgentTaskMessages } from '@/lib/agent/messageScope'
import {
  cancelTaskJob,
  createTaskJobEventStream,
  enqueueTaskJob,
  findActiveTaskJobForConversation,
  findTaskJobForRun,
  shouldUseExternalTaskWorker,
  startTaskJob,
  TaskConversationConflictError,
  TaskConversationPersistenceConflictError,
  TaskJobPayloadTooLargeError,
  TaskPreStartCancelledError,
} from '@/lib/agent/taskJobs'
import {
  getRecentTaskWorkerHeartbeats,
  workerHeartbeatIsHosted,
  workerHeartbeatMatchesCurrentProtocol,
  type TaskWorkerHeartbeat,
} from '@/lib/agent/taskWorkerHeartbeat'
import { runChatTaskJob as runSharedChatTaskJob, type ChatTaskPayload } from '@/lib/agent/chatTaskRunner'
import type { SSEEvent } from '@/types'
import { userErrorMessage } from '@/lib/errorMessages'

export const runtime = 'nodejs'
export const maxDuration = 300

const CHAT_JSON_BODY_LIMIT_BYTES = 30 * 1024 * 1024

const DEFAULT_TASK_WORKER_STALE_MS = 60_000
const TASK_WORKER_READY_CACHE_MS = 10_000
type WorkerAvailabilityCache = {
  checkedAt: number
}

const workerAvailabilityCacheKey = '__agentWorkerAvailabilityCache' as const

const conversationStartReservationsKey = '__agentConversationStartReservations' as const

function conversationStartReservations(): Map<string, string> {
  const globalRecord = globalThis as unknown as Record<string, unknown>
  const existing = globalRecord[conversationStartReservationsKey]
  if (existing instanceof Map) return existing as Map<string, string>
  const created = new Map<string, string>()
  globalRecord[conversationStartReservationsKey] = created
  return created
}

function reserveConversationStart(
  userId: string,
  conversationId: string,
  runId: string,
): { release: () => void; existingRunId?: never } | { release?: never; existingRunId: string } {
  const reservations = conversationStartReservations()
  const key = `${userId}:${conversationId}`
  const existingRunId = reservations.get(key)
  if (existingRunId) return { existingRunId }
  reservations.set(key, runId)
  let released = false
  return { release: () => {
    if (released) return
    released = true
    if (reservations.get(key) === runId) reservations.delete(key)
  } }
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function requiresTaskWorkerHeartbeat(): boolean {
  const raw = process.env.AGENT_REQUIRE_TASK_WORKER_HEARTBEAT?.trim().toLowerCase()
  return raw !== 'false' && raw !== '0'
}

function requiresHostedTaskWorkerHeartbeat(): boolean {
  const raw = process.env.AGENT_REQUIRE_HOSTED_TASK_WORKER?.trim().toLowerCase()
  if (raw) return raw !== 'false' && raw !== '0'
  return false
}

function envBoolEnabled(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  return raw !== 'false' && raw !== '0'
}

function externalTaskWorkerModeRequested(): boolean {
  return process.env.AGENT_TASK_WORKER_MODE?.trim() === 'external'
}

function workerMatchesConfiguredRuntime(worker: TaskWorkerHeartbeat): boolean {
  const expectedDeploymentVersion = process.env.AGENT_DEPLOYMENT_VERSION?.trim() || null
  const requireDeploymentVersion = envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')
  if (
    requireDeploymentVersion &&
    (!expectedDeploymentVersion || worker.deploymentVersion !== expectedDeploymentVersion)
  ) {
    return false
  }

  return workerHeartbeatMatchesCurrentProtocol(worker) &&
    (worker.status === 'idle' || worker.status === 'running') &&
    worker.taskWorkerMode === 'external' &&
    worker.sandboxProvider === 'e2b' &&
    worker.e2bApiKeyConfigured === true &&
    worker.e2bBrowserRuntimeConfigured === true
}

async function taskWorkerUnavailableResponse(): Promise<Response | null> {
  if (!externalTaskWorkerModeRequested()) return null

  if (!shouldUseExternalTaskWorker()) {
    return Response.json({
      error: 'External background worker mode is enabled, but the persistent task queue is not configured.',
      code: 'BACKGROUND_WORKER_QUEUE_NOT_CONFIGURED',
    }, { status: 503 })
  }

  if (!requiresTaskWorkerHeartbeat()) return null

  const cached = (globalThis as unknown as Record<typeof workerAvailabilityCacheKey, WorkerAvailabilityCache | undefined>)[workerAvailabilityCacheKey]
  if (cached && Date.now() - cached.checkedAt < TASK_WORKER_READY_CACHE_MS) {
    return null
  }

  const staleMs = envPositiveInt('AGENT_TASK_WORKER_STALE_MS', DEFAULT_TASK_WORKER_STALE_MS)
  const requireHostedWorker = requiresHostedTaskWorkerHeartbeat()
  try {
    const workers = await getRecentTaskWorkerHeartbeats(staleMs)
    const compatibleWorkers = workers.filter(workerMatchesConfiguredRuntime)
    if (compatibleWorkers.some(worker => !requireHostedWorker || workerHeartbeatIsHosted(worker))) {
      ;(globalThis as unknown as Record<typeof workerAvailabilityCacheKey, WorkerAvailabilityCache | undefined>)[workerAvailabilityCacheKey] = {
        checkedAt: Date.now(),
      }
      return null
    }
    if (requireHostedWorker && compatibleWorkers.length > 0) {
      const localHosts = compatibleWorkers
        .map(worker => worker.hostname)
        .filter(Boolean)
        .join(', ')
      return Response.json({
        error: `Only local background workers are running${localHosts ? ` (${localHosts})` : ''}. Start the hosted worker service and try again.`,
        code: 'BACKGROUND_WORKER_LOCAL_ONLY',
      }, { status: 503 })
    }
  } catch (error) {
    console.error('[AgentDiagnostics] Task worker heartbeat check failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    const body = {
      error: 'Background task worker health check failed. Please try again shortly.',
      code: 'BACKGROUND_WORKER_HEALTH_CHECK_FAILED',
    }
    return Response.json(body, { status: 503 })
  }

  const body = {
    error: 'No compatible background task worker is running right now. Please start the worker service and try again.',
    code: 'BACKGROUND_WORKER_UNAVAILABLE',
  }
  return Response.json(body, { status: 503 })
}

function hasUnhydratedAttachments(messages: AgentLoopOptions['messages']): boolean {
  return messages.some((message) => (
    Array.isArray(message.attachments) &&
    message.attachments.some((attachment) => !!attachment.id && !attachment.content)
  ))
}

function stripPersistedAttachmentBodies(
  messages: AgentLoopOptions['messages'],
): AgentLoopOptions['messages'] {
  return messages.map((message) => {
    if (!message.attachments?.length) return message
    return {
      ...message,
      attachments: message.attachments.map((attachment) => {
        const { sandboxPath: _clientSandboxPath, ...safeAttachment } = attachment
        if (!safeAttachment.id) return safeAttachment
        const {
          content: _inlineBody,
          contentEncoding: _inlineEncoding,
          preview: _inlinePreview,
          ...storedReference
        } = safeAttachment
        return storedReference
      }),
    }
  })
}

async function prepareConversationForTaskStartInsert(input: {
  userId: string
  conversationId: string
  messages: AgentLoopOptions['messages']
  runId: string
  assistantMessageId?: string
  startedAt: number
  customInstructions?: string
}): Promise<TaskStartConversationInsert | null> {
  const persistableMessages: TaskStartConversationInput['messages'] = input.messages
    .filter((message): message is AgentLoopOptions['messages'][number] & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .map((message) => ({
      ...(message.id ? { id: message.id } : {}),
      ...(Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}),
      role: message.role,
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    }))
  if (!persistableMessages.length) return null
  persistableMessages.push({
    id: input.assistantMessageId || randomUUID(),
    timestamp: input.startedAt,
    streamRunId: input.runId,
    streamSeq: 0,
    role: 'assistant',
    content: '',
  })
  return prepareUserConversationForTaskStartInsert(input.userId, {
    conversationId: input.conversationId,
    messages: persistableMessages,
    customInstructions: input.customInstructions,
  })
}

function routeTimingsHeaderValue(timings: Record<string, number>): string {
  return JSON.stringify(timings).slice(0, 1800)
}

function parseTaskRunQuery(request: Request): {
  runId: string
  conversationId: string
  afterSeq: number
} | Response {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId') || ''
  const conversationId = url.searchParams.get('conversationId') || ''
  const afterRaw = url.searchParams.get('after') || '0'
  const afterSeq = Number.parseInt(afterRaw, 10)

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
    return Response.json({ error: 'Invalid run id' }, { status: 400 })
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }

  return {
    runId,
    conversationId,
    afterSeq: Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0,
  }
}

async function authenticateTaskRunRequest(
  request: Request,
  options: { allowCreateTaskAccess?: boolean } = {},
): Promise<{
  userId: string
  runId: string
  conversationId: string
  afterSeq: number
} | Response> {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  const params = parseTaskRunQuery(request)
  if (params instanceof Response) return params

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }
  const access = await assertTaskAccess(request, params.conversationId, {
    userId,
    allowCreate: options.allowCreateTaskAccess === true,
  })
  if (!access.ok) return access.response

  return { userId, ...params }
}

export async function GET(request: Request) {
  const authenticated = await authenticateTaskRunRequest(request)
  if (authenticated instanceof Response) return authenticated

  const stream = createTaskJobEventStream({
    userId: authenticated.userId,
    runId: authenticated.runId,
    conversationId: authenticated.conversationId,
    afterSeq: authenticated.afterSeq,
    signal: request.signal,
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Agent-Run-Id': authenticated.runId,
      Connection: 'keep-alive',
    },
  })
}

export async function DELETE(request: Request) {
  // A stop can beat the initial POST's access/reservation write. Authenticated
  // ownership is therefore allowed to be created by DELETE for this exact
  // client-supplied conversation/run pair.
  const authenticated = await authenticateTaskRunRequest(request, { allowCreateTaskAccess: true })
  if (authenticated instanceof Response) return authenticated

  const cancellation = await cancelTaskJob(authenticated.userId, authenticated.runId, authenticated.conversationId)
  const terminalJob = cancellation.ok && cancellation.terminal
    ? await findTaskJobForRun(
        authenticated.userId,
        authenticated.conversationId,
        authenticated.runId,
      ).catch(() => null)
    : null
  const responseBody = terminalJob?.terminalError
    ? { ...cancellation, terminalError: terminalJob.terminalError }
    : cancellation
  return Response.json(responseBody, {
    status: cancellation.ok ? (cancellation.terminal ? 200 : 202) : 404,
  })
}

export async function POST(request: Request) {
  const postStartedAt = Date.now()
  const routeTimings: Record<string, number> = {}
  const markRouteTiming = (name: string) => {
    routeTimings[name] = Date.now() - postStartedAt
  }
  const timedRoutePromise = <T,>(name: string, promise: Promise<T>): Promise<T> =>
    promise.finally(() => {
      routeTimings[name] = Date.now() - postStartedAt
    })

  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  // Rate limiting
  const ip = getClientIp(request)
  const rateCheck = checkRateLimit(`chat:${ip}`)
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfterMs)
  }

  const sessionPromise = auth().catch(() => null)
  const body = await readJsonBody(request, CHAT_JSON_BODY_LIMIT_BYTES)
  markRouteTiming('bodyParsedMs')
  if (!body.success) {
    return body.response
  }

  const validation = validateRequest(ChatRequestSchema, body.data)
  markRouteTiming('validatedMs')
  if (!validation.success) {
    return validation.response
  }

  const { model, conversationId, customInstructions, startFreshSandbox } = validation.data
  const session = await sessionPromise
  markRouteTiming('sessionReadyMs')
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }
  const rawMessages = validation.data.messages
  const directChat = shouldUseDirectChat(rawMessages)
  const creditRunId = validation.data.runId
  const useExternalWorker = shouldUseExternalTaskWorker()
  const safeRawMessages = stripPersistedAttachmentBodies(rawMessages)
  const scopedTaskMessages = scopeAgentTaskMessages(safeRawMessages)

  // This preparation is read-only: it builds the conversation statement that
  // enqueue/start will later commit atomically with the task row. Begin it as
  // soon as the authenticated, validated payload is available so its schema and
  // conversation reads overlap access/idempotency checks instead of following
  // them serially. A denied request can never commit the prepared statement.
  const conversationInsertPromise = timedRoutePromise(
    'conversationPreparedMs',
    prepareConversationForTaskStartInsert({
      userId,
      conversationId,
      messages: safeRawMessages,
      runId: creditRunId,
      assistantMessageId: validation.data.assistantMessageId,
      startedAt: postStartedAt,
      customInstructions,
    }),
  )
  // Access/idempotency may return before preparation settles; register a
  // rejection observer now so that read-only speculative work is never an
  // unhandled rejection. The acceptance wave below still awaits the original.
  void conversationInsertPromise.catch(() => undefined)

  let access: Awaited<ReturnType<typeof assertTaskAccess>> | null = null
  try {
    access = conversationId
      ? await timedRoutePromise('taskAccessReadyMs', assertTaskAccess(request, conversationId, { allowCreate: true, userId }))
      : null
  } catch (error) {
    const message = userErrorMessage(error, 'The task could not start. Please try again.')
    return Response.json({ error: message, code: 'TASK_START_FAILED' }, { status: 500 })
  }
  if (access && !access.ok) return access.response

  // Idempotency recovery must happen before credit and worker readiness gates:
  // a retry after a lost success response may arrive after the original run
  // consumed the account's last credit or while workers are temporarily down.
  try {
    const acceptedRun = await findTaskJobForRun(userId, conversationId, creditRunId)
    if (acceptedRun) {
      return Response.json({
        error: 'This task start was already accepted. Reconnect to its existing run.',
        code: 'TASK_RUN_ALREADY_EXISTS',
        conversationId,
        runId: acceptedRun.runId,
        status: acceptedRun.status,
        terminal: !!acceptedRun.terminalStatus || ['done', 'error', 'cancelled'].includes(acceptedRun.status),
      }, { status: 409 })
    }
  } catch (error) {
    const message = userErrorMessage(error, 'The task could not verify its start status. Please try again.')
    return Response.json({ error: message, code: 'TASK_START_STATUS_FAILED' }, { status: 500 })
  }

  const messagesPromise = useExternalWorker || directChat || !hasUnhydratedAttachments(scopedTaskMessages)
    ? Promise.resolve(scopedTaskMessages)
    : hydrateMessageAttachmentsForUser(scopedTaskMessages, userId)
  const creditsPromise = assertServerCreditsAvailable(userId)
    .finally(() => {
      routeTimings.creditsReadyMs = Date.now() - postStartedAt
    })
  const workerAvailabilityPromise = timedRoutePromise('workerReadyMs', taskWorkerUnavailableResponse())
  const attachmentAccessPromise = timedRoutePromise(
    'attachmentsReadyMs',
    assertMessageAttachmentAccessForUser(safeRawMessages, userId),
  )
  // These are advisory early conflict responses. Start both reads in the same
  // acceptance wave; enqueue/start still repeat the authoritative checks inside
  // their atomic reservation transaction, closing every race after this read.
  const taskConflictChecksPromise = (async () => {
    const [requestedTask, activeCandidate] = await Promise.all([
      findTaskJobForRun(userId, conversationId, creditRunId),
      findActiveTaskJobForConversation(userId, conversationId),
    ])
    return { requestedTask, activeCandidate }
  })()

  let messages: AgentLoopOptions['messages']
  let unavailableWorker: Response | null = null
  let conversationInsert: TaskStartConversationInsert | null = null
  let taskConflictChecks: Awaited<typeof taskConflictChecksPromise>

  try {
    ;[, messages, unavailableWorker, , conversationInsert, taskConflictChecks] = await Promise.all([
      creditsPromise,
      messagesPromise,
      workerAvailabilityPromise,
      attachmentAccessPromise,
      conversationInsertPromise,
      taskConflictChecksPromise,
    ])
  } catch (error) {
    if (error instanceof AttachmentReferenceError) {
      return Response.json({
        error: error.message,
        code: error.code,
      }, { status: 400 })
    }
    if (isOutOfCreditsError(error)) {
      return Response.json({
        error: error.message || OUT_OF_CREDITS_MESSAGE,
        code: error.code || OUT_OF_CREDITS_CODE,
        balance: error.balanceAfter,
        requiredCredits: error.requiredCredits,
      }, { status: 402 })
    }
    const message = userErrorMessage(error, 'The task could not start. Please try again.')
    return Response.json({ error: message, code: 'TASK_START_FAILED' }, { status: 500 })
  }

  const startIsolatedTaskSandbox = startFreshSandbox || (!directChat && !isContextualTaskUpdate(messages))
  if (unavailableWorker) {
    const headers = new Headers(unavailableWorker.headers)
    headers.set('X-Agent-Route-Elapsed-Ms', String(Date.now() - postStartedAt))
    headers.set('X-Agent-Route-Timings', routeTimingsHeaderValue(routeTimings))
    return new Response(unavailableWorker.body, {
      status: unavailableWorker.status,
      statusText: unavailableWorker.statusText,
      headers,
    })
  }

  const startReservation = reserveConversationStart(userId, conversationId, creditRunId)
  if (!startReservation.release) {
    return Response.json({
      error: 'This task already has work starting. Reconnect to it or send a live instruction instead.',
      code: 'CONVERSATION_TASK_ALREADY_RUNNING',
      conversationId,
      runId: startReservation.existingRunId,
      status: 'starting',
    }, { status: 409 })
  }
  const releaseConversationStart = startReservation.release

  const { requestedTask, activeCandidate } = taskConflictChecks
  const existingRequestedTask = requestedTask || (activeCandidate?.runId === creditRunId ? activeCandidate : null)
  const activeTask = existingRequestedTask ? null : activeCandidate
  if (existingRequestedTask) {
    releaseConversationStart()
    return Response.json({
      error: 'This task start was already accepted. Reconnect to its existing run.',
      code: 'TASK_RUN_ALREADY_EXISTS',
      conversationId,
      runId: existingRequestedTask.runId,
      status: existingRequestedTask.status,
      terminal: !!existingRequestedTask.terminalStatus || ['done', 'error', 'cancelled'].includes(existingRequestedTask.status),
    }, { status: 409 })
  }
  if (activeTask) {
    releaseConversationStart()
    return Response.json({
      error: 'This task is already running. Reconnect to it or send a live instruction instead.',
      code: 'CONVERSATION_TASK_ALREADY_RUNNING',
      conversationId,
      runId: activeTask.runId,
      status: activeTask.status,
    }, { status: 409 })
  }

  const taskPayload: ChatTaskPayload = {
    messages,
    model,
    customInstructions,
    startFreshSandbox,
    startIsolatedTaskSandbox,
    directChat,
    skipStartupAcknowledgement: false,
    startupPlanExpected: false,
  }

  if (useExternalWorker) {
    const heartbeatEvent: SSEEvent = { type: 'heartbeat', timestamp: postStartedAt }
    const initialEvents: SSEEvent[] = [heartbeatEvent]
    try {
      const queuedTaskPayload: ChatTaskPayload = {
        ...taskPayload,
        messages,
        startupPlanExpected: false,
      }
      if (request.signal.aborted) {
        return Response.json({ error: 'Request cancelled.', code: 'REQUEST_ABORTED' }, { status: 499 })
      }
      await enqueueTaskJob({
        runId: creditRunId,
        userId,
        conversationId,
        payload: queuedTaskPayload,
        initialEvents,
        conversationInsert,
      })
    } catch (error) {
      if (error instanceof TaskPreStartCancelledError) {
        return Response.json({
          error: error.message,
          code: error.code,
          conversationId: error.conversationId,
          runId: error.runId,
          status: 'cancelled',
          terminal: true,
        }, { status: 410 })
      }
      if (error instanceof TaskConversationConflictError) {
        return Response.json({
          error: error.message,
          code: 'CONVERSATION_TASK_ALREADY_RUNNING',
          conversationId,
          runId: error.existingRunId,
          status: error.existingStatus,
        }, { status: 409 })
      }
      if (error instanceof TaskConversationPersistenceConflictError) {
        return Response.json({ error: error.message, code: error.code }, { status: 409 })
      }
      if (error instanceof TaskJobPayloadTooLargeError) {
        return Response.json({
          error: 'This task is too large to queue. Upload large files as saved attachments, then try again.',
          code: error.code,
          maxBytes: error.maxBytes,
        }, { status: 413 })
      }
      const message = userErrorMessage(error, 'The task could not be queued. Please try again.')
      return Response.json({ error: message, code: 'TASK_QUEUE_FAILED' }, { status: 500 })
    } finally {
      releaseConversationStart()
    }

    markRouteTiming('conversationDurableMs')
    markRouteTiming('taskQueuedMs')

    markRouteTiming('streamOpenedMs')
    console.log('[AgentDiagnostics] Chat POST opened queued task stream', {
      conversationId,
      runId: creditRunId,
      externalWorker: true,
      elapsedMs: Date.now() - postStartedAt,
      timings: routeTimings,
    })

    const stream = createTaskJobEventStream({
      userId,
      runId: creditRunId,
      conversationId,
      afterSeq: 0,
      signal: request.signal,
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Agent-Run-Id': creditRunId,
        'X-Agent-Route-Elapsed-Ms': String(Date.now() - postStartedAt),
        'X-Agent-Route-Timings': routeTimingsHeaderValue(routeTimings),
        Connection: 'keep-alive',
        ...(access?.ok ? access.headers : {}),
      },
    })
  }

  try {
    if (request.signal.aborted) {
      return Response.json({ error: 'Request cancelled.', code: 'REQUEST_ABORTED' }, { status: 499 })
    }
    await startTaskJob({
      runId: creditRunId,
      userId,
      conversationId,
      acceptsLiveDirectives: !directChat,
      conversationInsert,
      runner: (emitter, signal, runContext) => runSharedChatTaskJob({
        emitter,
        signal,
        messages,
        model,
        conversationId,
        customInstructions,
        startFreshSandbox,
        startIsolatedTaskSandbox,
        directChat,
        userId,
        creditRunId,
        registerPreTerminalCleanup: runContext.registerPreTerminalCleanup,
        registerInflightToolDrain: runContext.registerInflightToolDrain,
      }),
    })
  } catch (error) {
    if (error instanceof TaskPreStartCancelledError) {
      return Response.json({
        error: error.message,
        code: error.code,
        conversationId: error.conversationId,
        runId: error.runId,
        status: 'cancelled',
        terminal: true,
      }, { status: 410 })
    }
    if (error instanceof TaskConversationConflictError) {
      return Response.json({
        error: error.message,
        code: 'CONVERSATION_TASK_ALREADY_RUNNING',
        conversationId,
        runId: error.existingRunId,
        status: error.existingStatus,
      }, { status: 409 })
    }
    if (error instanceof TaskConversationPersistenceConflictError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 })
    }
    const message = userErrorMessage(error, 'The task could not start. Please try again.')
    return Response.json({ error: message, code: 'TASK_START_FAILED' }, { status: 500 })
  } finally {
    releaseConversationStart()
  }
  markRouteTiming('conversationDurableMs')
  markRouteTiming('taskQueuedMs')

  console.log('[AgentDiagnostics] Chat POST opened task stream', {
    conversationId,
    runId: creditRunId,
    externalWorker: shouldUseExternalTaskWorker(),
    elapsedMs: Date.now() - postStartedAt,
    timings: routeTimings,
  })

  const stream = createTaskJobEventStream({
    userId,
    runId: creditRunId,
    conversationId,
    afterSeq: 0,
    signal: request.signal,
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Agent-Run-Id': creditRunId,
      'X-Agent-Route-Elapsed-Ms': String(Date.now() - postStartedAt),
      'X-Agent-Route-Timings': routeTimingsHeaderValue(routeTimings),
      Connection: 'keep-alive',
      ...(access?.ok ? access.headers : {}),
    },
  })
}
