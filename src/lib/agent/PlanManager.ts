import {
  createCompletion,
  createStreamingCompletion,
  DEFAULT_MODEL,
  type ChatMessageParam,
  type StreamingChatCompletionChunk,
} from '@/lib/llm'
import type { FileResult } from '@/types'
import { getFastPlanningPrompt, getPlanningPrompt } from '@/lib/prompts'
import { effectiveTaskRequest } from '@/lib/conversationContext'
import type { AgentEventEmitter } from './SSEEmitter'
import {
  AgentStateData,
  advanceStep,
  satisfyWorkLedgerRequirement,
  setWorkLedgerObjective,
  setWorkLedgerRequirements,
  updatePhase,
} from './AgentState'
import { buildStepMessage } from './guards'
import { computeTimeouts, getStrategy, type TaskType } from './TaskStrategy'
import { PLAN_STARTUP_DELAY_MS, PLAN_MAX_RETRIES, PLAN_RETRY_BASE_MS, MIN_STEP_BUDGET, MIN_DELIVERABLE_BUDGET, RESEARCH_STEP_BUDGET_MULTIPLIER, DELIVERABLE_BUDGET_FRACTION, COMPLEXITY_BUDGET_MULTIPLIERS, MIN_RESEARCH_CALLS_BY_COMPLEXITY, MAX_ITERATIONS, REPLAN_MAX_TIMES as REPLAN_MAX_RETRIES, INFO_REPLAN_MIN_ITERATIONS, INFO_REPLAN_COOLDOWN_ITERATIONS } from './config'
import {
  currentStepHasSingleWebSearchLimit,
  currentStepWebSearchLimit,
  explicitTaskToolTargetLabel,
  explicitTaskToolConstraintFromText,
  taskDefaultsToMarkdownDeliverable,
} from './taskConstraints'
import { humanTopicLabel, requestSubject } from './taskText'
import { analyzeTaskIntent } from './TaskIntent'
import type { CreditTokenUsage } from '@/lib/creditPolicy'
import { researchDepthProfileForState } from './ResearchDepth'
import { compactAdjacentSourceEvidencePhases } from './PlanNormalization'

export interface RequiredPlanStep {
  title: string
  scope: string
  preloaded?: boolean
  kind?: 'skill' | 'attachment'
  label?: string
  contentPreview?: string
  visualInput?: boolean
}

type PlannerStep = string | { title?: string; scope?: string | null }

interface PlannerResponseObject {
  ack?: string
  taskType?: string
  complexity?: number
  steps?: PlannerStep[]
}

type RawCompletionUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
} | undefined

type PlanUsageRecorder = (usage: CreditTokenUsage, chargeId: string) => Promise<void>
type PlanCreditPreflight = (label: string) => Promise<void>

const BILLABLE_USAGE_ERROR = 'The assistant provider did not return billable usage.'
const PLANNER_QUALITY_ERROR = 'The agent did not produce a task-specific plan or acknowledgement.'
const PLANNER_REPAIR_EXHAUSTED_ERROR = 'The planner could not produce a usable task-specific plan after repair.'
const PLANNER_QUALITY_REPAIR_ATTEMPTS = 1
const PLANNER_ACK_MAX_TOKENS = 96
const PLANNER_ACK_STREAM_TIMEOUT_MS = 5_500
const PLANNER_ACK_DISPLAY_WAIT_MS = 150
const PLANNER_FAST_JSON_MAX_TOKENS = 520
const PLANNER_SIMPLE_JSON_MAX_TOKENS = 420
const PLANNER_MEDIUM_JSON_MAX_TOKENS = 560
const PLANNER_JSON_MAX_TOKENS = 640
const REPLAN_JSON_MAX_TOKENS = 520
const PLANNER_FAST_JSON_REQUEST_TIMEOUT_MS = 6_500
const PLANNER_JSON_REQUEST_TIMEOUT_MS = 7_500
const PLANNER_RELAXED_JSON_REQUEST_TIMEOUT_MS = 6_500
const PLANNER_REPAIR_REQUEST_TIMEOUT_MS = 7_500
const PLANNER_REPLAN_REQUEST_TIMEOUT_MS = 7_500
const PLANNER_OVERALL_DEADLINE_MS = 16_000
const PLANNER_TIMEOUT_RECOVERY_RETRIES = 0
const PLANNER_CONTROL_REASONING = { effort: 'minimal' as const, exclude: true }
const PLANNER_ACK_REASONING = { enabled: false as const, exclude: true }
const PLANNER_ACK_FIRST_FLUSH_CHARS = 48
const PLANNER_ACK_FIRST_FLUSH_WORDS = 9
const PLANNER_ACK_FOLLOWUP_FLUSH_CHARS = 60
const NATURAL_FINAL_RESPONSE_GUIDANCE = 'Write a natural final response, then STOP. Summarize the actual outcome in user-facing terms, not the internal step name. Do not start with "Here is the completed..." or "Here’s the completed...". Do not mention how many searches, browses, checks, tool calls, sources, steps, or phases you completed unless the user explicitly asked for those counts. Do not force **Summary** or **Deliverables** headings. If files/artifacts exist, mention the deliverable naturally in one short sentence, like "You can find the report below." Include concrete results, caveats, or next steps only when useful.'
const PLANNER_FAST_PARSE_MISS = 'Fast planner did not return parseable JSON.'

class PlannerUsageRecordingError extends Error {
  constructor(readonly originalError: unknown) {
    super('Planner usage could not be recorded.')
    this.name = 'PlannerUsageRecordingError'
  }
}

function redactPlannerErrorText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/\b(?:qwen|openai|anthropic|google|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
    .replace(/\bdeepseek-v[0-9][A-Za-z0-9._:-]*/gi, '[assistant-route]')
    .replace(/deepseek/gi, 'assistant service')
    .replace(/openrouter/gi, 'assistant service')
}

function sanitizePlannerError(error: unknown): Record<string, unknown> {
  const err = error as {
    name?: string
    status?: number
    body?: string
    message?: string
  }

  return {
    name: err?.name || (error instanceof Error ? error.name : 'Error'),
    status: err?.status,
    message: redactPlannerErrorText(error instanceof Error ? error.message : String(error || 'Unknown error')),
    body: err?.body ? redactPlannerErrorText(err.body).slice(0, 500) : undefined,
  }
}

function isPlannerQualityError(error: unknown): boolean {
  return error instanceof Error && error.message === PLANNER_QUALITY_ERROR
}

function plannerRepairExhaustedError(): Error {
  return new Error(PLANNER_REPAIR_EXHAUSTED_ERROR)
}

function isBillableUsageError(error: unknown): boolean {
  return error instanceof Error && error.message === BILLABLE_USAGE_ERROR
}

function isPlannerRequestTimeout(error: unknown): boolean {
  if ((error as { name?: string })?.name === 'AbortError') return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /Assistant request timed out after \d+ seconds/i.test(message) ||
    /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(message)
}

function normalizeCompletionUsage(usage: RawCompletionUsage): CreditTokenUsage | null {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens) || !Number.isFinite(usage.cost)) {
    return null
  }
  const promptTokens = Math.max(0, Math.round(usage.prompt_tokens || 0))
  const completionTokens = Math.max(0, Math.round(usage.completion_tokens || 0))
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(usage.total_tokens)
      ? Math.max(0, Math.round(usage.total_tokens || 0))
      : promptTokens + completionTokens,
    cost: Math.max(0, Number(usage.cost || 0)),
  }
}

function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function extractBalancedJson(raw: string, openChar: '{' | '[', closeChar: '}' | ']'): string | null {
  const start = raw.indexOf(openChar)
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === openChar) depth++
    if (ch === closeChar) depth--
    if (depth === 0) return raw.slice(start, i + 1)
  }

  return null
}

function parseJsonCandidate(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

function parsePlannerResponse(raw: string): PlannerResponseObject | null {
  const cleaned = stripJsonFence(raw)
  const objectCandidate = extractBalancedJson(cleaned, '{', '}')
  const objectValues = [
    cleaned,
    objectCandidate,
  ].filter((value): value is string => !!value)

  for (const candidate of objectValues) {
    const parsed = parseJsonCandidate(candidate)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as PlannerResponseObject
      if (Array.isArray(obj.steps)) return obj
    }
  }

  const arrayCandidate = extractBalancedJson(cleaned, '[', ']')
  if (arrayCandidate) {
    const parsed = parseJsonCandidate(arrayCandidate)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return { steps: parsed as string[] }
    }
  }

  return null
}

function stringifyPlannerResponseForRepair(response: PlannerResponseObject | null): string {
  if (!response) return ''
  try {
    return JSON.stringify(response)
  } catch {
    return ''
  }
}

function plannerTaskMessages(messages: Array<{ role: string; content: string }>): ChatMessageParam[] {
  const request = effectiveTaskRequest(messages).slice(0, 6000).trim() || 'Continue the current task.'
  return [{ role: 'user', content: request }]
}

function isConcreteBuildStep(strategy: string | undefined, title: string | undefined): boolean {
  if (strategy !== 'build' && strategy !== 'code') return false
  const lower = (title || '').toLowerCase()
  const looksLikeBuild = /\b(?:build|create|code|implement|develop|design|write|draft|style|css|html|assemble|layout|page|component|file|scaffold|set\s*up|setup|configure|config|install|initialize|initialise|init|bootstrap|wire|package|dependencies?|tailwind|next\.?js|tsx|jsx|react|route|preview|test|verify|run|boot|inspect|responsive)\b/.test(lower)
  const explicitlyResearch = /\b(?:research|gather|find|search|source|collect|asset|image|reference|investigate)\b/.test(lower)
  return looksLikeBuild && !explicitlyResearch
}

function isImageRetrievalStep(title: string | undefined, scope?: string | null): boolean {
  const text = `${title || ''} ${scope || ''}`
  return /\b(image|images|photo|photos|picture|pictures|asset|assets)\b/i.test(text) &&
    /\b(find|search|retrieve|return|download|select|get)\b/i.test(text)
}

function getLatestUserContent(messages: Array<{ role: string; content: string }>): string {
  return effectiveTaskRequest(messages).toLowerCase()
}

function isWebsiteBuildTask(messages: Array<{ role: string; content: string }>): boolean {
  const text = getLatestUserContent(messages)
  if (!text) return false

  const wantsBuild = /\b(build|create|make|design|develop|implement|code|write|generate)\b/.test(text)
  const websiteTarget = /\b(website|web\s*site|webpage|web\s*page|landing\s*page|site|next\.?js|tsx|frontend|portfolio|dashboard|page)\b/.test(text)
  return wantsBuild && websiteTarget
}

