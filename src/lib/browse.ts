import { BrowseResult } from '@/types'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'
import { MAX_READABLE_PAGE_CHARS, truncateReadablePageContent } from './readablePageLimits'

export { MAX_READABLE_PAGE_CHARS, truncateReadablePageContent } from './readablePageLimits'

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/123.0',
]

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

const MAX_REDIRECTS = 5
const MAX_PAGE_BYTES = 4 * 1024 * 1024
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
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

function htmlAttributeValue(html: string, pattern: RegExp): string {
  const match = html.match(pattern)
  return decodeHtmlEntities(match?.[1] || '').replace(/\s+/g, ' ').trim()
}

function htmlTagText(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = html.match(re)
  if (!match?.[1]) return ''
  return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function extractMainHtml(html: string): string {
  // Keep the largest semantic candidate. Taking the first <article> commonly
  // selects a recommendation card or teaser that appears before the real page.
  const candidates = [
    ...Array.from(html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi), match => match[1]),
    ...Array.from(html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main>/gi), match => match[1]),
  ].filter(Boolean)
  if (candidates.length > 0) {
    return candidates.reduce((largest, candidate) => (
      htmlToText(candidate).length > htmlToText(largest).length ? candidate : largest
    ))
  }
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `\n\n${'#'.repeat(Number(level))} `)
      .replace(/<\/(?:p|div|section|article|main|header|h[1-6]|tr|table|blockquote|pre)>/gi, '\n\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const READABLE_CONTAINER_SELECTOR = 'article, main, [role="main"]'
const NON_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'footer', 'aside', 'form', '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', '[aria-hidden="true"]',
].join(',')

function cleanedContainerHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element
  clone.querySelectorAll(NON_CONTENT_SELECTOR).forEach(node => node.remove())
  return clone.innerHTML
}

function largestReadableContainerHtml(document: Document): string {
  const semanticCandidates = Array.from(document.querySelectorAll(READABLE_CONTAINER_SELECTOR))
  const candidates = semanticCandidates.length > 0
    ? semanticCandidates
    : document.body
      ? [document.body]
      : []

  let bestHtml = ''
  let bestScore = -1
  for (const candidate of candidates) {
    const candidateHtml = cleanedContainerHtml(candidate)
    const textLength = htmlToText(candidateHtml).length
    const structureCount = candidate.querySelectorAll('p, h1, h2, h3, h4, li, blockquote, pre').length
    const score = textLength + structureCount * 40
    if (score > bestScore) {
      bestHtml = candidateHtml
      bestScore = score
    }
  }
  return bestHtml
}

function extractReadableContentHtml(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url })
    const fallbackHtml = largestReadableContainerHtml(dom.window.document)
    const fallbackLength = htmlToText(fallbackHtml).length
    const article = new Readability(dom.window.document, {
      charThreshold: 120,
      keepClasses: false,
    }).parse()
    const readableHtml = article?.content || ''
    const readableLength = htmlToText(readableHtml).length

    // Readability is normally the cleaner choice. Some documentation/help
    // layouts contain a tiny article-like teaser before a large semantic main;
    // in that case retain the substantive main content instead of the teaser.
    if (fallbackLength >= 1_200 && readableLength < fallbackLength * 0.65) {
      return fallbackHtml
    }
    return readableHtml || fallbackHtml || extractMainHtml(html)
  } catch {
    // Malformed legacy HTML should still get the bounded regex fallback.
    return extractMainHtml(html)
  }
}

