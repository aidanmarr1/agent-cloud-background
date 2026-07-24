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
const INLINE_ANSWER_PATTERN = /\b(?:no file|no document|without\s+(?:a\s+)?(?:file|document)|don'?t\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|(?:answer|tell|respond|reply)(?:\s+me)?\b.{0,80}\b(?:directly|in chat|here)|answer\b.{0,40}\bin\s+(?:one|two|three|four|five|\d+)\s+sentences?|(?:one|two|three|four|five|\d+)[-\s]+sentence\s+(?:answer|response|summary)|write\s+(?:it|this|the answer|the\s+(?:final\s+)?report|the summary|the findings?)\s+(?:directly\s+)?(?:in chat|here)|just\s+answer|inline)\b/i
const REPORT_MARKDOWN_DEFAULT_PATTERN = /\b(?:research\b|report(?:\s+on|\s+about)?|research\s+report|findings?|write[-\s]?up|source[-\s]?backed\s+summary|cited\s+summary|compile\s+(?:the\s+)?(?:findings|research|report)|synthesi[sz]e\s+(?:the\s+)?(?:findings|research)|deliver\s+(?:the\s+)?(?:findings|report))\b/i
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

export interface ExplicitTaskToolConstraint {
  /** Named tools/groups that must be used at least once. */
  required: string[]
  /** When non-empty, every tool action must match one of these targets. */
  exclusive: string[]
  /** Tool actions matching these targets are never allowed. */
  forbidden: string[]
}

interface ExplicitToolTargetDefinition {
  target: string
  pattern: string
}

const RAW_TOOL_NAMES = [
  'web_search',
  'image_search',
  'create_file',
  'read_file',
  'delete_file',
  'list_files',
  'edit_file',
  'append_file',
  'export_pdf',
  'read_document',
  'http_request',
  'execute_command',
  'run_code',
  'browser_navigate',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_find_text',
  'browser_screenshot',
  'browser_get_content',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_press_key',
  'browser_go_back',
  'browser_action_sequence',
  'browser_click_and_hold',
  'browser_drag',
] as const

const EXPLICIT_TOOL_TARGETS: ExplicitToolTargetDefinition[] = [
  { target: 'terminal', pattern: String.raw`(?:terminal|shell|command(?:[-\s]?line)?|cli)` },
  { target: 'web_search', pattern: String.raw`(?:web_search|web[-\s]?search(?:\s+tool)?|search(?:ing)?\s+the\s+web)` },
  { target: 'image_search', pattern: String.raw`(?:image_search|image[-\s]?search(?:\s+tool)?|search(?:ing)?\s+(?:for\s+)?images?)` },
  { target: 'browser', pattern: String.raw`(?:browser(?:[-\s]?tools?)?|brows(?:e|ing))` },
  { target: 'read_document', pattern: String.raw`(?:read_document|direct[-\s]?document[-\s]?extraction|document[-\s]?extraction(?:\s+tool)?)` },
  { target: 'http_request', pattern: String.raw`(?:http_request|HTTP(?:\s+request)?)` },
  { target: 'file_tools', pattern: String.raw`(?:file[-\s]?tools?)` },
  { target: 'export_pdf', pattern: String.raw`(?:export_pdf|export(?:ing)?\s+(?:(?:a|the)\s+)?PDF|PDF[-\s]?export(?:\s+tool)?)` },
  ...RAW_TOOL_NAMES
    .filter(name => !['web_search', 'image_search', 'read_document', 'http_request', 'export_pdf'].includes(name))
    .map(name => ({ target: name, pattern: name })),
]

const TERMINAL_TOOL_NAMES = new Set(['execute_command', 'run_code'])
const FILE_TOOL_NAMES = new Set([
  'create_file',
  'read_file',
  'delete_file',
  'list_files',
  'edit_file',
  'append_file',
  'export_pdf',
])

interface DirectiveMatch {
  mode: 'required' | 'exclusive' | 'forbidden' | 'release'
  index: number
  end: number
}

function allDirectiveMatches(
  text: string,
  targetPattern: string,
  mode: DirectiveMatch['mode'],
  patterns: string[],
): DirectiveMatch[] {
  const matches: DirectiveMatch[] = []
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.replaceAll('__TARGET__', targetPattern), 'gi')
    for (const match of text.matchAll(regex)) {
      matches.push({
        mode,
        index: match.index,
        end: match.index + match[0].length,
      })
    }
  }
  return matches
}

