/**
 * Working memory: accumulates facts learned from search/browse calls across
 * iterations within a single task. Surfaced in step messages as
 * "What you know so far" so the model has persistent grounded context instead
 * of re-deriving its mental state from message history every iteration.
 *
 * Enhanced with confidence scoring, corroboration tracking, contradiction
 * detection, and importance-weighted eviction.
 */

import {
  WORKING_MEMORY_CORROBORATION_THRESHOLD,
  WORKING_MEMORY_CONTRADICTION_THRESHOLD,
  WORKING_MEMORY_HIGH_CONFIDENCE_DOMAINS,
  WORKING_MEMORY_IMPORTANCE_CORROBORATION_BONUS,
  WORKING_MEMORY_MAX_IMPORTANCE,
  WORKING_MEMORY_SUMMARY_MAX_CHARS,
} from './config'

export type FactConfidence = 'high' | 'medium' | 'low'

export interface WorkingMemoryFact {
  text: string              // Human-readable single sentence
  source: string            // URL or query that produced the fact
  stepIdx: number           // Which step this fact came from
  confidence: FactConfidence
  corroborationCount: number // How many independent sources confirmed this
  importance: number         // 0-10, drives eviction priority
  addedAt: number           // Timestamp for age-based tiebreaking
}

export interface WorkingMemoryRenderOptions {
  maxFacts?: number
  maxChars?: number
  stepIdx?: number
}

// Negation/opposing keyword pairs for contradiction detection
const OPPOSING_PAIRS: [string, string][] = [
  ['increase', 'decrease'], ['rise', 'fall'], ['grow', 'shrink'],
  ['true', 'false'], ['yes', 'no'], ['positive', 'negative'],
  ['success', 'failure'], ['open', 'closed'], ['available', 'unavailable'],
  ['active', 'inactive'], ['approved', 'rejected'], ['legal', 'illegal'],
]

/** Tokenize a string into lowercase significant words (>= 3 chars, no stopwords) */
function tokenize(text: string): string[] {
  const stopwords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'had', 'its', 'that', 'this', 'with', 'from', 'they', 'been', 'have', 'will', 'each', 'make', 'like', 'than', 'them', 'then', 'into', 'just', 'over', 'such', 'also', 'more', 'some', 'very'])
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopwords.has(w))
}

/** Compute token overlap ratio between two token arrays */
function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  const overlap = a.filter(t => setB.has(t)).length
  return overlap / Math.min(a.length, b.length)
}

/** Score confidence based on the source domain */
function scoreConfidence(source: string, corroboration: number): FactConfidence {
  if (corroboration >= 2) return 'high'
  const lower = source.toLowerCase()
  for (const domain of WORKING_MEMORY_HIGH_CONFIDENCE_DOMAINS) {
    if (lower.includes(domain)) return 'high'
  }
  if (lower.includes('wikipedia')) return 'medium'
  if (lower.includes('.com') || lower.includes('.net') || lower.includes('.io')) return 'medium'
  return 'low'
}

/** Map confidence to base importance score */
function confidenceToImportance(confidence: FactConfidence): number {
  switch (confidence) {
    case 'high': return 8
    case 'medium': return 5
    case 'low': return 3
  }
}

export class WorkingMemory {
  private facts: WorkingMemoryFact[] = []
  private failures: Array<{ tool: string; error: string; stepIdx: number }> = []
  private filesCreated: Array<{ path: string; stepIdx: number }> = []

  private readonly MAX_FACTS = 30
  private readonly MAX_FAILURES = 10

  /** Pull a few salient findings from a search result and store them. */
  extractFromSearch(query: string, results: unknown[], stepIdx: number): void {
    if (!Array.isArray(results) || results.length === 0) return
    for (const r of results.slice(0, 3)) {
      if (!r || typeof r !== 'object') continue
      const obj = r as { title?: string; snippet?: string; url?: string }
      const text = obj.snippet?.trim() || obj.title?.trim()
      if (!text || text.length < 20) continue
      this.addFact({
        text: text.length > 200 ? text.slice(0, 197) + '...' : text,
        source: obj.url || `search: ${query}`,
        stepIdx,
        confidence: 'low',  // Defaults; addFact() will score properly
        corroborationCount: 1,
        importance: 3,
        addedAt: Date.now(),
      })
    }
  }

  /** Pull salient sentences from a browsed page's content. */
  extractFromBrowse(url: string, content: string, stepIdx: number): void {
    if (!content || content.length < 50) return
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= 30 && s.length <= 250)
      .filter(s => !/^(Skip to|Cookies?|Privacy Policy|Sign in|Log in|Menu|Search|Home|About|Contact)/i.test(s))
      .slice(0, 2)

