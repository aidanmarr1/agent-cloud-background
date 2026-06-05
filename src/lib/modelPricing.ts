export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash-lite'

export const DEFAULT_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.10,
  outputUsdPer1M: 0.40,
  internalReasoningUsdPer1M: 0.40,
  longContextThresholdTokens: 1_000_000,
  longContextInputUsdPer1M: 0.10,
  longContextOutputUsdPer1M: 0.40,
  contextTokens: 1_000_000,
  maxCompletionTokens: 65_535,
  source: 'OpenRouter',
} as const
