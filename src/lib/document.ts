import { constants } from 'fs'
import { open } from 'fs/promises'
import { join } from 'path'
import { getOrCreateSandboxDir, isInsideSandbox, resolveAndVerify } from './sandbox'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'

export interface DocumentResult {
  type: 'pdf' | 'docx' | 'text'
  title: string
  content: string
  pageCount?: number
  wordCount: number
  source: string
}

const MAX_CONTENT_CHARS = 40_000
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50MB
const MAX_REDIRECTS = 5

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

export async function readDocument(source: string, conversationId?: string): Promise<DocumentResult> {
  try {
    let buffer: Buffer
    let docType: 'pdf' | 'docx' | 'text'
    let title = source.split('/').pop()?.split('?')[0] || 'document'

    if (isUrl(source)) {
      // SSRF protection
      try {
        const parsed = validateHttpUrl(source)
        await checkHost(parsed.hostname)
      } catch (err) {
        return { type: 'text', title, content: `Blocked: ${(err as Error).message}`, wordCount: 0, source }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        // Manual redirect loop with per-hop SSRF re-validation. fetch's default
        // redirect handling does NOT re-check the host, so an attacker-controlled
        // page can 302 to http://169.254.169.254/ or any private IP and bypass
        // the checkHost above.
        let currentUrl = source
        let res: Response | null = null
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          res = await guardedFetch(currentUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' },
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
        if (!res) {
          clearTimeout(timeout)
          return { type: 'text', title, content: 'Error: no response', wordCount: 0, source }
        }
        if (!res.ok) {
          clearTimeout(timeout)
          return { type: 'text', title, content: `Error: HTTP ${res.status} ${res.statusText}`, wordCount: 0, source }
        }
        const contentType = res.headers.get('content-type') || ''
        docType = detectType(source, contentType)
        const contentLength = res.headers.get('content-length')
        if (contentLength) {
          const parsed = parseInt(contentLength, 10)
          // Reject malformed (NaN/negative) headers up-front so we don't waste
          // bandwidth on a download that the post-fetch size check will reject anyway.
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_FILE_BYTES) {
            clearTimeout(timeout)
            return { type: docType, title, content: 'Error: file exceeds 50MB limit or has invalid Content-Length', wordCount: 0, source }
          }
        }
        const arrayBuf = await res.arrayBuffer()
        clearTimeout(timeout)
        if (arrayBuf.byteLength > MAX_FILE_BYTES) {
          return { type: docType, title, content: 'Error: file exceeds 50MB limit', wordCount: 0, source }
        }
        buffer = Buffer.from(arrayBuf)
      } catch (err) {
        clearTimeout(timeout)
        return { type: 'text', title, content: `Error: ${(err as Error).message}`, wordCount: 0, source }
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
    } else {
      content = buffer.toString('utf-8')
    }

    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS) + '\n... [truncated]'
    }

    const wordCount = content.split(/\s+/).filter(Boolean).length

    return { type: docType, title, content, pageCount, wordCount, source }
  } catch (err) {
    return { type: 'text', title: 'document', content: `Error: ${(err as Error).message}`, wordCount: 0, source }
  }
}
