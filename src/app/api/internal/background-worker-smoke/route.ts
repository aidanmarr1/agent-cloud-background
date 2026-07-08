import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  cancelTaskJob,
  cleanupInternalTaskJob,
  enqueueTaskJob,
  createTaskJobEventStream,
  findActiveTaskJobForConversation,
} from '@/lib/agent/taskJobs'
import { taskQueueName } from '@/lib/agent/taskQueue'
import { getRecentTaskWorkerHeartbeats, isLikelyLocalWorkerHostname, workerHeartbeatIsHosted } from '@/lib/agent/taskWorkerHeartbeat'
import { parseSSE } from '@/lib/stream'
import type { SSEEvent } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/background-worker-smoke'
const FIRST_VIEWER_TIMEOUT_MS = 45_000
const RECONNECT_TIMEOUT_MS = 60_000
const PROBE_DELAY_MS = 2_500
const CLEANUP_RETRY_MS = 100
const CLEANUP_RETRIES = 30

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
  hostname?: string | null
  taskWorkerMode?: string | null
  sandboxProvider?: string | null
  deploymentVersion?: string | null
  e2bApiKeyConfigured?: boolean | null
  e2bBrowserRuntimeConfigured?: boolean | null
}, expectedDeploymentVersion: string | null, requireDeploymentVersion: boolean): boolean {
  const versionMatches = !requireDeploymentVersion ||
    (!!expectedDeploymentVersion && worker.deploymentVersion === expectedDeploymentVersion)

  return worker.taskWorkerMode === 'external' &&
    worker.sandboxProvider === 'e2b' &&
    worker.e2bApiKeyConfigured === true &&
    worker.e2bBrowserRuntimeConfigured === true &&
    workerHeartbeatIsHosted(worker) &&
    versionMatches
}

function isE2BCapableWorker(worker: {
  taskWorkerMode?: string | null
  sandboxProvider?: string | null
  deploymentVersion?: string | null
  e2bApiKeyConfigured?: boolean | null
  e2bBrowserRuntimeConfigured?: boolean | null
}, expectedDeploymentVersion: string | null, requireDeploymentVersion: boolean): boolean {
  const versionMatches = !requireDeploymentVersion ||
    (!!expectedDeploymentVersion && worker.deploymentVersion === expectedDeploymentVersion)

  return worker.taskWorkerMode === 'external' &&
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

async function cancelAndCleanupProbe(userId: string, runId: string): Promise<boolean> {
  await cancelTaskJob(userId, runId).catch((error) => {
    console.error('[BackgroundWorkerSmoke] Probe cancellation failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return cleanupProbeRows(userId, runId)
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

  const staleMs = envPositiveInt('AGENT_TASK_WORKER_STALE_MS', 60_000)
  const workers = await getRecentTaskWorkerHeartbeats(staleMs)
  if (workers.length === 0) {
    return NextResponse.json({ ok: false, error: 'No live background worker heartbeat found.' }, { status: 503 })
  }
  const expectedDeploymentVersion = env('AGENT_DEPLOYMENT_VERSION') || null
  const requireDeploymentVersion = envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')
  const requireHostedWorker = envBoolEnabled('AGENT_REQUIRE_HOSTED_TASK_WORKER', true)
  const cloudCapableWorkers = workers.filter((worker) =>
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

  const runId = `background-smoke-${randomUUID()}`
  const userId = `internal-background-smoke-${randomUUID()}`
  const conversationId = `internal-background-smoke-${randomUUID()}`
  const startedAt = Date.now()

  await enqueueTaskJob({
    runId,
    userId,
    conversationId,
    payload: {
      kind: 'background_probe',
      delayMs: PROBE_DELAY_MS,
      message: `queue=${taskQueueName()}`,
    },
  })

  const discoveredJob = await findActiveTaskJobForConversation(userId, conversationId)
  if (discoveredJob?.runId !== runId) {
    const cleanedUp = await cancelAndCleanupProbe(userId, runId)
    return NextResponse.json({
      ok: false,
      error: 'Durable active-run discovery could not find the queued probe.',
      runId,
      queueName: taskQueueName(),
      cleanedUp,
      discoveredRunId: discoveredJob?.runId || null,
      durationMs: Date.now() - startedAt,
    }, { status: 502 })
  }

  const first = await collectStreamEvents({
    userId,
    conversationId,
    runId,
    timeoutMs: FIRST_VIEWER_TIMEOUT_MS,
    stopWhen: (event) => event.type === 'text_delta' && event.content.includes('__background_probe_start__'),
  })
  const sawStart = first.events.some((event) => event.type === 'text_delta' && event.content.includes('__background_probe_start__'))
  if (!sawStart) {
    const cleanedUp = await cancelAndCleanupProbe(userId, runId)
    return NextResponse.json({
      ok: false,
      error: first.timedOut ? 'Timed out waiting for worker to claim the probe.' : 'Worker stream ended before probe start.',
      runId,
      queueName: taskQueueName(),
      workerCount: workers.length,
      hostedWorkerCount: cloudCapableWorkers.length,
      activeDiscovery: true,
      cleanedUp,
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
    const cleanedUp = await cancelAndCleanupProbe(userId, runId)
    return NextResponse.json({
      ok: false,
      error: errors[0]?.type === 'error' ? errors[0].message : 'Reconnected stream did not replay worker completion.',
      runId,
      queueName: taskQueueName(),
      activeDiscovery: true,
      workerCount: workers.length,
      hostedWorkerCount: cloudCapableWorkers.length,
      cleanedUp,
      firstViewerLastSeq: first.lastSeq,
      firstViewerEvents: first.events.map(eventSummary),
      reconnectedEvents: reconnected.events.map(eventSummary),
      durationMs: Date.now() - startedAt,
    }, { status: 502 })
  }

  const cleanedUp = await cleanupProbeRows(userId, runId)

  return NextResponse.json({
    ok: true,
    runId,
    queueName: taskQueueName(),
    workerCount: workers.length,
    hostedWorkerCount: cloudCapableWorkers.length,
    activeDiscovery: true,
    cleanedUp,
    workers: workers.map((worker) => ({
      workerId: worker.workerId,
      status: worker.status,
      currentRunId: worker.currentRunId,
      lastSeenAtMs: worker.lastSeenAtMs,
      hostname: worker.hostname,
      taskWorkerMode: worker.taskWorkerMode,
      sandboxProvider: worker.sandboxProvider,
      deploymentVersion: worker.deploymentVersion,
    })),
    firstViewerLastSeq: first.lastSeq,
    firstViewerEvents: first.events.map(eventSummary),
    reconnectedEvents: reconnected.events.map(eventSummary),
    durationMs: Date.now() - startedAt,
  })
}
