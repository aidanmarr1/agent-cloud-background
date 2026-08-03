// Plain model IDs use OpenRouter's balanced provider routing (price + speed).
// Route-specific suffixes such as :nitro/:exacto are opt-in, not the default.
export const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3.7-flash'

export const OPENROUTER_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.03,
  // OpenRouter reports exact billed cost when available. Keep the fallback
  // conservative because cache discounts can vary by routed provider.
  cacheHitInputUsdPer1M: 0.006,
  outputUsdPer1M: 0.13,
  internalReasoningUsdPer1M: 0.13,
  // Qwen 3.7 Flash switches to its first long-context tier at 32K tokens.
  // Use the highest published override as the conservative fallback because
  // exact OpenRouter-reported cost remains authoritative when available.
  longContextThresholdTokens: 32_000,
  longContextInputUsdPer1M: 0.20,
  longContextOutputUsdPer1M: 0.80,
  contextTokens: 1_000_000,
  maxCompletionTokens: 65_536,
  source: 'OpenRouter',
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
  const cacheHitTokens = finiteNumber(input.prompt_cache_hit_tokens)
  const cacheMissTokens = finiteNumber(input.prompt_cache_miss_tokens)
  const inputCost = cacheHitTokens !== null || cacheMissTokens !== null
    ? ((Math.max(0, cacheHitTokens || 0) * pricing.cacheHitInputUsdPer1M) +
      (Math.max(0, cacheMissTokens ?? Math.max(0, promptTokens - Math.max(0, cacheHitTokens || 0))) * inputUsdPer1M)) / 1_000_000
    : Math.max(0, promptTokens) * inputUsdPer1M / 1_000_000
  const outputCost = Math.max(0, completionTokens) * outputUsdPer1M / 1_000_000
  return Math.max(0, inputCost + outputCost)
}
