const NUMBER_WORDS = new Map<string, number>([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
])

const SOURCE_COUNT_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:current|official|primary|credible|authoritative|independent|distinct|different|direct|linked|strong)\s+){0,4}sources?\b/gi
const COMPARISON_OR_MULTI_SOURCE_RE = /\b(?:compare|comparison|versus|vs\.?|sources|citations?|references?|links)\b/i
const OFFICIAL_SOURCE_CONSTRAINT_RE = /\b(?:official|first[-\s]?party)[-\s]+(?:(?:primary|direct|original|authoritative|first[-\s]?party)[-\s]+){0,3}(?:sources?|documentation|docs?|publications?|reports?|pages?|websites?|data)\b/i
const PRIMARY_SOURCE_CONSTRAINT_RE = /\b(?:primary|first[-\s]?party|original|direct)[-\s]+sources?\b/i

const DIRECT_SOURCE_ROUTE_PARTS = new Set([
  'api',
  'apis',
  'changelog',
  'developer',
  'developers',
  'docs',
  'documentation',
  'newsroom',
  'papers',
  'press',
  'publication',
  'publications',
  'reference',
  'release',
  'releases',
  'research',
  'status',
])
const DIRECT_SOURCE_TITLE_RE = /\b(?:api\s+reference|changelog|developer\s+documentation|documentation|official\s+(?:announcement|documentation|release)|press\s+release|publication|release\s+notes?|research\s+(?:paper|publication)|technical\s+paper)\b/i
const GENERIC_HOST_LABELS = new Set([
  'api', 'app', 'blog', 'cloud', 'developer', 'developers', 'docs', 'documentation',
  'help', 'learn', 'news', 'newsroom', 'portal', 'press', 'research', 'status',
  'support', 'www',
])

const RESEARCH_RESULT_TOOLS = new Set([
  'web_search',
  'browser_navigate',
  'browser_get_content',
  'browse_page',
  'browser_find_text',
  'http_request',
  'read_document',
  'image_search',
])

export interface BriefInlineResearchEvidenceSnapshot {
  request: string
  researchCalls: number
  openedSourceUrls: Iterable<string>
  sourceEvidence?: Iterable<{
    url: string
    title?: string
  }>
  toolResults: Array<{
    toolName: string
    isError: boolean
    acceptedForExecution?: boolean
  }>
}

export interface BriefInlineResearchEvidenceAssessment {
  ready: boolean
  reason: 'ready' | 'missing-successful-action' | 'insufficient-count' | 'explicit-source-quality'
  requiredOpenedSources: number
  distinctOpenedSources: number
  qualifyingSourceCount: number
  rejectedDomains: string[]
  recoveryInstruction?: string
}

export interface BriefInlineRunResearchEvidenceSnapshot {
  request: string
  successfulToolTypeCounts: Iterable<readonly [string, number]>
  openedSourceUrls: Iterable<string>
  sourceEvidence?: Iterable<{
    url: string
    title?: string
  }>
}

export interface BriefInlinePlanFastForwardSnapshot {
  request: string
  planItems: readonly string[]
  planScopes?: readonly (string | null | undefined)[] | null
  currentStepIdx: number
}

const EXPLICIT_SEPARATE_PHASES_RE = new RegExp(
  String.raw`\b(?:use|in|as|across|with|make|create|follow)\s+(?:exactly\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:separate|distinct|individual)\s+)?(?:phases?|steps?)\b|` +
  String.raw`\b(?:separate|distinct|individual)\s+(?:phases?|steps?)\b|` +
  String.raw`\b(?:keep|treat|handle|perform|complete)\b.{0,60}\bseparate(?:ly)?\b|` +
  String.raw`\b(?:step|phase)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b|` +
  String.raw`\b(?:step[- ]by[- ]step|one\s+(?:step|phase)\s+at\s+a\s+time)\b|` +
  String.raw`\b(?:do\s+not|don't|dont|never)\s+(?:skip|combine|collapse|merge)\b`,
  'i',
)
const EVIDENCE_LOCAL_SYNTHESIS_RE = /\b(?:compare|contrast|synthesi[sz]e|analy[sz]e|summari[sz]e)\b/i
const NEW_EVIDENCE_OR_EXTERNAL_WORK_RE = /\b(?:search|research|browse|navigate|open|read|visit|fetch|gather|collect|extract|retrieve|obtain|locate|discover|verify|validate|fact[- ]?check|corroborate|confirm|cross[- ]?check|download|upload)\b/i
const NEW_EVIDENCE_TARGET_RE = /\b(?:new|additional|another|more|further|fresh|independent)\s+(?:sources?|evidence|facts?|data|references?|citations?)\b/i
const NON_INLINE_ARTIFACT_RE = /\b(?:files?|documents?|pdfs?|markdown|slides?|presentations?|decks?|images?|photos?|pictures?|assets?|websites?|webpages?|web\s+pages?|apps?|code|scripts?|spreadsheets?)\b/i
const INTERMEDIATE_DELIVERY_WORK_RE = /\b(?:write|draft|compose|produce|create|build|implement|deliver|present|answer|respond|publish|export)\b/i
const FINAL_INLINE_DELIVERY_RE = /\b(?:answer|write|deliver|present|provide|return|respond|report|list|give|compose|produce|summari[sz]e|recommend)\b/i

