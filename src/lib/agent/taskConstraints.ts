import type { AgentStateData } from './AgentState'

const SINGLE_WEB_SEARCH_PATTERNS = [
  /\b(?:do|run|make|perform|use)?\s*(?:only|exactly|just)\s+(?:one|1|a|single)\s+(?:web\s*)?search(?:es)?\b/i,
  /\b(?:one|1|a|single)\s+(?:web\s*)?search(?:es)?\s+(?:only|max|maximum|at\s+most)\b/i,
  /\b(?:limit|limited|cap)\s+(?:it|this|research|search(?:es)?)\s+(?:to|at)\s+(?:one|1|a|single)\s+(?:web\s*)?search(?:es)?\b/i,
]

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  single: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
}

const MARKDOWN_DELIVERABLE_PATTERN = /\b(?:\.md|markdown|md\s+file|markdown\s+file)\b/i
const FILE_DELIVERABLE_PATTERN = /\b(?:create|write|save|return|deliver|make)\b.{0,80}\b(?:file|report|document)\b/i
const INLINE_ANSWER_PATTERN = /\b(?:no file|no document|without\s+(?:a\s+)?(?:file|document)|don'?t\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|answer\s+(?:directly|in chat|here)|write\s+(?:it|this|the answer|the\s+(?:final\s+)?report|the summary|the findings?)\s+(?:directly\s+)?(?:in chat|here)|just\s+answer|inline)\b/i
const REPORT_MARKDOWN_DEFAULT_PATTERN = /\b(?:research\s+(?:about|on|into|for|why|whether|all\s+about)|deep\s+research|report(?:\s+on|\s+about)?|research\s+report|findings?|write[-\s]?up|source[-\s]?backed\s+summary|cited\s+summary|compile\s+(?:the\s+)?(?:findings|research|report)|synthesi[sz]e\s+(?:the\s+)?(?:findings|research)|deliver\s+(?:the\s+)?(?:findings|report))\b/i
const BARE_RESEARCH_OVERVIEW_PATTERN = /^\s*(?:please\s+)?(?:research|look\s+up|search(?:\s+for)?|find\s+out\s+about|learn\s+about)\s+(?:about|on|into|for)?\s+(.{2,120}?)\s*[.!?]*\s*$/i
const SUBSTANTIVE_RESEARCH_SCOPE_PATTERN = /\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|all\s+about|everything\s+about|current|latest|recent|today|this\s+(?:week|month|year)|202[4-9]|news|report|memo|briefing|analysis|markdown|\.md|file|document|sources?|citations?|cited|references?|evidence|verified|verify|compare|versus|vs\.?|landscape|ecosystem|applications?|use\s+cases?|trends?|history|timeline|ethical|societal|future|risks?|opportunities?|market|pricing|funding|reviews?)\b/i
const FIXED_SEARCH_COUNT_PATTERN = '(?:one|two|three|four|five|[1-5]|a|an|single)'
const FIXED_SEARCH_DIRECTIVE_PATTERNS = [
  new RegExp(`\\b(?:please\\s*)?(?:do|run|make|perform|use|conduct|complete)?\\s*(?:only|exactly|just)?\\s*${FIXED_SEARCH_COUNT_PATTERN}\\s+(?:web\\s*)?search(?:es)?\\b`, 'gi'),
  new RegExp(`\\b(?:only|exactly|just)\\s+(?:do|run|make|perform|use|conduct|complete)\\s*${FIXED_SEARCH_COUNT_PATTERN}\\s+(?:web\\s*)?search(?:es)?\\b`, 'gi'),
  /\b(?:then\s+)?(?:tell|answer|summari[sz]e|report)(?:\s+me)?(?:\s+(?:here|back))?\b/gi,
  /\bfrom\s+(?:the\s+)?search\s+results\b/gi,
]
const FIXED_SEARCH_DELIVERABLE_DIRECTIVE_PATTERNS = [
  /\b(?:and|then)\s+(?:get\s+back\s+to\s+me|write|create|make|save|return|deliver|compile)\b[\s\S]*?\b(?:\.md|markdown|md\s+file|markdown\s+file|report\s+file|report|file|document)\b(?:\s+(?:on|about)\s+(?:it|them|this|that))?/gi,
  /\b(?:and|then)\s+(?:return|deliver|send)\s+(?:it|the\s+(?:file|report|document))\b/gi,
  /\b(?:in|as)\s+(?:an?\s+)?(?:\.md|markdown|md)\s+(?:report\s+)?file\b/gi,
]

function parseSmallCount(value: string): number | null {
  const normalized = value.toLowerCase()
  const parsed = NUMBER_WORDS[normalized] ?? Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) return null
  return parsed
}

export function explicitWebSearchLimitFromText(text: string | null | undefined): number | null {
  if (!text) return null
  if (SINGLE_WEB_SEARCH_PATTERNS.some(pattern => pattern.test(text))) return 1

  const generic = text.match(/\b(?:do|run|make|perform|use|conduct|complete)?\s*(?:only|exactly|just)?\s*(one|two|three|four|five|[1-5])\s+(?:web\s*)?search(?:es)?\b/i)
  if (generic?.[1]) return parseSmallCount(generic[1])

  const limit = text.match(/\b(?:limit|limited|cap)\s+(?:it|this|research|search(?:es)?)\s+(?:to|at)\s+(one|two|three|four|five|[1-5])\s+(?:web\s*)?search(?:es)?\b/i)
  if (limit?.[1]) return parseSmallCount(limit[1])

  const exactTool = text.match(/\bexactly\s+(one|two|three|four|five|[1-5])\s+web_search\b/i)
  if (exactTool?.[1]) return parseSmallCount(exactTool[1])

  return null
}

