const MIN_REPLAYED_APPEND_OVERLAP_CHARS = 120
const MAX_REPLAYED_APPEND_OVERLAP_CHARS = 32_000

interface MarkdownHeading {
  level: number
  text: string
  normalized: string
}

export interface MarkdownTerminalSectionOrderingIssue {
  terminalHeading: string
  laterHeading: string
}

function markdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  let fenceMarker: '`' | '~' | null = null
  let fenceLength = 0

  for (const line of content.split(/\r?\n/)) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1][0] as '`' | '~'
      if (fenceMarker === null) {
        fenceMarker = marker
        fenceLength = fence[1].length
      } else if (marker === fenceMarker && fence[1].length >= fenceLength) {
        fenceMarker = null
        fenceLength = 0
      }
      continue
    }
    if (fenceMarker !== null) continue

    const match = line.match(/^\s*(#{1,6})[ \t]+(.+?)\s*#*\s*$/)
    if (!match) continue
    const text = match[2].trim()
    const normalized = text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
    if (!normalized) continue
    headings.push({ level: match[1].length, text, normalized })
  }

  return headings
}

function numberedH2Key(heading: MarkdownHeading): string | null {
  if (heading.level !== 2) return null
  const match = heading.normalized.match(
    /^(?:section\s+)?(\d+(?:\.\d+)*)(?:\s*[.):-]\s*|\s+|$)/i,
  )
  if (!match) return null
  return match[1]
    .split('.')
    .map(part => String(Number.parseInt(part, 10)))
    .join('.')
}

function terminalH2Kind(heading: MarkdownHeading): 'conclusion' | 'references' | null {
  if (heading.level !== 2) return null
  const withoutNumber = heading.normalized
    .replace(/^(?:section\s+)?\d+(?:\.\d+)*(?:\s*[.):-]\s*|\s+)/i, '')
    .trim()
  if (/^(?:final\s+)?conclusions?(?:\b|:)/i.test(withoutNumber)) return 'conclusion'
  if (/^(?:references|sources|bibliography|works\s+cited)(?:\b|:)/i.test(withoutNumber)) return 'references'
  return null
}

function isPostReportSupportH2(heading: MarkdownHeading): boolean {
  if (heading.level !== 2) return false
  return /^(?:appendix|appendices|acknowledg(?:e)?ments?|notes?)(?:\b|:)/i.test(heading.normalized)
}

function looksLikeStructuredReport(headings: MarkdownHeading[]): boolean {
  return headings.some(heading =>
    (heading.level === 1 && /\b(?:report|analysis|assessment|review|briefing|white\s+paper)\b/i.test(heading.normalized)) ||
    (heading.level === 2 && /^(?:executive\s+summary|references|sources|bibliography|works\s+cited)(?:\b|:)/i.test(heading.normalized)),
  )
}

/**
 * Return every numbered level-2 section identifier that occurs more than once.
 * Headings inside fenced code blocks are ignored.
 */
export function duplicateNumberedMarkdownH2Sections(content: string): string[] {
  const counts = new Map<string, number>()
  for (const heading of markdownHeadings(content)) {
    const key = numberedH2Key(heading)
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
}

/**
 * Reports a report body that restarts after its conclusion or reference list.
 * References and appendices may follow a conclusion; only appendices/notes may
 * follow references.
 */
export function markdownTerminalSectionOrderingIssues(
  content: string,
): MarkdownTerminalSectionOrderingIssue[] {
  const headings = markdownHeadings(content).filter(heading => heading.level === 2)
  const issues: MarkdownTerminalSectionOrderingIssue[] = []

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    const terminalKind = terminalH2Kind(heading)
    if (!terminalKind) continue

    const later = headings.slice(index + 1).find(candidate => {
      if (isPostReportSupportH2(candidate)) return false
      if (terminalKind === 'conclusion' && terminalH2Kind(candidate) === 'references') return false
      return true
    })
    if (later) {
      issues.push({
        terminalHeading: heading.text,
        laterHeading: later.text,
      })
    }
  }

  return issues
}

