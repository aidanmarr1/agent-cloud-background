const JSON_CHANNEL_MARKER_PATTERN = /\|\s*!\s*\(?\s*json\s*>\s*json\s*\)?|\(?\s*json\s*>\s*json\s*\)?/gi

function containsDisplayToolArgKeys(text: string): boolean {
  return /\\?"action_label\\?"\s*:/.test(text) && /\\?"plan_step_index\\?"\s*:/.test(text)
}

function containsPartialDisplayToolArgKey(text: string): boolean {
  return /\\?"(?:action_label|plan_step_index)\\?"\s*:/.test(text)
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth++
      continue
    }
    if (char === '}') {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

function stripDisplayToolArgJsonLeaks(text: string): string {
  let output = ''
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor)
    if (start === -1) {
      output += text.slice(cursor)
      break
    }

    output += text.slice(cursor, start)
    const end = findBalancedObjectEnd(text, start)

    if (end === -1) {
      const tail = text.slice(start)
      if (containsPartialDisplayToolArgKey(tail)) {
        output += ' '
        break
      }
      output += text[start]
      cursor = start + 1
      continue
    }

    const candidate = text.slice(start, end + 1)
    if (containsDisplayToolArgKeys(candidate)) {
      output += ' '
    } else {
      output += candidate
    }
    cursor = end + 1
  }

  return output.replace(JSON_CHANNEL_MARKER_PATTERN, ' ')
}