export function latestUserContent(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find(message => message.role === 'user')?.content || ''
}

export function previousUserContent(messages: Array<{ role: string; content: string }>): string {
  const userMessages = messages.filter(message => message.role === 'user')
  return userMessages.length >= 2 ? userMessages[userMessages.length - 2]?.content || '' : ''
}

export function stripFixedWebSearchDirective(text: string | null | undefined): string {
  if (!text) return ''
  let cleaned = text.trim()
  for (const pattern of FIXED_SEARCH_DIRECTIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ')
  }
  for (const pattern of FIXED_SEARCH_DELIVERABLE_DIRECTIVE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ')
  }
  return cleaned
    .replace(/\b(?:only|exactly|just)\b/gi, ' ')
    .replace(/\s+\b(?:and|then)\b\s*$/i, ' ')
    .replace(/^\s*(?:on|about|for|regarding|re:)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '')
    .trim()
}

export function fixedWebSearchTopicFromMessages(messages: Array<{ role: string; content: string }>): string {
  const latest = latestUserContent(messages)
  const cleanedLatest = stripFixedWebSearchDirective(latest)
  if (cleanedLatest) return cleanedLatest

  const previous = previousUserContent(messages).trim()
  if (previous) return previous

  return latest.trim()
}

export function requestsMarkdownDeliverable(text: string | null | undefined): boolean {
  if (!text) return false
  return MARKDOWN_DELIVERABLE_PATTERN.test(text) ||
    (/\bmarkdown\b/i.test(text) && FILE_DELIVERABLE_PATTERN.test(text))
}

export function explicitlyRequestsInlineAnswer(text: string | null | undefined): boolean {
  return !!text && INLINE_ANSWER_PATTERN.test(text)
}

export function bareResearchOverviewTopic(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.trim().match(BARE_RESEARCH_OVERVIEW_PATTERN)
  if (!match?.[1]) return null
  return match[1]
    .replace(/\b(?:quickly|quick|briefly|brief|short|concise|simple)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '')
    .trim() || null
}

export function isBareResearchOverviewRequest(text: string | null | undefined): boolean {
  const topic = bareResearchOverviewTopic(text)
  if (!topic || !text) return false
  if (explicitWebSearchLimitFromText(text) !== null) return false
  if (requestsMarkdownDeliverable(text) || FILE_DELIVERABLE_PATTERN.test(text)) return false
  return !SUBSTANTIVE_RESEARCH_SCOPE_PATTERN.test(text)
}

export function taskDefaultsToMarkdownDeliverable(text: string | null | undefined): boolean {
  if (!text) return false
  if (explicitlyRequestsInlineAnswer(text)) return false
  if (isBareResearchOverviewRequest(text)) return false
  const explicitArtifact = requestsMarkdownDeliverable(text) || FILE_DELIVERABLE_PATTERN.test(text)
  if (
    !explicitArtifact &&
    /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple|small|tiny|fast)\b/i.test(text)
  ) {
    return false
  }
  return explicitArtifact || REPORT_MARKDOWN_DEFAULT_PATTERN.test(text)
}

export function isSingleWebSearchMarkdownTask(messages: Array<{ role: string; content: string }>): boolean {
  const text = latestUserContent(messages)
  return explicitWebSearchLimitFromText(text) === 1 && taskDefaultsToMarkdownDeliverable(text)
}

export function isFixedWebSearchAnswerTask(messages: Array<{ role: string; content: string }>): boolean {
  const text = latestUserContent(messages)
  return explicitWebSearchLimitFromText(text) !== null && !taskDefaultsToMarkdownDeliverable(text)
}

export function isFixedWebSearchInlineAnswerState(state: Pick<AgentStateData, 'originalUserRequest'>): boolean {
  const text = state.originalUserRequest || ''
  return explicitWebSearchLimitFromText(text) !== null && !taskDefaultsToMarkdownDeliverable(text)
}

export function hasSingleWebSearchLimit(state: Pick<
  AgentStateData,
  'originalUserRequest' | 'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'
>): boolean {
  const parts = [
    state.originalUserRequest || '',
    ...(state.currentPlanItems || []),
    ...((state.currentPlanScopes || []).filter(Boolean) as string[]),
  ]
  return explicitWebSearchLimitFromText(parts.join(' ')) === 1 ||
    /\bexactly\s+one\s+web_search\b/i.test(parts.join(' '))
}

export function currentStepWebSearchLimit(state: Pick<
  AgentStateData,
  'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'
>): number | null {
  const currentTitle = state.currentPlanItems?.[state.currentStepIdx] || ''
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx] || ''
  return explicitWebSearchLimitFromText(`${currentTitle} ${currentScope}`)
}

export function currentStepHasSingleWebSearchLimit(state: Pick<
  AgentStateData,
  'originalUserRequest' | 'currentPlanItems' | 'currentPlanScopes' | 'currentStepIdx'
>): boolean {
  const currentTitle = state.currentPlanItems?.[state.currentStepIdx] || ''
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx] || ''
  const requestLimit = explicitWebSearchLimitFromText(state.originalUserRequest || '') === 1
  return requestLimit ||
    explicitWebSearchLimitFromText(`${currentTitle} ${currentScope}`) === 1 ||
    /\bexactly\s+one\s+web_search\b/i.test(`${currentTitle} ${currentScope}`)
}
