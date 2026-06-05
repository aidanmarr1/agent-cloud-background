/**
 * Agent Architecture — Public API
 */

// Core loop
export { AgentLoop, type AgentLoopOptions } from './AgentLoop'

// Errors
export {
  AgentError,
  TimeoutError, IterationTimeoutError, InactivityTimeoutError, ContentOnlyTimeoutError,
  ToolError, ToolParseError, ToolTimeoutError, ToolBlockedError,
  StreamError, RateLimitError,
  LeakageError, InjectionError,
  BudgetExhaustedError,
  isTimeoutError, isNudgeableTimeout, isToolError, isRateLimitError, isRecoverable,
  type BlockReason,
} from './errors'

// Task strategy
export {
  resolveStrategy, getStrategy, computeIterationLimit, computeTimeouts, computeStepBudgets,
  type TaskType, type TaskStrategyConfig,
} from './TaskStrategy'

// Context management
export { ContextManager } from './ContextManager'

// Tool registry
export {
  ToolRegistry,
  type ToolMetadata, type ToolCapability,
} from './ToolRegistry'

// Existing components
export { SSEEmitter } from './SSEEmitter'
export { StreamProcessor, type ToolCallData, type StreamResult } from './StreamProcessor'
export { ToolPipeline, type ToolExecutionResult } from './ToolPipeline'
export { PolicyEngine, type PolicyAction, type PolicyActionType } from './PolicyEngine'
export { PlanManager } from './PlanManager'

// State
export {
  createInitialState, type AgentStateData,
  trackToolCall, trackFileCreate, trackSearchResult, trackBrowseResult,
  advanceStep, logWork, getWorkSummary, getToolHealthSummary,
  trackSearchQuery, trackSourceDomain, trackFailure,
  updateToolHealth, isToolDisabled, updatePhase, detectToolCallLoop,
  tokenizeQuery,
  BROWSER_INTERACTION_TOOLS,
} from './AgentState'

// Logger
export { Logger, createAgentLogger, type LogLevel } from './Logger'

// Tool cache
export { ToolCache } from './ToolCache'

// Tool retry
export { ToolRetry, type RetryConfig } from './ToolRetry'

// Config
export * from './config'

// Reflection & verification
export { ReflectionEngine, type ReflectionResult } from './ReflectionEngine'
export { GoalTracker, type SubGoal, type GoalStatus } from './GoalTracker'
export { OutputVerifier, type VerificationResult } from './OutputVerifier'
export { auditAgentCompletion, type CompletionAuditResult } from './CompletionAudit'

// Error recovery
export * from './recovery'
