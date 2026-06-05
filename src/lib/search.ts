import { SearchResult } from '@/types'

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY

interface BraveWebResult {
  title: string
  description: string
  url: string
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] }
}

const TRUSTED_DOMAINS = new Set([
  'wikipedia.org', 'reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com',
  'github.com', 'stackoverflow.com', 'arxiv.org', 'nature.com', 'sciencedirect.com',
  'developer.mozilla.org', 'docs.python.org', 'docs.microsoft.com',
])

const WEB_SEARCH_REQUEST_TIMEOUT_MS = 6500
const WEB_SEARCH_RESULT_COUNT = 5

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
    if (normalized.startsWith('#x')) {
      return fromCode(Number.parseInt(normalized.slice(2), 16))
    }
    if (normalized.startsWith('#')) {
      return fromCode(Number.parseInt(normalized.slice(1), 10))
    }
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

export async function webSearch(query: string): Promise<SearchResult[]> {
  if (!BRAVE_API_KEY) {
    return [{
      title: 'Search unavailable',
      snippet: 'BRAVE_SEARCH_API_KEY is not set in .env.local.',
      url: '',
    }]
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${WEB_SEARCH_RESULT_COUNT}`,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY,
        },
        signal: controller.signal,
      },
    )

    if (!res.ok) throw new Error(`Brave API ${res.status}`)

    const data = (await res.json()) as BraveSearchResponse
    return (data.web?.results || [])
      .filter((r) => r.url && !isObviousBrokenResultUrl(r.url))
      .map((r) => {
        const result: SearchResult = {
          title: cleanSearchText(r.title || '', 180),
          snippet: cleanSearchText(r.description || '', 240),
          url: r.url,
        }

        try {
          const hostname = new URL(r.url).hostname.replace(/^www\./, '')
          if (TRUSTED_DOMAINS.has(hostname) || [...TRUSTED_DOMAINS].some((d) => hostname.endsWith(`.${d}`))) {
            result.source = 'trusted'
          }
        } catch {
          // Ignore malformed result URLs.
        }

        return result
      })
  } catch (error) {
    console.error('Brave search error:', error)
    return [{
      title: 'Search failed',
      snippet: `Search error: ${error instanceof Error ? error.message : 'unknown'}. Try browser_navigate to a known URL instead.`,
      url: '',
    }]
  } finally {
    clearTimeout(timer)
  }
}
