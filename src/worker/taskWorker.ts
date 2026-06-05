import { randomUUID } from 'crypto'
import { runChatTaskJob, type BackgroundProbeTaskPayload, type TaskJobPayload } from '@/lib/agent/chatTaskRunner'
import { claimNextTaskJob, runClaimedTaskJob } from '@/lib/agent/taskJobs'
import { taskQueueName } from '@/lib/agent/taskQueue'
import { markTaskWorkerStopped, recordTaskWorkerHeartbeat } from '@/lib/agent/taskWorkerHeartbeat'
import { getTursoSetupStatus } from '@/lib/db/turso'
import {
  destroyE2BSandbox,
  ensureE2BRemoteBrowser,
  executeCommandInE2B,
  getOrCreateE2BSandbox,
} from '@/lib/e2bSandbox'
import type { AgentEventEmitter } from '@/lib/agent/SSEEmitter'

interface TaskWorkerOptions {
  once?: boolean
}

const DEFAULT_WORKER_POLL_MS = 1_500
const DEFAULT_WORKER_HEARTBEAT_MS = 15_000

function finitePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function env(name: string): string {
  return process.env[name]?.trim() || ''
}

function envBool(name: string): boolean {
  const value = env(name).toLowerCase()
  return value === 'true' || value === '1'
}

function validateWorkerRuntimeConfig(): void {
  if (env('AGENT_TASK_WORKER_MODE') !== 'external') {
    throw new Error('Task worker requires AGENT_TASK_WORKER_MODE=external.')
  }

  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() !== 'e2b') return

  if (!env('E2B_API_KEY')) {
    throw new Error('Task worker is configured for AGENT_SANDBOX_PROVIDER=e2b but E2B_API_KEY is missing.')
  }

  if (!env('E2B_TEMPLATE_ID') && !env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')) {
    throw new Error('Task worker is configured for E2B but no E2B_TEMPLATE_ID or AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND is set.')
  }
}

async function verifyE2BWorkerStartup(): Promise<void> {
  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() !== 'e2b') return
  if (!envBool('AGENT_E2B_VERIFY_ON_WORKER_STARTUP')) return

  const conversationId = `worker-startup-${randomUUID()}`
  try {
    await getOrCreateE2BSandbox(conversationId)
    const result = await executeCommandInE2B(conversationId, 'printf worker-e2b-ready')
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `E2B startup command exited ${result.exitCode}`)
    }

    if (envBool('AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP')) {
      await ensureE2BRemoteBrowser(conversationId)
    }
  } finally {
    await destroyE2BSandbox(conversationId).catch((error) => {
      console.warn('[TaskWorker] E2B startup probe cleanup failed', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBackgroundProbeTaskPayload(payload: TaskJobPayload): payload is BackgroundProbeTaskPayload {
  return payload.kind === 'background_probe'
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Probe aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Probe aborted'))
    }, { once: true })
  })
}

async function runBackgroundProbeTaskJob(
  payload: BackgroundProbeTaskPayload,
  emitter: AgentEventEmitter,
  signal: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(30_000, Math.max(0, Math.round(payload.delayMs || 0)))
  emitter.plan(['Worker claimed the background probe', 'Viewer disconnect is simulated', 'Worker completes after the disconnect'])
  emitter.textDelta(`__background_probe_start__ ${payload.message || 'worker claimed probe'}\n`)
  emitter.heartbeat()
  await sleepWithAbort(delayMs, signal)
  emitter.textDelta('__background_probe_finish__ worker completed after viewer disconnect\n')
  emitter.done()
}

export async function runTaskWorker(options: TaskWorkerOptions = {}): Promise<void> {
  validateWorkerRuntimeConfig()

  const turso = getTursoSetupStatus()
  if (!turso.configured) {
    throw new Error(`Task worker requires Turso. Missing: ${turso.missing.join(', ')}`)
  }
  await verifyE2BWorkerStartup()

  const workerId = process.env.AGENT_TASK_WORKER_ID?.trim() || `worker-${randomUUID()}`
  const queueName = taskQueueName()
  const pollMs = finitePositiveInt(process.env.AGENT_TASK_WORKER_POLL_MS, DEFAULT_WORKER_POLL_MS)
  const heartbeatMs = finitePositiveInt(process.env.AGENT_TASK_WORKER_HEARTBEAT_MS, DEFAULT_WORKER_HEARTBEAT_MS)
  const workerCapabilities = {
    taskWorkerMode: env('AGENT_TASK_WORKER_MODE') || null,
    sandboxProvider: env('AGENT_SANDBOX_PROVIDER') || null,
    deploymentVersion: env('AGENT_DEPLOYMENT_VERSION') || null,
    e2bApiKeyConfigured: Boolean(env('E2B_API_KEY')),
    e2bBrowserRuntimeConfigured: Boolean(env('E2B_TEMPLATE_ID') || env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')),
    e2bPauseOnTaskEnd: envBool('AGENT_E2B_PAUSE_ON_TASK_END'),
  }
  const startedAtMs = Date.now()
  let currentRunId: string | null = null
  let completedTasks = 0
  let stopping = false
  const shutdownController = new AbortController()

  const sendHeartbeat = (status: 'starting' | 'idle' | 'running' | 'stopping' | 'stopped') =>
    recordTaskWorkerHeartbeat({
      workerId,
      queueName,
      startedAtMs,
      pollMs,
      heartbeatMs,
      status,
      currentRunId,
      completedTasks,
      ...workerCapabilities,
    }).catch((error) => {
      console.error('[TaskWorker] Heartbeat failed', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })

  const stop = () => {
    stopping = true
    shutdownController.abort()
    void sendHeartbeat('stopping')
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat(currentRunId ? 'running' : 'idle')
  }, heartbeatMs)
  heartbeatTimer.unref?.()

  await sendHeartbeat('starting')

  console.log('[TaskWorker] Started', { workerId, queueName, pollMs, heartbeatMs, once: options.once === true })

  try {
    while (!stopping) {
      const claim = await claimNextTaskJob(workerId)
      if (!claim) {
        if (options.once) break
        await sleep(pollMs)
        continue
      }

      console.log('[TaskWorker] Claimed task', {
        runId: claim.runId,
        conversationId: claim.conversationId,
        attempts: claim.attempts,
      })

      currentRunId = claim.runId
      await sendHeartbeat('running')

      const taskResult = await runClaimedTaskJob(claim, (emitter, signal) => {
        if (isBackgroundProbeTaskPayload(claim.payload)) {
          return runBackgroundProbeTaskJob(claim.payload, emitter, signal)
        }

        return runChatTaskJob({
          ...claim.payload,
          emitter,
          signal,
          conversationId: claim.conversationId,
          userId: claim.userId,
          creditRunId: claim.runId,
        })
      }, { shutdownSignal: shutdownController.signal })

      if (taskResult === 'requeued') {
        currentRunId = null
        await sendHeartbeat('stopping')
        console.log('[TaskWorker] Released task claim during shutdown', {
          runId: claim.runId,
          conversationId: claim.conversationId,
        })
        break
      }

      completedTasks += 1
      currentRunId = null
      await sendHeartbeat('idle')

      console.log('[TaskWorker] Finished task', {
        runId: claim.runId,
        conversationId: claim.conversationId,
      })

      if (options.once) break
    }
  } finally {
    clearInterval(heartbeatTimer)
    currentRunId = null
    await markTaskWorkerStopped(workerId).catch((error) => {
      console.error('[TaskWorker] Failed to mark worker stopped', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    console.log('[TaskWorker] Stopped', { workerId })
  }
}
