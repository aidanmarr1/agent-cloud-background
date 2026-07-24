import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { runChatTaskJob, type BackgroundProbeTaskPayload, type TaskJobPayload } from '@/lib/agent/chatTaskRunner'
import {
  claimNextTaskJob,
  runClaimedTaskJob,
  TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS,
  TASK_WORKER_CANCEL_PROOF_JITTER_MS,
} from '@/lib/agent/taskJobs'
import { taskQueueName } from '@/lib/agent/taskQueue'
import { isLikelyLocalWorkerHostname, markTaskWorkerStopped, recordTaskWorkerHeartbeat } from '@/lib/agent/taskWorkerHeartbeat'
import { getTursoSetupStatus } from '@/lib/db/turso'
import {
  destroyWarmE2BSandbox,
  destroyE2BSandbox,
  ensureE2BRemoteBrowser,
  executeCommandInE2B,
  getOrCreateE2BSandbox,
  prewarmE2BSandbox,
} from '@/lib/e2bSandbox'
import type { AgentEventEmitter } from '@/lib/agent/SSEEmitter'
import { AGENT_WORKER_RUN_MAX_DURATION_MS } from '@/lib/agent/config'

interface TaskWorkerOptions {
  once?: boolean
}

const DEFAULT_WORKER_POLL_MS = 100
const DEFAULT_WORKER_HEARTBEAT_MS = 15_000
const DEFAULT_WORKER_MAX_IDLE_POLL_MS = 500
const DEFAULT_WORKER_HARD_EXIT_GRACE_MS = 30_000
const DEFAULT_WORKER_CANCEL_HARD_EXIT_MS = 5_000
const DEFAULT_WORKER_STALE_MS = 60_000

function finitePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function env(name: string): string {
  return process.env[name]?.trim() || ''
}

function envBoolDefault(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value === 'true' || value === '1'
}

function envBool(name: string): boolean {
  return envBoolDefault(name, false)
}

function e2bWarmPoolEnabled(): boolean {
  return env('AGENT_SANDBOX_PROVIDER').toLowerCase() === 'e2b' &&
    envBoolDefault('AGENT_E2B_WARM_POOL_ENABLED', false)
}

function startE2BWorkerWarmup(): Promise<void> {
  return Promise.resolve().then(() => prewarmE2BSandbox('worker-startup'))
}

function workerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateWorkerRuntimeConfig(): void {
  if (env('AGENT_TASK_WORKER_MODE') !== 'external') {
    throw new Error('Task worker requires AGENT_TASK_WORKER_MODE=external.')
  }

  if (envBoolDefault('AGENT_REQUIRE_HOSTED_TASK_WORKER', false) && isLikelyLocalWorkerHostname(hostname())) {
    throw new Error('Refusing to start a local task worker while AGENT_REQUIRE_HOSTED_TASK_WORKER is true.')
  }

  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() !== 'e2b') {
    throw new Error('Task worker requires AGENT_SANDBOX_PROVIDER=e2b.')
  }

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

async function preloadAgentRuntime(): Promise<void> {
  await import('@/lib/agent/AgentLoop')
}