function isBrowserActionTask(messages: Array<{ role: string; content: string }>): boolean {
  const text = getLatestUserContent(messages)
  if (!text) return false

  const namedAiChatAction =
    /\b(?:debate|argue|chat|talk|message|ask|prompt|converse|discuss)\b.{0,100}\b(?:gemini|google\s+gemini|chatgpt|openai|claude|anthropic\s+claude|copilot|perplexity|grok)\b/i.test(text)
  const hasTarget = /\b(?:https?:\/\/|www\.|localhost|127\.0\.0\.1|[a-z0-9-]+\.(?:com|org|net|edu|gov|io|ai|app|dev|co|au|uk|ca|de|fr|jp|shop)\b)/i.test(text) ||
    /\b(website|site|webpage|page|section|checkout|cart|form|field|button|link|menu|dropdown|tab|control|setting|map|layer|filter|color|colour|size|swatch|option|variant)\b/.test(text)
  const directAction = /\b(go to|go on|head to|navigate to|visit|open|browse to|click|tap|press|select|pick|choose|set|configure|locate|find|fill|type|sign in|log in|add to cart|checkout|buy|order|submit|download|upload|book|reserve|schedule|cancel|unsubscribe|automate|debate|argue|chat|talk|message|ask|prompt|converse|discuss)\b/.test(text)
  const optionSelection = /\b(item|page|section|field|control|setting|product|ticket|appointment|reservation|file|map|layer)\b/.test(text) &&
    /\b(color|colour|finish|storage|capacity|gb|tb|size|model|variant|option|configure|select|pick|choose|set|filter|tab|layer|date|time)\b/.test(text)

  return namedAiChatAction || (directAction && (hasTarget || optionSelection))
}

function isWebsitePreviewStep(title: string): boolean {
  const text = title.toLowerCase()
  return /\b(boot|run|start|open|launch|serve|local|localhost|server|preview|browser|visual|screenshot|responsive|mobile|desktop)\b/.test(text) &&
    /\b(preview|server|localhost|browser|responsive|visual|screenshot|mobile|desktop|local)\b/.test(text)
}

function isSkillReadStep(title: string): boolean {
  const text = title.toLowerCase()
  return text.includes('skill') &&
    /\b(read|load|review|understand|apply|inspect)\b/.test(text)
}

function isAttachmentReadStep(title: string): boolean {
  const text = title.toLowerCase()
  return /\b(uploaded|attached|attachment|attachments|file|document|pdf)\b/.test(text) &&
    /\b(read|load|review|understand|inspect|open|analyze|analyse|summarize|summarise)\b/.test(text)
}

function isPreloadedReadStep(title: string): boolean {
  return isSkillReadStep(title) || isAttachmentReadStep(title)
}

