import { createCompletion, DEFAULT_MODEL, type ChatMessageParam } from '@/lib/llm'
import type { FileResult } from '@/types'
import { getPlanningPrompt } from '@/lib/prompts'
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
import { currentStepHasSingleWebSearchLimit, currentStepWebSearchLimit, isSingleWebSearchMarkdownTask } from './taskConstraints'
import type { CreditTokenUsage } from '@/lib/creditPolicy'

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
const PLANNER_ACK_MAX_TOKENS = 128
const PLANNER_JSON_MAX_TOKENS = 1536
const REPLAN_JSON_MAX_TOKENS = 768
const PLANNER_CONTROL_REASONING = { effort: 'minimal' as const, exclude: true }

function redactPlannerErrorText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
    .replace(/\b(?:qwen|openai|anthropic|google|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
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

function isBillableUsageError(error: unknown): boolean {
  return error instanceof Error && error.message === BILLABLE_USAGE_ERROR
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

function isLongWritingTask(messages: Array<{ role: string; content: string }>): boolean {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const text = lastUser?.content?.toLowerCase() || ''
  if (!text) return false

  const asksForWriting = /\b(write|draft|create|generate|make|compose)\b/.test(text)
  const longForm = /\b(novel|book|manuscript|chapters?|story|stories|screenplay|100\s*pages?|50\s*pages?|long[-\s]?form|full[-\s]?length|pdf)\b/.test(text)
  const noResearch = /\b(no research|straight to it|just write|start writing)\b/.test(text)

  return asksForWriting && (longForm || noResearch)
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

function isBuildOrCodeTask(messages: Array<{ role: string; content: string }>): boolean {
  const text = getLatestUserContent(messages)
  if (!text) return false

  if (isWebsiteBuildTask(messages)) return true
  return /\b(build|create|make|develop|implement|code|write|fix|add|update|refactor)\b/.test(text) &&
    /\b(app|application|component|feature|script|function|api|endpoint|class|module|code|typescript|javascript|python|react|next\.?js)\b/.test(text)
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

function isWebsiteDeliverStep(title: string): boolean {
  return /\b(deliver|final|finish|handoff|usage|notes|summary|report what was built)\b/i.test(title)
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

function isUsablePlannerAck(ack: string): boolean {
  const normalized = ack.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.length < 18) return false
  return !/\b(?:i(?:'|’)?ll|i will)\s+(?:open the site|work through this|start with the required|keep the task steps updated)\b/.test(normalized) &&
    !/\b(?:the requested task|the request|the site|the topic)\b.{0,80}\b(?:steps updated|visible steps)\b/.test(normalized)
}

function conciseTopicLabel(topic: string | null | undefined): string {
  const cleaned = (topic || '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, '')
    .trim()
  return cleaned ? cleaned.slice(0, 72) : 'the requested topic'
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

  const cleaned = request
    .replace(/\b(?:please|can you|could you|would you|i need you to|i want you to|make sure to|just)\b/gi, ' ')
    .replace(/\b(?:build|create|make|design|develop|implement|code|write|draft|research|find|open|go to|navigate to|fix|add|update|refactor)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return conciseTopicLabel(cleaned || request || defaultLabel)
}

function nonDeliverableStepGuidance(
  state: AgentStateData,
  stepTitle: string | undefined,
  taskComplexity: number,
): string {
  const strategyGuidance = state.strategyConfig?.stepGuidance
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
  return `RULES:\n- Research this step's specific goal; do not start by continuing a previous phase's page.\n- Use the hidden task research log as compact memory before web_search/navigation/extraction; avoid obvious repeats unless asked to revisit/refresh/monitor.\n- Use the fewest strong source actions needed. Add more only for comparison coverage, current claims, contradictions, or evidence gaps.\n- Extract concrete evidence from pages you open: dates, pricing, benchmarks, API/docs facts, caveats, contradictions, or product claims. Do not advance from titles alone.\n- Unpack the angle before advancing: mechanism/why, concrete evidence, example or comparison, limitation/counterpoint, and implication when relevant. If one part is missing, fill that gap rather than opening another generic source.\n- For comparisons, cover each named entity or record the source gap.\n- ${strategyGuidance?.research || 'Search targeted queries, visit the strongest pages, cross-reference only when it changes the answer.'}${noteGuidance}\n- Report findings in response text. Do NOT append raw source lists or lead with .md note creation.`
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

  const researchCalls = MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ?? 6
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
  private usageSequence = 0

  constructor(
    emitter: AgentEventEmitter,
    messages: Array<{ role: string; content: string }>,
    taskComplexity: number = 2,
    requiredFirstSteps: RequiredPlanStep[] = [],
    customInstructions?: string,
    recordUsage?: PlanUsageRecorder,
    preflightCredit?: PlanCreditPreflight,
  ) {
    this.emitter = emitter
    this.messages = messages
    this.taskComplexity = taskComplexity
    this.requiredFirstSteps = requiredFirstSteps
    this.customInstructions = customInstructions?.trim() || undefined
    this.recordUsage = recordUsage
    this.preflightCredit = preflightCredit
  }

  startPlanCall(): void {
    console.log('[AgentDiagnostics] Planner scheduled', {
      complexity: this.taskComplexity,
      messages: this.messages.length,
      hasCustomInstructions: !!this.customInstructions,
    })
    const start = PLAN_STARTUP_DELAY_MS > 0
      ? new Promise<null>(r => setTimeout(r, PLAN_STARTUP_DELAY_MS))
      : Promise.resolve(null)
    this.planPromise = start.then(() => this.attemptPlanCall())
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
    await this.recordUsage?.(normalized, `plan:${label}:${this.usageSequence}`)
  }

  private async assertCreditRunway(label: string): Promise<void> {
    await this.preflightCredit?.(label)
  }

  private async emitModelGeneratedAcknowledgement(taskShape: string, priorInvalidAck?: string): Promise<boolean> {
    if (this.emitter.isClosed) return false
    const request = effectiveTaskRequest(this.messages).slice(0, 1000)
    await this.assertCreditRunway('ack')
    const res = await createCompletion({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: 'system' as const,
          content: `Write exactly one first-person acknowledgement for Agent before it starts a ${taskShape} task.
Requirements:
- One sentence, <=160 characters.
- Specific to the user's concrete target/topic/artifact.
- No generic lines such as "I'll open the site", "I'll keep the steps updated", or "I'll work through this".
- No markdown, no bullets, no refusal, no mention of being an AI.`,
        },
        {
          role: 'user' as const,
          content: priorInvalidAck
            ? `USER REQUEST:\n${request}\n\nINVALID ACK TO REPLACE:\n${priorInvalidAck}\n\nWrite a better task-specific acknowledgement.`
            : request,
        },
      ],
      temperature: 0.4,
      max_tokens: PLANNER_ACK_MAX_TOKENS,
      reasoning: PLANNER_CONTROL_REASONING,
      includeTemporalContext: false,
    })
    await this.recordCompletionUsage(res.usage, 'ack')
    const ack = sanitizePlannerAck(res.choices[0]?.message?.content?.trim() || '')
    if (isUsablePlannerAck(ack)) {
      this.emitter.textDelta(ack + '\n\n')
      return true
    }
    if (!priorInvalidAck) {
      return this.emitModelGeneratedAcknowledgement(taskShape, ack || '(empty acknowledgement)')
    }
    throw new Error(PLANNER_QUALITY_ERROR)
  }

  private async emitAcknowledgement(ack: string | undefined, taskShape: string): Promise<void> {
    const sanitized = typeof ack === 'string' ? sanitizePlannerAck(ack) : ''
    if (isUsablePlannerAck(sanitized)) {
      this.emitter.textDelta(sanitized + '\n\n')
      return
    }

    const emitted = await this.emitModelGeneratedAcknowledgement(taskShape)
    if (!emitted && !this.emitter.isClosed) throw new Error(PLANNER_QUALITY_ERROR)
  }

  getStepInjection(state: AgentStateData, iterationLimit: number): { role: string; content: string } | null {
    const resolvedPlan = state.planItems as string[] | null
    const resolvedScopes = state.planScopes as (string | null)[] | null
    if (resolvedPlan && resolvedPlan.length > 0) {
      const isFirstStepDeliverable = resolvedPlan.length === 1
      const imageOnlyStep = isFirstStepDeliverable && isImageRetrievalStep(resolvedPlan[0], resolvedScopes?.[0])
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
      const requiredResearchCalls = MIN_RESEARCH_CALLS_BY_COMPLEXITY[this.taskComplexity as keyof typeof MIN_RESEARCH_CALLS_BY_COMPLEXITY] ?? 3
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
          action_label: step.visualInput ? 'Load uploaded image visual input' : 'Load uploaded attachment content',
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
        content: 'ALL PLAN STEPS ARE COMPLETE. You are DONE. Write a natural final response, then STOP. Use plain paragraphs or bullets only when they genuinely help the user. Do not force **Summary** or **Deliverables** headings. If files/artifacts exist, mention they are attached below in one short sentence. Include concrete results, caveats, or next steps only when useful. Do not create, edit, browse, or research further.',
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
        content: 'ALL PLAN STEPS ARE COMPLETE. You are DONE. Write a natural final response, then STOP. Use plain paragraphs or bullets only when they genuinely help the user. Do not force **Summary** or **Deliverables** headings. If files/artifacts exist, mention they are attached below in one short sentence. Include concrete results, caveats, or next steps only when useful. Do not create, edit, browse, or research further.',
      }
    }
    const isLastStep = state.currentStepIdx === state.currentPlanItems.length - 1
    const sg = state.strategyConfig?.stepGuidance
    const stepHint = isLastStep
      ? `This is the DELIVERABLE step — the most important step. ${sg?.deliverable || 'Create the actual final output file using create_file and append_file for large output. If the user requested PDF, export the completed source with export_pdf. Do NOT write a summary or outline — produce the real deliverable.'} For long manuscripts, collate chapter files into the final manuscript. When the file is complete, you are DONE.`
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
      if (mapped !== this.taskComplexity) {
        console.log(`[Plan] Agent complexity ${llmComplexity} (mapped ${mapped}) overrides regex guess ${this.taskComplexity}`)
        this.taskComplexity = mapped
        state.taskComplexity = mapped
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
{"ack":"task-specific acknowledgement","taskType":"research"|"action"|"build"|"code"|"creative"|"analysis"|"general","complexity":1-5,"steps":[{"title":"5-15 word task-specific step","scope":"non-overlapping step scope"}]}

Rules:
- Return only JSON. No markdown, prose, or code fence.
- Do not use a canned generic plan. Every title and scope must mention or clearly reflect the user's concrete topic, site, artifact, fields, or deliverable.
- Step count is flexible: do not default to 3 or 4 steps. Use 1-2 steps for simple tasks, 3-5 for multi-faceted tasks, and 5+ only for deep/large tasks.
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
        max_tokens: PLANNER_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
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
      const repaired = res.choices[0]?.message?.content?.trim() || ''
      console.log(`[Plan] Planner repair response received (${repaired.length} chars)`)
      return parsePlannerResponse(repaired)
    } catch (e) {
      if (isBillableUsageError(e)) throw e
      console.error('[Plan] Planner repair failed:', e)
      return null
    }
  }

  private async emitParsedPlan(state: AgentStateData, obj: PlannerResponseObject): Promise<boolean> {
    const arrays = this.plannerStepArrays(obj.steps)
    if (!arrays) return false

    const mappedTaskType = this.applyPlannerMetadata(state, obj)

    if (arrays.titles.length === 0) {
      await this.emitAcknowledgement(obj.ack, mappedTaskType)
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
    const withCustomRequirements = this.applyCustomInstructionPlanRequirements(enforcedTitles, alignedScopes)
    const withRequired = this.applyRequiredFirstSteps(withCustomRequirements.titles, withCustomRequirements.scopes)

    await this.emitAcknowledgement(obj.ack, mappedTaskType)
    this.emitter.plan(withRequired.titles)
    state.planItems = withRequired.titles
    state.planScopes = withRequired.scopes
    state.planEmitted = true
    return true
  }

  private async attemptPlanCall(attempt = 0): Promise<null> {
    const state = this._stateRef
    try {
      console.log('[AgentDiagnostics] Planner call starting', {
        attempt: attempt + 1,
        complexity: this.taskComplexity,
        messages: this.messages.length,
        emitterClosed: this.emitter.isClosed,
      })
      const params = {
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system' as const, content: getPlanningPrompt(this.customInstructions) },
          ...this.messages as ChatMessageParam[],
        ],
        temperature: 0.3,
        max_tokens: PLANNER_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
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
      const raw = res.choices[0]?.message?.content?.trim() || ''
      console.log(`[Plan] Planner response received (${raw.length} chars)`)
      if (state && !state.planEmitted && !this.emitter.isClosed) {
        const parsedPlan = parsePlannerResponse(raw) || await this.repairPlannerResponse(raw)
        if (parsedPlan) {
          try {
            const emitted = await this.emitParsedPlan(state, parsedPlan)
            if (emitted) return null
          } catch (qualityError) {
            if (!isPlannerQualityError(qualityError)) throw qualityError
            const repaired = await this.repairPlannerResponse(raw, PLANNER_QUALITY_ERROR)
            if (repaired) {
              const emitted = await this.emitParsedPlan(state, repaired)
              if (emitted) return null
            }
          }
        }

        throw new Error(PLANNER_QUALITY_ERROR)
      }
      return null
    } catch (e) {
      const status = (e as { status?: number })?.status
      if (status === 429 && attempt < PLAN_MAX_RETRIES) {
        const backoff = PLAN_RETRY_BASE_MS * (attempt + 1) + Math.random() * 500
        console.log(`[Plan] 429 on attempt ${attempt + 1}, retrying in ${Math.round(backoff)}ms`)
        await new Promise(r => setTimeout(r, backoff))
        return this.attemptPlanCall(attempt + 1)
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
          ...this.messages as ChatMessageParam[],
        ],
        temperature: 0.3,
        max_tokens: REPLAN_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
      })

      await this.recordCompletionUsage(res.usage, 'replan')
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
      if (isBillableUsageError(e)) throw e
      console.error('[Plan] Replan failed:', e)
    }
    return false
  }

  /**
   * Keep planner output structurally valid without locally fabricating missing
   * phases. Quality failures throw so the model repair path can produce a
   * fresh task-specific plan.
   */
  private enforceMinSteps(steps: string[]): string[] {
    // Complexity 1 (trivial) can have any number of steps.
    if (this.taskComplexity <= 1) return steps
    if (steps.length === 1 && isImageRetrievalStep(steps[0])) return steps
    if (isSingleWebSearchMarkdownTask(this.messages)) {
      if (steps.length !== 2) throw new Error(PLANNER_QUALITY_ERROR)
      const [searchStep, deliverableStep] = steps
      const searchOnlyStep = /\b(?:web[_\s-]?search|search)\b/i.test(searchStep) &&
        !/\b(?:browse|browser|open|visit|read page|scroll|navigate)\b/i.test(searchStep)
      const markdownDeliverableStep = /\b(?:markdown|\.md|report|file|deliverable|write|create|save)\b/i.test(deliverableStep)
      if (!searchOnlyStep || !markdownDeliverableStep) throw new Error(PLANNER_QUALITY_ERROR)
      return steps
    }
    if (this.customInstructionVisibleStepCount() !== null && steps.length > 0) return steps

    if (isBrowserActionTask(this.messages)) {
      if (steps.length === 0) throw new Error(PLANNER_QUALITY_ERROR)
      if (steps.length === 1) throw new Error(PLANNER_QUALITY_ERROR)

      const repaired = steps.map((step) => {
        const lower = step.toLowerCase()
        const isResearchShaped = /\b(research|investigate|analyze|compare|gather sources|find sources|source evidence|write guide|compile guide)\b/.test(lower)
        const isActionShaped = /\b(navigate|open|visit|click|select|choose|fill|type|submit|verify|download|upload|book|reserve|continue|confirm|complete|interact)\b/.test(lower)
        if (isResearchShaped && !isActionShaped) throw new Error(PLANNER_QUALITY_ERROR)
        return step
      })

      const hasFinalVerification = /\b(verify|confirm|report|final|deliver)\b/i.test(repaired[repaired.length - 1] || '')
      if (!hasFinalVerification) {
        throw new Error(PLANNER_QUALITY_ERROR)
      }
      return repaired
    }

    if (isBuildOrCodeTask(this.messages)) {
      if (steps.length === 0) throw new Error(PLANNER_QUALITY_ERROR)
      if (!isWebsiteBuildTask(this.messages)) {
        if (steps.length === 1) throw new Error(PLANNER_QUALITY_ERROR)
        return steps
      }
      if (steps.length < 3) {
        throw new Error(PLANNER_QUALITY_ERROR)
      }

      const normalizedSteps = steps.map((step) => {
        const lower = step.toLowerCase()
        const suspiciousResearchPadding = /\b(cross[-\s]?validate|additional sources|gather additional|research)\b/.test(lower) &&
          /\b(create|build|code|file|files|next\.?js|app\/|layout|page|globals|component)\b/.test(lower)
        if (!suspiciousResearchPadding) return step
        throw new Error(PLANNER_QUALITY_ERROR)
      })

      if (!isWebsiteBuildTask(this.messages)) return normalizedSteps

      const finalStep = normalizedSteps[normalizedSteps.length - 1]
      const finalIsDeliverOnly = isWebsiteDeliverStep(finalStep) && !isWebsitePreviewStep(finalStep)
      const existingPreviewIdx = normalizedSteps.findIndex((step, index) =>
        index < normalizedSteps.length - 1 && isWebsitePreviewStep(step)
      )
      if (existingPreviewIdx === normalizedSteps.length - 2 && finalIsDeliverOnly) return normalizedSteps
      throw new Error(PLANNER_QUALITY_ERROR)
    }

    if (isLongWritingTask(this.messages) && steps.length === 0) {
      throw new Error(PLANNER_QUALITY_ERROR)
    }

    if (isLongWritingTask(this.messages) && steps.length < 5) {
      throw new Error(PLANNER_QUALITY_ERROR)
    }

    if (steps.length >= 2) return steps

    if (steps.length === 1) {
      throw new Error(PLANNER_QUALITY_ERROR)
    }

    return steps
  }

  private customInstructionsRequestTrackingFile(): boolean {
    if (!this.customInstructions) return false
    return /\b(?:todo\.md|to-do\.md|tracking file|task tracking|progress file|checklist\.md|plan\.md)\b/i.test(this.customInstructions)
  }

  private customInstructionVisibleStepCount(): number | null {
    return parseVisibleStepCountInstruction(this.customInstructions)
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
          ...this.messages as ChatMessageParam[],
        ],
        temperature: 0.3,
        max_tokens: REPLAN_JSON_MAX_TOKENS,
        reasoning: PLANNER_CONTROL_REASONING,
        includeTemporalContext: false,
      })

      await this.recordCompletionUsage(res.usage, 'info-replan')
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
