/**
 * ErrorRecoveryEngine — centralized failure diagnosis, root-cause analysis,
 * and recovery strategy selection.
 *
 * Replaces ad-hoc error handling scattered across ToolRetry, AgentState,
 * ToolPipeline, PolicyEngine, and AgentLoop with a single, composable engine.
 *
 * Responsibilities:
 *   - Classify errors into structured root causes via pattern matching
 *   - Track failure history for pattern detection
 *   - Select the best recovery strategy given context without inventing substitute work
 */

import type { RecoveryContext } from './types'

// ── Root Cause Types ──────────────────────────────────────────────────────────

export type RootCause =
  | { type: 'network'; detail: 'timeout' | 'dns' | 'connection_refused' | 'rate_limited' }
  | { type: 'access'; detail: 'access_denied' | 'auth_required' | 'geo_restricted' | 'paywall' }
  | { type: 'data'; detail: 'not_found' | 'format_error' | 'empty_response' | 'corrupted' }
  | { type: 'execution'; detail: 'syntax_error' | 'runtime_error' | 'dependency_missing' | 'permission_denied' }
  | { type: 'resource'; detail: 'disk_full' | 'memory_exceeded' | 'timeout_exceeded' }
  | { type: 'configuration'; detail: 'invalid_args' | 'missing_context' | 'incompatible_state' }

// ── Failure & Diagnosis ───────────────────────────────────────────────────────

export interface ToolFailure {
  toolName: string
  error: Error | string
  args?: Record<string, unknown>
  durationMs?: number
  attemptNumber?: number
}

export interface DiagnosisResult {
  rootCause: RootCause
  confidence: number
  affectedTools: string[]
  affectedSteps: string[]
  isTransient: boolean
  userExplanation: string
}

// ── Recovery Strategies ───────────────────────────────────────────────────────

export type RecoveryStrategy =
  | { type: 'retry_with_backoff'; maxAttempts: number; backoffMs: number }
  | { type: 'replan'; reason: string; constraint: string }
  | { type: 'degrade_gracefully'; message: string; reducedCapabilities: string[] }
  | { type: 'abort'; userMessage: string }

// ── Pattern Matching Tables ───────────────────────────────────────────────────

interface ErrorPattern {
  pattern: RegExp
  rootCause: RootCause
  isTransient: boolean
  confidence: number
  explanation: string
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // Network errors
  { pattern: /ETIMEDOUT|timed?\s*out|timeout/i, rootCause: { type: 'network', detail: 'timeout' }, isTransient: true, confidence: 0.9, explanation: 'The request timed out' },
  { pattern: /ENOTFOUND|dns|getaddrinfo/i, rootCause: { type: 'network', detail: 'dns' }, isTransient: false, confidence: 0.95, explanation: 'DNS resolution failed' },
  { pattern: /ECONNREFUSED|connection refused/i, rootCause: { type: 'network', detail: 'connection_refused' }, isTransient: true, confidence: 0.9, explanation: 'The server refused the connection' },
  { pattern: /429|rate.?limit|too many requests/i, rootCause: { type: 'network', detail: 'rate_limited' }, isTransient: true, confidence: 0.95, explanation: 'Rate limited by the server' },
  { pattern: /502|503|504|bad gateway|service unavailable|gateway timeout/i, rootCause: { type: 'network', detail: 'timeout' }, isTransient: true, confidence: 0.8, explanation: 'The server is temporarily unavailable' },
  { pattern: /ECONNRESET|ENETUNREACH|socket hang up|network error|fetch failed/i, rootCause: { type: 'network', detail: 'connection_refused' }, isTransient: true, confidence: 0.85, explanation: 'Network connection was interrupted' },

  // Access errors
  { pattern: /403|forbidden|captcha|human.?verification|access denied/i, rootCause: { type: 'access', detail: 'access_denied' }, isTransient: false, confidence: 0.85, explanation: 'The page reported an access or verification block' },
  { pattern: /401|unauthorized|auth.?required|login.?required/i, rootCause: { type: 'access', detail: 'auth_required' }, isTransient: false, confidence: 0.9, explanation: 'Authentication is required' },
  { pattern: /geo.?restrict|region.?block|not available in your/i, rootCause: { type: 'access', detail: 'geo_restricted' }, isTransient: false, confidence: 0.85, explanation: 'Content is geo-restricted' },
  { pattern: /paywall|subscription required|premium content/i, rootCause: { type: 'access', detail: 'paywall' }, isTransient: false, confidence: 0.85, explanation: 'Content is behind a paywall' },

