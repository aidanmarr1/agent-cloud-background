/**
 * AgentLoop — the main orchestrator for the AI agent.
 *
 * Simple while-loop architecture:
 *   PLANNING → STREAMING → EXECUTING_TOOLS → EVALUATING → STREAMING → ... → COMPLETE
 */

import {
  createStreamingCompletion,
  type ChatCompletionTool,
  type ChatMessageParam,
  type StreamingChatCompletionChunk,
} from '@/lib/llm'
import { toolDefinitions } from '@/lib/tools'
import { getSystemPrompt, estimateTaskComplexity, type StrategyHints } from '@/lib/prompts'
import { effectiveTaskRequest, isContextualTaskUpdate } from '@/lib/conversationContext'
import { createFileInSandbox, readFileInSandbox } from '@/lib/sandbox'
import { subscribeToBrowserFrames } from '@/lib/browser'

import type { AgentEventEmitter } from './SSEEmitter'
import { AgentStateData, createInitialState, updatePhase, trackFileCreate, logWork, recordWorkLedgerDeliverable } from './AgentState'
import {
  MIN_ITERATION_DELAY_MS, MAX_TIMEOUT_NUDGES,
  STREAM_MAX_RETRIES, STREAM_RETRY_BASE_MS, STREAM_RETRY_EXPONENT,
  STREAM_REQUEST_TIMEOUT_MS, STREAM_RETRY_MAX_DELAY_MS,
  MAX_ATTACHMENT_CHARS, MAX_CONTEXT_ATTACHMENT_CHARS, URGENCY_FINAL_FRACTION,
  TOOL_CACHE_MAX_ENTRIES, TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_SIZE_CHARS,
  MIN_RESEARCH_CALLS_BY_COMPLEXITY, MIN_TOOL_CALLS_BY_COMPLEXITY,
  AGENT_RUN_MAX_DURATION_MS, AGENT_DEADLINE_FINALIZATION_BUFFER_MS,
  AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS, AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
} from './config'
import { StreamProcessor, type StreamResult, type ToolCallData } from './StreamProcessor'
import { ToolPipeline, type ToolExecutionResult } from './ToolPipeline'
import { PolicyEngine } from './PolicyEngine'
import { PlanManager, type RequiredPlanStep } from './PlanManager'
import { isPromptInjection } from './guards'
import { explicitWebSearchLimitFromText, isFixedWebSearchInlineAnswerState } from './taskConstraints'

import { resolveStrategy, computeIterationLimit, computeTimeouts, type TaskStrategyConfig } from './TaskStrategy'
import { ContextManager } from './ContextManager'
import { ToolRegistry } from './ToolRegistry'
import { isNudgeableTimeout, TimeoutError } from './errors'

import { createAgentLogger } from './Logger'
import { ToolCache } from './ToolCache'
import { ToolRetry } from './ToolRetry'
import { ErrorRecoveryEngine } from './recovery/ErrorRecoveryEngine'
import { WorkingMemory } from './WorkingMemory'
import { ReflectionEngine } from './ReflectionEngine'
import { GoalTracker } from './GoalTracker'
import { OutputVerifier } from './OutputVerifier'
import { auditAgentCompletion } from './CompletionAudit'
import { shouldDefaultFrontendToNextTsx } from './frontendDefaults'
import { isWebsiteEntryPath } from '@/lib/localWebsiteServer'
import { getNextWebsiteProjectStatus } from '@/lib/tsxWebsitePreview'
import { OUT_OF_CREDITS_MESSAGE, type CreditTokenUsage } from '@/lib/creditPolicy'
import { assertServerCreditsAvailable, chargeServerTokenUsage, isOutOfCreditsError } from '@/lib/serverCredits'
import { drainLiveDirectives, type LiveDirective } from '@/lib/liveDirectives'
import { MAX_DELIVERABLE_REVISIONS } from './config'
import type { StepAdvanceStatus } from '@/types'
import {
  hydrateResearchActivityIndex,
  loadResearchActivityEntries,
  researchActivityContext,
} from './ResearchActivityLog'
import { userErrorMessage } from '@/lib/errorMessages'

/**
 * Phase 12 Fix NNN: scan the user's most recent message for a URL or bare
 * domain. Returns the first match (full URL preferred over bare domain), or
 * null if none. Used by AgentLoop to populate state.userProvidedUrl, which
 * ToolPipeline reads to reroute premature web_search calls into direct navigation.
 *
 * Bare-domain regex requires `[a-z]{2,}` TLD AND a leading domain part so
 * filenames (`report.pdf`) and version strings (`1.2.3`) don't false-positive.
 */
function stripUrlTrailingPunctuation(value: string): string {
  return value.replace(/[.,!?;:)\]}>'"]+$/g, '')
}

function normalizeUserProvidedUrl(value: string): string | null {
  const cleaned = stripUrlTrailingPunctuation(value.trim())
  if (!cleaned) return null
  if (/^https?:\/\//i.test(cleaned)) return cleaned
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) return `http://${cleaned}`
  if (/^127\.0\.0\.1(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) return `http://${cleaned}`
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(cleaned)) {
    return `https://${cleaned}`
  }
  return null
}

function extractUserProvidedUrl(messages: Array<{ role: string; content: string }>): string | null {
  const content = effectiveTaskRequest(messages)
  if (!content) return null
  // Full URL match (preferred)
  const fullUrl = content.match(/https?:\/\/[^\s<>()\]]+/i)
  if (fullUrl) return normalizeUserProvidedUrl(fullUrl[0])
  // Bare domain match
  const bareDomain = content.match(/(?<!@)\b(?:localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?)(?:\/[^\s<>()\]]*)?/i)
  if (bareDomain) return normalizeUserProvidedUrl(bareDomain[0])
  return null
}

function toolArgumentsForProviderHistory(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed)
    }
    return JSON.stringify({ value: parsed ?? null })
  } catch {
    return JSON.stringify({
      invalidArguments: true,
      rawPreview: argumentsText.slice(0, 1000),
    })
  }
}

function executedToolCallsForProviderHistory(
  requestedToolCalls: Map<number, ToolCallData>,
  toolResults: ToolExecutionResult[],
): ToolCallData[] {
  const requestedIds = new Set(Array.from(requestedToolCalls.values()).map(tc => tc.id))
  return toolResults
    .map(result => result.tc)
    .filter(tc => requestedIds.has(tc.id))
    .map(tc => ({
      ...tc,
      arguments: toolArgumentsForProviderHistory(tc.arguments),
    }))
}

const FINAL_DELIVERABLE_WRITE_TOOLS = new Set(['create_file', 'append_file', 'edit_file', 'export_pdf'])

function isSuccessfulFinalDeliverableWrite(result: ToolExecutionResult): boolean {
  return FINAL_DELIVERABLE_WRITE_TOOLS.has(result.tc.name) && !result.isError
}

function toolResultPath(result: ToolExecutionResult): string {
  try {
    const args = JSON.parse(result.tc.arguments) as { path?: string; output_path?: string; source_path?: string }
    if (result.tc.name === 'export_pdf') {
      return String((result.result as { path?: string } | undefined)?.path || args.output_path || '')
    }
    return String(args.path || args.output_path || args.source_path || '')
  } catch {
    return String((result.result as { path?: string } | undefined)?.path || '')
  }
}

const EXACT_EXTRACTION_SOURCE_TOOLS = new Set([
  'browser_navigate',
  'browse_page',
  'browser_get_content',
  'browser_find_text',
  'browser_scroll',
])

const EXACT_EXTRACTION_TOOLS = new Set([
  'browser_find_text',
  'browser_screenshot',
  'browser_get_content',
  'browser_scroll',
])

const EXACT_EXTRACTION_NEED_PATTERN =
  /\b(?:exact|wording|quote|verbatim|specific|precise|date|timing|pre[-\s]?order|availability|available|launch|release|announc(?:e|ed|ement)|price|pricing|deadline|starts?|begins?|ships?|on sale)\b/i