function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, ms)
    const onAbort = () => cleanup()
    function cleanup() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isBackgroundProbeTaskPayload(payload: TaskJobPayload): payload is BackgroundProbeTaskPayload {
  return payload.kind === 'background_probe'
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Probe aborted'))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(), ms)
    const onAbort = () => finish(new Error('Probe aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
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

  const workerIdPrefix = process.env.AGENT_TASK_WORKER_ID?.trim() || 'worker'
  // The configured ID is a logical label, not a process identity. A boot UUID
  // prevents an old process from refreshing or releasing a replacement's claim.
  const workerId = `${workerIdPrefix}-${randomUUID()}`
  const queueName = taskQueueName()
  const pollMs = finitePositiveInt(process.env.AGENT_TASK_WORKER_POLL_MS, DEFAULT_WORKER_POLL_MS)
  const heartbeatMs = finitePositiveInt(process.env.AGENT_TASK_WORKER_HEARTBEAT_MS, DEFAULT_WORKER_HEARTBEAT_MS)
  const maxIdlePollMs = Math.max(
    pollMs,
    finitePositiveInt(process.env.AGENT_TASK_WORKER_MAX_IDLE_POLL_MS, DEFAULT_WORKER_MAX_IDLE_POLL_MS),
  )
  const hardTaskExitMs = finitePositiveInt(
    process.env.AGENT_WORKER_HARD_TASK_EXIT_MS,
    AGENT_WORKER_RUN_MAX_DURATION_MS + DEFAULT_WORKER_HARD_EXIT_GRACE_MS,
  )
  const cancelHardExitMs = finitePositiveInt(
    process.env.AGENT_WORKER_CANCEL_HARD_EXIT_MS,
    DEFAULT_WORKER_CANCEL_HARD_EXIT_MS,
  )
  const workerStaleMs = finitePositiveInt(
    process.env.AGENT_TASK_WORKER_STALE_MS,
    DEFAULT_WORKER_STALE_MS,
  )
  if (cancelHardExitMs > TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS) {
    throw new Error(`AGENT_WORKER_CANCEL_HARD_EXIT_MS must be at most ${TASK_WORKER_CANCEL_HARD_EXIT_MAX_MS}ms.`)
  }
  const minimumCancellationProofWindowMs = heartbeatMs + cancelHardExitMs + TASK_WORKER_CANCEL_PROOF_JITTER_MS
  if (workerStaleMs <= minimumCancellationProofWindowMs) {
    throw new Error(
      `AGENT_TASK_WORKER_STALE_MS must exceed heartbeat + cancellation hard-exit + jitter (${minimumCancellationProofWindowMs}ms).`,
    )
  }
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
  let runtimePreloadStarted = false
  let runtimePreloadFailure: unknown = null
  let runtimePreloadPromise: Promise<void> | null = null
  const shutdownController = new AbortController()

  const ensureAgentRuntimePreloaded = async () => {
    if (!runtimePreloadStarted) {
      runtimePreloadStarted = true
      runtimePreloadPromise = preloadAgentRuntime().catch((error) => {
        runtimePreloadFailure = error
        console.error('[TaskWorker] Agent runtime preload failed', {
          error: workerErrorMessage(error),
        })
      })
    }
    await runtimePreloadPromise
    if (runtimePreloadFailure) throw runtimePreloadFailure
  }

  type WorkerStatus = 'starting' | 'idle' | 'running' | 'stopping' | 'stopped'
  let desiredHeartbeatStatus: WorkerStatus = 'starting'
  let heartbeatWriteChain = Promise.resolve()
  const logHeartbeatError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[TaskWorker] Heartbeat failed', { workerId, error: message })
    if (/superseded by a newer process/i.test(message)) {
      stopping = true
      shutdownController.abort(error)
    }
  }
  const sendHeartbeat = (status: WorkerStatus, required = false): Promise<void> => {
    desiredHeartbeatStatus = status
    const attempt = heartbeatWriteChain.then(() => recordTaskWorkerHeartbeat({
      workerId,
      queueName,
      startedAtMs,
      pollMs,
      heartbeatMs,
      status: desiredHeartbeatStatus,
      currentRunId,
      completedTasks,
      ...workerCapabilities,
    }))
    heartbeatWriteChain = attempt.catch(logHeartbeatError)
    return required ? attempt : heartbeatWriteChain
  }

  const stop = () => {
    stopping = true
    shutdownController.abort()
    void sendHeartbeat('stopping')
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat(desiredHeartbeatStatus)
  }, heartbeatMs)
  heartbeatTimer.unref?.()

  try {
    await sendHeartbeat('starting', true)
    console.log('[TaskWorker] Starting', { workerId, queueName, pollMs, heartbeatMs, once: options.once === true })

    const warmPoolEnabled = e2bWarmPoolEnabled()
    const startupWarmupPromise = warmPoolEnabled
      ? startE2BWorkerWarmup()
      : verifyE2BWorkerStartup()
    try {
      await Promise.all([startupWarmupPromise, ensureAgentRuntimePreloaded()])
    } catch (error) {
      console.error('[TaskWorker] Startup readiness check failed', {
        error: workerErrorMessage(error),
      })
      throw error
    }
    if (warmPoolEnabled) console.log('[TaskWorker] Background E2B warmup ready')
    if (stopping) return
    await sendHeartbeat('idle', true)
    if (stopping) return
    console.log('[TaskWorker] Ready', { workerId, queueName })

    let idlePollMs = pollMs
    let consecutiveClaimFailures = 0
    while (!stopping) {
      let claim: Awaited<ReturnType<typeof claimNextTaskJob>>
      try {
        claim = await claimNextTaskJob(workerId)
        consecutiveClaimFailures = 0
      } catch (error) {
        consecutiveClaimFailures += 1
        console.error('[TaskWorker] Queue claim attempt failed', {
          consecutiveClaimFailures,
          error: workerErrorMessage(error),
        })
        if (consecutiveClaimFailures >= 5) throw error
        await sendHeartbeat('idle').catch(() => undefined)
        await sleepUntilAbort(Math.min(maxIdlePollMs, pollMs * (2 ** consecutiveClaimFailures)), shutdownController.signal)
        continue
      }
      if (!claim) {
        if (options.once) break
        await sleepUntilAbort(idlePollMs, shutdownController.signal)
        idlePollMs = Math.min(maxIdlePollMs, idlePollMs * 2)
        continue
      }
      idlePollMs = pollMs

      console.log('[TaskWorker] Claimed task', {
        runId: claim.runId,
        conversationId: claim.conversationId,
        attempts: claim.attempts,
      })

      currentRunId = claim.runId
      await sendHeartbeat('running')

      // Abort signals are cooperative; a provider SDK or tool handler can
      // ignore them forever. A claimed worker must eventually stop refreshing
      // its lease so another isolated process can recover the run.
      const hardExitTimer = setTimeout(() => {
        console.error('[TaskWorker] Hard task deadline exceeded; terminating process for fenced recovery', {
          runId: claim.runId,
          conversationId: claim.conversationId,
          attempts: claim.attempts,
          hardTaskExitMs,
        })
        process.exit(1)
      }, hardTaskExitMs)
      let cancellationHardExitTimer: ReturnType<typeof setTimeout> | null = null
      const armCancellationHardExit = () => {
        if (cancellationHardExitTimer) return
        // Publish observation before arming the dedicated-process kill. Remote
        // finalizers treat this exact boot/run heartbeat as live until it goes
        // stale, so a DB terminal can never race ahead of the worker hard stop.
        void sendHeartbeat('stopping')
        cancellationHardExitTimer = setTimeout(() => {
          console.error('[TaskWorker] Cancellation deadline exceeded; terminating process to stop late side effects', {
            runId: claim.runId,
            conversationId: claim.conversationId,
            attempts: claim.attempts,
            cancelHardExitMs,
          })
          process.exit(1)
        }, cancelHardExitMs)
      }

      let taskResult: Awaited<ReturnType<typeof runClaimedTaskJob>>
      try {
        taskResult = await runClaimedTaskJob(claim, (emitter, signal, runContext) => {
          if (isBackgroundProbeTaskPayload(claim.payload)) {
            return runBackgroundProbeTaskJob(claim.payload, emitter, signal)
          }

          const chatPayload = claim.payload
          return ensureAgentRuntimePreloaded().then(() =>
            runChatTaskJob({
              ...chatPayload,
              emitter,
              signal,
              conversationId: claim.conversationId,
              userId: claim.userId,
              creditRunId: claim.runId,
              workerAttempt: claim.attempts,
              preserveSandboxOnAbort: runContext.shouldPreserveSandboxOnAbort,
              registerPreTerminalCleanup: runContext.registerPreTerminalCleanup,
              registerInflightToolDrain: runContext.registerInflightToolDrain,
              markHandoffUnsafe: runContext.markHandoffUnsafe,
            }),
          )
        }, {
          shutdownSignal: shutdownController.signal,
          onCancellationObserved: armCancellationHardExit,
        })
      } finally {
        clearTimeout(hardExitTimer)
        if (cancellationHardExitTimer) clearTimeout(cancellationHardExitTimer)
      }

      if (taskResult === 'requeued') {
        currentRunId = null
        await sendHeartbeat('stopping')
        console.log('[TaskWorker] Released task claim during shutdown', {
          runId: claim.runId,
          conversationId: claim.conversationId,
        })
        break
      }

      if (taskResult === 'lease_lost') {
        currentRunId = null
        await sendHeartbeat(stopping ? 'stopping' : 'idle')
        console.warn('[TaskWorker] Stopped stale task execution after losing its fenced claim', {
          runId: claim.runId,
          conversationId: claim.conversationId,
          attempts: claim.attempts,
        })
        if (options.once) break
        continue
      }


      if (taskResult === 'unsafe_handoff') {
        currentRunId = null
        await sendHeartbeat('stopping')
        console.error('[TaskWorker] Stopping after an unsafe handoff; claim will expire for isolated recovery', {
          runId: claim.runId,
          conversationId: claim.conversationId,
          attempts: claim.attempts,
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
    await heartbeatWriteChain
    await destroyWarmE2BSandbox().catch((error) => {
      console.warn('[TaskWorker] Warm sandbox cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    await markTaskWorkerStopped(workerId, startedAtMs).catch((error) => {
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
