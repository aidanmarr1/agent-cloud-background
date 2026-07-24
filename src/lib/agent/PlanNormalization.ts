export interface PlanPhaseCollection {
  titles: string[]
  scopes: Array<string | null>
}

export interface SourceEvidenceCompactionOptions {
  preserveVisibleStepCount?: boolean
}

const SOURCE_SET_PATTERN = /\b(?:(?:official|primary|credible|authoritative|reliable|current|selected|identified|chosen|found|collected)\s+)*(?:sources?|documents?|reports?|papers?|studies|pages?|references?|documentation)\b/i
const SOURCE_DISCOVERY_ACTION_PATTERN = /\b(?:find|identify|locate|select|choose|gather|collect|search(?:\s+for)?|discover|compile)\b/i
const SOURCE_EXTRACTION_ACTION_PATTERN = /\b(?:extract|read|review|open|pull|capture|record|inspect|analy[sz]e|summari[sz]e)\b/i
const SOURCE_BACK_REFERENCE_PATTERN = /(?:\b(?:each|every|those|these|the|identified|selected|chosen|found|collected|located|same|prior|above)\s+(?:(?:official|primary|credible|authoritative|reliable|current)\s+)*(?:sources?|documents?|reports?|papers?|studies|pages?|references?)\b|\bper\s+(?:(?:official|primary|credible|authoritative|reliable|current)\s+)*(?:source|document|report|paper|study|page|reference)\b)/i
const DISTINCT_OUTPUT_ACTION_PATTERN = /\b(?:compare|contrast|synthesi[sz]e|write|draft|produce|deliver|present|answer|recommend|conclude|rank|score)\b/i
const NUMBERED_SOURCE_KIND_PATTERN = '(source|document|report|paper|study|page|reference)'
const NUMBERED_SOURCE_MODIFIER_PATTERN = '(?:(?:official|primary|credible|authoritative|reliable|current|independent)\\s+)*'
const CARDINAL_SOURCE_NUMBER_PATTERN = '(?:[1-9]\\d*|one|two|three|four|five|six|seven|eight|nine|ten)'
const ORDINAL_SOURCE_NUMBER_PATTERN = '(?:1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)'
const NUMBERED_SOURCE_AFTER_KIND = new RegExp(`\\b(${NUMBERED_SOURCE_MODIFIER_PATTERN})${NUMBERED_SOURCE_KIND_PATTERN}\\s*(?:#\\s*)?(${CARDINAL_SOURCE_NUMBER_PATTERN})\\b`, 'i')
const NUMBERED_SOURCE_BEFORE_KIND = new RegExp(`\\b(${ORDINAL_SOURCE_NUMBER_PATTERN})\\s+(${NUMBERED_SOURCE_MODIFIER_PATTERN})${NUMBERED_SOURCE_KIND_PATTERN}\\b`, 'i')
const SOURCE_TOPIC_STOP_WORDS = new Set([
  'a', 'an', 'and', 'another', 'about', 'current', 'credible', 'document', 'documents',
  'evidence', 'find', 'for', 'from', 'gather', 'identify', 'independent', 'locate', 'of',
  'official', 'on', 'one', 'page', 'pages', 'paper', 'papers', 'primary', 'reference',
  'references', 'reliable', 'report', 'reports', 'search', 'select', 'source', 'sources',
  'study', 'studies', 'the', 'to', 'using', 'with',
])

const SOURCE_NUMBER_VALUES: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
}

const SOURCE_COUNT_WORDS: Record<number, string> = {
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
}

function phaseText(title: string, scope: string | null | undefined): string {
  return `${title} ${scope || ''}`.replace(/\s+/g, ' ').trim()
}

function isSourceDiscoveryPhase(title: string, scope: string | null | undefined): boolean {
  const titleOnly = phaseText(title, null)
  if (
    SOURCE_SET_PATTERN.test(titleOnly) &&
    SOURCE_DISCOVERY_ACTION_PATTERN.test(titleOnly) &&
    !SOURCE_EXTRACTION_ACTION_PATTERN.test(titleOnly) &&
    !DISTINCT_OUTPUT_ACTION_PATTERN.test(titleOnly)
  ) {
    return true
  }

  const text = phaseText(title, scope)
  return SOURCE_SET_PATTERN.test(text) &&
    SOURCE_DISCOVERY_ACTION_PATTERN.test(text) &&
    !SOURCE_EXTRACTION_ACTION_PATTERN.test(text) &&
    !DISTINCT_OUTPUT_ACTION_PATTERN.test(text)
}

