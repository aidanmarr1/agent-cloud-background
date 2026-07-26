import { FatalError, sleep } from 'workflow'
import type {
  TaskDispatchProviderError,
  TaskDispatchProviderJobStatus,
  TaskDispatchResult,
} from '@/lib/agent/taskDispatch'
import type {
  TaskExecutionDispatchState,
  TaskExecutionRenderDispatch,
} from '@/lib/agent/taskJobs'

const INITIAL_RUNTIME_WAIT_MS = 3_000
const MISSING_TASK_POLL_MS = 2_000
const MISSING_TASK_GRACE_MS = 2 * 60_000
const RUNNING_POLL_MS = 10_000
const PROVIDER_BACKOFF_MIN_MS = 5_000
const PROVIDER_BACKOFF_MAX_MS = 60_000
const KNOWN_REJECTION_BACKOFF_MS = 30_000
const UNKNOWN_DISPATCH_SETTLE_MS = 2 * 60_000
const REQUIRED_EMPTY_PROVIDER_OBSERVATIONS = 2
const COORDINATOR_LAUNCH_DEADLINE_MS = 2 * 60 * 60_000
const COORDINATOR_DRAIN_BACKSTOP_MS = 60 * 60_000

interface InspectedTaskExecution {
  state: TaskExecutionDispatchState
  observedAtMs: number
}

type TaskExecutionDispatchStepResult =
  | TaskDispatchResult
  | {
      status: 'provider_rejected'
      dispatchId: string
      providerJobId: null
      errorCode: TaskDispatchProviderError['code']
      retryable: boolean
    }

interface ProviderObservationResult {
  observedAtMs: number
  authoritative: boolean
  possiblyLive: boolean
  notFoundDispatches: Array<{
    dispatchId: string
    providerJobId: string | null
  }>
}

export type TaskExecutionWorkflowResult =
  | {
      outcome: 'terminal'
      runId: string
      status: 'done' | 'error' | 'cancelled'
      attempts: number
    }
  | {
      outcome: 'missing'
      runId: string
    }
  | {
      outcome: 'dispatch_rejected' | 'dispatch_budget_exhausted'
      runId: string
      errorCode: string
    }
  | {
      outcome: 'coordinator_deadline'
      runId: string
      taskStillActive: boolean
    }

function terminalStatus(
  status: string | null,
  terminal: 'done' | 'error' | null,
): 'done' | 'error' | 'cancelled' {
  if (terminal === 'done' || status === 'done') return 'done'
  if (status === 'cancelled') return 'cancelled'
  return 'error'
}

function providerBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.min(4, Math.max(0, consecutiveFailures - 1))
  return Math.min(
    PROVIDER_BACKOFF_MAX_MS,
    PROVIDER_BACKOFF_MIN_MS * (2 ** exponent),
  )
}

function dispatchGeneration(dispatchId: string, runId: string): number | null {
  const prefix = `render:${runId}:`
  if (!dispatchId.startsWith(prefix)) return null
  const parsed = Number(dispatchId.slice(prefix.length))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isProviderJobLive(status: TaskDispatchProviderJobStatus): boolean {
  return status === 'pending' || status === 'running'
}

async function inspectTaskExecutionStep(
  runId: string,
): Promise<InspectedTaskExecution> {
  'use step'
  const [
    { inspectTaskExecutionDispatchState },
    { validateTaskExecutionRunId },
  ] = await Promise.all([
    import('@/lib/agent/taskJobs'),
    import('@/lib/agent/taskDispatch'),
  ])
  return {
    state: await inspectTaskExecutionDispatchState(
      validateTaskExecutionRunId(runId),
    ),
    observedAtMs: Date.now(),
  }
}

inspectTaskExecutionStep.maxRetries = 0

async function coordinatorClockStep(): Promise<number> {
  'use step'
  return Date.now()
}

coordinatorClockStep.maxRetries = 0

async function failTaskExecutionDispatchStep(
  runId: string,
  rejectedDispatchId?: string,
): Promise<boolean> {
  'use step'
  const [
    { failTaskExecutionDispatch },
    { validateTaskExecutionRunId },
  ] = await Promise.all([
    import('@/lib/agent/taskJobs'),
    import('@/lib/agent/taskDispatch'),
  ])
  return failTaskExecutionDispatch(
    validateTaskExecutionRunId(runId),
    rejectedDispatchId,
  )
}

failTaskExecutionDispatchStep.maxRetries = 0

async function finalizeRequestedTaskCancellationStep(
  runId: string,
): Promise<boolean> {
  'use step'
  const [
    { finalizeRequestedTaskCancellation },
    { validateTaskExecutionRunId },
  ] = await Promise.all([
    import('@/lib/agent/taskJobs'),
    import('@/lib/agent/taskDispatch'),
  ])
  return finalizeRequestedTaskCancellation(
    validateTaskExecutionRunId(runId),
  )
}

finalizeRequestedTaskCancellationStep.maxRetries = 0

async function dispatchTaskExecutionStep(
  runId: string,
  generation: number,
): Promise<TaskExecutionDispatchStepResult> {
  'use step'

  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new FatalError('Invalid task dispatch generation.')
  }
  const {
    TaskDispatchProviderError,
    dispatchTaskExecution,
    validateTaskExecutionRunId,
  } = await import('@/lib/agent/taskDispatch')
  const safeRunId = validateTaskExecutionRunId(runId)
  const dispatchId = `render:${safeRunId}:${generation}`
  try {
    return await dispatchTaskExecution({
      runId: safeRunId,
      dispatchId,
    })
  } catch (error) {
    if (
      error instanceof TaskDispatchProviderError &&
      error.launchDisposition === 'known_rejection'
    ) {
      return {
        status: 'provider_rejected',
        dispatchId,
        providerJobId: null,
        errorCode: error.code,
        retryable: error.retryable,
      }
    }
    throw error
  }
}

