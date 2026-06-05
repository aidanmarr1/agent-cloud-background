export type BrowserProgressKind =
  | 'progress'
  | 'no_progress_same_target'
  | 'no_progress_same_page'
  | 'recoverable_block'
  | 'hard_blocker'

export interface BrowserProgressOutcome {
  kind: BrowserProgressKind
  reason: string
  pageSignature: string
  targetKey?: string | null
  recoveryUsed?: boolean
}

export interface BrowserActionRecord {
  toolName: string
  targetKey: string | null
  url: string
  title: string
  pageSignature: string
  progressKind: BrowserProgressKind
  success: boolean
  recoveryUsed: boolean
  createdAt: number
}

export interface BrowserTargetElement {
  index: number
  role: string
  label: string
  primary: string
  groupLabel?: string
  visualLabel?: string
  disabled?: boolean
  unavailable?: boolean
  selected?: boolean
  checked?: boolean
}

export interface BrowserTargetHint {
  index: number
  role: string
  label: string
  recommendedTool: 'browser_click_at' | 'browser_type' | 'browser_select'
  score: number
  reason: string
}

export interface BrowserTaskCompletionSignal {
  completed: boolean
  confidence: number
  reason: string
  evidence: string[]
}

interface BrowserResultLike {
  success?: boolean
  url?: string
  title?: string
  content?: string
  error?: string
  action?: string
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'on', 'in', 'at', 'with',
  'from', 'by', 'this', 'that', 'these', 'those', 'page', 'site', 'website',
  'select', 'choose', 'click', 'go', 'open', 'find', 'use', 'get', 'make',
])

const COLOR_WORDS = new Set([
  'black', 'white', 'silver', 'blue', 'pink', 'green', 'red', 'yellow', 'purple',
  'gold', 'grey', 'gray', 'graphite', 'natural', 'titanium', 'teal', 'orange',
  'lavender', 'sage', 'mist', 'midnight', 'starlight', 'alpine', 'ultramarine',
  'desert', 'rose', 'coral', 'navy', 'cream',
])

const COLOR_SYNONYMS: Record<string, string[]> = {
  silver: ['silver', 'light gray', 'light grey', 'aluminum', 'aluminium'],
  grey: ['grey', 'gray', 'graphite', 'silver'],
  gray: ['gray', 'grey', 'graphite', 'silver'],
  graphite: ['graphite', 'gray', 'grey', 'black'],
  natural: ['natural', 'titanium', 'beige', 'sand'],
  titanium: ['titanium', 'natural'],
  gold: ['gold', 'yellow', 'champagne'],
  pink: ['pink', 'rose'],
  purple: ['purple', 'lavender'],
  lavender: ['lavender', 'purple'],
  blue: ['blue', 'navy', 'mist', 'ultramarine'],
  mist: ['mist', 'blue'],
  green: ['green', 'sage'],
  sage: ['sage', 'green'],
  black: ['black', 'midnight', 'graphite'],
  white: ['white', 'starlight', 'cream'],
  starlight: ['starlight', 'white', 'cream'],
}

const ACTION_WORDS = new Set([
  'add', 'cart', 'bag', 'buy', 'checkout', 'continue', 'next', 'submit', 'save',
  'apply', 'done', 'finish', 'search', 'order', 'pay', 'purchase',
])

const FORM_WORDS = new Set([
  'email', 'name', 'first', 'last', 'phone', 'postcode', 'zipcode', 'zip',
  'address', 'city', 'state', 'country', 'password', 'search', 'query',
  'prompt', 'message', 'chat', 'ask', 'question',
])

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token))
}

function extractRequestedSearchTerms(objectiveText: string): string[] {
  const quoted = objectiveText.match(/\b(?:search|find|look up)\b[^"'`]{0,30}["'`]([^"'`]{2,80})["'`]/i)?.[1]
  const unquoted = objectiveText.match(/\b(?:search(?:\s+(?:for|up))?|find|look up)\s+([^.,;\n]{2,100})/i)?.[1]
  const raw = (quoted || unquoted || '')
    .replace(/\b(?:and then|then|and add|add|put|place|move|click|select|choose|open|go to|press|submit|result|listing|product)\b[\s\S]*$/i, '')
    .trim()
  if (!raw) return []
  return Array.from(new Set(tokenize(raw))).slice(0, 5)
}

const GENERIC_OBJECT_WORDS = new Set([
  'item', 'items', 'product', 'products', 'thing', 'things', 'one', 'two', 'three',
  'standard', 'regular', 'single', 'dozen', 'carton', 'block', 'pack', 'packet',
  'box', 'bottle', 'jar', 'can', 'size', 'variant', 'cart', 'basket', 'checkout',
  'buy', 'purchase', 'add', 'put', 'place', 'move', 'search', 'find', 'look', 'up',
])

function objectiveObjectTerms(terms: string[]): string[] {
  return Array.from(new Set(terms.filter(term =>
    term.length > 1 &&
    !STOP_WORDS.has(term) &&
    !ACTION_WORDS.has(term) &&
    !FORM_WORDS.has(term) &&
    !GENERIC_OBJECT_WORDS.has(term)
  ))).slice(0, 6)
}

