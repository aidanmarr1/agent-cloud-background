import type { AgentStateData } from './AgentState'
import { analyzeTaskIntent } from './TaskIntent'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'

type DeliverableContractState = Pick<
  AgentStateData,
  | 'originalUserRequest'
  | 'currentPlanItems'
  | 'currentPlanScopes'
  | 'createdFiles'
  | 'buildTask'
  | 'taskStrategy'
>

function plannedTaskText(state: DeliverableContractState): string {
  return [
    state.originalUserRequest || '',
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
    ...state.createdFiles,
  ].join(' ')
}

function browseRequestCreatesSavedArtifact(request: string): boolean {
  const artifactTarget = String.raw`(?:file|artifact|pdf|markdown|document|docx?|word\s+doc(?:ument)?|pptx|slides?|presentation|deck|spreadsheet|xlsx|csv|notebook|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|pdf|docx?|pptx|xlsx|csv))`
  const outputAction = new RegExp(
    String.raw`\b(?:save|export|deliver|download|return|send|write|create|make|generate|produce)\b[^\n.!?]{0,120}\b${artifactTarget}\b`,
    'i',
  )
  const savePriorTarget = new RegExp(
    String.raw`\b${artifactTarget}\b[^\n.!?]{0,120}\b(?:save|export|deliver|download|return|send)\s+(?:it|that|the\s+(?:file|artifact|result))\b`,
    'i',
  )
  return outputAction.test(request) || savePriorTarget.test(request)
}

/**
 * Single source of truth for the final-output contract.
 *
 * The original user request has priority over planner wording: an explicit
 * inline/quick request must not become a file merely because a generated plan
 * happens to say "report". Conversely, ordinary research/report work defaults
 * to a verified Markdown artifact, even when the final plan title is terse.
 */
export function taskRequiresSavedFinalArtifact(
  state: DeliverableContractState,
  fallbackRequest = '',
): boolean {
  const userRequest = state.originalUserRequest || fallbackRequest
  const userIntent = analyzeTaskIntent([{ role: 'user', content: userRequest }])

  // A browser-led task can still explicitly request a saved result after the
  // live interaction (for example, "open this URL, read the title, then create
  // live-check.md"). Strategy classification describes how the task starts; it
  // must not erase an unambiguous user-authored output contract.
  if (
    userIntent.explicitSavedArtifact &&
    (
      state.taskStrategy !== 'browse' ||
      browseRequestCreatesSavedArtifact(userRequest)
    )
  ) {
    return true
  }
  if (state.taskStrategy === 'browse') return false
  if (
    state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
  ) {
    return true
  }

  if (userIntent.wantsInlineAnswer || userIntent.wantsQuick) return false
  if (userIntent.requiresSavedArtifact) return true

  const taskText = plannedTaskText(state)
  const plannedIntent = analyzeTaskIntent([{ role: 'user', content: taskText }])
  return plannedIntent.explicitSavedArtifact ||
    taskDefaultsToMarkdownDeliverable(taskText)
}
