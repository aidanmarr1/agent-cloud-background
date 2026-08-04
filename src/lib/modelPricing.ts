// The assistant is pinned to Qwen3.7 Flash. The plain model slug keeps
// OpenRouter's balanced price-and-speed routing instead of forcing one host.
export const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3.7-flash'

export const OPENROUTER_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.03,
  cacheHitInputUsdPer1M: 0.006,
  outputUsdPer1M: 0.13,
  internalReasoningUsdPer1M: 0.13,
  contextPriceTiers: [
    {
      minPromptTokens: 32_000,
      inputUsdPer1M: 0.10,
      cacheHitInputUsdPer1M: 0.02,
      outputUsdPer1M: 0.40,
    },
    {
      minPromptTokens: 256_000,
      inputUsdPer1M: 0.20,
      cacheHitInputUsdPer1M: 0.04,
      outputUsdPer1M: 0.80,
    },
  ],
  longContextThresholdTokens: 256_000,
  longContextInputUsdPer1M: 0.20,
  longContextCacheHitInputUsdPer1M: 0.04,
  longContextOutputUsdPer1M: 0.80,
  contextTokens: 1_000_000,
  maxCompletionTokens: 65_536,
  source: 'OpenRouter (Qwen)',
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
