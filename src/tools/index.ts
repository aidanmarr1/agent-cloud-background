// Unified tool system entry point
// Re-exports tool definitions and execution from existing implementations
// while providing a single import path for consumers

export { toolDefinitions } from '@/lib/tools'
export { executeTool } from '@/lib/tools'
export type { ToolContext } from '@/lib/tools'
export { executeToolFromRegistry } from '@/lib/toolRegistry'