function rangesOverlap(a: DirectiveMatch, b: DirectiveMatch): boolean {
  return a.index < b.end && b.index < a.end
}

function directiveModeForTarget(
  text: string,
  targetPattern: string,
): DirectiveMatch['mode'] | null {
  const release = allDirectiveMatches(text, targetPattern, 'release', [
    String.raw`\b(?:do\s+not|don'?t|dont|never)\s+(?:only|exclusively|strictly|solely)\s+(?:use|using)?\s*(?:the\s+)?__TARGET__\b`,
    String.raw`\b(?:no\s+longer|not|isn'?t|is\s+not)\s+(?:the\s+)?__TARGET__[-\s]?(?:only|exclusive)\b`,
    String.raw`\b(?:stop|quit)\s+(?:using|working\s+in)\s+(?:the\s+)?__TARGET__\s+only\b`,
    String.raw`\b(?:do\s+not|don'?t|dont)\s+need\s+to\s+use\s+(?:the\s+)?__TARGET__\b`,
    String.raw`\b(?:can|could|may|might)\s+(?:use|try)\s+(?:the\s+)?__TARGET__\b`,
    String.raw`\bfeel\s+free\s+to\s+use\s+(?:the\s+)?__TARGET__\b`,
  ])
  const exclusive = allDirectiveMatches(text, targetPattern, 'exclusive', [
    String.raw`\b(?:only|exclusively|strictly|solely)\s+(?:use|using|via|with|through|in)?\s*(?:the\s+)?__TARGET__\b`,
    String.raw`\b(?:use|using|via|with|through|in)\s+(?:only|exclusively|strictly|solely)\s*(?:the\s+)?__TARGET__\b`,
    String.raw`\b(?:use|using|via|with|through|in)\s+(?:the\s+)?__TARGET__\s+(?:only|exclusively|strictly|solely)\b`,
    String.raw`\b__TARGET__[-\s]?(?:only|exclusive)\b`,
  ]).filter(candidate => !release.some(other => rangesOverlap(candidate, other)))
  const forbidden = allDirectiveMatches(text, targetPattern, 'forbidden', [
    String.raw`\b(?:do\s+not|don'?t|dont|never|avoid|no\s+longer)\s+(?:use|using|call|calling|open|opening|run|running)?\s*(?:the\s+)?__TARGET__\b`,
    String.raw`\bwithout\s+(?:use|using)?\s*(?:the\s+)?__TARGET__\b`,
    String.raw`\bno\s+(?:use\s+of\s+)?(?:the\s+)?__TARGET__\b`,
  ]).filter(candidate => !release.some(other => rangesOverlap(candidate, other)))
  const stronger = [...release, ...exclusive, ...forbidden]
  const required = allDirectiveMatches(text, targetPattern, 'required', [
    String.raw`\b(?:use|using|via|call|invoke|open|run)\s+(?:the\s+)?__TARGET__\b`,
    String.raw`\b(?:do|run|make|perform|conduct)\s+(?:a\s+)?__TARGET__\b`,
    String.raw`\b(?:do|perform|complete|execute|handle)\s+(?:this|it|the\s+task|the\s+work)\s+(?:in|with|through|via)\s+(?:the\s+)?__TARGET__\b`,
  ]).filter(candidate => !stronger.some(other => rangesOverlap(candidate, other)))

  const candidates = [...stronger, ...required]
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.index - b.index || a.end - b.end)
  return candidates[candidates.length - 1]?.mode || null
}

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

/**
 * Parse clear user-authored named-tool instructions. A plain "use X" requires
 * one X action; "only X" keeps every action inside X; negative directives
 * remove X. Mere mentions and optional suggestions are intentionally ignored.
 */
