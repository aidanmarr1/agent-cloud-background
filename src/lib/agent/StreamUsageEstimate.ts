import { estimateUsageCost } from '@/lib/modelPricing'

export interface ConservativeStreamUsageEstimateInput {
  model: string
  requestMessages: unknown[]
  requestTools?: unknown[]
  assistantContent: string
  reasoningContent: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}

export interface ConservativeStreamUsageEstimate {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
}

const PROMPT_TOKEN_RESERVE = 256
const COMPLETION_TOKEN_RESERVE = 64

function serializableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item) || ''
  } catch {
    return String(value ?? '')
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * Synchronous fail-closed usage for providers that omit the final streamed
 * usage chunk. Counting UTF-8 bytes as tokens deliberately overestimates
 * normal BPE tokenization, while the fixed reserves cover chat/tool envelope
 * tokens that are not visible in message text. Cached input is priced as
 * uncached input so the debit never depends on delayed provider metadata.
 */
export function estimateConservativeMissingStreamUsage(
  input: ConservativeStreamUsageEstimateInput,
): ConservativeStreamUsageEstimate {
  const promptEnvelope = serializableJson({
    messages: input.requestMessages,
    tools: input.requestTools || [],
  })
  const completionEnvelope = serializableJson({
    content: input.assistantContent,
    reasoning: input.reasoningContent,
    toolCalls: input.toolCalls,
  })

  const promptTokens = Math.max(1, utf8ByteLength(promptEnvelope) + PROMPT_TOKEN_RESERVE)
  const completionTokens = Math.max(1, utf8ByteLength(completionEnvelope) + COMPLETION_TOKEN_RESERVE)
  const totalTokens = promptTokens + completionTokens
  const cost = estimateUsageCost({
    model: input.model,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  })

  if (cost === null || !Number.isFinite(cost) || cost <= 0) {
    throw new Error('Unable to create nonzero conservative streamed usage estimate.')
  }

  return { promptTokens, completionTokens, totalTokens, cost }
}
