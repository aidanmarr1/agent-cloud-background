import { randomUUID } from 'crypto'
import { hostname } from 'os'
import {
  isRetryableTaskInfrastructureStartupFailure,
  isRetryableTaskInfrastructureInitializationError,
  RetryableTaskInfrastructureInitializationError,
  runChatTaskJob,
  type BackgroundProbeTaskPayload,
  type TaskJobPayload,
} from '@/lib/agent/chatTaskRunner'
import {
  claimNextTaskJob,
  inspectTaskExecutionDispatchState,
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
  drain?: boolean
  runId?: string
}

const DEFAULT_WORKER_POLL_MS = 100
const DEFAULT_WORKER_HEARTBEAT_MS = 15_000
const DEFAULT_WORKER_MAX_IDLE_POLL_MS = 500
const DEFAULT_WORKER_HARD_EXIT_GRACE_MS = 30_000
const DEFAULT_WORKER_CANCEL_HARD_EXIT_MS = 5_000
const DEFAULT_WORKER_STALE_MS = 60_000
const DEFAULT_WORKER_DRAIN_RECLAIM_WAIT_MS = 120_000
const DEFAULT_WORKER_DRAIN_MISSING_GRACE_MS = 5_000
const TASK_RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

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
  const drainMode = options.drain === true
  const targetRunId = options.runId?.trim() || ''
  if (drainMode && options.once === true) {
    throw new Error('Task worker --drain mode cannot be combined with --once.')
  }
  if (drainMode && !targetRunId) {
    throw new Error('Task worker --drain mode requires --run-id.')
  }
  if (!drainMode && targetRunId) {
    throw new Error('Task worker --run-id requires --drain mode.')
  }
  if (targetRunId && !TASK_RUN_ID_PATTERN.test(targetRunId)) {
    throw new Error('Invalid target task run id.')
  }

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
  const drainReclaimWaitMs = Math.max(
    workerStaleMs + heartbeatMs + cancelHardExitMs + TASK_WORKER_CANCEL_PROOF_JITTER_MS,
    finitePositiveInt(
      process.env.AGENT_TASK_WORKER_DRAIN_RECLAIM_WAIT_MS,
      DEFAULT_WORKER_DRAIN_RECLAIM_WAIT_MS,
    ),
  )
  const drainMissingGraceMs = Math.min(
    drainReclaimWaitMs,
    finitePositiveInt(
      process.env.AGENT_TASK_WORKER_DRAIN_MISSING_GRACE_MS,
      DEFAULT_WORKER_DRAIN_MISSING_GRACE_MS,
    ),
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
  const drainClaimDeadlineMs = startedAtMs + drainReclaimWaitMs
  const drainMissingDeadlineMs = startedAtMs + drainMissingGraceMs
  let currentRunId: string | null = null
  let completedTasks = 0
  let stopping = false
  let runtimePreloadStarted = false
  let runtimePreloadFailure: unknown = null
  let runtimePreloadPromise: Promise<void> | null = null
  let drainStaleRetryUsed = false
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
    console.log('[TaskWorker] Starting', {
      workerId,
      queueName,
      pollMs,
      heartbeatMs,
      once: options.once === true,
      drain: drainMode,
      targetRunId: targetRunId || null,
    })

    const warmPoolEnabled = !drainMode && e2bWarmPoolEnabled()
    const startupWarmupPromise = drainMode
      ? Promise.resolve()
      : warmPoolEnabled
        ? startE2BWorkerWarmup()
        : verifyE2BWorkerStartup()
    try {
      // A finite drain may only need to observe an already-terminal task or
      // wait for an old lease to expire. Avoid creating a throwaway sandbox or
      // loading the full agent runtime until this process actually owns work.
      if (!drainMode) {
        await Promise.all([startupWarmupPromise, ensureAgentRuntimePreloaded()])
      }
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
        claim = drainMode
          ? await claimNextTaskJob(workerId, undefined, targetRunId)
          : await claimNextTaskJob(workerId)
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
        if (drainMode) {
          const dispatchState = await inspectTaskExecutionDispatchState(targetRunId)
          if (dispatchState.state === 'terminal') {
            console.log('[TaskWorker] Target task is already terminal; drain complete', {
              runId: targetRunId,
              status: dispatchState.status,
              terminalStatus: dispatchState.terminalStatus,
            })
            break
          }

          const now = Date.now()
          if (dispatchState.state === 'missing' && now >= drainMissingDeadlineMs) {
            // A targeted provider job can outlive an intentionally cleaned-up
            // internal probe. Once the bounded enqueue-lag grace expires there
            // is no durable claim left to recover, so exit successfully instead
            // of making the supervisor restart the same impossible drain.
            console.log('[TaskWorker] Target task no longer exists after the drain grace period; drain complete', {
              runId: targetRunId,
            })
            break
          }
          if (dispatchState.state === 'running' && now >= drainClaimDeadlineMs) {
            console.log('[TaskWorker] Target task remains owned by a live worker; drain duplicate is exiting', {
              runId: targetRunId,
              workerId: dispatchState.workerId,
              workerStatus: dispatchState.workerStatus,
              leaseExpiresAtMs: dispatchState.leaseExpiresAtMs,
            })
            break
          }
          if (
            now >= drainClaimDeadlineMs &&
            dispatchState.state === 'stale' &&
            !drainStaleRetryUsed
          ) {
            // The state can become reclaimable immediately after the claim
            // attempt that preceded this inspection. Permit exactly one more
            // targeted transaction, then fail rather than spin indefinitely.
            drainStaleRetryUsed = true
          } else if (
            now >= drainClaimDeadlineMs &&
            dispatchState.state !== 'missing'
          ) {
            throw new Error(
              `Target task "${targetRunId}" could not be claimed within ${drainReclaimWaitMs}ms ` +
              `(state: ${dispatchState.state}).`,
            )
          }

          await sendHeartbeat('idle').catch(() => undefined)
          await sleepUntilAbort(idlePollMs, shutdownController.signal)
          idlePollMs = Math.min(maxIdlePollMs, idlePollMs * 2)
          continue
        }
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
      let cancellationExecutionSettled = false
      const armCancellationHardExit = () => {
        if (cancellationHardExitTimer || cancellationExecutionSettled) return
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
      const disarmCancellationHardExit = () => {
        cancellationExecutionSettled = true
        if (!cancellationHardExitTimer) return
        clearTimeout(cancellationHardExitTimer)
        cancellationHardExitTimer = null
        console.log('[TaskWorker] Cancellation execution settled; continuing fenced cleanup', {
          runId: claim.runId,
          conversationId: claim.conversationId,
          attempts: claim.attempts,
        })
      }

      let taskResult: Awaited<ReturnType<typeof runClaimedTaskJob>>
      try {
        taskResult = await runClaimedTaskJob(claim, (emitter, signal, runContext) => {
          if (isBackgroundProbeTaskPayload(claim.payload)) {
            return runBackgroundProbeTaskJob(claim.payload, emitter, signal)
          }

          const chatPayload = claim.payload
          return (async () => {
            try {
              await ensureAgentRuntimePreloaded()
            } catch (error) {
              if (!isRetryableTaskInfrastructureStartupFailure(error)) {
                // Build/configuration/authentication defects cannot heal in a
                // replacement paid job. Let the claimed-task finalizer publish
                // a terminal error instead of spending the restart budget.
                throw error
              }
              const initializationError = new RetryableTaskInfrastructureInitializationError(
                'agent_runtime_preload',
                error,
              )
              runContext.requestInfrastructureRetry(initializationError.stage)
              throw initializationError
            }

            try {
              await runChatTaskJob({
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
              })
            } catch (error) {
              if (isRetryableTaskInfrastructureInitializationError(error)) {
                runContext.requestInfrastructureRetry(error.stage)
              }
              throw error
            }
          })()
        }, {
          shutdownSignal: shutdownController.signal,
          onCancellationObserved: armCancellationHardExit,
          onCancellationExecutionSettled: disarmCancellationHardExit,
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

      if (taskResult === 'retryable_failure') {
        currentRunId = null
        await sendHeartbeat('stopping')
        throw new Error(
          `Target task "${claim.runId}" was safely requeued after a transient infrastructure initialization failure.`,
        )
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
        if (drainMode) continue
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
        if (drainMode) {
          throw new Error(`Target task "${claim.runId}" requires isolated recovery after an unsafe handoff.`)
        }
        break
      }

      completedTasks += 1
      currentRunId = null
      await sendHeartbeat('idle')

      console.log('[TaskWorker] Finished task', {
        runId: claim.runId,
        conversationId: claim.conversationId,
      })

      if (options.once || drainMode) break
    }
  } finally {
    clearInterval(heartbeatTimer)
    currentRunId = null
    await heartbeatWriteChain
    if (!drainMode) {
      await destroyWarmE2BSandbox().catch((error) => {
        console.warn('[TaskWorker] Warm sandbox cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
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
