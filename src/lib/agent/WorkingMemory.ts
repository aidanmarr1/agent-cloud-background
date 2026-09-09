/** Bounded, source-backed evidence retained across task steps and worker restarts. */
import {
  WORKING_MEMORY_CONTRADICTION_THRESHOLD,
  WORKING_MEMORY_HIGH_CONFIDENCE_DOMAINS,
  WORKING_MEMORY_SUMMARY_MAX_CHARS,
} from './config'

export type FactConfidence = 'high' | 'medium' | 'low'
export interface EvidenceSource {
  url: string
  title?: string
  /** Publication time is only populated from explicit source metadata. */
  publishedAt?: string
  observedAt: number
}
export interface WorkingMemoryFact {
  text: string
  source: string
  sources: EvidenceSource[]
  stepIdx: number
  confidence: FactConfidence
  corroborationCount: number
  importance: number
  relevance: number
  addedAt: number
}
export interface EvidenceContext {
  objective?: string
  title?: string
  publishedAt?: string
  observedAt?: number
}
export interface WorkingMemoryRenderOptions { maxFacts?: number; maxChars?: number; stepIdx?: number }
export interface WorkingMemorySnapshot {
  version: 1
  facts: WorkingMemoryFact[]
  failures: Array<{ tool: string; error: string; stepIdx: number }>
  files: Array<{ path: string; stepIdx: number }>
}