function planStepText(
  snapshot: BriefInlinePlanFastForwardSnapshot,
  stepIdx: number,
): string {
  return [snapshot.planItems[stepIdx] || '', snapshot.planScopes?.[stepIdx] || '']
    .filter(Boolean)
    .join(' ')
    .trim()
}

function isEvidenceLocalSynthesisStep(text: string): boolean {
  if (!text || !EVIDENCE_LOCAL_SYNTHESIS_RE.test(text)) return false
  if (NEW_EVIDENCE_OR_EXTERNAL_WORK_RE.test(text)) return false
  if (NEW_EVIDENCE_TARGET_RE.test(text)) return false
  if (NON_INLINE_ARTIFACT_RE.test(text)) return false
  if (INTERMEDIATE_DELIVERY_WORK_RE.test(text)) return false
  return true
}

function isInlineFinalDeliveryStep(text: string): boolean {
  if (!text || !FINAL_INLINE_DELIVERY_RE.test(text)) return false
  if (NEW_EVIDENCE_OR_EXTERNAL_WORK_RE.test(text)) return false
  if (NEW_EVIDENCE_TARGET_RE.test(text)) return false
  if (NON_INLINE_ARTIFACT_RE.test(text)) return false
  return true
}

/**
 * Once a brief inline request has already met its evidence floor, fold only
 * evidence-local thinking phases into the final answer turn. This deliberately
 * leaves the visible plan intact: the caller advances through every skipped
 * index so each corresponding step_advance event is still emitted.
 */
export function briefInlineFinalDeliveryStepIndex(
  snapshot: BriefInlinePlanFastForwardSnapshot,
): number | null {
  const lastStepIdx = snapshot.planItems.length - 1
  if (snapshot.currentStepIdx < 0 || snapshot.currentStepIdx >= lastStepIdx) return null
  if (snapshot.currentStepIdx + 1 >= lastStepIdx) return null
  if (EXPLICIT_SEPARATE_PHASES_RE.test(snapshot.request)) return null

  const finalStepText = planStepText(snapshot, lastStepIdx)
  if (!isInlineFinalDeliveryStep(finalStepText)) return null

  for (let stepIdx = snapshot.currentStepIdx + 1; stepIdx < lastStepIdx; stepIdx++) {
    if (!isEvidenceLocalSynthesisStep(planStepText(snapshot, stepIdx))) return null
  }

  return lastStepIdx
}

function parsedSourceCount(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return NUMBER_WORDS.get(value.toLowerCase()) ?? null
}

export function requestedBriefInlineSourceCount(request: string): number | null {
  let requested: number | null = null
  SOURCE_COUNT_RE.lastIndex = 0
  for (const match of request.matchAll(SOURCE_COUNT_RE)) {
    const count = parsedSourceCount(match[1] || '')
    if (count !== null) requested = Math.max(requested ?? 0, count)
  }
  return requested
}

export function normalizeBriefInlineSourceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|mc_.+)$/i.test(key)) parsed.searchParams.delete(key)
    }
    parsed.searchParams.sort()
    let normalized = parsed.toString()
    if (normalized.endsWith('/') && parsed.pathname !== '/') normalized = normalized.slice(0, -1)
    return normalized
  } catch {
    return rawUrl.trim()
  }
}

function parsedHttpSource(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

function institutionalSourceHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (labels.length < 2) return false
  if (labels.includes('gov') || labels.includes('mil')) return true
  if (labels.at(-1) === 'int' || labels.at(-1) === 'edu') return true
  return labels.length >= 3 && labels.at(-2) === 'ac'
}

