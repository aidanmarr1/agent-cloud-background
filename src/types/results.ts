export interface SearchResult {
  title: string
  snippet: string
  url: string
  source?: string
}

export interface BrowseResult {
  title: string
  content: string
  url: string
}

export interface ImageSearchResult {
  title: string
  thumbnailUrl: string
  sourceUrl: string
  imageUrl: string
}

export interface TerminalResult {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

export interface BrowserResult {
  success: boolean
  url: string
  title: string
  recoverable?: boolean
  screenshotPath?: string
  screenshotUrl?: string
  screenshotBase64?: string
  liveFrame?: boolean
  liveFrameUpdatedAt?: number
  content?: string
  error?: string
  visualQuality?: {
    blank: boolean
    reason: string | null
    nonWhiteRatio: number
    edgeRatio: number
    channelStdDev: number
  }
  action: string
}

export interface ImageSearchPanelItem {
  title: string
  thumbnailUrl: string
  localUrl: string
  sourceUrl: string
}

export interface FileResult {
  action: 'created' | 'read' | 'deleted' | 'listed' | 'edited' | 'appended' | 'exported'
  path: string
  content?: string
  error?: string
  files?: string[]
  size?: number
  // Set when listFilesInSandbox hit MAX_LIST_DEPTH or MAX_LIST_FILES.
  truncated?: boolean
}
