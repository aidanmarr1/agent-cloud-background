import {
  currentStepText,
  isResearchStepText,
  stepOpenedSourceDomains,
  type AgentStateData,
} from './AgentState'
import {
  currentStepWebSearchLimit,
  hasSingleWebSearchLimit,
} from './taskConstraints'
import {
  normalizeResearchQuery,
  normalizeResearchUrl,
} from './ResearchActivityLog'

const SOURCE_OPENING_TOOLS = new Set([
  'read_document',
  'http_request',
  'browser_navigate',
  'browser_get_content',
  'browser_find_text',
  'browse_page',
])

function totalOpenedSourceReads(state: AgentStateData): number {
  return [...stepOpenedSourceDomains(state).values()].reduce((sum, count) => sum + count, 0)
}

function latestSearchCandidateCount(state: AgentStateData): number {
  const latestQuery = [...state.stepSearchQueries].at(-1)
  const normalizedLatestQuery = latestQuery
    ? normalizeResearchQuery(latestQuery.slice(0, 180))
    : ''
  return new Set(
    state.workLedger.searchResults
      .filter(result =>
        result.stepIdx === state.currentStepIdx &&
        !!result.url.trim() &&
        (!normalizedLatestQuery ||
          normalizeResearchQuery(result.query) === normalizedLatestQuery)
      )
      .map(result => normalizeResearchUrl(result.url)),
  ).size
}

export function researchSourceBalanceBlockReason(
  toolName: string,
  state: AgentStateData,
): string | null {
  if (toolName !== 'web_search') return null
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return null
  if (currentStepWebSearchLimit(state) !== null || hasSingleWebSearchLimit(state)) return null
  if (state.taskStrategy === 'browse' || state.taskStrategy === 'build' || state.taskStrategy === 'code') return null

  const stepText = currentStepText(state)
  const isResearchPhase =
    state.currentPhase === 'research' ||
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    isResearchStepText(stepText)
  if (!isResearchPhase) return null

  const completedSearches = Math.max(
    state.stepSearchQueries.size,
    state.stepToolTypeCounts.get('web_search') || 0,
  )
  const openedSourceReads = totalOpenedSourceReads(state)
  const latestCandidateCount = latestSearchCandidateCount(state)
  const distinctSourceFailures = state.stepFailedSourceTargets.size
  const sourceReadTools = [...SOURCE_OPENING_TOOLS].join(', ')

  // Only a successful result set with concrete candidate URLs can require an
  // opening action. Two distinct failed source URLs unlock a fresh discovery
  // search; executing that search clears the failure set for its new pool.
  if (
    completedSearches >= 1 &&
    openedSourceReads === 0 &&
    latestCandidateCount > 0 &&
    distinctSourceFailures < 2
  ) {
    return `INTERNAL_RECOVERY: this web_search was skipped because this research phase has ${completedSearches} search result sets but no opened or extracted source pages yet. Use one of these source-reading tools next: ${sourceReadTools}. Extract concrete facts from the strongest result before searching again.`
  }

  if (
    completedSearches >= 4 &&
    openedSourceReads < Math.floor(completedSearches / 2) &&
    latestCandidateCount > 0 &&
    distinctSourceFailures < 2
  ) {
    return `INTERNAL_RECOVERY: this web_search was skipped because this research phase is leaning too heavily on search previews (${completedSearches} searches, ${openedSourceReads} opened/extracted sources). Read or extract another strong source page with ${sourceReadTools} before searching again.`
  }

  return null
}

export function applyResearchPreflightRouteRecovery(
  state: AgentStateData,
  toolName: string,
  rejectionCode: string,
): void {
  if (
    toolName !== 'web_search' ||
    (rejectionCode !== 'research_source_balance' && rejectionCode !== 'direct_navigation_required')
  ) return
  state.suppressedResearchToolName = 'web_search'
  state.stepLoopDetections = Math.max(1, state.stepLoopDetections + 1)
  state.lastLoopSignal = { type: 'search_duplicate', tool: 'web_search' }
}

export function releaseSearchAfterDistinctSourceFailures(
  state: AgentStateData,
  failedToolName: string,
  failedTarget: string,
): void {
  if (!SOURCE_OPENING_TOOLS.has(failedToolName)) return
  let normalizedTarget = ''
  try {
    const parsed = new URL(failedTarget)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    normalizedTarget = normalizeResearchUrl(parsed.toString())
  } catch {
    return
  }
  state.stepFailedSourceTargets.add(normalizedTarget)
  const normalizedUserTarget = state.userProvidedUrl
    ? normalizeResearchUrl(state.userProvidedUrl)
    : ''
  if (
    state.suppressedResearchToolName === 'web_search' &&
    normalizedUserTarget &&
    normalizedTarget === normalizedUserTarget
  ) {
    // A direct-navigation correction needs exactly one non-search attempt.
    // If that exact target fails, the next turn may use search as a fallback;
    // keeping it suppressed would leave the route with no bounded escape.
    state.suppressedResearchToolName = null
    return
  }
  if (
    state.suppressedResearchToolName !== 'web_search' ||
    state.stepFailedSourceTargets.size < 2
  ) return
  state.suppressedResearchToolName = null
}
