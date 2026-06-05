/**
 * BatchScheduler — Coalesces rapid state updates into single animation frames.
 *
 * During SSE streaming, events arrive faster than the browser can render
 * (text_delta every ~10-50ms, terminal_output every ~10ms). Each event previously
 * triggered a full Zustand state update (deep-copying the conversations array),
 * causing the main thread to freeze.
 *
 * This scheduler buffers updates and flushes once per animation frame (~16ms),
 * consolidating 5-20 events into a single state update + render.
 */

type FlushCallback = () => void

export class BatchScheduler {
  private pending = new Map<string, FlushCallback>()
  private rafId: number | null = null

  /**
   * Schedule an action to run on the next animation frame.
   * If the same key is scheduled multiple times before flush,
   * only the LAST action runs (latest state wins).
   */
  schedule(key: string, action: FlushCallback): void {
    this.pending.set(key, action)
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flush())
    }
  }

  /**
   * Flush all pending actions immediately (used on cleanup/done).
   */
  flushSync(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.flush()
  }

  private flush(): void {
    this.rafId = null
    const actions = Array.from(this.pending.values())
    this.pending.clear()
    for (const action of actions) {
      action()
    }
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.pending.clear()
  }
}
