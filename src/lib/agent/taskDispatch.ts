import 'server-only'

import {
  completeTaskDispatchAttempt,
  failTaskDispatchAttempt,
  markTaskDispatchAttemptUnknown,
  reconcileTaskDispatchAttempt,
  reserveTaskDispatchAttempt,
} from '@/lib/agent/taskJobs'

const RENDER_API_BASE_URL = 'https://api.render.com/v1'
export const RENDER_DISPATCH_BACKEND = 'render-one-off'
const RENDER_REQUEST_TIMEOUT_MS = 20_000
const RENDER_JOB_LIST_PAGE_SIZE = 100
const RENDER_JOB_LIST_MAX_PAGES = 5
const SAFE_TASK_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SAFE_RENDER_SERVICE_ID = /^srv-[0-9a-z]{20}$/
const SAFE_RENDER_PLAN_ID = /^plan-srv-[0-9a-z-]{3,64}$/
const SAFE_PROVIDER_JOB_ID = /^job-[0-9a-z]{20}$/

type TaskDispatchEnvironmentName =
  | 'RENDER_API_KEY'
  | 'RENDER_WORKER_SERVICE_ID'
  | 'RENDER_ON_DEMAND_JOB_PLAN_ID'

export interface TaskDispatchConfigurationStatus {
  backend: typeof RENDER_DISPATCH_BACKEND
  configured: boolean
  apiKeyConfigured: boolean
  serviceIdConfigured: boolean
  serviceIdValid: boolean
  planIdConfigured: boolean
  planIdValid: boolean
  missing: TaskDispatchEnvironmentName[]
  invalid: TaskDispatchEnvironmentName[]
}

export type TaskDispatchProviderReadiness =
  | {
      ok: true
      serviceId: string
      suspended: 'suspended' | 'not_suspended'
      serviceType:
        | 'static_site'
        | 'web_service'
        | 'private_service'
        | 'background_worker'
        | 'cron_job'
    }
  | {
      ok: false
      serviceId: string | null
      suspended: null
      serviceType: null
      errorCode: TaskDispatchProviderError['code']
      retryable: boolean
      status: number | null
    }

export type TaskDispatchResult =
  | {
      status: 'launched' | 'existing'
      dispatchId: string
      providerJobId: string
    }
  | {
      status: 'pending' | 'unknown' | 'skipped' | 'budget_exhausted' | 'cancelled'
      dispatchId: string
      providerJobId: null
    }

export type TaskDispatchProviderJobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface TaskDispatchProviderJob {
  providerJobId: string
  status: TaskDispatchProviderJobStatus
  startCommand: string | null
  createdAtMs: number | null
  startedAtMs: number | null
  finishedAtMs: number | null
}

interface TaskDispatchProviderObservationFailure {
  errorCode: TaskDispatchProviderError['code']
  retryable: boolean
  status: number | null
}

export type TaskDispatchProviderJobObservation =
  | {
      outcome: 'found'
      job: TaskDispatchProviderJob
    }
  | {
      outcome: 'not_found'
      providerJobId: string
    }
  | ({
      outcome: 'unknown'
      providerJobId: string
    } & TaskDispatchProviderObservationFailure)

export type TaskDispatchProviderJobListObservation =
  | {
      outcome: 'complete'
      jobs: TaskDispatchProviderJob[]
    }
  | ({
      outcome: 'unknown'
      jobs: TaskDispatchProviderJob[]
    } & TaskDispatchProviderObservationFailure)

export type TaskDispatchProviderJobCancellation =
  | {
      outcome: 'accepted'
      providerJobId: string
    }
  | {
      outcome: 'not_found'
      providerJobId: string
    }
  | ({
      outcome: 'unknown'
      providerJobId: string
    } & TaskDispatchProviderObservationFailure)

