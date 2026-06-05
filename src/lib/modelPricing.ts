export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.4-mini'

export const DEFAULT_MODEL_PRICING = {
  model: DEFAULT_OPENROUTER_MODEL,
  inputUsdPer1M: 0.75,
  outputUsdPer1M: 4.50,
  internalReasoningUsdPer1M: 4.50,
  longContextThresholdTokens: 400_000,
  longContextInputUsdPer1M: 0.75,
  longContextOutputUsdPer1M: 4.50,
  contextTokens: 400_000,
  maxCompletionTokens: 128_000,
  source: 'OpenRouter',
} as const
