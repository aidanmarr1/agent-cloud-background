// Pin the expiring preview exactly; do not replace it automatically on expiry.
// Preview cost estimates use the published Flash rates (peak and off-peak).
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4.1-flash-expires-on-0910'

export const DEEPSEEK_MODEL_PRICING = {
  model: DEFAULT_DEEPSEEK_MODEL,
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
  maxCompletionTokens: 393_216,
  source: 'https://api-docs.deepseek.com/quick_start/pricing/',
} as const

export const DEFAULT_MODEL_PRICING = DEEPSEEK_MODEL_PRICING

export type ModelPricing = typeof DEEPSEEK_MODEL_PRICING

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function pricingForModel(model: string | undefined): ModelPricing {
  void model
  return DEFAULT_MODEL_PRICING
}

export function isDeepSeekPeakTime(at: Date): boolean {
  const day = at.getUTCDay()
  const hour = at.getUTCHours()
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
}

export function estimateUsageCost(input: {
  at?: Date
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
  const rateMultiplier = isDeepSeekPeakTime(input.at ?? new Date()) ? 1 : 0.5
  return Math.max(0, (inputCost + outputCost) * rateMultiplier)
}
