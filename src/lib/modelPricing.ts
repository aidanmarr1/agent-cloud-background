export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.1-flash-lite'

export const DEEPSEEK_MODEL_PRICING = {
  model: DEFAULT_DEEPSEEK_MODEL,
  inputUsdPer1M: 0.14,
  cacheHitInputUsdPer1M: 0.0028,
  outputUsdPer1M: 0.28,
  internalReasoningUsdPer1M: 0.28,
  longContextThresholdTokens: 1_000_000,
  longContextInputUsdPer1M: 0.14,
  longContextOutputUsdPer1M: 0.28,
  contextTokens: 1_000_000,
  maxCompletionTokens: 384_000,
  source: 'DeepSeek',
} as const

export const OPENROUTER_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.25,
  cacheHitInputUsdPer1M: 0.025,
  outputUsdPer1M: 1.50,
  internalReasoningUsdPer1M: 1.50,
  longContextThresholdTokens: 1_048_576,
  longContextInputUsdPer1M: 0.25,
  longContextOutputUsdPer1M: 1.50,
  contextTokens: 1_048_576,
  maxCompletionTokens: 65_536,
  source: 'OpenRouter',
} as const

export const DEFAULT_MODEL_PRICING = DEEPSEEK_MODEL_PRICING

export type ModelPricing = typeof DEEPSEEK_MODEL_PRICING | typeof OPENROUTER_MODEL_PRICING

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function pricingForModel(model: string | undefined): ModelPricing {
  const normalized = (model || '').trim().toLowerCase()
  if (normalized === DEFAULT_OPENROUTER_MODEL) return OPENROUTER_MODEL_PRICING
  if (normalized === DEFAULT_DEEPSEEK_MODEL) return DEEPSEEK_MODEL_PRICING
  return DEFAULT_MODEL_PRICING
}

export function estimateUsageCost(input: {
  model?: string
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}): number | null {
  const promptTokens = finiteNumber(input.prompt_tokens)
  const completionTokens = finiteNumber(input.completion_tokens)
  if (promptTokens === null || completionTokens === null) return null

  const pricing = pricingForModel(input.model)
  const cacheHitTokens = finiteNumber(input.prompt_cache_hit_tokens)
  const cacheMissTokens = finiteNumber(input.prompt_cache_miss_tokens)
  const inputCost = cacheHitTokens !== null || cacheMissTokens !== null
    ? ((Math.max(0, cacheHitTokens || 0) * pricing.cacheHitInputUsdPer1M) +
      (Math.max(0, cacheMissTokens ?? Math.max(0, promptTokens - Math.max(0, cacheHitTokens || 0))) * pricing.inputUsdPer1M)) / 1_000_000
    : Math.max(0, promptTokens) * pricing.inputUsdPer1M / 1_000_000
  const outputCost = Math.max(0, completionTokens) * pricing.outputUsdPer1M / 1_000_000
  return Math.max(0, inputCost + outputCost)
}
