import { randomUUID } from 'crypto'
import { tursoExecute } from '@/lib/db/turso'
import { SEARCH_STOPWORDS, URL_NORMALIZE_STRIP_PARAMS } from './config'

// Hidden per-task runtime metadata only. This is not agent memory and must not
// be used across fresh tasks; chat startup clears it when a new sandbox starts.
export type ResearchActivityKind = 'search' | 'search_result' | 'visit' | 'extract' | 'failure'

export interface ResearchActivityEntry {
  id: string
  userId: string
  conversationId: string
  runId?: string
  stepIdx: number
  stepTitle?: string
  tool: string
  kind: ResearchActivityKind
  query?: string
  normalizedQuery?: string
  url?: string
  normalizedUrl?: string
  domain?: string
  success: boolean
  error?: string
  resultCount?: number
  titles?: string[]
  sourceUrls?: string[]
  allowedRepeatReason?: string
  createdAt: number
}

export interface ResearchActivityIndex {
  entries: ResearchActivityEntry[]
  searchQueries: Set<string>
  stepSearchQueries: Map<number, Set<string>>
  visitedUrls: Set<string>
  stepVisitedUrls: Map<number, Set<string>>
  domainCounts: Map<string, number>
  stepDomainCounts: Map<number, Map<string, number>>
  failedTargets: Set<string>
}

type ResearchActivityRow = {
  id?: unknown
  user_id?: unknown
  conversation_id?: unknown
  run_id?: unknown
  step_idx?: unknown
  step_title?: unknown
  tool?: unknown
  kind?: unknown
  query?: unknown
  normalized_query?: unknown
  url?: unknown
  normalized_url?: unknown
  domain?: unknown
  success?: unknown
  error?: unknown
  result_count?: unknown
  titles_json?: unknown
  source_urls_json?: unknown
  allowed_repeat_reason?: unknown
  created_at?: unknown
}

let schemaPromise: Promise<void> | null = null

export function createResearchActivityIndex(): ResearchActivityIndex {
  return {
    entries: [],
    searchQueries: new Set(),
    stepSearchQueries: new Map(),
    visitedUrls: new Set(),
    stepVisitedUrls: new Map(),
    domainCounts: new Map(),
    stepDomainCounts: new Map(),
    failedTargets: new Set(),
  }
}

function getStepSet(map: Map<number, Set<string>>, stepIdx: number): Set<string> {
  let set = map.get(stepIdx)
  if (!set) {
    set = new Set()
    map.set(stepIdx, set)
  }
  return set
}

function getStepDomainMap(map: Map<number, Map<string, number>>, stepIdx: number): Map<string, number> {
  let stepMap = map.get(stepIdx)
  if (!stepMap) {
    stepMap = new Map()
    map.set(stepIdx, stepMap)
  }
  return stepMap
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1)
}

export function addResearchActivityToIndex(index: ResearchActivityIndex, entry: ResearchActivityEntry): void {
  index.entries.push(entry)
  if (index.entries.length > 500) index.entries.shift()

  if (entry.normalizedQuery) {
    index.searchQueries.add(entry.normalizedQuery)
    getStepSet(index.stepSearchQueries, entry.stepIdx).add(entry.normalizedQuery)
  }

  if (entry.normalizedUrl) {
    index.visitedUrls.add(entry.normalizedUrl)
    getStepSet(index.stepVisitedUrls, entry.stepIdx).add(entry.normalizedUrl)
  }

  if (entry.domain) {
    incrementCount(index.domainCounts, entry.domain)
    incrementCount(getStepDomainMap(index.stepDomainCounts, entry.stepIdx), entry.domain)
  }

  if (entry.kind === 'failure') {
    const target = entry.normalizedUrl || entry.normalizedQuery || entry.url || entry.query
    if (target) index.failedTargets.add(target)
  }
}

export function hydrateResearchActivityIndex(index: ResearchActivityIndex, entries: ResearchActivityEntry[]): void {
  index.entries = []
  index.searchQueries.clear()
  index.stepSearchQueries.clear()
  index.visitedUrls.clear()
  index.stepVisitedUrls.clear()
  index.domainCounts.clear()
  index.stepDomainCounts.clear()
  index.failedTargets.clear()

  for (const entry of entries) addResearchActivityToIndex(index, entry)
}

export function normalizeResearchQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function tokenizeResearchQuery(query: string): Set<string> {
  return new Set(
    normalizeResearchQuery(query)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !SEARCH_STOPWORDS.has(word)),
  )
}

