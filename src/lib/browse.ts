import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { BrowseResult } from '@/types'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'

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

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
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

function parseHTML(html: string, url: string): BrowseResult {
  const dom = new JSDOM(html, { url })
  const doc = dom.window.document

  // Extract metadata before Readability destroys the DOM
  const metaDescription = doc.querySelector('meta[name="description"]')?.getAttribute('content')
    || doc.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || ''
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''
  const publishedDate = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content')
    || doc.querySelector('time[datetime]')?.getAttribute('datetime')
    || ''

  // Remove noisy elements before parsing
  const noiseSelectors = ['nav', 'footer', '.sidebar', '.ad', '.advertisement', '.cookie-banner', '.popup', '#comments', '.social-share']
  for (const sel of noiseSelectors) {
    try {
      doc.querySelectorAll(sel).forEach(el => el.remove())
    } catch { /* skip invalid selectors */ }
  }

  // Try Readability first
  const reader = new Readability(doc)
  const article = reader.parse()

  let title = article?.title || ogTitle || doc.title || url
  let content = article?.textContent || ''

  // Fallback to body text
  if (!content.trim()) {
    content = doc.body?.textContent || ''
  }

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

  // Smart truncation: try to break at paragraph boundaries
  const MAX_CONTENT_LENGTH = 6000
  const originalLength = content.length
  if (content.length > MAX_CONTENT_LENGTH) {
    // Find last paragraph break before the limit
    const breakPoint = content.lastIndexOf('\n\n', MAX_CONTENT_LENGTH - 100)
    if (breakPoint > MAX_CONTENT_LENGTH * 0.6) {
      content = content.slice(0, breakPoint) + `\n\n... [Truncated from ${originalLength} characters]`
    } else {
      // Fallback: break at sentence boundary
      const sentenceBreak = content.lastIndexOf('. ', MAX_CONTENT_LENGTH - 50)
      if (sentenceBreak > MAX_CONTENT_LENGTH * 0.7) {
        content = content.slice(0, sentenceBreak + 1) + ` [Truncated from ${originalLength} characters]`
      } else {
        content = content.slice(0, MAX_CONTENT_LENGTH) + `... [Truncated from ${originalLength} characters]`
      }
    }
  }

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
      return parseHTML(response.html, url)
    }

    // Attempt 2: Retry 403/429 with Googlebot UA
    if (response.status === 403 || response.status === 429) {
      try {
        const retryResponse = await fetchPage(url, GOOGLEBOT_UA, 20000)
        if (retryResponse.ok) {
          return parseHTML(retryResponse.html, url)
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