async function fetchPage(url: string, userAgent: string, timeoutMs: number): Promise<{ ok: boolean; status: number; statusText: string; html: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let currentUrl = url
    let response: Response | null = null
    // Manual redirect loop with per-hop SSRF re-validation. fetch's default
    // redirect handling does NOT re-check the host, so an attacker-controlled
    // page can 302 to http://169.254.169.254/ or any private IP and bypass
    // the checkHost performed before fetchPage was called.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await guardedFetch(currentUrl, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'manual',
        maxBytes: MAX_PAGE_BYTES,
      })

      const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location')
      if (!isRedirect) break

      if (hop === MAX_REDIRECTS) {
        return { ok: false, status: response.status, statusText: `Too many redirects (max ${MAX_REDIRECTS})`, html: '' }
      }

      const location = response.headers.get('location')!
      currentUrl = new URL(location, currentUrl).toString()
      const parsed = validateHttpUrl(currentUrl)
      await checkHost(parsed.hostname)
    }

    if (!response) {
      return { ok: false, status: 0, statusText: 'No response', html: '' }
    }
    // Read body while the timeout is still active — prevents hanging on stalled body reads
    const html = response.ok ? await response.text() : ''
    return { ok: response.ok, status: response.status, statusText: response.statusText, html }
  } finally {
    clearTimeout(timeout)
  }
}

export function parseReadableHtml(html: string, url: string): BrowseResult {
  const metaDescription = htmlAttributeValue(html, /<meta\b(?=[^>]*(?:name|property)=["'](?:description|og:description)["'])[^>]*content=["']([^"']*)["'][^>]*>/i)
  const ogTitle = htmlAttributeValue(html, /<meta\b(?=[^>]*property=["']og:title["'])[^>]*content=["']([^"']*)["'][^>]*>/i)
  const publishedDate = htmlAttributeValue(html, /<meta\b(?=[^>]*property=["']article:published_time["'])[^>]*content=["']([^"']*)["'][^>]*>/i)
    || htmlAttributeValue(html, /<time\b[^>]*datetime=["']([^"']*)["'][^>]*>/i)

  let title = ogTitle || htmlTagText(html, 'title') || url
  let content = htmlToText(extractReadableContentHtml(html, url))

  // Clean up whitespace but preserve paragraph breaks
  content = content
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Prepend metadata if available
  const metaParts: string[] = []
  if (metaDescription && metaDescription.length > 20) {
    metaParts.push(`Summary: ${metaDescription.slice(0, 300)}`)
  }
  if (publishedDate) {
    metaParts.push(`Published: ${publishedDate}`)
  }
  if (metaParts.length > 0) {
    content = metaParts.join(' | ') + '\n\n' + content
  }

  content = truncateReadablePageContent(content)

  return { title, content, url }
}

// Overall timeout for the entire browse cascade (all attempts combined)
const BROWSE_OVERALL_TIMEOUT_MS = 30_000

export async function browsePage(url: string): Promise<BrowseResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      browsePageInner(url),
      new Promise<BrowseResult>((resolve) => {
        timeoutId = setTimeout(() => {
          console.error(`[Browse] Overall browse timeout for ${url}`)
          resolve({
            title: 'Error loading page',
            content: `Timed out loading ${url}. The page took too long to respond.`,
            url,
          })
        }, BROWSE_OVERALL_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function browsePageInner(url: string): Promise<BrowseResult> {
  // SSRF protection
  try {
    const parsed = validateHttpUrl(url)
    await checkHost(parsed.hostname)
  } catch (err) {
    return {
      title: 'Blocked',
      content: `Request blocked: ${(err as Error).message}`,
      url,
    }
  }

  // Attempt 1: Normal request with random UA
  try {
    const response = await fetchPage(url, randomUA(), 20000)

    if (response.ok) {
      return parseReadableHtml(response.html, url)
    }

    // Attempt 2: Retry 403/429 with Googlebot UA
    if (response.status === 403 || response.status === 429) {
      try {
        const retryResponse = await fetchPage(url, GOOGLEBOT_UA, 20000)
        if (retryResponse.ok) {
          return parseReadableHtml(retryResponse.html, url)
        }
      } catch {
        // Fall through to error
      }

      return {
        title: 'Page blocked',
        content: `${url} returned ${response.status}. This site blocks automated access. Try a different source for this information.`,
        url,
      }
    }

    return {
      title: 'Error loading page',
      content: `Request failed with status ${response.status}: ${response.statusText}`,
      url,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      title: 'Error loading page',
      content: `Failed to load ${url}: ${message}`,
      url,
    }
  }
}
