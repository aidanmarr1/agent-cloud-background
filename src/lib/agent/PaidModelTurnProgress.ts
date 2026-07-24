export interface PaidModelTurnProgressSnapshot {
  iteration: number
  stepIdxBefore: number
  visibleText: boolean
  acceptedToolCall: boolean
  terminalAction?: boolean
  internalRecoveryScheduled?: 'malformed_tool_arguments' | 'display_contract'
}

export type PaidModelTurnProgressDecision =
  | { kind: 'progress'; consecutiveNoProgressTurns: 0; consecutiveInternalRecoveryTurns: 0 }
  | {
      kind: 'allow_internal_recovery'
      consecutiveNoProgressTurns: number
      consecutiveInternalRecoveryTurns: number
    }
  | {
      kind: 'allow_recovery'
      consecutiveNoProgressTurns: number
      consecutiveInternalRecoveryTurns: number
    }
  | {
      kind: 'stop'
      consecutiveNoProgressTurns: number
      consecutiveInternalRecoveryTurns: number
      reason: 'generic_no_progress' | 'internal_recovery_cap'
    }

export const MAX_CONSECUTIVE_PAID_INTERNAL_RECOVERY_TURNS = 2
export const MAX_CONSECUTIVE_PAID_NO_PROGRESS_TURNS = 2

export function paidModelTurnMadeProgress(
  turn: PaidModelTurnProgressSnapshot,
  currentStepIdx: number,
): boolean {
  return turn.visibleText ||
    turn.acceptedToolCall ||
    turn.terminalAction === true ||
    currentStepIdx !== turn.stepIdxBefore
}

export function decidePaidModelTurnProgress(
  turn: PaidModelTurnProgressSnapshot,
  currentStepIdx: number,
  consecutiveNoProgressTurns: number,
  consecutiveInternalRecoveryTurns = 0,
): PaidModelTurnProgressDecision {
  if (paidModelTurnMadeProgress(turn, currentStepIdx)) {
    return {
      kind: 'progress',
      consecutiveNoProgressTurns: 0,
      consecutiveInternalRecoveryTurns: 0,
    }
  }

  if (turn.internalRecoveryScheduled) {
    if (consecutiveInternalRecoveryTurns < MAX_CONSECUTIVE_PAID_INTERNAL_RECOVERY_TURNS) {
      return {
        kind: 'allow_internal_recovery',
        consecutiveNoProgressTurns,
        consecutiveInternalRecoveryTurns: consecutiveInternalRecoveryTurns + 1,
      }
    }
    return {
      kind: 'stop',
      consecutiveNoProgressTurns,
      consecutiveInternalRecoveryTurns,
      reason: 'internal_recovery_cap',
    }
  }

  if (consecutiveNoProgressTurns < MAX_CONSECUTIVE_PAID_NO_PROGRESS_TURNS) {
    return {
      kind: 'allow_recovery',
      consecutiveNoProgressTurns: consecutiveNoProgressTurns + 1,
      consecutiveInternalRecoveryTurns,
    }
  }

  return {
    kind: 'stop',
    consecutiveNoProgressTurns,
    consecutiveInternalRecoveryTurns,
    reason: 'generic_no_progress',
  }
}
