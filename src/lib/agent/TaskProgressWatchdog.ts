import { createHash } from 'node:crypto'

const PRESENTATION_KEYS = new Set([
  'action_label', 'plan_step_index', 'progress_update',
  'durationMs', 'elapsedMs', 'latencyMs', 'timestamp', 'observedAt', 'requestId',
])
const OBSERVATIONS = new Set(['read_file', 'list_files', 'read_document', 'web_search', 'image_search', 'browser_get_content', 'browser_screenshot', 'browser_find_text'])

export const STALLED_TURN_REDIRECT_LIMIT = 2
export const STALLED_TURN_STOP_LIMIT = 4
const PROGRESS_WINDOW = 8
const WINDOW_STALLED_STOP_LIMIT = 6

export interface TaskProgressSnapshot {
  seen: string[]
  pending: boolean
  progressed: boolean
  stalledTurns: number
  recentProgress?: boolean[]
  redirected?: boolean
  completedStepCount?: number
  newResultsSinceCompletion?: boolean
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !PRESENTATION_KEYS.has(key))
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

/** Task-wide fence, independent of phase changes and local recovery counters. */
export class TaskProgressWatchdog {
  private seen = new Set<string>()
  private pending = false
  private progressed = false
  private stalledTurns = 0
  private recentProgress: boolean[] = []
  private redirected = false
  private completedStepCount = 0
  private newResultsSinceCompletion = false

  constructor(snapshot?: TaskProgressSnapshot) {
    if (snapshot) {
      this.seen = new Set(snapshot.seen)
      this.pending = snapshot.pending
      this.progressed = snapshot.progressed
      this.stalledTurns = snapshot.stalledTurns
      this.recentProgress = [...(snapshot.recentProgress || [])].slice(-PROGRESS_WINDOW)
      this.redirected = snapshot.redirected === true
      this.completedStepCount = snapshot.completedStepCount || 0
      this.newResultsSinceCompletion = snapshot.newResultsSinceCompletion ?? snapshot.seen.length > 0
    }
  }

  snapshot(): TaskProgressSnapshot {
    return {
      seen: [...this.seen], pending: this.pending, progressed: this.progressed,
      stalledTurns: this.stalledTurns, recentProgress: [...this.recentProgress], redirected: this.redirected,
      completedStepCount: this.completedStepCount, newResultsSinceCompletion: this.newResultsSinceCompletion,
    }
  }

  startTurn(): void {
    // Reopening a stream must not erase an unsettled turn's progress.
    if (this.pending) return
    this.pending = true
    this.progressed = false
  }

  record(results: ReadonlyArray<{
    tc: { name: string; arguments?: string }; result: unknown; isError: boolean
    acceptedForExecution?: boolean; cached?: boolean
  }>): void {
    for (const result of results) {
      if (!result.acceptedForExecution || result.isError || result.cached) continue
      // Compare evidence, not labels or arguments: changing the wording of a
      // request for the same result does not make it new work. Hashes keep
      // source contents, screenshots, and credentials out of retained state.
      let action: unknown = null
      if (!OBSERVATIONS.has(result.tc.name)) {
        try { action = stable(JSON.parse(result.tc.arguments || '{}')) } catch { action = result.tc.arguments }
      }
      const fingerprint = createHash('sha256').update(result.tc.name).update(JSON.stringify(action) ?? '')
        .update(JSON.stringify(stable(result.result)) ?? 'null').digest('hex')
      if (this.seen.has(fingerprint)) continue
      this.seen.add(fingerprint)
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
      this.progressed = true
      this.newResultsSinceCompletion = true
    }
  }

  /** Credit a validated phase outcome once, backed by new successful results.
   * Arbitrary narration, replanning, and empty phase jumps cannot renew it. */
  recordPhaseCompletion(completedStepCount: number): void {
    if (!this.pending || !this.newResultsSinceCompletion || completedStepCount <= this.completedStepCount) return
    this.completedStepCount = completedStepCount
    this.newResultsSinceCompletion = false
    this.progressed = true
  }

  boundary(): 'continue' | 'redirect' | 'stop' {
    if (!this.pending) return 'continue'
    this.pending = false
    this.stalledTurns = this.progressed ? 0 : this.stalledTurns + 1
    this.recentProgress.push(this.progressed)
    if (this.recentProgress.length > PROGRESS_WINDOW) this.recentProgress.shift()
    const stalledInWindow = this.recentProgress.filter(progress => !progress).length
    // Occasional novel results cannot fund an otherwise repeating tool cycle.
    if (
      this.stalledTurns >= STALLED_TURN_STOP_LIMIT ||
      (this.recentProgress.length === PROGRESS_WINDOW && stalledInWindow >= WINDOW_STALLED_STOP_LIMIT)
    ) return 'stop'
    if (this.progressed && stalledInWindow < STALLED_TURN_REDIRECT_LIMIT) this.redirected = false
    if (!this.redirected && (
      this.stalledTurns >= STALLED_TURN_REDIRECT_LIMIT ||
      (this.recentProgress.length === PROGRESS_WINDOW && stalledInWindow >= STALLED_TURN_STOP_LIMIT)
    )) {
      this.redirected = true
      return 'redirect'
    }
    return 'continue'
  }

  /** Only a new user instruction starts a fresh autonomous budget. */
  reset(): void {
    this.pending = false
    this.progressed = false
    this.stalledTurns = 0
    this.recentProgress = []
    this.redirected = false
    this.seen.clear()
    this.completedStepCount = 0
    this.newResultsSinceCompletion = false
  }
}
