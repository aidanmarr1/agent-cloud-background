import { retryDecision, waitForRetry } from './ExecutionControl'
/**
 * Tool Retry Logic — handles transient failures with exponential backoff.
 *
 * Wraps tool execution with configurable retry behavior:
 *   - Only retries on transient errors (network, timeout, rate limit)
 *   - Does NOT retry on permanent errors such as invalid arguments
 *   - Exponential backoff with jitter to prevent thundering herd
 *   - Respects per-tool retry limits
 */

import type { Logger } from './Logger'
import { TOOL_RETRY_BASE_MS, TOOL_RETRY_MAX, TOOL_RETRY_MAX_DELAY_MS } from './config'
import { isNonIdempotentToolCall } from './toolSafety'

export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  backoffExponent: number
  jitterFraction: number  // 0-1, adds randomness to delay
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: TOOL_RETRY_MAX,
  baseDelayMs: TOOL_RETRY_BASE_MS,
  maxDelayMs: TOOL_RETRY_MAX_DELAY_MS,
  backoffExponent: 1.6,
  jitterFraction: 0.15,
}

// Per-tool retry configs (override defaults)
const TOOL_RETRY_CONFIGS: Record<string, Partial<RetryConfig>> = {
  web_search: { maxRetries: 0, baseDelayMs: 600 },
  browser_navigate: { maxRetries: 0, baseDelayMs: 750 },
  read_document: { maxRetries: 0, baseDelayMs: 500 },
  http_request: { maxRetries: 0, baseDelayMs: 750 },
  image_search: { maxRetries: 0, baseDelayMs: 750 },
}

export class ToolRetry {
  private logger: Logger | null

  constructor(logger?: Logger) {
    this.logger = logger ?? null
  }

  /**
   * Execute a tool with retry logic.
   * Returns the result on success, or throws on permanent failure.
   */
  async execute(
    toolName: string,
    fn: () => Promise<unknown>,
    signal?: AbortSignal,
    args?: unknown,
    deadlineAtMs?: number,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('Tool execution aborted')
    // No retry for side-effect tools
    if (isNonIdempotentToolCall(toolName, args)) {
      return fn()
    }

    const config = this.getConfig(toolName)
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Tool execution aborted')
      try {
        return await fn()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        const decision = retryDecision(lastError, attempt, config, { signal, sideEffects: isNonIdempotentToolCall(toolName, args), deadlineAtMs })
        if (!decision.retry) throw lastError
        this.logger?.info(`Retrying ${toolName} (attempt ${attempt + 2}/${config.maxRetries + 1}) in ${decision.delayMs}ms`)
        await waitForRetry(decision.delayMs, signal)
      }
    }

    throw lastError || new Error(`${toolName} failed with no error`)
  }

  /**
   * Check if an error result (from a tool that returned instead of throwing)
   * should trigger a retry.
   */
  shouldRetryResult(toolName: string, result: unknown, args?: unknown): boolean {
    if (isNonIdempotentToolCall(toolName, args)) return false

    if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
      const errorMsg = String((result as Record<string, unknown>).error)
      return retryDecision(new Error(errorMsg), 0, this.getConfig(toolName), {
        sideEffects: isNonIdempotentToolCall(toolName, args),
      }).retry
    }

    return false
  }

  private getConfig(toolName: string): RetryConfig {
    const override = TOOL_RETRY_CONFIGS[toolName] || {}
    return { ...DEFAULT_CONFIG, ...override }
  }
}
