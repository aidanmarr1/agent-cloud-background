import { encodeSSE } from '@/lib/stream'
import type { SSEEvent, Artifact, SearchResult, BrowseResult, TerminalResult, FileResult, BrowserResult, StepAdvanceStatus } from '@/types'
import type { CreditLedgerEvent, CreditTokenUsage } from '@/lib/creditPolicy'
import { userErrorMessage } from '@/lib/errorMessages'

interface SSEEmitterOptions {
  keepAliveMs?: number
}

export interface AgentEventEmitter {
  readonly isClosed: boolean
  readonly terminalStatus: 'done' | 'error' | null
  heartbeat(): void
  textDelta(content: string): void
  reasoningDelta(content: string): void
  reasoningDone(): void
  toolStart(id: string, name: string, args: Record<string, unknown>): void
  toolResult(id: string, name: string, result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult): void
  browserFrame(frame: string): void
  terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string): void
  fileContentStart(id: string, path: string, toolName?: string): void
  fileContentDelta(id: string, content: string): void
  plan(items: string[]): void
  artifactCreated(artifact: Artifact): void
  creditEvent(entry: CreditLedgerEvent): void
  stepAdvance(status?: StepAdvanceStatus, reason?: string): void
  done(usage?: CreditTokenUsage): void
  error(message: unknown): void
  close(): void
}

export class SSEEmitter implements AgentEventEmitter {
  private controller: ReadableStreamDefaultController<Uint8Array>
  private encoder = new TextEncoder()
  private _isClosed = false
  private _terminalStatus: 'done' | 'error' | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private lastEmitAt = Date.now()

  constructor(controller: ReadableStreamDefaultController<Uint8Array>, options: SSEEmitterOptions = {}) {
    this.controller = controller
    // Track close state
    const originalClose = controller.close.bind(controller)
    controller.close = () => {
      this.clearKeepAlive()
      this._isClosed = true
      try {
        originalClose()
      } catch {
        // Controller may already be closed by the stream infrastructure
      }
    }

    const keepAliveMs = options.keepAliveMs ?? 15_000
    if (keepAliveMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        if (this._isClosed) {
          this.clearKeepAlive()
          return
        }
        if (Date.now() - this.lastEmitAt >= keepAliveMs - 500) {
          this.heartbeat()
        }
      }, keepAliveMs)
    }
  }

  get isClosed(): boolean {
    return this._isClosed
  }

  get terminalStatus(): 'done' | 'error' | null {
    return this._terminalStatus
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private emit(event: SSEEvent, options: { countAsActivity?: boolean } = {}): void {
    if (this._isClosed) return
    try {
      this.controller.enqueue(this.encoder.encode(encodeSSE(event)))
      if (options.countAsActivity !== false) {
        this.lastEmitAt = Date.now()
      }
    } catch (err) {
      // Controller was closed externally (client disconnect, stream cancel).
      // Mark as closed so subsequent emits are silently skipped.
      console.warn('[SSEEmitter] Stream closed, failed to emit event:', event.type, err instanceof Error ? err.message : '')
      this.clearKeepAlive()
      this._isClosed = true
    }
  }

  heartbeat(): void {
    this.emit({ type: 'heartbeat', timestamp: Date.now() }, { countAsActivity: false })
  }

  textDelta(content: string): void {
    this.emit({ type: 'text_delta', content })
  }

  reasoningDelta(content: string): void {
    this.emit({ type: 'reasoning_delta', content } as SSEEvent)
  }

  reasoningDone(): void {
    this.emit({ type: 'reasoning_done' } as SSEEvent)
  }

  toolStart(id: string, name: string, args: Record<string, unknown>): void {
    this.emit({ type: 'tool_start', id, name, args })
  }

  toolResult(id: string, name: string, result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult): void {
    this.emit({ type: 'tool_result', id, name, result })
  }

  browserFrame(frame: string): void {
    this.emit({ type: 'browser_frame', frame, timestamp: Date.now() } as SSEEvent, { countAsActivity: false })
  }

  terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string): void {
    this.emit({ type: 'terminal_output', id, stream, data } as SSEEvent)
  }

  fileContentStart(id: string, path: string, toolName?: string): void {
    this.emit({ type: 'file_content_start', id, path, toolName } as SSEEvent)
  }

  fileContentDelta(id: string, content: string): void {
    this.emit({ type: 'file_content_delta', id, content } as SSEEvent)
  }

  plan(items: string[]): void {
    this.emit({ type: 'plan', items } as SSEEvent)
  }

  artifactCreated(artifact: Artifact): void {
    this.emit({ type: 'artifact_created', artifact } as SSEEvent)
  }

  creditEvent(entry: CreditLedgerEvent): void {
    this.emit({ type: 'credit_event', entry } as SSEEvent)
  }

  stepAdvance(status: StepAdvanceStatus = 'done', reason?: string): void {
    this.emit({ type: 'step_advance', status, reason } as SSEEvent)
  }

  done(usage?: CreditTokenUsage): void {
    this._terminalStatus = 'done'
    this.emit({ type: 'done', usage })
  }

  error(message: unknown): void {
    this._terminalStatus = 'error'
    this.emit({ type: 'error', message: userErrorMessage(message, 'The task stopped before it finished. Please try again.') })
  }

  close(): void {
    if (!this._isClosed) {
      this.clearKeepAlive()
      this._isClosed = true
      try {
        this.controller.close()
      } catch {
        // Already closed
      }
    }
  }
}
