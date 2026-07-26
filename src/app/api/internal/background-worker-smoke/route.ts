import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  cancelTaskJob,
  cleanupInternalTaskJob,
  enqueueTaskJob,
  createTaskJobEventStream,
  findActiveTaskJobForConversation,
  inspectTaskExecutionDispatchState,
} from '@/lib/agent/taskJobs'
import { taskQueueName } from '@/lib/agent/taskQueue'
import {
  getRecentTaskWorkerHeartbeats,
  isLikelyLocalWorkerHostname,
  workerHeartbeatIsHosted,
  workerHeartbeatMatchesCurrentProtocol,
} from '@/lib/agent/taskWorkerHeartbeat'
import {
  getTaskExecutionCoordinatorStatus,
  startTaskExecutionCoordinator,
} from '@/lib/agent/taskExecutionCoordinator'
import {
  cancelTaskDispatchProviderJob,
  listTaskDispatchProviderJobs,
  retrieveTaskDispatchProviderJob,
  usesOnDemandTaskDispatch,
} from '@/lib/agent/taskDispatch'
import { parseSSE } from '@/lib/stream'
import type { SSEEvent } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 180

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/background-worker-smoke'
const FIRST_VIEWER_TIMEOUT_MS = 45_000
const ON_DEMAND_COLD_START_GRACE_MS = 60_000
const RECONNECT_TIMEOUT_MS = 20_000
const PROBE_DELAY_MS = 2_500
const CLEANUP_RETRY_MS = 100
const CLEANUP_RETRIES = 30
const PROVIDER_SETTLE_TIMEOUT_MS = 8_000
const PROVIDER_SETTLE_POLL_MS = 500
const PROVIDER_SETTLE_MIN_MS = 2_000
const PROVIDER_SETTLE_REQUIRED_CLEAN_OBSERVATIONS = 2

function safeCompareHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function verifyInternalSignature(request: NextRequest): boolean {
  const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET
  if (!secret) return false

  const timestamp = request.headers.get('x-agent-health-ts') || ''
  const signature = request.headers.get('x-agent-health-signature') || ''
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false

  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs)) return false
  if (Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) return false

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${HEALTH_PATH}`)
    .digest('hex')

  return safeCompareHex(signature, expected)
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function env(name: string): string {
  return process.env[name]?.trim() || ''
}

function envBoolEnabled(name: string, fallback = false): boolean {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value !== 'false' && value !== '0'
}

function eventSummary(event: SSEEvent): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    type: event.type,
    seq: event.seq,
  }
  if (event.type === 'text_delta') summary.content = event.content.slice(0, 120)
  if (event.type === 'error') summary.message = event.message
  return summary
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isCloudCapableWorker(worker: {
  status?: string | null
  hostname?: string | null
  taskWorkerMode?: string | null
  sandboxProvider?: string | null
  deploymentVersion?: string | null
  orchestrationProtocolVersion?: string | null
  e2bApiKeyConfigured?: boolean | null
  e2bBrowserRuntimeConfigured?: boolean | null
}, expectedDeploymentVersion: string | null, requireDeploymentVersion: boolean): boolean {
  const versionMatches = !requireDeploymentVersion ||
    (!!expectedDeploymentVersion && worker.deploymentVersion === expectedDeploymentVersion)

  return workerHeartbeatMatchesCurrentProtocol(worker) &&
    (worker.status === 'idle' || worker.status === 'running') &&
    worker.taskWorkerMode === 'external' &&
    worker.sandboxProvider === 'e2b' &&
    worker.e2bApiKeyConfigured === true &&
    worker.e2bBrowserRuntimeConfigured === true &&
    workerHeartbeatIsHosted(worker) &&
    versionMatches
}

function isE2BCapableWorker(worker: {
  status?: string | null
  taskWorkerMode?: string | null
  sandboxProvider?: string | null
  deploymentVersion?: string | null
  orchestrationProtocolVersion?: string | null
  e2bApiKeyConfigured?: boolean | null
  e2bBrowserRuntimeConfigured?: boolean | null
}, expectedDeploymentVersion: string | null, requireDeploymentVersion: boolean): boolean {
  const versionMatches = !requireDeploymentVersion ||
    (!!expectedDeploymentVersion && worker.deploymentVersion === expectedDeploymentVersion)

  return workerHeartbeatMatchesCurrentProtocol(worker) &&
    (worker.status === 'idle' || worker.status === 'running') &&
    worker.taskWorkerMode === 'external' &&
    worker.sandboxProvider === 'e2b' &&
    worker.e2bApiKeyConfigured === true &&
    worker.e2bBrowserRuntimeConfigured === true &&
    versionMatches
}

async function cleanupProbeRows(userId: string, runId: string): Promise<boolean> {
  for (let attempt = 0; attempt < CLEANUP_RETRIES; attempt += 1) {
    if (await cleanupInternalTaskJob(userId, runId)) return true
    await sleep(CLEANUP_RETRY_MS)
  }
  return false
}

interface ProviderSettlement {
  safeToCleanup: boolean
  observedProviderJobs: number
  cancellationAccepted: number
  reason: string | null
}

interface ProbeCleanupResult extends ProviderSettlement {
  cleanedUp: boolean
}

function providerJobIsLive(status: string): boolean {
  return status === 'pending' || status === 'running'
}

async function withinProviderSettleDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) {
    throw new Error('Provider settlement deadline reached.')
  }
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Provider settlement deadline reached.')),
      remainingMs,
    )
    timeout.unref?.()
    operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function settleOnDemandProviderJobs(input: {
  runId: string
  startedAtMs: number
  cancelLiveJobs: boolean
}): Promise<ProviderSettlement> {
  const deadlineMs = Date.now() + PROVIDER_SETTLE_TIMEOUT_MS
  const providerSettleController = new AbortController()
  const providerSettleTimeout = setTimeout(
    () => providerSettleController.abort(),
    PROVIDER_SETTLE_TIMEOUT_MS,
  )
  const cleanNotBeforeMs = Date.now() + PROVIDER_SETTLE_MIN_MS
  const cancellationAttempted = new Set<string>()
  const cancellationAccepted = new Set<string>()
  const observedProviderJobs = new Set<string>()
  let cleanObservations = 0
  let lastReason: string | null = 'The provider execution has not reached a terminal state.'

  while (Date.now() < deadlineMs) {
    try {
      const [dispatchState, listed] = await withinProviderSettleDeadline(
        Promise.all([
          inspectTaskExecutionDispatchState(input.runId),
          listTaskDispatchProviderJobs({
            runId: input.runId,
            createdAfterMs: input.startedAtMs,
          }, {
            signal: providerSettleController.signal,
          }),
        ]),
        deadlineMs,
      )
      if (listed.outcome !== 'complete') {
        cleanObservations = 0
        lastReason = `Render job listing was not authoritative (${listed.errorCode}).`
        await sleep(PROVIDER_SETTLE_POLL_MS)
        continue
      }

      const jobs = new Map(
        listed.jobs.map((job) => [job.providerJobId, job]),
      )
      const activeDispatches = dispatchState.renderDispatches.filter(
        (dispatch) => (
          dispatch.status === 'creating' ||
          dispatch.status === 'unknown' ||
          dispatch.status === 'created'
        ),
      )
      let authoritative = true

      for (const dispatch of activeDispatches) {
        if (!dispatch.providerJobId || jobs.has(dispatch.providerJobId)) continue
        const observation = await withinProviderSettleDeadline(
          retrieveTaskDispatchProviderJob(dispatch.providerJobId, {
            signal: providerSettleController.signal,
          }),
          deadlineMs,
        )
        if (observation.outcome === 'found') {
          jobs.set(observation.job.providerJobId, observation.job)
        } else {
          authoritative = false
          lastReason = observation.outcome === 'unknown'
            ? `Render job retrieval was not authoritative (${observation.errorCode}).`
            : 'A durable Render dispatch was not visible from the provider yet.'
        }
      }

      const providerlessActiveDispatches = activeDispatches.filter(
        (dispatch) => !dispatch.providerJobId,
      ).length
      if (providerlessActiveDispatches > 0) {
        // Exact jobs from the listing are still cancelled below, but an
        // ambiguous durable launch is never treated as proof that every
        // provider execution is terminal. Preserve the rows for late workers.
        authoritative = false
        lastReason = 'A provider launch is still ambiguous.'
      }

      const liveJobs = Array.from(jobs.values()).filter((job) =>
        providerJobIsLive(job.status))
      for (const job of jobs.values()) {
        observedProviderJobs.add(job.providerJobId)
      }

      if (input.cancelLiveJobs) {
        for (const job of liveJobs) {
          if (cancellationAttempted.has(job.providerJobId)) continue
          cancellationAttempted.add(job.providerJobId)
          const cancellation = await withinProviderSettleDeadline(
            cancelTaskDispatchProviderJob(job.providerJobId, {
              signal: providerSettleController.signal,
            }),
            deadlineMs,
          )
          if (cancellation.outcome === 'accepted') {
            cancellationAccepted.add(job.providerJobId)
          } else if (cancellation.outcome === 'unknown') {
            lastReason = `Render job cancellation was not authoritative (${cancellation.errorCode}).`
          } else {
            // A 404 can be eventual provider state. Require a subsequent
            // authoritative list/retrieve cycle before deleting durable rows.
            lastReason = 'A Render job disappeared while cancellation was requested.'
          }
        }
      }

      if (
        authoritative &&
        liveJobs.length === 0 &&
        Date.now() >= cleanNotBeforeMs
      ) {
        cleanObservations += 1
        if (
          cleanObservations >=
            PROVIDER_SETTLE_REQUIRED_CLEAN_OBSERVATIONS
        ) {
          clearTimeout(providerSettleTimeout)
          return {
            safeToCleanup: true,
            observedProviderJobs: observedProviderJobs.size,
            cancellationAccepted: cancellationAccepted.size,
            reason: null,
          }
        }
      } else {
        cleanObservations = 0
        if (liveJobs.length > 0) {
          lastReason = input.cancelLiveJobs
            ? 'Render is still stopping the one-off job.'
            : 'The successful one-off job has not exited yet.'
        }
      }
    } catch (error) {
      cleanObservations = 0
      lastReason = error instanceof Error ? error.message : String(error)
    }

    await sleep(PROVIDER_SETTLE_POLL_MS)
  }

  clearTimeout(providerSettleTimeout)
  return {
    safeToCleanup: false,
    observedProviderJobs: observedProviderJobs.size,
    cancellationAccepted: cancellationAccepted.size,
    reason: lastReason,
  }
}

async function cleanupProbeRowsSafely(input: {
  userId: string
  runId: string
  startedAtMs: number
  onDemandDispatch: boolean
  cancelLiveProviderJobs: boolean
}): Promise<ProbeCleanupResult> {
  const settlement = input.onDemandDispatch
    ? await settleOnDemandProviderJobs({
        runId: input.runId,
        startedAtMs: input.startedAtMs,
        cancelLiveJobs: input.cancelLiveProviderJobs,
      })
    : {
        safeToCleanup: true,
        observedProviderJobs: 0,
        cancellationAccepted: 0,
        reason: null,
      }
  if (!settlement.safeToCleanup) {
    // Keeping the terminal task and dispatch rows is intentional. A late
    // one-off worker then observes a terminal target and exits cleanly instead
    // of treating a deleted target as a restartable infrastructure failure.
    return { ...settlement, cleanedUp: false }
  }
  return {
    ...settlement,
    cleanedUp: await cleanupProbeRows(input.userId, input.runId),
  }
}

async function cancelAndCleanupProbe(input: {
  userId: string
  runId: string
  startedAtMs: number
  onDemandDispatch: boolean
}): Promise<ProbeCleanupResult> {
  const { userId, runId } = input
  await cancelTaskJob(userId, runId).catch((error) => {
    console.error('[BackgroundWorkerSmoke] Probe cancellation failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return cleanupProbeRowsSafely({
    ...input,
    cancelLiveProviderJobs: true,
  })
}

async function collectStreamEvents(input: {
  userId: string
  conversationId: string
  runId: string
  afterSeq?: number
  timeoutMs: number
  stopWhen: (event: SSEEvent) => boolean
}): Promise<{ events: SSEEvent[]; lastSeq: number; timedOut: boolean }> {
  const abort = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, input.timeoutMs)

  const stream = createTaskJobEventStream({
    userId: input.userId,
    conversationId: input.conversationId,
    runId: input.runId,
    afterSeq: input.afterSeq,
    signal: abort.signal,
  })
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: SSEEvent[] = []
  let buffer = ''
  let lastSeq = Math.max(0, input.afterSeq || 0)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\n\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const event = parseSSE(block)
        if (!event) continue
        events.push(event)
        if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq)
        if (input.stopWhen(event)) {
          abort.abort()
          return { events, lastSeq, timedOut }
        }
      }
    }
  } finally {
    clearTimeout(timeout)
    await reader.cancel().catch(() => undefined)
  }

  return { events, lastSeq, timedOut }
}

export async function GET(request: NextRequest) {
  if (!verifyInternalSignature(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (process.env.AGENT_TASK_WORKER_MODE?.trim() !== 'external') {
    return NextResponse.json({ ok: false, error: 'AGENT_TASK_WORKER_MODE must be external.' }, { status: 409 })
  }

  const onDemandDispatch = usesOnDemandTaskDispatch()
  if (onDemandDispatch) {
    const coordinatorStatus = getTaskExecutionCoordinatorStatus()
    if (!coordinatorStatus.configured || !coordinatorStatus.workflowConfigured) {
      return NextResponse.json({
        ok: false,
        error: 'On-demand task execution is not configured.',
        missing: coordinatorStatus.missing,
        invalid: coordinatorStatus.invalid,
      }, { status: 503 })
    }
  }

  let workers: Awaited<ReturnType<typeof getRecentTaskWorkerHeartbeats>> = []
  let cloudCapableWorkers: typeof workers = []
  const expectedDeploymentVersion = env('AGENT_DEPLOYMENT_VERSION') || null
  const requireDeploymentVersion = envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')
  const requireHostedWorker = envBoolEnabled('AGENT_REQUIRE_HOSTED_TASK_WORKER', false)
  if (!onDemandDispatch) {
    const staleMs = envPositiveInt('AGENT_TASK_WORKER_STALE_MS', 60_000)
    workers = await getRecentTaskWorkerHeartbeats(staleMs)
    if (workers.length === 0) {
      return NextResponse.json({ ok: false, error: 'No live background worker heartbeat found.' }, { status: 503 })
    }
    cloudCapableWorkers = workers.filter((worker) =>
      isCloudCapableWorker(worker, expectedDeploymentVersion, requireDeploymentVersion))
    const e2bCapableWorkers = workers.filter((worker) =>
      isE2BCapableWorker(worker, expectedDeploymentVersion, requireDeploymentVersion))
    const acceptedWorkers = requireHostedWorker ? cloudCapableWorkers : e2bCapableWorkers
    if (acceptedWorkers.length === 0) {
      const localOnlyWorkerHosts = e2bCapableWorkers
        .filter((worker) => isLikelyLocalWorkerHostname(worker.hostname))
        .map((worker) => worker.hostname)
      const error = requireHostedWorker && localOnlyWorkerHosts.length > 0
        ? `Only local E2B background worker heartbeats were found (${localOnlyWorkerHosts.join(', ')}). Start a hosted worker before running this smoke.`
        : requireDeploymentVersion
        ? `No task worker heartbeat matched AGENT_DEPLOYMENT_VERSION="${expectedDeploymentVersion}".`
        : 'No hosted E2B task worker heartbeat found.'
      return NextResponse.json({ ok: false, error }, { status: 503 })
    }
  }

  const runId = `background-smoke-${randomUUID()}`
  const userId = `internal-background-smoke-${randomUUID()}`
  const conversationId = `internal-background-smoke-${randomUUID()}`
  const startedAt = Date.now()

  let coordinatorDispatch: {
    dispatchId: string
    backend: string
    providerJobId: string
  } | null = null
  if (onDemandDispatch) {
    try {
      const coordinator = await startTaskExecutionCoordinator(runId)
      coordinatorDispatch = {
        dispatchId: `coordinator:${runId}`,
        backend: 'vercel-workflow',
        providerJobId: coordinator.workflowRunId,
      }
    } catch (error) {
      console.error('[BackgroundWorkerSmoke] On-demand task coordinator failed to start', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json({
        ok: false,
        error: 'The on-demand task coordinator could not start.',
      }, { status: 503 })
    }
  }

  await enqueueTaskJob({
    runId,
    userId,
    conversationId,
    payload: {
      kind: 'background_probe',
      delayMs: PROBE_DELAY_MS,
      message: `queue=${taskQueueName()}`,
    },
    coordinatorDispatch,
    intakeAdmission: 'signed_internal_probe',
  })

  const discoveredJob = await findActiveTaskJobForConversation(userId, conversationId)
  if (discoveredJob?.runId !== runId) {
    const cleanup = await cancelAndCleanupProbe({
      userId,
      runId,
      startedAtMs: startedAt,
      onDemandDispatch,
    })
    return NextResponse.json({
      ok: false,
      error: 'Durable active-run discovery could not find the queued probe.',
      runId,
      queueName: taskQueueName(),
      cleanedUp: cleanup.cleanedUp,
      providerExecutionStopped: cleanup.safeToCleanup,
      providerCleanupReason: cleanup.reason,
      discoveredRunId: discoveredJob?.runId || null,
      durationMs: Date.now() - startedAt,
    }, { status: 502 })
  }

  let first = await collectStreamEvents({
    userId,
    conversationId,
    runId,
    timeoutMs: FIRST_VIEWER_TIMEOUT_MS,
    stopWhen: (event) => event.type === 'text_delta' && event.content.includes('__background_probe_start__'),
  })
  let sawStart = first.events.some((event) =>
    event.type === 'text_delta' &&
    event.content.includes('__background_probe_start__'))
  let coldStartGraceUsed = false
  let coldStartState: string | null = null
  if (!sawStart && onDemandDispatch) {
    let coldStartMayStillBeProgressing = true
    try {
      const state = await inspectTaskExecutionDispatchState(runId)
      coldStartState = state.state
      coldStartMayStillBeProgressing = (
        !state.cancelRequested &&
        (
          state.state === 'queued' ||
          state.state === 'running' ||
          state.state === 'stale'
        )
      )
    } catch (error) {
      // A transient control-plane read must not cause destructive cleanup while
      // a paid one-off job can still be booting. The additional wait is finite.
      console.warn('[BackgroundWorkerSmoke] Cold-start state inspection failed', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (coldStartMayStillBeProgressing) {
      coldStartGraceUsed = true
      const coldStart = await collectStreamEvents({
        userId,
        conversationId,
        runId,
        afterSeq: first.lastSeq,
        timeoutMs: ON_DEMAND_COLD_START_GRACE_MS,
        stopWhen: (event) => (
          event.type === 'text_delta' &&
          event.content.includes('__background_probe_start__')
        ),
      })
      first = {
        events: [...first.events, ...coldStart.events],
        lastSeq: coldStart.lastSeq,
        timedOut: coldStart.timedOut,
      }
      sawStart = first.events.some((event) =>
        event.type === 'text_delta' &&
        event.content.includes('__background_probe_start__'))
    }
  }

  if (!sawStart) {
    const cleanup = await cancelAndCleanupProbe({
      userId,
      runId,
      startedAtMs: startedAt,
      onDemandDispatch,
    })
    return NextResponse.json({
      ok: false,
      error: first.timedOut ? 'Timed out waiting for worker to claim the probe.' : 'Worker stream ended before probe start.',
      runId,
      queueName: taskQueueName(),
      workerCount: workers.length,
      hostedWorkerCount: cloudCapableWorkers.length,
      executorMode: onDemandDispatch ? 'render_job' : 'persistent_worker',
      activeDiscovery: true,
      cleanedUp: cleanup.cleanedUp,
      providerExecutionStopped: cleanup.safeToCleanup,
      providerJobsObserved: cleanup.observedProviderJobs,
      providerCancellationsAccepted: cleanup.cancellationAccepted,
      providerCleanupReason: cleanup.reason,
      coldStartGraceUsed,
      coldStartState,
      firstViewerEvents: first.events.map(eventSummary),
      durationMs: Date.now() - startedAt,
    }, { status: 504 })
  }

  const reconnected = await collectStreamEvents({
    userId,
    conversationId,
    runId,
    afterSeq: first.lastSeq,
    timeoutMs: RECONNECT_TIMEOUT_MS,
    stopWhen: (event) => event.type === 'done' || event.type === 'error',
  })

  const errors = reconnected.events.filter((event) => event.type === 'error')
  const sawFinish = reconnected.events.some((event) => event.type === 'text_delta' && event.content.includes('__background_probe_finish__'))
  const sawDone = reconnected.events.some((event) => event.type === 'done')

  if (errors.length > 0 || !sawFinish || !sawDone) {
    const cleanup = await cancelAndCleanupProbe({
      userId,
      runId,
      startedAtMs: startedAt,
      onDemandDispatch,
    })
    return NextResponse.json({
      ok: false,
      error: errors[0]?.type === 'error' ? errors[0].message : 'Reconnected stream did not replay worker completion.',
      runId,
      queueName: taskQueueName(),
      activeDiscovery: true,
      workerCount: workers.length,
      hostedWorkerCount: cloudCapableWorkers.length,
      executorMode: onDemandDispatch ? 'render_job' : 'persistent_worker',
      cleanedUp: cleanup.cleanedUp,
      providerExecutionStopped: cleanup.safeToCleanup,
      providerJobsObserved: cleanup.observedProviderJobs,
      providerCancellationsAccepted: cleanup.cancellationAccepted,
      providerCleanupReason: cleanup.reason,
      coldStartGraceUsed,
      coldStartState,
      firstViewerLastSeq: first.lastSeq,
      firstViewerEvents: first.events.map(eventSummary),
      reconnectedEvents: reconnected.events.map(eventSummary),
      durationMs: Date.now() - startedAt,
    }, { status: 502 })
  }

  const cleanup = await cleanupProbeRowsSafely({
    userId,
    runId,
    startedAtMs: startedAt,
    onDemandDispatch,
    cancelLiveProviderJobs: false,
  })

  return NextResponse.json({
    ok: true,
    runId,
    queueName: taskQueueName(),
    workerCount: workers.length,
    hostedWorkerCount: cloudCapableWorkers.length,
    executorMode: onDemandDispatch ? 'render_job' : 'persistent_worker',
    activeDiscovery: true,
    cleanedUp: cleanup.cleanedUp,
    providerExecutionStopped: cleanup.safeToCleanup,
    providerJobsObserved: cleanup.observedProviderJobs,
    providerCleanupReason: cleanup.reason,
    coldStartGraceUsed,
    coldStartState,
    workers: workers.map((worker) => ({
      workerId: worker.workerId,
      status: worker.status,
      currentRunId: worker.currentRunId,
      lastSeenAtMs: worker.lastSeenAtMs,
      hostname: worker.hostname,
      taskWorkerMode: worker.taskWorkerMode,
      sandboxProvider: worker.sandboxProvider,
      deploymentVersion: worker.deploymentVersion,
      orchestrationProtocolVersion: worker.orchestrationProtocolVersion,
    })),
    firstViewerLastSeq: first.lastSeq,
    firstViewerEvents: first.events.map(eventSummary),
    reconnectedEvents: reconnected.events.map(eventSummary),
    durationMs: Date.now() - startedAt,
  })
}
