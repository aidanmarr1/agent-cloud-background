import { constants } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { parseReadableHtml } from './browse'
import { MAX_READABLE_PAGE_CHARS } from './readablePageLimits'
import { getOrCreateSandboxDir, isInsideSandbox, resolveAndVerify } from './sandbox'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'

export interface DocumentResult {
  type: 'pdf' | 'docx' | 'text'
  title: string
  content: string
  pageCount?: number
  wordCount: number
  source: string
  error?: string
  status?: number
  statusText?: string
  recoveryHint?: string
  recoverable?: boolean
  unavailable?: boolean
}

const MAX_CONTENT_CHARS = MAX_READABLE_PAGE_CHARS
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50MB
const MAX_REDIRECTS = 5
const URL_FETCH_TIMEOUT_MS = 10_000
const READER_FETCH_TIMEOUT_MS = 12_000
const READER_MAX_BYTES = 4 * 1024 * 1024
const PUBLIC_READER_BASE_URL = (process.env.WEB_READER_BASE_URL || 'https://r.jina.ai').replace(/\/+$/, '')
const DIRECT_PAGE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36'

function detectType(pathOrUrl: string, contentType?: string): 'pdf' | 'docx' | 'text' {
  if (contentType) {
    if (contentType.includes('pdf')) return 'pdf'
    if (contentType.includes('wordprocessingml') || contentType.includes('msword')) return 'docx'
  }
  const ext = pathOrUrl.split('.').pop()?.toLowerCase().split('?')[0] || ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  return 'text'
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source.trim())
}

function wordCount(content: string): number {
  return content.split(/\s+/).filter(Boolean).length
}

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content
  return content.slice(0, MAX_CONTENT_CHARS) + '\n... [truncated]'
}

function extractionBlockedResult(input: {
  source: string
  title: string
  type?: 'pdf' | 'docx' | 'text'
  status?: number
  statusText?: string
  error?: string
}): DocumentResult {
  const statusLabel = input.status
    ? `HTTP ${input.status}${input.statusText ? ` ${input.statusText}` : ''}`
    : (input.error || 'request failed')
  const recoveryHint = 'INTERNAL_RECOVERY: direct text extraction did not return readable evidence for this URL. Do not show this message to the user or retry the same reader/URL. Choose the next route intelligently from the task context: another authoritative source or direct text/data endpoint for ordinary content, or a rendered browser only when scripts, page state, screenshots, or interaction are genuinely required.'
  const content = `INTERNAL_RECOVERY: source extraction unavailable (${statusLabel}). Choose a materially different evidence route; do not report this internal extraction failure to the user.`
  return {
    type: input.type || 'text',
    title: input.title || 'Source extraction unavailable',
    content,
    wordCount: wordCount(content),
    source: input.source,
    error: recoveryHint,
    status: input.status,
    statusText: input.statusText,
    recoveryHint,
    recoverable: true,
    unavailable: true,
  }
}

function readerFallbackEligibleStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