function sanitizePlannerAck(ack: string): string {
  return ack
    .replace(/^\s*(?:on it|sure|okay|ok|absolutely|certainly|got it)\s*(?:[-:,.]|—|–)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ackWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function isUsablePlannerAck(ack: string): boolean {
  const normalized = ack.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.length < 45) return false
  if (normalized.length > 280) return false
  if (containsPromptInstructionLeak(normalized)) return false
  const words = ackWordCount(normalized)
  if (words < 10 || words > 38) return false
  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  if (sentences.length < 1 || sentences.length > 2) return false
  if (/^(?:next|now|then|after that|moving forward|from here)[,\s]+(?:i(?:'|’)?ll|i will|let me|i(?:'|’)?m going to|i am going to)\b/.test(normalized)) return false
  if (!/\b(?:research|source|compare|check|verify|read|gather|analy[sz]e|assess|review|build|create|write|draft|fix|test|inspect|summari[sz]e|deliver|report|answer|find|produce)\b/.test(normalized)) return false
  if (!/\b(?:then|and|so|before|while|with|into|using|based on|against|across)\b/.test(normalized)) return false
  return !/\b(?:i(?:'|’)?ll|i will)\s+(?:open the site|work through this|start with the required|keep the task steps updated)\b/.test(normalized) &&
    !/\b(?:the requested task|the request|the site|the topic)\b.{0,80}\b(?:steps updated|visible steps)\b/.test(normalized)
}

function streamingChunkText(chunk: StreamingChatCompletionChunk): string {
  const delta = chunk.choices?.[0]?.delta
  const content = delta?.content
  return typeof content === 'string' ? content : ''
}

function containsPromptInstructionLeak(text: string): boolean {
  return /\b(?:conduct|perform|run|carry\s+out)\s+(?:the\s+)?(?:deepest\s+possible|maximum\s+depth)\s+(?:research|analysis|investigation)\b/i.test(text) ||
    /\b(?:extremely|very)\s+deep\s+research\s+all\s+about\b/i.test(text) ||
    /\bproduce\s+a\s+concise,\s+visually\s+rich\s+markdown\b/i.test(text)
}

function assertPlannerVisibleTextQuality(ack: string | undefined, titles: string[], scopes: Array<string | null>): void {
  const visibleText = [ack || '', ...titles, ...scopes.map((scope) => scope || '')]
  if (visibleText.some((text) => containsPromptInstructionLeak(text))) {
    console.warn('[Plan] Planner visible text may contain copied prompt wording; accepting model-authored plan instead of blocking startup.')
  }
}

function conciseTopicLabel(topic: string | null | undefined): string {
  return humanTopicLabel(topic, 'the requested topic')
}

function conciseRequestSubject(messages: Array<{ role: string; content: string }>): string {
  return requestSubject(messages)
}

const STEP_COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}

function parseStepCountToken(token: string | undefined): number | null {
  if (!token) return null
  const normalized = token.toLowerCase()
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : STEP_COUNT_WORDS[normalized]
  return parsed && parsed >= 1 && parsed <= 10 ? parsed : null
}

function parseVisibleStepCountInstruction(instructions?: string): number | null {
  if (!instructions) return null
  const text = instructions.toLowerCase()
  const countToken = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)'
  const patterns = [
    new RegExp(`\\b(?:exactly|always\\s+use|use|make|create|keep|show|display|plan\\s+with|visible\\s+plan\\s+with)\\s+(?:a\\s+)?${countToken}[-\\s]*(?:step|steps|phase|phases)\\b`, 'i'),
    new RegExp(`\\b${countToken}[-\\s]*(?:step|steps|phase|phases)\\b`, 'i'),
    new RegExp(`\\b(?:step|phase)\\s*count\\s*(?:is|=|:|of)?\\s*${countToken}\\b`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) continue
    const prefix = text.slice(Math.max(0, match.index - 24), match.index)
    if (/\b(?:no|not|never|avoid|without|don't|dont|do\s+not)\s+$/.test(prefix)) continue
    return parseStepCountToken(match[1])
  }
  return null
}

function requestedTargetLabel(
  messages: Array<{ role: string; content: string }> | undefined,
  defaultLabel = 'the requested task',
): string {
  if (!messages) return defaultLabel
  const request = effectiveTaskRequest(messages)
  const urlOrDomain = request.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/i)?.[0]
  if (urlOrDomain) return urlOrDomain.replace(/^https?:\/\//i, '').replace(/\/$/, '')

  return requestSubject(messages) || defaultLabel
}

function nonDeliverableStepGuidance(
  state: AgentStateData,
  stepTitle: string | undefined,
  taskComplexity: number,
): string {
  const strategyGuidance = state.strategyConfig?.stepGuidance
  const explicitToolConstraint = explicitTaskToolConstraintFromText(state.originalUserRequest)
  if (explicitToolConstraint) {
    const required = explicitToolConstraint.required.map(explicitTaskToolTargetLabel).join(', ')
    const exclusive = explicitToolConstraint.exclusive.map(explicitTaskToolTargetLabel).join(', ')
    const forbidden = explicitToolConstraint.forbidden.map(explicitTaskToolTargetLabel).join(', ')
    return [
      'RULES:',
      '- Preserve the user’s stated step order and explicit named-tool instructions.',
      required ? `- Required at least once before normal tool freedom resumes: ${required}.` : '',
      exclusive ? `- Exclusive allowed tool scope for every action: ${exclusive}.` : '',
      forbidden ? `- Forbidden tool scope: ${forbidden}.` : '',
      '- Safety, permissions, and actual tool availability still override these instructions.',
      '- If a required/allowed named tool is unavailable, report that concrete blocker instead of silently substituting another tool.',
    ].filter(Boolean).join('\n')
  }
  const fixedSearchLimit = currentStepWebSearchLimit(state) ?? (currentStepHasSingleWebSearchLimit(state) ? 1 : null)
  if (fixedSearchLimit !== null) {
    return `RULES:\n- User limited this phase to exactly ${fixedSearchLimit} web_search call${fixedSearchLimit === 1 ? '' : 's'}; this overrides normal depth.\n- Call web_search exactly ${fixedSearchLimit} time${fixedSearchLimit === 1 ? '' : 's'}, then advance. Do NOT browse, scroll, read pages/documents, or run extra searches.\n- Answer/create from those snippets plus existing context only.`
  }

  if (state.uploadedAttachmentContextAvailable && /\b(uploaded|attached|attachment|attachments|file|document|pdf|summari[sz]e|review|analy[sz]e|what is this|read)\b/i.test(`${stepTitle || ''} ${state.originalUserRequest || ''}`)) {
    return `RULES:\n- Uploaded attachment phase: use the uploaded attachment content already loaded in conversation context.\n- Do NOT web_search the attachment filename/title. Do NOT use read_file for uploaded attachment names; read_file is only for workspace/sandbox files created during the task.\n- If attachment content is available, answer or synthesize from it. If no extracted text/visual content is available, report that this uploaded file could not be read from the provided content.\n- Use web/browsing only if the user explicitly asked for outside/current information beyond the attachment.`
  }

  if ((state.taskStrategy === 'build' || state.taskStrategy === 'code') && isWebsitePreviewStep(stepTitle || '')) {
    return `RULES:\n- Dedicated website verification: inspect the generated local preview now with browser_screenshot/browser_scroll.\n- Use read_file/edit_file only for targeted fixes; create missing initial files only if genuinely absent.\n- Do NOT skip because preview opened during file writes. Do NOT change the Computer browser viewport or aspect ratio.`
  }

  if (isConcreteBuildStep(state.taskStrategy, stepTitle)) {
    return `RULES:\n- Build now with create_file, append_file, edit_file, export_pdf, or read_file.\n- Website/app builds: create the initial layout, page, globals, and needed components before advancing; app/layout.tsx must import './globals.css'. Verification is for running/preview/fixes, not first-time file creation.\n- Do NOT browse generic design articles/templates. After file tools start, do NOT write future-tense status; call the next tool, report a concrete blocker, or finish.\n- ${strategyGuidance?.deliverable || 'Create the actual working artifact.'}`
  }

  if (state.taskStrategy === 'build' || state.taskStrategy === 'code') {
    return `RULES:\n- Build support only: gather specific facts/assets needed for the requested build.\n- Prefer image_search for requested assets. Do NOT browse generic design articles/templates unless asked.\n- ${strategyGuidance?.research || 'Gather only necessary inputs, then move on.'}`
  }

  if (state.taskStrategy === 'creative') {
    return `RULES:\n- This is a long-form writing step. Save concrete prose to files now.\n- For novels/books, write chapter or section files in chunks (for example chapters/01-title.md), then later collate them into the final manuscript.\n- Use create_file for a new chapter/outline file and append_file for continuation chunks. Do NOT keep long prose only in the reply.`
  }

  if (state.taskStrategy === 'browse') {
    return `RULES:\n- Website action step: use browser tools to complete the live page interaction, not research.\n- If the user gave a URL/domain, navigate directly first; do NOT web_search known destinations unless direct navigation failed or hit a blocker.\n- Before browser_type, confirm a fresh input/textarea/contenteditable [N] is focused or click it first. Treat visible validation/errors as page state to fix before submit/advance/success.\n- For multi-target flows, work one concrete item, field, or choice at a time. For option groups, follow page order and use TARGET HINTS/screenshot markers for visual controls.\n- Do NOT write reports/guides/failure summaries while controls remain. Do not repeat unchanged clicks; inspect state, scroll, or choose another visible control.\n- Block only on hard blockers: login, payment, CAPTCHA, unavailable inventory, access denied, or hard site error.`
  }

  const noteGuidance = ''
  const depth = researchDepthProfileForState(state)
  return `RULES:\n- Research this step's specific goal; do not start by continuing a previous phase's page.\n- Current depth profile: ${depth.label}; this phase should usually reach about ${depth.requiredCalls} research actions and ${depth.requiredSourceBreadth} distinct source domains unless the user explicitly limited scope or real blockers make that impossible.\n- Tool caps are ceilings, never targets. Do not try to use all available searches/extractions; stop as soon as the phase has the evidence packet its scope requires.\n- Use enough strong source actions to satisfy the request's actual depth. Prefer web_search plus read_document/http extraction for normal research pages; use browser_navigate only when rendered state, screenshots, interaction, or page scripts are needed.\n- Add source actions for comparison coverage, current claims, contradictions, named entities, or evidence gaps; stop when the phase has a credible evidence packet, not when an arbitrary small count is reached.\n- Extract concrete evidence from pages you open: dates, pricing, benchmarks, API/docs facts, caveats, contradictions, or product claims. Do not advance from titles alone.\n- Unpack the angle before advancing: mechanism/why, concrete evidence, example or comparison, limitation/counterpoint, and implication when relevant. If one part is missing, fill that gap rather than opening another generic source.\n- For comparisons, cover each named entity or record the source gap.\n- Use the hidden task research log as compact memory before web_search/read_document/extraction; avoid obvious repeats unless asked to revisit/refresh/monitor.\n- ${strategyGuidance?.research || 'Search targeted queries, read the strongest pages with read_document first, and use the full browser only when rendering matters.'}${noteGuidance}\n- Report findings in response text. Do NOT append raw source lists or lead with .md note creation.`
}

function planAwareIterationFloor(
  state: AgentStateData,
  numSteps: number,
  taskComplexity: number,
): number {
  if (numSteps <= 0) return 0

  const complexity = taskComplexity as 1 | 2 | 3
  const nonFinalSteps = Math.max(0, numSteps - 1)
  const fixedOverhead = 6

  if (state.taskStrategy === 'build' || state.taskStrategy === 'code') {
    const buildStepFloor = Math.max(MIN_STEP_BUDGET + 10, 18)
    const deliverableFloor = Math.max(MIN_DELIVERABLE_BUDGET + 16, 30)
    return fixedOverhead + (nonFinalSteps * buildStepFloor) + deliverableFloor
  }

  if (state.taskStrategy === 'browse') {
    const browserStepFloor = Math.max(MIN_STEP_BUDGET + 8, 16)
    const finalReportFloor = Math.max(MIN_DELIVERABLE_BUDGET + 6, 18)
    return fixedOverhead + (nonFinalSteps * browserStepFloor) + finalReportFloor
  }

  const researchCalls = researchDepthProfileForState(state).requiredCalls ||
    MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ||
    6
  const expectedVisibleActions = researchCalls + 1
  const narrationTurns = Math.ceil(expectedVisibleActions / 3)
  const researchStepFloor = Math.max(
    MIN_STEP_BUDGET + 3,
    expectedVisibleActions + narrationTurns + 3,
  )
  const deliverableFloor = Math.max(MIN_DELIVERABLE_BUDGET + 4, 12)

  return fixedOverhead + (nonFinalSteps * researchStepFloor) + deliverableFloor
}

export class PlanManager {
  private emitter: AgentEventEmitter
  private messages: Array<{ role: string; content: string }>
  private planPromise: Promise<null> | null = null
  private taskComplexity: number
  private requiredFirstSteps: RequiredPlanStep[]
  private customInstructions?: string
  private recordUsage?: PlanUsageRecorder
  private preflightCredit?: PlanCreditPreflight
  private skipAcknowledgement: boolean
  private usageSequence = 0
  private acknowledgementEmitted = false
  private acknowledgementPromise: Promise<boolean> | null = null
  private acknowledgementDisplayPromise: Promise<boolean> | null = null
  private resolveAcknowledgementDisplay: ((emitted: boolean) => void) | null = null
  private acknowledgementDisplayResolved = false
  private acknowledgementFirstVisiblePromise: Promise<boolean> | null = null
  private resolveAcknowledgementFirstVisible: ((emitted: boolean) => void) | null = null
  private acknowledgementFirstVisibleResolved = false
  private suppressFurtherAcknowledgementDeltas = false
  private acknowledgementUsageError: unknown = null
  private plannerDeadlineAtMs = 0
  private plannerAbortController: AbortController | null = null
  private externalSignal?: AbortSignal
  private removeExternalAbortListener: (() => void) | null = null
  constructor(
    emitter: AgentEventEmitter,
    messages: Array<{ role: string; content: string }>,
    taskComplexity: number = 2,
    requiredFirstSteps: RequiredPlanStep[] = [],
    customInstructions?: string,
    recordUsage?: PlanUsageRecorder,
    preflightCredit?: PlanCreditPreflight,
    skipAcknowledgement = false,
    externalSignal?: AbortSignal,
  ) {
    this.emitter = emitter
    this.messages = messages
    this.taskComplexity = taskComplexity
    this.requiredFirstSteps = requiredFirstSteps
    this.customInstructions = customInstructions?.trim() || undefined
    this.recordUsage = recordUsage
    this.preflightCredit = preflightCredit
    this.skipAcknowledgement = skipAcknowledgement
    this.externalSignal = externalSignal
    this.resetPlannerAbortController()
  }

  private resetPlannerAbortController(): AbortController {
    this.removeExternalAbortListener?.()
    this.removeExternalAbortListener = null
    this.plannerAbortController?.abort()
    const plannerAbortController = new AbortController()
    this.plannerAbortController = plannerAbortController
    if (this.externalSignal?.aborted) {
      plannerAbortController.abort(this.externalSignal.reason)
    } else if (this.externalSignal) {
      const abortPlanner = () => plannerAbortController.abort(this.externalSignal?.reason)
      this.externalSignal.addEventListener('abort', abortPlanner, { once: true })
      this.removeExternalAbortListener = () => this.externalSignal?.removeEventListener('abort', abortPlanner)
    }
    return plannerAbortController
  }

  startPlanCall(): void {
    console.log('[AgentDiagnostics] Planner scheduled', {
      complexity: this.taskComplexity,
      messages: this.messages.length,
      hasCustomInstructions: !!this.customInstructions,
    })
    const plannerAbortController = this.resetPlannerAbortController()
    if (!this.skipAcknowledgement && !this.acknowledgementPromise) {
      this.acknowledgementDisplayResolved = false
      this.acknowledgementDisplayPromise = new Promise<boolean>((resolve) => {
        this.resolveAcknowledgementDisplay = resolve
      })
      this.acknowledgementFirstVisibleResolved = false
      this.acknowledgementFirstVisiblePromise = new Promise<boolean>((resolve) => {
        this.resolveAcknowledgementFirstVisible = resolve
      })
      this.acknowledgementPromise = this.emitModelGeneratedAcknowledgement('task')
        .then((emitted) => {
          this.settleAcknowledgementFirstVisible(emitted)
          this.settleAcknowledgementDisplay(emitted)
          return emitted
        })
        .catch((error) => {
          if (this.plannerWasAborted()) {
            this.acknowledgementUsageError = error
          } else if (error instanceof PlannerUsageRecordingError) {
            this.acknowledgementUsageError = error.originalError
          } else if (isBillableUsageError(error)) {
            this.acknowledgementUsageError = error
          }
          console.warn('[AgentDiagnostics] Startup acknowledgement call failed', {
            error: sanitizePlannerError(error),
          })
          this.settleAcknowledgementFirstVisible(false)
          this.settleAcknowledgementDisplay(false)
          return false
        })
    }
    const start = async (): Promise<null> => {
      if (PLAN_STARTUP_DELAY_MS > 0) {
        await this.waitForPlannerDelay(PLAN_STARTUP_DELAY_MS)
      }
      this.plannerDeadlineAtMs = Date.now() + PLANNER_OVERALL_DEADLINE_MS
      return null
    }
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    this.planPromise = start()
      .then(() => {
        deadlineTimer = setTimeout(() => plannerAbortController.abort(), PLANNER_OVERALL_DEADLINE_MS)
        return this.attemptPlanCall(0, true)
      })
      .then(async (result) => {
        await this.acknowledgementPromise
        if (this.acknowledgementUsageError) throw this.acknowledgementUsageError
        return result
      })
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer)
      })
    // The loop attaches its authoritative await a little later. Observe early
    // rejection now so an immediate abort/provider failure is never reported as
    // an unhandled promise while preserving the rejection on planPromise.
    void this.planPromise.catch(() => undefined)
  }

  dispose(): void {
    this.removeExternalAbortListener?.()
    this.removeExternalAbortListener = null
    this.plannerAbortController?.abort()
    this.plannerAbortController = null
    this.settleAcknowledgementFirstVisible(false)
    this.settleAcknowledgementDisplay(false)
  }

  usePrecomputedPlan(
    state: AgentStateData,
    plan: { items: string[]; scopes?: Array<string | null> },
    options: { emitPlan?: boolean } = {},
  ): boolean {
    const titles = (plan.items || [])
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
      .slice(0, 8)
    if (titles.length === 0) return false

    const scopes = titles.map((_, index) => {
      const scope = plan.scopes?.[index]
      return typeof scope === 'string' && scope.trim() ? scope.trim() : null
    })
    const alignedScopes = this.alignScopesToTitles(titles, scopes)
    const compacted = this.compactSourceEvidencePhasesForTask(titles, alignedScopes, state.taskStrategy)
    const withCustomRequirements = this.applyCustomInstructionPlanRequirements(compacted.titles, compacted.scopes)
    const withRequired = this.applyRequiredFirstSteps(withCustomRequirements.titles, withCustomRequirements.scopes)

    if (options.emitPlan !== false) this.emitter.plan(withRequired.titles)
    state.planItems = withRequired.titles
    state.planScopes = withRequired.scopes
    state.planEmitted = true
    this.planPromise = Promise.resolve(null)
    console.log('[AgentDiagnostics] Using route startup plan for worker', {
      steps: withRequired.titles.length,
      emitted: options.emitPlan !== false,
    })
    return true
  }

  private settleAcknowledgementFirstVisible(emitted: boolean): void {
    if (this.acknowledgementFirstVisibleResolved) return
    this.acknowledgementFirstVisibleResolved = true
    this.resolveAcknowledgementFirstVisible?.(emitted)
    this.resolveAcknowledgementFirstVisible = null
  }

  private settleAcknowledgementDisplay(emitted: boolean): void {
    if (this.acknowledgementDisplayResolved) return
    this.acknowledgementDisplayResolved = true
    this.resolveAcknowledgementDisplay?.(emitted)
    this.resolveAcknowledgementDisplay = null
  }

  async awaitPlan(state: AgentStateData): Promise<void> {
    if (!state.planEmitted && this.planPromise && (state.iterations <= 1 || state.currentPlanItems === null)) {
      const startedAt = Date.now()
      console.log('[AgentDiagnostics] Awaiting planner', {
        iteration: state.iterations,
        hasCurrentPlan: !!state.currentPlanItems,
        emitterClosed: this.emitter.isClosed,
      })
      await this.planPromise
      console.log('[AgentDiagnostics] Planner await finished', {
        durationMs: Date.now() - startedAt,
        planEmitted: state.planEmitted,
        steps: state.currentPlanItems?.length || 0,
        emitterClosed: this.emitter.isClosed,
      })
    }
  }

  private async recordCompletionUsage(usage: RawCompletionUsage, label: string): Promise<void> {
    const normalized = normalizeCompletionUsage(usage)
    if (!normalized) throw new Error(BILLABLE_USAGE_ERROR)

    this.usageSequence += 1
    console.log(`[COST:PLAN] ${label} in=${normalized.promptTokens} out=${normalized.completionTokens} cost=$${(normalized.cost || 0).toFixed(6)}`)
    try {
      await this.recordUsage?.(normalized, `plan:${label}:${this.usageSequence}`)
    } catch (error) {
      throw new PlannerUsageRecordingError(error)
    }
  }

  private async assertCreditRunway(label: string): Promise<void> {
    await this.preflightCredit?.(label)
  }

  private plannerRequestTimeoutMs(preferredMs: number): number {
    if (!this.plannerDeadlineAtMs) return preferredMs
    const remainingMs = this.plannerDeadlineAtMs - Date.now()
    if (remainingMs <= 250) {
      throw new Error(`Assistant request timed out after ${Math.round(PLANNER_OVERALL_DEADLINE_MS / 1000)} seconds.`)
    }
    return Math.max(250, Math.min(preferredMs, remainingMs - 150))
  }

  private waitForPlannerDelay(delayMs: number): Promise<void> {
    const signal = this.plannerAbortController?.signal
    if (!signal) return new Promise(resolve => setTimeout(resolve, delayMs))
    if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, delayMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private plannerWasAborted(): boolean {
    return this.externalSignal?.aborted === true || this.plannerAbortController?.signal.aborted === true
  }

  private throwIfPlannerAborted(): void {
    if (this.plannerWasAborted()) {
      throw new DOMException('The planner was aborted.', 'AbortError')
    }
  }

  private async emitModelGeneratedAcknowledgement(taskShape: string, priorInvalidAck?: string): Promise<boolean> {
    if (this.emitter.isClosed || this.acknowledgementEmitted) return false
    const ackStartedAt = Date.now()
    const request = effectiveTaskRequest(this.messages).slice(0, 1000)
    console.log('[AgentDiagnostics] Startup acknowledgement call starting', {
      taskShape,
      requestChars: request.length,
      retry: !!priorInvalidAck,
    })
    await this.assertCreditRunway('ack')
    const afterCreditAt = Date.now()
    const stream = await createStreamingCompletion({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system' as const,
          content: `Write exactly one short, direct acknowledgement paragraph for Agent before it starts a ${taskShape} task.
Requirements:
- One very brief paragraph, one or two short sentences, 12-38 words total.
- Use plain words. Avoid fancy, inflated or formal phrasing.
- Specific to the user's concrete target/topic/artifact and requested output.
- Say what Agent will actually do for this task and the final answer/artifact shape.
- Before writing, silently identify the real target, requested deliverable, likely work areas, and any important constraints. Output only the final paragraph.
- Extract the real topic/artifact first. Do not echo command wrappers such as "research about", "conduct the deepest possible research on", "write a report on", or "produce a concise report".
- Direct first-person phrasing like "I'll..." is allowed when specific. Do not start with "Let me", "Next", or "Now".
- No generic lines such as "I'll open the site", "I'll keep the steps updated", "I'll research this", or "I'll work through this".
- No markdown, no bullets, no refusal, no mention of being an AI.`,
        },
        {
          role: 'user' as const,
          content: priorInvalidAck
            ? `USER REQUEST:\n${request}\n\nINVALID ACK TO REPLACE:\n${priorInvalidAck}\n\nWrite a better task-specific acknowledgement paragraph.`
            : request,
        },
      ],
      temperature: 0.4,
      max_tokens: PLANNER_ACK_MAX_TOKENS,
      reasoning: PLANNER_ACK_REASONING,
      includeTemporalContext: false,
      stream_options: { include_usage: true },
      requestTimeoutMs: PLANNER_ACK_STREAM_TIMEOUT_MS,
      retryMaxAttempts: 0,
      abortSignal: this.plannerAbortController?.signal,
    })
    console.log('[AgentDiagnostics] Startup acknowledgement stream opened', {
      elapsedMs: Date.now() - ackStartedAt,
      creditPreflightMs: afterCreditAt - ackStartedAt,
    })

    let ack = ''
    let firstBuffer = ''
    let pendingVisibleAck = ''
    let startedVisibleText = false
    let emittedAny = false
    let ownsVisibleAcknowledgement = false
    let usage: RawCompletionUsage

    const emitVisible = async (content: string) => {
      if (!content || this.emitter.isClosed) return
      if (this.suppressFurtherAcknowledgementDeltas) return
      if (this.acknowledgementEmitted && !ownsVisibleAcknowledgement) return
      if (this.emitter.isClosed) return
      if (this.suppressFurtherAcknowledgementDeltas) return
      if (this.acknowledgementEmitted && !ownsVisibleAcknowledgement) return
      ownsVisibleAcknowledgement = true
      this.settleAcknowledgementFirstVisible(true)
      this.emitter.textDelta(content)
      this.acknowledgementEmitted = true
      emittedAny = true
    }

    const flushPendingVisibleAck = async (force = false) => {
      if (!pendingVisibleAck) return
      const compact = pendingVisibleAck.replace(/\s+/g, ' ')
      const trimmed = compact.trim()
      if (!trimmed) {
        pendingVisibleAck = ''
        return
      }
      const endsCleanly = /[.!?]\s*$/.test(trimmed)
      const hasUsefulClause = trimmed.length >= PLANNER_ACK_FOLLOWUP_FLUSH_CHARS && /\s$/.test(pendingVisibleAck)
      if (!force && !endsCleanly && !hasUsefulClause) return
      await emitVisible(compact)
      pendingVisibleAck = ''
    }

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      const delta = streamingChunkText(chunk)
      if (!delta) continue
      ack += delta

      if (startedVisibleText) {
        pendingVisibleAck += delta
        await flushPendingVisibleAck(false)
        continue
      }

      firstBuffer += delta
      const cleanedFirst = sanitizePlannerAck(firstBuffer)
      const hasCompleteSentence = cleanedFirst.length >= PLANNER_ACK_FIRST_FLUSH_CHARS &&
        ackWordCount(cleanedFirst) >= PLANNER_ACK_FIRST_FLUSH_WORDS &&
        /[.!?]\s*$/.test(cleanedFirst)
      const readyToFlush = hasCompleteSentence
      if (readyToFlush) {
        startedVisibleText = true
        await emitVisible(cleanedFirst)
        console.log('[AgentDiagnostics] Startup acknowledgement first visible text emitted', {
          elapsedMs: Date.now() - ackStartedAt,
          chars: cleanedFirst.length,
        })
      }
    }

    await flushPendingVisibleAck(true)

    if (!startedVisibleText) {
      const cleaned = sanitizePlannerAck(firstBuffer || ack)
      if (cleaned) await emitVisible(cleaned)
    }

    if (emittedAny && ownsVisibleAcknowledgement && !this.emitter.isClosed) {
      this.emitter.textDelta('\n\n')
      this.settleAcknowledgementDisplay(true)
    }

    const sanitizedAck = sanitizePlannerAck(ack.trim())
    await this.recordCompletionUsage(usage, 'ack')
    this.throwIfPlannerAborted()

    if (emittedAny) {
      if (!isUsablePlannerAck(sanitizedAck)) {
        console.warn('[AgentDiagnostics] Startup acknowledgement streamed but failed post-hoc quality check', {
          length: sanitizedAck.length,
          taskShape,
        })
      }
      console.log('[AgentDiagnostics] Startup acknowledgement complete', {
        elapsedMs: Date.now() - ackStartedAt,
        chars: sanitizedAck.length,
      })
      return true
    }

    this.settleAcknowledgementDisplay(false)
    throw new Error(PLANNER_QUALITY_ERROR)
  }

  private async emitAcknowledgement(ack: string | undefined, taskShape: string): Promise<void> {
    if (this.skipAcknowledgement) return

    if (this.acknowledgementEmitted) {
      this.suppressFurtherAcknowledgementDeltas = true
      this.settleAcknowledgementDisplay(true)
      return
    }

    if (this.acknowledgementDisplayPromise) {
      const displayed = await Promise.race([
        this.acknowledgementDisplayPromise,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), PLANNER_ACK_DISPLAY_WAIT_MS)),
      ])
      if (this.acknowledgementEmitted || displayed) {
        this.suppressFurtherAcknowledgementDeltas = true
        return
      }
    }

    const sanitized = typeof ack === 'string' ? sanitizePlannerAck(ack) : ''
    if (isUsablePlannerAck(sanitized)) {
      this.emitter.textDelta(sanitized + '\n\n')
      this.acknowledgementEmitted = true
      return
    }

    if (this.acknowledgementPromise) {
      const emitted = await Promise.race([
        this.acknowledgementPromise,
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), PLANNER_ACK_DISPLAY_WAIT_MS)),
      ])
      if (this.acknowledgementEmitted || emitted) return
    }

    this.suppressFurtherAcknowledgementDeltas = true
    this.settleAcknowledgementDisplay(false)
  }

  getStepInjection(state: AgentStateData, iterationLimit: number): { role: string; content: string } | null {
    const resolvedPlan = state.planItems as string[] | null
    const resolvedScopes = state.planScopes as (string | null)[] | null
    if (resolvedPlan && resolvedPlan.length > 0) {
      const taskIntent = analyzeTaskIntent(this.messages)
      const quickInlineAnswer = taskIntent.wantsQuick &&
        !taskIntent.explicitSavedArtifact &&
        !taskDefaultsToMarkdownDeliverable(effectiveTaskRequest(this.messages))
      const singleStepNeedsSavedArtifact = !quickInlineAnswer && (
        taskIntent.explicitSavedArtifact ||
        taskDefaultsToMarkdownDeliverable(effectiveTaskRequest(this.messages)) ||
        state.buildTask ||
        state.taskStrategy === 'build' ||
        state.taskStrategy === 'creative'
      )
      const isFirstStepDeliverable = resolvedPlan.length === 1 && singleStepNeedsSavedArtifact
      const imageOnlyStep = resolvedPlan.length === 1 &&
        isImageRetrievalStep(resolvedPlan[0], resolvedScopes?.[0])
      // Use strategy-specific step guidance when available
      const strategyGuidance = state.strategyConfig?.stepGuidance
      const stepGuidance = imageOnlyStep
        ? `RULES:\n- This is a direct image retrieval step. Call image_search once with the user's requested subject.\n- When image_search downloads or returns images, you are DONE. Do NOT add separate browser, selection, file, or compile steps.`
        : isFirstStepDeliverable
        ? `RULES:\n- This is the deliverable step. ${strategyGuidance?.deliverable || 'Create the actual final output file using create_file and append_file for large output. If the user requested PDF, export the completed source with export_pdf. Do NOT write a summary or outline — produce the real deliverable.'}\n- For long manuscripts, assemble/collate chapter files into deliverables/final-manuscript.md instead of trying one giant write.\n- When the file is created and complete, you are DONE.`
        : nonDeliverableStepGuidance(state, resolvedPlan[0], this.taskComplexity)
      const msg = {
        role: 'system',
        content: buildStepMessage(resolvedPlan, 0, this.withCustomInstructionGuidance(stepGuidance), undefined, this.taskComplexity, state.taskStrategy, resolvedScopes?.[0] ?? undefined),
      }
      state.currentPlanItems = resolvedPlan
      state.currentPlanScopes = resolvedScopes
      state.currentStepIdx = 0
      state.stepIterationCount = 0
      state.phaseNarrationEmittedThisStep = false
      updatePhase(state)
      setWorkLedgerObjective(state, resolvedPlan[0])
      setWorkLedgerRequirements(state, this.buildInitialRequirements(resolvedPlan, resolvedScopes))

      // Weighted step budgets: scale by task complexity and task strategy.
      // Research-heavy tasks need enough budget to keep later phases substantive;
      // build/code tasks still reserve more room for the artifact and verification.
      const complexityMultiplier = COMPLEXITY_BUDGET_MULTIPLIERS[this.taskComplexity as keyof typeof COMPLEXITY_BUDGET_MULTIPLIERS] || 1.0
      const researchBudgetMultiplier = state.strategyConfig?.researchBudgetMultiplier ?? RESEARCH_STEP_BUDGET_MULTIPLIER
      const deliverableBudgetFraction = state.strategyConfig?.deliverableBudgetFraction ?? DELIVERABLE_BUDGET_FRACTION
      const numSteps = resolvedPlan.length
      const planFloor = planAwareIterationFloor(state, numSteps, this.taskComplexity)
      const boundedPlanFloor = Math.min(planFloor, MAX_ITERATIONS)
      if (boundedPlanFloor > state.dynamicIterationLimit) {
        state.dynamicIterationLimit = boundedPlanFloor
        console.log(`[Plan] Expanded iteration limit for ${numSteps} planned steps: ${boundedPlanFloor}${planFloor > boundedPlanFloor ? ` (capped from ${planFloor})` : ''}`)
      }
      const effectiveIterationLimit = Math.max(iterationLimit, state.dynamicIterationLimit)
      if (numSteps === 1) {
        const iterationsForWork = Math.floor(effectiveIterationLimit * deliverableBudgetFraction)
        state.perStepBudget = iterationsForWork
        state.deliverableStepBudget = iterationsForWork
      } else {
        const iterationsForWork = Math.floor(effectiveIterationLimit * deliverableBudgetFraction)
        const baseBudget = iterationsForWork / numSteps
      const requiredResearchCalls = researchDepthProfileForState(state).requiredCalls
      const researchCadenceBudget = requiredResearchCalls + Math.ceil(requiredResearchCalls / 3) + 1
      const strategyStepFloor = state.taskStrategy === 'build' || state.taskStrategy === 'code'
        ? MIN_STEP_BUDGET + 4
        : state.taskStrategy === 'analysis' || state.taskStrategy === 'browse'
          ? MIN_STEP_BUDGET + 2
          : MIN_STEP_BUDGET
      const researchBudget = Math.max(strategyStepFloor, researchCadenceBudget, Math.floor(baseBudget * researchBudgetMultiplier * complexityMultiplier))
        const researchTotal = researchBudget * (numSteps - 1)
        const deliverableBudget = Math.max(MIN_DELIVERABLE_BUDGET, iterationsForWork - researchTotal)
        state.perStepBudget = researchBudget
        state.deliverableStepBudget = deliverableBudget
      }
      console.log(`[Plan] Budgets: perStep=${state.perStepBudget}, deliverable=${state.deliverableStepBudget}, strategy=${state.taskStrategy}, researchMultiplier=${researchBudgetMultiplier}, complexity=${this.taskComplexity}x${complexityMultiplier}`)
      state.planItems = null // Only inject once
      return msg
    }
    return null
  }

  completePreloadedFirstSteps(state: AgentStateData): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return messages

    for (const step of this.requiredFirstSteps) {
      if (!step.preloaded) continue
      const currentTitle = state.currentPlanItems[state.currentStepIdx] || ''
      if (currentTitle !== step.title && !isPreloadedReadStep(currentTitle)) continue

      if (step.kind === 'attachment') {
        const attachmentName = step.label || step.title.replace(/^(?:Read uploaded attachments?|Visually inspect uploaded images?):\s*/i, '').trim() || 'uploaded attachment'
        const id = `attachment_read_${state.currentStepIdx}`
        this.emitter.toolStart(id, 'read_attachment', {
          name: attachmentName,
          path: attachmentName,
          plan_step_index: state.currentStepIdx + 1,
        })
        this.emitter.toolResult(id, 'read_attachment', {
          action: 'read',
          path: attachmentName,
          content: step.contentPreview || 'Uploaded attachment content was loaded into the agent context.',
        } satisfies FileResult)
        satisfyWorkLedgerRequirement(state, 'Uploaded attachment content loaded before work', [
          'uploaded attachment content',
          'uploaded image visual content',
          'uploaded image visual input',
          'attachment content loaded',
          'read uploaded attachment',
          'read and load selected skill/file',
        ])
      } else {
        const skillName = step.label || step.title.replace(/^Read selected skill files?:\s*/i, '').trim() || 'selected skill'
        const id = `skill_read_${state.currentStepIdx}`
        this.emitter.toolStart(id, 'read_skill', {
          name: skillName,
          path: `${skillName}.skill`,
        })
        this.emitter.toolResult(id, 'read_skill', {
          action: 'read',
          path: `${skillName}.skill`,
          content: 'Selected skill content was loaded into the agent context before any research, browsing, coding, or writing.',
        } satisfies FileResult)
        satisfyWorkLedgerRequirement(state, 'Selected skill/file loaded before work', [
          'read and load selected skill/file',
          'selected skill/file content',
          'skill/file content',
          'read selected skill',
        ])
      }
      this.emitter.stepAdvance()
      const nextStepMessage = this.handleStepAdvance(state)
      if (nextStepMessage) messages.push(nextStepMessage)
    }

    return messages
  }

  handleStepAdvance(state: AgentStateData): { role: string; content: string } | null {
    if (!state.currentPlanItems || state.currentPlanItems.length === 0) return null

    // Guard against double-advance: don't advance if already past the end
    if (state.currentStepIdx >= state.currentPlanItems.length) {
      return {
        role: 'system',
        content: `ALL PLAN STEPS ARE COMPLETE. You are DONE. ${NATURAL_FINAL_RESPONSE_GUIDANCE} Do not create, edit, browse, or research further.`,
      }
    }

    // Use advanceStep() so we get findings capture, semantic-loop reset, AND
    // updatePhase() — without updatePhase, currentPhase stays 'research' which
    // caps max_tokens at 1024 and applies the wrong tool filter.
    advanceStep(state)
    setWorkLedgerObjective(state)

    if (state.currentStepIdx >= state.currentPlanItems.length) {
      return {
        role: 'system',
        content: `ALL PLAN STEPS ARE COMPLETE. You are DONE. ${NATURAL_FINAL_RESPONSE_GUIDANCE} Do not create, edit, browse, or research further.`,
      }
    }
    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    const sg = state.strategyConfig?.stepGuidance
    const taskIntent = analyzeTaskIntent(this.messages)
    const lastStepNeedsSavedArtifact =
      taskIntent.explicitSavedArtifact ||
      taskDefaultsToMarkdownDeliverable(effectiveTaskRequest(this.messages)) ||
      state.buildTask ||
      state.taskStrategy === 'build' ||
      state.taskStrategy === 'creative'
    const stepHint = isLastStep
      ? lastStepNeedsSavedArtifact
        ? `This is the DELIVERABLE step — the most important step. ${sg?.deliverable || 'Create the actual final output file using create_file and append_file for large output. If the user requested PDF, export the completed source with export_pdf. Do NOT write a summary or outline — produce the real deliverable.'} For long manuscripts, collate chapter files into the final manuscript. When the file is complete, you are DONE.`
        : 'This is the final answer step. Deliver the requested answer directly in chat from completed work. Do not create a file unless the user explicitly requested one.'
      : nonDeliverableStepGuidance(state, state.currentPlanItems[state.currentStepIdx], this.taskComplexity)
    return {
      role: 'system',
      content: buildStepMessage(
        state.currentPlanItems,
        state.currentStepIdx,
        this.withCustomInstructionGuidance(stepHint),
        undefined,
        this.taskComplexity,
        state.taskStrategy,
        state.currentPlanScopes?.[state.currentStepIdx] ?? undefined,
      ),
    }
  }

  private plannerStepArrays(steps: PlannerStep[] | undefined): { titles: string[]; scopes: (string | null)[] } | null {
    if (!Array.isArray(steps)) return null
    if (steps.length === 0) return { titles: [], scopes: [] }

    const allStrings = steps.every(item => typeof item === 'string')
    if (allStrings) {
      const titles = (steps as string[])
        .map(step => step.trim())
        .filter(Boolean)
      return { titles, scopes: titles.map(() => null) }
    }

    const allObjects = steps.every(item => item && typeof item === 'object' && typeof (item as { title?: string }).title === 'string')
    if (!allObjects) return null

    const pairs = (steps as Array<{ title?: string; scope?: string | null }>)
      .map(step => ({
        title: (step.title || '').trim(),
        scope: typeof step.scope === 'string' && step.scope.trim() ? step.scope.trim() : null,
      }))
      .filter(step => step.title)

    return {
      titles: pairs.map(step => step.title),
      scopes: pairs.map(step => step.scope),
    }
  }

  private applyPlannerMetadata(state: AgentStateData, obj: PlannerResponseObject): TaskType {
    const validTypes = new Set(['research', 'action', 'build', 'code', 'creative', 'analysis', 'general'])
    const requestedType = obj.taskType && typeof obj.taskType === 'string' && validTypes.has(obj.taskType)
      ? obj.taskType
      : null
    const mappedTaskType = requestedType === 'action'
      ? 'browse'
      : (requestedType || state.taskStrategy) as TaskType

    if (typeof obj.complexity === 'number' && obj.complexity >= 1 && obj.complexity <= 5) {
      const llmComplexity = obj.complexity
      const mapped = llmComplexity <= 1 ? 1 : llmComplexity <= 3 ? 2 : 3
      if (mapped > this.taskComplexity) {
        console.log(`[Plan] Agent complexity ${llmComplexity} (mapped ${mapped}) upgrades regex guess ${this.taskComplexity}`)
        this.taskComplexity = mapped
        state.taskComplexity = mapped
      } else if (mapped < this.taskComplexity) {
        console.log(`[Plan] Keeping higher regex complexity ${this.taskComplexity} over planner ${llmComplexity} (mapped ${mapped})`)
      }
    }

    if (requestedType && state.taskStrategy !== mappedTaskType) {
      console.log(`[Plan] Agent taskType "${requestedType}" -> strategy "${mappedTaskType}" (was "${state.taskStrategy}")`)
      this.applyStrategyOverride(state, mappedTaskType)
    }

    return mappedTaskType
  }

  private async repairPlannerResponse(raw: string, qualityIssue?: string): Promise<PlannerResponseObject | null> {
    if (this.emitter.isClosed) return null
    try {
      const request = effectiveTaskRequest(this.messages).slice(0, 3000)
      const qualityContext = qualityIssue
        ? `\nQUALITY FAILURE TO FIX:\n${qualityIssue}\nThe previous planner output may have been valid JSON, but it failed the runtime quality gate. Generate a fresh, task-specific acknowledgement and task-specific steps now.`
        : ''
      const params = {
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'system' as const,
            content: `Repair an invalid task-planner response into a valid JSON object only.
Schema:
{"ack":"very brief direct acknowledgement paragraph","taskType":"research"|"action"|"build"|"code"|"creative"|"analysis"|"general","complexity":1-5,"steps":[{"title":"5-15 word task-specific step","scope":"non-overlapping step scope"}]}

Rules:
- Return only JSON. No markdown, prose, or code fence.
- First extract the user's actual target/topic/artifact and requested output. Treat command wrappers such as "research about", "conduct the deepest possible research on", "write a report on", "produce a concise report", and "answer whether" as instructions, not as the topic.
- Preserve explicit user-authored steps in their stated order. Carry required, exclusive, and forbidden named-tool instructions into every relevant scope and do not insert substitute phases that violate them.
- Do not use a canned generic plan. Every title and scope must mention or clearly reflect the user's concrete topic, site, artifact, fields, or deliverable.
- Never copy a long user command phrase into the ack, step titles, scopes, or search labels.
- The ack must be one very brief direct paragraph, one or two short sentences and 12-38 words, using plain words and saying what Agent will do for the exact task and what it will deliver.
- Step count is flexible: do not default to 3 or 4 steps, do not use fixed ranges, and do not shrink substantive work into a tiny plan.
- Scopes must be compact, usually 10-22 words. Preserve depth through the phase goal, not long scope prose.
- Research work starts after the plan with targeted web_search calls chosen by the agent for the current evidence gap, then read_document/browser tools for rich sources.
- "code" means the user asked to write, modify, debug, run, or deploy code. A question or research request about code, code generation, developer tools, or software behaviour is research/general unless it asks for code changes or a code artifact.
- A request for current, external, citation-backed, credible, official, or primary-source evidence must put evidence gathering before final synthesis. Never combine evidence gathering and delivery into its only step; choose task-specific phase wording.
- Saved custom instructions still apply and supersede default planner behavior for process, tools, source rules, files, format, narration, verification, and visible step count. They do not supersede safety, permissions, sandbox/tool availability, or core runtime rules. If they specify a fixed phase count such as "three-step" or "4 phases", honor that visible count unless the latest user request or a higher-priority runtime/safety rule requires otherwise.
- If saved custom instructions require todo.md or another tracking file, preserve that support step; otherwise do not invent tracking files.
- If the broken response contains useful task details, preserve them. If it does not, derive a specific plan from the user request.
- Use 0 steps only for a trivial non-tool answer. Otherwise use enough task-specific steps for the requested work.`,
          },
          {
            role: 'user' as const,
          content: `USER REQUEST:\n${request}\n${this.customInstructionPlanningContext()}${qualityContext}\n\nBROKEN PLANNER RESPONSE:\n${raw.slice(0, 4000) || '(empty response)'}`,
          },
        ],
        temperature: 0.1,
        max_tokens: this.plannerJsonMaxTokens(),
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
        requestTimeoutMs: this.plannerRequestTimeoutMs(PLANNER_REPAIR_REQUEST_TIMEOUT_MS),
        retryMaxAttempts: 0,
        abortSignal: this.plannerAbortController?.signal,
      }
      let res
      try {
        await this.assertCreditRunway('repair')
        res = await createCompletion({
          ...params,
          response_format: { type: 'json_object' },
        })
      } catch (e) {
        const status = (e as { status?: number })?.status
        if (status !== 400 && status !== 422) throw e
        console.warn('[Plan] Planner repair JSON mode rejected; retrying repair without response_format')
        await this.assertCreditRunway('repair-retry')
        res = await createCompletion(params)
      }
      await this.recordCompletionUsage(res.usage, 'repair')
      this.throwIfPlannerAborted()
      const repaired = res.choices[0]?.message?.content?.trim() || ''
      console.log(`[Plan] Planner repair response received (${repaired.length} chars)`)
      return parsePlannerResponse(repaired)
    } catch (e) {
      if (this.plannerWasAborted()) throw e
      if (e instanceof PlannerUsageRecordingError) throw e.originalError
      if (isBillableUsageError(e)) throw e
      console.error('[Plan] Planner repair failed:', e)
      return null
    }
  }

  private plannerJsonMaxTokens(): number {
    const request = effectiveTaskRequest(this.messages)
    if (this.taskComplexity <= 1 && request.length < 1200) return PLANNER_SIMPLE_JSON_MAX_TOKENS
    if (this.taskComplexity <= 2 && request.length < 2200) return PLANNER_MEDIUM_JSON_MAX_TOKENS
    return PLANNER_JSON_MAX_TOKENS
  }

  private async emitParsedPlan(state: AgentStateData, obj: PlannerResponseObject): Promise<boolean> {
    const arrays = this.plannerStepArrays(obj.steps)
    if (!arrays) return false

    const mappedTaskType = this.applyPlannerMetadata(state, obj)

    if (arrays.titles.length === 0) {
      if (
        mappedTaskType !== 'general' ||
        this.requiredFirstSteps.length > 0 ||
        this.customInstructionsRequestTrackingFile()
      ) {
        return false
      }
      await this.emitAcknowledgement(obj.ack, mappedTaskType)
      this.throwIfPlannerAborted()
      state.planItems = null
      state.planScopes = null
      state.currentPlanItems = null
      state.currentPlanScopes = null
      state.planEmitted = true
      return true
    }

    const enforcedTitles = this.enforceMinSteps(arrays.titles)
    const enforcedScopes = enforcedTitles.length === arrays.scopes.length
      ? arrays.scopes
      : enforcedTitles.map((_, index) => arrays.scopes[index] ?? null)
    const alignedScopes = this.alignScopesToTitles(enforcedTitles, enforcedScopes)
    const compacted = this.compactSourceEvidencePhasesForTask(enforcedTitles, alignedScopes, mappedTaskType)
    const withCustomRequirements = this.applyCustomInstructionPlanRequirements(compacted.titles, compacted.scopes)
    const withRequired = this.applyRequiredFirstSteps(withCustomRequirements.titles, withCustomRequirements.scopes)
    assertPlannerVisibleTextQuality(obj.ack, withRequired.titles, withRequired.scopes)

    await this.emitAcknowledgement(obj.ack, mappedTaskType)
    this.throwIfPlannerAborted()
    this.emitter.plan(withRequired.titles)
    state.planItems = withRequired.titles
    state.planScopes = withRequired.scopes
    state.planEmitted = true
    return true
  }

  private async emitParsedPlanWithModelRepair(
    state: AgentStateData,
    raw: string,
    initialPlan: PlannerResponseObject | null,
  ): Promise<boolean> {
    let candidate = initialPlan
    let repairInput = raw
    let qualityIssue = initialPlan ? PLANNER_QUALITY_ERROR : undefined

    for (let repairAttempt = 0; repairAttempt <= PLANNER_QUALITY_REPAIR_ATTEMPTS; repairAttempt++) {
      if (candidate) {
        try {
          const emitted = await this.emitParsedPlan(state, candidate)
          if (emitted) return true
        } catch (qualityError) {
          if (!isPlannerQualityError(qualityError)) throw qualityError
          qualityIssue = PLANNER_QUALITY_ERROR
        }
      } else {
        qualityIssue = qualityIssue || PLANNER_QUALITY_ERROR
      }

      if (this.emitter.isClosed || state.planEmitted) return true
      if (repairAttempt >= PLANNER_QUALITY_REPAIR_ATTEMPTS) break

      const serializedCandidate = stringifyPlannerResponseForRepair(candidate)
      const nextRepairInput = serializedCandidate || repairInput || `USER REQUEST:\n${effectiveTaskRequest(this.messages).slice(0, 3000)}`
      const repaired = await this.repairPlannerResponse(nextRepairInput, qualityIssue)
      if (!repaired) {
        repairInput = nextRepairInput
        continue
      }

      candidate = repaired
      repairInput = stringifyPlannerResponseForRepair(repaired) || nextRepairInput
      qualityIssue = PLANNER_QUALITY_ERROR
    }

    return false
  }

  private async attemptPlanCall(attempt = 0, relaxedJsonMode = false): Promise<null> {
    const state = this._stateRef
    const fastPlannerMode = relaxedJsonMode && attempt === 0
    try {
      console.log('[AgentDiagnostics] Planner call starting', {
        attempt: attempt + 1,
        complexity: this.taskComplexity,
        messages: this.messages.length,
        emitterClosed: this.emitter.isClosed,
        fastPlannerMode,
      })
      const params = {
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'system' as const,
            content: fastPlannerMode
              ? getFastPlanningPrompt(this.customInstructions)
              : getPlanningPrompt(this.customInstructions),
          },
          ...plannerTaskMessages(this.messages),
        ],
        temperature: fastPlannerMode ? 0.2 : 0.3,
        max_tokens: fastPlannerMode ? PLANNER_FAST_JSON_MAX_TOKENS : this.plannerJsonMaxTokens(),
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
        requestTimeoutMs: this.plannerRequestTimeoutMs(fastPlannerMode
          ? PLANNER_FAST_JSON_REQUEST_TIMEOUT_MS
          : relaxedJsonMode
          ? PLANNER_RELAXED_JSON_REQUEST_TIMEOUT_MS
          : PLANNER_JSON_REQUEST_TIMEOUT_MS),
        retryMaxAttempts: 0,
        abortSignal: this.plannerAbortController?.signal,
      }
      let res
      try {
        await this.assertCreditRunway('initial')
        res = await createCompletion({
          ...params,
          response_format: { type: 'json_object' },
        })
      } catch (e) {
        const status = (e as { status?: number })?.status
        console.error('[AgentDiagnostics] Planner JSON-mode call failed', {
          attempt: attempt + 1,
          status,
          error: sanitizePlannerError(e),
        })
        if (status !== 400 && status !== 422) throw e
        console.warn('[Plan] Planner JSON mode rejected; retrying planner without response_format')
        await this.assertCreditRunway('initial-retry')
        res = await createCompletion(params)
      }
      console.log('[AgentDiagnostics] Planner call returned', {
        attempt: attempt + 1,
        hasUsage: !!res.usage,
        choices: res.choices?.length || 0,
        emitterClosed: this.emitter.isClosed,
      })
      await this.recordCompletionUsage(res.usage, 'initial')
      this.throwIfPlannerAborted()
      const raw = res.choices[0]?.message?.content?.trim() || ''
      console.log(`[Plan] Planner response received (${raw.length} chars)`)
      if (state && !state.planEmitted && !this.emitter.isClosed) {
        const parsedPlan = parsePlannerResponse(raw)
        if (fastPlannerMode && !parsedPlan) throw new Error(PLANNER_FAST_PARSE_MISS)
        const emitted = await this.emitParsedPlanWithModelRepair(state, raw, parsedPlan)
        if (emitted) return null

        throw plannerRepairExhaustedError()
      }
      return null
    } catch (e) {
      if (e instanceof PlannerUsageRecordingError) throw e.originalError
      const status = (e as { status?: number })?.status
      if (status === 429 && attempt < PLAN_MAX_RETRIES) {
        const backoff = PLAN_RETRY_BASE_MS * (attempt + 1) + Math.random() * 500
        console.log(`[Plan] 429 on attempt ${attempt + 1}, retrying in ${Math.round(backoff)}ms`)
        await this.waitForPlannerDelay(backoff)
        return this.attemptPlanCall(attempt + 1)
      }
      if (e instanceof Error && e.message === PLANNER_REPAIR_EXHAUSTED_ERROR && attempt < PLAN_MAX_RETRIES) {
        const backoff = PLAN_RETRY_BASE_MS * (attempt + 1)
        console.log(`[Plan] Planner quality repair exhausted on attempt ${attempt + 1}, retrying fresh planner call in ${Math.round(backoff)}ms`)
        await this.waitForPlannerDelay(backoff)
        return this.attemptPlanCall(attempt + 1)
      }
      if (e instanceof Error && e.message === PLANNER_FAST_PARSE_MISS) {
        console.log('[Plan] Fast planner missed parseable JSON; retrying strict planner immediately')
        return this.attemptPlanCall(attempt, false)
      }
      if (isPlannerRequestTimeout(e) && attempt < PLANNER_TIMEOUT_RECOVERY_RETRIES) {
        const backoff = fastPlannerMode ? 25 : 100
        console.log(`[Plan] Planner start timed out on attempt ${attempt + 1}, retrying strict planner mode in ${backoff}ms`)
        await this.waitForPlannerDelay(backoff)
        return this.attemptPlanCall(attempt + 1, false)
      }
      if (isBillableUsageError(e)) throw e
      console.error('[AgentDiagnostics] Planner call failed', {
        attempt: attempt + 1,
        status,
        emitterClosed: this.emitter.isClosed,
        error: sanitizePlannerError(e),
      })
      console.error('[Plan] Planning call failed:', e)
      throw e
    }
  }

  /**
   * Mid-plan replanning: when the agent encounters too many failures on a step,
   * or discovers the plan needs adjustment, insert/modify remaining steps.
   */
  async replan(state: AgentStateData, reason: string): Promise<boolean> {
    if (!state.currentPlanItems || state.replanCount >= REPLAN_MAX_RETRIES) return false

    const completedSteps = state.currentPlanItems.slice(0, state.currentStepIdx)
    const currentStep = state.currentPlanItems[state.currentStepIdx]
    const remainingSteps = state.currentPlanItems.slice(state.currentStepIdx + 1)

    try {
      const customInstructionContext = this.customInstructionPlanningContext()
      await this.assertCreditRunway('replan')
      const res = await createCompletion({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'system' as const,
            content: `You are a task planning assistant. The user's original plan needs adjustment.

COMPLETED STEPS: ${completedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
CURRENT STEP (having issues): ${state.currentStepIdx + 1}. ${currentStep}
REMAINING STEPS: ${remainingSteps.map((s, i) => `${state.currentStepIdx + 2 + i}. ${s}`).join('\n')}

REASON FOR REPLANNING: ${reason}
${customInstructionContext}

Generate an updated list of remaining steps (including a revised current step if needed). Return ONLY a JSON array of strings. Keep it concise (3-6 steps max). The steps should be actionable and specific.`,
          },
          ...plannerTaskMessages(this.messages),
        ],
        temperature: 0.3,
        max_tokens: REPLAN_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
        requestTimeoutMs: PLANNER_REPLAN_REQUEST_TIMEOUT_MS,
        retryMaxAttempts: 0,
        abortSignal: this.plannerAbortController?.signal,
      })

      await this.recordCompletionUsage(res.usage, 'replan')
      this.throwIfPlannerAborted()
      const raw = res.choices[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const newSteps = JSON.parse(jsonMatch[0]) as string[]
        if (Array.isArray(newSteps) && newSteps.length > 0 && newSteps.every(s => typeof s === 'string')) {
          // Replace remaining plan from current step onward
          const updatedPlan = [...completedSteps, ...newSteps]
          state.currentPlanItems = updatedPlan
          // Replan currently returns titles only — pad scopes with nulls so the
          // parallel arrays stay 1:1. Future enhancement: have replan ask for scopes too.
          if (state.currentPlanScopes) {
            const completedScopes = state.currentPlanScopes.slice(0, state.currentStepIdx)
            state.currentPlanScopes = [...completedScopes, ...newSteps.map(() => null)]
          }
          state.replanCount++
          state.stepFailureCount = 0
          updatePhase(state)
          setWorkLedgerObjective(state)
          setWorkLedgerRequirements(state, this.buildInitialRequirements(updatedPlan, state.currentPlanScopes || null))

          // Recalculate budgets for remaining steps
          const remainingIterations = state.dynamicIterationLimit - state.iterations
          const remainingStepCount = newSteps.length
          if (remainingStepCount > 1) {
            const baseBudget = Math.floor(remainingIterations / remainingStepCount)
            state.perStepBudget = Math.max(MIN_STEP_BUDGET, baseBudget)
            state.deliverableStepBudget = Math.max(MIN_DELIVERABLE_BUDGET, remainingIterations - (baseBudget * (remainingStepCount - 1)))
          }

          this.emitter.plan(updatedPlan)
          console.log(`[Plan] Replanned: ${updatedPlan.length} steps (replan #${state.replanCount})`)
          return true
        }
      }
    } catch (e) {
      if (this.plannerWasAborted()) throw e
      if (e instanceof PlannerUsageRecordingError) throw e.originalError
      if (isBillableUsageError(e)) throw e
      console.error('[Plan] Replan failed:', e)
    }
    return false
  }

  /**
   * Keep planner output structurally valid without locally fabricating missing
   * phases. The LLM owns the plan shape; this method intentionally avoids
   * local step-count or template vetoes that can deadlock startup.
   */
  private enforceMinSteps(steps: string[]): string[] {
    return steps
  }

  private customInstructionsRequestTrackingFile(): boolean {
    if (!this.customInstructions) return false
    return /\b(?:todo\.md|to-do\.md|tracking file|task tracking|progress file|checklist\.md|plan\.md)\b/i.test(this.customInstructions)
  }

  private customInstructionVisibleStepCount(): number | null {
    return parseVisibleStepCountInstruction(this.customInstructions)
  }

  private compactSourceEvidencePhasesForTask(
    titles: string[],
    scopes: Array<string | null>,
    taskType: string | undefined,
  ): { titles: string[]; scopes: Array<string | null> } {
    const eligibleResearchTask = taskType === 'research' || taskType === 'analysis'
    if (!eligibleResearchTask) return { titles, scopes }

    const request = effectiveTaskRequest(this.messages)
    const fixedVisibleCount = this.customInstructionVisibleStepCount() ?? parseVisibleStepCountInstruction(request)
    const explicitlySeparateSourcePhases = /\b(?:separate|distinct|individual)\s+(?:(?:source|research|evidence)[-\s]*)?(?:steps|phases)\b/i.test(request)

    return compactAdjacentSourceEvidencePhases(titles, scopes, {
      preserveVisibleStepCount: fixedVisibleCount !== null || explicitlySeparateSourcePhases,
    })
  }

  private applyCustomInstructionPlanRequirements(
    titles: string[],
    scopes: (string | null)[],
  ): { titles: string[]; scopes: (string | null)[] } {
    if (!this.customInstructionsRequestTrackingFile()) return { titles, scopes }

    const alreadyHasTracking = titles.some((title, index) =>
      /\b(?:todo\.md|to-do\.md|tracking file|task tracking|progress file|checklist\.md|plan\.md)\b/i.test(`${title} ${scopes[index] || ''}`)
    )
    if (alreadyHasTracking) return { titles, scopes }

    const target = requestedTargetLabel(this.messages)
    const fixedVisibleCount = this.customInstructionVisibleStepCount()
    if (fixedVisibleCount !== null && titles.length >= fixedVisibleCount && titles.length > 0) {
      return {
        titles: [`Create todo.md and begin ${conciseTopicLabel(target)}`, ...titles.slice(1)],
        scopes: [
          `Create the todo.md support file requested by saved custom instructions for "${target}". Then complete the original first phase: ${scopes[0] || titles[0]}.`,
          ...scopes.slice(1),
        ],
      }
    }

    return {
      titles: [`Create todo.md for ${target}`, ...titles],
      scopes: [
        `Create the todo.md support file requested by saved custom instructions for "${target}". Use it only for task tracking; it is not the final deliverable.`,
        ...scopes,
      ],
    }
  }

  private applyRequiredFirstSteps(
    titles: string[],
    scopes: (string | null)[],
  ): { titles: string[]; scopes: (string | null)[] } {
    const pairs = titles.map((title, index) => ({
      title,
      scope: scopes[index] ?? null,
    }))
    const normalizedPairs = this.requiredFirstSteps.length > 0
      ? pairs.filter((pair) => !this.requiredFirstSteps.some((step) =>
          pair.title === step.title ||
          (step.kind === 'skill' && isSkillReadStep(pair.title))
        ))
      : pairs
    const normalizedTitles = normalizedPairs.map((pair) => pair.title)
    const normalizedScopes = normalizedPairs.map((pair) => pair.scope)
    if (this.requiredFirstSteps.length === 0) return { titles: normalizedTitles, scopes: normalizedScopes }

    const nextTitles = [...normalizedTitles]
    const nextScopes = [...normalizedScopes]

    for (const step of [...this.requiredFirstSteps].reverse()) {
      nextTitles.unshift(step.title)
      nextScopes.unshift(step.scope)
    }

    return { titles: nextTitles, scopes: nextScopes }
  }

  private alignScopesToTitles(titles: string[], scopes: (string | null)[]): (string | null)[] {
    if (!isBrowserActionTask(this.messages)) {
      return titles.map((_, index) => scopes[index] ?? null)
    }

    return titles.map((title, index) => {
      const scope = scopes[index]
      const scopeLooksResearchy = scope && /\b(research|investigate|analyze|compare|source|sources|evidence|guide|article|report)\b/i.test(scope)
      if (scope && !scopeLooksResearchy) return scope

      return 'Complete this browser-flow step only. Use live page controls and fresh elements; do not research or write a guide in this phase.'
    })
  }

  private applyStrategyOverride(state: AgentStateData, type: TaskType): void {
    const strategy = getStrategy(type)
    state.taskStrategy = strategy.type
    state.strategyConfig = strategy
    state.tierTimeouts = computeTimeouts(strategy)
    state.buildTask = strategy.type === 'build' || strategy.type === 'code'
    updatePhase(state)
    setWorkLedgerObjective(state)
  }

  private buildInitialRequirements(titles: string[], scopes: (string | null)[] | null): string[] {
    const requirements: string[] = []

    if (this.requiredFirstSteps.length > 0) {
      requirements.push('Read and load selected skill/file content before research or implementation')
    }

    if (this.requiredFirstSteps.some((step) => step.kind === 'attachment')) {
      requirements.push('Use uploaded attachment content before any filename search or workspace file read')
    }

    if (this.requiredFirstSteps.some((step) => step.kind === 'attachment' && step.visualInput)) {
      requirements.push('Use uploaded image visual input directly before any browser or current-view inspection')
    }

    if (isWebsiteBuildTask(this.messages)) {
      requirements.push('Create complete runnable website files')
      requirements.push('Boot local preview')
      requirements.push('Visually verify the current browser rendering')
      requirements.push('Repair blank or broken preview before completion')
    }

    if (isBrowserActionTask(this.messages)) {
      requirements.push('Use visual screenshot state plus fresh indexed controls')
      requirements.push('Verify the final browser state or a concrete hard blocker')
    }

    const previewScope = scopes?.find((scope, index) => scope && isWebsitePreviewStep(titles[index] || ''))
    if (previewScope) requirements.push(previewScope)

    const lastTitle = titles[titles.length - 1]
    if (lastTitle) requirements.push(`Final phase: ${lastTitle}`)

    return requirements
  }

  /**
   * Information-triggered replanning: when new information contradicts the plan
   * or the current approach is unproductive, replan with learned context.
   *
   * Guarded by: replan count cap, minimum iterations, and cooldown period.
   */
  async informationTriggeredReplan(
    state: AgentStateData,
    trigger: {
      type: 'contradiction' | 'assumption_invalidated'
      description: string
      workingMemorySnapshot: string
    },
  ): Promise<boolean> {
    // Guard: replan cap
    if (state.replanCount >= REPLAN_MAX_RETRIES) return false
    // Guard: too early
    if (state.iterations < INFO_REPLAN_MIN_ITERATIONS) return false
    // Guard: cooldown
    if (state.infoReplanCooldown > 0) return false

    if (!state.currentPlanItems) return false

    const completedSteps = state.currentPlanItems.slice(0, state.currentStepIdx)
    const currentStep = state.currentPlanItems[state.currentStepIdx]
    const remainingSteps = state.currentPlanItems.slice(state.currentStepIdx + 1)

    const reasonText = trigger.type === 'contradiction'
      ? 'Facts discovered during research contradict an assumption in the current plan.'
      : 'The current approach is not productive — learned information suggests a different path.'

    try {
      const customInstructionContext = this.customInstructionPlanningContext()
      await this.assertCreditRunway('info-replan')
      const res = await createCompletion({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: 'system' as const,
            content: `You are a task planning assistant. New information has changed the situation.

COMPLETED STEPS: ${completedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') || '(none)'}
CURRENT STEP: ${state.currentStepIdx + 1}. ${currentStep}
REMAINING STEPS: ${remainingSteps.map((s, i) => `${state.currentStepIdx + 2 + i}. ${s}`).join('\n') || '(none)'}

NEW INFORMATION: ${trigger.description}

WORKING MEMORY:
${trigger.workingMemorySnapshot || '(no facts collected yet)'}

REASON FOR REPLANNING: ${reasonText}
${customInstructionContext}

Generate an updated list of remaining steps (starting from a revised current step). Return ONLY a JSON array of strings. Keep it concise (3-6 steps max). The steps should account for what was learned.`,
          },
          ...plannerTaskMessages(this.messages),
        ],
        temperature: 0.3,
        max_tokens: REPLAN_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
        requestTimeoutMs: PLANNER_REPLAN_REQUEST_TIMEOUT_MS,
        retryMaxAttempts: 0,
        abortSignal: this.plannerAbortController?.signal,
      })

      await this.recordCompletionUsage(res.usage, 'info-replan')
      this.throwIfPlannerAborted()
      const raw = res.choices[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const newSteps = JSON.parse(jsonMatch[0]) as string[]
        if (Array.isArray(newSteps) && newSteps.length > 0 && newSteps.every(s => typeof s === 'string')) {
          const updatedPlan = [...completedSteps, ...newSteps]
          state.currentPlanItems = updatedPlan
          if (state.currentPlanScopes) {
            const completedScopes = state.currentPlanScopes.slice(0, state.currentStepIdx)
            state.currentPlanScopes = [...completedScopes, ...newSteps.map(() => null)]
          }
          state.replanCount++
          state.stepFailureCount = 0
          state.infoReplanCooldown = INFO_REPLAN_COOLDOWN_ITERATIONS
          state.lastInfoReplanIteration = state.iterations
          updatePhase(state)
          setWorkLedgerObjective(state)
          setWorkLedgerRequirements(state, this.buildInitialRequirements(updatedPlan, state.currentPlanScopes || null))

          // Recalculate budgets
          const remainingIterations = state.dynamicIterationLimit - state.iterations
          const remainingStepCount = newSteps.length
          if (remainingStepCount > 1) {
            const baseBudget = Math.floor(remainingIterations / remainingStepCount)
            state.perStepBudget = Math.max(MIN_STEP_BUDGET, baseBudget)
            state.deliverableStepBudget = Math.max(MIN_DELIVERABLE_BUDGET, remainingIterations - (baseBudget * (remainingStepCount - 1)))
          }

          this.emitter.plan(updatedPlan)
          console.log(`[Plan] Info-replan: ${updatedPlan.length} steps (trigger: ${trigger.type}, replan #${state.replanCount})`)
          return true
        }
      }
    } catch (e) {
      if (this.plannerWasAborted()) throw e
      if (e instanceof PlannerUsageRecordingError) throw e.originalError
      if (isBillableUsageError(e)) throw e
      console.error('[Plan] Info-replan failed:', e)
    }
    return false
  }

  // State reference — set by AgentLoop after construction
  private _stateRef: AgentStateData | null = null
  setStateRef(state: AgentStateData): void {
    this._stateRef = state
  }

  private customInstructionPlanningContext(): string {
    if (!this.customInstructions) return ''
    return `
CUSTOM INSTRUCTIONS STILL APPLY:
${this.customInstructions}

Replanning requirement: preserve the user's saved process/order/format, including any saved visible phase/step count, unless the latest user request, a safety/core runtime rule, or a verified blocker requires a different path. Custom instructions supersede defaults except for safety, permissions, sandbox/tool availability, and core runtime rules.`
  }

  private withCustomInstructionGuidance(guidance: string): string {
    if (!this.customInstructions) return guidance
    return `${guidance}

CUSTOM INSTRUCTIONS TO APPLY IN THIS STEP:
- Treat the saved custom instructions from the root system prompt and current plan as workflow constraints for this step's tools, scope, deliverable shape, and verification.
- Do not let saved custom instructions override safety, permissions, sandbox/tool availability, or core runtime rules.
- If they define a process/order/checklist, follow that process now instead of defaulting to the generic scaffold.
- If they mention a fixed number of steps/phases, treat that count as binding for the visible plan unless a higher-priority rule required this current phase shape.
- If this step cannot follow part of the instructions, state the concrete blocker briefly and continue with the closest compliant path.
Do not ask to see the saved instructions again; they are already present in the root task context.`
  }
}