export function stripRawToolCallMarkup(text: string): string {
  return stripDisplayToolArgJsonLeaks(text)
    .replace(/<\s*tool[_\s-]*calls?\b[^>]*>[\s\S]*?<\/\s*tool[_\s-]*calls?\s*>/gi, ' ')
    .replace(/&lt;\s*tool[_\s-]*calls?\b[^&]*&gt;[\s\S]*?&lt;\/\s*tool[_\s-]*calls?\s*&gt;/gi, ' ')
    .replace(/<\s*function\s*=\s*["']?[\w.-]+["']?\s*>[\s\S]*?<\/\s*function\s*>/gi, ' ')
    .replace(/&lt;\s*function\s*=\s*["']?[\w.-]+["']?\s*&gt;[\s\S]*?&lt;\/\s*function\s*&gt;/gi, ' ')
    .replace(/<\/?\s*tool[_\s-]*calls?\b[^>]*>/gi, ' ')
    .replace(/&lt;\/?\s*tool[_\s-]*calls?\b[^&]*&gt;/gi, ' ')
    .replace(/<\s*function\s*=\s*[^>]+>/gi, ' ')
    .replace(/<\/\s*function\s*>/gi, ' ')
    .replace(/&lt;\s*function\s*=\s*[^&]+&gt;/gi, ' ')
    .replace(/&lt;\/\s*function\s*&gt;/gi, ' ')
}

/** Light cleanup for streaming chunks -- preserves whitespace so words don't merge */
export function cleanThinkingTags(text: string): string {
  return stripRawToolCallMarkup(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\s*\|?\s*(?:begin|end)[_\s]*of[_\s]*thinking\s*\|?\s*>/gi, '')
    .replace(/\b(?:end_of_thinking|begin_of_thinking|end_thinking|begin_thinking)\b/gi, '')
    .replace(/\(end_of_thinking\)/g, '')
    // Special tokens (fullwidth pipes, sentence boundary tokens)
    .replace(/<\/?[\s]*(?:\uFF5C|[|])[\s]*[A-Za-z_]+[\s]*(?:\uFF5C|[|])[^>]*>/g, '')
    .replace(/<[\s]*(?:\uFF5C|[|])[\s]*[\w\u2581]+[\s]*(?:\uFF5C|[|])[\s]*>/g, '')
    .replace(/<\/?(?:strong|stron|em|b|i|span|p|br|div|a|ul|ol|li|h[1-6])\b[^>]*>?/gi, '')
    .replace(/<\/?(?:strong|stron|em|b|i|span|p|br|div|a|ul|ol|li|h[1-6])\.?/gi, '')
}

/**
 * Strip the per-step reflection scaffolding that PolicyEngine.checkStepReflection
 * injects when a step spins. The model echoes back the labelled enumeration
 * ("1. GOAL: ...", "DONE: ...", "BLOCKER: ...", "NEXT: ..."), and that's
 * scaffolding — not narration the user should see.
 *
 * We deliberately do NOT broaden isIntentionNarration: general meta-narration
 * like "the research so far has established..." is preserved per user request.
 */
export function stripPolicyScaffolding(text: string): string {
  return text
    .replace(/^\s*(?:\d+\.\s*)?(?:\*\*)?(?:GOAL|DONE|BLOCKER|NEXT)(?:\*\*)?\s*:.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
}

/** Full cleanup for complete text blocks (narrations, final deliverable) -- trims result */
export function cleanThinkingTokens(text: string): string {
  return stripPolicyScaffolding(stripRawToolCallMarkup(text)
    .replace(/\\([[\]])/g, '$1')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\s*\|?\s*(?:begin|end)[_\s]*of[_\s]*thinking\s*\|?\s*>/gi, '')
    .replace(/\b(?:end_of_thinking|begin_of_thinking|end_thinking|begin_thinking)\b/gi, '')
    .replace(/\(end_of_thinking\)/g, '')
    // Special tokens (fullwidth pipes, sentence boundary tokens)
    .replace(/<\/?[\s]*(?:\uFF5C|[|])[\s]*[A-Za-z_]+[\s]*(?:\uFF5C|[|])[^>]*>/g, '')
    .replace(/<[\s]*(?:\uFF5C|[|])[\s]*[\w\u2581]+[\s]*(?:\uFF5C|[|])[\s]*>/g, '')
    .replace(/<\/?(?:strong|stron|em|b|i|span|p|br|div|a|ul|ol|li|h[1-6])\b[^>]*>?/gi, '')
    .replace(/<\/?(?:strong|stron|em|b|i|span|p|br|div|a|ul|ol|li|h[1-6])\.?/gi, '')
    // <plan>...</plan> XML form (the model emits this around its per-step micro-plan)
    .replace(/<plan>[\s\S]*?<\/plan>\s*/gi, '')
    .replace(/<plan>\s*/gi, '')
    .replace(/<\/plan>\s*/gi, '')
    // [PLAN]...[/PLAN] bracket form
    .replace(/\[PLAN\][\s\S]*?\[\/PLAN\]/gi, '')
    .replace(/\[PLAN\]\s*\n(?:[ \t]*(?:\d+[.)]\s+|-\s+|\*\s+).+(?:\n|$))+/gi, '')
    .replace(/\[STEP \d+:[\s\S]*?\[\/STEP \d+\]/gi, '')
    .replace(/\[STEP \d+:.*?\]/gi, '')
    .replace(/\[\/STEP \d+\]/gi, '')
    .replace(/^\]\s+/, '')
  ).trim()
}

const PLANNER_VERB_PATTERN = '(?:Navigate(?:\\s+to)?|Go\\s+to|Open|Opening|Browse|Visit|Search(?:ing)?(?:\\s+for)?|Research(?!\\s+(?:shows?|indicates?|confirms?|found|suggests?|reports?|demonstrates?|states?))|Examine|Investigate|Analyze|Compare|Synthesize|Summarize|Compile|Write|Draft|Produce|Deliver|Create|Prepare|Gather|Verify|Check|Fix)'
const TOOL_ACTION_START_PATTERN = new RegExp(`^(?:i(?:['’]ll| will| am going to)\\s+)?${PLANNER_VERB_PATTERN}\\b|^(?:click|type|select|scroll|inspect|read|list|edit|append|build|run|execute|use)\\b`, 'i')
const TOOL_ACTION_SPLIT_PATTERN = new RegExp(`(?=\\b(?:${PLANNER_VERB_PATTERN}|Click|Type|Select|Scroll|Inspect|Read|List|Edit|Append|Build|Run|Execute|Use)\\b)`, 'gi')
const ENUMERATED_PLAN_ITEM_PATTERN = new RegExp(`(?:^|\\s)\\d+[.)]\\s+${PLANNER_VERB_PATTERN}\\b`, 'gi')
const FINDING_SIGNAL_PATTERN = /\b(?:found|discovered|identified|learned|reviewed|examined|analyzed|analysis|research shows?|research indicates?|shows?|showed|confirms?|confirmed|verified|retrieved|gathered|created|built|generated|designed|saved|completed|selected|entered|progressed|synthesized|successfully|states?|stated|says?|said|reports?|reported|defines?|defined|explains?|explained|indicates?|indicated|suggests?|suggested|demonstrates?|demonstrated|according to|evidence|source|page explains|result indicates)\b/i
const BLOCKER_SIGNAL_PATTERN = /\b(?:blocked|paywall|captcha|access denied|unavailable|failed|could not|not found|no visible matches|requires login|requires sign-in|rate limit|403|404|500)\b/i
const MALFORMED_NARRATION_PATTERNS = [
  /\b(?:the\s+The|a\s+A|an\s+An)\b/,
  /\b[a-z]{3,}\s+(?:The|This|These|That)\s+[a-z]/,
  /^the analysis of\b/i,
  /^i have (?:initiated|started|begun|performed|conducted|analyzed|analysed)\b/i,
  /^i (?:have|now have|had)\s+(?:sufficient|enough)\s+(?:evidence|information|context|research)\s+(?:for|on)\s+(?:step|phase|task)\s*\d*\.?$/i,
  /\b(?:step|phase)\s+\d+\b/i,
  /^gather\b.{0,160}\b(?:evidence|information|research|sources?|context)\b/i,
  /\bto\s+i\s+(?:have\s+)?(?:found|identified|confirmed|learned|gathered|examined|reviewed|analyzed|analysed)\b/i,
  /^(?:review|read|open|navigate|search|click|scroll)\b.{0,160}\bi (?:have\s+)?(?:found|identified|confirmed|learned|gathered|examined)\b/i,
]
const PAGE_CHROME_PATTERN = /\b(?:log in|sign in|sign up|sign out|create account|continue with google|continue with linkedin|continue with apple|privacy policy|terms of use|terms and conditions|cookie(?:s| banner)?|subscribe|newsletter|donate|advertisement|sponsored|main menu|navigation menu|table of contents|contents hide|from wikipedia|article needs additional citations|ask anything|what'?s on your mind|new chat|search chats|search input|search button|site search|voice|upload files|checking your browser|verify you are human|just a moment|cloudflare|captcha|recaptcha|security verification)\b/i
const BROWSER_DUMP_PATTERN = /\b(?:Page UNCHANGED|Interactive elements|PRIMARY ACTIONS|FORMS:|NAVIGATION:|LINKS & OTHER|TARGET HINTS|role\s*[→-]|selector|href=|aria-|data-|browser_(?:click|type|scroll|select|navigate|find|screenshot)|@\(\d+,\d+\)|\[\d+\]\s*@\(\d+,\d+\))\b/i
const TOOL_XML_FRAGMENT_PATTERN = /(?:<\s*\/?\s*(?:tool|function|tool_call|toolcall)\b|<\/?[a-z][a-z0-9-]*\.{2,}|<\/[a-z][a-z0-9-]*\b[^.!?]{0,80})/i
const UI_MECHANIC_NARRATION_PATTERNS = [
  /^(?:click|type|select|press|tap|choose)\b/i,
  /\b(?:click|clicked|type|typed|select|selected|press|pressed|tap|tapped|button|element|target|index|\[\d+\]|browser action|tool action)\b.{0,90}\b(?:confirm|submit|send|retry|try|open|focus|prompt|field)\b/i,
  /\b(?:action|click|button|element|target|attempt|browser)\b.{0,90}\b(?:ineffective|no effect|unchanged|did nothing|not work(?:ing)?|failed|unsuccessful|unresponsive)\b/i,
  /\b(?:ineffective|no effect|unchanged|did nothing|not work(?:ing)?|failed|unsuccessful|unresponsive)\b.{0,90}\b(?:action|click|button|element|target|attempt|browser)\b/i,
  /^this (?:indicates|means|suggests|shows)\b.{0,90}\b(?:action|click|button|element|target|attempt)\b/i,
]
const PHASE_LEAK_NARRATION_PATTERNS = [
  /^(?:now\s+)?(?:i(?:'|’)?ll|i will|let me|i am going to)\s+(?:now\s+)?(?:synthesize|summarize|compile|write|draft|produce|create|deliver)\b.{0,120}\b(?:findings?|report|answer|deliverable|summary|comparison|analysis)\b/i,
  /^(?:synthesize|summarize|compile|write|draft|produce|create|deliver)\b.{0,120}\b(?:these|the|my|our|current|prior)?\s*(?:findings?|report|answer|deliverable|summary|comparison|analysis)\b/i,
  /\b(?:these|the|current|prior)\s+findings?\b.{0,120}\b(?:explain why|into|to produce|to write|to create|report|deliverable|final answer|synthesis)\b/i,
]
const PLAN_LEAK_NARRATION_PATTERNS = [
  /^(?:navigate|go to|open|browse|visit|search|research|examine|investigate|analyze|compare|synthesize|summarize|compile|write|draft|produce|deliver|create|prepare|gather|verify|check|fix)\b.{0,180}\b(?:findings?|report|answer|deliverable|sources?|web|official|publication|analysis|review|consultation|step|task)\b/i,
  /^(?:or|and|then)\s+(?:reputable|official|state|territory|source|web|browser|legal|government)\b/i,
  /^(?:state\/territory\)|state[- ]level responses?|or reputable legal analysis sites)(?:\b|[).])/i,
  /\b(?:detailing these amendments|status of legal reviews|provide a comprehensive answer|synthesize all gathered information|compile findings|official government publications|reputable legal analysis sites)\b/i,
]
const HIGH_LEVEL_NEXT_NARRATION_PATTERN = /^(?:(?:next,\s*)?i(?:'|’)?ll|next,\s*i will|i(?:'|’)?ll now|i will now(?:\s+proceed to)?|will(?:\s+now\s+proceed to)?|will|proceeding to|moving forward with|next step:?)\s+(?:analyze|compare|verify|synthesize|review|assess|evaluate|connect|check|look at|extract|consolidate|prepare|gather|develop|explore|organize|compile|finalize|continue|proceed|enter|answer|submit|inspect|open|outline|add|refine|focus|run|update|rebuild|apply|correct|gathering|developing|exploring|organizing|compiling|finalizing|verifying|outlining|adding|refining|focusing|running|updating|rebuilding|applying|correcting)\b/i
const PERMISSION_TO_CONTINUE_PATTERN = /\bif\s+you\s+(?:want|would\s+like|need|prefer),?\s+i\s+(?:can|could|will|would)\s+(?:continue|keep\s+going|go\s+on|proceed|move\s+on|dig\s+deeper|look\s+further|research\s+more|expand|finish)\b/i
const MAX_NARRATION_SENTENCE_LENGTH = 300
const MAX_NARRATION_WORDS = 45
const MIN_NARRATION_WORDS = 12
const MIN_PROGRESS_NARRATION_WORDS = 15
const DEFAULT_NARRATION_MAX_LENGTH = 360
const COMPLETE_SENTENCE_PATTERN = /[.!?][)"'\]]*$/
const DANGLING_NARRATION_END_PATTERN = /\b(?:and|or|but|with|without|to|for|of|in|on|at|by|from|as|than|that|which|while|because|including|such as|rather than|instead of|its|their|the|a|an)$/i
const NON_FINAL_NARRATION_TRAIL_PATTERN = /[:;,]\s*$/
const IMPERATIVE_NARRATION_START_PATTERN = /^(?:confirm|move|proceed|continue|advance|select|choose|enter|fill|submit|go|open|navigate|search|read|scroll|click|type)\b/i
const OPERATIONAL_NARRATION_PATTERNS = [
  /^(?:now\s+)?(?:let me|i(?:['’]ll| will| am going to| need to| should| can| have to))\s+(?:now\s+)?(?:read|scroll|search|open|navigate|click|continue|try|extract|gather|build|create|write|edit|append|verify|check|fix|look|review|inspect|visit|use)\b/i,
  /^the (?:page|article|content|page content|result|results?) (?:loaded|opened|is truncated|was truncated|looks truncated|has loaded)\b/i,
  /^the browser (?:got\s+)?redirected\b/i,
  /^i have (?:searched|looked up|found some relevant information)\b/i,
  /^i have (?:initial\s+)?(?:findings|research|sources|images|enough)\b/i,
  /^now (?:i|let me)\b/i,
  /^continuing with\b/i,
  PERMISSION_TO_CONTINUE_PATTERN,
  /^i(?:['’]ll| will) (?:continue|move on|proceed|switch|try|use)\b/i,
  /^i(?:['’]ll| will| am going to) .*\bnow\b.*\b(?:files?|website|app|page|code|deliverable)\b/i,
]
const INTERNAL_GUARD_PATTERNS = [
  /\bFINAL_STEP_REDIRECT:[^.?!]*(?:[.?!]|$)/gi,
  /\bNavigation failed:\s*(?:HTTP\s*(?:4\d\d|5\d\d)|URL redirected|Page title|Page body)[^.?!]*(?:[.?!]|$)/gi,
  /⚠\s*ERROR PAGE DETECTED[\s\S]*?Use the recovery options in the tool content\.?/gi,
  /\bBROWSER_ACTION_PREFLIGHT_BLOCKED:[^.?!]*(?:[.?!]|$)/gi,
  /\bThe current browser page is marked as a failed\/blocking page[^.?!]*(?:[.?!]|$)/gi,
  /\bDo NOT click elements on this error page[^.?!]*(?:[.?!]|$)/gi,
  /\bDo NOT retry (?:this same URL|the same URL|the exact broken URL)[^.?!]*(?:[.?!]|$)/gi,
  /\bYour search ["“][^"”]+["”] is too similar to a previous search ["“][^"”]+["”][^.?!]*(?:[.?!]|$)/gi,
  /\bYou already searched ["“][^"”]+["”][^.?!]*(?:[.?!]|$)/gi,
  /\bSearch for something substantially different, or browse an existing result URL you haven't visited yet[.?!]?/gi,
  /\bDo NOT search the same thing again[.?!]?/gi,
  /\b(?:INTERNAL_RECOVERY|BLOCKED):[^.?!]*(?:[.?!]|$)/gi,
  /\bTreat this as a recoverable navigation miss[^.?!]*(?:[.?!]|$)/gi,
  /\bThe page is blocked \(HTTP \d+[^.?!]*(?:[.?!]|$)/gi,
  /\brecover with a different source[^.?!]*(?:[.?!]|$)/gi,
  /\b(?:INTERNAL_RECOVERY|BLOCKED):[^.?!]*(?:duplicate|near-duplicate|web_search|search|final-step|deliverable)[^.?!]*(?:[.?!]|$)/gi,
  /\bThe system is (?:incorrectly\s+)?flagging this as a research step[^.?!]*(?:[.?!]|$)/gi,
  /\bthe user's (?:explicit\s+)?instructions[^.?!]*(?:build step|proceed with the build|let me proceed with the build)[^.?!]*(?:[.?!]|$)/gi,
  /\bNavigation failed;\s*choosing another route[.?!]?/gi,
  /\bUse a different website\/source instead of retrying it[.?!]?/gi,
  /\bBLOCKED:\s*the user's request contains an explicit URL\/domain[\s\S]*?concrete blocker[.?!]?/gi,
  /\bSources?:\s*(?:[A-Za-z0-9][A-Za-z0-9.-]*(?:,\s*)?){1,12}\.?/gi,
]

function isToolActionFragment(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (!TOOL_ACTION_START_PATTERN.test(trimmed)) return false
  if (FINDING_SIGNAL_PATTERN.test(trimmed)) return false
  return true
}

function isUiMechanicNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return UI_MECHANIC_NARRATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isPhaseLeakNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return PHASE_LEAK_NARRATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isPlanLeakNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return PLAN_LEAK_NARRATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isHighLevelNextNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || isUiMechanicNarration(trimmed)) return false
  if (/\b(?:click|type|select|press|tap|button|element|index|\[\d+\]|browser_)\b/i.test(trimmed)) return false
  return HIGH_LEVEL_NEXT_NARRATION_PATTERN.test(trimmed)
}

function isOperationalNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (isUiMechanicNarration(trimmed)) return true
  if (FINDING_SIGNAL_PATTERN.test(trimmed)) return false
  if (BLOCKER_SIGNAL_PATTERN.test(trimmed) && !/\b(?:let me|i(?:'ll| will| need to| should| can)|continue|navigate|open|scroll|search|click|read|try)\b/i.test(trimmed)) {
    return false
  }
  return OPERATIONAL_NARRATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isImperativeNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return IMPERATIVE_NARRATION_START_PATTERN.test(trimmed)
}

function isMalformedNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  return MALFORMED_NARRATION_PATTERNS.some(pattern => pattern.test(trimmed))
}

function isCompleteNarrationSentence(text: string): boolean {
  return COMPLETE_SENTENCE_PATTERN.test(text.trim())
}

function looksDanglingNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (NON_FINAL_NARRATION_TRAIL_PATTERN.test(trimmed)) return true
  const stripped = trimmed.replace(/[.!?][)"'\]]*$/, '').trim()
  return DANGLING_NARRATION_END_PATTERN.test(stripped)
}

function countNarrationWords(text: string): number {
  return text
    .split(/\s+/)
    .filter(token => /[A-Za-z0-9\u00C0-\uFFFF]/.test(token))
    .length
}

function findEnumeratedPlanItemEnd(text: string, start: number, nextStart?: number): number {
  if (typeof nextStart === 'number' && nextStart > start) return nextStart

  const max = Math.min(text.length, start + 700)
  for (let i = start; i < max; i++) {
    const char = text[i]
    if (char !== '.' && char !== '!' && char !== '?') continue

    if (i - start <= 5 && /\d+\.$/.test(text.slice(start, i + 1).trim())) continue

    const before = text.slice(Math.max(start, i - 8), i + 1).toLowerCase()
    if (/\b(?:vs|e\.g|i\.e)\.$/.test(before)) continue

    const after = text.slice(i + 1)
    if (/^\s*(?:\d+[.)]\s+|[A-Z*]|$)/.test(after)) return i + 1
  }

  return max
}

function stripEnumeratedPlanItems(text: string): string {
  const matches = Array.from(text.matchAll(ENUMERATED_PLAN_ITEM_PATTERN))
  if (matches.length === 0) return text

  let cursor = 0
  let stripped = ''
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0
    const nextStart = matches[i + 1]?.index
    stripped += text.slice(cursor, start)
    cursor = findEnumeratedPlanItemEnd(text, start, nextStart)
  }

  return stripped + text.slice(cursor)
}

/**
 * Remove leaked tool-call plan text from task narrations.
 *
 * Some models emit content like "Navigate to Wikipedia Search for images"
 * immediately before tool calls. The action pill already represents that work,
 * so showing this as narration creates noisy duplicated planner text.
 */
export function stripToolActionNarration(text: string): string {
  const normalized = INTERNAL_GUARD_PATTERNS
    .reduce((current, pattern) => current.replace(pattern, ' '), stripEnumeratedPlanItems(stripRawToolCallMarkup(text)))
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''

  const sentenceChunks = normalized.split(/(?<=[.!?])\s+/)
  const kept: string[] = []

  for (const chunk of sentenceChunks) {
    if (isHighLevelNextNarration(chunk)) {
      kept.push(chunk.trim())
      continue
    }
    const fragments = chunk.split(TOOL_ACTION_SPLIT_PATTERN).map(part => part.trim()).filter(Boolean)
    const candidates = fragments.length > 0 ? fragments : [chunk.trim()]
    for (const fragment of candidates) {
      if (!isToolActionFragment(fragment) && !isOperationalNarration(fragment)) kept.push(fragment)
    }
  }

  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

export function isIntentionNarration(text: string): boolean {
  const trimmed = text.trim()
  // Only filter very short fragments (under 8 chars) — single words, punctuation
  if (trimmed.length < 8) return true
  if (isPhaseLeakNarration(trimmed)) return true
  if (isPlanLeakNarration(trimmed)) return true
  if (PERMISSION_TO_CONTINUE_PATTERN.test(trimmed)) return true
  if (/^i have (?:searched|looked up)\b/i.test(trimmed)) return true
  // Only filter pure meta-commentary with no factual substance
  const metaPattern = /^(the next step is|my approach is|the plan is|step \d|moving to step|advancing to|let me think|okay so|alright|so basically|here goes|now then)/i
  return metaPattern.test(trimmed) || isOperationalNarration(trimmed)
}

function decodeCommonEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function stripHtmlArtifacts(text: string): string {
  return decodeCommonEntities(text)
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*)?>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*\.{2,}/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*)?$/gi, ' ')
    .replace(/[<>]/g, ' ')
}

function stripMarkdownArtifacts(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

export function stripNarrationArtifacts(text: string): string {
  return stripMarkdownArtifacts(stripHtmlArtifacts(stripToolActionNarration(cleanThinkingTokens(text))))
    .replace(/\bSources?:\s*[^.?!]*(?:[.?!]|$)/gi, ' ')
    .replace(/\b(?:Page text|Target selector|Target path|Nearby text):\s*[^.?!]*(?:[.?!]|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLikelyRawPageNarration(text: string): boolean {
  const trimmed = stripHtmlArtifacts(text).replace(/\s+/g, ' ').trim()
  if (!trimmed) return true
  if (trimmed.length > MAX_NARRATION_SENTENCE_LENGTH) return true
  if (TOOL_XML_FRAGMENT_PATTERN.test(text)) return true
  if (BROWSER_DUMP_PATTERN.test(trimmed)) return true
  if (PAGE_CHROME_PATTERN.test(trimmed)) return true
  if (/\b(?:INTERNAL_RECOVERY|FINAL_STEP_REDIRECT|BROWSER_ACTION_PREFLIGHT_BLOCKED|BLOCKED):/i.test(trimmed)) return true
  if (/\b(?:HTTP\s*)?(?:401|403|404|410|429|500|502|503|504)\b.*\b(?:page|error|failed|blocked|gone|unavailable)\b/i.test(trimmed)) return true
  if (/\b(?:for more details|see (?:our|the) faqs?|learn more|read more|contact us|subscribe|privacy policy|terms of use|cookie policy|sign up|log in|create account)\b/i.test(trimmed)) return true
  if (/\badds that\s+(?:log in|sign in|sign up|create account|continue with|cookie|privacy policy|terms|menu|search|subscribe|donate)\b/i.test(trimmed)) return true
  if (/^[A-Za-z0-9.-]+\.[a-z]{2,}\s+(?:adds|says|states)\s+that\s+(?:log in|sign in|sign up|create account|continue with|cookie|privacy policy|terms|menu|search|subscribe|donate)\b/i.test(trimmed)) return true

  const chromeHits = [
    /\blog in\b/i,
    /\bsign up\b/i,
    /\bprivacy policy\b/i,
    /\bterms\b/i,
    /\bcookie\b/i,
    /\bsubscribe\b/i,
    /\bsearch\b/i,
    /\bmenu\b/i,
    /\bcontinue with\b/i,
  ].filter(pattern => pattern.test(trimmed)).length
  return chromeHits >= 3
}

export function sanitizeNarrationText(
  text: string,
  options: { maxSentences?: number; maxLength?: number; requireSignal?: boolean } = {},
): string | null {
  const maxSentences = options.maxSentences ?? 2
  const maxLength = options.maxLength ?? DEFAULT_NARRATION_MAX_LENGTH
  const requireSignal = options.requireSignal ?? false
  const rawCleaned = stripMarkdownArtifacts(stripHtmlArtifacts(cleanThinkingTokens(text)))
    .replace(/\s+/g, ' ')
    .trim()
  if (isPlanLeakNarration(rawCleaned) || isPhaseLeakNarration(rawCleaned)) return null

  const cleaned = stripNarrationArtifacts(text)
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim()

  if (cleaned.length <= 12 || !cleaned.includes(' ')) return null

  const candidates = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(sentence => stripNarrationArtifacts(sentence).trim())
    .filter(sentence => {
      if (sentence.length < 15) return false
      if (!isCompleteNarrationSentence(sentence)) return false
      if (looksDanglingNarration(sentence)) return false
      if (sentence.length > MAX_NARRATION_SENTENCE_LENGTH) return false
      if (sentence.split(/\s+/).filter(Boolean).length > MAX_NARRATION_WORDS) return false
      if (isMalformedNarration(sentence)) return false
      if (isImperativeNarration(sentence)) return false
      if (isUiMechanicNarration(sentence)) return false
      if (isLikelyRawPageNarration(sentence)) return false
      if (isIntentionNarration(sentence)) return false
      return true
    })

  const sentences: string[] = []
  for (const sentence of candidates) {
    const hasSignal = FINDING_SIGNAL_PATTERN.test(sentence) || BLOCKER_SIGNAL_PATTERN.test(sentence)
    const isNext = sentences.length > 0 && isHighLevelNextNarration(sentence)
    if (sentences.length > 0 && !isNext) continue
    if (requireSignal && !hasSignal && !isNext) continue
    sentences.push(sentence)
    if (sentences.length >= maxSentences) break
  }

  if (sentences.length === 0) return null

  let narrationText = sentences.slice(0, maxSentences).join(' ').replace(/\s+/g, ' ').trim()
  if (narrationText.length > maxLength) {
    const cutPoint = narrationText.lastIndexOf('. ', maxLength - 3)
    narrationText = cutPoint > 50 ? narrationText.slice(0, cutPoint + 1) : ''
  }

  const minWords = requireSignal ? MIN_PROGRESS_NARRATION_WORDS : MIN_NARRATION_WORDS
  return narrationText.length > 12 && countNarrationWords(narrationText) >= minWords ? narrationText : null
}