export function explicitTaskToolConstraintFromText(
  text: string | null | undefined,
): ExplicitTaskToolConstraint | null {
  if (!text) return null
  const required = new Set<string>()
  const exclusive = new Set<string>()
  const forbidden = new Set<string>()

  for (const definition of EXPLICIT_TOOL_TARGETS) {
    let mode = directiveModeForTarget(text, definition.pattern)
    if (!mode && definition.target === 'browser' && /(?:^|[.;!?]\s*|\b(?:please|then)\s+)browse\b/i.test(text)) {
      mode = 'required'
    }
    if (!mode && definition.target === 'web_search' && /(?:^|[.;!?]\s*|\b(?:please|then)\s+)(?:search\s+the\s+web|web[-\s]?search)\b/i.test(text)) {
      mode = 'required'
    }
    if (!mode && definition.target === 'image_search' && /(?:^|[.;!?]\s*|\b(?:please|then)\s+)(?:search\s+(?:for\s+)?images?|image[-\s]?search)\b/i.test(text)) {
      mode = 'required'
    }
    if (!mode && definition.target === 'export_pdf' && /(?:^|[.;!?]\s*|\b(?:please|then)\s+)export\s+(?:(?:a|the)\s+)?PDF\b/i.test(text)) {
      mode = 'required'
    }
    if (!mode || mode === 'release') continue
    if (mode === 'forbidden') {
      forbidden.add(definition.target)
      continue
    }
    required.add(definition.target)
    if (mode === 'exclusive') exclusive.add(definition.target)
  }

  // A natural group alias wins over raw members captured inside the same
  // phrase (for example "browser tools" or "terminal only").
  for (const group of ['terminal', 'browser', 'file_tools']) {
    if (required.has(group)) {
      for (const definition of EXPLICIT_TOOL_TARGETS) {
        if (definition.target !== group && toolMatchesExplicitTaskToolTarget(group, definition.target)) {
          required.delete(definition.target)
          exclusive.delete(definition.target)
        }
      }
    }
    if (forbidden.has(group)) {
      for (const definition of EXPLICIT_TOOL_TARGETS) {
        if (definition.target !== group && toolMatchesExplicitTaskToolTarget(group, definition.target)) {
          forbidden.delete(definition.target)
        }
      }
    }
  }

  if (required.size === 0 && exclusive.size === 0 && forbidden.size === 0) return null
  return {
    required: [...required],
    exclusive: [...exclusive],
    forbidden: [...forbidden],
  }
}

export function toolMatchesExplicitTaskToolTarget(target: string, toolName: string): boolean {
  if (target === 'terminal') return TERMINAL_TOOL_NAMES.has(toolName)
  if (target === 'browser') return toolName === 'browse_page' || toolName.startsWith('browser_')
  if (target === 'file_tools') return FILE_TOOL_NAMES.has(toolName)
  return target === toolName
}

export function explicitTaskToolTargetLabel(target: string): string {
  if (target === 'terminal') return 'terminal command tools'
  if (target === 'browser') return 'browser tools'
  if (target === 'file_tools') return 'file tools'
  return target
}

export function toolAllowedByExplicitTaskConstraint(
  constraint: ExplicitTaskToolConstraint | null,
  toolName: string,
): boolean {
  if (!constraint) return true
  if (constraint.forbidden.some(target => toolMatchesExplicitTaskToolTarget(target, toolName))) return false
  return constraint.exclusive.length === 0 ||
    constraint.exclusive.some(target => toolMatchesExplicitTaskToolTarget(target, toolName))
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
  const explicitArtifact = requestsMarkdownDeliverable(text) || FILE_DELIVERABLE_PATTERN.test(text)
  const reportDefault = REPORT_MARKDOWN_DEFAULT_PATTERN.test(text)
  const taskLevelBrevityText = text.replace(
    /\b(?:short|brief|concise|succinct|small|tiny)\s+(?:executive\s+)?summary\b/gi,
    ' ',
  )
  if (
    !explicitArtifact &&
    /\b(?:brief|briefly|quick|quickly|short|concise|succinct|simple|small|tiny|fast|one[-\s]?sentence|two[-\s]?sentence|in\s+(?:one|two|three|four|five|\d+)\s+sentences?)\b/i.test(taskLevelBrevityText)
  ) {
    return false
  }
  return explicitArtifact || reportDefault
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
