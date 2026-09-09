/** Shared execution decisions. maxRetries always means additional attempts. */
export type FailureKind = 'aborted' | 'permanent' | 'timeout' | 'rate_limit' | 'transient' | 'unknown'

export function classifyFailure(error: unknown): FailureKind {
  const value = error as { name?: string; status?: number; message?: string } | null
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : value?.message || ''
  if (value?.name === 'AbortError') return 'aborted'
  const status = value?.status
  // Explicit permanent status/denial wins even if the response mentions a timeout.
  if ((status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) ||
    /\b(?:401|403|404)\b|forbidden|unauthori[sz]ed|access denied|permission denied|\bBLOCKED\b|already exists|already searched|disabled|invalid.*arg|not found|model.*expir/i.test(message)) return 'permanent'
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message)) return 'rate_limit'
  if (status === 408 || /timed?\s*out|timeout|ETIMEDOUT/i.test(message)) return 'timeout'
  if ((status !== undefined && status >= 500) ||
    /fetch failed|network|socket|terminated|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|UND_ERR|temporarily unavailable|\b(?:502|503|504)\b|bad gateway|service unavailable/i.test(message)) return 'transient'
  return 'unknown'
}
export function isTransientFailure(error: unknown): boolean {
  return ['timeout', 'rate_limit', 'transient'].includes(classifyFailure(error))
}
export interface RetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  backoffExponent?: number
  jitterFraction?: number
}
export type RetryDecision = { retry: true; delayMs: number } | {
  retry: false; reason: 'aborted' | 'side_effect' | 'permanent' | 'unknown' | 'exhausted' | 'deadline'
}
export function retryDecision(error: unknown, retriesUsed: number, policy: RetryPolicy, options: {
  sideEffects?: boolean; signal?: AbortSignal; deadlineAtMs?: number; now?: number; random?: number; minAttemptMs?: number
} = {}): RetryDecision {
  const kind = classifyFailure(error)
  if (options.signal?.aborted || kind === 'aborted') return { retry: false, reason: 'aborted' }
  if (options.sideEffects) return { retry: false, reason: 'side_effect' }
  if (kind === 'permanent' || kind === 'unknown') return { retry: false, reason: kind }
  if (retriesUsed >= policy.maxRetries) return { retry: false, reason: 'exhausted' }
  const now = options.now ?? Date.now()
  const retryAfter = (error as { headers?: Record<string, string> })?.headers?.['retry-after']
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN
  const dateDelay = retryAfter ? Date.parse(retryAfter) - now : NaN
  const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, dateDelay)
  const raw = Number.isFinite(serverDelay) ? serverDelay : policy.baseDelayMs * (policy.backoffExponent ?? 2) ** retriesUsed
  // A server-directed wait cannot be shortened to the local cap. Stop when
  // the caller cannot afford it, rather than hammering a rate-limited endpoint.
  const delayMs = Number.isFinite(serverDelay) ? Math.ceil(raw) : Math.max(0, Math.ceil(Math.min(policy.maxDelayMs,
    raw * (1 + (options.random ?? Math.random()) * (policy.jitterFraction ?? 0.15)))))
  if (delayMs > 2_147_483_647) return { retry: false, reason: 'deadline' }
  if (options.deadlineAtMs !== undefined && now + delayMs + (options.minAttemptMs ?? 250) >= options.deadlineAtMs) {
    return { retry: false, reason: 'deadline' }
  }
  return { retry: true, delayMs }
}
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.max(0, delayMs))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
export function requestTimeoutWithinDeadline(preferredMs: number, deadlineAtMs?: number, now = Date.now(), reserveMs = 150): number {
  if (deadlineAtMs === undefined) return preferredMs
  const available = deadlineAtMs - now - reserveMs
  if (available < 250) throw new Error('Assistant request timed out: the execution deadline was reached.')
  return Math.min(preferredMs, available)
}

// One terminal policy owns whether each recovery path may reopen a task.
const CLOSED_TO_ALL = new Set(['safety_leakage', 'runtime_deadline', 'runtime_deadline_finalized', 'task_no_progress'])
const CLOSED_TO_WEBSITE = new Set(['iteration_cap', 'post_completion_rewrite', 'step_blocked', 'browser_stuck_step',
  'deliverable_verification_failed', 'saved_deliverable_model_start_timeout', 'deliverable_handoff_complete', 'deliverable_handoff_fallback'])
export function canReopenCompletion(reason: string, target: 'website' | 'live_directive' | 'inline_answer'): boolean {
  if (CLOSED_TO_ALL.has(reason)) return false
  return target !== 'website' || !CLOSED_TO_WEBSITE.has(reason)
}
export function finalOutputRetryDecision(attempts: number, maxRetries: number, hasVerifiedOutput: boolean): 'retry' | 'complete' | 'error' {
  if (attempts < maxRetries) return 'retry'
  return hasVerifiedOutput ? 'complete' : 'error'
}
