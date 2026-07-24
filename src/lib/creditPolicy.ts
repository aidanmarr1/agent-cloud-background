import { DEFAULT_MODEL_PRICING } from '@/lib/modelPricing'

export interface CreditTokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  tokens?: number
  cost?: number
}

export type CreditCategory = 'task' | 'time' | 'tool' | 'tokens' | 'adjustment'

export const OUT_OF_CREDITS_CODE = 'OUT_OF_CREDITS'
export const OUT_OF_CREDITS_MESSAGE = 'Credits ran out. Add credits or check usage before continuing.'

export interface CreditLedgerEvent {
  id: string
  timestamp: number
  amount: number
  category: CreditCategory
  reason: string
  conversationId?: string
  toolName?: string
  runId?: string
  source: 'server'
}

// Keep the customer-facing scale comparable to the current Manus benchmark:
// 4,000 credits for $20 (200 credits per retail dollar), with standard
// 15–25 minute agent tasks landing in the low hundreds of credits. Provider
// costs remain the source of truth; this multiplier converts those exact costs
// into billable product credits while leaving room for hosted-worker overhead,
// payment fees, failed-task refunds, and product margin.
export const RETAIL_CREDITS_PER_USD = 200
export const PROVIDER_COST_TO_RETAIL_MULTIPLIER = 30
export const CREDITS_PER_USD = RETAIL_CREDITS_PER_USD * PROVIDER_COST_TO_RETAIL_MULTIPLIER
export const TASK_START_CREDITS = 0
// Runtime wall-clock time and task startup are not billable. Credits are
// charged only from provider-reported billing usage or explicitly priced
// external APIs, so local actions cannot drain credits in the background.
export const ACTIVE_CREDITS_PER_MINUTE = 0

// Public provider rates used to keep in-app credits anchored to real spend.
// Current default route: DeepSeek V4 Flash.
export const MODEL_INPUT_USD_PER_1M = DEFAULT_MODEL_PRICING.inputUsdPer1M
export const MODEL_OUTPUT_USD_PER_1M = DEFAULT_MODEL_PRICING.outputUsdPer1M
export const MODEL_LONG_CONTEXT_THRESHOLD_TOKENS = DEFAULT_MODEL_PRICING.longContextThresholdTokens
export const MODEL_LONG_CONTEXT_INPUT_USD_PER_1M = DEFAULT_MODEL_PRICING.longContextInputUsdPer1M
export const MODEL_LONG_CONTEXT_OUTPUT_USD_PER_1M = DEFAULT_MODEL_PRICING.longContextOutputUsdPer1M
export const SERPER_SEARCH_USD_PER_1K_REQUESTS = 0.30
export const LOCAL_BROWSER_USD_PER_STEP = 0
export const E2B_DEFAULT_VCPU_COUNT = 2
export const E2B_DEFAULT_MEMORY_GIB = 0.5
export const E2B_VCPU_USD_PER_SECOND = 0.000014
export const E2B_MEMORY_GIB_USD_PER_SECOND = 0.0000045

