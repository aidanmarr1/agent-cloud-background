import type { AgentStateData } from './AgentState'
import { requestsMarkdownDeliverable } from './taskConstraints'

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

function hasSavedRequestedMarkdownDeliverable(state: AgentStateData): boolean {
  if (!requestsMarkdownDeliverable(currentTaskText(state))) return false
  const requestedSearch = /\b(?:web\s*)?search(?:es)?\b/i.test(state.originalUserRequest || '')
  if (requestedSearch && state.searchQueries.size === 0 && state.workLedger.searchResults.length === 0) return false
  return state.workLedger.deliverableCandidates.some(item =>
    item.purpose === 'deliverable' &&
    item.path.toLowerCase().endsWith('.md')
  )
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
  const text = currentTaskText(state)
  return state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative' ||
    explicitSavedArtifactRequested(text)
}

function explicitSavedArtifactRequested(text: string): boolean {
  return /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|pptx|xlsx)\b/i.test(text) ||
    /\b(?:save|create|write|export|make|generate|deliver|return)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|website|web\s*site|app|code|script|component|deliverable|manuscript|novel|book)\b/i.test(text) ||
    /\b(?:website|web\s*app|next\.?js|page\.tsx|layout\.tsx|globals\.css)\b/i.test(text)
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
  const savedRequestedMarkdownDeliverable = hasSavedRequestedMarkdownDeliverable(state)

  if (totalSteps > 0 && state.currentStepIdx < totalSteps && !savedRequestedMarkdownDeliverable) {
    missing.push(`only ${state.currentStepIdx} of ${totalSteps} plan steps were completed`)
  }

  const unresolvedSteps = unresolvedStepSummaries(state)
  if (unresolvedSteps.length > 0) {
    missing.push(`${unresolvedSteps.join(', ')} did not complete`)
  }

  if (requiresFinalDeliverable(state) && !hasFinalDeliverable(state)) {
    missing.push('no successful final deliverable artifact was saved')
  }

  if (requiresFinalDeliverable(state) && hasFinalDeliverable(state) && !state.deliverableVerificationDone && !savedRequestedMarkdownDeliverable) {
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