// A launch step performs one provider POST at most. Workflow-level recovery
// always allocates a new monotonically increasing generation after observing
// durable provider/DB state; the SDK never invisibly repeats a POST.
dispatchTaskExecutionStep.maxRetries = 0

async function observeTaskExecutionProviderStep(input: {
  runId: string
  taskStartedAtMs: number
  dispatches: TaskExecutionRenderDispatch[]
}): Promise<ProviderObservationResult> {
  'use step'

  const [
    {
      RENDER_DISPATCH_BACKEND,
      listTaskDispatchProviderJobs,
      retrieveTaskDispatchProviderJob,
      validateTaskExecutionRunId,
    },
    {
      reconcileTaskDispatchAttempt,
      recordTaskDispatchProviderStatus,
    },
  ] = await Promise.all([
    import('@/lib/agent/taskDispatch'),
    import('@/lib/agent/taskJobs'),
  ])
  const runId = validateTaskExecutionRunId(input.runId)
  const observedAtMs = Date.now()
  const activeDispatches = input.dispatches
    .filter((dispatch) => (
      dispatch.status === 'creating' ||
      dispatch.status === 'unknown' ||
      dispatch.status === 'created'
    ))
    .sort((left, right) => (
      left.updatedAtMs - right.updatedAtMs ||
      left.dispatchId.localeCompare(right.dispatchId)
    ))
  if (activeDispatches.length === 0) {
    return {
      observedAtMs,
      authoritative: true,
      possiblyLive: false,
      notFoundDispatches: [],
    }
  }

  let authoritative = true
  let possiblyLive = false
  const unresolved = new Map(
    activeDispatches.map((dispatch) => [dispatch.dispatchId, dispatch]),
  )
  const activeDispatchIds = new Set(
    activeDispatches.map((dispatch) => dispatch.dispatchId),
  )
  const associatedProviderJobIds = new Set(
    input.dispatches
      .filter((dispatch) => !activeDispatchIds.has(dispatch.dispatchId))
      .map((dispatch) => dispatch.providerJobId)
      .filter((providerJobId): providerJobId is string => !!providerJobId),
  )

  for (const dispatch of activeDispatches) {
    if (!dispatch.providerJobId) continue
    const observation = await retrieveTaskDispatchProviderJob(
      dispatch.providerJobId,
    )
    if (observation.outcome === 'unknown') {
      authoritative = false
      possiblyLive = true
      continue
    }
    if (observation.outcome === 'not_found') continue

    unresolved.delete(dispatch.dispatchId)
    associatedProviderJobIds.add(dispatch.providerJobId)
    await recordTaskDispatchProviderStatus(
      dispatch.dispatchId,
      observation.job.providerJobId,
      observation.job.status,
    )
    if (isProviderJobLive(observation.job.status)) possiblyLive = true
  }

  if (unresolved.size > 0) {
    const listObservation = await listTaskDispatchProviderJobs({
      runId,
      createdAfterMs: input.taskStartedAtMs,
    })
    if (listObservation.outcome === 'unknown') {
      authoritative = false
      possiblyLive = true
    } else {
      const exactJobs = listObservation.jobs
        .slice()
        .sort((left, right) => (
          (left.createdAtMs ?? Number.MAX_SAFE_INTEGER) -
            (right.createdAtMs ?? Number.MAX_SAFE_INTEGER) ||
          left.providerJobId.localeCompare(right.providerJobId)
        ))
      for (const job of exactJobs) {
        if (isProviderJobLive(job.status)) possiblyLive = true
      }

      const unassignedJobs = exactJobs.filter(
        (job) => !associatedProviderJobIds.has(job.providerJobId),
      )
      for (const dispatch of unresolved.values()) {
        let matchingIndex = dispatch.providerJobId
          ? unassignedJobs.findIndex(
            (job) => job.providerJobId === dispatch.providerJobId,
          )
          : -1
        if (matchingIndex < 0 && !dispatch.providerJobId) matchingIndex = 0
        if (matchingIndex < 0 || matchingIndex >= unassignedJobs.length) continue

        const [job] = unassignedJobs.splice(matchingIndex, 1)
        unresolved.delete(dispatch.dispatchId)
        await reconcileTaskDispatchAttempt(
          dispatch.dispatchId,
          runId,
          RENDER_DISPATCH_BACKEND,
          job.providerJobId,
        )
        await recordTaskDispatchProviderStatus(
          dispatch.dispatchId,
          job.providerJobId,
          job.status,
        )
      }
    }
  }

  return {
    observedAtMs,
    authoritative,
    possiblyLive,
    notFoundDispatches: authoritative
      ? Array.from(unresolved.values()).map((dispatch) => ({
          dispatchId: dispatch.dispatchId,
          providerJobId: dispatch.providerJobId,
        }))
      : [],
  }
}