function isBackreferencingSourceExtractionPhase(title: string, scope: string | null | undefined): boolean {
  const titleOnly = phaseText(title, null)
  if (
    SOURCE_SET_PATTERN.test(titleOnly) &&
    SOURCE_EXTRACTION_ACTION_PATTERN.test(titleOnly) &&
    SOURCE_BACK_REFERENCE_PATTERN.test(titleOnly) &&
    !SOURCE_DISCOVERY_ACTION_PATTERN.test(titleOnly) &&
    !DISTINCT_OUTPUT_ACTION_PATTERN.test(titleOnly)
  ) {
    return true
  }

  const text = phaseText(title, scope)
  return SOURCE_SET_PATTERN.test(text) &&
    SOURCE_EXTRACTION_ACTION_PATTERN.test(text) &&
    SOURCE_BACK_REFERENCE_PATTERN.test(text) &&
    !SOURCE_DISCOVERY_ACTION_PATTERN.test(text) &&
    !DISTINCT_OUTPUT_ACTION_PATTERN.test(text)
}

function stripTerminalPunctuation(text: string): string {
  return text.trim().replace(/[.!?:;,]+$/g, '')
}

function lowerInitial(text: string): string {
  if (!text) return text
  return `${text[0].toLowerCase()}${text.slice(1)}`
}

function mergedSourceEvidenceTitle(discoveryTitle: string, extractionTitle: string): string {
  const first = stripTerminalPunctuation(discoveryTitle)
  const second = lowerInitial(stripTerminalPunctuation(extractionTitle).replace(/^then\s+/i, ''))
  const combined = `${first} and ${second}`
  if (combined.length <= 140) return combined
  return `${first} and extract evidence from them`
}

function mergedSourceEvidenceScope(
  discoveryTitle: string,
  discoveryScope: string | null | undefined,
  extractionTitle: string,
  extractionScope: string | null | undefined,
): string {
  const discovery = stripTerminalPunctuation(discoveryScope || discoveryTitle)
  const extraction = stripTerminalPunctuation(extractionScope || extractionTitle)
  return `Complete source discovery and extraction in one evidence-gathering phase: ${discovery}; then ${lowerInitial(extraction)}.`
}

function sourceNumberValue(raw: string): number | null {
  const normalized = raw.toLowerCase().replace(/(?:st|nd|rd|th)$/i, '')
  const numeric = Number.parseInt(normalized, 10)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return SOURCE_NUMBER_VALUES[raw.toLowerCase()] ?? null
}

function numberedSourceOrdinal(title: string): number | null {
  const afterKind = title.match(NUMBERED_SOURCE_AFTER_KIND)
  if (afterKind?.[3]) return sourceNumberValue(afterKind[3])

  const beforeKind = title.match(NUMBERED_SOURCE_BEFORE_KIND)
  if (beforeKind?.[1]) return sourceNumberValue(beforeKind[1])
  return null
}

function stripNumberedSourceMarker(text: string): string {
  return text
    .replace(NUMBERED_SOURCE_AFTER_KIND, ' $1$2 ')
    .replace(NUMBERED_SOURCE_BEFORE_KIND, ' $2$3 ')
}

function sourceTopicTokens(title: string, scope: string | null | undefined): Set<string> {
  const text = stripNumberedSourceMarker(phaseText(title, scope))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  return new Set(
    text
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !SOURCE_TOPIC_STOP_WORDS.has(token) && !/^\d+$/.test(token)),
  )
}

function numberedSourceTopicsMatch(
  firstTitle: string,
  firstScope: string | null | undefined,
  nextTitle: string,
  nextScope: string | null | undefined,
): boolean {
  const firstTokens = sourceTopicTokens(firstTitle, firstScope)
  const nextTokens = sourceTopicTokens(nextTitle, nextScope)
  if (firstTokens.size === 0 || nextTokens.size === 0) return firstTokens.size === nextTokens.size

  let shared = 0
  for (const token of firstTokens) {
    if (nextTokens.has(token)) shared += 1
  }
  return shared / Math.min(firstTokens.size, nextTokens.size) >= 0.6
}

