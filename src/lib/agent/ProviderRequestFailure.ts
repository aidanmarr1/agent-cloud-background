export const MAX_PROVIDER_REQUEST_REPAIR_ATTEMPTS = 1

export type ProviderRequestFailureCategory =
  | 'message_payload_parse'
  | 'request_schema'
  | 'authentication'
  | 'request_rejected'

export interface ProviderRequestFailureDecision {
  category: ProviderRequestFailureCategory
  deterministic: true
  messagePayloadRepairable: boolean
}

type ProviderMessageLike = {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  [key: string]: unknown
}

function errorTextMatches(text: string, expression: RegExp): boolean {
  expression.lastIndex = 0
  return expression.test(text)
}

/**
 * Provider 4xx failures are request failures, not empty model turns. They must
 * never be handed to the normal null-stream / paid-turn recovery loop.
 */
export function classifyDeterministicProviderRequestFailure(
  status: number | undefined,
  errorText: string,
): ProviderRequestFailureDecision | null {
  if (typeof status !== 'number' || status < 400 || status >= 500) return null
  if (status === 408 || status === 425 || status === 429) return null

  if (status === 401 || status === 403) {
    return {
      category: 'authentication',
      deterministic: true,
      messagePayloadRepairable: false,
    }
  }

  const messagePayloadParseFailure = (status === 400 || status === 422) &&
    errorTextMatches(
      errorText,
      /messages?\s*\[?\d*\]?\s*\.?(?:content|tool_calls)|unexpected end of (?:hex|unicode) escape|(?:failed|unable) to parse (?:the )?request body|malformed (?:message|request|json)|invalid json|json (?:parse|decode|deserializ)|(?:parse|decode|deserializ)[^\n]{0,80}json/i,
    )
  if (messagePayloadParseFailure) {
    return {
      category: 'message_payload_parse',
      deterministic: true,
      messagePayloadRepairable: true,
    }
  }

  const schemaFailure = (status === 400 || status === 422) &&
    errorTextMatches(
      errorText,
      /invalid[_ -]?(?:request|parameter|schema)|validation (?:error|failed)|tool_choice|function\.arguments|request schema|does not match|expected (?:an? )?(?:object|array|string)/i,
    )
  if (schemaFailure) {
    return {
      category: 'request_schema',
      deterministic: true,
      messagePayloadRepairable: false,
    }
  }

  return {
    category: 'request_rejected',
    deterministic: true,
    messagePayloadRepairable: false,
  }
}

function safePreview(value: string, maxChars = 2_000): string {
  let preview = value.slice(0, maxChars)
  const last = preview.charCodeAt(preview.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) preview = preview.slice(0, -1)
  return preview
}

/**
 * Some OpenAI-compatible providers parse JSON-looking tool content a second
 * time. A raw truncation can therefore leave `\u`, a trailing slash, or broken
 * JSON that is valid in the outer HTTP body but rejected by that provider.
 */
export function normalizeLiteralJsonEscapes(value: string): { value: string; changed: boolean } {
  let output = ''
  let changed = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character !== '\\') {
      output += character
      continue
    }

    const next = value[index + 1]
    if (next === undefined) {
      output += '\\\\'
      changed = true
      continue
    }

    if (next === 'u') {
      const hex = value.slice(index + 2, index + 6)
      if (/^[0-9a-f]{4}$/i.test(hex)) {
        output += value.slice(index, index + 6)
        index += 5
      } else {
        output += '\\\\u'
        index += 1
        changed = true
      }
      continue
    }

    if ('"\\/bfnrt'.includes(next)) {
      output += `\\${next}`
      index += 1
      continue
    }

    output += `\\\\${next}`
    index += 1
    changed = true
  }

  return { value: output, changed }
}

function sanitizeJsonLookingToolContent(content: string): { content: string; changed: boolean } {
  const normalized = normalizeLiteralJsonEscapes(content)
  const trimmed = normalized.value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { content: normalized.value, changed: normalized.changed }
  }

  try {
    JSON.parse(trimmed)
    return { content: normalized.value, changed: normalized.changed }
  } catch {
    return {
      content: JSON.stringify({
        providerRecovery: 'Malformed or truncated tool result was replaced before retry.',
        rawPreview: safePreview(normalized.value),
      }),
      changed: true,
    }
  }
}

function sanitizeToolCalls(toolCalls: unknown): { toolCalls: unknown; changed: boolean } {
  if (!Array.isArray(toolCalls)) return { toolCalls, changed: false }

  let changed = false
  const sanitized = toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== 'object') return toolCall
    const record = toolCall as Record<string, unknown>
    const fn = record.function
    if (!fn || typeof fn !== 'object') return toolCall
    const functionRecord = fn as Record<string, unknown>
    if (typeof functionRecord.arguments !== 'string') return toolCall

    try {
      JSON.parse(functionRecord.arguments)
      return toolCall
    } catch {
      changed = true
      return {
        ...record,
        function: {
          ...functionRecord,
          arguments: JSON.stringify({
            invalidArguments: true,
            rawPreview: safePreview(functionRecord.arguments, 1_000),
          }),
        },
      }
    }
  })

  return { toolCalls: sanitized, changed }
}

/**
 * Returns a fresh request message array only when a concrete repair was made.
 * Callers must not spend their single repair allowance on an unchanged request.
 */
export function sanitizeProviderRequestMessagesForRetry<T extends ProviderMessageLike>(
  messages: T[],
): { messages: T[]; changed: boolean } {
  let changed = false
  const sanitized = messages.map((message) => {
    let nextMessage: ProviderMessageLike = message

    if (typeof message.content === 'string') {
      const normalizedContent = normalizeLiteralJsonEscapes(message.content)
      const contentRepair = message.role === 'tool'
        ? sanitizeJsonLookingToolContent(message.content)
        : { content: normalizedContent.value, changed: normalizedContent.changed }
      if (contentRepair.changed) {
        nextMessage = { ...nextMessage, content: contentRepair.content }
        changed = true
      }
    } else if (Array.isArray(message.content)) {
      let contentChanged = false
      const content = message.content.map((part) => {
        if (!part || typeof part !== 'object') return part
        const record = part as Record<string, unknown>
        if (typeof record.text !== 'string') return part
        const repair = normalizeLiteralJsonEscapes(record.text)
        if (!repair.changed) return part
        contentChanged = true
        return { ...record, text: repair.value }
      })
      if (contentChanged) {
        nextMessage = { ...nextMessage, content }
        changed = true
      }
    }

    const toolCallRepair = sanitizeToolCalls(nextMessage.tool_calls)
    if (toolCallRepair.changed) {
      nextMessage = { ...nextMessage, tool_calls: toolCallRepair.toolCalls }
      changed = true
    }

    return nextMessage as T
  })

  return { messages: sanitized, changed }
}
