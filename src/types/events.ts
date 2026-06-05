import type { SearchResult, BrowseResult, TerminalResult, FileResult, BrowserResult } from './results'
import type { Artifact } from './artifacts'
import type { CreditLedgerEvent, CreditTokenUsage } from '@/lib/creditPolicy'

export interface FollowUpSuggestion {
  text: string
}

export type StepAdvanceStatus = 'done' | 'incomplete'

export type SSEEventPayload =
  | { type: 'heartbeat'; timestamp: number }
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'reasoning_done' }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: SearchResult[] | BrowseResult | TerminalResult | FileResult | BrowserResult }
  | { type: 'browser_frame'; frame: string; timestamp: number }
  | { type: 'terminal_output'; id: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'file_content_start'; id: string; path: string; toolName?: string }
  | { type: 'file_content_delta'; id: string; content: string }
  | { type: 'plan'; items: string[] }
  | { type: 'follow_ups'; suggestions: FollowUpSuggestion[] }
  | { type: 'artifact_created'; artifact: Artifact }
  | { type: 'credit_event'; entry: CreditLedgerEvent }
  | { type: 'step_advance'; status?: StepAdvanceStatus; reason?: string }
  | { type: 'done'; usage?: CreditTokenUsage }
  | { type: 'error'; message: string }

export type SSEEvent = SSEEventPayload & {
  seq?: number
  runId?: string
}

export type StreamingStatus = 'startup' | 'thinking' | 'searching' | 'browsing' | 'coding' | 'writing' | 'analyzing' | 'running' | null