    for (const sentence of sentences) {
      this.addFact({
        text: sentence,
        source: url,
        stepIdx,
        confidence: 'low',
        corroborationCount: 1,
        importance: 3,
        addedAt: Date.now(),
      })
    }
  }

  /** Track tool failures for the failure-pattern check. */
  recordFailure(toolName: string, error: string, stepIdx: number): void {
    this.failures.push({ tool: toolName, error: error.slice(0, 200), stepIdx })
    if (this.failures.length > this.MAX_FAILURES) this.failures.shift()
  }

  /** Track files created (mostly informational). */
  recordFileCreated(path: string, stepIdx: number): void {
    this.filesCreated.push({ path, stepIdx })
  }

  /**
   * Detect contradictions between a new fact text and existing facts.
   * Returns contradicting existing facts (if any).
   */
  detectContradictions(newFactText: string): WorkingMemoryFact[] {
    const newTokens = tokenize(newFactText)
    if (newTokens.length < 3) return []

    const contradictions: WorkingMemoryFact[] = []

    for (const existing of this.facts) {
      const existingTokens = tokenize(existing.text)
      const overlap = tokenOverlap(newTokens, existingTokens)

      // Need sufficient topic overlap to even consider contradiction
      if (overlap < WORKING_MEMORY_CONTRADICTION_THRESHOLD) continue

      // Check for opposing keyword pairs
      const newSet = new Set(newTokens)
      const existSet = new Set(existingTokens)

      for (const [a, b] of OPPOSING_PAIRS) {
        if ((newSet.has(a) && existSet.has(b)) || (newSet.has(b) && existSet.has(a))) {
          contradictions.push(existing)
          break
        }
      }

      // Check for different numbers in similar contexts
      if (contradictions[contradictions.length - 1] !== existing) {
        const newNumbers = newFactText.match(/\b\d{4}\b/g) || []
        const existNumbers = existing.text.match(/\b\d{4}\b/g) || []
        if (newNumbers.length > 0 && existNumbers.length > 0) {
          const hasConflict = newNumbers.some(n => existNumbers.some(e => n !== e))
          if (hasConflict) contradictions.push(existing)
        }
      }
    }

    return contradictions
  }

  /** Internal: add a fact with confidence scoring and importance-weighted eviction. */
  private addFact(fact: WorkingMemoryFact): void {
    const factTokens = tokenize(fact.text)

    // Check for exact duplicate
    const factLower = fact.text.toLowerCase()
    for (const existing of this.facts) {
      const existingLower = existing.text.toLowerCase()
      if (existingLower === factLower) return
      // Cheap overlap check
      if (factLower.length >= 50 && existingLower.includes(factLower.slice(0, 50))) return
      if (existingLower.length >= 50 && factLower.includes(existingLower.slice(0, 50))) return
    }

    // Check for corroboration: high token overlap from a different source = corroborating
    for (const existing of this.facts) {
      const existingTokens = tokenize(existing.text)
      const overlap = tokenOverlap(factTokens, existingTokens)
      if (overlap >= WORKING_MEMORY_CORROBORATION_THRESHOLD && fact.source !== existing.source) {
        existing.corroborationCount++
        existing.importance = Math.min(
          WORKING_MEMORY_MAX_IMPORTANCE,
          existing.importance + WORKING_MEMORY_IMPORTANCE_CORROBORATION_BONUS,
        )
        existing.confidence = scoreConfidence(existing.source, existing.corroborationCount)
        return // Don't add the duplicate, just boost the existing fact
      }
    }

    // Score the new fact
    fact.confidence = scoreConfidence(fact.source, fact.corroborationCount)
    fact.importance = confidenceToImportance(fact.confidence)
    fact.addedAt = Date.now()

    this.facts.push(fact)
    this.evictLeastImportant()
  }

  /** Evict the least important fact when over capacity. */
  private evictLeastImportant(): void {
    if (this.facts.length <= this.MAX_FACTS) return

    let minIdx = 0
    let minScore = Infinity
    for (let i = 0; i < this.facts.length; i++) {
      const score = this.facts[i].importance + (this.facts[i].corroborationCount * 0.5)
      if (score < minScore) {
        minScore = score
        minIdx = i
      }
    }
    this.facts.splice(minIdx, 1)
  }

  /**
   * Render the working memory as a compact string for inclusion in step messages.
   * Returns null if there are no facts yet.
   */
  render(opts?: WorkingMemoryRenderOptions): string | null {
    if (this.facts.length === 0) return null
    const maxFacts = Math.max(1, opts?.maxFacts ?? 15)
    const maxChars = Math.max(250, opts?.maxChars ?? WORKING_MEMORY_SUMMARY_MAX_CHARS)
    const facts = this.selectFactsForRender(maxFacts, opts?.stepIdx)
    const lines = facts.map((f, i) => {
      const src = f.source.length > 50 ? f.source.slice(0, 47) + '...' : f.source
      const conf = f.confidence === 'high' ? '[H]' : f.confidence === 'medium' ? '[M]' : '[L]'
      const corrob = f.corroborationCount > 1 ? ` x${f.corroborationCount}` : ''
      return `  ${i + 1}. ${conf} ${f.text} (${src}${corrob})`
    })
    const rendered = `What you know so far (${this.facts.length} fact${this.facts.length === 1 ? '' : 's'} collected):\n${lines.join('\n')}`
    return rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars).trimEnd() + '\n...[memory compacted]'
  }

  /** Compact alias for context summaries that expect getSummary(). */
  getSummary(): string {
    return this.render({ maxFacts: 8, maxChars: WORKING_MEMORY_SUMMARY_MAX_CHARS }) || ''
  }

  private selectFactsForRender(maxFacts: number, stepIdx?: number): WorkingMemoryFact[] {
    if (this.facts.length <= maxFacts) return [...this.facts]
    if (typeof stepIdx !== 'number') return this.facts.slice(-maxFacts)

    return this.facts
      .map((fact, index) => ({
        fact,
        index,
        score:
          fact.importance +
          fact.corroborationCount +
          (fact.stepIdx === stepIdx ? 6 : 0) +
          (index / Math.max(1, this.facts.length)),
      }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, maxFacts)
      .sort((a, b) => a.index - b.index)
      .map(item => item.fact)
  }

  /** Get the number of facts added since a given count snapshot. */
  factCountSince(previousCount: number): number {
    return Math.max(0, this.facts.length - previousCount)
  }

  /** For debugging / inspection. */
  size(): { facts: number; failures: number; files: number } {
    return { facts: this.facts.length, failures: this.failures.length, files: this.filesCreated.length }
  }
}