export class TaskDispatchProviderError extends Error {
  constructor(
    readonly code:
      | 'CONFIGURATION_MISSING'
      | 'CONFIGURATION_INVALID'
      | 'REQUEST_TIMEOUT'
      | 'NETWORK_ERROR'
      | 'RATE_LIMITED'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_REJECTED'
      | 'INVALID_PROVIDER_RESPONSE',
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly launchDisposition: 'known_rejection' | 'ambiguous' | null = null,
  ) {
    super(message)
    this.name = 'TaskDispatchProviderError'
  }
}

function environmentValue(name: TaskDispatchEnvironmentName): string {
  return process.env[name]?.trim() || ''
}

export function usesOnDemandTaskDispatch(): boolean {
  return process.env.AGENT_TASK_DISPATCH_MODE?.trim() === 'render_job'
}

export function validateTaskExecutionRunId(runId: string): string {
  const normalized = runId.trim()
  if (!SAFE_TASK_RUN_ID.test(normalized)) {
    throw new Error('Invalid task run id.')
  }
  return normalized
}

export function getTaskDispatchConfigurationStatus(): TaskDispatchConfigurationStatus {
  const apiKeyConfigured = environmentValue('RENDER_API_KEY').length > 0
  const serviceId = environmentValue('RENDER_WORKER_SERVICE_ID')
  const serviceIdConfigured = serviceId.length > 0
  const serviceIdValid = serviceIdConfigured && SAFE_RENDER_SERVICE_ID.test(serviceId)
  const planId = environmentValue('RENDER_ON_DEMAND_JOB_PLAN_ID')
  const planIdConfigured = planId.length > 0
  const planIdValid = planIdConfigured && SAFE_RENDER_PLAN_ID.test(planId)
  const missing: TaskDispatchEnvironmentName[] = []
  const invalid: TaskDispatchEnvironmentName[] = []

  if (!apiKeyConfigured) missing.push('RENDER_API_KEY')
  if (!serviceIdConfigured) missing.push('RENDER_WORKER_SERVICE_ID')
  else if (!serviceIdValid) invalid.push('RENDER_WORKER_SERVICE_ID')
  if (!planIdConfigured) missing.push('RENDER_ON_DEMAND_JOB_PLAN_ID')
  else if (!planIdValid) invalid.push('RENDER_ON_DEMAND_JOB_PLAN_ID')

  return {
    backend: RENDER_DISPATCH_BACKEND,
    configured: missing.length === 0 && invalid.length === 0,
    apiKeyConfigured,
    serviceIdConfigured,
    serviceIdValid,
    planIdConfigured,
    planIdValid,
    missing,
    invalid,
  }
}

export function renderTaskExecutionCommand(runId: string): string {
  return `npm run worker:drain -- --run-id ${validateTaskExecutionRunId(runId)}`
}

function requireRenderConfiguration(): {
  apiKey: string
  serviceId: string
  planId: string
} {
  const status = getTaskDispatchConfigurationStatus()
  if (status.missing.length > 0) {
    throw new TaskDispatchProviderError(
      'CONFIGURATION_MISSING',
      'On-demand task execution is not configured.',
      false,
      null,
      'known_rejection',
    )
  }
  if (status.invalid.length > 0) {
    throw new TaskDispatchProviderError(
      'CONFIGURATION_INVALID',
      'On-demand task execution configuration is invalid.',
      false,
      null,
      'known_rejection',
    )
  }

  return {
    apiKey: environmentValue('RENDER_API_KEY'),
    serviceId: environmentValue('RENDER_WORKER_SERVICE_ID'),
    planId: environmentValue('RENDER_ON_DEMAND_JOB_PLAN_ID'),
  }
}

function requireRenderServiceConfiguration(): {
  apiKey: string
  serviceId: string
} {
  const apiKey = environmentValue('RENDER_API_KEY')
  const serviceId = environmentValue('RENDER_WORKER_SERVICE_ID')
  if (!apiKey || !serviceId) {
    throw new TaskDispatchProviderError(
      'CONFIGURATION_MISSING',
      'On-demand task execution is not configured.',
      false,
    )
  }
  if (!SAFE_RENDER_SERVICE_ID.test(serviceId)) {
    throw new TaskDispatchProviderError(
      'CONFIGURATION_INVALID',
      'On-demand task execution configuration is invalid.',
      false,
    )
  }
  return { apiKey, serviceId }
}

