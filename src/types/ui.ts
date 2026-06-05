import type { SearchResult, BrowseResult, TerminalResult, FileResult, ImageSearchPanelItem, BrowserResult } from './results'

export interface ComputerPanelItem {
  id: string
  type: 'search' | 'browse' | 'terminal' | 'file' | 'image_search' | 'browser'
  title: string
  data: SearchResult[] | BrowseResult | TerminalResult | FileResult | ImageSearchPanelItem[] | BrowserResult
  timestamp: number
  streaming?: boolean
}

export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: string
  handler: 'inject' | 'action' | 'skill'
  skillId?: string
  source?: 'command' | 'skill'
}

export interface SavedSkill {
  id: string
  name: string
  description: string
  content: string
  sourceName: string
  sourceType: 'skill' | 'zip' | 'folder' | 'text'
  fileCount: number
  size: number
  createdAt: number
  updatedAt: number
}

export interface InstructionTemplate {
  id: string
  name: string
  description: string
  content: string
}

export type ThemeSetting = 'light' | 'dark' | 'system'
