import type { AgentStateData } from './AgentState'
import { analyzeTaskIntent } from './TaskIntent'

export interface CompletionAuditResult {
  complete: boolean
  reason: string
  missing: string[]
  message: string
}

function hasFinalDeliverable(state: AgentStateData): boolean {
  return state.workLedger.deliverableCandidates.some(item => item.purpose === 'deliverable') ||
    state.emittedImageArtifacts.size > 0
}

function currentTaskText(state: AgentStateData): string {
  return [
    state.originalUserRequest || '',
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
    ...state.createdFiles,
  ].join(' ')
}

function requiresFinalDeliverable(state: AgentStateData): boolean {
  if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
  if (state.taskStrategy === 'browse') return false
  const userRequest = state.originalUserRequest || ''
  const taskIntent = analyzeTaskIntent([{ role: 'user', content: userRequest }])
  return state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative' ||
    taskIntent.requiresSavedArtifact
}

function isWebsiteLike(state: AgentStateData): boolean {
  if (!state.buildTask && state.taskStrategy !== 'build' && state.taskStrategy !== 'code') return false
  return /\b(next\.?js|website|web\s*site|webpage|landing page|site|page\.tsx|layout\.tsx|globals\.css|responsive|preview|localhost)\b/i.test(currentTaskText(state))
}

function unresolvedStepSummaries(state: AgentStateData): string[] {
  return [...state.stepFindings.entries()]
    .filter(([, finding]) => finding.startsWith('[INCOMPLETE]') || finding.startsWith('[BLOCKED]'))
    .map(([idx, finding]) => {
      const detail = finding.replace(/^\[(?:INCOMPLETE|BLOCKED)\]\s*/, '')
      const trimmed = detail.length > 180 ? `${detail.slice(0, 180)}...` : detail
      return `step ${idx + 1}${trimmed ? ` (${trimmed})` : ''}`
    })
}

export function auditAgentCompletion(
  state: AgentStateData,
  terminalReason = 'unknown',
): CompletionAuditResult {
  const missing: string[] = []
  const totalSteps = state.currentPlanItems?.length || 0
  const completedInlineAnswer = /(?:^|_)inline_answer_complete$/.test(terminalReason)

  if (totalSteps > 0 && state.currentStepIdx < totalSteps) {
    missing.push(`only ${state.currentStepIdx} of ${totalSteps} plan steps were completed`)
  }

  const unresolvedSteps = unresolvedStepSummaries(state)
  if (unresolvedSteps.length > 0) {
    missing.push(`${unresolvedSteps.join(', ')} did not complete`)
  }

  if (!completedInlineAnswer && requiresFinalDeliverable(state) && !hasFinalDeliverable(state)) {
    missing.push('no successful final deliverable artifact was saved')
  }

  if (!completedInlineAnswer && requiresFinalDeliverable(state) && hasFinalDeliverable(state) && !state.deliverableVerificationDone) {
    missing.push('the final deliverable was saved but did not pass completion verification')
  }

  if (state.partialFileWriteRecoveryPending) {
    missing.push(`partial file write still needs continuation: ${state.partialFileWriteRecoveryPending.path}`)
  }

  if (isWebsiteLike(state) && state.createdFiles.size > 0) {
    if (!state.websiteBrowserCheckDone && !state.nextWebsitePreviewDone) {
      missing.push('local website preview was not successfully verified')
    }
    if (!state.websiteResponsiveCheckDone) {
      missing.push('local visual website check was not completed')
    }
  }

  if (terminalReason === 'iteration_cap') {
    missing.push('the iteration limit was reached before a verified completion state')
  }

  const uniqueMissing = [...new Set(missing)]
  const reason = uniqueMissing.length > 0 ? terminalReason : 'complete'
  const message = uniqueMissing.length > 0
    ? `Agent stopped before completion: ${uniqueMissing.join('; ')}. Reason: ${terminalReason}.`
    : 'Completion audit passed.'

  return {
    complete: uniqueMissing.length === 0,
    reason,
    missing: uniqueMissing,
    message,
  }
}