function ownerTokensFromHostname(hostname: string): string[] {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  const withoutSuffix = labels.slice(0, Math.max(1, labels.length - 1))
  const tokens = new Set<string>()
  for (const rawLabel of withoutSuffix) {
    if (GENERIC_HOST_LABELS.has(rawLabel) || rawLabel.length < 4) continue
    tokens.add(rawLabel.replace(/[^a-z0-9]/g, ''))
    if (rawLabel.endsWith('blog') && rawLabel.length > 7) {
      tokens.add(rawLabel.slice(0, -4).replace(/[^a-z0-9]/g, ''))
    }
  }
  return [...tokens].filter(token => token.length >= 4)
}

function titleMatchesSourceOwner(hostname: string, title: string): boolean {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!normalizedTitle) return false
  return ownerTokensFromHostname(hostname).some(token => normalizedTitle.includes(token))
}

function hasDirectSourceRouteSignal(parsed: URL, title: string): boolean {
  const routeParts = [
    ...parsed.hostname.toLowerCase().split('.'),
    ...parsed.pathname.toLowerCase().split(/[^a-z0-9]+/),
  ].filter(Boolean)
  return routeParts.some(part => DIRECT_SOURCE_ROUTE_PARTS.has(part)) ||
    DIRECT_SOURCE_TITLE_RE.test(title) ||
    /\.(?:pdf|csv|json)$/i.test(parsed.pathname)
}

function explicitSourceQualityConstraints(request: string): {
  requiresOfficial: boolean
  requiresPrimary: boolean
} {
  return {
    requiresOfficial: OFFICIAL_SOURCE_CONSTRAINT_RE.test(request),
    requiresPrimary: PRIMARY_SOURCE_CONSTRAINT_RE.test(request),
  }
}

function sourcePlausiblySatisfiesExplicitQuality(
  source: { url: string; title?: string },
  constraints: { requiresOfficial: boolean; requiresPrimary: boolean },
): boolean {
  if (!constraints.requiresOfficial && !constraints.requiresPrimary) return true
  const parsed = parsedHttpSource(source.url)
  if (!parsed) return false

  const title = source.title?.trim() || ''
  const institutional = institutionalSourceHost(parsed.hostname)
  const directRoute = hasDirectSourceRouteSignal(parsed, title)
  const ownerAligned = titleMatchesSourceOwner(parsed.hostname, title)
  const structuredFirstPartyHost = parsed.hostname
    .toLowerCase()
    .split('.')
    .some(part => DIRECT_SOURCE_ROUTE_PARTS.has(part))
  const plausiblyOfficial = institutional || structuredFirstPartyHost || (ownerAligned && directRoute)
  const plausiblyPrimary = institutional || structuredFirstPartyHost || (ownerAligned && directRoute)

  return (!constraints.requiresOfficial || plausiblyOfficial) &&
    (!constraints.requiresPrimary || plausiblyPrimary)
}

function sourceEvidenceForOpenedUrls(snapshot: BriefInlineResearchEvidenceSnapshot): Array<{
  url: string
  title?: string
}> {
  const openedUrls = new Map<string, { url: string; title?: string }>()
  for (const rawUrl of snapshot.openedSourceUrls) {
    const url = String(rawUrl).trim()
    if (!url) continue
    const normalized = normalizeBriefInlineSourceUrl(url)
    if (!openedUrls.has(normalized)) openedUrls.set(normalized, { url })
  }
  for (const evidence of snapshot.sourceEvidence || []) {
    const url = evidence.url?.trim()
    if (!url) continue
    const normalized = normalizeBriefInlineSourceUrl(url)
    const opened = openedUrls.get(normalized)
    if (!opened) continue
    if (evidence.title?.trim()) opened.title = evidence.title.trim()
  }
  return [...openedUrls.values()]
}

function sourceDomain(rawUrl: string): string | null {
  return parsedHttpSource(rawUrl)?.hostname.toLowerCase().replace(/^www\./, '') || null
}