  // Data errors
  { pattern: /404|not found/i, rootCause: { type: 'data', detail: 'not_found' }, isTransient: false, confidence: 0.9, explanation: 'The requested resource was not found' },
  { pattern: /parse error|JSON\.parse|format error|malformed/i, rootCause: { type: 'data', detail: 'format_error' }, isTransient: false, confidence: 0.85, explanation: 'The response data was in an unexpected format' },
  { pattern: /empty response|no results|no content|no data/i, rootCause: { type: 'data', detail: 'empty_response' }, isTransient: true, confidence: 0.7, explanation: 'The response was empty' },
  { pattern: /corrupt|invalid data|checksum/i, rootCause: { type: 'data', detail: 'corrupted' }, isTransient: false, confidence: 0.8, explanation: 'The data appears to be corrupted' },

  // Execution errors
  { pattern: /SyntaxError|syntax error|unexpected token/i, rootCause: { type: 'execution', detail: 'syntax_error' }, isTransient: false, confidence: 0.95, explanation: 'There is a syntax error in the code' },
  { pattern: /ReferenceError|TypeError|RangeError|runtime error/i, rootCause: { type: 'execution', detail: 'runtime_error' }, isTransient: false, confidence: 0.85, explanation: 'A runtime error occurred' },
  { pattern: /module not found|cannot find module|dependency|ModuleNotFoundError|no module named|import error/i, rootCause: { type: 'execution', detail: 'dependency_missing' }, isTransient: false, confidence: 0.9, explanation: 'A required dependency is missing' },
  { pattern: /EACCES|permission denied|EPERM/i, rootCause: { type: 'execution', detail: 'permission_denied' }, isTransient: false, confidence: 0.95, explanation: 'Permission was denied' },

  // Resource errors
  { pattern: /ENOSPC|disk full|no space left/i, rootCause: { type: 'resource', detail: 'disk_full' }, isTransient: false, confidence: 0.95, explanation: 'Disk space is full' },
  { pattern: /out of memory|ENOMEM|memory exceeded|heap|OOM/i, rootCause: { type: 'resource', detail: 'memory_exceeded' }, isTransient: false, confidence: 0.9, explanation: 'Memory limit was exceeded' },
  { pattern: /execution.?timeout|time.?limit|exceeded.*time/i, rootCause: { type: 'resource', detail: 'timeout_exceeded' }, isTransient: true, confidence: 0.8, explanation: 'The execution time limit was exceeded' },

  // Configuration errors
  { pattern: /invalid.?arg|bad.?argument|missing.?param|required.?parameter/i, rootCause: { type: 'configuration', detail: 'invalid_args' }, isTransient: false, confidence: 0.85, explanation: 'Invalid or missing arguments were provided' },
  { pattern: /missing.?context|context.?required|state.?not.?found/i, rootCause: { type: 'configuration', detail: 'missing_context' }, isTransient: false, confidence: 0.8, explanation: 'Required context is missing' },
  { pattern: /incompatible|version.?mismatch|conflict/i, rootCause: { type: 'configuration', detail: 'incompatible_state' }, isTransient: false, confidence: 0.75, explanation: 'Incompatible state or version conflict' },
]

// Transient root cause details that are worth retrying
const TRANSIENT_DETAILS = new Set([
  'timeout', 'rate_limited', 'connection_refused', 'empty_response', 'timeout_exceeded',
])

// Maximum failures to keep in history
const MAX_FAILURE_HISTORY = 50

// Consecutive failures that mark a tool as unhealthy
const UNHEALTHY_THRESHOLD = 3

// ── Engine ─────────────────────────────────────────────────────────────────────

export class ErrorRecoveryEngine {
  private failureHistory: ToolFailure[] = []
  // Session learning: track tool success rates.
  private toolSuccessCount: Map<string, number> = new Map()
  private toolFailureCount: Map<string, number> = new Map()
  private domainFailures: Map<string, Set<string>> = new Map() // domain → Set<toolName>

