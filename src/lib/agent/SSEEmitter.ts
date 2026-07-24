import { encodeSSE } from '@/lib/stream'
import type { SSEEvent, Artifact, SearchResult, BrowseResult, TerminalResult, FileResult, BrowserResult, StepAdvanceStatus } from '@/types'
import type { ProgressUpdatePlacement, ToolStartMetadata } from '@/types/events'
import type { CreditLedgerEvent, CreditTokenUsage } from '@/lib/creditPolicy'
import { userErrorMessage } from '@/lib/errorMessages'
import {
  redactTerminalOutputSecrets,
  sanitizeToolResultForEvent,
  sanitizeToolStartArgs,
} from './toolEventSanitizer'

interface SSEEmitterOptions {
  keepAliveMs?: number
}

export interface AgentEventEmitter {
  readonly isClosed: boolean
  readonly terminalStatus: 'done' | 'error' | null
  flush?(): Promise<void>
  heartbeat(): void
  textDelta(content: string): void
  progressUpdate(content: string, placement?: ProgressUpdatePlacement): void
  reasoningDelta(content: string): void
  reasoningDone(): void
  toolStart(id: string, name: string, args: Record<string, unknown>, metadata?: ToolStartMetadata): void
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

const sanitizedEmitterCache = new WeakMap<object, AgentEventEmitter>()

/**
 * Applies the durable tool-event privacy boundary to any emitter implementation.
 * Background task emitters do not extend SSEEmitter, so the agent loop wraps its
 * emitter once and every normal, recovery, and early-error tool path is covered.
 */
export function sanitizeAgentEventEmitter(emitter: AgentEventEmitter): AgentEventEmitter {
  const cached = sanitizedEmitterCache.get(emitter as object)
  if (cached) return cached

  const wrapped: AgentEventEmitter = {
    get isClosed() { return emitter.isClosed },
    get terminalStatus() { return emitter.terminalStatus },
    async flush() { await emitter.flush?.() },
    heartbeat() { emitter.heartbeat() },
    textDelta(content) { emitter.textDelta(content) },
    progressUpdate(content, placement) { emitter.progressUpdate(content, placement) },
    reasoningDelta(content) { emitter.reasoningDelta(content) },
    reasoningDone() { emitter.reasoningDone() },
    toolStart(id, name, args, metadata) {
      emitter.toolStart(id, name, sanitizeToolStartArgs(name, args), metadata)
    },
    toolResult(id, name, result) {
      emitter.toolResult(id, name, sanitizeToolResultForEvent(name, result) as typeof result)
    },
    browserFrame(frame) { emitter.browserFrame(frame) },
    terminalOutput(id, stream, data) {
      emitter.terminalOutput(id, stream, redactTerminalOutputSecrets(data))
    },
    fileContentStart(id, path, toolName) { emitter.fileContentStart(id, path, toolName) },
    fileContentDelta(id, content) { emitter.fileContentDelta(id, content) },
    plan(items) { emitter.plan(items) },
    artifactCreated(artifact) { emitter.artifactCreated(artifact) },
    creditEvent(entry) { emitter.creditEvent(entry) },
    stepAdvance(status, reason) { emitter.stepAdvance(status, reason) },
    done(usage) { emitter.done(usage) },
    error(message) { emitter.error(message) },
    close() { emitter.close() },
  }
  sanitizedEmitterCache.set(emitter as object, wrapped)
  sanitizedEmitterCache.set(wrapped as object, wrapped)
  return wrapped
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

  async flush(): Promise<void> {
    // Direct response streams enqueue synchronously; durable task emitters
    // override this to await their persistence chain.
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private emit(event: SSEEvent, options: { countAsActivity?: boolean } = {}): void {
    if (this._isClosed) return
    if (this._terminalStatus && event.type !== this._terminalStatus) return
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

  progressUpdate(content: string, placement: ProgressUpdatePlacement = {}): void {
    this.emit({ type: 'progress_update', content, ...placement })
  }

  reasoningDelta(content: string): void {
    this.emit({ type: 'reasoning_delta', content } as SSEEvent)
  }

  reasoningDone(): void {
    this.emit({ type: 'reasoning_done' } as SSEEvent)
  }

  toolStart(id: string, name: string, args: Record<string, unknown>, metadata: ToolStartMetadata = {}): void {
    this.emit({
      type: 'tool_start',
      id,
      name,
      args: sanitizeToolStartArgs(name, args),
      ...(metadata.provisional ? { provisional: true } : {}),
    })
  }

  toolResult(id: string, name: string, result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult): void {
    this.emit({ type: 'tool_result', id, name, result: sanitizeToolResultForEvent(name, result) as typeof result })
  }

  browserFrame(frame: string): void {
    this.emit({ type: 'browser_frame', frame, timestamp: Date.now() } as SSEEvent, { countAsActivity: false })
  }

  terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string): void {
    this.emit({ type: 'terminal_output', id, stream, data: redactTerminalOutputSecrets(data) } as SSEEvent)
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
    if (this._isClosed || this._terminalStatus) return
    this._terminalStatus = 'done'
    this.emit({ type: 'done', usage })
  }

  error(message: unknown): void {
    if (this._isClosed || this._terminalStatus) return
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
