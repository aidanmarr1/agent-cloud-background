/**
 * UserNotifier — centralized user-facing error communication.
 *
 * Translates internal diagnosis results and recovery strategies into
 * user-friendly notifications with appropriate severity levels.
 *
 * Rules:
 *   - Transient retries          -> silent (no user notification)
 *   - Replan needed              -> warning ("Adjusting plan due to...")
 *   - Abort                      -> error ("Unable to complete: ...")
 *   - Completion with failures   -> summary of what was accomplished vs what wasn't
 */

import type { DiagnosisResult, RecoveryStrategy } from './ErrorRecoveryEngine'

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationSeverity = 'silent' | 'info' | 'warning' | 'error'

export interface UserNotification {
  severity: NotificationSeverity
  message: string
  details?: string
}

// ── UserNotifier ──────────────────────────────────────────────────────────────

export class UserNotifier {
  /**
   * Determine notification severity based on the diagnosis and chosen strategy.
   */
  getSeverity(diagnosis: DiagnosisResult, strategy: RecoveryStrategy): NotificationSeverity {
    switch (strategy.type) {
      case 'retry_with_backoff':
        return 'silent'

      case 'replan':
        return 'warning'

      case 'degrade_gracefully':
        // Degrade to warning only when confidence in the diagnosis is high
        return diagnosis.confidence >= 0.8 ? 'warning' : 'info'

      case 'abort':
        return 'error'

      default:
        return 'info'
    }
  }

  /**
   * Format a user-friendly notification from a diagnosis and recovery strategy.
   */
  formatNotification(diagnosis: DiagnosisResult, strategy: RecoveryStrategy): UserNotification {
    const severity = this.getSeverity(diagnosis, strategy)

    switch (strategy.type) {
      case 'retry_with_backoff':
        return {
          severity,
          message: '',
        }

      case 'replan':
        return {
          severity,
          message: 'Adjusting plan due to repeated failures',
          details: `${strategy.reason}. Constraint: ${strategy.constraint}.`,
        }

      case 'degrade_gracefully':
        return {
          severity,
          message: strategy.message,
          details: `Reduced capabilities: ${strategy.reducedCapabilities.join(', ')}.`,
        }

      case 'abort':
        return {
          severity,
          message: strategy.userMessage,
        }

      default:
        return {
          severity: 'info',
          message: diagnosis.userExplanation,
        }
    }
  }

  /**
   * Format a completion summary when the task had failures.
   *
   * Produces a concise report of what was accomplished versus what was skipped
   * or degraded, suitable for display to the end user.
   */
  formatCompletionWithFailures(
    completedSteps: number,
    totalSteps: number,
    failures: DiagnosisResult[],
  ): string {
    const parts: string[] = []

    // Completion line
    if (completedSteps === totalSteps) {
      parts.push(`Completed all ${totalSteps} steps.`)
    } else {
      parts.push(`Completed ${completedSteps} of ${totalSteps} steps.`)
    }

    // Summarize failures if any
    if (failures.length > 0) {
      // Group by root cause type
      const grouped = new Map<string, DiagnosisResult[]>()
      for (const f of failures) {
        const key = f.rootCause.type
        const list = grouped.get(key) || []
        list.push(f)
        grouped.set(key, list)
      }

      const issues: string[] = []
      for (const [causeType, diags] of grouped) {
        const tools = [...new Set(diags.flatMap(d => d.affectedTools))]
        const label = this.causeTypeLabel(causeType)
        if (tools.length > 0) {
          issues.push(`${label} (affected: ${tools.join(', ')})`)
        } else {
          issues.push(label)
        }
      }

      parts.push(`Issues encountered: ${issues.join('; ')}.`)
    }

    // Offer guidance when steps were missed
    if (completedSteps < totalSteps) {
      const missed = totalSteps - completedSteps
      parts.push(
        missed === 1
          ? 'One step could not be completed due to the errors above.'
          : `${missed} steps could not be completed due to the errors above.`,
      )
    }

    return parts.join(' ')
  }

  /**
   * Human-readable label for a root cause type.
   */
  private causeTypeLabel(causeType: string): string {
    switch (causeType) {
      case 'network': return 'network issues'
      case 'access': return 'access restrictions'
      case 'data': return 'data errors'
      case 'execution': return 'execution errors'
      case 'resource': return 'resource limits'
      case 'configuration': return 'configuration problems'
      default: return causeType
    }
  }
}