function duplicateMajorH2Conflict(
  existingHeadings: MarkdownHeading[],
  incomingHeadings: MarkdownHeading[],
): string | null {
  const existingNumbers = new Set(
    existingHeadings.map(numberedH2Key).filter((key): key is string => Boolean(key)),
  )
  const incomingNumbers = new Set<string>()
  for (const heading of incomingHeadings) {
    const key = numberedH2Key(heading)
    if (!key) continue
    if (existingNumbers.has(key) || incomingNumbers.has(key)) {
      return `numbered level-2 section ${key} already exists`
    }
    incomingNumbers.add(key)
  }

  const existingTerminalKinds = new Set(
    existingHeadings.map(terminalH2Kind).filter((kind): kind is 'conclusion' | 'references' => Boolean(kind)),
  )
  const incomingTerminalKinds = new Set<'conclusion' | 'references'>()
  for (const heading of incomingHeadings) {
    const kind = terminalH2Kind(heading)
    if (!kind) continue
    if (existingTerminalKinds.has(kind) || incomingTerminalKinds.has(kind)) {
      return `${kind === 'references' ? 'references/sources' : 'conclusion'} section already exists`
    }
    incomingTerminalKinds.add(kind)
  }

  const existingH2Labels = new Set(
    existingHeadings
      .filter(heading => heading.level === 2)
      .map(heading => heading.normalized),
  )
  const incomingH2Labels = new Set<string>()
  for (const heading of incomingHeadings) {
    if (heading.level !== 2) continue
    if (existingH2Labels.has(heading.normalized) || incomingH2Labels.has(heading.normalized)) {
      return `level-2 section "${heading.text}" already exists`
    }
    incomingH2Labels.add(heading.normalized)
  }

  return null
}

/**
 * Guard Markdown continuation chunks before append_file mutates the report.
 * Paragraph-only continuation remains valid, while a restarted title, repeated
 * major section, or body section added after the report ending is rejected.
 */
export function markdownAppendStructureConflict(existing: string, incoming: string): string | null {
  if (!incoming.trim()) return null

  const existingHeadings = markdownHeadings(existing)
  const incomingHeadings = markdownHeadings(incoming)
  const combinedHeadings = [...existingHeadings, ...incomingHeadings]
  const structuredReport = looksLikeStructuredReport(combinedHeadings)
  const existingTitles = existingHeadings.filter(heading => heading.level === 1)
  const incomingTitles = incomingHeadings.filter(heading => heading.level === 1)
  const existingTitleLabels = new Set(existingTitles.map(heading => heading.normalized))
  const incomingTitleLabels = new Set<string>()
  for (const heading of incomingTitles) {
    if (existingTitleLabels.has(heading.normalized) || incomingTitleLabels.has(heading.normalized)) {
      return `top-level title "${heading.text}" already exists`
    }
    incomingTitleLabels.add(heading.normalized)
  }
  if (
    structuredReport &&
    (incomingTitles.length > 1 || (existingTitles.length > 0 && incomingTitles.length > 0))
  ) {
    return 'a top-level report title already exists'
  }

  if (structuredReport) {
    const duplicateSection = duplicateMajorH2Conflict(existingHeadings, incomingHeadings)
    if (duplicateSection) return duplicateSection
  }

  const combined = existing
    ? `${existing.replace(/\s+$/, '')}\n\n${incoming.replace(/^\s+/, '')}`
    : incoming
  if (structuredReport) {
    const existingOrderingIssueCount = markdownTerminalSectionOrderingIssues(existing).length
    const combinedOrderingIssues = markdownTerminalSectionOrderingIssues(combined)
    if (combinedOrderingIssues.length > existingOrderingIssueCount) {
      const issue = combinedOrderingIssues.at(-1)!
      return `"${issue.laterHeading}" cannot follow terminal section "${issue.terminalHeading}"`
    }
  }

  return null
}

/**
 * Interrupted provider streams can replay the tail of a recovered file when
 * the continuation call starts. Remove only an exact suffix/prefix overlap;
 * ordinary repeated headings or intentionally similar prose remain untouched.
 */
export function trimReplayedAppendOverlap(existing: string, incoming: string): string {
  if (!existing || !incoming) return incoming

  const maxOverlap = Math.min(
    existing.length,
    incoming.length,
    MAX_REPLAYED_APPEND_OVERLAP_CHARS,
  )
  if (maxOverlap < MIN_REPLAYED_APPEND_OVERLAP_CHARS) return incoming

  const existingTail = existing.slice(-maxOverlap)
  for (let overlap = maxOverlap; overlap >= MIN_REPLAYED_APPEND_OVERLAP_CHARS; overlap--) {
    if (existingTail.endsWith(incoming.slice(0, overlap))) {
      return incoming.slice(overlap)
    }
  }

  return incoming
}
