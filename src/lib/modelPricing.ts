// The assistant is pinned to Gemini 3.5 Flash Lite. The plain model slug keeps
// OpenRouter's balanced price-and-speed routing instead of forcing one host.
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.5-flash-lite'

export const OPENROUTER_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.30,
  cacheHitInputUsdPer1M: 0.03,
  outputUsdPer1M: 2.50,
  internalReasoningUsdPer1M: 2.50,
  // The current Google endpoint publishes one rate across the full context
  // window, so there are no prompt-length price overrides to apply.
  contextPriceTiers: [] as Array<{
    minPromptTokens: number
    inputUsdPer1M: number
    cacheHitInputUsdPer1M: number
    outputUsdPer1M: number
  }>,
  longContextThresholdTokens: 256_000,
  longContextInputUsdPer1M: 0.30,
  longContextCacheHitInputUsdPer1M: 0.03,
  longContextOutputUsdPer1M: 2.50,
  contextTokens: 1_048_576,
  maxCompletionTokens: 65_536,
  source: 'OpenRouter (Google)',
} as const

export const DEFAULT_MODEL_PRICING = OPENROUTER_MODEL_PRICING

export type ModelPricing = typeof OPENROUTER_MODEL_PRICING

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function pricingForModel(model: string | undefined): ModelPricing {
  const normalized = (model || '').trim().toLowerCase()
  const routeIndependentModel = normalized.replace(/:(?:nitro|exacto|free)$/, '')
  const openRouterBaseModel = DEFAULT_OPENROUTER_MODEL.replace(/:(?:nitro|exacto|free)$/, '')
  if (routeIndependentModel === openRouterBaseModel) return OPENROUTER_MODEL_PRICING
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