  /**
   * Diagnose a tool failure by matching its error message against known patterns.
   * Returns a structured diagnosis with root cause, confidence, and explanation.
   */
  diagnose(failure: ToolFailure): DiagnosisResult {
    const errorMessage = failure.error instanceof Error ? failure.error.message : String(failure.error)

    // Find the best matching pattern
    let bestMatch: ErrorPattern | null = null
    let bestConfidence = 0

    for (const pattern of ERROR_PATTERNS) {
      if (pattern.pattern.test(errorMessage) && pattern.confidence > bestConfidence) {
        bestMatch = pattern
        bestConfidence = pattern.confidence
      }
    }

    // Default to a generic execution:runtime_error if no pattern matches
    if (!bestMatch) {
      return {
        rootCause: { type: 'execution', detail: 'runtime_error' },
        confidence: 0.3,
        affectedTools: [failure.toolName],
        affectedSteps: [],
        isTransient: false,
        userExplanation: `Tool "${failure.toolName}" failed: ${errorMessage.slice(0, 150)}`,
      }
    }

    // Adjust confidence based on additional signals
    let confidence = bestMatch.confidence
    if (failure.durationMs !== undefined) {
      // Long durations make timeout diagnoses more confident
      if (bestMatch.rootCause.type === 'network' && bestMatch.rootCause.detail === 'timeout' && failure.durationMs > 10000) {
        confidence = Math.min(1, confidence + 0.05)
      }
    }

    // Check if this tool has a pattern of the same failure
    const recentSameToolFailures = this.failureHistory.filter(
      f => f.toolName === failure.toolName
    ).length
    if (recentSameToolFailures >= 2) {
      confidence = Math.min(1, confidence + 0.05)
    }

    return {
      rootCause: bestMatch.rootCause,
      confidence,
      affectedTools: [failure.toolName],
      affectedSteps: [],
      isTransient: bestMatch.isTransient,
      userExplanation: bestMatch.explanation,
    }
  }

  /**
   * Select the best recovery strategy based on the diagnosis and current context.
   *
   * Priority order:
   *   1. Transient + low attempt count  -> retry_with_backoff
   *   2. Non-critical step              -> replan around the failing tool
   *   3. Multiple cascading failures    -> replan
   *   4. Last resort                    -> degrade_gracefully or abort
   */
  selectStrategy(diagnosis: DiagnosisResult, context: RecoveryContext): RecoveryStrategy {
    // 1. Retry transient errors if we have budget
    if (diagnosis.isTransient && context.consecutiveFailures < 3 && context.remainingBudget > 2) {
      const backoffMs = diagnosis.rootCause.type === 'network' && diagnosis.rootCause.detail === 'rate_limited'
        ? 3000
        : 1500
      return {
        type: 'retry_with_backoff',
        maxAttempts: 3,
        backoffMs,
      }
    }

    // 2. Replan non-critical steps instead of skipping them. A step that did
    // not complete must remain visible as unresolved; later steps cannot depend
    // on fabricated progress.
    if (context.currentStepId && context.remainingBudget > 5 && !context.isLastStep) {
      const isCritical = this.isStepCritical(context.currentStepTitle)
      if (!isCritical) {
        return {
          type: 'replan',
          reason: `Current approach hit a ${diagnosis.rootCause.type} error: ${diagnosis.userExplanation}`,
          constraint: `Do not rely on ${diagnosis.affectedTools.join(', ') || 'the failing tool'} for this step`,
        }
      }
    }

    // 3. Replan when there are cascading failures
    if (context.totalFailures >= 5 && context.remainingBudget > 10) {
      return {
        type: 'replan',
        reason: `Multiple failures (${context.totalFailures} total) suggest the current approach is not viable`,
        constraint: `Avoid tools: ${diagnosis.affectedTools.join(', ')}`,
      }
    }

    // 4. Degrade gracefully or abort
    if (context.remainingBudget <= 2) {
      return {
        type: 'abort',
        userMessage: `Unable to complete: ${diagnosis.userExplanation}. Budget exhausted with ${context.totalFailures} failures.`,
      }
    }

    return {
      type: 'degrade_gracefully',
      message: `Proceeding with reduced capabilities due to: ${diagnosis.userExplanation}`,
      reducedCapabilities: diagnosis.affectedTools,
    }
  }

