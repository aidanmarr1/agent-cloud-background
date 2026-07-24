import { currentStepText, stepOpenedSourceDomains, type AgentStateData } from './AgentState'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'
import {
  MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY,
  MIN_RESEARCH_CALLS_BY_COMPLEXITY,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
} from './config'

export interface ResearchDepthProfile {
  requiredCalls: number
  requiredSourceBreadth: number
  label: 'single-source' | 'light' | 'standard' | 'deep' | 'wide'
}

const QUICK_RE = /\b(?:very quickly|real quick|asap|super quick|quickly|quick|briefly|brief|short|succinct|simple|one[-\s]?sentence|two[-\s]?sentence|in\s+\d+\s+sentences?)\b/i
const DEEP_RE = /\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|deep[-\s]?dive|rigorous|rigorously|extensive|full report|serious analysis|strategic|technical|historical|cultural|comparative)\b/i
const EXTREME_RE = /\b(?:extremely|exhaustive|all about|everything about|ultimate|complete|deepest possible|max(?:imum)? depth|very deep)\b/i
const WIDE_RE = /\b(?:wide research|hundreds?|dozens?|many\s+(?:companies|items|sources|papers|products|competitors)|large[-\s]?scale|at scale|market map|landscape)\b/i
const COMPARISON_RE = /\b(?:compare|versus|vs\.?|competitive|competitors?|alternatives?|bull|bear|base case|scenarios?|risks?|opportunities?|tradeoffs?|technical strengths?|weaknesses?)\b/i
const REPORT_RE = /\b(?:report|memo|write[-\s]?up|markdown|\.md|dossier|briefing|analysis)\b/i
const CURRENT_RE = /\b(?:latest|current|recent|today|this\s+week|this\s+month|this\s+year|202[4-9]|newest|up[-\s]?to[-\s]?date|news|release timeline|pricing|funding|hiring|reviews?)\b/i
const EVIDENCE_RE = /\b(?:source-backed|evidence-backed|sources?|citations?|cited?|references?|verified|verify|cross[-\s]?check|benchmark|data|numbers?|metrics?)\b/i
const BROAD_SYNTHESIS_RE = /\b(?:current\s+state|state\s+of|overview|landscape|ecosystem|real[-\s]?world\s+applications?|applications?|use\s+cases?|core\s+technolog(?:y|ies)|capabilities|trends?|impact|implications?)\b/i
const MULTI_ANGLE_RE = /\b(?:history|founding|team|funding|leadership|product|customers?|adoption|traction|financial|hiring|partnerships?|competitive position|pricing|reviews?|market sentiment|strengths?|weaknesses?|risks?|opportunities?|applications?|use cases?|technolog(?:y|ies)|capabilities|trends?|impact|implications?|ecosystem|landscape)\b/gi

function plannedResearchPhaseCount(state: AgentStateData): number {
  const plan = state.currentPlanItems || state.planItems
  if (!plan || plan.length <= 1) return 1
  const nonFinal = plan.slice(0, -1)
  const explicitResearchCount = nonFinal.filter((title, index) => {
    const scope = state.currentPlanScopes?.[index] || state.planScopes?.[index] || ''
    return /\b(?:research|source|evidence|market|technical|customer|competitor|risk|history|funding|pricing|review|adoption|trend|landscape|compare|analysis)\b/i.test(`${title} ${scope}`)
  }).length
  return Math.max(1, explicitResearchCount || nonFinal.length)
}

function perPhaseDepthBudget(
  state: AgentStateData,
  totalCalls: number,
  totalBreadth: number,
  label: ResearchDepthProfile['label'],
  complexity: 1 | 2 | 3,
): { calls: number; breadth: number } {
  const phases = plannedResearchPhaseCount(state)
  if (phases <= 1) return { calls: totalCalls, breadth: totalBreadth }

  // Keep the user's requested depth as a task-level target instead of
  // multiplying the whole prompt's "deep/compare/wide" signals into every
  // phase. Each phase still has a real evidence floor, but large plans stop
  // turning one deep request into dozens of repeated model/tool cycles.
  const callDivisor = phases <= 1
    ? 1
    : label === 'wide'
      ? Math.max(1.6, Math.sqrt(phases))
      : label === 'deep'
        ? Math.max(1.7, Math.sqrt(phases) + 0.25)
        : phases >= 3
          ? Math.max(1.8, Math.sqrt(phases) + 0.45)
          : 1.6
  const breadthDivisor = phases <= 1
    ? 1
    : label === 'wide'
      ? Math.max(1.5, Math.sqrt(phases))
      : label === 'deep'
        ? Math.max(1.6, Math.sqrt(phases) + 0.2)
        : phases >= 3
          ? Math.max(1.8, Math.sqrt(phases) + 0.5)
          : 1.7
  const minCalls = label === 'wide'
    ? 8
    : label === 'deep'
      ? 6
      : complexity >= 3
        ? 4
        : complexity >= 2
          ? 4
          : 3
  const minBreadth = label === 'wide'
    ? 5
    : label === 'deep'
      ? 4
      : complexity >= 3
        ? 3
        : complexity >= 2
          ? 3
          : 2

  return {
    calls: Math.max(minCalls, Math.ceil(totalCalls / callDivisor)),
    breadth: Math.max(minBreadth, Math.ceil(totalBreadth / breadthDivisor)),
  }
}

export function isExactSingleSourceLookupText(text: string): boolean {
  return /\b(?:exact|source[-\s]?specific|single source|one source|specific page|specific document|quote|verbatim|wording|precise date|exact date|exact timing|exact release|exact price|api reference|pep|standard)\b/i.test(text) &&
    !/\b(?:compare|versus|vs\.?|across|rank|ranking|pros?|cons?|tradeoffs?|risks?|benefits?|why|how|evaluate|assess|analy[sz]e|synthesis|perspectives?|drivers?|ecosystem)\b/i.test(text)
}

