/**
 * Dynamic Tool Registry with capability discovery and health tracking.
 */

import type { AgentStateData } from './AgentState'
import { isToolDisabled } from './AgentState'
import type { TaskType } from './TaskStrategy'
import { PHASE_TOOL_FILTER } from './config'
import { inferToolRiskLevel, toolHasSideEffects } from './toolSafety'

const BROWSE_STRATEGY_TOOLS = new Set([
  'browser_navigate', 'browser_click_at', 'browser_type',
  'browser_fill_form', 'browser_find_text', 'browser_screenshot',
  'browser_get_content', 'browser_scroll', 'browser_hover', 'browser_select',
  'browser_press_key', 'browser_go_back', 'browser_action_sequence',
  'browser_click_and_hold', 'browser_drag', 'web_search',
])

// ── Types ───────────────────────────────────────────────────────────────────

export type ToolCapability =
  | 'search'
  | 'browse'
  | 'file_read'
  | 'file_write'
  | 'file_manage'
  | 'code_execution'
  | 'network'
  | 'browser_interaction'
  | 'browser_navigation'
  | 'media'
  | 'document'

export interface ToolMetadata {
  name: string
  capabilities: ToolCapability[]
  description: string
  riskLevel: 'low' | 'medium' | 'high'
  sideEffects: boolean
  timeout?: number
  definition: Record<string, unknown>
}

interface ToolRuntimeState {
  enabled: boolean
  disabledReason?: string
  callCount: number
  lastCalledAt: number
}

// ── Registry ────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools: Map<string, ToolMetadata> = new Map()
  private runtimeState: Map<string, ToolRuntimeState> = new Map()

  /**
   * Register a tool with its metadata.
   */
  register(metadata: ToolMetadata): this {
    this.tools.set(metadata.name, metadata)
    this.runtimeState.set(metadata.name, {
      enabled: true,
      callCount: 0,
      lastCalledAt: 0,
    })
    return this
  }

  /**
   * Bulk register from existing tool definitions array.
   */
  registerFromDefinitions(definitions: Array<unknown>): this {
    for (const def of definitions) {
      const defObj = def as Record<string, unknown>
      const fn = defObj.function as { name: string; description: string } | undefined
      if (!fn) continue

      const capabilities = inferCapabilities(fn.name)
      const riskLevel = inferToolRiskLevel(fn.name)
      const sideEffects = toolHasSideEffects(fn.name)

      this.register({
        name: fn.name,
        capabilities,
        description: fn.description,
        riskLevel,
        sideEffects,
        definition: defObj,
      })
    }
    return this
  }

  /**
   * Get a tool by name.
   */
  get(name: string): ToolMetadata | undefined {
    return this.tools.get(name)
  }

  /**
   * Get all tools matching a capability.
   */
  getByCapability(capability: ToolCapability): ToolMetadata[] {
    return [...this.tools.values()].filter(
      t => t.capabilities.includes(capability)
    )
  }

  /**
   * Get tool definitions filtered by current state and phase.
   */
  getActiveDefinitions(state: AgentStateData, taskType?: TaskType): Array<Record<string, unknown>> {
    const active: Array<{ name: string; definition: Record<string, unknown>; order: number }> = []

    const phaseFilter = state.currentPhase !== 'unknown'
      ? (PHASE_TOOL_FILTER[state.currentPhase] as string[] | undefined)
      : undefined
    const priority = new Map<string, number>()
    const priorityList = state.strategyConfig?.toolPriority || (taskType ? this.getRecommendedTools(taskType) : [])
    priorityList.forEach((name, index) => priority.set(name, index))

    let order = 0
    for (const [name, metadata] of this.tools) {
      const runtime = this.runtimeState.get(name)
      if (runtime && !runtime.enabled) continue
      if (isToolDisabled(state, name)) continue
      if (name === 'web_search' && state.searchDisabled) continue
      if (phaseFilter && !phaseFilter.includes(name) && !(state.taskStrategy === 'browse' && BROWSE_STRATEGY_TOOLS.has(name))) continue

      active.push({ name, definition: metadata.definition, order })
      order++
    }

    active.sort((a, b) => {
      const aPriority = priority.get(a.name) ?? Number.MAX_SAFE_INTEGER
      const bPriority = priority.get(b.name) ?? Number.MAX_SAFE_INTEGER
      return aPriority - bPriority || a.order - b.order
    })

    return active.map(tool => tool.definition)
  }

  /**
   * Disable a tool at runtime with a reason.
   */
  disable(name: string, reason: string): void {
    const runtime = this.runtimeState.get(name)
    if (runtime) {
      runtime.enabled = false
      runtime.disabledReason = reason
    }
  }

  /**
   * Re-enable a tool.
   */
  enable(name: string): void {
    const runtime = this.runtimeState.get(name)
    if (runtime) {
      runtime.enabled = true
      runtime.disabledReason = undefined
    }
  }

  /**
   * Record a tool call for tracking.
   */
  recordCall(name: string): void {
    const runtime = this.runtimeState.get(name)
    if (runtime) {
      runtime.callCount++
      runtime.lastCalledAt = Date.now()
    }
  }

  /**
   * Get tool names sorted by relevance for a task type.
   */
  getRecommendedTools(taskType: TaskType): string[] {
    const capabilityPriority = TASK_CAPABILITY_PRIORITY[taskType] || []
    const scored = [...this.tools.entries()].map(([name, meta]) => {
      let score = 0
      for (let i = 0; i < capabilityPriority.length; i++) {
        if (meta.capabilities.includes(capabilityPriority[i])) {
          score += capabilityPriority.length - i
        }
      }
      return { name, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.map(s => s.name)
  }

  /**
   * Get the timeout for a specific tool.
   */
  getTimeout(name: string, defaultTimeout: number): number {
    const meta = this.tools.get(name)
    return meta?.timeout ?? defaultTimeout
  }

  /**
   * Get tool count.
   */
  get size(): number {
    return this.tools.size
  }

  /**
   * Check if a tool has side effects.
   */
  hasSideEffects(name: string): boolean {
    return this.tools.get(name)?.sideEffects ?? false
  }
}

// ── Capability Inference ────────────────────────────────────────────────────

const TASK_CAPABILITY_PRIORITY: Record<string, ToolCapability[]> = {
  research: ['search', 'browse', 'document', 'file_write'],
  build: ['file_write', 'code_execution', 'file_read', 'search'],
  code: ['code_execution', 'file_write', 'file_read'],
  browse: ['browser_navigation', 'browser_interaction', 'search'],
  analysis: ['code_execution', 'search', 'document', 'file_write'],
  creative: ['file_write', 'search', 'media'],
  general: ['search', 'browse', 'file_write', 'code_execution'],
}

function inferCapabilities(name: string): ToolCapability[] {
  const caps: ToolCapability[] = []

  if (name === 'web_search') caps.push('search', 'network')
  if (name === 'image_search') caps.push('search', 'media')
  if (name === 'browse_page') caps.push('browse')
  if (name === 'read_document') caps.push('document')

  if (name.startsWith('browser_')) {
    if (name === 'browser_navigate' || name === 'browser_go_back') {
      caps.push('browser_navigation')
    } else {
      caps.push('browser_interaction')
    }
  }

  if (name === 'create_file' || name === 'edit_file' || name === 'append_file' || name === 'export_pdf') caps.push('file_write')
  if (name === 'read_file' || name === 'list_files') caps.push('file_read')
  if (name === 'delete_file') caps.push('file_manage')

  if (name === 'execute_command' || name === 'run_code') caps.push('code_execution')
  if (name === 'http_request') caps.push('network')

  return caps
}
