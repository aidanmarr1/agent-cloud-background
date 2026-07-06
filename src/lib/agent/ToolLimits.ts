import type { AgentStateData } from './AgentState'
import { TOOL_TYPE_RATE_LIMITS } from './config'
import { researchDepthProfileForState } from './ResearchDepth'
import { currentStepWebSearchLimit } from './taskConstraints'

const RESEARCH_SOURCE_TOOLS = new Set([
  'web_search',
  'read_document',
  'browser_navigate',
  'browser_get_content',
  'browser_find_text',
  'browser_scroll',
])

const FILE_DELIVERABLE_TOOLS = new Set([
  'create_file',
  'append_file',
  'edit_file',
  'export_pdf',
])

function isResearchLikeState(state: AgentStateData): boolean {
  return state.currentPhase === 'research' ||
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis'
}

function complexityMultiplier(state: AgentStateData): number {
  const complexity = Math.min(3, Math.max(1, Math.round(state.taskComplexity || 2)))
  if (complexity >= 3) return 1.25
  if (complexity === 2) return 1.08
  return 1
}

function researchDepthMultiplier(state: AgentStateData): number {
  if (!isResearchLikeState(state)) return 1
  const depth = researchDepthProfileForState(state)
  if (depth.label === 'wide') return 1.65
  if (depth.label === 'deep') return 1.45
  if (depth.label === 'standard') return 1.2
  return 1
}

export function toolTypeRateLimitForState(state: AgentStateData, toolName: string): number | undefined {
  const fixedSearchLimit = toolName === 'web_search' ? currentStepWebSearchLimit(state) : null
  if (fixedSearchLimit !== null) return fixedSearchLimit

  const base = TOOL_TYPE_RATE_LIMITS[toolName]
  if (base === undefined) return undefined

  if (RESEARCH_SOURCE_TOOLS.has(toolName)) {
    return Math.ceil(base * Math.max(complexityMultiplier(state), researchDepthMultiplier(state)))
  }

  if (FILE_DELIVERABLE_TOOLS.has(toolName) && state.currentPhase === 'deliver') {
    return Math.ceil(base * complexityMultiplier(state))
  }

  if (toolName === 'image_search' && /\b(?:image|images|photos?|visual|assets?)\b/i.test(state.originalUserRequest || '')) {
    return Math.ceil(base * complexityMultiplier(state))
  }

  return base
}
