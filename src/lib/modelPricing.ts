// The assistant talks directly to DeepSeek's API. Keeping the model identifier
// in code prevents stale deployment variables or client settings from changing
// the production route.
export const DEFAULT_ASSISTANT_MODEL = 'deepseek-v4-flash-vision-exp'

export const ASSISTANT_MODEL_PRICING = {
  model: DEFAULT_ASSISTANT_MODEL,
  // Use peak pricing for the internal credit fence so off-peak changes never
  // understate the maximum provider charge.
  inputUsdPer1M: 0.44,
  cacheHitInputUsdPer1M: 0.014,
  outputUsdPer1M: 1.32,
  internalReasoningUsdPer1M: 1.32,
  contextPriceTiers: [] as Array<{
    minPromptTokens: number
    inputUsdPer1M: number
    cacheHitInputUsdPer1M: number
    outputUsdPer1M: number
  }>,
  longContextThresholdTokens: 1_048_576,
  longContextInputUsdPer1M: 0.44,
  longContextCacheHitInputUsdPer1M: 0.014,
  longContextOutputUsdPer1M: 1.32,
  contextTokens: 1_048_576,
  maxCompletionTokens: 384_000,
  source: 'DeepSeek API (DeepSeek V4 Flash Vision Exp, peak pricing)',
} as const

export const DEFAULT_MODEL_PRICING = ASSISTANT_MODEL_PRICING

export type ModelPricing = typeof ASSISTANT_MODEL_PRICING

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function pricingForModel(model: string | undefined): ModelPricing {
  const normalized = (model || '').trim().toLowerCase()
  const routeIndependentModel = normalized.replace(/:(?:nitro|exacto|free)$/, '')
  const assistantBaseModel = DEFAULT_ASSISTANT_MODEL.replace(/:(?:nitro|exacto|free)$/, '')
  if (routeIndependentModel === assistantBaseModel) return ASSISTANT_MODEL_PRICING
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
  const applicableTier = [...pricing.contextPriceTiers]
    .reverse()
    .find(tier => Math.max(0, promptTokens) >= tier.minPromptTokens)
  const inputUsdPer1M = applicableTier?.inputUsdPer1M ?? pricing.inputUsdPer1M
  const outputUsdPer1M = applicableTier?.outputUsdPer1M ?? pricing.outputUsdPer1M
  const cacheHitInputUsdPer1M = applicableTier?.cacheHitInputUsdPer1M ?? pricing.cacheHitInputUsdPer1M
  const cacheHitTokens = finiteNumber(input.prompt_cache_hit_tokens)
  const cacheMissTokens = finiteNumber(input.prompt_cache_miss_tokens)
  const inputCost = cacheHitTokens !== null || cacheMissTokens !== null
    ? ((Math.max(0, cacheHitTokens || 0) * cacheHitInputUsdPer1M) +
      (Math.max(0, cacheMissTokens ?? Math.max(0, promptTokens - Math.max(0, cacheHitTokens || 0))) * inputUsdPer1M)) / 1_000_000
    : Math.max(0, promptTokens) * inputUsdPer1M / 1_000_000
  const outputCost = Math.max(0, completionTokens) * outputUsdPer1M / 1_000_000
  return Math.max(0, inputCost + outputCost)
}