function providerJobIdFromResponse(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const response = payload as {
    id?: unknown
    job?: { id?: unknown } | null
  }
  const id = response.id ?? response.job?.id
  return typeof id === 'string' && SAFE_PROVIDER_JOB_ID.test(id) ? id : null
}

function timestampFromProvider(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function providerJobFromResponse(payload: unknown): TaskDispatchProviderJob | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const root = payload as {
    id?: unknown
    status?: unknown
    startCommand?: unknown
    createdAt?: unknown
    startedAt?: unknown
    finishedAt?: unknown
    job?: unknown
  }
  const candidate = (
    root.job &&
    typeof root.job === 'object' &&
    !Array.isArray(root.job)
  ) ? root.job as typeof root : root
  const providerJobId = providerJobIdFromResponse(candidate)
  const validStatuses = new Set<TaskDispatchProviderJobStatus>([
    'pending',
    'running',
    'succeeded',
    'failed',
    'canceled',
  ])
  if (
    !providerJobId ||
    typeof candidate.status !== 'string' ||
    !validStatuses.has(candidate.status as TaskDispatchProviderJobStatus)
  ) return null

  return {
    providerJobId,
    status: candidate.status as TaskDispatchProviderJobStatus,
    startCommand: typeof candidate.startCommand === 'string'
      ? candidate.startCommand
      : null,
    createdAtMs: timestampFromProvider(candidate.createdAt),
    startedAtMs: timestampFromProvider(candidate.startedAt),
    finishedAtMs: timestampFromProvider(candidate.finishedAt),
  }
}

function providerStatusError(status: number): TaskDispatchProviderError {
  if (status === 429) {
    return new TaskDispatchProviderError(
      'RATE_LIMITED',
      'The task runtime is temporarily rate limited.',
      true,
      status,
    )
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return new TaskDispatchProviderError(
      'PROVIDER_UNAVAILABLE',
      'The task runtime is temporarily unavailable.',
      true,
      status,
    )
  }
  return new TaskDispatchProviderError(
    'PROVIDER_REJECTED',
    'The task runtime rejected the launch request.',
    false,
    status,
  )
}

function launchStatusError(status: number): TaskDispatchProviderError {
  if (status === 429) {
    return new TaskDispatchProviderError(
      'RATE_LIMITED',
      'The task runtime temporarily rejected the launch because it is rate limited.',
      true,
      status,
      'known_rejection',
    )
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new TaskDispatchProviderError(
      'PROVIDER_UNAVAILABLE',
      'The task runtime returned an uncertain launch result.',
      true,
      status,
      'ambiguous',
    )
  }
  return new TaskDispatchProviderError(
    'PROVIDER_REJECTED',
    'The task runtime rejected the launch request.',
    status === 409,
    status,
    'known_rejection',
  )
}

function classifiedProviderError(error: unknown): TaskDispatchProviderError {
  if (error instanceof TaskDispatchProviderError) return error
  return new TaskDispatchProviderError(
    'PROVIDER_UNAVAILABLE',
    'The task runtime readiness check failed.',
    true,
  )
}

function providerObservationFailure(
  error: unknown,
): TaskDispatchProviderObservationFailure {
  const classified = classifiedProviderError(error)
  return {
    errorCode: classified.code,
    retryable: classified.retryable,
    status: classified.status,
  }
}