observeTaskExecutionProviderStep.maxRetries = 0

async function resolveTaskDispatchesNotFoundStep(
  runId: string,
  dispatches: Array<{
    dispatchId: string
    providerJobId: string | null
  }>,
): Promise<void> {
  'use step'
  const [
    { recordTaskDispatchProviderStatus },
    { validateTaskExecutionRunId },
  ] = await Promise.all([
    import('@/lib/agent/taskJobs'),
    import('@/lib/agent/taskDispatch'),
  ])
  validateTaskExecutionRunId(runId)
  const notFoundBeforeMs = Date.now() - UNKNOWN_DISPATCH_SETTLE_MS
  for (const dispatch of dispatches) {
    await recordTaskDispatchProviderStatus(
      dispatch.dispatchId,
      dispatch.providerJobId,
      'not_found',
      notFoundBeforeMs,
    )
  }
}

resolveTaskDispatchesNotFoundStep.maxRetries = 0

export async function taskExecutionWorkflow(
  runId: string,
): Promise<TaskExecutionWorkflowResult> {
  'use workflow'

  let missingTaskWaitMs = 0
  let nextDispatchGeneration = 1
  let providerFailureCount = 0
  let observeOnlyReason:
    | 'budget_exhausted'
    | 'provider_rejected'
    | 'launch_deadline'
    | null = null
  let observeOnlyErrorCode = 'DISPATCH_BUDGET_EXHAUSTED'
  let lastRejectedDispatchId: string | undefined
  let launchDeadlineAtMs: number | null = null
  let hardDeadlineAtMs: number | null = null
  const emptyProviderObservations: Record<string, number> = {}

  // Workflow sleeps release compute. The task's persisted startedAt value
  // defines a finite deadline that remains stable across workflow replays.
  for (;;) {
    let inspected: InspectedTaskExecution
    try {
      inspected = await inspectTaskExecutionStep(runId)
    } catch {
      providerFailureCount += 1
      let observedAtMs: number
      try {
        observedAtMs = await coordinatorClockStep()
      } catch {
        await sleep(providerBackoffMs(providerFailureCount))
        continue
      }
      if (launchDeadlineAtMs === null || hardDeadlineAtMs === null) {
        launchDeadlineAtMs =
          observedAtMs + COORDINATOR_LAUNCH_DEADLINE_MS
        hardDeadlineAtMs =
          launchDeadlineAtMs + COORDINATOR_DRAIN_BACKSTOP_MS
      }
      // The worker/provider owns any already-launched execution. Once the
      // coordinator backstop expires, stop spending Workflow steps instead of
      // polling a persistently unavailable database forever. Returning an
      // active result avoids publishing a false terminal state.
      if (observedAtMs >= hardDeadlineAtMs) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      await sleep(providerBackoffMs(providerFailureCount))
      continue
    }
    const { state, observedAtMs } = inspected

    if (state.state === 'missing') {
      if (missingTaskWaitMs < MISSING_TASK_GRACE_MS) {
        await sleep(MISSING_TASK_POLL_MS)
        missingTaskWaitMs += MISSING_TASK_POLL_MS
        continue
      }
      return { outcome: 'missing', runId }
    }
    missingTaskWaitMs = 0
    if (state.state === 'terminal') {
      return {
        outcome: 'terminal',
        runId,
        status: terminalStatus(state.status, state.terminalStatus),
        attempts: state.attempts,
      }
    }
    const startedAtMs = (
      typeof state.startedAtMs === 'number' &&
      Number.isFinite(state.startedAtMs) &&
      state.startedAtMs > 0
    ) ? state.startedAtMs : observedAtMs
    const taskLaunchDeadlineAtMs =
      startedAtMs + COORDINATOR_LAUNCH_DEADLINE_MS
    launchDeadlineAtMs = launchDeadlineAtMs === null
      ? taskLaunchDeadlineAtMs
      : Math.min(launchDeadlineAtMs, taskLaunchDeadlineAtMs)
    hardDeadlineAtMs = hardDeadlineAtMs === null
      ? launchDeadlineAtMs + COORDINATOR_DRAIN_BACKSTOP_MS
      : Math.min(
          hardDeadlineAtMs,
          launchDeadlineAtMs + COORDINATOR_DRAIN_BACKSTOP_MS,
        )
    const launchDeadlineReached = observedAtMs >= launchDeadlineAtMs
    const hardDeadlineReached = observedAtMs >= hardDeadlineAtMs
    if (launchDeadlineReached && observeOnlyReason === null) {
      observeOnlyReason = 'launch_deadline'
      observeOnlyErrorCode = 'COORDINATOR_LAUNCH_DEADLINE'
    }
    if (state.cancelRequested) {
      try {
        const finalized = await finalizeRequestedTaskCancellationStep(runId)
        if (finalized) {
          return {
            outcome: 'terminal',
            runId,
            status: 'cancelled',
            attempts: state.attempts,
          }
        }
      } catch {
        providerFailureCount += 1
        if (hardDeadlineReached) {
          return {
            outcome: 'coordinator_deadline',
            runId,
            taskStillActive: true,
          }
        }
        await sleep(providerBackoffMs(providerFailureCount))
        continue
      }
      if (hardDeadlineReached) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      providerFailureCount = 0
      await sleep(RUNNING_POLL_MS)
      continue
    }
    const renderDispatches = Array.isArray(state.renderDispatches)
      ? state.renderDispatches
      : []
    for (const dispatch of renderDispatches) {
      const generation = dispatchGeneration(dispatch.dispatchId, runId)
      if (generation !== null) {
        nextDispatchGeneration = Math.max(
          nextDispatchGeneration,
          generation + 1,
        )
      }
    }

    if (state.state === 'running') {
      // Never publish a terminal row ahead of an exact live worker. The drain
      // and worker watchdogs bound paid compute. At the coordinator backstop,
      // the exact worker remains responsible for its own terminal write while
      // this Workflow stops consuming control-plane steps.
      if (hardDeadlineReached) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      providerFailureCount = 0
      await sleep(RUNNING_POLL_MS)
      continue
    }

    let providerObservation: ProviderObservationResult
    try {
      providerObservation = await observeTaskExecutionProviderStep({
        runId,
        taskStartedAtMs: startedAtMs,
        dispatches: renderDispatches,
      })
    } catch {
      providerFailureCount += 1
      if (hardDeadlineReached) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      await sleep(providerBackoffMs(providerFailureCount))
      continue
    }

    if (!providerObservation.authoritative) {
      providerFailureCount += 1
      // Unknown provider state can mean the POST succeeded. Keep observing
      // without launching another job or falsely terminalizing the task, but
      // stop the coordinator itself at its finite control-plane backstop.
      if (hardDeadlineReached) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      await sleep(providerBackoffMs(providerFailureCount))
      continue
    }
    providerFailureCount = 0

    const notFoundSet = new Set(
      providerObservation.notFoundDispatches.map(
        (dispatch) => dispatch.dispatchId,
      ),
    )
    for (const dispatchId of Object.keys(emptyProviderObservations)) {
      if (!notFoundSet.has(dispatchId)) delete emptyProviderObservations[dispatchId]
    }
    const eligibleNotFoundDispatches: Array<{
      dispatchId: string
      providerJobId: string | null
    }> = []
    for (const notFoundDispatch of providerObservation.notFoundDispatches) {
      const { dispatchId } = notFoundDispatch
      emptyProviderObservations[dispatchId] =
        (emptyProviderObservations[dispatchId] ?? 0) + 1
      const dispatch = renderDispatches.find(
        (candidate) => candidate.dispatchId === dispatchId,
      )
      if (
        dispatch &&
        dispatch.updatedAtMs <=
          providerObservation.observedAtMs - UNKNOWN_DISPATCH_SETTLE_MS &&
        emptyProviderObservations[dispatchId] >=
          REQUIRED_EMPTY_PROVIDER_OBSERVATIONS
      ) {
        eligibleNotFoundDispatches.push(notFoundDispatch)
      }
    }
    if (eligibleNotFoundDispatches.length > 0) {
      try {
        await resolveTaskDispatchesNotFoundStep(
          runId,
          eligibleNotFoundDispatches,
        )
      } catch {
        providerFailureCount += 1
        if (hardDeadlineReached) {
          return {
            outcome: 'coordinator_deadline',
            runId,
            taskStillActive: true,
          }
        }
        await sleep(providerBackoffMs(providerFailureCount))
        continue
      }
      for (const dispatch of eligibleNotFoundDispatches) {
        delete emptyProviderObservations[dispatch.dispatchId]
      }
      await sleep(INITIAL_RUNTIME_WAIT_MS)
      continue
    }

    const unresolvedDispatchExists =
      providerObservation.notFoundDispatches.length > 0
    if (providerObservation.possiblyLive || unresolvedDispatchExists) {
      if (hardDeadlineReached) {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      await sleep(providerBackoffMs(1))
      continue
    }

    if (hardDeadlineReached) {
      let finalized = false
      try {
        finalized = await failTaskExecutionDispatchStep(
          runId,
          lastRejectedDispatchId,
        )
      } catch {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: true,
        }
      }
      return {
        outcome: 'coordinator_deadline',
        runId,
        taskStillActive: !finalized,
      }
    }

    if (observeOnlyReason) {
      let finalized = false
      try {
        finalized = await failTaskExecutionDispatchStep(
          runId,
          lastRejectedDispatchId,
        )
      } catch {
        providerFailureCount += 1
        await sleep(providerBackoffMs(providerFailureCount))
        continue
      }
      if (!finalized) {
        await sleep(providerBackoffMs(1))
        continue
      }
      if (observeOnlyReason === 'launch_deadline') {
        return {
          outcome: 'coordinator_deadline',
          runId,
          taskStillActive: false,
        }
      }
      return {
        outcome: observeOnlyReason === 'provider_rejected'
          ? 'dispatch_rejected'
          : 'dispatch_budget_exhausted',
        runId,
        errorCode: observeOnlyErrorCode,
      }
    }

    const generation = nextDispatchGeneration
    nextDispatchGeneration += 1
    let dispatchResult: TaskExecutionDispatchStepResult
    try {
      dispatchResult = await dispatchTaskExecutionStep(runId, generation)
    } catch {
      // A failed step can be ambiguous if it stopped after reserving or
      // launching. Inspect durable dispatch/provider state before considering
      // any newer generation.
      providerFailureCount += 1
      await sleep(providerBackoffMs(providerFailureCount))
      continue
    }

    if (dispatchResult.status === 'budget_exhausted') {
      observeOnlyReason = 'budget_exhausted'
      observeOnlyErrorCode = 'DISPATCH_BUDGET_EXHAUSTED'
      await sleep(INITIAL_RUNTIME_WAIT_MS)
      continue
    }
    if (dispatchResult.status === 'provider_rejected') {
      lastRejectedDispatchId = dispatchResult.dispatchId
      if (!dispatchResult.retryable) {
        observeOnlyReason = 'provider_rejected'
        observeOnlyErrorCode = dispatchResult.errorCode
      }
      await sleep(KNOWN_REJECTION_BACKOFF_MS)
      continue
    }

    // launched/existing/pending/unknown/skipped all re-enter observation.
    // This prevents a second POST until accepted or ambiguous prior work has
    // been reconciled against Render's retrieve/list job APIs.
    await sleep(INITIAL_RUNTIME_WAIT_MS)
  }
}