function contentTextForGuard(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function currentTaskTextForGuard(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): string {
  return [
    effectiveTaskRequest(messages),
    state.currentPlanItems?.[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
  ].filter(Boolean).join(' ')
}

function exactExtractionHints(text: string): string[] {
  const hints = new Set<string>()
  const lower = text.toLowerCase()
  if (/\bpre[-\s]?order/.test(lower)) hints.add('pre-order')
  if (/\bavailable|availability|on sale|ships?\b/.test(lower)) hints.add('available')
  if (/\blaunch|release|announc/.test(lower)) hints.add('launch')
  if (/\bprice|pricing|cost\b/.test(lower)) hints.add('price')
  if (/\bdate|timing|deadline|starts?|begins?\b/.test(lower)) hints.add('date')
  const quoted = [...text.matchAll(/["'“”‘’]([^"'“”‘’]{3,80})["'“”‘’]/g)]
    .map(match => match[1]?.trim())
    .filter((value): value is string => !!value)
    .slice(0, 2)
  for (const value of quoted) hints.add(value)
  return [...hints].slice(0, 5)
}

function shouldArmExactExtractionGuard(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): { shouldArm: boolean; prompt: string | null } {
  if (state.exactExtractionGuardPending || state.exactExtractionGuardAttempts >= 2) {
    return { shouldArm: false, prompt: null }
  }
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) {
    return { shouldArm: false, prompt: null }
  }

  const taskText = currentTaskTextForGuard(state, messages)
  if (!EXACT_EXTRACTION_NEED_PATTERN.test(taskText)) {
    return { shouldArm: false, prompt: null }
  }

  const source = toolResults.find(({ tc, result, isError }) => {
    if (isError || !EXACT_EXTRACTION_SOURCE_TOOLS.has(tc.name)) return false
    const resultText = contentTextForGuard(result)
    if (!resultText || /\b(?:captcha|access denied|blocked|not found|failed|error)\b/i.test(resultText)) return false
    return true
  })
  if (!source) return { shouldArm: false, prompt: null }

  const hints = exactExtractionHints(taskText)
  const hintText = hints.length > 0
    ? ` Search targeted rendered text first with browser_find_text using one of: ${hints.map(h => `"${h}"`).join(', ')}.`
    : ' Search targeted rendered text first with browser_find_text using the key phrase/date/label from the current step.'

  return {
    shouldArm: true,
    prompt: [
      'EXACT EXTRACTION REQUIRED BEFORE NARRATION: the current task/step needs precise wording, timing, date, availability, launch, or pricing evidence from the page you just opened/read.',
      'Do not write a progress update, uncertainty paragraph, synthesis, or <next_step/> yet.',
      `${hintText} If rendered text is incomplete or no text-node match appears, use browser_screenshot to visually read the relevant area, browser_scroll to reveal it, or browser_get_content to refresh the page text.`,
      'Make exactly one native tool call now using browser_find_text, browser_screenshot, browser_get_content, or browser_scroll. After that result, answer from the verified evidence or continue the phase.',
    ].join(' '),
  }
}

function updateExactExtractionGuardAfterTools(
  state: AgentStateData,
  toolResults: ToolExecutionResult[],
  messages: Array<{ role: string; content: string }>,
): void {
  const completedGuardExtraction = state.exactExtractionGuardPending &&
    toolResults.some(({ tc, isError }) => EXACT_EXTRACTION_TOOLS.has(tc.name) && !isError)

  if (completedGuardExtraction) {
    state.exactExtractionGuardPending = false
    state.exactExtractionGuardPrompt = null
    return
  }

  const nextGuard = shouldArmExactExtractionGuard(state, toolResults, messages)
  if (!nextGuard.shouldArm || !nextGuard.prompt) return

  state.exactExtractionGuardPending = true
  state.exactExtractionGuardPrompt = nextGuard.prompt
  state.exactExtractionGuardAttempts++
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
  state.visibleToolActionsSinceLastNarration = 0
}

async function deliverableContentForVerification(
  conversationId: string,
  result: ToolExecutionResult,
): Promise<{ path: string; content: string }> {
  let args: { path?: string; content?: string } = {}
  try {
    args = JSON.parse(result.tc.arguments) as { path?: string; content?: string }
  } catch {
    args = {}
  }

  const path = toolResultPath(result)
  let content = String(args.content || '')
  if (path && result.tc.name !== 'export_pdf') {
    try {
      const diskFile = await readFileInSandbox(conversationId, path)
      if (typeof diskFile.content === 'string' && !diskFile.content.startsWith('Error:')) {
        content = diskFile.content
      }
    } catch {
      // Fall back to the streamed tool argument content.
    }
  }
  return { path, content }
}

function publicAgentErrorMessage(error: unknown): string {
  if (isOutOfCreditsError(error)) return error.message || OUT_OF_CREDITS_MESSAGE
  const message = userErrorMessage(error, 'Unknown error')
  if (/assistant service|openrouter|qwen|gemini|model|provider|api key|env\.local|function\.arguments/i.test(message)) {
    if (/timed out|timeout/i.test(message)) return 'The task took too long to respond. Please try again.'
    if (/rate|429/i.test(message)) return 'The assistant is temporarily busy. Please try again shortly.'
    return 'The assistant could not complete the request. Please try again.'
  }
  return message
}

function redactAgentServiceText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/\b(?:qwen|openai|anthropic|google|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
    .replace(/openrouter/gi, 'assistant service')
}

function sanitizeAgentServiceError(error: unknown): Record<string, unknown> {
  const err = error as {
    name?: string
    status?: number
    body?: string
    message?: string
  }

  return {
    name: err?.name || (error instanceof Error ? error.name : 'Error'),
    status: err?.status,
    message: redactAgentServiceText(error instanceof Error ? error.message : String(error || 'Unknown error')),
    body: err?.body ? redactAgentServiceText(err.body).slice(0, 500) : undefined,
  }
}

function stepAdvanceStatusFor(state: AgentStateData, stepIdx: number): StepAdvanceStatus {
  const finding = state.stepFindings.get(stepIdx)
  return finding?.startsWith('[INCOMPLETE]') || finding?.startsWith('[BLOCKED]') ? 'incomplete' : 'done'
}

function liveDirectiveContextMessage(directives: LiveDirective[]): string {
  const directiveList = directives
    .map((directive, index) => {
      const receivedAt = new Date(directive.createdAt).toISOString()
      return `${index + 1}. Received ${receivedAt}: ${directive.content}`
    })
    .join('\n')

  return [
    'LIVE USER DIRECTIVE: The user sent the following instruction while this task was already running.',
    'Treat it as the newest user instruction for this same task. Apply it at the next safe action without restarting, stopping, or discarding completed work.',
    'If it changes source, browser, search, output, or plan constraints, obey it over earlier plan text and realign the current phase before using another tool.',
    'Do not execute stale tool calls that were selected before this directive if they now conflict with it.',
    '',
    directiveList,
  ].join('\n')
}

function agentRunRemainingMs(state: AgentStateData): number {
  return state.runStartedAtMs + AGENT_RUN_MAX_DURATION_MS - Date.now()
}

function shouldStartDeadlineFinalization(state: AgentStateData): boolean {
  if (state.deadlineFinalizationStarted) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false
  return agentRunRemainingMs(state) <= AGENT_DEADLINE_FINALIZATION_BUFFER_MS
}

function deadlineFinalizationMessage(state: AgentStateData): ChatMessageParam {
  const remainingSeconds = Math.max(0, Math.round(agentRunRemainingMs(state) / 1000))
  return {
    role: 'system',
    content: [
      `RUNTIME FINALIZATION DEADLINE: approximately ${remainingSeconds}s remain before the hosting platform can terminate this long task.`,
      'Stop starting new research, browsing, comparison branches, or optional verification.',
      'Use only the gathered work log, research activity, files, browser evidence, and current context to create the final user-facing result now.',
      'If a deliverable file is required and none is saved, make exactly one create_file call for the initial final output; use append_file only for essential continuation chunks.',
      'If the answer can be delivered inline, write the concise final answer now. Mention evidence gaps plainly instead of trying to fill them.',
    ].join(' '),
  } as ChatMessageParam
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface AgentLoopOptions {
  messages: Array<{
    role: string
    content: string
    attachments?: Array<{
      id?: string
      name: string
      type: string
      size: number
      content?: string
      contentEncoding?: 'text' | 'data-url'
      url?: string
      persisted?: boolean
      preview?: string
    }>
  }>
  model: string
  conversationId?: string
  customInstructions?: string
  startFreshSandbox?: boolean
  signal?: AbortSignal
  creditRunId?: string
  userId?: string
  skipStartupAcknowledgement?: boolean
  diagnostics?: (event: { type: string; data: Record<string, unknown> }) => void
}

// ── AgentLoop ───────────────────────────────────────────────────────────────

type Phase = 'PLANNING' | 'STREAMING' | 'EXECUTING_TOOLS' | 'EVALUATING' | 'COMPLETE' | 'ERROR'

const AUTOSAVE_DRAFT_MIN_CHARS = 1200
const SKILL_ATTACHMENT_TYPE = 'application/x-agent-skill'
const MAX_PLANNING_SKILL_CHARS = 18_000
const MAX_PLANNING_ATTACHMENT_CHARS = 12_000
const MAX_PRELOADED_ATTACHMENT_PANEL_CHARS = 5_000
const FRESH_TASK_CONTEXT_MESSAGES = 1
const CONTEXTUAL_TASK_CONTEXT_MESSAGES = 6
const HISTORICAL_CONTEXT_CHARS = 1200
type AgentAttachment = NonNullable<AgentLoopOptions['messages'][number]['attachments']>[number]
type ToolDefinitionLike = { function?: { name?: string } }
type ModelToolDefinition = ToolDefinitionLike & {
  function?: {
    name?: string
    parameters?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

const BROWSER_NONFINAL_RUNTIME_TOOLS = new Set([
  'browser_navigate',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_find_text',
  'browser_screenshot',
  'browser_get_content',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_press_key',
  'browser_go_back',
  'browser_action_sequence',
  'browser_click_and_hold',
  'browser_drag',
  'web_search',
  'read_document',
])

const BROWSER_STEP_START_RUNTIME_TOOLS = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_get_content',
  'browser_find_text',
  'web_search',
  'read_document',
])

const RESEARCH_FILE_WRITE_RUNTIME_TOOLS = new Set(['create_file', 'edit_file', 'append_file'])
const RESEARCH_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search'])
const FIXED_WEB_SEARCH_RUNTIME_TOOLS = new Set(['web_search'])
const BUILD_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search', 'browser_screenshot', 'browser_scroll', 'export_pdf', 'delete_file'])
const FINAL_OPTIONAL_RUNTIME_TOOLS = new Set(['image_search', 'browser_screenshot', 'browser_scroll', 'export_pdf', 'delete_file'])
const BROWSER_ADVANCED_POINTER_TOOLS = new Set(['browser_click_and_hold', 'browser_drag', 'browser_hover'])

function cleanDraftContent(content: string): string {
  return content
    .replace(/<next_step\s*\/?>/gi, '')
    .trim()
}

function slugifyDraftName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'draft'
}

function shouldAutosaveTextOnlyDraft(state: AgentStateData, content: string): boolean {
  const text = cleanDraftContent(content)
  if (text.length < AUTOSAVE_DRAFT_MIN_CHARS) return false
  if (!state.currentPlanItems || state.currentStepIdx >= state.currentPlanItems.length) return false

  const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
  if (isLastStep) return true

  return state.currentPhase === 'build' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
}

function autosaveDraftPath(state: AgentStateData): string {
  const title = state.currentPlanItems?.[state.currentStepIdx] || 'draft'
  const slug = slugifyDraftName(title)
  const isLastStep = !!state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1
  return isLastStep
    ? `deliverables/${slug}.md`
    : `drafts/step-${state.currentStepIdx + 1}-${slug}.md`
}

function shouldKeepAssistantInjection(content: string): boolean {
  const text = content.trim()
  if (!text) return false
  if (text.length >= 240) return true
  return /```|^#{1,6}\s|^\s*[-*]\s+\S/m.test(text)
}

function containsFalseCapabilityRefusal(content: string): boolean {
  return /(?:i (?:cannot|can't|am unable to|am not able to).{0,120}(?:access|browse|interact|perform|retrieve|search|images?|photos?|pictures?)|i can only provide text[- ]based information|please use (?:a )?(?:search engine|google images|bing images))/i.test(content)
}

function compactHistoricalAgentMessage(message: AgentLoopOptions['messages'][number], isLatest: boolean): AgentLoopOptions['messages'][number] {
  if (isLatest) return message
  const content = message.content.length > HISTORICAL_CONTEXT_CHARS
    ? `${message.content.slice(0, HISTORICAL_CONTEXT_CHARS)}\n...[historical message compacted]`
    : message.content
  return {
    ...message,
    content,
    attachments: undefined,
  }
}

function scopedMessagesForAgentTask(messages: AgentLoopOptions['messages']): AgentLoopOptions['messages'] {
  const latestUserIndex = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && message.content.trim())
    .at(-1)?.index ?? messages.length - 1

  if (!isContextualTaskUpdate(messages)) {
    return messages.slice(Math.max(0, latestUserIndex)).slice(-FRESH_TASK_CONTEXT_MESSAGES)
  }

  const recent = messages.slice(Math.max(0, messages.length - CONTEXTUAL_TASK_CONTEXT_MESSAGES))
  const lastIndex = recent.length - 1
  return recent.map((message, index) => compactHistoricalAgentMessage(message, index === lastIndex))
}

function taskWantsImageArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return /\b(image|images|photo|photos|picture|pictures|asset|assets|retrieve|return|download)\b/i.test(`${currentToolIntentText(state)} ${userText}`)
}

function taskWantsPdfArtifact(
  state: AgentStateData,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' ')
  return /\b(?:pdf|export)\b/i.test(`${currentToolIntentText(state)} ${userText}`)
}

function isLeanFinalSynthesisStep(state: AgentStateData): boolean {
  return !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx === state.currentPlanItems.length - 1 &&
    state.currentPhase === 'deliver' &&
    (state.taskStrategy === 'research' || state.taskStrategy === 'analysis' || state.taskStrategy === 'general') &&
    !state.buildTask
}

function isNonFinalBrowserStep(state: AgentStateData): boolean {
  return state.taskStrategy === 'browse' &&
    !!state.currentPlanItems &&
    state.currentPlanItems.length > 0 &&
    state.currentStepIdx < state.currentPlanItems.length - 1
}

function shouldInjectResearchActivityContext(state: AgentStateData): boolean {
  if (state.forceTextNextIteration) return false
  if (!state.currentPlanItems || state.currentPlanItems.length === 0) return false
  if (state.currentStepIdx >= state.currentPlanItems.length) return false
  if (state.currentPhase === 'research') return true
  return isNonFinalBrowserStep(state)
}

function filterToolDefinitions(
  tools: ToolDefinitionLike[],
  allowed: Set<string>,
): ToolDefinitionLike[] {
  return tools.filter(tool => {
    const name = tool.function?.name || ''
    return allowed.has(name)
  })
}

function compactToolDefinitionsForModel(tools: ToolDefinitionLike[]): ToolDefinitionLike[] {
  return tools.map((tool) => {
    const modelTool = tool as ModelToolDefinition
    const parameters = modelTool.function?.parameters
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return tool
    const schema = parameters as { properties?: Record<string, unknown>; [key: string]: unknown }
    if (!schema.properties?.action_label && !schema.properties?.plan_step_index) return tool

    const compactProperties = { ...schema.properties }
    for (const key of ['action_label', 'plan_step_index'] as const) {
      const prop = compactProperties[key]
      if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue
      const { description: _description, ...rest } = prop as Record<string, unknown>
      compactProperties[key] = rest
    }

    return {
      ...modelTool,
      function: {
        ...modelTool.function,
        parameters: {
          ...schema,
          properties: compactProperties,
        },
      },
    } as ToolDefinitionLike
  })
}

function researchStepAllowsSupportFileTools(state: AgentStateData): boolean {
  if (state.currentPhase !== 'research') return true
  const stepText = state.currentPlanItems?.[state.currentStepIdx] || ''
  const scopeText = state.currentPlanScopes?.[state.currentStepIdx] || ''
  const text = [
    state.originalUserRequest || '',
    stepText,
    scopeText,
    state.stepMicroPlan || '',
  ].join('\n')
  return /\b(?:research[- ]?notes?|phase[- ]?notes?|notes?\.md|markdown notes?|save (?:the )?(?:notes?|findings)|write (?:the )?(?:notes?|findings)|create (?:a )?(?:notes?|markdown|\.md)|todo\.md|checklist|tracking file|progress file)\b/i.test(text)
}

function researchStepAllowsImageSearch(state: AgentStateData): boolean {
  if (state.currentPhase !== 'research') return true
  return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|return|download|real one|use real|logo|logos|icon|icons|illustration|illustrations)\b/i.test(currentToolIntentText(state))
}

function currentToolIntentText(state: AgentStateData): string {
  return [
    state.originalUserRequest || '',
    state.currentPlanItems?.[state.currentStepIdx] || '',
    state.currentPlanScopes?.[state.currentStepIdx] || '',
    state.stepMicroPlan || '',
  ].join('\n')
}

function shouldIncludeTemporalContextForTurn(state: AgentStateData): boolean {
  if (state.forceTextNextIteration) return false
  if (state.taskStrategy === 'research' || state.taskStrategy === 'browse' || state.taskStrategy === 'analysis') return true
  return /\b(?:today|tomorrow|yesterday|latest|recent|up[-\s]?to[-\s]?date|date|time|timezone|time\s*zone|as of|current\s+(?:date|time|weather|news|price|score|schedule|status|version))\b/i.test(currentToolIntentText(state))
}

function browserStepAllowsAdvancedPointerTools(state: AgentStateData): boolean {
  if (state.browserRecoveryRequired || state.stepFailureCount >= 2) return true
  return /\b(?:drag|drop|drag[- ]?and[- ]?drop|click[- ]?and[- ]?hold|click hold|long[- ]?press|hold|hover|tooltip|flyout|sub[- ]?menu|menu|mega[- ]?menu|slider|range input|resize handle|reorder|sort|move item|move card|move marker|pan map|canvas|drawing|scrub|swipe)\b/i.test(currentToolIntentText(state))
}

function browserStepAllowsDocumentTool(state: AgentStateData): boolean {
  if (state.browserRecoveryRequired || state.stepFailureCount >= 2) return true
  return /\b(?:pdf|document|docx?|paper|report|manual|whitepaper|file|download|transcript|terms|policy)\b/i.test(currentToolIntentText(state))
}

function buildStepAllowsOptionalTool(state: AgentStateData, toolName: string): boolean {
  if (state.currentPhase !== 'build') return true
  const text = currentToolIntentText(state)
  if (toolName === 'image_search') {
    return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|download|real one|use real)\b/i.test(text)
  }
  if (toolName === 'browser_screenshot' || toolName === 'browser_scroll') {
    return state.websiteBrowserCheckAttempted ||
      state.websiteBrowserCheckDone ||
      state.websiteResponsiveCheckPrompted ||
      state.nextWebsitePreviewAttempted ||
      state.nextWebsitePreviewDone ||
      /\b(?:preview|visual|inspect|browser|screenshot|scroll|render|responsive|viewport|local site|local preview|qa|quality check|verify)\b/i.test(text)
  }
  if (toolName === 'export_pdf') {
    return /\b(?:pdf|export)\b/i.test(text)
  }
  if (toolName === 'delete_file') {
    return /\b(?:delete|remove|cleanup|clean up|discard)\b/i.test(text)
  }
  return true
}

function finalStepAllowsOptionalTool(state: AgentStateData, toolName: string): boolean {
  if (state.currentPhase !== 'deliver') return true
  const text = currentToolIntentText(state)
  if (toolName === 'image_search') {
    return /\b(?:image|images|photo|photos|picture|pictures|asset|assets|retrieve|download|real one|use real)\b/i.test(text)
  }
  if (toolName === 'browser_screenshot' || toolName === 'browser_scroll') {
    return state.taskStrategy === 'browse' ||
      state.websiteBrowserCheckAttempted ||
      state.websiteBrowserCheckDone ||
      state.websiteResponsiveCheckPrompted ||
      state.nextWebsitePreviewAttempted ||
      state.nextWebsitePreviewDone ||
      /\b(?:preview|visual|inspect|browser|screenshot|scroll|render|responsive|viewport|local site|local preview|qa|quality check|verify)\b/i.test(text)
  }
  if (toolName === 'export_pdf') {
    return /\b(?:pdf|export)\b/i.test(text)
  }
  if (toolName === 'delete_file') {
    return /\b(?:delete|remove|cleanup|clean up|discard)\b/i.test(text)
  }
  return true
}

function pruneToolsForCurrentStep(state: AgentStateData, tools: ToolDefinitionLike[]): ToolDefinitionLike[] {
  if (isNonFinalBrowserStep(state)) {
    if (state.stepToolCallCount === 0 && !state.browserRecoveryRequired) {
      const startTools = filterToolDefinitions(tools, BROWSER_STEP_START_RUNTIME_TOOLS)
      return browserStepAllowsDocumentTool(state)
        ? startTools
        : startTools.filter(tool => tool.function?.name !== 'read_document')
    }
    const browserTools = filterToolDefinitions(tools, BROWSER_NONFINAL_RUNTIME_TOOLS)
    const toolsWithoutColdDocument = browserStepAllowsDocumentTool(state)
      ? browserTools
      : browserTools.filter(tool => tool.function?.name !== 'read_document')
    if (browserStepAllowsAdvancedPointerTools(state)) return toolsWithoutColdDocument
    return browserTools.filter(tool => {
      const name = tool.function?.name || ''
      return !BROWSER_ADVANCED_POINTER_TOOLS.has(name) && (name !== 'read_document' || browserStepAllowsDocumentTool(state))
    })
  }
  if (state.currentPhase === 'research') {
    if (explicitWebSearchLimitFromText(state.originalUserRequest || '') !== null) {
      return filterToolDefinitions(tools, FIXED_WEB_SEARCH_RUNTIME_TOOLS)
    }
    const allowSupportFiles = researchStepAllowsSupportFileTools(state)
    const allowImageSearch = researchStepAllowsImageSearch(state)
    return tools.filter(tool => {
      const name = tool.function?.name || ''
      if (!allowSupportFiles && RESEARCH_FILE_WRITE_RUNTIME_TOOLS.has(name)) return false
      if (!allowImageSearch && RESEARCH_OPTIONAL_RUNTIME_TOOLS.has(name)) return false
      return true
    })
  }
  if (state.currentPhase === 'build') {
    return tools.filter(tool => {
      const name = tool.function?.name || ''
      return !BUILD_OPTIONAL_RUNTIME_TOOLS.has(name) || buildStepAllowsOptionalTool(state, name)
    })
  }
  if (state.currentPhase === 'deliver') {
    return tools.filter(tool => {
      const name = tool.function?.name || ''
      return !FINAL_OPTIONAL_RUNTIME_TOOLS.has(name) || finalStepAllowsOptionalTool(state, name)
    })
  }
  return tools
}

function selectedSkillAttachments(messages: AgentLoopOptions['messages']): Array<{ name: string; content: string }> {
  return messages.flatMap((message) =>
    (message.attachments || [])
      .filter((attachment) => attachment.type === SKILL_ATTACHMENT_TYPE && attachment.content)
      .map((attachment) => ({
        name: attachment.name.replace(/\.skill$/i, ''),
        content: attachment.content || '',
      }))
  )
}

function uploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return messages.flatMap((message) =>
    (message.attachments || []).filter((attachment) => attachment.type !== SKILL_ATTACHMENT_TYPE)
  )
}

function isReadableAttachmentContent(attachment: AgentAttachment): boolean {
  return !!attachment.content &&
    !attachment.type.startsWith('image/') &&
    attachment.contentEncoding !== 'data-url'
}

function readableUploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return uploadedAttachments(messages).filter(isReadableAttachmentContent)
}

function visualImageUploadedAttachments(messages: AgentLoopOptions['messages']): AgentAttachment[] {
  return uploadedAttachments(messages).filter((attachment) =>
    attachment.type.startsWith('image/') && !!attachment.content
  )
}

function uploadedAttachmentNames(messages: AgentLoopOptions['messages']): string[] {
  return [...new Set(uploadedAttachments(messages).map((attachment) => attachment.name).filter(Boolean))]
}

function describeAttachmentForContext(attachment: AgentAttachment): string {
  const size = attachment.size > 0 ? `, ${Math.round(attachment.size / 1024)} KB` : ''
  if (attachment.type.startsWith('image/')) return `Image: ${attachment.name} (${attachment.type}${size})`
  if (attachment.type === SKILL_ATTACHMENT_TYPE) return `Selected skill file: ${attachment.name}${size ? ` (${Math.round(attachment.size / 1024)} KB)` : ''}`
  return `Attached file: ${attachment.name} (${attachment.type || 'unknown type'}${size})`
}

function attachmentSummaryForContext(message: AgentLoopOptions['messages'][number], includeSkills = false): string {
  const attachments = (message.attachments || []).filter((attachment) =>
    includeSkills || attachment.type !== SKILL_ATTACHMENT_TYPE
  )
  if (attachments.length === 0) return ''

  return [
    'ATTACHMENTS PROVIDED BY THE USER:',
    ...attachments.map((attachment) => `- ${describeAttachmentForContext(attachment)}`),
  ].join('\n')
}

function attachmentContextForPlanning(message: AgentLoopOptions['messages'][number]): string {
  const attachments = (message.attachments || []).filter((attachment) => attachment.type !== SKILL_ATTACHMENT_TYPE)
  if (attachments.length === 0) return ''

  const sections = [
    'UPLOADED ATTACHMENT HANDLING:',
    'These files came from the user upload UI, not the public web. If the user asks about them, plan from the uploaded attachment context first.',
    'Do not plan web_search for an uploaded filename/title. Do not plan read_file/open-local-path steps for uploaded attachments; read_file is only for files created in the task workspace.',
    'Use web/browsing only if the user explicitly asks for outside/current information beyond the attachment.',
  ]

  for (const attachment of attachments) {
    sections.push(`- ${describeAttachmentForContext(attachment)}`)
    if (isReadableAttachmentContent(attachment)) {
      const content = attachment.content || ''
      const excerpt = content.length > MAX_PLANNING_ATTACHMENT_CHARS
        ? `${content.slice(0, MAX_PLANNING_ATTACHMENT_CHARS)}\n... [truncated from ${content.length} characters]`
        : content
      sections.push(`--- Uploaded attachment text: ${attachment.name} ---\n${excerpt}\n--- End uploaded attachment text: ${attachment.name} ---`)
    } else if (attachment.type.startsWith('image/')) {
      sections.push([
        `Image attachment ${attachment.name} is already available as high-detail visual input at runtime.`,
        'For image questions, inspect the uploaded image directly from the visual input.',
        'Do not create browser/open/current-view/extract-text/read_file/web_search steps for the uploaded image filename.',
      ].join(' '))
    } else {
      sections.push(`No extracted text is currently loaded for ${attachment.name}. If runtime still lacks content, report that this uploaded file could not be read instead of searching the web for the filename.`)
    }
  }

  return sections.join('\n')
}

function buildPlanningMessages(messages: AgentLoopOptions['messages']): Array<{ role: string; content: string }> {
  const planningMessages = messages.map((message) => {
    const skills = (message.attachments || [])
      .filter((attachment) => attachment.type === SKILL_ATTACHMENT_TYPE && attachment.content)
    const attachmentSummary = attachmentSummaryForContext(message)
    const uploadedAttachmentContext = attachmentContextForPlanning(message)

    if (skills.length === 0 && !attachmentSummary && !uploadedAttachmentContext) {
      return { role: message.role, content: message.content }
    }

    const skillContext = skills.map((skill) => {
      const content = skill.content || ''
      const truncated = content.length > MAX_PLANNING_SKILL_CHARS
        ? `${content.slice(0, MAX_PLANNING_SKILL_CHARS)}\n... [truncated from ${content.length} characters]`
        : content
      return `--- Selected skill file: ${skill.name} ---\n${truncated}\n--- End selected skill file: ${skill.name} ---`
    }).join('\n\n')

    return {
      role: message.role,
      content: [
        message.content,
        attachmentSummary,
        uploadedAttachmentContext,
        skills.length > 0
          ? `SELECTED SKILL FILES LOADED BEFORE PLANNING:\n${skillContext}\n\nPlanner requirement: include and respect a first step that reads and applies these selected skill files before any research, browsing, coding, or writing.`
          : '',
      ].filter(Boolean).join('\n\n'),
    }
  })

  if (isContextualTaskUpdate(messages)) {
    planningMessages.push({
      role: 'system',
      content: `The latest user message is an interruption/correction to the previous task. Plan for the combined effective request below, and treat the correction as a hard constraint:\n\n${effectiveTaskRequest(messages)}`,
    })
  }

  return planningMessages
}

function requiredAttachmentPlanSteps(messages: AgentLoopOptions['messages']): RequiredPlanStep[] {
  const attachments = uploadedAttachments(messages)
  if (attachments.length === 0) return []

  const names = uploadedAttachmentNames(messages)
  const readableName = names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '')
  const firstReadable = readableUploadedAttachments(messages)[0]
  const hasVisualImages = visualImageUploadedAttachments(messages).length > 0
  const contentPreview = firstReadable?.content
    ? firstReadable.content.slice(0, MAX_PRELOADED_ATTACHMENT_PANEL_CHARS)
    : hasVisualImages
      ? 'Uploaded image visual content is available as high-detail model input. No browser opening, current-view extraction, or filename search is required.'
      : 'Uploaded attachment metadata was loaded, but no extracted text was available in context.'
  const titlePrefix = hasVisualImages
    ? `Visually inspect uploaded image${names.length === 1 ? '' : 's'}`
    : `Read uploaded attachment${names.length === 1 ? '' : 's'}`
  const scope = hasVisualImages
    ? 'Runtime preflight only: uploaded image bytes are already loaded as high-detail visual input in the model context. Inspect the attached image directly from that visual input. Do not plan browser/open/current-view/extract-text/read_file/web_search steps for the image filename. Use web/browsing only if the user explicitly asks for outside/current information beyond the image.'
    : 'Runtime preflight only: uploaded attachment content is loaded from the message/server and must be used as the source context. Do not web_search uploaded filenames. Do not use read_file for uploaded attachment names.'

  return [{
    title: `${titlePrefix}: ${readableName || 'provided file'}`,
    scope,
    preloaded: true,
    kind: 'attachment',
    label: readableName || 'uploaded attachment',
    contentPreview,
    visualInput: hasVisualImages,
  }]
}

function requiredSkillPlanSteps(messages: AgentLoopOptions['messages']): RequiredPlanStep[] {
  const skills = selectedSkillAttachments(messages)
  if (skills.length === 0) return []

  const names = [...new Set(skills.map((skill) => skill.name || 'selected skill'))]
  const readableNames = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')

  return [{
    title: `Read selected skill file${names.length === 1 ? '' : 's'}: ${readableNames}`,
    scope: 'Runtime preflight only: selected skill attachment content is loaded into context and must be understood before any research, browsing, coding, or writing. Do not use external tools in this step.',
    preloaded: true,
    kind: 'skill',
    label: readableNames,
  }]
}

export type AgentContextMessage = {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>
}

export function preprocessMessagesForAgentContext(messages: AgentLoopOptions['messages']): AgentContextMessage[] {
  return messages.map(m => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content }
    }

    const imageAttachments = m.attachments.filter(a => a.type.startsWith('image/') && a.content)
    const textAttachments = m.attachments.filter(a =>
      !a.type.startsWith('image/') &&
      a.content &&
      a.contentEncoding !== 'data-url'
    )

    let textContent = m.content
    let remainingAttachmentChars = MAX_CONTEXT_ATTACHMENT_CHARS
    for (const att of textAttachments) {
      if (!att.content) continue
      const isSkill = att.type === SKILL_ATTACHMENT_TYPE
      const isExpandedArchive = att.type === 'application/vnd.agent.archive-text'
      if (remainingAttachmentChars <= 0) {
        textContent += `\n\n--- Attached file: ${att.name} ---\n[omitted: attachment context budget reached]\n--- End of ${att.name} ---`
        continue
      }
      const maxChars = Math.min(
        remainingAttachmentChars,
        isSkill || isExpandedArchive ? MAX_CONTEXT_ATTACHMENT_CHARS : MAX_ATTACHMENT_CHARS,
      )
      const label = isSkill ? 'Selected skill' : isExpandedArchive ? 'Extracted archive' : 'Attached file'
      const instruction = isSkill
        ? '\nRead this skill first and apply the relevant instructions before continuing.'
        : ''
      const truncated = att.content.length > maxChars
        ? att.content.slice(0, maxChars) + `\n... [truncated from ${att.content.length} characters]`
        : att.content
      remainingAttachmentChars -= Math.min(att.content.length, maxChars)
      textContent += `\n\n--- ${label}: ${att.name} ---${instruction}\n${truncated}\n--- End of ${att.name} ---`
    }

    if (imageAttachments.length > 0) {
      textContent += `\n\n${attachmentSummaryForContext(m, false)}\nUse the attached image content below as visual input; do not claim the image was unavailable.`
      const parts: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [
        { type: 'text', text: textContent },
      ]
      for (const att of imageAttachments) {
        parts.push({
          type: 'image_url',
          image_url: { url: att.content!, detail: 'high' },
        })
      }
      return { role: m.role, content: parts }
    }

    return { role: m.role, content: textContent }
  })
}

function normalizedCreatedFileSet(createdFiles: Iterable<string>): Set<string> {
  return new Set([...createdFiles].map(p => p.replace(/^\.?\//, '').toLowerCase()))
}

function createdFileWebsiteProblems(createdFiles: Iterable<string>): { missingFiles: string[]; structureIssues: string[] } {
  const created = normalizedCreatedFileSet(createdFiles)
  const hasPage = created.has('app/page.tsx') || created.has('src/app/page.tsx')
  const hasLayout = created.has('app/layout.tsx') || created.has('src/app/layout.tsx')
  const hasStyles = created.has('app/globals.css') || created.has('src/app/globals.css') || created.has('styles/globals.css')
  const hasComponent = [...created].some(p =>
    /^(src\/)?components\/.+\.(?:tsx|jsx)$/.test(p) ||
    /^(src\/)?app\/components\/.+\.(?:tsx|jsx)$/.test(p)
  )

  return {
    missingFiles: [
      hasPage ? '' : 'app/page.tsx',
      hasLayout ? '' : 'app/layout.tsx',
      hasStyles ? '' : 'app/globals.css',
    ].filter(Boolean),
    structureIssues: hasComponent
      ? []
      : ['Create at least one reusable TSX component under components/ or app/components/ and render it from page.tsx.'],
  }
}

async function getNextWebsiteCompletionProblems(
  conversationId: string | undefined,
  createdFiles: Iterable<string>,
): Promise<{ missingFiles: string[]; structureIssues: string[] }> {
  if (!conversationId) return createdFileWebsiteProblems(createdFiles)

  const status = await getNextWebsiteProjectStatus(conversationId)
  return {
    missingFiles: status.missingFiles,
    structureIssues: status.ready ? status.structureIssues : [],
  }
}

async function getNextWebsiteCompletionBlocker(
  conversationId: string | undefined,
  state: AgentStateData,
  originalRequest: string,
): Promise<string | null> {
  if (!shouldDefaultFrontendToNextTsx(originalRequest)) return null

  const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
  if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
    const details = [
      websiteProblems.missingFiles.length > 0
        ? `Missing required file(s): ${websiteProblems.missingFiles.join(', ')}.`
        : '',
      websiteProblems.structureIssues.length > 0
        ? `Structure/style issue(s): ${websiteProblems.structureIssues.join(' ')}`
        : '',
    ].filter(Boolean).join(' ')

    return `WEBSITE COMPLETION BLOCKED: The requested website is not a complete renderable Next.js/TSX build. ${details} Create or edit the actual website files now: app/page.tsx, app/layout.tsx importing './globals.css', app/globals.css, and at least one imported reusable component under components/ or app/components/. Do not finish after only package/config/layout files.`
  }

  if (!state.nextWebsitePreviewDone) {
    const previewProblem = state.nextWebsitePreviewError
      ? ` Last preview error: ${state.nextWebsitePreviewError}`
      : state.nextWebsitePreviewAttempted
        ? ' The preview was attempted but did not open successfully.'
        : ' The local TSX preview has not run yet.'

    return `WEBSITE COMPLETION BLOCKED: The Next.js/TSX website has not successfully built and opened in the Computer browser.${previewProblem} Fix the generated frontend files or make a targeted frontend edit so the backend rebuilds and opens the local preview.`
  }

  if (!state.websiteResponsiveCheckDone) {
    return `WEBSITE COMPLETION BLOCKED: The local website preview opened, but the required visual check has not passed. Use browser_screenshot or browser_scroll on the managed local preview at the existing browser size, then fix visual issues or finish only after the visual check succeeds.`
  }

  return null
}

function maxTokensForIteration(state: AgentStateData): number {
  if (state.forceTextNextIteration) return 96
  if (state.deadlineFinalizationStarted) return 4096
  if (state.currentPhase === 'deliver') {
    if (state.taskStrategy === 'creative') return 10_240
    if (state.taskStrategy === 'build' || state.taskStrategy === 'code') return 6144
    if (state.taskStrategy === 'research' || state.taskStrategy === 'analysis') {
      return state.taskComplexity >= 3 ? 6144 : 4096
    }
    return 4096
  }
  if (state.taskStrategy === 'browse') return 1280
  if (state.currentPhase === 'build') return state.taskStrategy === 'creative' ? 8192 : 3072
  if (state.taskStrategy === 'research' || state.taskStrategy === 'analysis') {
    return state.taskComplexity >= 3 ? 2048 : state.taskComplexity >= 2 ? 1792 : 1024
  }
  return state.taskComplexity >= 2 ? 1536 : 768
}

function shouldForceAgenticToolCall(state: AgentStateData, hasActivePlanStep: boolean): boolean {
  if (!hasActivePlanStep || state.currentPhase === 'deliver') return false
  if (state.taskStrategy === 'browse') return true

  const agenticStep =
    state.taskStrategy === 'research' ||
    state.taskStrategy === 'analysis' ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.currentPhase === 'research' ||
    state.currentPhase === 'build'
  if (!agenticStep) return false

  const complexity = state.taskComplexity as 1 | 2 | 3
  const requiredCalls = state.currentPhase === 'research' || state.taskStrategy === 'research' || state.taskStrategy === 'analysis'
    ? (MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ?? MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 2)
    : (MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 2)
  const earlyToolFloor = Math.min(requiredCalls, state.taskComplexity >= 3 ? 2 : 1)

  return state.stepToolCallCount < earlyToolFloor
}

function messageText(content: ChatMessageParam['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => part.text || '').filter(Boolean).join('\n')
  return ''
}

function latestUserMessageText(messages: ChatMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const text = messageText(messages[i].content)
      if (text.trim()) return text.trim().slice(0, 700)
    }
  }
  return ''
}

function compactForcedNarrationMessages(state: AgentStateData, allMessages: ChatMessageParam[]): ChatMessageParam[] {
  const currentStep = state.currentPlanItems?.[state.currentStepIdx] || 'current step'
  const currentScope = state.currentPlanScopes?.[state.currentStepIdx]
  const recentActions = state.workLog
    .slice(-6)
    .map(entry => entry.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean)
  const recentFindings = [...state.stepFindings.entries()]
    .slice(-3)
    .map(([idx, finding]) => `Step ${idx + 1}: ${finding}`)
  const browserEvidence = state.browserTaskCompletionEvidence.slice(-3)
  const visualObservations = state.workLedger.visualObservations
    .slice(-3)
    .map(item => `${item.title || item.url || item.tool}: ${item.detail}`)

  const context = [
    `User request: ${state.originalUserRequest || latestUserMessageText(allMessages) || 'not available'}`,
    `Active phase: ${state.currentStepIdx + 1}/${state.currentPlanItems?.length || 1} - ${currentStep}`,
    currentScope ? `Phase scope: ${currentScope}` : '',
    recentActions.length ? `Recent visible work:\n- ${recentActions.join('\n- ')}` : '',
    recentFindings.length ? `Recent findings:\n- ${recentFindings.join('\n- ')}` : '',
    browserEvidence.length ? `Browser completion evidence:\n- ${browserEvidence.join('\n- ')}` : '',
    visualObservations.length ? `Recent browser/page observations:\n- ${visualObservations.join('\n- ')}` : '',
  ].filter(Boolean).join('\n\n')

  return [
    {
      role: 'system',
      content: 'FAST PROGRESS NARRATION ONLY. Do not solve, plan, browse, search, write files, or call tools. Write one natural Manus-style progress paragraph from the compact context only. This applies to the current phase regardless of task type. Use 1-2 complete sentences, 15-20 words preferred, hard cap 34 words / 240 characters. Be result-first and concrete. Vary the opening verb and sentence shape; do not repeat the same starter pattern. No internal step numbers, no vague "sufficient evidence", no command fragments, no source dump.',
    },
    {
      role: 'user',
      content: context || 'Write a concise progress update from the recent completed work.',
    },
  ]
}

function toolJsonRecoveryMessage(state: AgentStateData): string {
  if (state.taskStrategy === 'browse') {
    return [
      'TOOL FORMAT RECOVERY: The previous assistant response was rejected before streaming because the browser tool call format or forced tool-call mode was not accepted.',
      'Do not expose this provider/runtime issue to the user.',
      'Retry the current browser step with exactly one native browser tool call using strict JSON object arguments. Do not write a progress update, do not emit <next_step/>, and do not report success unless the live browser state proves this exact step is done.',
      'Use the current page state: browser_screenshot, browser_click_at, browser_type, browser_scroll, browser_find_text, browser_press_key, browser_select, or browser_get_content. If the page is a concrete hard blocker, verify it with browser_screenshot or browser_get_content before reporting.',
      'Never write raw XML-like tool markup such as <toolcall> or <function=...>.',
    ].filter(Boolean).join(' ')
  }

  return [
    'TOOL FORMAT RECOVERY: The previous assistant response was rejected before streaming because the tool-call format or forced tool-call mode was not accepted.',
    'Do not expose this provider/runtime issue to the user.',
    'For this recovery turn, write one concise progress update from evidence already gathered if any exists, then stop.',
    'On the following turn, continue with exactly one native tool call using strict JSON object arguments, or finish directly if the user only needed a direct answer.',
    'If the current browser page is blocked by CAPTCHA, Cloudflare, human verification, access denial, or a hard error, do not click it and do not retry the same URL. Switch to a different credible source, a same-site search result, or synthesize from existing evidence.',
    'Never write raw XML-like tool markup such as <toolcall> or <function=...>.',
  ].filter(Boolean).join(' ')
}

function providerToolModeRecoveryMessage(state: AgentStateData): string {
  const step = state.currentPlanItems?.[state.currentStepIdx] || 'the current task phase'
  const preferredTool = state.taskStrategy === 'browse'
    ? 'a browser tool such as browser_screenshot, browser_get_content, browser_click_at, browser_type, browser_scroll, or browser_find_text'
    : state.currentPhase === 'research' || state.taskStrategy === 'research' || state.taskStrategy === 'analysis'
      ? 'web_search, browser_navigate, browser_get_content, read_document, or image_search if visual evidence is needed'
      : 'the single most useful available tool'

  return [
    'PROVIDER TOOL-CALL RECOVERY: The previous attempt was rejected before streaming because forced tool-call mode was not accepted by this model route.',
    'Do not expose this provider/runtime issue to the user.',
    `Continue "${step}" now. Make exactly one native tool call voluntarily using strict JSON object arguments.`,
    `Use ${preferredTool}.`,
    'Do not answer from memory, do not emit <next_step/>, do not write raw XML-like tool markup, and do not stop unless the requested work is already complete from existing evidence.',
  ].join(' ')
}

export class AgentLoop {
  private emitter: AgentEventEmitter
  private options: AgentLoopOptions

  constructor(emitter: AgentEventEmitter, options: AgentLoopOptions) {
    this.emitter = emitter
    this.options = options
  }

  private async recoverTextOnlyDraft(
    state: AgentStateData,
    assistantContent: string,
    contextManager: ContextManager,
    planManager: PlanManager,
    workingMemory: WorkingMemory,
    goalTracker: GoalTracker,
  ): Promise<Phase | null> {
    const { conversationId } = this.options
    if (!conversationId || !shouldAutosaveTextOnlyDraft(state, assistantContent)) return null

    const content = cleanDraftContent(assistantContent)
    const path = autosaveDraftPath(state)
    const id = `autosave_${state.iterations}_${state.currentStepIdx}`
    const isLastStep = !!state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1

    const previewContent = content.length > 5000
      ? content.slice(0, 5000) + '\n\n...[autosaved draft continues in the saved file]'
      : content
    this.emitter.toolStart(id, 'create_file', { path, content: previewContent })
    const result = await createFileInSandbox(conversationId, path, content)
    this.emitter.toolResult(id, 'create_file', result as never)

    if (result.size === undefined) {
      contextManager.push({
        role: 'system',
        content: `The draft text was not saved because create_file failed for ${path}. Retry with a shorter create_file call or a safer path.`,
      } as ChatMessageParam)
      return null
    }

    state.createdFiles.add(path)
    trackFileCreate(state, path)
    recordWorkLedgerDeliverable(state, { path, purpose: isLastStep ? 'deliverable' : 'support' })
    logWork(state, `Autosaved text-only draft: ${path}`)
    workingMemory.recordFileCreated(path, state.currentStepIdx)

    contextManager.push({
      role: 'system',
      content: `RECOVERY SAVE: Your previous text-only draft was saved to ${path}. Do NOT rewrite it from scratch. Continue from this saved file; use append_file for additional chunks and edit_file only for targeted revisions.`,
    } as ChatMessageParam)

    if (isLastStep && state.currentPlanItems) {
      const stepIdxBefore = state.currentStepIdx
      state.deliverableVerificationDone = true
      state.currentStepIdx = state.currentPlanItems.length
      for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
        this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
      }
      this.emitter.artifactCreated({
        id: `artifact_${id}`,
        fileName: path.split('/').pop() || path,
        filePath: path,
        content: content.length > 20_000
          ? content.slice(0, 20_000) + '\n\n---\n*Content truncated for preview. Open the file for the full saved draft.*'
          : content,
        type: 'document',
        deliverable: true,
        createdAt: Date.now(),
      })
      return 'COMPLETE'
    }

    const stepIdxBefore = state.currentStepIdx
    const advanceMsg = planManager.handleStepAdvance(state)
    if (advanceMsg) {
      contextManager.push(advanceMsg as ChatMessageParam)
    }
    if (goalTracker.isInitialized()) {
      goalTracker.advanceToStep(state.currentStepIdx)
    }
    for (let i = stepIdxBefore; i < state.currentStepIdx; i++) {
      this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
    }
    return 'STREAMING'
  }

  private maybeStartDeadlineFinalization(
    state: AgentStateData,
    contextManager: ContextManager,
    planManager: PlanManager,
    goalTracker: GoalTracker,
  ): boolean {
    if (!shouldStartDeadlineFinalization(state)) return false

    state.deadlineFinalizationStarted = true
    state.forceTextNextIteration = false
    state.forcedNarrationRepairAttempts = 0

    let lastStepMessage: { role: string; content: string } | null = null
    if (state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length - 1) {
      while (state.currentStepIdx < state.currentPlanItems.length - 1) {
        const stepIdxBefore = state.currentStepIdx
        lastStepMessage = planManager.handleStepAdvance(state)
        this.emitter.stepAdvance(stepAdvanceStatusFor(state, stepIdxBefore))
      }
      if (goalTracker.isInitialized()) {
        goalTracker.advanceToStep(state.currentStepIdx)
      }
      contextManager.compactForStepTransition(state)
    }

    if (lastStepMessage) {
      contextManager.push(lastStepMessage as ChatMessageParam)
    }
    contextManager.push(deadlineFinalizationMessage(state))
    console.log('[AgentDiagnostics] Runtime deadline finalization started', {
      iteration: state.iterations,
      step: state.currentStepIdx,
      totalSteps: state.currentPlanItems?.length || 0,
      remainingMs: agentRunRemainingMs(state),
      elapsedMs: Date.now() - state.runStartedAtMs,
    })
    return true
  }

  async run(): Promise<void> {
    const { messages, model, conversationId, customInstructions, signal } = this.options

    // ── Security: Prompt Injection Check ───────────────────────────────

    const latestUserMessage = [...messages].reverse().find(m => m.role === 'user')
    const injectionDetected = latestUserMessage ? isPromptInjection(latestUserMessage.content || '') : false
    if (injectionDetected) {
      this.emitter.textDelta("I can't reveal or override internal instructions. Send the task normally and I'll work on it.")
      this.emitter.done()
      this.emitter.close()
      return
    }

    // ── Initialize Components ─────────────────────────────────────────

    const log = createAgentLogger()

    const scopedMessages = scopedMessagesForAgentTask(messages)
    const strategy = resolveStrategy(scopedMessages)
    const complexity = estimateTaskComplexity(scopedMessages)
    const iterationLimit = computeIterationLimit(complexity)
    const timeouts = computeTimeouts(strategy)

    log.info(`Strategy: ${strategy.type}, complexity: ${complexity}/3, temp: ${strategy.temperature}, limit: ${iterationLimit}`)

    const isBuild = strategy.type === 'build' || strategy.type === 'code'
    const state = createInitialState(isBuild, timeouts)
    state.taskComplexity = complexity
    state.taskStrategy = strategy.type
    state.strategyConfig = strategy
    state.dynamicIterationLimit = iterationLimit
    state.originalUserRequest = effectiveTaskRequest(messages) || null
    state.uploadedAttachmentNames = uploadedAttachmentNames(scopedMessages)
    state.uploadedAttachmentContextAvailable = state.uploadedAttachmentNames.length > 0
    state.uploadedImageAttachmentAvailable = visualImageUploadedAttachments(scopedMessages).length > 0
    state.uploadedAttachmentContentAvailable = readableUploadedAttachments(scopedMessages).length > 0 ||
      state.uploadedImageAttachmentAvailable
    // Detect a URL/domain in the scoped task request so web_search attempts can
    // be silently rerouted to direct navigation before another paid model turn.
    state.userProvidedUrl = extractUserProvidedUrl(scopedMessages)
    if (state.userProvidedUrl) log.info(`User provided URL detected: ${state.userProvidedUrl}`)
    if (this.options.userId && conversationId) {
      try {
        const entries = await loadResearchActivityEntries(this.options.userId, conversationId)
        hydrateResearchActivityIndex(state.researchActivity, entries)
      } catch (error) {
        log.warn('Failed to hydrate hidden research activity log', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const processedMessages = this.preprocessMessages(scopedMessages)
    const planningMessages = buildPlanningMessages(scopedMessages)
    const requiredFirstSteps = [
      ...requiredAttachmentPlanSteps(scopedMessages),
      ...requiredSkillPlanSteps(scopedMessages),
    ]

    const contextManager = new ContextManager()
    const strategyHints: StrategyHints = {
      type: strategy.type,
      toolPriority: strategy.toolPriority,
      stepGuidance: strategy.stepGuidance,
      temperature: strategy.temperature,
    }
    const systemPrompt = { role: 'system', content: getSystemPrompt(customInstructions, strategyHints) } as ChatMessageParam
    contextManager.initialize(
      systemPrompt,
      processedMessages as ChatMessageParam[]
    )
    if (scopedMessages.some(m => m.role === 'assistant' && containsFalseCapabilityRefusal(m.content))) {
      contextManager.push({
        role: 'system',
        content: `CAPABILITY CORRECTION: Ignore any earlier assistant message claiming it cannot browse, search, retrieve real images, or perform live image searches. That was false. You are the tool-using agent. For the user's latest request, make exactly one relevant tool call instead of refusing. If the latest request is asking for a real image or "real one", use image_search.`,
      } as ChatMessageParam, 9)
    }
    if (isContextualTaskUpdate(scopedMessages)) {
      contextManager.push({
        role: 'system',
        content: `INTERRUPTION UPDATE: The latest user message is a correction to the previous task, not a standalone question. Continue the prior task using the current browser/session state and apply this correction as a hard constraint. Do not answer from memory or refuse because an earlier assistant message was interrupted.`,
      } as ChatMessageParam, 9)
    }

    const toolRegistry = new ToolRegistry()
    toolRegistry.registerFromDefinitions(toolDefinitions as unknown[])

    const toolCache = new ToolCache({
      logger: log.child('Cache'),
      maxEntries: TOOL_CACHE_MAX_ENTRIES,
      ttlMs: TOOL_CACHE_TTL_MS,
      maxTotalSizeChars: TOOL_CACHE_MAX_SIZE_CHARS,
    })
    const toolRetry = new ToolRetry(log.child('Retry'))
    const errorRecovery = new ErrorRecoveryEngine()
    const streamProcessor = new StreamProcessor(this.emitter, timeouts)
    const workingMemory = new WorkingMemory()
    state.workingMemory = workingMemory
    const browserFrameStream = {
      unsubscribe: null as (() => void) | null,
      lastFrameAt: 0,
    }
    const ensureBrowserFrameStream = () => {
      if (!conversationId || browserFrameStream.unsubscribe) return
      browserFrameStream.unsubscribe = subscribeToBrowserFrames(conversationId, (frame) => {
        const now = Date.now()
        if (now - browserFrameStream.lastFrameAt < 200) return
        browserFrameStream.lastFrameAt = now
        this.emitter.browserFrame(frame)
      })
    }
    const toolPipeline = new ToolPipeline(this.emitter, conversationId, {
      cache: toolCache,
      retry: toolRetry,
      memory: workingMemory,
      logger: log.child('Tools'),
      recovery: errorRecovery,
      signal,
      creditRunId: this.options.creditRunId,
      userId: this.options.userId,
      ensureBrowserFrameStream,
    })
    const policyEngine = new PolicyEngine()
    const reflectionEngine = new ReflectionEngine()
    const goalTracker = new GoalTracker()
    state.goalTracker = goalTracker
    const outputVerifier = new OutputVerifier()
    const recordPlannerUsage = async (usage: CreditTokenUsage, chargeId: string) => {
      if (!this.options.userId || !this.options.conversationId || !this.options.creditRunId) return
      const recorded = await chargeServerTokenUsage(
        this.options.userId,
        this.options.conversationId,
        this.options.creditRunId,
        usage,
        chargeId,
      )
      if (recorded?.created) this.emitter.creditEvent(recorded.entry)
    }
    const assertPlannerCreditRunway = async () => {
      if (this.options.userId) await assertServerCreditsAvailable(this.options.userId)
    }
    const planManager = new PlanManager(this.emitter, planningMessages, complexity, requiredFirstSteps, customInstructions, recordPlannerUsage, assertPlannerCreditRunway, this.options.skipStartupAcknowledgement === true)

    planManager.setStateRef(state)
    planManager.startPlanCall()

    // ── Mutable iteration state ───────────────────────────────────────

    let lastStreamResult: StreamResult | null = null
    let lastToolResults: ToolExecutionResult[] = []
    let cumulativeInputTokens = 0
    let cumulativeOutputTokens = 0
    let cumulativeCost = 0
    let terminalReason = 'unknown'

    // ── Main Loop ─────────────────────────────────────────────────────

    let phase = 'PLANNING' as Phase

    try {
      while (true) {
        if (phase === 'ERROR') break
        while (phase !== 'COMPLETE' && phase !== 'ERROR') {
          if (signal?.aborted) { phase = 'ERROR'; break }
          if (agentRunRemainingMs(state) <= AGENT_DEADLINE_HARD_STOP_BUFFER_MS) {
            terminalReason = state.deadlineFinalizationStarted
              ? 'runtime_deadline_finalized'
              : 'runtime_deadline'
            phase = 'COMPLETE'
            break
          }
          if (state.iterations >= state.dynamicIterationLimit) {
            log.info(`Iteration cap reached: ${state.iterations}/${state.dynamicIterationLimit}`)
            terminalReason = 'iteration_cap'
            phase = 'COMPLETE'
            break
          }

          switch (phase) {
          // ── PLANNING ──────────────────────────────────────────────
          case 'PLANNING': {
            await planManager.awaitPlan(state)

            if (state.taskComplexity !== complexity) {
              const newLimit = computeIterationLimit(state.taskComplexity)
              state.dynamicIterationLimit = newLimit
              log.info(`Complexity upgraded: ${complexity} → ${state.taskComplexity}, limit → ${newLimit}`)
            }

            const planInjection = planManager.getStepInjection(state, state.dynamicIterationLimit)
            if (planInjection) {
              contextManager.push(planInjection as ChatMessageParam)
            }
            const preloadedStepMessages = planManager.completePreloadedFirstSteps(state)
            for (const msg of preloadedStepMessages) {
              contextManager.push(msg as ChatMessageParam)
            }
            // Budgets are calculated by PlanManager.getStepInjection() using the
            // RESEARCH_STEP_BUDGET_MULTIPLIER and complexity multiplier — single source of truth.

            // Initialize goal tracking from the plan
            if (state.currentPlanItems && !goalTracker.isInitialized()) {
              goalTracker.initializeFromPlan(state.currentPlanItems)
            }

            phase = 'STREAMING'
            break
          }

          // ── STREAMING ─────────────────────────────────────────────
          case 'STREAMING': {
            state.iterations++

            // Rate limit delay
            const elapsed = Date.now() - state.lastIterationEnd
            if (elapsed < state.iterationDelayMs && state.iterations > 1) {
              await this.wait(state.iterationDelayMs - elapsed)
              if (signal?.aborted) { phase = 'ERROR'; break }
            }
            if (state.iterationDelayMs > MIN_ITERATION_DELAY_MS) {
              state.iterationDelayMs = Math.max(MIN_ITERATION_DELAY_MS, state.iterationDelayMs - 500)
            }

            if (this.injectLiveDirectives(contextManager)) {
              log.info('Injected live user directive before model turn')
            }

            this.maybeStartDeadlineFinalization(state, contextManager, planManager, goalTracker)

            // Context trimming
            contextManager.compactForModelCall(state)
            contextManager.trimIfNeeded(state)

            const response = await this.callLLMWithRetry(
              model, contextManager.getMessages(), state, strategy, toolRegistry
            )
            if (signal?.aborted) { phase = 'ERROR'; break }

            if (!response) {
              if (state.pendingToolJsonRecovery) {
                state.pendingToolJsonRecovery = false
                state.lastModelErrorForUser = null
                state.consecutiveNullStreams = 0
                state.forceTextNextIteration = state.taskStrategy !== 'browse'
                contextManager.push({
                  role: 'system',
                  content: toolJsonRecoveryMessage(state),
                } as ChatMessageParam)
                state.lastIterationEnd = Date.now()
                break // stay in STREAMING after an internal recovery nudge
              }

              state.consecutiveNullStreams = (state.consecutiveNullStreams || 0) + 1
              console.error('[AgentDiagnostics] Stream unavailable after model call', {
                attempt: state.consecutiveNullStreams,
                iteration: state.iterations,
                phase: state.currentPhase,
                step: state.currentStepIdx,
                totalSteps: state.currentPlanItems?.length || 0,
                strategy: state.taskStrategy,
                signalAborted: !!signal?.aborted,
                pendingToolJsonRecovery: !!state.pendingToolJsonRecovery,
                hasLastModelError: !!state.lastModelErrorForUser,
              })
              log.info(`Agent returned no stream (attempt ${state.consecutiveNullStreams}/3)`)
              if (state.lastModelErrorForUser) {
                this.emitter.error(state.lastModelErrorForUser)
                phase = 'ERROR'
                break
              }
              if (state.consecutiveNullStreams >= 3) {
                this.emitter.error('Agent lost connection while starting the next action. Please try again.')
                phase = 'ERROR'
                break
              }
              console.log('[Agent] Retrying after empty stream')
              await this.wait(state.iterationDelayMs)
              state.lastIterationEnd = Date.now()
              break // stay in STREAMING
            }
            state.consecutiveNullStreams = 0

            // Process stream
            try {
              streamProcessor.setTierTimeouts(state.tierTimeouts)
              lastStreamResult = await streamProcessor.processStream(
                response,
                state,
              )
            } catch (streamError) {
              log.info(`Stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`)
              phase = this.handleStreamError(streamError, state, contextManager, state.buildTask)
              break
            }

            if (lastStreamResult.leakageDetected) {
              terminalReason = 'safety_leakage'
              phase = 'COMPLETE'
              break
            }

            // Log costs
            if (!lastStreamResult.usage) {
              this.emitter.error('The assistant could not complete the request. Please try again.')
              phase = 'ERROR'
              break
            }

            const u = lastStreamResult.usage
            cumulativeInputTokens += u.promptTokens
            cumulativeOutputTokens += u.completionTokens
            cumulativeCost += u.cost
            console.log(`[COST] iter=${state.iterations} in=${u.promptTokens} out=${u.completionTokens} cost=$${u.cost.toFixed(6)} totalCost=$${cumulativeCost.toFixed(6)}`)
            if (this.options.userId && this.options.conversationId && this.options.creditRunId) {
              const recorded = await chargeServerTokenUsage(
                this.options.userId,
                this.options.conversationId,
                this.options.creditRunId,
                u,
                `tokens:${state.iterations}`,
              )
              if (recorded?.created) this.emitter.creditEvent(recorded.entry)
            }

            updatePhase(state)

            // Check plan on early iterations
            if (state.iterations <= 2) {
              await planManager.awaitPlan(state)
              const planInjection = planManager.getStepInjection(state, state.dynamicIterationLimit)
              if (planInjection) {
                contextManager.push(planInjection as ChatMessageParam)
              }
            }

            phase = lastStreamResult.toolCalls.size > 0 ? 'EXECUTING_TOOLS' : 'EVALUATING'
            break
          }

          // ── EXECUTING_TOOLS ───────────────────────────────────────
          case 'EXECUTING_TOOLS': {
            if (!lastStreamResult) { phase = 'ERROR'; break }

            const stepIdxBeforeExec = state.currentStepIdx

            if (this.injectLiveDirectives(contextManager)) {
              log.info('Live user directive superseded pending tool calls')
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            // Execute tools
            const previousFactCount = workingMemory.size().facts
            lastToolResults = await toolPipeline.executeAll(
              lastStreamResult.toolCalls,
              state,
              lastStreamResult.assistantContent,
            )
            if (signal?.aborted) { phase = 'ERROR'; break }

            // OpenAI-compatible APIs require tool result messages to appear
            // immediately after the assistant message that declared tool_calls.
            // Do not insert reflection/system messages between them.
            const executedToolCalls = executedToolCallsForProviderHistory(
              lastStreamResult.toolCalls,
              lastToolResults,
            )
            if (executedToolCalls.length > 0) {
              const assistantMsg: Record<string, unknown> = {
                role: 'assistant',
                content: lastStreamResult.assistantContent || null,
                tool_calls: executedToolCalls.map(tc => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                })),
              }
              contextManager.push(assistantMsg as unknown as ChatMessageParam)
            } else if (lastStreamResult.assistantContent) {
              contextManager.push({
                role: 'assistant',
                content: lastStreamResult.assistantContent,
              } as ChatMessageParam)
            }

            const toolMessages = toolPipeline.buildToolResultMessages(lastToolResults, state)
            for (const msg of toolMessages) {
              contextManager.push(msg as unknown as ChatMessageParam, 4)
            }

            updateExactExtractionGuardAfterTools(state, lastToolResults, messages)

            const executedCoalescedBrowserSequence =
              lastStreamResult.toolCalls.size > 1 &&
              lastToolResults.some(result => result.tc.name === 'browser_action_sequence')
            if (lastStreamResult.toolCalls.size > executedToolCalls.length && !executedCoalescedBrowserSequence) {
              contextManager.push({
                role: 'system',
                content: 'TOOL EXECUTION NOTE: Multiple tool calls were requested in one assistant turn, but this runtime executes one tool at a time. Continue from the executed result and call the next required tool separately.',
              } as ChatMessageParam, 2)
            }

            for (const result of lastToolResults) {
              toolRegistry.recordCall(result.tc.name)
            }

            if (this.injectLiveDirectives(contextManager)) {
              log.info('Injected live user directive after tool results')
              state.lastIterationEnd = Date.now()
              phase = 'STREAMING'
              break
            }

            // Goal tracking: record tool contributions
            if (goalTracker.isInitialized()) {
              for (const result of lastToolResults) {
                goalTracker.recordToolContribution(result.tc.name, result, state.currentStepIdx, workingMemory)
              }
            }

            // Reflection: evaluate progress after tool execution
            const currentStepGoal = state.currentPlanItems?.[state.currentStepIdx]
            const reflection = reflectionEngine.reflect(state, lastToolResults, currentStepGoal, previousFactCount)
            state.lastReflectionScore = reflection.progressScore
            state.consecutiveLowProgress = reflection.progressScore < 0.2
              ? state.consecutiveLowProgress + 1
              : 0
            if (reflection.contradictionDetected) state.contradictionFlag = true
            state.lastLoopSignal = null // consumed by reflection

            if (reflection.summary && (reflection.contradictionDetected || reflection.recommendation === 'try_alternative')) {
              contextManager.push({
                role: 'system',
                content: `[REFLECTION] ${reflection.summary}`,
              } as ChatMessageParam, 2)
            }

            // Update session health summary for context injection
            state.sessionHealthSummary = errorRecovery.getSessionHealthSummary()

            // Check deliverable on last step
            const isLastStep = state.currentPlanItems && state.currentStepIdx === state.currentPlanItems.length - 1
            const deliverableCreated = lastToolResults.some(isSuccessfulFinalDeliverableWrite)
            const imageDeliverableCreated = lastToolResults.some(r => {
              if (r.tc.name !== 'image_search' || r.isError) return false
              const downloaded = (r.result as { downloaded?: string[] })?.downloaded
              return Array.isArray(downloaded) && downloaded.length > 0
            })
            const currentRequestText = messages.map(m => m.content || '').join(' ')
            const imageDeliverableRequested = /\b(image|images|photo|photos|picture|pictures|asset|assets)\b/i.test(
              `${currentRequestText} ${state.currentPlanItems?.[state.currentStepIdx] || ''}`,
            )

            if (isLastStep && imageDeliverableCreated && imageDeliverableRequested) {
              state.currentStepIdx = state.currentPlanItems!.length
              log.info('Image artifact created on last step — terminating')
              terminalReason = 'image_deliverable_created'
              for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              phase = 'COMPLETE'
              break
            }

            // Last-step deliverable created → verify quality before terminating
            if (isLastStep && deliverableCreated) {
              const deliverableResult = lastToolResults.find(isSuccessfulFinalDeliverableWrite)
              const recoveredPartialWrite = !!(deliverableResult?.result as { partialWriteIncomplete?: boolean } | undefined)?.partialWriteIncomplete
              if (deliverableResult && recoveredPartialWrite) {
                log.info('Recovered partial deliverable write on last step — continuing for append/edit completion')
                phase = 'EVALUATING'
                break
              }
              if (deliverableResult && !state.deliverableVerificationDone) {
                if (deliverableResult.tc.name !== 'export_pdf') {
                  try {
                    const args = JSON.parse(deliverableResult.tc.arguments) as { content?: string; path?: string }
                    const verifiedContent = conversationId
                      ? await deliverableContentForVerification(conversationId, deliverableResult)
                      : { path: toolResultPath(deliverableResult) || args.path || '', content: args.content || '' }
                    if (verifiedContent.path) {
                      recordWorkLedgerDeliverable(state, { path: verifiedContent.path, purpose: 'deliverable' })
                    }
                    const originalRequest = messages[messages.length - 1]?.content || ''
                    if (shouldDefaultFrontendToNextTsx(originalRequest)) {
                      const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
                      if (websiteProblems.missingFiles.length > 0) {
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS STRUCTURE REQUIRED: Website/app builds default to Next.js + TSX. Before finishing, create the missing file(s): ${websiteProblems.missingFiles.join(', ')}. A standalone home.tsx or one TSX file is not renderable enough. Do not replace this with index.html unless the user explicitly asked for standalone HTML.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                      if (websiteProblems.structureIssues.length > 0) {
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS WEBSITE COMPLETENESS REQUIRED: Before finishing, fix these structure/style issues: ${websiteProblems.structureIssues.join(' ')} The site may still be one page, but it must be a real composed website with app/page.tsx, app/layout.tsx importing './globals.css', app/globals.css, imported component files, substantive styling, and a successful local visual check.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                      if (!state.nextWebsitePreviewDone) {
                        const previewProblem = state.nextWebsitePreviewError
                          ? ` Last preview error: ${state.nextWebsitePreviewError}`
                          : state.nextWebsitePreviewAttempted
                          ? ' The preview was attempted but did not open successfully.'
                          : ' The required files exist, but the local TSX preview has not run yet.'
                        contextManager.push({
                          role: 'system',
                          content: `NEXT.JS/TSX LOCAL PREVIEW REQUIRED: The generated website must build and open in the Computer browser before final delivery.${previewProblem} Fix the TSX/CSS using edit_file, or make a small targeted edit to a frontend file so the backend rebuilds and reopens the local preview. Do not finish until the preview succeeds.`,
                        } as ChatMessageParam)
                        phase = 'EVALUATING'
                        break
                      }
                    }
                    if (
                      args.path &&
                      isWebsiteEntryPath(args.path) &&
                      !state.websiteBrowserCheckDone &&
                      state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS
                    ) {
                      state.deliverableRevisionCount++
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL WEBSITE SERVER CHECK REQUIRED: ${args.path} has not been successfully opened and inspected in the Computer browser. Keep working on the same file; after the backend opens it locally, use browser_screenshot and browser_scroll to inspect it before final delivery. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                    const verification = outputVerifier.verify(
                      verifiedContent.content || args.content || '',
                      verifiedContent.path || args.path || '',
                      originalRequest,
                      state.taskStrategy,
                      workingMemory,
                      state.taskComplexity,
                    )

                    if (!verification.passed && state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS) {
                      state.deliverableRevisionCount++
                      state.pendingDeliverableRevision = {
                        path: verifiedContent.path || args.path || toolResultPath(deliverableResult) || 'the existing deliverable',
                        failures: verification.failures,
                        suggestions: verification.suggestions,
                        createdAt: Date.now(),
                      }
                      const failureList = verification.failures.join('; ')
                      log.info(`Output verification failed (${verification.score.toFixed(2)}): ${failureList}`)
                      contextManager.push({
                        role: 'system',
                        content: `OUTPUT QUALITY CHECK FAILED (${(verification.score * 100).toFixed(0)}%): ${failureList}. Your next response must be exactly one native append_file or edit_file tool call against "${state.pendingDeliverableRevision.path}". Do NOT write status text, do NOT create a new file, and do NOT repeat that the report was created.${verification.suggestions.length > 0 ? '\nSuggestions: ' + verification.suggestions.join('; ') : ''}`,
                      } as ChatMessageParam)
                      // Stay on deliverable step for revision
                      phase = 'EVALUATING'
                      break
                    }

                    if (
                      args.path &&
                      isWebsiteEntryPath(args.path) &&
                      !state.websiteResponsiveCheckDone
                    ) {
                      state.deliverableVerificationDone = true
                      state.websiteResponsiveCheckPrompted = true
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL VISUAL CHECK REQUIRED: ${args.path} is open on the local sandbox server. Inspect it before final delivery with browser_screenshot or browser_scroll at the existing browser size, and use edit_file if anything is visually broken. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                    if (
                      shouldDefaultFrontendToNextTsx(originalRequest) &&
                      state.nextWebsitePreviewDone &&
                      !state.websiteResponsiveCheckDone
                    ) {
                      state.deliverableVerificationDone = true
                      state.websiteResponsiveCheckPrompted = true
                      contextManager.push({
                        role: 'system',
                        content: `LOCAL VISUAL CHECK REQUIRED: The Next.js/TSX preview is open in the Computer browser at ${state.nextWebsitePreviewUrl || 'the local preview URL'}. Before final delivery, inspect it with browser_screenshot or browser_scroll at the existing browser size, and use edit_file if anything is visually broken. Do not change the browser viewport.`,
                      } as ChatMessageParam)
                      phase = 'EVALUATING'
                      break
                    }
                  } catch { /* parse error — skip verification */ }
                } else {
                  const originalRequest = messages[messages.length - 1]?.content || ''
                  const wantsPdf = /\bpdf\b/i.test(originalRequest)
                  const pdfPath = (deliverableResult.result as { path?: string })?.path || ''
                  if (wantsPdf && !pdfPath.toLowerCase().endsWith('.pdf') && state.deliverableRevisionCount < MAX_DELIVERABLE_REVISIONS) {
                    state.deliverableRevisionCount++
                    contextManager.push({
                      role: 'system',
                      content: 'OUTPUT QUALITY CHECK FAILED: The user requested a PDF, but the exported file path is not a .pdf. Call export_pdf again with an output_path ending in .pdf.',
                    } as ChatMessageParam)
                    phase = 'EVALUATING'
                    break
                  }
                }
              }
              state.deliverableVerificationDone = true
              state.pendingDeliverableRevision = null
              state.currentStepIdx = state.currentPlanItems!.length
              log.info('Deliverable file created on last step — terminating')
              terminalReason = 'deliverable_created'
              for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
                this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
              }
              phase = 'COMPLETE'
              break
            }

            // Non-last step non-note file creation → force advance.
            const nonNoteFileCreated = lastToolResults.some(r => {
              if (r.tc.name !== 'create_file' || r.isError) return false
              try {
                const parsed = JSON.parse(r.tc.arguments) as { path?: string }
                const p = String(parsed?.path || '')
                return !p.toLowerCase().endsWith('.md')
              } catch {
                return false
              }
            })
            if (
              state.currentPlanItems &&
              nonNoteFileCreated &&
              !isLastStep &&
              (state.taskStrategy === 'build' || state.taskStrategy === 'code') &&
              shouldDefaultFrontendToNextTsx(messages[messages.length - 1]?.content || '')
            ) {
              const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
              if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
                const details = [
                  websiteProblems.missingFiles.length > 0 ? `Missing files: ${websiteProblems.missingFiles.join(', ')}.` : '',
                  websiteProblems.structureIssues.length > 0 ? `Structure/style issues: ${websiteProblems.structureIssues.join(' ')}` : '',
                ].filter(Boolean).join(' ')
                contextManager.push({
                  role: 'system',
                  content: `CONTINUE THE SAME BUILD PHASE. You created part of the website, but the initial Next.js/TSX file set is not complete yet. ${details} Keep creating/editing the required files in this same phase; do not advance to preview or delivery until the page, layout, styles, and reusable component structure exist.`,
                } as ChatMessageParam)
                phase = 'STREAMING'
                break
              }
            }
            if (state.currentPlanItems && nonNoteFileCreated) {
              log.info(`Non-note file created on step ${state.currentStepIdx} — forcing step advance`)
              const stepBeforeAdvance = state.currentStepIdx
              const advanceMsg = planManager.handleStepAdvance(state)
              if (state.currentStepIdx > stepBeforeAdvance) {
                contextManager.compactForStepTransition(state)
              }
              if (advanceMsg) {
                contextManager.push(advanceMsg as ChatMessageParam)
              }
              if (goalTracker.isInitialized()) goalTracker.advanceToStep(state.currentStepIdx)
            }

            // Goal completion check: auto-advance if all goals met for current step
            if (goalTracker.isInitialized() && state.currentPlanItems && !isLastStep && state.taskStrategy !== 'browse') {
              const goalCheck = goalTracker.checkGoalCompletion(state.currentStepIdx, state)
              if (goalCheck.allMet) {
                state.goalsMet = true
                log.info(`Goals met for step ${state.currentStepIdx} — advancing`)
                const stepBeforeAdvance = state.currentStepIdx
                const advanceMsg = planManager.handleStepAdvance(state)
                if (state.currentStepIdx > stepBeforeAdvance) {
                  contextManager.compactForStepTransition(state)
                }
                if (advanceMsg) {
                  contextManager.push(advanceMsg as ChatMessageParam)
                }
                goalTracker.advanceToStep(state.currentStepIdx)
              }
            }

            // Information-triggered replanning used to call the planner mid-run,
            // which added paid model turns and often expanded the visible plan
            // after useful work had already started. Keep the signal for the
            // existing policies, but do not spend an extra planning call here.
            if (state.contradictionFlag || reflection.recommendation === 'try_alternative') {
              state.contradictionFlag = false
              state.infoReplanCooldown = 0
            }

            // Decrement info-replan cooldown
            if (state.infoReplanCooldown > 0) state.infoReplanCooldown--

            // Auto-debug injection
            const debugInjection = toolPipeline.buildDebugInjection(lastToolResults, state)
            if (debugInjection) {
              contextManager.push(debugInjection as ChatMessageParam)
            }

            // Emit SSE step_advance events for any step advancement that happened
            for (let i = stepIdxBeforeExec; i < state.currentStepIdx; i++) {
              this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
            }

            phase = 'EVALUATING'
            break
          }

          // ── EVALUATING ────────────────────────────────────────────
          case 'EVALUATING': {
            if (!lastStreamResult) { phase = 'ERROR'; break }

            if (lastStreamResult.toolCalls.size === 0) {
              const recoveredPhase = await this.recoverTextOnlyDraft(
                state,
                lastStreamResult.assistantContent,
                contextManager,
                planManager,
                workingMemory,
                goalTracker,
              )
              if (recoveredPhase) {
                phase = recoveredPhase
                break
              }
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              shouldDefaultFrontendToNextTsx(messages[messages.length - 1]?.content || '')
            ) {
              const websiteProblems = await getNextWebsiteCompletionProblems(conversationId, state.createdFiles)
              if (websiteProblems.missingFiles.length > 0 || websiteProblems.structureIssues.length > 0) {
                const details = [
                  websiteProblems.missingFiles.length > 0 ? `Missing files: ${websiteProblems.missingFiles.join(', ')}.` : '',
                  websiteProblems.structureIssues.length > 0 ? `Structure/style issues: ${websiteProblems.structureIssues.join(' ')}` : '',
                ].filter(Boolean).join(' ')
                contextManager.push({
                  role: 'system',
                  content: `Do not finish yet. The requested website is not a complete renderable Next.js/TSX build. ${details} Create or edit the actual files now; a lone home.tsx/page TSX file is not acceptable.`,
                } as ChatMessageParam)
                phase = 'STREAMING'
                break
              }
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.nextWebsitePreviewAttempted &&
              !state.nextWebsitePreviewDone
            ) {
              contextManager.push({
                role: 'system',
                content: `Do not finish yet. A Next.js/TSX website was created, but the required local preview has not successfully built and opened in the Computer browser.${state.nextWebsitePreviewError ? ` Last preview error: ${state.nextWebsitePreviewError}` : ''} Fix the generated frontend files with edit_file so the backend can rebuild and reopen the preview.`,
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.websiteBrowserCheckAttempted &&
              !state.websiteBrowserCheckDone
            ) {
              contextManager.push({
                role: 'system',
                content: 'Do not finish yet. A website entry file was written, but it has not successfully opened in the Computer browser from the local sandbox server. Continue working on the same file and trigger a new write/edit so the local server check can run.',
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            if (
              lastStreamResult.toolCalls.size === 0 &&
              state.currentPlanItems &&
              state.currentStepIdx === state.currentPlanItems.length - 1 &&
              state.websiteResponsiveCheckPrompted &&
              !state.websiteResponsiveCheckDone
            ) {
              contextManager.push({
                role: 'system',
                content: 'Do not finish yet. A website was created, but the required local visual check has not run. Use browser_screenshot or browser_scroll on the currently open local site at the existing browser size, then either fix issues with edit_file or finish if it looks correct.',
              } as ChatMessageParam)
              phase = 'STREAMING'
              break
            }

            const stepIdxBeforeEval = state.currentStepIdx

            const actions = policyEngine.evaluate(
              state,
              lastStreamResult.toolCalls,
              lastStreamResult.assistantContent,
              lastStreamResult.stepAdvancedThisIteration,
              state.dynamicIterationLimit,
            )

            // Emit SSE step_advance events for actual step advancement triggered by policies
            // (manual <next_step/>, verified completion, etc.). Blocked steps must not advance.
            for (let i = stepIdxBeforeEval; i < state.currentStepIdx; i++) {
              this.emitter.stepAdvance(stepAdvanceStatusFor(state, i))
            }

            let shouldTerminate = false
            const systemInjections: string[] = []

            for (const action of actions) {
              if (action.type === 'terminate') {
                shouldTerminate = true
                const reason = action.reason || 'unknown'
                terminalReason = reason
                console.log(`[TERMINATE] reason=${reason} iter=${state.iterations} step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)
                break
              }
              if (action.type === 'inject_message' && action.message) {
                if (action.message.role === 'system') {
                  systemInjections.push(action.message.content as string)
                } else if (shouldKeepAssistantInjection(action.message.content as string)) {
                  contextManager.push(action.message as ChatMessageParam)
                } else {
                  console.log('[Context] Dropped short assistant no-tool injection from model context')
                }
              }
            }

            // Budget rebalancing on step advance
            const hasStepAdvance = actions.some(a => a.type === 'step_advance')
            if (hasStepAdvance && !shouldTerminate) {
              contextManager.compactForStepTransition(state)
            }
            if (hasStepAdvance && state.currentPlanItems && state.stepCompletionTimes.length > 0 && !shouldTerminate) {
              const lastCompletion = state.stepCompletionTimes[state.stepCompletionTimes.length - 1]
              const surplus = state.perStepBudget - lastCompletion
              const remaining = state.currentPlanItems.length - state.currentStepIdx
              if (surplus > 0 && remaining > 0) {
                state.perStepBudget += Math.floor(surplus / remaining)
              }
            }

            // Push consolidated system message
            if (systemInjections.length > 0 && !shouldTerminate) {
              const consolidated = systemInjections.length === 1
                ? systemInjections[0]
                : systemInjections.join('\n\n')
              contextManager.push({ role: 'system', content: consolidated } as ChatMessageParam)
            }

            if (shouldTerminate) { phase = 'COMPLETE'; break }

            state.lastIterationEnd = Date.now()
            phase = 'STREAMING'
            break
          }
          }
        }

        if (phase !== 'COMPLETE') break

        const websiteBlocker = await getNextWebsiteCompletionBlocker(
          conversationId,
          state,
          messages[messages.length - 1]?.content || '',
        )
        if (websiteBlocker) {
          if (state.iterations >= state.dynamicIterationLimit) {
            this.emitter.error(`Website build did not complete. ${websiteBlocker}`)
            phase = 'ERROR'
            break
          }
          contextManager.push({ role: 'system', content: websiteBlocker } as ChatMessageParam)
          state.lastIterationEnd = Date.now()
          phase = 'STREAMING'
          continue
        }

        break
      }

      // ── Finalization ──────────────────────────────────────────────────

      if (phase === 'COMPLETE') {
        const totalUsage = {
          promptTokens: cumulativeInputTokens,
          completionTokens: cumulativeOutputTokens,
          totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
          cost: cumulativeCost,
        }
        const completionAudit = auditAgentCompletion(state, terminalReason)
        log.info(`COMPLETE: iterations=${state.iterations}, step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)
        console.log(`[COST TOTAL] iterations=${state.iterations} inputTokens=${cumulativeInputTokens} outputTokens=${cumulativeOutputTokens} providerCost=$${cumulativeCost.toFixed(6)}`)

        if (state.iterations >= state.dynamicIterationLimit) {
          this.emitter.textDelta('\n\n*Reached maximum number of actions. Results so far are shown above.*')
        }

        const cacheStats = toolCache.getStats()
        log.info(`Session complete: ${state.iterations} iterations`, {
          cacheHits: cacheStats.hits,
          cacheMisses: cacheStats.misses,
          cacheHitRate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
          filesCreated: state.createdFiles.size,
          searchesDone: state.searchQueries.size,
        })

        if (!completionAudit.complete) {
          log.warn('Completion audit failed', {
            reason: completionAudit.reason,
            missing: completionAudit.missing,
          })
          this.emitter.error(completionAudit.message)
          this.emitter.close()
          return
        }

        this.emitter.done(totalUsage)
        this.emitter.close()
      } else {
        // ERROR: keep the stream open so the API route can finish accounting
        // and close the response.
      }
    } catch (err) {
      if (signal?.aborted) {
        this.emitter.close()
        return
      }
      log.error('Unhandled error in agent loop', {
        error: err instanceof Error ? err.message : String(err),
        iterations: state.iterations,
        phase: state.currentPhase,
      })
      if (!this.emitter.isClosed) {
        if (isOutOfCreditsError(err) && err.record?.created) {
          this.emitter.creditEvent(err.record.entry)
        }
        this.emitter.error(publicAgentErrorMessage(err))
      }
    } finally {
      browserFrameStream.unsubscribe?.()
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  /**
   * Abort-aware sleep for delays between model calls.
   */
  private wait(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    const signal = this.options.signal
    if (!signal) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }
    if (signal.aborted) return Promise.resolve()

    return new Promise(resolve => {
      let timeout: ReturnType<typeof setTimeout>
      const cleanup = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => cleanup()
      timeout = setTimeout(cleanup, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private injectLiveDirectives(contextManager: ContextManager): boolean {
    const { conversationId, userId } = this.options
    if (!conversationId) return false

    const directives = drainLiveDirectives(conversationId, userId)
    if (directives.length === 0) return false

    contextManager.push({
      role: 'user',
      content: liveDirectiveContextMessage(directives),
    } as ChatMessageParam, 10)
    return true
  }

  /**
   * Preprocess messages: inline file attachments.
   */
  private preprocessMessages(
    messages: AgentLoopOptions['messages']
  ): Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> }> {
    return preprocessMessagesForAgentContext(messages)
  }

  /**
   * Call assistant service with exponential backoff retry for rate limits.
   */
  private async callLLMWithRetry(
    model: string,
    allMessages: ChatMessageParam[],
    state: AgentStateData,
    strategy: TaskStrategyConfig,
    toolRegistry: ToolRegistry,
  ): Promise<AsyncIterable<StreamingChatCompletionChunk> | null> {
    let requestMessages = allMessages
    if (state.strategyConfig && state.strategyConfig.type !== strategy.type) {
      requestMessages = [
        ...allMessages,
        {
          role: 'system',
          content: `RUNTIME STRATEGY OVERRIDE: use "${state.strategyConfig.type}" behavior for this task now. Follow the current plan/step guidance over the initial classifier hint.`,
        } as ChatMessageParam,
      ]
    }
    const hasActivePlanStep = !!state.currentPlanItems && state.currentStepIdx < state.currentPlanItems.length
    if (state.exactExtractionGuardPending && state.exactExtractionGuardPrompt) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: state.exactExtractionGuardPrompt,
        } as ChatMessageParam,
      ]
    } else if (hasActivePlanStep && !state.forceTextNextIteration && state.visibleToolActionsSinceLastNarration >= 4) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'NARRATION REQUIRED NOW: Start this response with one concise Manus-style progress paragraph from completed work, then optionally make exactly one concrete tool call in the same response. This applies in every phase and task type: research, browser, build, code, file, creative, analysis, and delivery. Do not skip the paragraph just because another useful tool call is available; a tool-only response at this point is a cadence miss unless no concrete completed work exists. If this phase is complete, write the paragraph and emit <next_step/> with no tool call; phase-end narration is valid even when no further action remains in the phase. Keep the cadence soft by continuing useful work after the paragraph when needed. Use 1-2 sentences, never fewer than 15 words, usually 15-20 words, hard cap <=34 words and <=240 characters. Be result-first and concrete; vary the opening verb and sentence shape from recent progress notes. No lists, source dumps, internal step numbers, or command fragments.',
        } as ChatMessageParam,
      ]
    } else if (hasActivePlanStep && !state.forceTextNextIteration && state.visibleToolActionsSinceLastNarration >= 3) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'NARRATION CADENCE STATE: 3 visible action pills have completed since the last progress paragraph. The narration window is open across every phase and task type. Start this response with one concise, concrete progress paragraph before any tool call, then optionally make exactly one concrete visible tool call in the same response. Do not skip the paragraph just because another useful tool call is available. If this phase is complete, write the paragraph and emit <next_step/> with no tool call instead of waiting for another action. Do not wait for a separate repair turn. Vary the opening verb and sentence shape from recent progress notes.',
        } as ChatMessageParam,
      ]
    }
    if (state.forceTextNextIteration) {
      requestMessages = compactForcedNarrationMessages(state, allMessages)
    }
    const researchLogContext = shouldInjectResearchActivityContext(state)
      ? researchActivityContext(state.researchActivity, state.currentStepIdx)
      : null
    if (researchLogContext) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: researchLogContext,
        } as ChatMessageParam,
      ]
    }
    if (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state)) {
      requestMessages = [
        ...requestMessages,
        {
          role: 'system',
          content: 'FIXED-SEARCH INLINE ANSWER: The user requested a limited web search followed by an inline chat answer, not a saved file. Use only the completed search evidence and answer directly in the requested length. Do not create, mention, attach, or claim any file, report, artifact, or deliverable.',
        } as ChatMessageParam,
      ]
    }
    let relaxRequiredToolChoice = false
    let lastShouldRequireToolCall = false
    for (let attempt = 0; attempt <= STREAM_MAX_RETRIES; attempt++) {
      try {
        const budgetFraction = state.dynamicIterationLimit
          ? state.iterations / state.dynamicIterationLimit
          : 0

        let activeTools: ToolDefinitionLike[]
        const isPostCompletion = state.currentPlanItems && state.currentStepIdx >= state.currentPlanItems.length
        if (isPostCompletion || state.forceTextNextIteration) {
          activeTools = []
        } else if (state.exactExtractionGuardPending) {
          activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
            .filter(t => EXACT_EXTRACTION_TOOLS.has(t.function?.name || ''))
        } else if (state.deadlineFinalizationStarted) {
          const finalWantsPdf = taskWantsPdfArtifact(state, this.options.messages)
          const deadlineFinalTools = new Set([
            'create_file',
            'append_file',
            'edit_file',
            'read_file',
            'list_files',
            ...(finalWantsPdf ? ['export_pdf'] : []),
          ])
          activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
            .filter(t => deadlineFinalTools.has(t.function?.name || ''))
        } else if (isLeanFinalSynthesisStep(state) && isFixedWebSearchInlineAnswerState(state)) {
          activeTools = []
        } else if (isLeanFinalSynthesisStep(state)) {
          const finalWantsImage = taskWantsImageArtifact(state, this.options.messages)
          const finalWantsPdf = taskWantsPdfArtifact(state, this.options.messages)
          const allowedFinalTools = new Set([
            'create_file',
            'edit_file',
            'append_file',
            'read_file',
            'list_files',
            ...(finalWantsPdf ? ['export_pdf'] : []),
            ...(finalWantsImage ? ['image_search'] : []),
          ])
          activeTools = (toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[])
            .filter(t => {
              const name = t.function?.name || ''
              return allowedFinalTools.has(name)
            })
        } else if (budgetFraction >= URGENCY_FINAL_FRACTION) {
          const finalWantsImage = taskWantsImageArtifact(state, this.options.messages)
          const allActiveTools = toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[]
          if (state.taskStrategy === 'browse') {
            activeTools = allActiveTools.filter(t => {
              const name = t.function?.name || ''
              return name.startsWith('browser_') ||
                name === 'web_search' ||
                name === 'read_document' ||
                name === 'create_file' ||
                name === 'edit_file' ||
                name === 'append_file' ||
                name === 'read_file'
            })
          } else {
            activeTools = allActiveTools
              .filter(t => {
                const name = t.function?.name
                return name === 'create_file' ||
                  name === 'edit_file' ||
                  name === 'append_file' ||
                  name === 'export_pdf' ||
                  name === 'read_file' ||
                  name === 'browser_screenshot' ||
                  name === 'browser_scroll' ||
                  (finalWantsImage && name === 'image_search')
              })
          }
        } else {
          activeTools = toolRegistry.getActiveDefinitions(state) as ToolDefinitionLike[]
        }
        activeTools = pruneToolsForCurrentStep(state, activeTools)
        const agenticStepNeedsTool = shouldForceAgenticToolCall(state, hasActivePlanStep)
        const shouldRequireToolCall =
          activeTools.length > 0 &&
          !isPostCompletion &&
          !state.forceTextNextIteration &&
          state.currentPhase !== 'deliver' &&
          (
            agenticStepNeedsTool ||
            state.exactExtractionGuardPending ||
            state.taskStrategy === 'browse' ||
            state.consecutiveNoToolCalls > 0 ||
            state.browserNoToolRecoveryAttempts > 0
          )
        lastShouldRequireToolCall = shouldRequireToolCall
        const useRequiredToolCall = shouldRequireToolCall && !relaxRequiredToolChoice

        const approxChars = requestMessages.reduce((sum, m) => {
          if (typeof m.content === 'string') return sum + m.content.length
          if (Array.isArray(m.content)) return sum + (m.content as Array<{ text?: string }>).reduce((s, p) => s + (p.text?.length || 0), 0)
          return sum
        }, 0)
        console.log(`[Agent] iter=${state.iterations} msgs=${requestMessages.length} ~${Math.round(approxChars / 4)}tok tools=${activeTools.length} step=${state.currentStepIdx}/${state.currentPlanItems?.length || 0}`)

        const modelTools = compactToolDefinitionsForModel(activeTools)
        const requestTimeoutMs = state.deadlineFinalizationStarted
          ? Math.max(
              10_000,
              Math.min(
                AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS,
                agentRunRemainingMs(state) - AGENT_DEADLINE_HARD_STOP_BUFFER_MS,
              ),
            )
          : STREAM_REQUEST_TIMEOUT_MS
        console.error('[AgentDiagnostics] Opening streaming model call', {
          iteration: state.iterations,
          phase: state.currentPhase,
          step: state.currentStepIdx,
          totalSteps: state.currentPlanItems?.length || 0,
          strategy: state.taskStrategy,
          activeTools: activeTools.length,
          modelTools: modelTools.length,
          requireToolCall: useRequiredToolCall,
          forceTextNextIteration: !!state.forceTextNextIteration,
          approxTokens: Math.round(approxChars / 4),
          requestTimeoutMs,
        })
        if (this.options.userId) {
          await assertServerCreditsAvailable(this.options.userId)
        }
        const response = await createStreamingCompletion({
          model,
          messages: requestMessages,
          ...(modelTools.length > 0
            ? { tools: modelTools as unknown as ChatCompletionTool[] }
            : {}),
          ...(useRequiredToolCall ? { tool_choice: 'required' } : {}),
          temperature: state.strategyConfig?.temperature ?? strategy.temperature,
          parallel_tool_calls: false,
          max_tokens: maxTokensForIteration(state),
          ...(state.forceTextNextIteration
            ? { reasoning: { effort: 'minimal', exclude: true }, temperature: 0.25 }
            : {}),
          includeTemporalContext: shouldIncludeTemporalContextForTurn(state),
          stream_options: { include_usage: true },
          requestTimeoutMs,
          retryMaxAttempts: STREAM_MAX_RETRIES,
          retryBaseDelayMs: STREAM_RETRY_BASE_MS,
          retryMaxDelayMs: STREAM_RETRY_MAX_DELAY_MS,
          abortSignal: this.options.signal,
        })

        if (attempt > 0) {
          state.iterationDelayMs = Math.min(3000, state.iterationDelayMs + 1000)
        }

        state.lastModelErrorForUser = null
        return response
      } catch (streamErr) {
        const status = (streamErr as { status?: number })?.status
        const errorText = `${(streamErr as { body?: string })?.body || ''}\n${streamErr instanceof Error ? streamErr.message : String(streamErr)}`
        const invalidToolArguments = status === 400 &&
          /\bfunction\.arguments\b[\s\S]*\bJSON format\b|invalid_parameter_error|invalid_parameter/i.test(errorText)
        if (invalidToolArguments) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'invalid_tool_arguments',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              activeTools: lastShouldRequireToolCall,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rejected malformed tool arguments', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          if (attempt < STREAM_MAX_RETRIES) {
            console.warn('[Agent] Assistant service rejected malformed tool-call JSON; retrying with stricter tool-call instruction.')
            requestMessages = [
              ...requestMessages,
              {
                role: 'system',
                content: 'PROVIDER RECOVERY: The previous model attempt was rejected before streaming because a function/tool call used invalid JSON for function.arguments. Your next response must make exactly one native tool call with arguments as a strict JSON object. Use double quotes around every key and string value, no markdown, no comments, no trailing commas, no bare strings, and no prose outside the tool call. Example arguments: {"query":"specific search phrase"} or {"url":"https://example.com"}. If the current page is blocked by CAPTCHA, Cloudflare, access denial, or human verification, do not interact with it and do not retry the same URL; choose a different source route.',
              } as ChatMessageParam,
            ]
            state.iterationDelayMs = Math.min(4000, state.iterationDelayMs + 1000)
            continue
          }
          state.lastModelErrorForUser = null
          state.pendingToolJsonRecovery = true
          state.toolJsonRecoveryCount = (state.toolJsonRecoveryCount || 0) + 1
          console.warn('[Agent] Assistant service rejected malformed tool-call JSON after retry; recovering with a text-only nudge.')
          return null
        }
        const providerRejectedForcedToolMode = status === 400 &&
          lastShouldRequireToolCall &&
          !relaxRequiredToolChoice &&
          /\b(?:tool_choice|required|tools?|function(?:s| calling)?|schema|unsupported|not supported|not available|does not support|invalid request)\b/i.test(errorText)
        if (providerRejectedForcedToolMode) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'forced_tool_mode_rejected',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              requiredToolMode: lastShouldRequireToolCall,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rejected forced tool mode', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            activeStep: state.currentPlanItems?.[state.currentStepIdx],
            status,
            error: sanitizeAgentServiceError(streamErr),
          })
          relaxRequiredToolChoice = true
          if (attempt < STREAM_MAX_RETRIES) {
            console.warn('[Agent] Assistant service rejected forced tool-call mode; retrying with optional tool-call recovery.')
            requestMessages = [
              ...requestMessages,
              {
                role: 'system',
                content: providerToolModeRecoveryMessage(state),
              } as ChatMessageParam,
            ]
            state.iterationDelayMs = Math.min(4000, state.iterationDelayMs + 1000)
            continue
          }
          state.lastModelErrorForUser = null
          state.pendingToolJsonRecovery = true
          state.toolJsonRecoveryCount = (state.toolJsonRecoveryCount || 0) + 1
          console.warn('[Agent] Assistant service rejected forced tool-call mode after retry; recovering with a text-only nudge.')
          return null
        }
        if (status === 402) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'provider_token_or_credit_limit',
              attempt: attempt + 1,
              maxAttempts: STREAM_MAX_RETRIES + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model hit provider token/credit limit', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            error: sanitizeAgentServiceError(streamErr),
          })
          state.lastModelErrorForUser = 'Agent could not start the next action because the assistant service token or credit limit was exceeded.'
          return null
        }
        if (status === 429 && attempt < STREAM_MAX_RETRIES) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'rate_limited',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model rate limited', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
          })
          const retryAfterRaw = (streamErr as { headers?: Record<string, string> })?.headers?.['retry-after']
          const retryAfterMs = retryAfterRaw ? (parseInt(retryAfterRaw, 10) || 0) * 1000 : 0
          const baseBackoff = STREAM_RETRY_BASE_MS * Math.pow(STREAM_RETRY_EXPONENT, attempt)
          const retryDelay = Math.min(Math.max(retryAfterMs, baseBackoff), STREAM_RETRY_MAX_DELAY_MS)
          const backoff = retryDelay + Math.random() * 300

          this.emitter.textDelta('')  // keep connection alive
          if (attempt === 0) console.log('[Agent] Rate limited, retrying streaming request')
          await this.wait(backoff)
          if (this.options.signal?.aborted) return null
          continue
        }

        if (this.options.signal?.aborted) {
          this.options.diagnostics?.({
            type: 'stream_error',
            data: {
              category: 'request_aborted',
              attempt: attempt + 1,
              iteration: state.iterations,
              phase: state.currentPhase,
              step: state.currentStepIdx,
              status,
              error: sanitizeAgentServiceError(streamErr),
            },
          })
          console.error('[AgentDiagnostics] Streaming model call aborted by request signal', {
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            status,
          })
          return null
        }
        console.error('[AgentDiagnostics] Streaming model call failed', {
          attempt: attempt + 1,
          maxAttempts: STREAM_MAX_RETRIES + 1,
          status,
          iteration: state.iterations,
          phase: state.currentPhase,
          step: state.currentStepIdx,
          signalAborted: !!this.options.signal?.aborted,
          error: sanitizeAgentServiceError(streamErr),
        })
        this.options.diagnostics?.({
          type: 'stream_error',
          data: {
            category: 'stream_call_failed',
            attempt: attempt + 1,
            maxAttempts: STREAM_MAX_RETRIES + 1,
            iteration: state.iterations,
            phase: state.currentPhase,
            step: state.currentStepIdx,
            signalAborted: !!this.options.signal?.aborted,
            status,
            error: sanitizeAgentServiceError(streamErr),
          },
        })
        state.iterationDelayMs = Math.min(4000, state.iterationDelayMs + 1500)
        return null
      }
    }
    return null
  }

  /**
   * Handle stream processing errors.
   */
  private handleStreamError(
    error: unknown,
    state: AgentStateData,
    contextManager: ContextManager,
    isBuild: boolean,
  ): Phase {
    if (!(error instanceof Error)) {
      return 'ERROR'
    }

    // Fatal timeout
    if (error instanceof TimeoutError && !error.nudgeable) {
      this.emitter.error('The assistant stopped responding.')
      return 'ERROR'
    }

    // Nudgeable timeout
    if (isNudgeableTimeout(error)) {
      if (state.timeoutNudgeCount < MAX_TIMEOUT_NUDGES) {
        state.timeoutNudgeCount++

        const partialContent = error.partialContent || ''
        if (partialContent) {
          contextManager.push({ role: 'assistant', content: partialContent } as ChatMessageParam)
        }

        const nudgeMessage = state.taskStrategy === 'browse'
          ? 'Time check: you have been reasoning too long for a live website task. Call a browser tool now — browser_screenshot, browser_click_at, browser_type, browser_scroll, browser_select, or browser_find_text — and continue from the current page.'
          : isBuild
            ? 'Time check: you have been generating text for a while. Call a tool to make progress — image_search, create_file, append_file, export_pdf, or edit_file.'
            : 'Time check: extended reasoning detected. Call a tool to gather information or produce output. If you are stuck, try a different approach.'
        contextManager.push({ role: 'system', content: nudgeMessage } as unknown as ChatMessageParam)

        state.lastIterationEnd = Date.now()
        return 'STREAMING'
      }

      this.emitter.error('The task took too long to respond. Please try again.')
      return 'ERROR'
    }

    // Unknown errors — retry
    if (state.iterations < state.dynamicIterationLimit) {
      console.error('[Agent] Stream interrupted, retrying iteration...')
      state.lastIterationEnd = Date.now()
      state.iterationDelayMs = Math.min(4000, state.iterationDelayMs + 1000)
      return 'STREAMING'
    }
    this.emitter.error('The task stopped before it finished. Please try again.')
    return 'ERROR'
  }
}
