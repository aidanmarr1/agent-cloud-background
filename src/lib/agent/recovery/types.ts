/**
 * Shared types for the error recovery subsystem.
 */

export interface RecoveryContext {
  currentStepId?: string
  currentStepTitle?: string
  isLastStep?: boolean
  remainingBudget: number
  totalFailures: number
  consecutiveFailures: number
  availableTools: string[]
}