export function researchDepthProfileForState(state: AgentStateData): ResearchDepthProfile {
  const complexity = Math.min(3, Math.max(1, Math.round(state.taskComplexity || 2))) as 1 | 2 | 3
  const stepText = currentStepText(state)
  const originalRequest = state.originalUserRequest || ''
  const text = [
    originalRequest,
    stepText,
    state.currentPlanScopes?.[state.currentStepIdx] || '',
  ].join(' ')

  const baseCalls = MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ??
    MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ??
    2
  const baseBreadth = MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY[complexity] ?? 1

  if (isExactSingleSourceLookupText(text)) {
    return { requiredCalls: 1, requiredSourceBreadth: 1, label: 'single-source' }
  }

  const quick = QUICK_RE.test(originalRequest) &&
    !taskDefaultsToMarkdownDeliverable(originalRequest) &&
    !DEEP_RE.test(text) &&
    !WIDE_RE.test(text) &&
    !BROAD_SYNTHESIS_RE.test(text)
  if (quick) {
    return { requiredCalls: 3, requiredSourceBreadth: 2, label: 'light' }
  }

  let requiredCalls = baseCalls
  let requiredSourceBreadth = baseBreadth
  let label: ResearchDepthProfile['label'] = 'standard'

  if (DEEP_RE.test(text)) {
    requiredCalls += 3
    requiredSourceBreadth += 2
    label = 'deep'
  }

  if (EXTREME_RE.test(text)) {
    requiredCalls += 5
    requiredSourceBreadth += 3
    label = 'deep'
  }

  if (COMPARISON_RE.test(text)) {
    requiredCalls += 4
    requiredSourceBreadth += 2
  }

  if (REPORT_RE.test(text)) {
    requiredCalls += 2
    requiredSourceBreadth += 1
    if (complexity >= 3 || DEEP_RE.test(text) || COMPARISON_RE.test(text)) label = 'deep'
  }

  if (CURRENT_RE.test(text)) {
    requiredCalls += 2
    requiredSourceBreadth += 1
  }

  if (EVIDENCE_RE.test(text)) {
    requiredCalls += 2
    requiredSourceBreadth += 1
  }

  if (BROAD_SYNTHESIS_RE.test(text)) {
    requiredCalls += 3
    requiredSourceBreadth += 2
    if (complexity >= 2 || CURRENT_RE.test(text)) label = 'deep'
  }

  const angleMatches = text.match(MULTI_ANGLE_RE) || []
  if (angleMatches.length >= 4) {
    requiredCalls += Math.min(8, Math.ceil(angleMatches.length / 2))
    requiredSourceBreadth += Math.min(4, Math.ceil(angleMatches.length / 4))
    label = 'deep'
  }

  if (WIDE_RE.test(text)) {
    requiredCalls += 7
    requiredSourceBreadth += 4
    label = 'wide'
  }

  const callCap = label === 'wide' ? 36 : label === 'deep' ? 30 : 22
  const allocated = perPhaseDepthBudget(state, requiredCalls, requiredSourceBreadth, label, complexity)
  return {
    requiredCalls: Math.max(1, Math.min(callCap, allocated.calls)),
    requiredSourceBreadth: Math.max(1, Math.min(label === 'wide' ? 12 : 10, allocated.breadth)),
    label,
  }
}

/**
 * A conservative evidence floor for deterministic recovery after the model has
 * started repeating or has failed to produce an executable next action.
 *
 * This is deliberately stricter than ordinary early-step progress: search
 * snippets alone never qualify. The runtime must already have opened several
 * distinct source domains, and deeper single-phase requests scale the floor up
 * with their configured depth instead of being advanced after one search.
 */
export function hasCredibleResearchRecoveryPacket(state: AgentStateData): boolean {
  const profile = researchDepthProfileForState(state)
  const requiredOpenedPages = Math.min(
    profile.requiredSourceBreadth,
    Math.max(1, Math.ceil(profile.requiredCalls / 3)),
  )
  const credibleCalls = Math.min(
    profile.requiredCalls,
    Math.max(5, Math.ceil(profile.requiredCalls * 0.4)),
  )
  const credibleOpenedPages = Math.min(
    requiredOpenedPages,
    Math.max(3, Math.ceil(requiredOpenedPages * 0.6)),
  )
  const credibleDomains = Math.min(
    profile.requiredSourceBreadth,
    Math.max(3, Math.ceil(profile.requiredSourceBreadth * 0.6)),
  )

  const openedDomains = stepOpenedSourceDomains(state).size
  const openedPages = state.stepVisitedUrls.size
  const meetsPrimaryFloor = state.stepResearchCallCount >= credibleCalls &&
    openedPages >= credibleOpenedPages &&
    openedDomains >= credibleDomains

  // A single search action may open/extract several full pages in parallel.
  // Let one *extra opened page* compensate for exactly one missing research
  // action, while retaining the configured domain floor. This covers the live
  // 4-page/3-domain packet without turning snippets or shallow searches into
  // sufficient evidence, and never relaxes deeper profiles by more than one.
  const breadthCompensatesForOneCall = credibleCalls > 1 &&
    state.stepResearchCallCount >= Math.max(4, credibleCalls - 1) &&
    openedPages >= Math.max(4, credibleOpenedPages + 1) &&
    openedDomains >= credibleDomains

  return meetsPrimaryFloor || breadthCompensatesForOneCall
}