export function researchQuerySimilarity(a: string, b: string): number {
  const left = tokenizeResearchQuery(a)
  const right = tokenizeResearchQuery(b)
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection++
  }
  const union = left.size + right.size - intersection
  return union > 0 ? intersection / union : 0
}

export function normalizeResearchUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hostname = parsed.hostname.toLowerCase()
    for (const param of URL_NORMALIZE_STRIP_PARAMS) {
      parsed.searchParams.delete(param)
    }
    parsed.searchParams.sort()
    parsed.hash = ''
    let normalized = parsed.toString()
    if (normalized.endsWith('/') && parsed.pathname !== '/') normalized = normalized.slice(0, -1)
    return normalized
  } catch {
    return rawUrl.trim()
  }
}

export function researchDomainFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

export function deliberateRepeatReason(input: {
  objectiveText: string
  actionText?: string
  domain?: string | null
  url?: string | null
}): string | null {
  const text = [input.objectiveText, input.actionText || ''].join('\n')
  if (/\b(?:revisit|go back|return to|reopen|re-open|open again|visit again|same site|same page|same source|refresh|reload|keep checking|monitor)\b/i.test(text)) {
    return 'explicit revisit/refresh instruction'
  }
  if (/\b(?:again|retry)\b/i.test(text) && /\b(?:same|this|that|previous|current)\b/i.test(text)) {
    return 'explicit repeat of current/previous target'
  }
  if (input.domain) {
    const escapedDomain = input.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escapedDomain}\\b`, 'i').test(text)) {
      return 'current step explicitly names this domain'
    }
  }
  return null
}

export function searchLoopBlockReason(input: {
  index: ResearchActivityIndex
  stepIdx: number
  query: string
  allowRepeatReason?: string | null
}): string | null {
  void input
  // Hidden logs are advisory. Do not hard-block searches here; hard blocks
  // caused repeated paid recovery turns and made tasks less stable.
  return null
}

export function navigationLoopBlockReason(input: {
  index: ResearchActivityIndex
  stepIdx: number
  url: string
  domain?: string | null
  allowRepeatReason?: string | null
}): string | null {
  void input
  // Hidden logs are advisory. Do not hard-block revisits here; the model sees
  // the compact log context and can choose a better route without recovery-loop
  // errors when a revisit is actually useful.
  return null
}

export function makeResearchActivityEntry(input: Omit<ResearchActivityEntry, 'id' | 'createdAt'> & {
  id?: string
  createdAt?: number
}): ResearchActivityEntry {
  return {
    ...input,
    id: input.id || `research:${randomUUID()}`,
    createdAt: input.createdAt || Date.now(),
  }
}

async function ensureResearchActivitySchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists task_research_activity (
          id text primary key,
          user_id text not null,
          conversation_id text not null,
          run_id text,
          step_idx integer not null,
          step_title text,
          tool text not null,
          kind text not null,
          query text,
          normalized_query text,
          url text,
          normalized_url text,
          domain text,
          success integer not null,
          error text,
          result_count integer,
          titles_json text,
          source_urls_json text,
          allowed_repeat_reason text,
          created_at integer not null
        )
      `)
      await tursoExecute('create index if not exists task_research_activity_task_time_idx on task_research_activity(user_id, conversation_id, created_at)')
      await tursoExecute('create index if not exists task_research_activity_step_query_idx on task_research_activity(user_id, conversation_id, step_idx, normalized_query)')
      await tursoExecute('create index if not exists task_research_activity_step_url_idx on task_research_activity(user_id, conversation_id, step_idx, normalized_url)')
      await tursoExecute('create index if not exists task_research_activity_step_domain_idx on task_research_activity(user_id, conversation_id, step_idx, domain)')
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

function parseJsonStringArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : undefined
  } catch {
    return undefined
  }
}

