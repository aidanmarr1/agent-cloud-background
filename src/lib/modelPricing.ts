// The assistant is pinned to GPT-5.6 Luna. Provider selection is separately
// locked to OpenRouter's standard OpenAI endpoint in src/lib/llm.ts.
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-luna'

export const OPENROUTER_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.10,
  cacheHitInputUsdPer1M: 0.01,
  outputUsdPer1M: 0.60,
  internalReasoningUsdPer1M: 0.60,
  // The standard OpenAI endpoint switches to its published long-context tier
  // at 272K prompt tokens. Exact OpenRouter-reported cost remains authoritative.
  longContextThresholdTokens: 272_000,
  longContextInputUsdPer1M: 0.20,
  longContextCacheHitInputUsdPer1M: 0.02,
  longContextOutputUsdPer1M: 0.90,
  contextTokens: 1_050_000,
  maxCompletionTokens: 128_000,
  source: 'OpenRouter (OpenAI)',
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
  const longContext = Math.max(0, promptTokens) >= pricing.longContextThresholdTokens
  const inputUsdPer1M = longContext
    ? pricing.longContextInputUsdPer1M
    : pricing.inputUsdPer1M
  const outputUsdPer1M = longContext
    ? pricing.longContextOutputUsdPer1M
    : pricing.outputUsdPer1M
  const cacheHitInputUsdPer1M = longContext
    ? pricing.longContextCacheHitInputUsdPer1M
    : pricing.cacheHitInputUsdPer1M
  const cacheHitTokens = finiteNumber(input.prompt_cache_hit_tokens)
  const cacheMissTokens = finiteNumber(input.prompt_cache_miss_tokens)
  const inputCost = cacheHitTokens !== null || cacheMissTokens !== null
    ? ((Math.max(0, cacheHitTokens || 0) * cacheHitInputUsdPer1M) +
      (Math.max(0, cacheMissTokens ?? Math.max(0, promptTokens - Math.max(0, cacheHitTokens || 0))) * inputUsdPer1M)) / 1_000_000
    : Math.max(0, promptTokens) * inputUsdPer1M / 1_000_000
  const outputCost = Math.max(0, completionTokens) * outputUsdPer1M / 1_000_000
  return Math.max(0, inputCost + outputCost)
}