/**
 * Phase 10 Fix III: an "atomic" step is one that should complete in 1-3 iterations
 * because it's a single navigational, interactional, or page-state verification
 * action. Data-gathering checks are deliberately excluded: "check X for Y" often
 * requires reading, scrolling, filtering, comparing, or otherwise collecting evidence.
 *
 * Used by PolicyEngine.checkAtomicStepDrift to nudge the model to emit <next_step/>
 * when it overruns an atomic step (typically because it tries to do work that belongs
 * to the NEXT step inside the current one).
 */
export function isAtomicStep(stepText: string): boolean {
  const t = stepText.toLowerCase().trim()
  const evidenceGathering = /\b(?:official|signals?|release[-\s]?status|breadcrumbs?|evidence|sources?|references?|research|investigate|details?|facts?|findings?|methodolog(?:y|ies)|criteria|benchmarks?|market|product|policy|risks?|benefits?|compare|analy[sz]e|evaluate|assess|map|survey|compile|collect|gather)\b/.test(t)
  if (evidenceGathering) return false

  // Single-action navigation
  if (/^(navigate|go)\s+(to|directly\s+to)\s+/.test(t)) return true
  if (/^open\s+(the\s+)?(homepage|page|url|site|website)/.test(t)) return true
  if (/^visit\s+\w+\.\w+/.test(t)) return true
  // Single-action page-state verification. Do not classify information-gathering
  // checks like "Check source X for condition Y" as atomic; those need runway.
  if (/^(verify|check|confirm)\s+/.test(t) && t.length < 100) {
    const pageStateTarget = /\b(page|site|url|screen|modal|dialog|banner|popup|form|field|button|control|selection|state|confirmation|success|error|loaded|load|visible|opened|rendered|selected|checked|submitted|complete|completed|downloaded|saved)\b/.test(t)
    const informationGathering = /\b(for|whether|if|when|where|why|how|between|during|compare|consult|research|investigate|look\s+up|find\s+out|search)\b/.test(t)
    if (pageStateTarget && !informationGathering) return true
  }
  // Single-action dismissal
  if (/^(dismiss|close|accept)\s+(the\s+)?(popup|cookie|banner|modal)/.test(t)) return true
  return false
}
