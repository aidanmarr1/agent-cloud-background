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
    const docResult = result as { title?: string; content?: string; source?: string }
    return {
      title: docResult.title || 'Document',
      content: docResult.content || '',
      url: docResult.source || '',
    } as BrowseResult
  }

  if (name === 'http_request') {
    const httpResult = result as { status?: number; statusText?: string; body?: string }
    return {
      title: `HTTP ${httpResult.status || ''} ${httpResult.statusText || ''}`.trim(),
      content: httpResult.body || '',
      url: '',
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
