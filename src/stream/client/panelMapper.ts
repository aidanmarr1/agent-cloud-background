import type {
  ComputerPanelItem, SearchResult, BrowseResult, TerminalResult,
  FileResult, ImageSearchPanelItem, BrowserResult,
} from '@/types'
import { FILE_TOOLS, BROWSER_TOOLS, BROWSE_TOOLS } from '@/lib/stream/constants'

interface ToolResultEvent {
  id: string
  name: string
  result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringField(record: Record<string, unknown> | null, field: string): string {
  const value = record?.[field]
  return typeof value === 'string' ? value.trim() : ''
}

function firstStringField(record: Record<string, unknown> | null, fields: string[]): string {
  for (const field of fields) {
    const value = stringField(record, field)
    if (value) return value
  }
  return ''
}

function numberField(record: Record<string, unknown> | null, field: string): number | undefined {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function fallbackTitleForSource(url: string, fallback: string): string {
  const host = hostnameFromUrl(url)
  if (!host) return fallback
  try {
    const parsed = new URL(url)
    const lastPath = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/[-_]+/g, ' ')
    return lastPath ? `${host} · ${lastPath}` : host
  } catch {
    return host
  }
}

function normalizeDocumentTitle(title: string, url: string, content: string, error = '', status?: number): string {
  const genericTitle = !title || /^(?:document|untitled|page content)$/i.test(title)
  const failureText = `${error} ${content}`.trim()
  const internalRecovery = /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(error) ||
    /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(content)
  if (internalRecovery) return 'Source needs browser rendering'

  const failed = /^(?:error|blocked|request failed|failed to load|extraction blocked)\b/i.test(content) || !!error
  if (failed) {
    if (status === 401 || /\b(?:401|unauthorized|login required|authentication required)\b/i.test(failureText)) return 'Access required'
    if (status === 403 || /\b(?:403|forbidden)\b/i.test(failureText)) return 'Source needs browser rendering'
    if (status === 429 || /\b(?:429|rate limited|too many requests)\b/i.test(failureText)) return 'Temporarily rate limited'
    return 'Source needs browser rendering'
  }
  if (genericTitle) return fallbackTitleForSource(url, 'Extracted page')
  return title
}

function normalizeBrowseLikeResult(result: unknown, fallbackTitle: string): BrowseResult {
  const record = asRecord(result)
  const url = firstStringField(record, ['url', 'source', 'path'])
  const error = firstStringField(record, ['error'])
  const status = numberField(record, 'status')
  const rawContent = firstStringField(record, ['content', 'text', 'markdown', 'body', 'error', 'statusText'])
  const internalRecovery = /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(error) ||
    /^(?:INTERNAL_RECOVERY:|FINAL_STEP_REDIRECT:)/i.test(rawContent)
  const content = internalRecovery
    ? ''
    : rawContent
  const title = normalizeDocumentTitle(firstStringField(record, ['title', 'name']), url, content, error, status)
  return {
    title: title || fallbackTitleForSource(url, fallbackTitle),
    content: internalRecovery ? '' : content || 'No extracted text was returned for this source.',
    url,
  }
}

function resolvePanelType(name: string): ComputerPanelItem['type'] {
  if (name === 'image_search') return 'image_search'
  if (name === 'web_search') return 'search'
  if (name === 'execute_command' || name === 'run_code') return 'terminal'
  if (FILE_TOOLS.includes(name)) return 'file'
  if (BROWSER_TOOLS.includes(name)) return 'browser'
  if (BROWSE_TOOLS.includes(name)) return 'browse'
  return 'browse'
}

const PANEL_TITLES: Record<string, string> = {
  image_search: 'Image Search',
  web_search: 'Search Results',
  execute_command: 'Terminal',
  create_file: 'File Created',
  read_file: 'File Contents',
  read_attachment: 'Uploaded Attachment',
  read_skill: 'Skill Read',
  delete_file: 'File Deleted',
  list_files: 'File Listing',
  edit_file: 'File Edited',
  append_file: 'File Appended',
  export_pdf: 'PDF Exported',
  youtube_transcript: 'YouTube Transcript',
  read_document: 'Document Content',
  http_request: 'HTTP Response',
  run_code: 'Code Output',
}

function resolvePanelTitle(name: string): string {
  if (PANEL_TITLES[name]) return PANEL_TITLES[name]
  if (name.startsWith('browser_')) return 'Browser'
  return 'Page Content'
}

function transformPanelData(
  name: string,
  result: unknown,
  conversationId: string,
): SearchResult[] | BrowseResult | TerminalResult | FileResult | ImageSearchPanelItem[] | BrowserResult {
  if (name === 'image_search') {
    const imgResult = result as {
      downloaded?: string[]
      images?: Array<{ title: string; thumbnailUrl: string; sourceUrl: string; imageUrl: string }>
      conversationId?: string
    }
    const images = imgResult.images || []
    const downloaded = imgResult.downloaded || []
    const convId = imgResult.conversationId || conversationId
    return downloaded.map((filePath: string, idx: number) => {
      const image = images[idx]
      return {
        title: image?.title || filePath.split('/').pop() || 'Image',
        thumbnailUrl: image?.thumbnailUrl || '',
        localUrl: `/api/sandbox/${convId}/${filePath}`,
        sourceUrl: image?.sourceUrl || '',
      }
    }) as ImageSearchPanelItem[]
  }

  if (name === 'youtube_transcript') {
    const ytResult = result as { title?: string; transcript?: string; videoId?: string }
    return {
      title: ytResult.title || 'YouTube Transcript',
      content: ytResult.transcript || '',
      url: ytResult.videoId ? `https://youtube.com/watch?v=${ytResult.videoId}` : '',
    } as BrowseResult
  }

  if (name === 'read_document') {
    return normalizeBrowseLikeResult(result, 'Extracted page')
  }

  if (name === 'http_request') {
    const httpResult = result as { status?: number; statusText?: string; body?: string; url?: string; source?: string; content?: string; text?: string; error?: string }
    const status = typeof httpResult.status === 'number' ? httpResult.status : undefined
    const statusText = httpResult.statusText || ''
    const body = httpResult.body || httpResult.content || httpResult.text || httpResult.error || ''
    const statusLabel = status !== undefined ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : (statusText || 'HTTP response')
    const url = httpResult.url || httpResult.source || ''
    return {
      title: statusLabel,
      content: body || statusLabel,
      url,
    } as BrowseResult
  }

  if (name === 'run_code') {
    const codeResult = result as { stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; timedOut?: boolean; language?: string }
    return {
      command: `[${codeResult.language || 'code'}]`,
      stdout: codeResult.stdout || '',
      stderr: codeResult.stderr || '',
      exitCode: codeResult.exitCode ?? 1,
      durationMs: codeResult.durationMs ?? 0,
      timedOut: codeResult.timedOut ?? false,
    } as TerminalResult
  }

  return result as SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult
}

export function mapToolResultToPanel(event: ToolResultEvent, conversationId: string): ComputerPanelItem {
  return {
    id: event.id,
    type: resolvePanelType(event.name),
    title: resolvePanelTitle(event.name),
    data: transformPanelData(event.name, event.result, conversationId),
    timestamp: Date.now(),
  }
}

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOLS.includes(name)
}
