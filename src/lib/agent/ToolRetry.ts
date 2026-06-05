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
  read_document: { maxRetries: 1, baseDelayMs: 500 },
  youtube_transcript: { maxRetries: 1, baseDelayMs: 500 },
  http_request: { maxRetries: 1, baseDelayMs: 750 },
  image_search: { maxRetries: 1, baseDelayMs: 750 },
}

// Tools that should never be retried
const NO_RETRY_TOOLS = new Set([
  'create_file',     // Side effects — don't double-create
  'edit_file',       // Side effects
  'append_file',     // Side effects — don't double-append
  'export_pdf',      // Side effects — don't double-write/export
  'delete_file',     // Side effects
  'browser_fill_form',
  'browser_action_sequence',
  'execute_command', // Side effects — could run twice
  'run_code',        // Side effects
])

// Error patterns that indicate transient failures (worth retrying)
const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ENETUNREACH/i,
  /socket hang up/i,
  /network error/i,
  /fetch failed/i,
  /\b429\b/,
  /rate limit/i,
  /temporarily unavailable/i,
  /\b(502|503|504)\b/,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
]

// Error patterns that are permanent (never retry)
const PERMANENT_PATTERNS = [
  /BLOCKED/i,
  /already exists/i,
  /already searched/i,
  /disabled/i,
  /invalid.*argument/i,
  /not found/i,
  /\b(401|403)\b/,
  /forbidden/i,
  /unauthorized/i,
]

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
  ): Promise<unknown> {
    // No retry for side-effect tools
    if (NO_RETRY_TOOLS.has(toolName)) {
      return fn()
    }

    const config = this.getConfig(toolName)
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Check if this is a permanent error (don't retry)
        if (this.isPermanentError(lastError)) {
          this.logger?.debug(`Permanent error for ${toolName}, not retrying`, {
            error: lastError.message,
          })
          throw lastError
        }

        // Check if this is retryable
        if (!this.isTransientError(lastError)) {
          this.logger?.debug(`Unknown error type for ${toolName}, not retrying`, {
            error: lastError.message,
          })
          throw lastError
        }

        // Don't retry if this was the last attempt
        if (attempt >= config.maxRetries) {
          this.logger?.warn(`${toolName} failed after ${attempt + 1} attempts`, {
            error: lastError.message,
          })
          throw lastError
        }

        // Calculate backoff delay
        const delay = this.calculateDelay(attempt, config)
        this.logger?.info(`Retrying ${toolName} (attempt ${attempt + 2}/${config.maxRetries + 1}) in ${delay}ms`, {
          error: lastError.message,
        })

        await new Promise(r => setTimeout(r, delay))
      }
    }

    throw lastError || new Error(`${toolName} failed with no error`)
  }

  /**
   * Check if an error result (from a tool that returned instead of throwing)
   * should trigger a retry.
   */
  shouldRetryResult(toolName: string, result: unknown): boolean {
    if (NO_RETRY_TOOLS.has(toolName)) return false

    if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
      const errorMsg = String((result as Record<string, unknown>).error)
      // Check for transient patterns in the error message
      return TRANSIENT_PATTERNS.some(p => p.test(errorMsg))
        && !PERMANENT_PATTERNS.some(p => p.test(errorMsg))
    }

    return false
  }

  private getConfig(toolName: string): RetryConfig {
    const override = TOOL_RETRY_CONFIGS[toolName] || {}
    return { ...DEFAULT_CONFIG, ...override }
  }

  private isTransientError(error: Error): boolean {
    return TRANSIENT_PATTERNS.some(p => p.test(error.message))
  }

  private isPermanentError(error: Error): boolean {
    return PERMANENT_PATTERNS.some(p => p.test(error.message))
  }

  private calculateDelay(attempt: number, config: RetryConfig): number {
    const baseDelay = config.baseDelayMs * Math.pow(config.backoffExponent, attempt)
    const capped = Math.min(baseDelay, config.maxDelayMs)
    // Small symmetric jitter keeps retries from bunching without making them feel stalled.
    const jitter = capped * config.jitterFraction * (Math.random() * 2 - 1)
    return Math.max(100, Math.round(capped + jitter))
  }
}
