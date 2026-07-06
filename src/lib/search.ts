import { SearchResult } from '@/types'
import { normalizeSearchQuery, simplifiedSearchQuery } from './searchQuery'

const SERPER_API_KEY = process.env.SERPER_API_KEY
const SERPER_BASE_URL = (process.env.SERPER_BASE_URL || 'https://google.serper.dev').replace(/\/+$/, '')
const WEB_SEARCH_RESULT_COUNT = 15
const WEB_SEARCH_REQUEST_TIMEOUT_MS = 2_500

interface SerperOrganicResult {
  title?: string
  link?: string
  snippet?: string
  date?: string
  source?: string
  position?: number
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[]
  news?: SerperOrganicResult[]
  places?: Array<{
    title?: string
    website?: string
    address?: string
    rating?: number
    ratingCount?: number
  }>
  answerBox?: {
    title?: string
    answer?: string
    snippet?: string
    link?: string
  }
}

class SerperHttpError extends Error {
  constructor(
    readonly path: 'search',
    readonly status: number,
    detail: string,
  ) {
    super(`Serper ${path} HTTP ${status}${detail ? `: ${detail}` : ''}`)
  }
}

const TRUSTED_DOMAINS = new Set([
  'wikipedia.org', 'reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com',
  'github.com', 'stackoverflow.com', 'arxiv.org', 'nature.com', 'sciencedirect.com',
  'developer.mozilla.org', 'docs.python.org', 'docs.microsoft.com',
])

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const fromCode = (code: number) => {
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      } catch {
        return match
      }
    }
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#x')) return fromCode(Number.parseInt(normalized.slice(2), 16))
    if (normalized.startsWith('#')) return fromCode(Number.parseInt(normalized.slice(1), 10))
    return HTML_ENTITIES[normalized] ?? match
  })
}

function cleanSearchText(value: string, maxLength: number): string {
  let text = value
  for (let i = 0; i < 3; i++) {
    text = decodeHtmlEntities(text).replace(/<[^>]*>/g, ' ')
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function isObviousBrokenResultUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const path = url.pathname.toLowerCase().replace(/\/+$/, '')
    const query = url.search.toLowerCase()
    if (
      path === '/404' ||
      path === '/410' ||
      path === '/error' ||
      path === '/oops' ||
      path === '/gone' ||
      path.endsWith('/404') ||
      path.endsWith('/410') ||
      path.endsWith('/not-found') ||
      path.endsWith('/notfound') ||
      path.endsWith('/page-not-found') ||
      path.endsWith('/resourcenotfound') ||
      path.endsWith('/error') ||
      path.endsWith('/oops') ||
      path.endsWith('/gone')
    ) {
      return true
    }
    return /(?:^|[?&])(?:oops|error|notfound|not_found|page_not_found|status)=/i.test(query)
  } catch {
    return true
  }
}

function markTrustedSource(result: SearchResult): SearchResult {
  try {
    const hostname = new URL(result.url).hostname.replace(/^www\./, '')
    if (TRUSTED_DOMAINS.has(hostname) || [...TRUSTED_DOMAINS].some((d) => hostname.endsWith(`.${d}`))) {
      result.source = result.source ? `${result.source},trusted` : 'trusted'
    }
  } catch {
    // Ignore malformed result URLs.
  }
  return result
}

function queryTokens(query: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'latest', 'current', 'news', 'about', 'into', 'what', 'why', 'how'])
  return cleanSearchText(query.toLowerCase(), 200)
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length >= 3 && !stop.has(token))
    .slice(0, 12)
}

function scoreResultForQuery(result: SearchResult, query: string): number {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return 0
  const title = result.title.toLowerCase()
  const snippet = result.snippet.toLowerCase()
  let host = ''
  try {
    host = new URL(result.url).hostname.toLowerCase()
  } catch {
    // Ignore malformed hosts; they will be filtered elsewhere.
  }

  let score = 0
  const phrase = cleanSearchText(query.toLowerCase(), 160)
  if (phrase && title.includes(phrase)) score += 8
  if (phrase && snippet.includes(phrase)) score += 4
  for (const token of tokens) {
    if (title.includes(token)) score += 3
    if (snippet.includes(token)) score += 1
    if (host.includes(token)) score += 1
  }
  return score
}