function pluralSourceKind(kind: string): string {
  if (/study/i.test(kind)) return 'studies'
  return `${kind.toLowerCase()}s`
}

function mergedNumberedSourceTitle(firstTitle: string, count: number): string {
  const countLabel = SOURCE_COUNT_WORDS[count] || String(count)
  if (NUMBERED_SOURCE_AFTER_KIND.test(firstTitle)) {
    return stripTerminalPunctuation(firstTitle).replace(
      NUMBERED_SOURCE_AFTER_KIND,
      (_match, modifiers: string, kind: string) => `${countLabel} ${modifiers}${pluralSourceKind(kind)}`,
    )
  }
  return stripTerminalPunctuation(firstTitle).replace(
    NUMBERED_SOURCE_BEFORE_KIND,
    (_match, _ordinal: string, modifiers: string, kind: string) => `${countLabel} ${modifiers}${pluralSourceKind(kind)}`,
  )
}

function mergedNumberedSourceScope(
  titles: string[],
  scopes: Array<string | null>,
): string {
  const details: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < titles.length; index++) {
    const detail = stripTerminalPunctuation(scopes[index] || titles[index])
    const dedupeKey = stripNumberedSourceMarker(detail).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (!dedupeKey || seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    details.push(detail)
  }
  return `Gather the numbered sources in one evidence-gathering phase: ${details.join('; ')}.`
}

/**
 * Collapse only two narrow planner failures: one phase finds a source set before
 * the next merely opens that same set, or a consecutive source-1/source-2/source-3
 * run repeats discovery for the same topic. Back-references, sequential numbering,
 * and topic overlap keep unrelated research, comparison, and output phases separate.
 */
export function compactAdjacentSourceEvidencePhases(
  titles: string[],
  scopes: Array<string | null>,
  options: SourceEvidenceCompactionOptions = {},
): PlanPhaseCollection {
  const normalizedScopes = titles.map((_, index) => scopes[index] ?? null)
  if (options.preserveVisibleStepCount || titles.length < 2) {
    return { titles: [...titles], scopes: normalizedScopes }
  }

  const nextTitles: string[] = []
  const nextScopes: Array<string | null> = []

  for (let index = 0; index < titles.length; index++) {
    const currentTitle = titles[index]
    const currentScope = normalizedScopes[index]
    const followingTitle = titles[index + 1]
    const followingScope = normalizedScopes[index + 1]

    const numberedOrdinal = numberedSourceOrdinal(currentTitle)
    if (numberedOrdinal === 1 && isSourceDiscoveryPhase(currentTitle, currentScope)) {
      let runEnd = index + 1
      while (runEnd < titles.length) {
        const expectedOrdinal = runEnd - index + 1
        if (
          numberedSourceOrdinal(titles[runEnd]) !== expectedOrdinal ||
          !isSourceDiscoveryPhase(titles[runEnd], normalizedScopes[runEnd]) ||
          !numberedSourceTopicsMatch(currentTitle, currentScope, titles[runEnd], normalizedScopes[runEnd])
        ) {
          break
        }
        runEnd += 1
      }

      const runLength = runEnd - index
      if (runLength >= 2) {
        const runTitles = titles.slice(index, runEnd)
        const runScopes = normalizedScopes.slice(index, runEnd)
        nextTitles.push(mergedNumberedSourceTitle(currentTitle, runLength))
        nextScopes.push(mergedNumberedSourceScope(runTitles, runScopes))
        index = runEnd - 1
        continue
      }
    }

    if (
      followingTitle &&
      isSourceDiscoveryPhase(currentTitle, currentScope) &&
      isBackreferencingSourceExtractionPhase(followingTitle, followingScope)
    ) {
      nextTitles.push(mergedSourceEvidenceTitle(currentTitle, followingTitle))
      nextScopes.push(mergedSourceEvidenceScope(currentTitle, currentScope, followingTitle, followingScope))
      index += 1
      continue
    }

    nextTitles.push(currentTitle)
    nextScopes.push(currentScope)
  }

  return { titles: nextTitles, scopes: nextScopes }
}