function rowToEntry(row: ResearchActivityRow): ResearchActivityEntry | null {
  if (typeof row.id !== 'string') return null
  if (typeof row.user_id !== 'string') return null
  if (typeof row.conversation_id !== 'string') return null
  if (typeof row.tool !== 'string') return null
  if (typeof row.kind !== 'string') return null

  const stepIdx = Number(row.step_idx)
  const createdAt = Number(row.created_at)
  if (!Number.isFinite(stepIdx) || !Number.isFinite(createdAt)) return null
  const titles = parseJsonStringArray(row.titles_json)
  const sourceUrls = parseJsonStringArray(row.source_urls_json)

  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    ...(typeof row.run_id === 'string' ? { runId: row.run_id } : {}),
    stepIdx,
    ...(typeof row.step_title === 'string' ? { stepTitle: row.step_title } : {}),
    tool: row.tool,
    kind: row.kind as ResearchActivityKind,
    ...(typeof row.query === 'string' ? { query: row.query } : {}),
    ...(typeof row.normalized_query === 'string' ? { normalizedQuery: row.normalized_query } : {}),
    ...(typeof row.url === 'string' ? { url: row.url } : {}),
    ...(typeof row.normalized_url === 'string' ? { normalizedUrl: row.normalized_url } : {}),
    ...(typeof row.domain === 'string' ? { domain: row.domain } : {}),
    success: Boolean(row.success),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    ...(Number.isFinite(Number(row.result_count)) ? { resultCount: Number(row.result_count) } : {}),
    ...(titles ? { titles } : {}),
    ...(sourceUrls ? { sourceUrls } : {}),
    ...(typeof row.allowed_repeat_reason === 'string' ? { allowedRepeatReason: row.allowed_repeat_reason } : {}),
    createdAt,
  }
}

export async function loadResearchActivityEntries(
  userId: string,
  conversationId: string,
  limit = 500,
): Promise<ResearchActivityEntry[]> {
  await ensureResearchActivitySchema()
  const result = await tursoExecute(
    `
      select id, user_id, conversation_id, run_id, step_idx, step_title, tool, kind,
             query, normalized_query, url, normalized_url, domain, success, error,
             result_count, titles_json, source_urls_json, allowed_repeat_reason, created_at
      from task_research_activity
      where user_id = ? and conversation_id = ?
      order by created_at asc
      limit ?
    `,
    [userId, conversationId, limit],
  )
  return result.rows
    .map(row => rowToEntry(row as ResearchActivityRow))
    .filter((entry): entry is ResearchActivityEntry => !!entry)
}

export async function appendResearchActivityEntry(entry: ResearchActivityEntry): Promise<void> {
  await ensureResearchActivitySchema()
  await tursoExecute(
    `
      insert or ignore into task_research_activity (
        id, user_id, conversation_id, run_id, step_idx, step_title, tool, kind,
        query, normalized_query, url, normalized_url, domain, success, error,
        result_count, titles_json, source_urls_json, allowed_repeat_reason, created_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      entry.id,
      entry.userId,
      entry.conversationId,
      entry.runId || null,
      entry.stepIdx,
      entry.stepTitle || null,
      entry.tool,
      entry.kind,
      entry.query || null,
      entry.normalizedQuery || null,
      entry.url || null,
      entry.normalizedUrl || null,
      entry.domain || null,
      entry.success ? 1 : 0,
      entry.error || null,
      entry.resultCount ?? null,
      entry.titles ? JSON.stringify(entry.titles.slice(0, 8)) : null,
      entry.sourceUrls ? JSON.stringify(entry.sourceUrls.slice(0, 12)) : null,
      entry.allowedRepeatReason || null,
      entry.createdAt,
    ],
  )
}

export async function clearResearchActivityForTask(
  userId: string,
  conversationId: string,
  beforeCreatedAt?: number,
): Promise<void> {
  await ensureResearchActivitySchema()
  if (Number.isFinite(beforeCreatedAt)) {
    await tursoExecute(
      'delete from task_research_activity where user_id = ? and conversation_id = ? and created_at < ?',
      [userId, conversationId, Math.max(0, Math.floor(beforeCreatedAt || 0))],
    )
    return
  }
  await tursoExecute(
    'delete from task_research_activity where user_id = ? and conversation_id = ?',
    [userId, conversationId],
  )
}

function takeRecent<T>(values: Iterable<T>, limit: number): T[] {
  return [...values].slice(-limit)
}

export function researchActivityContext(index: ResearchActivityIndex, stepIdx: number): string | null {
  const stepQueries = takeRecent(index.stepSearchQueries.get(stepIdx) || [], 3)
  const stepUrls = takeRecent(index.stepVisitedUrls.get(stepIdx) || [], 3)
  const failed = takeRecent(index.failedTargets, 2)

  if (stepQueries.length === 0 && stepUrls.length === 0 && failed.length === 0) return null

  const parts = [
    stepQueries.length ? `searched: ${stepQueries.join('; ')}` : '',
    stepUrls.length ? `visited: ${stepUrls.join('; ')}` : '',
    failed.length ? `failed: ${failed.join('; ')}` : '',
    'Avoid repeats unless the user asked to revisit/refresh/monitor/return.',
  ].filter(Boolean)

  return `RESEARCH LOG:\n${parts.join('\n')}`
}
