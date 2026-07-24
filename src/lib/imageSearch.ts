import { ImageSearchResult } from '@/types'
import { writeSandboxFileBytes } from './sandbox'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'
import { normalizeSearchQuery } from './searchQuery'

const SERPER_API_KEY = process.env.SERPER_API_KEY
const SERPER_BASE_URL = (process.env.SERPER_BASE_URL || 'https://google.serper.dev').replace(/\/+$/, '')
const IMAGE_SEARCH_TIMEOUT_MS = 12_000
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
]

const MAX_REDIRECTS = 5

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

type ImageFetchOptions = Omit<RequestInit, 'body'>

async function fetchWithTimeout(url: string, options: ImageFetchOptions, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  try {
    // Manual redirect loop with per-hop SSRF re-validation. fetch's default
    // redirect handling does NOT re-check the host, so an attacker-controlled
    // image URL can 302 to http://169.254.169.254/ or any private IP and
    // bypass the checkHost performed before this call.
    let currentUrl = url
    let response: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await guardedFetch(currentUrl, { ...options, signal, redirect: 'manual', maxBytes: MAX_IMAGE_BYTES })
      const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location')
      if (!isRedirect) return response
      if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (max ${MAX_REDIRECTS})`)
      const location = response.headers.get('location')!
      currentUrl = new URL(location, currentUrl).toString()
      const parsed = validateHttpUrl(currentUrl)
      await checkHost(parsed.hostname)
    }
    if (!response) throw new Error('no response')
    return response
  } finally {
    clearTimeout(timer)
  }
}

interface SerperImageResult {
  title?: string
  imageUrl?: string
  thumbnailUrl?: string
  source?: string
  domain?: string
  link?: string
}

interface SerperImagesResponse {
  images?: SerperImageResult[]
}

function serperApiKey(): string {
  const key = SERPER_API_KEY?.trim()
  if (!key) throw new Error('SERPER_API_KEY is not configured')
  return key
}

async function serperImages(rawQuery: unknown, count: number, signal?: AbortSignal): Promise<SerperImagesResponse> {
  const query = normalizeSearchQuery(rawQuery)
  if (!query) throw new Error('Image search query is empty after cleanup')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_SEARCH_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    const response = await fetch(`${SERPER_BASE_URL}/images`, {
      method: 'POST',
      headers: {
        'X-API-KEY': serperApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: query, num: count }),
      signal: requestSignal,
    })
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 220)
      throw new Error(`Serper images HTTP ${response.status}${body ? `: ${body}` : ''}`)
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength) {
      const parsedLen = Number.parseInt(contentLength, 10)
      if (!Number.isFinite(parsedLen) || parsedLen < 0 || parsedLen > MAX_SEARCH_RESPONSE_BYTES) {
        throw new Error('Serper image response exceeds size limit')
      }
    }
    return (await response.json()) as SerperImagesResponse
  } finally {
    clearTimeout(timer)
  }
}

export async function imageSearch(query: unknown, count: number = 8, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  count = Math.max(1, Math.min(8, count))

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      imageSearchInner(query, count, signal),
      new Promise<ImageSearchResult[]>((resolve) => {
        timeoutId = setTimeout(() => {
          console.error('[ImageSearch] Overall timeout reached')
          resolve([])
        }, IMAGE_SEARCH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function imageSearchInner(query: unknown, count: number, signal?: AbortSignal): Promise<ImageSearchResult[]> {
  const data = await serperImages(query, count, signal)
  return (data.images || [])
    .filter(result => result.imageUrl || result.thumbnailUrl)
    .slice(0, count)
    .map(result => ({
      title: result.title || result.source || result.domain || '',
      thumbnailUrl: result.thumbnailUrl || result.imageUrl || '',
      sourceUrl: result.link || '',
      imageUrl: result.imageUrl || result.thumbnailUrl || '',
    }))
}

// --- Download images to sandbox ---

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = pathname.split('.').pop()?.toLowerCase()
    if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext
    }
  } catch { /* ignore */ }
  return ''
}

export async function downloadImagesToSandbox(
  conversationId: string,
  results: ImageSearchResult[],
  signal?: AbortSignal,
): Promise<{ downloaded: string[]; failed: string[] }> {
  const downloaded: string[] = []
  const failed: string[] = []

  const outcomes = await Promise.allSettled(
    results.map(async (result, idx) => {
      // SSRF protection
      const parsed = validateHttpUrl(result.imageUrl)
      await checkHost(parsed.hostname)

      const response = await fetchWithTimeout(result.imageUrl, {
        headers: { 'User-Agent': randomUA() },
        signal,
      }, 8000)

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      // Size limit check (Content-Length header). Reject malformed (NaN/negative)
      // headers up-front so we don't burn bandwidth on a download we'd reject anyway.
      const contentLength = response.headers.get('content-length')
      if (contentLength) {
        const parsedLen = parseInt(contentLength, 10)
        if (!Number.isFinite(parsedLen) || parsedLen < 0 || parsedLen > MAX_IMAGE_BYTES) {
          throw new Error('Image exceeds 20MB size limit or has invalid Content-Length')
        }
      }

      const contentType = response.headers.get('content-type') || ''
      let ext = getExtensionFromUrl(result.imageUrl)
      if (!ext) {
        for (const [mime, mimeExt] of Object.entries(MIME_TO_EXT)) {
          if (contentType.includes(mime)) { ext = mimeExt; break }
        }
      }
      if (!ext) ext = 'jpg' // fallback

      const titlePart = sanitizeFilename(result.title || `image_${idx}`)
      const filename = `${idx}_${titlePart}.${ext}`
      const filePath = `downloads/${filename}`

      const buffer = Buffer.from(await response.arrayBuffer())
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      // Real size check after download — catches missing/malformed Content-Length headers
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error('Image exceeds 20MB size limit')
      }
      await writeSandboxFileBytes(conversationId, filePath, new Uint8Array(buffer))
      return filePath
    })
  )

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]
    if (outcome.status === 'fulfilled') {
      downloaded.push(outcome.value)
    } else {
      failed.push(results[i].imageUrl)
    }
  }

  return { downloaded, failed }
}