async function renderProviderRequest(
  url: string,
  operation: 'readiness' | 'retrieve' | 'list' | 'launch' | 'cancel',
  init: RequestInit,
): Promise<{
  ok: boolean
  status: number
  payload: unknown
}> {
  const controller = new AbortController()
  const callerSignal = init.signal
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) {
    abortFromCaller()
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), RENDER_REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    })
    // Keep the same deadline active through body consumption. A provider can
    // return headers and then stall the JSON stream; treating that as a
    // completed launch would leave its outcome unknowable without recovery.
    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    return {
      ok: response.ok,
      status: response.status,
      payload,
    }
  } catch {
    const isLaunch = operation === 'launch'
    throw new TaskDispatchProviderError(
      controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      controller.signal.aborted
        ? `The task runtime ${operation} request timed out.`
        : `The task runtime ${operation} request could not be completed.`,
      true,
      null,
      isLaunch ? 'ambiguous' : null,
    )
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function serviceReadinessFromResponse(
  payload: unknown,
  expectedServiceId: string,
): Extract<TaskDispatchProviderReadiness, { ok: true }> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const root = payload as {
    id?: unknown
    type?: unknown
    suspended?: unknown
    service?: unknown
  }
  const service = (
    root.service &&
    typeof root.service === 'object' &&
    !Array.isArray(root.service)
  ) ? root.service as typeof root : root
  const serviceTypes = new Set([
    'static_site',
    'web_service',
    'private_service',
    'background_worker',
    'cron_job',
  ])
  if (
    service.id !== expectedServiceId ||
    typeof service.type !== 'string' ||
    !serviceTypes.has(service.type) ||
    (service.suspended !== 'suspended' && service.suspended !== 'not_suspended')
  ) return null

  return {
    ok: true,
    serviceId: expectedServiceId,
    suspended: service.suspended,
    serviceType: service.type as Extract<
      TaskDispatchProviderReadiness,
      { ok: true }
    >['serviceType'],
  }
}

