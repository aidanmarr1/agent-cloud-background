import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { shouldUseExternalTaskWorker } from '@/lib/agent/taskJobs'
import { taskQueueName } from '@/lib/agent/taskQueue'
import { getRecentTaskWorkerHeartbeats, isLikelyLocalWorkerHostname, workerHeartbeatIsHosted } from '@/lib/agent/taskWorkerHeartbeat'
import { getTursoClient, getTursoSetupStatus } from '@/lib/db/turso'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/background-worker-ready'

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

function env(name: string): string {
  return process.env[name]?.trim() || ''
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envBoolEnabled(name: string, fallback = true): boolean {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value !== 'false' && value !== '0'
}

function envBoolExact(name: string, fallback = false): boolean {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value === 'true' || value === '1'
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

export async function GET(request: NextRequest) {
  if (!verifyInternalSignature(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const checks: Record<string, boolean> = {}
  const errors: string[] = []
  const warnings: string[] = []

  const queueName = taskQueueName()
  const turso = getTursoSetupStatus()
  checks.externalWorkerMode = env('AGENT_TASK_WORKER_MODE') === 'external'
  checks.persistentQueueConfigured = shouldUseExternalTaskWorker()
  checks.tursoEnvConfigured = turso.configured
  checks.workerHeartbeatRequired = envBoolEnabled('AGENT_REQUIRE_TASK_WORKER_HEARTBEAT', true)
  checks.e2bProviderEnabled = env('AGENT_SANDBOX_PROVIDER').toLowerCase() === 'e2b'
  checks.e2bApiKeyConfigured = Boolean(env('E2B_API_KEY'))
  checks.e2bBrowserRuntimeConfigured = Boolean(env('E2B_TEMPLATE_ID') || env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND'))
  checks.e2bFreshTaskReset = envBoolExact('AGENT_E2B_KILL_ON_RESET', true)
  checks.e2bWarmPoolDisabled = !envBoolExact('AGENT_E2B_WARM_POOL_ENABLED', false)
  const expectedDeploymentVersion = env('AGENT_DEPLOYMENT_VERSION') || null
  const requireDeploymentVersion = envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION', false)
  const requireHostedWorker = envBoolEnabled('AGENT_REQUIRE_HOSTED_TASK_WORKER', false)
  checks.workerDeploymentVersionRequired = requireDeploymentVersion
  checks.workerDeploymentVersionConfigured = Boolean(expectedDeploymentVersion)
  checks.hostedWorkerRequired = requireHostedWorker

  if (!checks.externalWorkerMode) errors.push('AGENT_TASK_WORKER_MODE must be external.')
  if (!checks.persistentQueueConfigured) errors.push('Persistent Turso task queue is not configured.')
  if (!checks.e2bProviderEnabled) errors.push('AGENT_SANDBOX_PROVIDER must be e2b.')
  if (!checks.e2bApiKeyConfigured) errors.push('E2B_API_KEY must be set.')
  if (!checks.e2bBrowserRuntimeConfigured) errors.push('E2B_TEMPLATE_ID or AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND must be set.')
  if (!checks.e2bFreshTaskReset) errors.push('AGENT_E2B_KILL_ON_RESET must be true so each task starts from a fresh sandbox.')
  if (!checks.e2bWarmPoolDisabled) errors.push('AGENT_E2B_WARM_POOL_ENABLED must be false so tasks do not reuse warm sandboxes.')
  if (requireDeploymentVersion && !expectedDeploymentVersion) errors.push('AGENT_DEPLOYMENT_VERSION must be set when AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true.')
  if (!checks.workerHeartbeatRequired) warnings.push('AGENT_REQUIRE_TASK_WORKER_HEARTBEAT is disabled; tasks may queue without a live worker.')

  let tursoConnected = false
  if (turso.configured) {
    try {
      const result = await getTursoClient().execute('select 1 as ok')
      tursoConnected = result.rows.length >= 1
    } catch (error) {
      errors.push(`Turso connection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    errors.push(`Missing Turso env: ${turso.missing.join(', ')}`)
  }
  checks.tursoConnected = tursoConnected

  const staleMs = envPositiveInt('AGENT_TASK_WORKER_STALE_MS', 60_000)
  let workers: Array<{
    workerId: string
    status: string
    currentRunId: string | null
    lastSeenAtMs: number
    completedTasks: number
    hostname: string
    taskWorkerMode: string | null
    sandboxProvider: string | null
    deploymentVersion: string | null
    e2bApiKeyConfigured: boolean
    e2bBrowserRuntimeConfigured: boolean
    e2bPauseOnTaskEnd: boolean
  }> = []

  if (tursoConnected) {
    try {
      workers = (await getRecentTaskWorkerHeartbeats(staleMs)).map((worker) => ({
        workerId: worker.workerId,
        status: worker.status,
        currentRunId: worker.currentRunId,
        lastSeenAtMs: worker.lastSeenAtMs,
        completedTasks: worker.completedTasks,
        hostname: worker.hostname,
        taskWorkerMode: worker.taskWorkerMode,
        sandboxProvider: worker.sandboxProvider,
        deploymentVersion: worker.deploymentVersion,
        e2bApiKeyConfigured: worker.e2bApiKeyConfigured,
        e2bBrowserRuntimeConfigured: worker.e2bBrowserRuntimeConfigured,
        e2bPauseOnTaskEnd: worker.e2bPauseOnTaskEnd,
      }))
    } catch (error) {
      errors.push(`Worker heartbeat lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const cloudCapableWorkers = workers.filter((worker) =>
    isCloudCapableWorker(worker, expectedDeploymentVersion, requireDeploymentVersion))
  const e2bCapableWorkers = workers.filter((worker) =>
    isE2BCapableWorker(worker, expectedDeploymentVersion, requireDeploymentVersion))
  const acceptedWorkers = requireHostedWorker ? cloudCapableWorkers : e2bCapableWorkers
  const localOnlyWorkerHosts = e2bCapableWorkers
    .filter((worker) => isLikelyLocalWorkerHostname(worker.hostname))
    .map((worker) => worker.hostname)
  checks.liveWorkerHeartbeat = workers.length > 0
  checks.liveCloudWorkerHeartbeat = acceptedWorkers.length > 0
  checks.liveHostedWorkerHeartbeat = cloudCapableWorkers.length > 0
  if (workers.length === 0) {
    errors.push(`No live worker heartbeat found for queue "${queueName}" in the last ${staleMs}ms.`)
  } else if (requireHostedWorker && e2bCapableWorkers.length > 0 && cloudCapableWorkers.length === 0) {
    errors.push(`Only local E2B worker heartbeats were found for queue "${queueName}" (${localOnlyWorkerHosts.join(', ')}). Start a hosted E2B background worker so tasks can continue when this Mac is offline.`)
  } else if (!requireHostedWorker && e2bCapableWorkers.length > 0 && cloudCapableWorkers.length === 0) {
    warnings.push(`Only local E2B worker heartbeats were found for queue "${queueName}" (${localOnlyWorkerHosts.join(', ')}). Tasks can run while this worker stays online, but they are not offline-safe.`)
  } else if (requireDeploymentVersion && acceptedWorkers.length === 0) {
    errors.push(`No live task worker heartbeat matched AGENT_DEPLOYMENT_VERSION="${expectedDeploymentVersion}" for queue "${queueName}". Redeploy the worker with the same AGENT_DEPLOYMENT_VERSION as the web service.`)
  } else if (acceptedWorkers.length === 0) {
    errors.push(`No hosted E2B task worker heartbeat found for queue "${queueName}". Redeploy the worker with AGENT_TASK_WORKER_MODE=external and AGENT_SANDBOX_PROVIDER=e2b.`)
  }

  const ok = errors.length === 0
  return NextResponse.json({
    ok,
    queueName,
    staleMs,
    checks,
    errors,
    warnings,
    workers,
    env: {
      taskWorkerMode: env('AGENT_TASK_WORKER_MODE') || null,
      storageDriver: env('AGENT_STORAGE_DRIVER') || null,
      sandboxProvider: env('AGENT_SANDBOX_PROVIDER') || null,
      deploymentVersion: expectedDeploymentVersion,
    },
  }, { status: ok ? 200 : 503 })
}
