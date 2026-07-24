const NON_IDEMPOTENT_TOOL_NAMES = new Set([
  'create_file',
  'edit_file',
  'append_file',
  'delete_file',
  'export_pdf',
  'image_search',
  'execute_command',
  'run_code',
  'browser_click',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_select',
  'browser_press_key',
  'browser_go_back',
  'browser_click_and_hold',
  'browser_drag',
  'browser_action_sequence',
])

const HIGH_RISK_TOOL_NAMES = new Set([
  'delete_file',
  'execute_command',
  'run_code',
  'browser_click',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_select',
  'browser_press_key',
  'browser_click_and_hold',
  'browser_drag',
  'browser_action_sequence',
])

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface InflightToolDrainResult {
  settled: boolean
  pendingCount: number
  nonIdempotentPending: boolean
  pendingToolNames: string[]
}

export type InflightToolDrain = (timeoutMs: number) => Promise<InflightToolDrainResult>

function httpMethod(args?: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'GET'
  const method = (args as { method?: unknown }).method
  return typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET'
}

export function isNonIdempotentToolCall(toolName: string, args?: unknown): boolean {
  if (NON_IDEMPOTENT_TOOL_NAMES.has(toolName)) return true
  if (toolName === 'browser_navigate' && args && typeof args === 'object' && !Array.isArray(args)) {
    if ((args as { previewBuild?: unknown }).previewBuild === true) return true
  }
  return toolName === 'http_request' && !SAFE_HTTP_METHODS.has(httpMethod(args))
}

export function toolHasSideEffects(toolName: string): boolean {
  return NON_IDEMPOTENT_TOOL_NAMES.has(toolName) || toolName === 'http_request'
}

export function inferToolRiskLevel(toolName: string): 'low' | 'medium' | 'high' {
  if (HIGH_RISK_TOOL_NAMES.has(toolName)) return 'high'
  if (toolHasSideEffects(toolName)) return 'medium'
  return 'low'
}