export async function getTaskDispatchProviderReadiness():
  Promise<TaskDispatchProviderReadiness> {
  let serviceId: string | null = null
  try {
    const configuration = requireRenderServiceConfiguration()
    serviceId = configuration.serviceId
    const response = await renderProviderRequest(
      `${RENDER_API_BASE_URL}/services/${encodeURIComponent(serviceId)}`,
      'readiness',
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${configuration.apiKey}`,
        },
      },
    )

    if (!response.ok) throw providerStatusError(response.status)
    const readiness = serviceReadinessFromResponse(response.payload, serviceId)
    if (!readiness) {
      throw new TaskDispatchProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'The task runtime returned an invalid readiness result.',
        true,
        response.status,
      )
    }
    return readiness
  } catch (error) {
    const classified = classifiedProviderError(error)
    return {
      ok: false,
      serviceId,
      suspended: null,
      serviceType: null,
      errorCode: classified.code,
      retryable: classified.retryable,
      status: classified.status,
    }
  }
}

export async function retrieveTaskDispatchProviderJob(
  providerJobId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TaskDispatchProviderJobObservation> {
  const normalizedJobId = providerJobId.trim()
  if (!SAFE_PROVIDER_JOB_ID.test(normalizedJobId)) {
    throw new Error('Invalid task runtime job id.')
  }

  try {
    const { apiKey, serviceId } = requireRenderServiceConfiguration()
    const response = await renderProviderRequest(
      `${RENDER_API_BASE_URL}/services/${encodeURIComponent(serviceId)}/jobs/${encodeURIComponent(normalizedJobId)}`,
      'retrieve',
      {
        method: 'GET',
        signal: options.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      },
    )
    if (response.status === 404) {
      return { outcome: 'not_found', providerJobId: normalizedJobId }
    }
    if (!response.ok) throw providerStatusError(response.status)
    const job = providerJobFromResponse(response.payload)
    if (!job || job.providerJobId !== normalizedJobId) {
      throw new TaskDispatchProviderError(
        'INVALID_PROVIDER_RESPONSE',
        'The task runtime returned an invalid job result.',
        true,
        response.status,
      )
    }
    return { outcome: 'found', job }
  } catch (error) {
    return {
      outcome: 'unknown',
      providerJobId: normalizedJobId,
      ...providerObservationFailure(error),
    }
  }
}

export async function cancelTaskDispatchProviderJob(
  providerJobId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TaskDispatchProviderJobCancellation> {
  const normalizedJobId = providerJobId.trim()
  if (!SAFE_PROVIDER_JOB_ID.test(normalizedJobId)) {
    throw new Error('Invalid task runtime job id.')
  }

  try {
    const { apiKey, serviceId } = requireRenderServiceConfiguration()
    const response = await renderProviderRequest(
      `${RENDER_API_BASE_URL}/services/${encodeURIComponent(serviceId)}/jobs/${encodeURIComponent(normalizedJobId)}/cancel`,
      'cancel',
      {
        method: 'POST',
        signal: options.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      },
    )
    if (response.status === 404) {
      return { outcome: 'not_found', providerJobId: normalizedJobId }
    }
    if (!response.ok) throw providerStatusError(response.status)
    return { outcome: 'accepted', providerJobId: normalizedJobId }
  } catch (error) {
    return {
      outcome: 'unknown',
      providerJobId: normalizedJobId,
      ...providerObservationFailure(error),
    }
  }
}

export async function listTaskDispatchProviderJobs(input: {
  runId: string
  createdAfterMs: number
}, options: {
  signal?: AbortSignal
} = {}): Promise<TaskDispatchProviderJobListObservation> {
  const runId = validateTaskExecutionRunId(input.runId)
  if (!Number.isFinite(input.createdAfterMs) || input.createdAfterMs < 0) {
    throw new Error('Invalid task runtime job observation time.')
  }

  const jobs: TaskDispatchProviderJob[] = []
  try {
    const { apiKey, serviceId } = requireRenderServiceConfiguration()
    let cursor: string | null = null
    for (let page = 0; page < RENDER_JOB_LIST_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        limit: String(RENDER_JOB_LIST_PAGE_SIZE),
        // Include a clock-skew margin while keeping the bounded listing scoped
        // to this task's lifetime.
        createdAfter: new Date(Math.max(0, input.createdAfterMs - 60_000)).toISOString(),
      })
      if (cursor) query.set('cursor', cursor)
      const response = await renderProviderRequest(
        `${RENDER_API_BASE_URL}/services/${encodeURIComponent(serviceId)}/jobs?${query.toString()}`,
        'list',
        {
          method: 'GET',
          signal: options.signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
        },
      )
      if (!response.ok) throw providerStatusError(response.status)
      const payload = response.payload
      if (!Array.isArray(payload)) {
        throw new TaskDispatchProviderError(
          'INVALID_PROVIDER_RESPONSE',
          'The task runtime returned an invalid job list.',
          true,
          response.status,
        )
      }

      let nextCursor: string | null = null
      for (const entry of payload) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new TaskDispatchProviderError(
            'INVALID_PROVIDER_RESPONSE',
            'The task runtime returned an invalid job list entry.',
            true,
            response.status,
          )
        }
        const typedEntry = entry as { cursor?: unknown; job?: unknown }
        const job = providerJobFromResponse(typedEntry.job ?? typedEntry)
        if (!job) {
          throw new TaskDispatchProviderError(
            'INVALID_PROVIDER_RESPONSE',
            'The task runtime returned an invalid job list entry.',
            true,
            response.status,
          )
        }
        jobs.push(job)
        if (typeof typedEntry.cursor === 'string' && typedEntry.cursor) {
          nextCursor = typedEntry.cursor
        }
      }

      if (payload.length < RENDER_JOB_LIST_PAGE_SIZE) {
        return {
          outcome: 'complete',
          jobs: jobs.filter((job) => job.startCommand === renderTaskExecutionCommand(runId)),
        }
      }
      if (!nextCursor || nextCursor === cursor) {
        throw new TaskDispatchProviderError(
          'INVALID_PROVIDER_RESPONSE',
          'The task runtime job list could not be paginated safely.',
          true,
          response.status,
        )
      }
      cursor = nextCursor
    }
    throw new TaskDispatchProviderError(
      'PROVIDER_UNAVAILABLE',
      'The task runtime job list exceeded the bounded observation window.',
      true,
    )
  } catch (error) {
    return {
      outcome: 'unknown',
      jobs: [],
      ...providerObservationFailure(error),
    }
  }
}

async function createRenderOneOffJob(runId: string): Promise<string> {
  const safeRunId = validateTaskExecutionRunId(runId)
  const { apiKey, serviceId, planId } = requireRenderConfiguration()
  const response = await renderProviderRequest(
    `${RENDER_API_BASE_URL}/services/${encodeURIComponent(serviceId)}/jobs`,
    'launch',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startCommand: renderTaskExecutionCommand(safeRunId),
        planId,
      }),
    },
  )

  if (!response.ok) throw launchStatusError(response.status)

  const providerJobId = providerJobIdFromResponse(response.payload)
  if (!providerJobId) {
    throw new TaskDispatchProviderError(
      'INVALID_PROVIDER_RESPONSE',
      'The task runtime returned an invalid launch result.',
      true,
      response.status,
      'ambiguous',
    )
  }
  return providerJobId
}

export async function dispatchTaskExecution(input: {
  runId: string
  dispatchId: string
}): Promise<TaskDispatchResult> {
  const runId = validateTaskExecutionRunId(input.runId)
  const dispatchId = input.dispatchId.trim()
  if (!dispatchId || dispatchId.length > 256) {
    throw new Error('Invalid task dispatch id.')
  }

  const reservation = await reserveTaskDispatchAttempt({
    runId,
    dispatchId,
    backend: RENDER_DISPATCH_BACKEND,
  })

  if (reservation.status === 'created' && reservation.providerJobId) {
    return {
      status: 'existing',
      dispatchId,
      providerJobId: reservation.providerJobId,
    }
  }
  if (!reservation.created) {
    const status = reservation.status === 'budget_exhausted'
      ? 'budget_exhausted'
      : reservation.status === 'task_cancelled'
        ? 'cancelled'
        : reservation.status === 'unknown'
          ? 'unknown'
          : reservation.status === 'failed_known' ||
              reservation.status === 'terminal' ||
              reservation.status === 'task_terminal'
            ? 'skipped'
            : 'pending'
    return {
      status,
      dispatchId,
      providerJobId: null,
    }
  }
  const reservationToken = reservation.reservationToken
  if (!reservationToken) {
    throw new Error('Task dispatch reservation did not return an ownership token.')
  }

  let providerJobId: string
  try {
    providerJobId = await createRenderOneOffJob(runId)
  } catch (error) {
    const classified = error instanceof TaskDispatchProviderError
      ? error
      : new TaskDispatchProviderError(
        'PROVIDER_UNAVAILABLE',
        'The task runtime returned an uncertain launch result.',
        true,
        null,
        'ambiguous',
      )
    if (classified.launchDisposition === 'ambiguous') {
      await markTaskDispatchAttemptUnknown(
        dispatchId,
        reservationToken,
        classified,
      ).catch(() => undefined)
      return {
        status: 'unknown',
        dispatchId,
        providerJobId: null,
      }
    }
    await failTaskDispatchAttempt(
      dispatchId,
      reservationToken,
      classified,
    ).catch(() => undefined)
    throw error
  }

  // Generation-safe completion prevents a slow provider response from
  // overwriting a newer reservation. A superseded launch can still start, but
  // the task queue's exact atomic run claim makes the redundant worker exit.
  const completed = await completeTaskDispatchAttempt(
    dispatchId,
    reservationToken,
    providerJobId,
  )
  if (!completed) {
    // A provider job definitely exists even if the original reservation owner
    // lost its compare-and-swap race. Reconciliation records that identity so
    // subsequent coordinator turns observe it instead of issuing another POST.
    await reconcileTaskDispatchAttempt(
      dispatchId,
      runId,
      RENDER_DISPATCH_BACKEND,
      providerJobId,
    ).catch(() => undefined)
    return {
      status: 'existing',
      dispatchId,
      providerJobId,
    }
  }
  return {
    status: 'launched',
    dispatchId,
    providerJobId,
  }
}
