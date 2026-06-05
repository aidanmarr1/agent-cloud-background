import type { SearchResult, BrowseResult, TerminalResult, FileResult, BrowserResult } from './results'

// --- Legacy step types (backward compat with persisted conversations) ---

export interface TaskStep {
  index: number
  title: string
  status: 'pending' | 'running' | 'done' | 'incomplete' | 'error'
  items: StepItem[]
  startedAt?: number
}

export interface StepAction {
  type: 'search' | 'browse'
  query?: string
  url?: string
  result?: SearchResult[] | BrowseResult
}

export interface StepUpdate {
  type: 'update'
  content: string
}

export type StepItem = StepAction | StepUpdate

// --- Task group types ---

export interface GroupNarration {
  id: string
  text: string
  position: number
}

export interface TaskGroup {
  id: string
  index: number
  title: string
  status: 'pending' | 'running' | 'done' | 'incomplete' | 'error'
  subtasks: Subtask[]
  narrations: GroupNarration[]
  synthesis: string
  startedAt?: number
}

export type SubtaskType = 'search' | 'browse' | 'terminal' | 'create_file' | 'read_file' | 'read_skill' | 'delete_file' | 'list_files' | 'edit_file' | 'append_file' | 'export_pdf' | 'youtube_transcript' | 'read_document' | 'http_request' | 'run_code' | 'browser'

export interface Subtask {
  id: string
  toolName?: string
  type: SubtaskType
  label: string
  labelSource?: 'model' | 'system'
  query?: string
  url?: string
  command?: string
  filePath?: string
  status: 'running' | 'done' | 'error'
  errorMessage?: string
  result?: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult
  startedAt: number
}