const STOPWORDS = new Set('is of in at to on as by be an or it we us do so if up am my me the and for are but you all her was one our out has had its that this with from they been have will each make like than them then into just over such also more some very what which how please find research about'.split(' '))
const OPPOSING_PAIRS = [
  ['increase', 'decrease'], ['rise', 'fall'], ['grow', 'shrink'], ['true', 'false'],
  ['yes', 'no'], ['positive', 'negative'], ['success', 'failure'], ['open', 'closed'],
  ['available', 'unavailable'], ['active', 'inactive'], ['approved', 'rejected'], ['legal', 'illegal'],
]
const NEGATION = /\b(?:not|no|never|without|cannot)\b|n['’]t\b/i
const MAX_FACTS = 30
const MAX_PASSAGE_CHARS = 700

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
}
function overlap(a: string[], b: string[]): number {
  const other = new Set(b)
  return a.filter(word => other.has(word)).length / Math.max(1, a.length, b.length)
}
function hostname(source: string): string {
  try { return new URL(source).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}
function scoreConfidence(sources: EvidenceSource[]): FactConfidence {
  const hosts = new Set(sources.map(source => hostname(source.url)).filter(Boolean))
  if (hosts.size >= 2) return 'high'
  for (const host of hosts) {
    if (WORKING_MEMORY_HIGH_CONFIDENCE_DOMAINS.some(domain => domain.startsWith('.')
      ? host.endsWith(domain)
      : host === domain || host.endsWith(`.${domain}`))) return 'high'
  }
  return hosts.size ? 'medium' : 'low'
}
function normalizeClaim(text: string): string {
  // Preserve negation, quantities, punctuation and qualifiers; topic similarity
  // alone does not prove two sources made the same claim.
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}
function publicationDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return undefined
  // Require an explicit year; never turn a relative date into a guessed date.
  return /\b(?:19|20)\d{2}\b/.test(value) && Number.isFinite(Date.parse(value)) ? value.trim() : undefined
}
export function evidenceContextFromResult(result: unknown, objective?: string): EvidenceContext {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  return {
    objective,
    title: typeof record.title === 'string' ? record.title.slice(0, 240) : undefined,
    publishedAt: publicationDate(record.publishedAt ?? record.publishedDate ?? record.published_date ?? record.date),
  }
}
function possibleConflict(a: string, b: string): boolean {
  const at = tokenize(a), bt = tokenize(b)
  if (at.length < 4 || bt.length < 4 || overlap(at, bt) < WORKING_MEMORY_CONTRADICTION_THRESHOLD) return false
  if (NEGATION.test(a) !== NEGATION.test(b)) return true
  if (OPPOSING_PAIRS.some(([left, right]) =>
    (at.includes(left) && bt.includes(right)) || (at.includes(right) && bt.includes(left)))) return true
  // Different values only conflict when the surrounding claim matches. Merely
  // mentioning different years or numbers on the same topic is not enough.
  const numbers = /\d+(?:[.,]\d+)*/g
  return a.replace(numbers, '#').toLowerCase() === b.replace(numbers, '#').toLowerCase() &&
    JSON.stringify(a.match(numbers)) !== JSON.stringify(b.match(numbers))
}
function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`
}

export class WorkingMemory {
  private facts: WorkingMemoryFact[] = []
  private failures: WorkingMemorySnapshot['failures'] = []
  private filesCreated: WorkingMemorySnapshot['files'] = []
  constructor(private readonly taskQuestion = '') {}

  private relevance(text: string, objective = ''): number {
    const words = new Set(tokenize(text))
    const score = (query: string) => {
      const terms = tokenize(query)
      return terms.filter(term => words.has(term)).length / Math.max(1, terms.length)
    }
    return Math.min(1, score(this.taskQuestion) * 0.6 + score(objective || this.taskQuestion) * 0.4)
  }

  extractFromSearch(query: string, results: unknown[], stepIdx: number, context: EvidenceContext = {}): void {
    if (!Array.isArray(results)) return
    const candidates = results.slice(0, 40).flatMap(result => {
      if (!result || typeof result !== 'object') return []
      const obj = result as Record<string, unknown>
      const text = typeof obj.snippet === 'string' && obj.snippet.trim()
        ? obj.snippet.trim() : typeof obj.title === 'string' ? obj.title.trim() : ''
      if (text.length < 20) return []
      return [{ text: excerpt(text, MAX_PASSAGE_CHARS), url: typeof obj.url === 'string' ? obj.url : `search: ${query}`,
        context: { ...context, ...evidenceContextFromResult(result, context.objective || query) },
        relevance: this.relevance(text, `${context.objective || ''} ${query}`) }]
    }).sort((a, b) => b.relevance - a.relevance).slice(0, 4)
    for (const candidate of candidates) this.addFact(candidate.text, candidate.url, stepIdx, candidate.context, candidate.relevance)
  }

  extractFromBrowse(url: string, content: string, stepIdx: number, context: EvidenceContext = {}): void {
    if (!content || content.length < 30) return
    // Scan the full bounded document, including later sections. Newlines also
    // delimit evidence in tables, PDFs and pages without sentence punctuation.
    const passages = content.slice(0, 300_000).split(/\n+|(?<=[.!?])\s+/)
      .map(text => text.replace(/\s+/g, ' ').trim())
      .filter(text => text.length >= 30 && !/^(?:skip to|cookies?\b|privacy policy|sign in|log in|menu\b)/i.test(text))
      .flatMap(text => {
        if (text.length <= MAX_PASSAGE_CHARS) return [text]
        const words = text.split(' '), windows: string[] = []
        let start = 0
        while (start < words.length) {
          let end = start, length = 0
          while (end < words.length && length + words[end].length < MAX_PASSAGE_CHARS) length += words[end++].length + 1
          if (end === start) { start++; continue }
          windows.push(`${start > 0 ? '…' : ''}${words.slice(start, end).join(' ')}${end < words.length ? '…' : ''}`)
          start = end
        }
        return windows
      })
    const unique = [...new Set(passages)]
    const ranked = unique.map((text, index) => ({ text, index, relevance: this.relevance(text, context.objective) }))
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
    const relevanceFloor = (ranked[0]?.relevance || 0) * 0.25
    for (const passage of ranked.filter(item => item.relevance >= relevanceFloor).slice(0, 4)) {
      this.addFact(passage.text, url, stepIdx, context, passage.relevance)
    }
  }

  recordFailure(tool: string, error: string, stepIdx: number): void {
    this.failures.push({ tool, error: error.slice(0, 200), stepIdx })
    this.failures = this.failures.slice(-10)
  }
  recordFileCreated(path: string, stepIdx: number): void {
    this.filesCreated = this.filesCreated.filter(file => file.path !== path)
    this.filesCreated.push({ path, stepIdx })
    this.filesCreated = this.filesCreated.slice(-100)
  }
  detectContradictions(newFactText: string): WorkingMemoryFact[] {
    return this.facts.filter(fact => possibleConflict(newFactText, fact.text))
  }
  private addFact(text: string, source: string, stepIdx: number, context: EvidenceContext, relevance: number): void {
    const observedAt = context.observedAt && Number.isFinite(context.observedAt) ? context.observedAt : Date.now()
    const provenance: EvidenceSource = { url: source.slice(0, 2048), title: context.title,
      publishedAt: publicationDate(context.publishedAt), observedAt }
    const existing = this.facts.find(fact => normalizeClaim(fact.text) === normalizeClaim(text))
    if (existing) {
      const sameSource = existing.sources.find(item => item.url === provenance.url &&
        (!item.publishedAt || !provenance.publishedAt || item.publishedAt === provenance.publishedAt))
      if (sameSource) {
        sameSource.publishedAt ||= provenance.publishedAt
        sameSource.title ||= provenance.title
      } else {
        existing.sources = [...existing.sources, provenance].slice(0, 5)
      }
      existing.corroborationCount = Math.max(1, new Set(existing.sources.map(item => hostname(item.url)).filter(Boolean)).size)
      existing.confidence = scoreConfidence(existing.sources)
      existing.relevance = Math.max(existing.relevance, relevance)
      return
    }
    this.facts.push({ text, source: provenance.url, sources: [provenance], stepIdx,
      confidence: scoreConfidence([provenance]), corroborationCount: 1,
      importance: 3 + relevance * 7, relevance, addedAt: observedAt })
    if (this.facts.length > MAX_FACTS) {
      const ranked = this.facts.map((fact, index) => ({ index, score: this.priority(fact) }))
        .sort((a, b) => a.score - b.score || a.index - b.index)
      this.facts.splice(ranked[0].index, 1)
    }
  }
  private priority(fact: WorkingMemoryFact, stepIdx?: number): number {
    return fact.importance + fact.relevance * 10 + fact.corroborationCount +
      (fact.stepIdx === stepIdx ? 3 : 0) + (this.detectContradictions(fact.text).length ? 5 : 0)
  }

  render(opts?: WorkingMemoryRenderOptions): string | null {
    if (!this.facts.length) return null
    const maxFacts = Math.max(1, opts?.maxFacts ?? 15)
    const maxChars = Math.max(250, opts?.maxChars ?? WORKING_MEMORY_SUMMARY_MAX_CHARS)
    let output = `Research evidence (${this.facts.length} passages; source confidence is heuristic):`
    const ranked = [...this.facts].sort((a, b) => this.priority(b, opts?.stepIdx) - this.priority(a, opts?.stepIdx))
    const included = new Set<WorkingMemoryFact>()
    const line = (fact: WorkingMemoryFact) => {
      const sources = fact.sources.map(source => `${source.url}${source.publishedAt ? `; published ${source.publishedAt}` : '; publication date unknown'}; observed ${new Date(source.observedAt).toISOString().slice(0, 10)}`)
      return `- [${fact.confidence}] ${excerpt(fact.text, 300)} (${sources.join(' | ')})`
    }
    for (const fact of ranked) {
      if (included.has(fact) || included.size >= maxFacts) continue
      const conflicts = this.detectContradictions(fact.text)
      const group = [fact, ...conflicts].filter(item => !included.has(item))
      const block = `${conflicts.length ? '\nPossible conflict — unresolved; verify date and scope:' : ''}\n${group.map(line).join('\n')}`
      // Keep conflicting claims together and never slice through a citation.
      if (output.length + block.length > maxChars || included.size + group.length > maxFacts) continue
      output += block
      group.forEach(item => included.add(item))
    }
    const omitted = this.facts.length - included.size
    const note = `\n${omitted} additional passage(s) retained in memory.`
    if (omitted && output.length + note.length <= maxChars) output += note
    return output
  }
  getSummary(): string { return this.render({ maxFacts: 8 }) || '' }
  snapshot(): WorkingMemorySnapshot {
    return JSON.parse(JSON.stringify({ version: 1, facts: this.facts, failures: this.failures, files: this.filesCreated })) as WorkingMemorySnapshot
  }
  restore(snapshot: WorkingMemorySnapshot): void {
    if (snapshot.version !== 1) return
    // Rebuild scores and provenance instead of trusting persisted derived data.
    for (const fact of snapshot.facts.slice(-MAX_FACTS)) {
      if (typeof fact.text !== 'string' || !Array.isArray(fact.sources)) continue
      for (const source of fact.sources.slice(0, 5)) {
        if (typeof source.url !== 'string' || !Number.isFinite(source.observedAt)) continue
        this.addFact(excerpt(fact.text, MAX_PASSAGE_CHARS), source.url, fact.stepIdx,
          { ...source, observedAt: source.observedAt }, this.relevance(fact.text))
      }
    }
    this.failures = snapshot.failures.slice(-10)
    this.filesCreated = snapshot.files.slice(-100)
  }
  factCountSince(previousCount: number): number { return Math.max(0, this.facts.length - previousCount) }
  size(): { facts: number; failures: number; files: number } {
    return { facts: this.facts.length, failures: this.failures.length, files: this.filesCreated.length }
  }
}
