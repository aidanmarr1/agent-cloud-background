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
  if (state.taskStrategy === 'browse') return false
  if (
    state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
  ) {
    return true
  }

  const userRequest = state.originalUserRequest || fallbackRequest
  const userIntent = analyzeTaskIntent([{ role: 'user', content: userRequest }])

  if (userIntent.explicitSavedArtifact) return true
  if (userIntent.wantsInlineAnswer || userIntent.wantsQuick) return false
  if (userIntent.requiresSavedArtifact) return true

  const taskText = plannedTaskText(state)
  const plannedIntent = analyzeTaskIntent([{ role: 'user', content: taskText }])
  return plannedIntent.explicitSavedArtifact ||
    taskDefaultsToMarkdownDeliverable(taskText)
}
