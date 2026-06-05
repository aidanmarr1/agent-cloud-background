import type { SubtaskType } from '@/types'

export const toolNameToSubtaskType: Record<string, SubtaskType> = {
  web_search: 'search',
  image_search: 'search',
  execute_command: 'terminal',
  create_file: 'create_file',
  read_file: 'read_file',
  read_attachment: 'read_file',
  read_skill: 'read_skill',
  delete_file: 'delete_file',
  list_files: 'list_files',
  edit_file: 'edit_file',
  append_file: 'append_file',
  export_pdf: 'export_pdf',
  youtube_transcript: 'youtube_transcript',
  read_document: 'read_document',
  http_request: 'http_request',
  run_code: 'run_code',
  browse_page: 'browser',
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_click_at: 'browser',
  browser_type: 'browser',
  browser_fill_form: 'browser',
  browser_screenshot: 'browser',
  browser_get_content: 'browser',
  browser_scroll: 'browser',
  browser_find_text: 'browser',
  browser_hover: 'browser',
  browser_select: 'browser',
  browser_press_key: 'browser',
  browser_go_back: 'browser',
  browser_click_and_hold: 'browser',
  browser_drag: 'browser',
  browser_action_sequence: 'browser',
}

export const BROWSER_TOOLS = [
  'browse_page', 'browser_navigate', 'browser_click', 'browser_click_at', 'browser_type',
  'browser_fill_form', 'browser_screenshot', 'browser_get_content', 'browser_scroll', 'browser_find_text', 'browser_hover',
  'browser_select', 'browser_press_key', 'browser_go_back', 'browser_click_and_hold',
  'browser_drag', 'browser_action_sequence',
]

export const INTERNAL_ACTIVITY_TOOLS = ['browser_screenshot', 'browser_resize'] as const

export function isInternalActivityTool(toolName?: string): boolean {
  return !!toolName && (INTERNAL_ACTIVITY_TOOLS as readonly string[]).includes(toolName)
}

export function isInternalActivityLabel(label?: string): boolean {
  return label === 'Taking screenshot' ||
    label === 'Capturing full page screenshot' ||
    label === 'Inspecting page' ||
    label === 'Inspecting full page' ||
    label === 'Skipping viewport resize' ||
    /^Testing \d+x\d+$/i.test(label || '')
}

export function isInternalSubtaskActivity(subtask: { toolName?: string; label?: string }): boolean {
  return isInternalActivityTool(subtask.toolName) || isInternalActivityLabel(subtask.label)
}

export function isIncompleteBrowserClickActivity(subtask: { toolName?: string; label?: string }): boolean {
  if (subtask.toolName !== 'browser_click' && subtask.toolName !== 'browser_click_at') return false
  const label = (subtask.label || '').trim().toLowerCase()
  return label === 'clicking element' || label === 'clicking page control'
}

const BROWSER_PREFLIGHT_BLOCK_PATTERN = /\bBlocked browser_|BROWSER_ACTION_PREFLIGHT_BLOCKED|blocked before execution|browser_(?:click_at|type|select|fill_form) requires/i

function getStringField(value: unknown, field: 'error' | 'action'): string {
  if (!value || typeof value !== 'object') return ''
  const raw = (value as Record<string, unknown>)[field]
  return typeof raw === 'string' ? raw : ''
}

export function isBrowserPreflightBlockText(text?: string): boolean {
  return !!text && BROWSER_PREFLIGHT_BLOCK_PATTERN.test(text)
}

export function isBrowserPreflightBlockResult(result?: unknown): boolean {
  return isBrowserPreflightBlockText([
    getStringField(result, 'action'),
    getStringField(result, 'error'),
  ].filter(Boolean).join('\n'))
}

export function isBrowserPreflightBlockActivity(subtask: { toolName?: string; label?: string; result?: unknown }): boolean {
  if (!subtask.toolName?.startsWith('browser_')) return false
  return isBrowserPreflightBlockText([
    subtask.label || '',
    getStringField(subtask.result, 'action'),
    getStringField(subtask.result, 'error'),
  ].filter(Boolean).join('\n'))
}

export function isHiddenSubtaskActivity(subtask: { toolName?: string; label?: string; result?: unknown }): boolean {
  return isInternalSubtaskActivity(subtask) ||
    isIncompleteBrowserClickActivity(subtask) ||
    isBrowserPreflightBlockActivity(subtask)
}

export const FILE_TOOLS = ['create_file', 'read_file', 'read_attachment', 'read_skill', 'delete_file', 'list_files', 'edit_file', 'append_file', 'export_pdf']
export const BROWSE_TOOLS = ['youtube_transcript', 'read_document', 'http_request']
