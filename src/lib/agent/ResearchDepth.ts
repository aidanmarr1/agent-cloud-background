import { currentStepText, type AgentStateData } from './AgentState'
import {
  MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY,
  MIN_RESEARCH_CALLS_BY_COMPLEXITY,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  MIN_TOOL_CALLS_PER_STEP,
} from './config'
import { currentStepHasSingleWebSearchLimit, currentStepWebSearchLimit } from './taskConstraints'

export interface ResearchDepthProfile {
  requiredCalls: number
  requiredSourceBreadth: number
  substantive: boolean
  exactSingleSource: boolean
  fixedSearchOnly: boolean
}

const QUICK_RE = /\b(?:very quickly|real quick|asap|super quick|quickly|quick|brief|short|direct answer|answer directly|one[-\s]?liner|one sentence|tl;?dr)\b/i
const BROAD_SYNTHESIS_RE = /\b(?:current\s+state|state\s+of|overview|landscape|ecosystem|real[-\s]?world\s+applications?|applications?\s+of|use cases?|core technolog(?:y|ies)|key technolog(?:y|ies)|capabilities?|trends?|impact|implications?)\b/i
const MULTI_ANGLE_RE = /\b(?:summari[sz]e|explain|cover(?:ing)?|survey|map|compare|analy[sz]e|evaluate|assess|synthesis|foundational|pillars?|modern|today)\b/i
const WIDE_SYNTHESIS_RE = /\b(?:current\s+state|state\s+of|landscape|ecosystem|real[-\s]?world\s+applications?)\b/i

export function isExactSingleSourceLookupText(text: string): boolean {
  return /\b(?:exact|official|primary|source[-\s]?specific|single source|one source|specific page|specific document|quote|verbatim|wording|date|timing|release|price|policy|docs?|documentation|spec|api reference|pep|standard)\b/i.test(text) &&
    !/\b(?:compare|versus|vs\.?|across|rank|ranking|pros?|cons?|tradeoffs?|risks?|benefits?|why|how|evaluate|assess|analy[sz]e|synthesis|perspectives?|drivers?|ecosystem|landscape|current\s+state|state\s+of)\b/i.test(text)
}

export function isSubstantiveResearchText(text: string): boolean {
  if (!text.trim()) return false
  if (isExactSingleSourceLookupText(text)) return false
  if (QUICK_RE.test(text)) return false
  return BROAD_SYNTHESIS_RE.test(text) &&
    (MULTI_ANGLE_RE.test(text) || /\b(?:current\s+state|state\s+of|landscape|ecosystem|real[-\s]?world\s+applications?)\b/i.test(text))
}

export function researchDepthTextForState(state: AgentStateData): string {
  return [
    state.originalUserRequest || '',
    currentStepText(state),
    state.currentPlanScopes?.[state.currentStepIdx] || '',
  ].join(' ')
}

export function isSubstantiveResearchState(state: AgentStateData): boolean {
  return isSubstantiveResearchText(researchDepthTextForState(state))
}

export function researchDepthProfileForState(state: AgentStateData): ResearchDepthProfile {
  const fixedSearchLimit = currentStepWebSearchLimit(state)
  const fixedSearchOnly = fixedSearchLimit !== null || currentStepHasSingleWebSearchLimit(state)
  const text = researchDepthTextForState(state)
  const exactSingleSource = isExactSingleSourceLookupText(text)
  const substantive = isSubstantiveResearchText(text)
  const complexity = state.taskComplexity as 1 | 2 | 3

  let requiredCalls = fixedSearchLimit ??
    (currentStepHasSingleWebSearchLimit(state)
      ? 1
      : MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ?? MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? MIN_TOOL_CALLS_PER_STEP)
  let requiredSourceBreadth = fixedSearchOnly
    ? 0
    : exactSingleSource
      ? 1
      : MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY[complexity] ?? 2

  if (!fixedSearchOnly && substantive) {
    requiredCalls = Math.max(requiredCalls, 6)
    requiredSourceBreadth = Math.max(requiredSourceBreadth, WIDE_SYNTHESIS_RE.test(text) ? 4 : 3)
  }

  return {
    requiredCalls,
    requiredSourceBreadth,
    substantive,
    exactSingleSource,
    fixedSearchOnly,
  }
}
