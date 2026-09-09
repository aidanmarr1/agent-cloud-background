import { createHash } from 'node:crypto'

const PRESENTATION_KEYS = new Set(['action_label', 'plan_step_index', 'durationMs', 'timestamp', 'observedAt'])
const OBSERVATIONS = new Set(['read_file', 'list_files', 'read_document', 'web_search', 'browser_get_content', 'browser_screenshot', 'browser_find_text'])

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

  constructor(snapshot?: { seen: string[]; pending: boolean; progressed: boolean; stalledTurns: number }) {
    if (snapshot) {
      this.seen = new Set(snapshot.seen)
      this.pending = snapshot.pending
      this.progressed = snapshot.progressed
      this.stalledTurns = snapshot.stalledTurns
    }
  }

  snapshot(): { seen: string[]; pending: boolean; progressed: boolean; stalledTurns: number } {
    return { seen: [...this.seen], pending: this.pending, progressed: this.progressed, stalledTurns: this.stalledTurns }
  }

  startTurn(): void { this.pending = true; this.progressed = false }

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
    }
  }

  boundary(): 'continue' | 'redirect' | 'stop' {
    if (!this.pending) return 'continue'
    this.pending = false
    this.stalledTurns = this.progressed ? 0 : this.stalledTurns + 1
    if (this.stalledTurns >= 6) return 'stop'
    return this.stalledTurns === 3 ? 'redirect' : 'continue'
  }

  /** Only a new user instruction starts a fresh autonomous budget. */
  reset(): void {
    this.pending = false
    this.progressed = false
    this.stalledTurns = 0
    this.seen.clear()
  }
}