function dedupeResults(results: SearchResult[], query = ''): SearchResult[] {
  const seen = new Set<string>()
  const candidates: SearchResult[] = []
  for (const result of results) {
    if (!result.url || isObviousBrokenResultUrl(result.url)) continue
    const key = result.url.replace(/#.*$/, '').replace(/\/+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(markTrustedSource(result))
    if (candidates.length >= WEB_SEARCH_RESULT_COUNT * 5) break
  }
  if (!query.trim()) return candidates.slice(0, WEB_SEARCH_RESULT_COUNT)

  const scored = candidates.map((result, index) => ({
    result,
    index,
    score: scoreResultForQuery(result, query),
  }))
  const positive = scored.filter(item => item.score > 0)
  const pool = positive.length > 0 ? positive : scored
  return pool
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, WEB_SEARCH_RESULT_COUNT)
    .map(item => item.result)
}

function serperApiKey(): string {
  const key = SERPER_API_KEY?.trim()
  if (!key) throw new Error('SERPER_API_KEY is not configured')
  return key
}

function compactSerperErrorBody(body: string): string {
  return body
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 260)
}

async function serperPost<T>(path: 'search', body: Record<string, unknown>, timeoutMs = WEB_SEARCH_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${SERPER_BASE_URL}/${path}`, {
      method: 'POST',
      headers: {
        'X-API-KEY': serperApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const responseText = await response.text()
    if (!response.ok) {
      throw new SerperHttpError(path, response.status, compactSerperErrorBody(responseText))
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      throw new Error(`Serper ${path} returned ${contentType || 'unknown content type'}`)
    }
    return JSON.parse(responseText) as T
  } finally {
    clearTimeout(timer)
  }
}

function shouldRetryWithSimplifiedQuery(error: unknown): boolean {
  return error instanceof SerperHttpError && error.status === 400
}

async function serperSearchPage(query: string, page = 1): Promise<SerperSearchResponse> {
  return serperPost<SerperSearchResponse>('search', {
    q: query,
    num: WEB_SEARCH_RESULT_COUNT,
    ...(page > 1 ? { page } : {}),
  }, WEB_SEARCH_REQUEST_TIMEOUT_MS)
}

async function firstSerperSearchPage(query: string): Promise<SerperSearchResponse> {
  try {
    return await serperSearchPage(query)
  } catch (error) {
    const simplified = simplifiedSearchQuery(query)
    if (!shouldRetryWithSimplifiedQuery(error) || !simplified || simplified === query) {
      throw error
    }
    return serperSearchPage(simplified)
  }
}

function resultFromOrganic(item: SerperOrganicResult, source: string): SearchResult | null {
  if (!item.link) return null
  return {
    title: cleanSearchText(item.title || item.link, 180),
    snippet: cleanSearchText([item.snippet, item.date].filter(Boolean).join(' '), 260),
    url: item.link,
    source,
  }
}

function resultsFromAnswerBox(answerBox: SerperSearchResponse['answerBox']): SearchResult[] {
  if (!answerBox?.link) return []
  return [{
    title: cleanSearchText(answerBox.title || answerBox.link, 180),
    snippet: cleanSearchText(answerBox.answer || answerBox.snippet || '', 260),
    url: answerBox.link,
    source: 'serper-answer',
  }]
}

function resultsFromPlaces(places: SerperSearchResponse['places']): SearchResult[] {
  return (places || [])
    .filter(place => place.website)
    .map(place => ({
      title: cleanSearchText(place.title || place.website || '', 180),
      snippet: cleanSearchText([
        place.address,
        typeof place.rating === 'number' ? `Rating ${place.rating}` : '',
        typeof place.ratingCount === 'number' ? `${place.ratingCount} reviews` : '',
      ].filter(Boolean).join(' '), 260),
      url: place.website || '',
      source: 'serper-places',
    }))
}

function searchResultsFromResponse(data: SerperSearchResponse): SearchResult[] {
  const organic = (data.organic || [])
    .map(item => resultFromOrganic(item, 'serper-organic'))
    .filter((item): item is SearchResult => Boolean(item))
  const news = (data.news || [])
    .map(item => resultFromOrganic(item, 'serper-news'))
    .filter((item): item is SearchResult => Boolean(item))

  return [
    ...resultsFromAnswerBox(data.answerBox),
    ...organic,
    ...news,
    ...resultsFromPlaces(data.places),
  ]
}

export async function webSearch(rawQuery: unknown): Promise<SearchResult[]> {
  const query = normalizeSearchQuery(rawQuery)
  if (!query) throw new Error('Search query is empty after cleanup')

  const firstPage = await firstSerperSearchPage(query)
  const rawResults = searchResultsFromResponse(firstPage)

  return dedupeResults(rawResults, query)
}