export function assessBriefInlineResearchEvidence(
  snapshot: BriefInlineResearchEvidenceSnapshot,
): BriefInlineResearchEvidenceAssessment {
  const explicitSourceCount = requestedBriefInlineSourceCount(snapshot.request)
  const requiredOpenedSources = explicitSourceCount ?? (
    COMPARISON_OR_MULTI_SOURCE_RE.test(snapshot.request) ? 2 : 1
  )
  const openedSources = sourceEvidenceForOpenedUrls(snapshot)
  const distinctOpenedSources = openedSources.length
  const successfulResearchAction = snapshot.toolResults.some(result =>
    !result.isError &&
    result.acceptedForExecution !== false &&
    RESEARCH_RESULT_TOOLS.has(result.toolName),
  )
  if (!successfulResearchAction) {
    return {
      ready: false,
      reason: 'missing-successful-action',
      requiredOpenedSources,
      distinctOpenedSources,
      qualifyingSourceCount: 0,
      rejectedDomains: [],
    }
  }
  if (distinctOpenedSources < requiredOpenedSources || snapshot.researchCalls < requiredOpenedSources) {
    return {
      ready: false,
      reason: 'insufficient-count',
      requiredOpenedSources,
      distinctOpenedSources,
      qualifyingSourceCount: 0,
      rejectedDomains: [],
    }
  }

  const constraints = explicitSourceQualityConstraints(snapshot.request)
  if (!constraints.requiresOfficial && !constraints.requiresPrimary) {
    return {
      ready: true,
      reason: 'ready',
      requiredOpenedSources,
      distinctOpenedSources,
      qualifyingSourceCount: distinctOpenedSources,
      rejectedDomains: [],
    }
  }

  const qualifyingSources = openedSources.filter(source =>
    sourcePlausiblySatisfiesExplicitQuality(source, constraints),
  )
  const rejectedDomains = [...new Set(
    openedSources
      .filter(source => !sourcePlausiblySatisfiesExplicitQuality(source, constraints))
      .map(source => sourceDomain(source.url))
      .filter((domain): domain is string => !!domain),
  )].slice(0, 4)
  if (qualifyingSources.length < requiredOpenedSources) {
    const qualityLabel = constraints.requiresOfficial && constraints.requiresPrimary
      ? 'official primary sources'
      : (constraints.requiresOfficial ? 'official first-party sources' : 'primary sources')
    const missing = requiredOpenedSources - qualifyingSources.length
    return {
      ready: false,
      reason: 'explicit-source-quality',
      requiredOpenedSources,
      distinctOpenedSources,
      qualifyingSourceCount: qualifyingSources.length,
      rejectedDomains,
      recoveryInstruction: [
        `INTERNAL_RECOVERY: the concise request explicitly requires ${qualityLabel}, but only ${qualifyingSources.length}/${requiredOpenedSources} opened sources plausibly satisfy that constraint.`,
        rejectedDomains.length > 0
          ? `Replace the non-primary domains (${rejectedDomains.join(', ')}) rather than reusing or summarizing them.`
          : `Replace ${missing} source${missing === 1 ? '' : 's'} with direct first-party evidence.`,
        'Make one targeted web_search now for the missing claim owner/publisher and prefer its own documentation/API/reference, research/publication, release/changelog, newsroom/press page, or a government/academic publication; the runtime can open the strongest results in parallel.',
        'Do not finalize yet, do not repeat the rejected domains, and do not show this recovery instruction to the user.',
      ].join(' '),
    }
  }

  return {
    ready: true,
    reason: 'ready',
    requiredOpenedSources,
    distinctOpenedSources,
    qualifyingSourceCount: qualifyingSources.length,
    rejectedDomains: [],
  }
}

export function briefInlineResearchEvidenceReady(
  snapshot: BriefInlineResearchEvidenceSnapshot,
): boolean {
  return assessBriefInlineResearchEvidence(snapshot).ready
}

/**
 * Rebuild the concise-answer evidence assessment from run-wide state.
 *
 * Plan advancement intentionally resets the step-local research counters. The
 * final answer gate therefore needs fresh-run tool successes plus the sources
 * actually opened anywhere in this run. Search-result URLs alone do not count:
 * `assessBriefInlineResearchEvidence` intersects source metadata with
 * `openedSourceUrls` before applying source-count and quality requirements.
 */
export function assessBriefInlineRunResearchEvidence(
  snapshot: BriefInlineRunResearchEvidenceSnapshot,
): BriefInlineResearchEvidenceAssessment {
  const successfulResearchTools: Array<[string, number]> = []
  let researchCalls = 0

  for (const [toolName, rawCount] of snapshot.successfulToolTypeCounts) {
    const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
    if (count === 0 || !RESEARCH_RESULT_TOOLS.has(toolName)) continue
    successfulResearchTools.push([toolName, count])
    researchCalls += count
  }

  return assessBriefInlineResearchEvidence({
    request: snapshot.request,
    researchCalls,
    openedSourceUrls: snapshot.openedSourceUrls,
    sourceEvidence: snapshot.sourceEvidence,
    toolResults: successfulResearchTools.map(([toolName]) => ({
      toolName,
      isError: false,
      acceptedForExecution: true,
    })),
  })
}