function extractRequestedCartTerms(objectiveText: string): string[] {
  const searchTerms = objectiveObjectTerms(extractRequestedSearchTerms(objectiveText))
  if (searchTerms.length > 0) return searchTerms

  const quoted = objectiveText.match(/\b(?:add|put|place|move|buy|purchase)\b[^"'`]{0,30}["'`]([^"'`]{2,80})["'`]/i)?.[1]
  const objectMatch = objectiveText.match(/\b(?:add|put|place|move|buy|purchase)\s+(.{2,120}?)\s+(?:to|into|in)\s+(?:the\s+)?(?:cart|bag|basket)\b/i)?.[1] ||
    objectiveText.match(/\b(?:checkout|buy|purchase)\s+(.{2,100})/i)?.[1]
  const raw = (quoted || objectMatch || '')
    .replace(/\b(?:and then|then|with|from|at|on|after|before|checkout|cart|bag|basket)\b[\s\S]*$/i, '')
    .trim()

  return objectiveObjectTerms(tokenize(raw))
}

function isSearchResultClickObjective(objectiveText: string): boolean {
  return /\b(?:click|open|select|choose|visit|go to)\b[\s\S]{0,90}\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|result|listing|product)\b/i.test(objectiveText) ||
    /\b(?:result|listing|product)\b[\s\S]{0,60}\b(?:click|open|select|choose|visit)\b/i.test(objectiveText)
}

function requiresMoreThanNavigation(objectiveText: string): boolean {
  return /\b(?:search|find|look up|click|select|choose|type|fill|submit|add|cart|basket|bag|checkout|buy|purchase|download|configure|pick|result|listing|product|chat|message|ask|prompt|conversation|debate|argue)\b/i.test(objectiveText)
}

function primaryObjectiveLine(objectiveText: string): string {
  return objectiveText.split('\n').map(line => line.trim()).find(Boolean) || objectiveText.trim()
}

function isSetupNavigationObjective(objectiveText: string): boolean {
  const primary = primaryObjectiveLine(objectiveText)
  if (!primary) return false
  if (!/\b(?:navigate|go to|open|visit|homepage|requested site|requested page|site|website)\b/i.test(primary)) return false
  return !/\b(?:search|find|look up|type|fill|submit|add|cart|basket|bag|checkout|buy|purchase|download|configure|select|choose|pick|result|listing|product|chat|message|ask|prompt|conversation|debate|argue)\b/i.test(primary)
}

function extractRequestedHost(objectiveText: string): string | null {
  const match = objectiveText.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?/i)
  if (!match?.[1]) return null
  return match[1].replace(/^www\./, '').toLowerCase()
}

const SETUP_SITE_STOP_WORDS = new Set([
  'navigate', 'directly', 'open', 'visit', 'homepage', 'requested', 'site', 'website',
  'page', 'accept', 'dismiss', 'close', 'cookie', 'cookies', 'location', 'popup',
  'banner', 'modal', 'and', 'the', 'to', 'for',
])

function setupSiteTerms(objectiveText: string): string[] {
  return normalizeText(primaryObjectiveLine(objectiveText))
    .split(/\s+/)
    .filter(token => token.length > 2 && !SETUP_SITE_STOP_WORDS.has(token) && !/^(?:com|org|net|edu|gov|io|ai|app|dev|co|au|uk|ca)$/.test(token))
}