  /**
   * Record a failure for pattern detection and health tracking.
   */
  recordFailure(failure: ToolFailure): void {
    this.failureHistory.push(failure)
    if (this.failureHistory.length > MAX_FAILURE_HISTORY) {
      this.failureHistory.shift()
    }
  }

  /**
   * Check if a tool is experiencing repeated failures (unhealthy).
   */
  isToolUnhealthy(toolName: string): boolean {
    const recent = this.failureHistory.slice(-10)
    let consecutiveCount = 0

    // Count consecutive failures for this tool from the end of history
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].toolName === toolName) {
        consecutiveCount++
      } else {
        break
      }
    }

    return consecutiveCount >= UNHEALTHY_THRESHOLD
  }

  /**
   * Given a failing tool, find all plan step IDs that depend on it.
   */
  getAffectedSteps(toolName: string, planStepTools: Map<string, string[]>): string[] {
    const affected: string[] = []
    for (const [stepId, tools] of planStepTools) {
      if (tools.includes(toolName)) {
        affected.push(stepId)
      }
    }
    return affected
  }

  /**
   * Heuristic: determine if a step title suggests it is critical to the task.
   * Deliverable / build / final steps are considered critical.
   */
  private isStepCritical(stepTitle?: string): boolean {
    if (!stepTitle) return true // Assume critical when unknown
    const lower = stepTitle.toLowerCase()
    return /\b(deliver|final|create|build|write|produce|output|submit)\b/.test(lower)
  }

  // ── Session Learning ─────────────────────────────────────────────────────

  /**
   * Record a successful tool execution so the engine can learn what works.
   */
  recordSuccess(toolName: string, domain?: string): void {
    this.toolSuccessCount.set(toolName, (this.toolSuccessCount.get(toolName) || 0) + 1)
  }

  /**
   * Record a domain-specific failure so we can avoid that domain with that tool.
   */
  recordDomainFailure(toolName: string, url: string): void {
    try {
      const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
      if (!this.domainFailures.has(domain)) {
        this.domainFailures.set(domain, new Set())
      }
      this.domainFailures.get(domain)!.add(toolName)
    } catch { /* invalid URL */ }
    this.toolFailureCount.set(toolName, (this.toolFailureCount.get(toolName) || 0) + 1)
  }

  /**
   * Check if a tool has consistently failed on a specific domain.
   */
  isToolUnhealthyForDomain(toolName: string, url: string): boolean {
    try {
      const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
      return this.domainFailures.get(domain)?.has(toolName) ?? false
    } catch {
      return false
    }
  }

  /**
   * Get the tool success rate in this session (0-1). Returns 1.0 if never called.
   */
  getToolSuccessRate(toolName: string): number {
    const successes = this.toolSuccessCount.get(toolName) || 0
    const failures = this.toolFailureCount.get(toolName) || 0
    const total = successes + failures
    if (total === 0) return 1.0
    return successes / total
  }

  /**
   * Build a context string describing tool health for injection into prompts.
   * Only includes tools that have meaningfully failed.
   */
  getSessionHealthSummary(): string | null {
    const unhealthy: string[] = []
    const domainBlocked: string[] = []

    for (const [tool, failures] of this.toolFailureCount) {
      const rate = this.getToolSuccessRate(tool)
      if (rate < 0.5 && failures >= 2) {
        unhealthy.push(`${tool}: ${Math.round(rate * 100)}% success`)
      }
    }

    for (const [domain, tools] of this.domainFailures) {
      if (tools.size >= 2) {
        domainBlocked.push(`${domain}: blocked by ${[...tools].join(', ')}`)
      }
    }

    if (unhealthy.length === 0 && domainBlocked.length === 0) return null

    const parts: string[] = []
    if (unhealthy.length > 0) parts.push(`Unreliable tools: ${unhealthy.join('; ')}`)
    if (domainBlocked.length > 0) parts.push(`Blocked domains: ${domainBlocked.join('; ')}`)
    return parts.join('\n')
  }

}