function publicReaderEligibleSource(source: string): boolean {
  try {
    const parsed = validateHttpUrl(source)
    if (parsed.username || parsed.password) return false
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|jwt|key|password|secret|signature|sig|token|x-amz-)/i.test(key)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function readerUrlForSource(source: string): string {
  return `${PUBLIC_READER_BASE_URL}/${source}`
}

/**
 * Convert the reader endpoint's LLM-friendly response into the same ordinary
 * document result returned by direct extraction. Exported for a fixture-level
 * regression test; callers should normally use readDocument().
 */
export function parsePublicReaderDocument(
  raw: string,
  source: string,
  fallbackTitle: string,
): DocumentResult | null {
  const normalized = raw.replace(/\r\n?/g, '\n').trim()
  if (!normalized || /^(?:AbuseAlleviationError|SecurityCompromiseError|RateLimitError|Too Many Requests)\b/i.test(normalized)) {
    return null
  }

  const readerTitle = normalized.match(/^Title:\s*(.+)$/im)?.[1]?.trim() || fallbackTitle
  const contentMarker = normalized.match(/(?:^|\n)Markdown Content:\s*\n/i)
  const contentStart = contentMarker?.index === undefined
    ? 0
    : contentMarker.index + contentMarker[0].length
  const content = truncateContent(normalized.slice(contentStart).trim())
  const words = wordCount(content)
  if (words < 8) return null

  return {
    type: 'text',
    title: readerTitle || fallbackTitle,
    content,
    wordCount: words,
    source,
  }
}

async function readThroughPublicReader(
  source: string,
  fallbackTitle: string,
  signal?: AbortSignal,
): Promise<DocumentResult | null> {
  if (!publicReaderEligibleSource(source)) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), READER_FETCH_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal

  try {
    const readerUrl = validateHttpUrl(readerUrlForSource(source))
    await checkHost(readerUrl.hostname)
    const response = await guardedFetch(readerUrl, {
      signal: requestSignal,
      headers: {
        Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
        'User-Agent': DIRECT_PAGE_USER_AGENT,
        'X-Return-Format': 'markdown',
      },
      redirect: 'manual',
      maxBytes: READER_MAX_BYTES,
    })
    if (!response.ok) return null
    return parsePublicReaderDocument(await response.text(), source, fallbackTitle)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function parsePdf(buffer: Buffer): Promise<{ text: string; pages: number }> {
  // pdf-parse v1 exports a function directly
  const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>
  const data = await pdfParse(buffer)
  return { text: data.text, pages: data.numpages }
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

export async function readDocument(source: string, conversationId?: string, signal?: AbortSignal): Promise<DocumentResult> {
  try {
    let buffer: Buffer
    let docType: 'pdf' | 'docx' | 'text'
    let title = source.split('/').pop()?.split('?')[0] || 'document'
    let contentType = ''
    let resolvedSource = source

    if (isUrl(source)) {
      // SSRF protection
      try {
        const parsed = validateHttpUrl(source)
        await checkHost(parsed.hostname)
      } catch (err) {
        return { type: 'text', title, content: `Blocked: ${(err as Error).message}`, wordCount: 0, source }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
      try {
        // Manual redirect loop with per-hop SSRF re-validation. fetch's default
        // redirect handling does NOT re-check the host, so an attacker-controlled
        // page can 302 to http://169.254.169.254/ or any private IP and bypass
        // the checkHost above.
        let currentUrl = source
        let res: Response | null = null
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await guardedFetch(currentUrl, {
            signal: requestSignal,
            headers: {
              'User-Agent': DIRECT_PAGE_USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
            },
            redirect: 'manual',
            maxBytes: MAX_FILE_BYTES,
          })
          const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location')
          if (!isRedirect) break
          if (hop === MAX_REDIRECTS) {
            clearTimeout(timeout)
            return { type: 'text', title, content: `Error: too many redirects (max ${MAX_REDIRECTS})`, wordCount: 0, source }
          }
          const location = res.headers.get('location')!
          currentUrl = new URL(location, currentUrl).toString()
          const parsedRedirect = validateHttpUrl(currentUrl)
          await checkHost(parsedRedirect.hostname)
        }
        resolvedSource = currentUrl
        if (!res) {
          clearTimeout(timeout)
          const readerResult = await readThroughPublicReader(source, title, signal)
          if (readerResult) return readerResult
          return extractionBlockedResult({ source, title, error: 'no response' })
        }
        if (!res.ok) {
          resolvedSource = currentUrl
          contentType = res.headers.get('content-type') || ''
          const failedDocType = detectType(resolvedSource, contentType)
          clearTimeout(timeout)
          if (readerFallbackEligibleStatus(res.status)) {
            const readerResult = await readThroughPublicReader(resolvedSource, title, signal)
            if (readerResult) return readerResult
          }
          return extractionBlockedResult({
            source: resolvedSource,
            title: 'Source extraction unavailable',
            type: failedDocType,
            status: res.status,
            statusText: res.statusText,
          })
        }
        contentType = res.headers.get('content-type') || ''
        docType = detectType(source, contentType)
        const contentLength = res.headers.get('content-length')
        if (contentLength) {
          const parsed = parseInt(contentLength, 10)
          // Reject malformed (NaN/negative) headers up-front so we don't waste
          // bandwidth on a download that the post-fetch size check will reject anyway.
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_FILE_BYTES) {
            clearTimeout(timeout)
            return {
              type: docType,
              title,
              content: 'Error: file exceeds 50MB limit or has invalid Content-Length',
              wordCount: 0,
              source,
              error: 'file exceeds 50MB limit or has invalid Content-Length',
            }
          }
        }
        const arrayBuf = await res.arrayBuffer()
        clearTimeout(timeout)
        if (arrayBuf.byteLength > MAX_FILE_BYTES) {
          return { type: docType, title, content: 'Error: file exceeds 50MB limit', wordCount: 0, source, error: 'file exceeds 50MB limit' }
        }
        buffer = Buffer.from(arrayBuf)
      } catch (err) {
        clearTimeout(timeout)
        const readerResult = await readThroughPublicReader(source, title, signal)
        if (readerResult) return readerResult
        return extractionBlockedResult({ source, title, error: (err as Error).message })
      }
    } else {
      // Local file in sandbox
      if (!conversationId) {
        return { type: 'text', title, content: 'Error: missing task context for local file', wordCount: 0, source }
      }
      const sandboxDir = await getOrCreateSandboxDir(conversationId)
      const resolved = join(sandboxDir, source)
      // Two-step check matches readFileInSandbox in sandbox.ts: cheap string check
      // first, then symlink-aware realpath verification to block planted symlinks.
      if (!isInsideSandbox(sandboxDir, resolved)) {
        return { type: 'text', title, content: 'Error: path traversal not allowed', wordCount: 0, source }
      }
      try {
        if (!await resolveAndVerify(sandboxDir, resolved)) {
          return { type: 'text', title, content: 'Error: path traversal not allowed', wordCount: 0, source }
        }
        const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await file.stat()
          if (info.size > MAX_FILE_BYTES) {
            return { type: 'text', title, content: 'Error: file exceeds 50MB limit', wordCount: 0, source }
          }
          buffer = await file.readFile()
        } finally {
          await file.close()
        }
      } catch {
        return { type: 'text', title, content: 'Error: file not found', wordCount: 0, source }
      }
      if (buffer.length > MAX_FILE_BYTES) {
        return { type: 'text', title, content: 'Error: file exceeds 50MB limit', wordCount: 0, source }
      }
      docType = detectType(source)
    }

    let content: string
    let pageCount: number | undefined

    if (docType === 'pdf') {
      const result = await parsePdf(buffer)
      content = result.text
      pageCount = result.pages
    } else if (docType === 'docx') {
      content = await parseDocx(buffer)
    } else if (isUrl(resolvedSource) && /(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      const page = parseReadableHtml(buffer.toString('utf-8'), resolvedSource)
      title = page.title || title
      content = page.content || ''
    } else {
      content = buffer.toString('utf-8')
    }

    content = truncateContent(content)

    const words = wordCount(content)

    if (isUrl(resolvedSource) && docType === 'text' && words < 8) {
      const readerResult = await readThroughPublicReader(resolvedSource, title, signal)
      if (readerResult) return readerResult
      return extractionBlockedResult({
        source: resolvedSource,
        title: 'Source extraction unavailable',
        type: 'text',
        status: 200,
        statusText: 'No readable page text',
        error: 'HTML response contained no substantive readable text',
      })
    }

    return { type: docType, title, content, pageCount, wordCount: words, source: resolvedSource }
  } catch (err) {
    return { type: 'text', title: 'document', content: `Error: ${(err as Error).message}`, wordCount: 0, source, error: (err as Error).message }
  }
}
