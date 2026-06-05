import { ImageSearchResult } from '@/types'
import { getOrCreateSandboxDir, resolveAndVerify } from './sandbox'
import { constants } from 'fs'
import { mkdir, open, unlink } from 'fs/promises'
import { join } from 'path'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'

// --- Helpers (same pattern as search.ts) ---

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
]

const MAX_REDIRECTS = 5
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

type ImageFetchOptions = Omit<RequestInit, 'body'>

async function fetchWithTimeout(url: string, options: ImageFetchOptions, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Manual redirect loop with per-hop SSRF re-validation. fetch's default
    // redirect handling does NOT re-check the host, so an attacker-controlled
    // image URL can 302 to http://169.254.169.254/ or any private IP and
    // bypass the checkHost performed before this call.
    let currentUrl = url
    let response: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await guardedFetch(currentUrl, { ...options, signal: controller.signal, redirect: 'manual', maxBytes: MAX_IMAGE_BYTES })
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

async function fetchJsonWithTimeout(url: string, options: ImageFetchOptions, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, { ...options, signal: controller.signal, maxBytes: MAX_SEARCH_RESPONSE_BYTES })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTextWithTimeout(url: string, options: ImageFetchOptions, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await guardedFetch(url, { ...options, signal: controller.signal, maxBytes: MAX_SEARCH_RESPONSE_BYTES })
    const text = response.ok ? await response.text() : ''
    return { ok: response.ok, status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

// --- DuckDuckGo Image Search ---

async function searchDuckDuckGoImages(query: string, count: number): Promise<ImageSearchResult[]> {
  // Step 1: Get vqd token
  const { ok, text: html } = await fetchTextWithTimeout(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html',
      },
    },
    10000
  )
  if (!ok) throw new Error('DuckDuckGo image page failed')

  const vqdMatch = html.match(/vqd=["']?([^"'&]+)/)
  if (!vqdMatch) throw new Error('Could not extract vqd token')
  const vqd = vqdMatch[1]

  // Step 2: Fetch image JSON
  const data = await fetchJsonWithTimeout(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`,
    {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'application/json',
        'Referer': 'https://duckduckgo.com/',
      },
    },
    10000
  ) as { results?: Array<{ title?: string; thumbnail?: string; url?: string; image?: string }> }

  const results = data.results || []
  return results.slice(0, count).map((r) => ({
    title: r.title || '',
    thumbnailUrl: r.thumbnail || '',
    sourceUrl: r.url || '',
    imageUrl: r.image || r.thumbnail || '',
  }))
}

// --- Main entry point ---

const IMAGE_SEARCH_TIMEOUT_MS = 20_000

export async function imageSearch(query: string, count: number = 5): Promise<ImageSearchResult[]> {
  count = Math.max(1, Math.min(20, count))

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      imageSearchInner(query, count),
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

async function imageSearchInner(query: string, count: number): Promise<ImageSearchResult[]> {
  try {
    const results = await searchDuckDuckGoImages(query, count)
    if (results.length > 0) return results
  } catch (error) {
    console.error('DuckDuckGo image search error:', error)
  }

  return []
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
  results: ImageSearchResult[]
): Promise<{ downloaded: string[]; failed: string[] }> {
  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const downloadsDir = join(sandboxDir, 'downloads')
  await mkdir(downloadsDir, { recursive: true })
  if (!await resolveAndVerify(sandboxDir, downloadsDir)) {
    return { downloaded: [], failed: results.map(result => result.imageUrl) }
  }

  const downloaded: string[] = []
  const failed: string[] = []

  const outcomes = await Promise.allSettled(
    results.map(async (result, idx) => {
      // SSRF protection
      const parsed = validateHttpUrl(result.imageUrl)
      await checkHost(parsed.hostname)

      const response = await fetchWithTimeout(result.imageUrl, {
        headers: { 'User-Agent': randomUA() },
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
      const filePath = join(downloadsDir, filename)

      const buffer = Buffer.from(await response.arrayBuffer())
      // Real size check after download — catches missing/malformed Content-Length headers
      if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error('Image exceeds 20MB size limit')
      }
      const fd = await open(
        filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      )
      try {
        await fd.writeFile(buffer)
      } finally {
        await fd.close()
      }

      if (!await resolveAndVerify(sandboxDir, filePath)) {
        try { await unlink(filePath) } catch { /* best effort */ }
        throw new Error('Image path escaped sandbox')
      }

      return `downloads/${filename}`
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