export function finiteCreditNumber(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function roundCreditAmount(value: number): number {
  const safe = finiteCreditNumber(value)
  return Math.round(safe * 100) / 100
}

function usdToCredits(amountUsd: number): number {
  return roundCreditAmount(amountUsd * CREDITS_PER_USD)
}

export const CREDIT_RATES = {
  retailCreditsPerUsd: RETAIL_CREDITS_PER_USD,
  providerCostToRetailMultiplier: PROVIDER_COST_TO_RETAIL_MULTIPLIER,
  creditsPerUsd: CREDITS_PER_USD,
  model: DEFAULT_MODEL_PRICING.model,
  modelInputUsdPer1M: MODEL_INPUT_USD_PER_1M,
  modelOutputUsdPer1M: MODEL_OUTPUT_USD_PER_1M,
  modelInternalReasoningUsdPer1M: DEFAULT_MODEL_PRICING.internalReasoningUsdPer1M,
  modelLongContextThresholdTokens: MODEL_LONG_CONTEXT_THRESHOLD_TOKENS,
  modelLongContextInputUsdPer1M: MODEL_LONG_CONTEXT_INPUT_USD_PER_1M,
  modelLongContextOutputUsdPer1M: MODEL_LONG_CONTEXT_OUTPUT_USD_PER_1M,
  modelContextTokens: DEFAULT_MODEL_PRICING.contextTokens,
  modelMaxCompletionTokens: DEFAULT_MODEL_PRICING.maxCompletionTokens,
  activeModelInputUsdPer1M: MODEL_INPUT_USD_PER_1M,
  activeModelOutputUsdPer1M: MODEL_OUTPUT_USD_PER_1M,
  serperSearchUsdPer1KRequests: SERPER_SEARCH_USD_PER_1K_REQUESTS,
  localBrowserUsdPerStep: LOCAL_BROWSER_USD_PER_STEP,
  e2bDefaultVcpuCount: E2B_DEFAULT_VCPU_COUNT,
  e2bDefaultMemoryGiB: E2B_DEFAULT_MEMORY_GIB,
  e2bVcpuUsdPerSecond: E2B_VCPU_USD_PER_SECOND,
  e2bMemoryGiBUsdPerSecond: E2B_MEMORY_GIB_USD_PER_SECOND,
  e2bSandboxUsdPerSecond: (E2B_DEFAULT_VCPU_COUNT * E2B_VCPU_USD_PER_SECOND) +
    (E2B_DEFAULT_MEMORY_GIB * E2B_MEMORY_GIB_USD_PER_SECOND),
  inputTokenCreditsPer1K: usdToCredits(MODEL_INPUT_USD_PER_1M / 1000),
  outputTokenCreditsPer1K: usdToCredits(MODEL_OUTPUT_USD_PER_1M / 1000),
  webSearchCredits: usdToCredits(SERPER_SEARCH_USD_PER_1K_REQUESTS / 1000),
  imageSearchCredits: usdToCredits(SERPER_SEARCH_USD_PER_1K_REQUESTS / 1000),
  browserStepCredits: usdToCredits(LOCAL_BROWSER_USD_PER_STEP),
} as const

export const TOOL_CREDIT_RATES: Record<string, number> = {
  web_search: CREDIT_RATES.webSearchCredits,
  image_search: CREDIT_RATES.imageSearchCredits,
  browse_page: 0,
  browser_navigate: 0,
  browser_get_content: 0,
  browser_click: 0,
  browser_click_at: 0,
  browser_type: 0,
  browser_fill_form: 0,
  browser_select: 0,
  browser_scroll: 0,
  browser_find_text: 0,
  browser_hover: 0,
  browser_press_key: 0,
  browser_go_back: 0,
  browser_click_and_hold: 0,
  browser_drag: 0,
  browser_action_sequence: 0,
  browser_screenshot: 0,
  http_request: 0,
  read_document: 0,
  execute_command: 0,
  run_code: 0,
  create_file: 0,
  edit_file: 0,
  append_file: 0,
  delete_file: 0,
  export_pdf: 0,
  read_file: 0,
  read_skill: 0,
  list_files: 0,
}

export function toolCreditCharge(toolName: string): number {
  if (TOOL_CREDIT_RATES[toolName] !== undefined) return TOOL_CREDIT_RATES[toolName]
  return 0
}

export function normalizeTokenUsage(usage: CreditTokenUsage | number): Required<CreditTokenUsage> {
  if (typeof usage === 'number') {
    const total = Math.max(0, finiteCreditNumber(usage))
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: total,
      tokens: total,
      cost: 0,
    }
  }

  const promptTokens = Math.max(0, finiteCreditNumber(usage.promptTokens))
  const completionTokens = Math.max(0, finiteCreditNumber(usage.completionTokens))
  const explicitTotal = Math.max(0, finiteCreditNumber(usage.totalTokens ?? usage.tokens))
  const totalTokens = explicitTotal || promptTokens + completionTokens

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    tokens: totalTokens,
    cost: Math.max(0, finiteCreditNumber(usage.cost)),
  }
}

export function tokenUsageCreditCharge(usage: CreditTokenUsage | number): number {
  if (typeof usage === 'object' && usage !== null && usage.cost !== undefined) {
    return roundCreditAmount(Math.max(0, finiteCreditNumber(usage.cost)) * CREDITS_PER_USD)
  }
  return 0
}

export function e2bSandboxRuntimeCreditCharge(input: {
  elapsedMs: number
  vcpuCount?: number
  memoryGiB?: number
}): number {
  const elapsedSeconds = Math.max(0, finiteCreditNumber(input.elapsedMs) / 1000)
  if (elapsedSeconds <= 0) return 0

  const vcpuCount = Math.max(0, finiteCreditNumber(input.vcpuCount, E2B_DEFAULT_VCPU_COUNT))
  const memoryGiB = Math.max(0, finiteCreditNumber(input.memoryGiB, E2B_DEFAULT_MEMORY_GIB))
  const amountUsd = elapsedSeconds * (
    (vcpuCount * E2B_VCPU_USD_PER_SECOND) +
    (memoryGiB * E2B_MEMORY_GIB_USD_PER_SECOND)
  )
  return usdToCredits(amountUsd)
}
