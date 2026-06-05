/**
 * Structured error hierarchy for the agent system.
 *
 * Replaces string-matching error handling with typed, catchable error classes.
 * Each error carries structured data so callers can make decisions without parsing messages.
 */

// ── Base Error ──────────────────────────────────────────────────────────────

export class AgentError extends Error {
  readonly recoverable: boolean
  readonly code: string

  constructor(message: string, code: string, recoverable = false) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    this.recoverable = recoverable
  }
}

// ── Timeout Errors ──────────────────────────────────────────────────────────

export class TimeoutError extends AgentError {
  readonly elapsed: number
  readonly nudgeable: boolean

  constructor(
    message: string,
    opts: { elapsed: number; nudgeable: boolean }
  ) {
    super(message, 'TIMEOUT', opts.nudgeable)
    this.name = 'TimeoutError'
    this.elapsed = opts.elapsed
    this.nudgeable = opts.nudgeable
  }
}

export class IterationTimeoutError extends TimeoutError {
  constructor(elapsed: number) {
    super(`Iteration timed out after ${Math.round(elapsed / 1000)}s`, {
      elapsed,
      nudgeable: false,
    })
    this.name = 'IterationTimeoutError'
  }
}

export class InactivityTimeoutError extends TimeoutError {
  readonly partialContent: string

  constructor(elapsed: number, partialContent: string) {
    super(`No activity for ${Math.round(elapsed / 1000)}s`, {
      elapsed,
      nudgeable: true,
    })
    this.name = 'InactivityTimeoutError'
    this.partialContent = partialContent
  }
}

export class ContentOnlyTimeoutError extends TimeoutError {
  readonly charCount: number
  readonly partialContent: string

  constructor(elapsed: number, charCount: number, partialContent: string) {
    super(
      `Content-only streaming for ${Math.round(elapsed / 1000)}s (${charCount} chars) without tool calls`,
      { elapsed, nudgeable: true }
    )
    this.name = 'ContentOnlyTimeoutError'
    this.charCount = charCount
    this.partialContent = partialContent
  }
}

// ── Tool Errors ─────────────────────────────────────────────────────────────

export class ToolError extends AgentError {
  readonly toolName: string
  readonly toolCallId: string

  constructor(message: string, toolName: string, toolCallId: string, recoverable = true) {
    super(message, 'TOOL_ERROR', recoverable)
    this.name = 'ToolError'
    this.toolName = toolName
    this.toolCallId = toolCallId
  }
}

export class ToolParseError extends ToolError {
  readonly rawArguments: string

  constructor(toolName: string, toolCallId: string, rawArguments: string) {
    super(`Failed to parse arguments for ${toolName}`, toolName, toolCallId)
    this.name = 'ToolParseError'
    this.rawArguments = rawArguments.slice(0, 500)
  }
}

export class ToolTimeoutError extends ToolError {
  readonly timeoutMs: number
  readonly mayHaveSideEffects: boolean

  constructor(toolName: string, toolCallId: string, timeoutMs: number) {
    const sideEffectTools = ['create_file', 'execute_command', 'run_code', 'edit_file', 'append_file', 'export_pdf']
    const hasSideEffects = sideEffectTools.includes(toolName)
    super(
      `Tool "${toolName}" timed out after ${timeoutMs / 1000}s${hasSideEffects ? ' (may have partially completed)' : ''}`,
      toolName,
      toolCallId,
    )
    this.name = 'ToolTimeoutError'
    this.timeoutMs = timeoutMs
    this.mayHaveSideEffects = hasSideEffects
  }
}

export class ToolBlockedError extends ToolError {
  readonly reason: BlockReason

  constructor(toolName: string, toolCallId: string, reason: BlockReason) {
    super(`Tool "${toolName}" blocked: ${reason.type}`, toolName, toolCallId, true)
    this.name = 'ToolBlockedError'
    this.reason = reason
  }
}

export type BlockReason =
  | { type: 'duplicate_search'; query: string }
  | { type: 'duplicate_url'; url: string }
  | { type: 'file_already_exists'; path: string; attempts: number }
  | { type: 'circuit_breaker'; cooldownMs: number }
  | { type: 'search_disabled' }
  | { type: 'domain_blocked'; domain: string }

// ── Stream Errors ───────────────────────────────────────────────────────────

export class StreamError extends AgentError {
  readonly statusCode?: number

  constructor(message: string, statusCode?: number, recoverable = false) {
    super(message, 'STREAM_ERROR', recoverable)
    this.name = 'StreamError'
    this.statusCode = statusCode
  }
}

export class RateLimitError extends StreamError {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number, statusCode = 429) {
    super(`Rate limited (retry after ${Math.round(retryAfterMs / 1000)}s)`, statusCode, true)
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

// ── Security Errors ─────────────────────────────────────────────────────────

export class LeakageError extends AgentError {
  readonly matchCount: number

  constructor(matchCount: number) {
    super('System prompt leakage detected', 'LEAKAGE', false)
    this.name = 'LeakageError'
    this.matchCount = matchCount
  }
}

export class InjectionError extends AgentError {
  readonly pattern: string

  constructor(pattern: string) {
    super('Prompt injection detected', 'INJECTION', false)
    this.name = 'InjectionError'
    this.pattern = pattern
  }
}

// ── Budget Errors ───────────────────────────────────────────────────────────

export class BudgetExhaustedError extends AgentError {
  readonly iterationsUsed: number
  readonly iterationLimit: number

  constructor(iterationsUsed: number, iterationLimit: number) {
    super(
      `Budget exhausted: ${iterationsUsed}/${iterationLimit} iterations used`,
      'BUDGET_EXHAUSTED',
      false,
    )
    this.name = 'BudgetExhaustedError'
    this.iterationsUsed = iterationsUsed
    this.iterationLimit = iterationLimit
  }
}

// ── Type Guards ─────────────────────────────────────────────────────────────

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError
}

export function isNudgeableTimeout(err: unknown): err is TimeoutError & { partialContent: string } {
  return err instanceof TimeoutError && err.nudgeable
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError
}

export function isRecoverable(err: unknown): boolean {
  return err instanceof AgentError && err.recoverable
}