function currentHost(result: BrowserResultLike): string | null {
  try {
    return new URL(result.url || '').hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function detectSetupNavigationCompletion(
  objectiveText: string,
  result: BrowserResultLike,
  rawText: string,
  lowerRaw: string,
): BrowserTaskCompletionSignal | null {
  if (!isSetupNavigationObjective(objectiveText)) return null
  if (/\b(?:checking your browser|verify you are human|captcha|access denied|error page|navigation failed)\b/i.test(lowerRaw)) return null

  const host = currentHost(result)
  const requestedHost = extractRequestedHost(objectiveText)
  const terms = setupSiteTerms(objectiveText)
  const hostMatchesRequested = !!host && !!requestedHost && (host === requestedHost || host.endsWith(`.${requestedHost}`))
  const hostMatchesNamedSite = !!host && terms.some(term => host.includes(term))
  const genericLoadedSite = !!host && !requestedHost && terms.length === 0 && host !== 'about:blank'

  if (!hostMatchesRequested && !hostMatchesNamedSite && !genericLoadedSite) return null

  const usablePageSignal = /\b(?:search|results?|menu|navigation|primary actions|interactive elements|forms|links|map|layers?|forecast|filter|account)\b/i.test(rawText)
  const evidence = [`Current URL host is ${host}.`]
  if (usablePageSignal) evidence.push('The page shows usable site controls/content.')

  return {
    completed: true,
    confidence: usablePageSignal ? 0.82 : 0.74,
    reason: 'The requested site is loaded and usable for the next browser phase.',
    evidence,
  }
}

function isSearchFormEntryObjective(objectiveText: string): boolean {
  const primary = primaryObjectiveLine(objectiveText)
  if (!primary) return false
  const entryIntent = /\b(?:navigate|go to|open|visit|access|load|launch|start|begin|initiate|enter|use|reach)\b/i.test(primary)
  const searchSurface = /\b(?:search|finder|lookup|tool|questionnaire|form|registration|licen[cs]e|permit|business type|activity)\b/i.test(primary)
  if (!entryIntent || !searchSurface) return false

  // "Search for X" usually means results are required. "Start/initiate/open the
  // search/finder/tool" means a ready input form is enough for this phase.
  const asksForResults = /\b(?:search for|find|look up)\b/i.test(primary)
  const namesSearchSurface = /\b(?:search|finder|lookup|tool|questionnaire|form|registration|licen[cs]e|permit)\b/i.test(primary)
  return !asksForResults || namesSearchSurface
}

function detectSearchFormReadyCompletion(
  objectiveText: string,
  result: BrowserResultLike,
  rawText: string,
  lowerRaw: string,
): BrowserTaskCompletionSignal | null {
  if (!isSearchFormEntryObjective(objectiveText)) return null
  if (/\b(?:checking your browser|verify you are human|captcha|access denied|error page|navigation failed)\b/i.test(lowerRaw)) return null

  const formReadyPattern = hasPattern(rawText, [
    /\bstep\s*1\s+of\s+\d+\b/i,
    /\bbusiness type\b[\s\S]{0,220}\b(?:next|previous|your business details)\b/i,
    /\b(?:for example|type keywords|enter keywords|search)\b[\s\S]{0,140}\b(?:next|search|continue)\b/i,
    /\b(?:search|finder|questionnaire|guided search)\b[\s\S]{0,180}\b(?:business|activity|licen[cs]e|permit)\b/i,
  ])
  const inputSignal = /\b(?:text-input|textarea|input|type keywords|for example|business type|activity)\b/i.test(rawText)
  const forwardControl = /\b(?:next|continue|search|submit)\b/i.test(rawText)

  if (!formReadyPattern || (!inputSignal && !forwardControl)) return null

  const evidence = [
    matchingSnippet(rawText, formReadyPattern) || 'A search/finder form is visible.',
  ]
  const host = currentHost(result)
  if (host) evidence.unshift(`Current URL host is ${host}.`)

  return {
    completed: true,
    confidence: 0.84,
    reason: 'The requested search/finder flow is open and ready for the next form input.',
    evidence,
  }
}

function isNamedAiConversationObjective(objectiveText: string): boolean {
  const namedService = /\b(?:gemini|chatgpt|claude|copilot|perplexity|grok|openai|anthropic)\b/i
  const conversationIntent = /\b(?:debate|chat|talk|message|ask|prompt|conversation|argue)\b/i
  return namedService.test(objectiveText) && conversationIntent.test(objectiveText)
}

function allTermsPresent(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const compact = normalizeText(haystack)
  return terms.every(term => compact.includes(normalizeText(term)))
}

function termVariants(term: string): string[] {
  const normalized = normalizeText(term).replace(/\s+/g, '')
  if (!normalized) return []
  const variants = new Set([normalized])
  if (normalized.endsWith('ies') && normalized.length > 4) variants.add(`${normalized.slice(0, -3)}y`)
  if (normalized.endsWith('es') && normalized.length > 4) variants.add(normalized.slice(0, -2))
  if (normalized.endsWith('s') && normalized.length > 3) variants.add(normalized.slice(0, -1))
  if (!normalized.endsWith('s') && /^[a-z]+$/i.test(normalized)) variants.add(`${normalized}s`)
  return [...variants]
}

function resultContainsObjectiveTerm(normalizedResult: string, term: string): boolean {
  const words = new Set(normalizedResult.split(/\s+/).filter(Boolean))
  const compact = normalizedResult.replace(/\s+/g, '')
  return termVariants(term).some(variant =>
    words.has(variant) || (/\d/.test(variant) && compact.includes(variant))
  )
}

function objectiveTermsEvidence(normalizedResult: string, terms: string[]): { present: string[]; missing: string[] } {
  const present: string[] = []
  const missing: string[] = []
  for (const term of terms) {
    if (resultContainsObjectiveTerm(normalizedResult, term)) present.push(term)
    else missing.push(term)
  }
  return { present, missing }
}

function looksLikeSearchListing(rawText: string, url: string): boolean {
  const lower = rawText.toLowerCase()
  const lowerUrl = url.toLowerCase()
  return /\b(search results|results for|showing.{0,40}results|found.{0,30}results)\b/i.test(lower) ||
    /[?&](?:k|q|query|search|field-keywords)=/i.test(lowerUrl) ||
    /\/(?:s|search|search-results)(?:[/?#]|$)/i.test(lowerUrl)
}

function looksLikeOpenedResultPage(rawText: string, url: string): boolean {
  const lower = rawText.toLowerCase()
  const lowerUrl = url.toLowerCase()
  if (!url || /^https?:\/\/(?:www\.)?[^/?#]+\/?$/i.test(url)) return false
  if (looksLikeSearchListing(rawText, url)) return false
  return /\/(?:dp|gp\/product|product|products|item|p|article|news|watch|listing)(?:[/?#]|$)/i.test(lowerUrl) ||
    /\b(?:add to cart|add to basket|buy now|product details|about this item|customer reviews|ratings?|price|availability|article|published|byline)\b/i.test(lower)
}

function hashString(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return String(hash)
}

export function normalizeBrowserUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
      url.searchParams.delete(param)
    }
    url.searchParams.sort()
    let normalized = url.toString()
    if (normalized.endsWith('/') && url.pathname !== '/') normalized = normalized.slice(0, -1)
    return normalized.toLowerCase()
  } catch {
    return rawUrl.toLowerCase().replace(/\/+$/, '')
  }
}

function normalizeBrowserContent(content: string): string {
  const pageMarker = content.lastIndexOf('\nPage:')
  const focused = pageMarker >= 0
    ? content.slice(pageMarker + 1)
    : content.startsWith('Page:') ? content : content
  return focused
    .replace(/\n?TARGET HINTS:[\s\S]*$/i, '')
    .replace(/^.*Page UNCHANGED.*$/gmi, '')
    .replace(/^.*Page changed:.*$/gmi, '')
    .replace(/\[(NEW|JUST CLICKED)\]/gi, '')
    .replace(/\(value: "[^"]*"\)/g, '')
    .replace(/^Focused element:.*$/gmi, '')
    .replace(/^\(format:.*$/gmi, '')
    .replace(/Scroll position:\s*\d+px\s*\/\s*\d+px/gi, '')
    .replace(/scroll\s+\d+\/\d+px/gi, 'scroll')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
}

export function computeBrowserPageSignature(result: BrowserResultLike): string {
  const url = normalizeBrowserUrl(result.url || '')
  const title = normalizeText(result.title || '')
  const contentHash = hashString(normalizeBrowserContent(result.content || ''))
  return `${url}|${title}|${contentHash}`
}

function textForElement(element: BrowserTargetElement): string {
  return normalizeText(`${element.label} ${element.groupLabel || ''} ${element.visualLabel || ''} ${element.primary} ${element.role}`)
}

function recommendedToolForRole(role: string): BrowserTargetHint['recommendedTool'] {
  if (role === 'dropdown') return 'browser_select'
  if (role === 'text-input' || role === 'textarea' || role === 'contenteditable' || role.endsWith('-input')) return 'browser_type'
  return 'browser_click_at'
}

function storageTerms(objective: string): string[] {
  return Array.from(objective.matchAll(/\b\d+\s*(?:gb|tb)\b/gi)).map(match =>
    normalizeText(match[0]).replace(/\s+/g, ''),
  )
}

export function rankBrowserTargets(
  objectiveText: string,
  elements: BrowserTargetElement[],
  opts?: { limit?: number },
): BrowserTargetHint[] {
  const objective = normalizeText(objectiveText)
  const objectiveTokens = new Set(tokenize(objectiveText))
  const objectiveStorage = storageTerms(objectiveText)
  const objectiveColors = [...objectiveTokens].filter(token => COLOR_WORDS.has(token))
  const objectiveActions = [...objectiveTokens].filter(token => ACTION_WORDS.has(token))
  const objectiveForms = [...objectiveTokens].filter(token => FORM_WORDS.has(token))
  const wantsAction = objectiveActions.length > 0
  const wantsForm = objectiveForms.length > 0 || /\b(type|enter|fill|form|prompt|message|chat|ask|question|debate|send)\b/i.test(objectiveText)
  const wantsChoice = /\b(select|choose|option|storage|colour|color|size|model)\b/i.test(objectiveText) ||
    objectiveStorage.length > 0 ||
    objectiveColors.length > 0

  const scored = elements.map(element => {
    const haystack = textForElement(element)
    const reasons: string[] = []
    let score = 0

    for (const token of objectiveTokens) {
      if (!token || STOP_WORDS.has(token)) continue
      if (haystack.split(/\s+/).includes(token)) {
        score += 12
        reasons.push(`matches "${token}"`)
      } else if (haystack.includes(token)) {
        score += 6
      }
    }

    for (const term of objectiveStorage) {
      if (haystack.replace(/\s+/g, '').includes(term)) {
        score += 80
        reasons.push(`matches storage ${term.toUpperCase()}`)
      }
    }

    for (const color of objectiveColors) {
      if (haystack.includes(color)) {
        score += 70
        reasons.push(`matches color "${color}"`)
      } else {
        const synonym = COLOR_SYNONYMS[color]?.find(term => haystack.includes(normalizeText(term)))
        if (synonym) {
          score += 34
          reasons.push(`near color "${color}" via "${synonym}"`)
        }
      }
    }

    for (const action of objectiveActions) {
      if (haystack.includes(action)) {
        score += 50
        reasons.push(`matches action "${action}"`)
      }
    }

    if (wantsAction && ['button', 'link', 'tab', 'menuitem'].includes(element.role) && objectiveActions.some(action => haystack.includes(action))) score += 18
    if (wantsChoice && ['radio', 'checkbox', 'option', 'button', 'tab', 'label'].includes(element.role) && (objectiveStorage.length > 0 || objectiveColors.some(color => haystack.includes(color)))) score += 14
    if (wantsChoice && /\b(option|choice|finish|color|colour|storage|capacity|size|model|variant|swatch|visual color)\b/i.test(`${element.label} ${element.groupLabel || ''} ${element.visualLabel || ''}`)) score += 10
    if (wantsForm && (element.role === 'text-input' || element.role === 'textarea' || element.role === 'contenteditable' || element.role.endsWith('-input'))) score += 38
    if (wantsForm && objectiveForms.some(term => haystack.includes(term))) {
      score += 40
      reasons.push('matches form field')
    }
    if (element.role === 'dropdown' && /\b(dropdown|select|choose|option)\b/i.test(objectiveText)) score += 24

    if (element.disabled || element.unavailable) {
      score -= 120
      reasons.push(element.unavailable ? 'unavailable' : 'disabled')
    }
    if (element.selected || element.checked) {
      const directlyRequested = reasons.some(reason => reason.startsWith('matches'))
      score += directlyRequested ? -8 : -30
      reasons.push(element.checked ? 'already checked' : 'already selected')
    }

    const label = element.label || element.primary || `element ${element.index}`
    return {
      index: element.index,
      role: element.role,
      label,
      recommendedTool: recommendedToolForRole(element.role),
      score,
      reason: reasons.slice(0, 3).join(', ') || 'closest visible actionable control',
    } satisfies BrowserTargetHint
  })

  return scored
    .filter(hint => hint.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, opts?.limit ?? 5)
}

export function formatTargetHints(hints: BrowserTargetHint[]): string {
  if (hints.length === 0) return ''
  const lines = hints.map(hint =>
    `- [${hint.index}] ${hint.role} "${hint.label.slice(0, 80)}" -> ${hint.recommendedTool} (${hint.reason})`,
  )
  return `TARGET HINTS:\n${lines.join('\n')}`
}

export function appendTargetHintsToContent(content: string | undefined, hints: BrowserTargetHint[]): string | undefined {
  const formatted = formatTargetHints(hints)
  if (!formatted) return content
  const cleanContent = (content || '').replace(/\n?TARGET HINTS:[\s\S]*$/i, '').trim()
  return cleanContent ? `${cleanContent}\n\n${formatted}` : formatted
}

function elementForIndex(elements: BrowserTargetElement[] | undefined, index: number): BrowserTargetElement | null {
  return elements?.find(element => element.index === index) || null
}

function indexTarget(index: number, elements?: BrowserTargetElement[]): string {
  const element = elementForIndex(elements, index)
  if (!element) return `idx:${index}`
  return `idx:${index}:${element.role}:${normalizeText(element.label || element.primary).slice(0, 80)}`
}

export function getBrowserActionTargetKey(
  toolName: string,
  args: Record<string, unknown>,
  elements?: BrowserTargetElement[],
): string | null {
  if (toolName === 'browser_action_sequence') {
    const actions = Array.isArray(args.actions) ? args.actions : []
    const first = actions[0] && typeof actions[0] === 'object' ? actions[0] as Record<string, unknown> : null
    const action = typeof first?.action === 'string' ? first.action : ''
    const actionArgs = first?.args && typeof first.args === 'object' ? first.args as Record<string, unknown> : {}
    return action ? `sequence:${action}:${getBrowserActionTargetKey(`browser_${action}`, actionArgs, elements) || 'unknown'}` : null
  }

  if (toolName === 'browser_click_at' || toolName === 'browser_click_and_hold' || toolName === 'browser_hover' || toolName === 'browser_type' || toolName === 'browser_select') {
    if (typeof args.index === 'number' && Number.isInteger(args.index)) return `${toolName}:${indexTarget(args.index, elements)}`
    const selector = typeof args.selector === 'string' ? args.selector.trim().toLowerCase() : ''
    if (selector) return `${toolName}:selector:${selector.slice(0, 120)}`
  }

  if (toolName === 'browser_click') {
    if (typeof args.index === 'number' && Number.isInteger(args.index)) return `${toolName}:${indexTarget(args.index, elements)}`
    const selector = typeof args.selector === 'string' ? args.selector.trim().toLowerCase() : ''
    if (selector) return `${toolName}:selector:${selector.slice(0, 120)}`
  }

  if (toolName === 'browser_drag') {
    const from = typeof args.from_selector === 'string' ? args.from_selector.trim().toLowerCase() : ''
    const to = typeof args.to_selector === 'string' ? args.to_selector.trim().toLowerCase() : ''
    return from || to ? `browser_drag:${from.slice(0, 80)}->${to.slice(0, 80)}` : null
  }

  if (toolName === 'browser_fill_form') {
    const fields = Array.isArray(args.fields) ? args.fields : []
    const key = fields.map(field => {
      if (!field || typeof field !== 'object') return ''
      const f = field as Record<string, unknown>
      if (typeof f.index === 'number') return indexTarget(f.index, elements)
      return typeof f.label === 'string' ? normalizeText(f.label) : ''
    }).filter(Boolean).join('|')
    return key ? `browser_fill_form:${key.slice(0, 160)}` : null
  }

  if (toolName === 'browser_navigate') {
    return typeof args.url === 'string' ? `browser_navigate:${normalizeBrowserUrl(args.url)}` : null
  }

  if (toolName === 'browser_find_text') {
    return typeof args.query === 'string' ? `browser_find_text:${normalizeText(args.query)}` : null
  }

  if (toolName === 'browser_scroll') {
    return `browser_scroll:${String(args.direction || '')}:${String(args.amount || '')}`
  }

  if (toolName === 'browser_press_key') {
    return typeof args.key === 'string' ? `browser_press_key:${args.key.toLowerCase()}` : null
  }

  return null
}

export function isBrowserRecoveryTool(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'browser_scroll' || toolName === 'browser_find_text' || toolName === 'browser_screenshot' || toolName === 'browser_get_content') {
    return true
  }
  if (toolName === 'browser_press_key') {
    return typeof args.key === 'string' && args.key.toLowerCase() === 'escape'
  }
  if (toolName === 'browser_navigate') return true
  return false
}

export function classifyBrowserProgress(
  history: BrowserActionRecord[],
  toolName: string,
  args: Record<string, unknown>,
  result: BrowserResultLike,
  targetKey: string | null,
): BrowserProgressOutcome {
  const combined = `${result.error || ''}\n${result.content || ''}`.toLowerCase()
  const pageSignature = computeBrowserPageSignature(result)
  const recoveryUsed = isBrowserRecoveryTool(toolName, args)

  if (/\b(captcha|2fa|two-factor|login required|sign in required|payment required|credit card|access denied|forbidden|rate limited|sold out|out of stock|unavailable|server error|http 4\d\d|http 5\d\d)\b/i.test(combined)) {
    return { kind: 'hard_blocker', reason: 'Result names a concrete site blocker.', pageSignature, targetKey, recoveryUsed }
  }

  if (result.error || result.success === false) {
    return { kind: 'recoverable_block', reason: 'Browser action failed but may be recoverable with a fresh page tactic.', pageSignature, targetKey, recoveryUsed }
  }

  const previous = [...history].reverse().find(record => record.toolName.startsWith('browser_'))
  if (!previous) {
    return { kind: 'progress', reason: 'First browser state recorded.', pageSignature, targetKey, recoveryUsed }
  }

  if (recoveryUsed) {
    return { kind: 'progress', reason: 'Recovery tactic used; allow a new target decision.', pageSignature, targetKey, recoveryUsed }
  }

  if (previous.pageSignature === pageSignature) {
    if (targetKey && previous.targetKey === targetKey) {
      return { kind: 'no_progress_same_target', reason: 'Same target produced the same page signature.', pageSignature, targetKey, recoveryUsed }
    }
    return { kind: 'no_progress_same_page', reason: 'Action left the page signature unchanged.', pageSignature, targetKey, recoveryUsed }
  }

  return { kind: 'progress', reason: 'Page signature changed after the action.', pageSignature, targetKey, recoveryUsed }
}

function hasPattern(value: string, patterns: RegExp[]): RegExp | null {
  return patterns.find(pattern => pattern.test(value)) || null
}

function compactEvidence(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 140)
}

function matchingSnippet(rawText: string, pattern: RegExp): string | null {
  const match = rawText.match(pattern)
  if (!match) return null
  return compactEvidence(match[0])
}

function visibleValidationEvidence(rawText: string): string[] {
  const lines = rawText.split('\n').map(line => line.trim()).filter(Boolean)
  const errors: string[] = []
  let inBlock = false
  for (const line of lines) {
    if (/^VISIBLE VALIDATION ERRORS:?$/i.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (!line.startsWith('- ')) break
    errors.push(compactEvidence(line.slice(2)))
    if (errors.length >= 5) break
  }
  if (errors.length > 0) return errors

  const validationMatch = rawText.match(/\b(?:required|invalid|too short|too long|too weak|must (?:be|include|contain)|can be \d+\s+to\s+\d+\s+characters?|please (?:enter|select|choose|create)|already taken|not allowed)\b.{0,120}/i)
  return validationMatch ? [compactEvidence(validationMatch[0])] : []
}

function termIsMarkedSelected(rawText: string, normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizeText(term).replace(/\s+/g, '')
  if (!normalizedTerm) return false
  const rawTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const selectedNearTerm = new RegExp(`\\b(?:selected|checked|pressed|current)\\b[\\s\\S]{0,90}\\b${rawTerm}\\b|\\b${rawTerm}\\b[\\s\\S]{0,90}\\b(?:selected|checked|pressed|current)\\b`, 'i')
  if (selectedNearTerm.test(rawText)) return true

  const selectedIndex = normalizedText.search(/\b(selected|checked|pressed|current)\b/)
  const termIndex = normalizedText.replace(/\s+/g, '').indexOf(normalizedTerm)
  return selectedIndex >= 0 && termIndex >= 0 && Math.abs(selectedIndex - termIndex) < 140
}

export function detectBrowserTaskCompletion(
  objectiveText: string,
  result: BrowserResultLike,
): BrowserTaskCompletionSignal {
  const empty: BrowserTaskCompletionSignal = {
    completed: false,
    confidence: 0,
    reason: 'No reliable completion evidence detected.',
    evidence: [],
  }

  if (!objectiveText.trim() || result.error || result.success === false) return empty

  const rawText = [
    result.title || '',
    result.url || '',
    result.action || '',
    result.content || '',
  ].join('\n')
  const lowerRaw = rawText.toLowerCase()
  const normalizedResult = normalizeText(rawText)
  const evidence: string[] = []

  const setupNavigationCompletion = detectSetupNavigationCompletion(objectiveText, result, rawText, lowerRaw)
  if (setupNavigationCompletion) return setupNavigationCompletion

  const searchFormReadyCompletion = detectSearchFormReadyCompletion(objectiveText, result, rawText, lowerRaw)
  if (searchFormReadyCompletion) return searchFormReadyCompletion

  const wantsResultClick = isSearchResultClickObjective(objectiveText)
  const wantsSearch = !wantsResultClick && /\b(search|find|look up)\b/i.test(objectiveText)
  const wantsCart = /\b(add|put|place|move)\b.{0,60}\b(cart|bag|basket)\b|\b(cart|bag|basket)\b.{0,60}\b(add|put|place)\b|\bcheckout\b|\bbuy\b|\bpurchase\b/i.test(objectiveText)
  const wantsFormSubmit = !wantsSearch && (/\b(submit|send|register|sign up|apply|book|reserve|complete).{0,60}\b(form|application|message|booking|registration|reservation)?\b|\bcontact form\b/i.test(objectiveText))
  const wantsDownload = /\b(download|save|export)\b/i.test(objectiveText)
  const wantsConfigure = /\b(select|choose|configure|set|pick).{0,80}\b(option|storage|colour|color|size|model|variant)?\b/i.test(objectiveText) ||
    storageTerms(objectiveText).length > 0 ||
    [...tokenize(objectiveText)].some(token => COLOR_WORDS.has(token))
  const wantsNamedAiConversation = isNamedAiConversationObjective(objectiveText)
  const validationEvidence = visibleValidationEvidence(rawText)
  const wantsValidatedInteraction = wantsFormSubmit ||
    /\b(form|sign[- ]?up|signup|register|registration|submit|credentials?|account|checkout|payment|booking|reservation|application)\b/i.test(objectiveText)

  if (validationEvidence.length > 0 && wantsValidatedInteraction) {
    return {
      completed: false,
      confidence: 0.18,
      reason: 'Visible form validation errors block completion.',
      evidence: validationEvidence,
    }
  }

  if (wantsResultClick) {
    const clicked = /\bclicked\b/i.test(result.action || '')
    if (clicked && looksLikeOpenedResultPage(rawText, result.url || '')) {
      evidence.push(`Opened result page: ${result.title || result.url || 'current page'}.`)
      return {
        completed: true,
        confidence: 0.84,
        reason: 'A clicked search/listing result opened a non-search detail page.',
        evidence,
      }
    }
  }

  if (wantsCart) {
    const requestedCartTerms = extractRequestedCartTerms(objectiveText)
    const clickedAddLike = /\bclicked\b[\s\S]{0,100}\badd(?:ed)?\b[\s\S]{0,60}\b(?:cart|bag|basket)\b|\badd(?:ed)?\b[\s\S]{0,60}\b(?:cart|bag|basket)\b/i.test(result.action || '')
    const currentUrlIsCart = (() => {
      try {
        return /\/(?:cart|bag|basket|checkout)(?:[/?#]|$)/i.test(new URL(result.url || '').pathname)
      } catch {
        return false
      }
    })()
    const emptyCartPattern = /\b(?:cart|bag|basket)\b.{0,80}\b(?:empty|0\s*items?|no\s+items?)\b|\b(?:empty|0\s*items?|no\s+items?)\b.{0,80}\b(?:cart|bag|basket)\b|\$\s*0(?:\.00)?\b/i
    const definitiveCartPattern = hasPattern(lowerRaw, [
      /\badded to (?:your )?(?:cart|bag|basket)\b/i,
      /\bitem(?:s)? added\b/i,
      /\bin (?:your )?(?:cart|bag|basket)\b/i,
      /\b(?:continue|proceed) to checkout\b/i,
    ])
    const cartPageConfirmationPattern = hasPattern(lowerRaw, [
      /\b(?:cart|bag|basket)\b.{0,80}\b(?:contains|subtotal|review|checkout|items?)\b/i,
      /\b(?:view|go to|review|open) (?:cart|bag|basket)\b/i,
    ])
    const hasNonEmptyCartEvidence = !emptyCartPattern.test(lowerRaw) &&
      /\b(?:[1-9]\d*\s+items?|subtotal\s+\$?\s*(?!0(?:\.00)?\b)\d|checkout|continue to checkout|proceed to checkout)\b/i.test(lowerRaw)

    const cartPattern = definitiveCartPattern ||
      ((clickedAddLike || currentUrlIsCart) && cartPageConfirmationPattern && hasNonEmptyCartEvidence
        ? cartPageConfirmationPattern
        : null)

    if (cartPattern) {
      const snippet = matchingSnippet(rawText, cartPattern)
      const itemEvidence = objectiveTermsEvidence(normalizedResult, requestedCartTerms)
      if (requestedCartTerms.length > 0 && itemEvidence.missing.length > 0) {
        return {
          completed: false,
          confidence: 0.38,
          reason: `Cart evidence matched, but requested item term(s) are not visible: ${itemEvidence.missing.join(', ')}.`,
          evidence: [
            snippet || 'Cart or checkout marker is visible.',
            `Requested item terms visible: ${itemEvidence.present.length > 0 ? itemEvidence.present.join(', ') : 'none'}.`,
          ],
        }
      }
      evidence.push(snippet || 'Cart or checkout completion marker is visible.')
      if (requestedCartTerms.length > 0) evidence.push(`Requested item visible: ${requestedCartTerms.join(' ')}.`)
      return {
        completed: true,
        confidence: 0.92,
        reason: 'The page shows cart/bag/checkout completion evidence.',
        evidence,
      }
    }
  }

  if (wantsFormSubmit) {
    const submitPattern = hasPattern(lowerRaw, [
      /\bthank you\b/i,
      /\bsubmitted\b/i,
      /\b(?:message|form|application|request|booking|reservation|registration) (?:sent|submitted|received|complete|confirmed)\b/i,
      /\bconfirmation\b/i,
      /\bsuccess(?:fully)?\b/i,
    ])
    if (submitPattern) {
      const snippet = matchingSnippet(rawText, submitPattern)
      evidence.push(snippet || 'Submission success marker is visible.')
      return {
        completed: true,
        confidence: 0.9,
        reason: 'The page shows form/submission success evidence.',
        evidence,
      }
    }
  }

  if (wantsDownload) {
    const downloadPattern = hasPattern(lowerRaw, [
      /\bdownload(?:ed| complete| ready)\b/i,
      /\bsaved to\b/i,
      /\bdownloads?\//i,
      /\b\w+\.(?:pdf|csv|zip|docx|xlsx|png|jpg|jpeg)\b/i,
    ])
    if (downloadPattern) {
      const snippet = matchingSnippet(rawText, downloadPattern)
      evidence.push(snippet || 'Download completion marker is visible.')
      return {
        completed: true,
        confidence: 0.86,
        reason: 'The browser result shows download evidence.',
        evidence,
      }
    }
  }

  const requestedStorage = storageTerms(objectiveText)
  const requestedColors = tokenize(objectiveText).filter(token => COLOR_WORDS.has(token))
  const requestedSelections = [...requestedStorage, ...requestedColors]
  if (wantsConfigure && requestedSelections.length > 0 && !wantsCart) {
    const selected = requestedSelections.filter(term => termIsMarkedSelected(rawText, normalizedResult, term))
    if (selected.length === requestedSelections.length) {
      evidence.push(`Selected requested option(s): ${selected.join(', ')}`)
      return {
        completed: true,
        confidence: 0.82,
        reason: 'The requested configurator options are marked selected/checked.',
        evidence,
      }
    }
  }

  if (wantsSearch && !wantsCart && !wantsFormSubmit && !wantsDownload) {
    const requestedTerms = extractRequestedSearchTerms(objectiveText)
    const searchPattern = hasPattern(lowerRaw, [
      /\bresults for\b/i,
      /\bsearch results\b/i,
      /\bshowing\b.{0,40}\bresults\b/i,
      /\bfound\b.{0,30}\bresults\b/i,
    ])
    const listingEvidence = searchPattern || looksLikeSearchListing(rawText, result.url || '')
    if (listingEvidence && !/\bno results\b/i.test(lowerRaw) && allTermsPresent(rawText, requestedTerms)) {
      const snippet = searchPattern ? matchingSnippet(rawText, searchPattern) : null
      evidence.push(snippet || 'Search results/listing page is visible.')
      if (requestedTerms.length > 0) evidence.push(`Search terms visible: ${requestedTerms.join(' ')}.`)
      return {
        completed: true,
        confidence: requestedTerms.length > 0 ? 0.84 : 0.76,
        reason: 'The page shows matching search result evidence.',
        evidence,
      }
    }
  }

  if (wantsNamedAiConversation) {
    const servicePattern = hasPattern(lowerRaw, [
      /\bask gemini\b/i,
      /\bgemini\b/i,
      /\bchatgpt\b/i,
      /\bclaude\b/i,
      /\bcopilot\b/i,
      /\bperplexity\b/i,
      /\bgrok\b/i,
    ])
    const responsePattern = hasPattern(rawText, [
      /\bchallenge accepted\b/i,
      /\bopening argument\b/i,
      /\bcounter[- ]argument\b/i,
      /\bmotion:\b/i,
      /\bto kick (?:things )?off\b/i,
      /\b(?:here(?:'|’)?s|here is)\b.{0,120}\b(?:answer|argument|response|take|view)\b/i,
      /\b(?:i can|i will|i would|i think|i believe)\b.{0,120}\b(?:argue|answer|debate|respond|explain)\b/i,
    ])

    if (servicePattern && responsePattern) {
      const snippet = matchingSnippet(rawText, responsePattern)
      evidence.push(snippet || 'The named AI service shows a generated response.')
      return {
        completed: true,
        confidence: 0.86,
        reason: 'The named AI chat page shows a response to the requested conversation prompt.',
        evidence,
      }
    }
  }

  const urlMatch = objectiveText.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:\/[a-z0-9/_-]+)?/i)
  if (urlMatch && /\b(open|navigate|visit|go)\b/i.test(objectiveText) && !requiresMoreThanNavigation(objectiveText)) {
    const requestedHost = urlMatch[1].replace(/^www\./, '').toLowerCase()
    try {
      const currentHost = new URL(result.url || '').hostname.replace(/^www\./, '').toLowerCase()
      if (currentHost === requestedHost || currentHost.endsWith(`.${requestedHost}`)) {
        evidence.push(`Current URL host is ${currentHost}.`)
        return {
          completed: true,
          confidence: 0.74,
          reason: 'The browser is on the requested site.',
          evidence,
        }
      }
    } catch {
      // Non-URL browser states are not completion evidence.
    }
  }

  return empty
}

export function appendTaskCompletionToContent(
  content: string | undefined,
  completion: BrowserTaskCompletionSignal,
): string | undefined {
  const cleanContent = (content || '')
    .replace(/\n?TASK COMPLETION DETECTED:[\s\S]*?(?=\n\nTARGET HINTS:|$)/i, '')
    .replace(/\n?TASK COMPLETION REJECTED:[\s\S]*?(?=\n\nTARGET HINTS:|$)/i, '')
    .trim()

  if (!completion.completed) {
    if (completion.confidence <= 0 || completion.evidence.length === 0) return content
    const evidence = ` Evidence: ${completion.evidence.slice(0, 3).join('; ')}`
    const marker = `TASK COMPLETION REJECTED: ${completion.reason}${evidence}\nDo not emit <next_step/> yet; verify the exact requested item or final state first.`
    return cleanContent ? `${cleanContent}\n\n${marker}` : marker
  }

  const evidence = completion.evidence.length > 0
    ? ` Evidence: ${completion.evidence.slice(0, 3).join('; ')}`
    : ''
  const marker = `TASK COMPLETION DETECTED: ${completion.reason} Confidence ${completion.confidence.toFixed(2)}.${evidence}\nIf this satisfies the current step, emit <next_step/> instead of continuing to click.`
  return cleanContent ? `${cleanContent}\n\n${marker}` : marker
}
