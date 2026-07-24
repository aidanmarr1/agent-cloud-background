import {
  DEFAULT_OPENROUTER_MODEL,
  estimateUsageCost,
} from '@/lib/modelPricing'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const GENERATION_URL = `${OPENROUTER_BASE_URL}/generation`
const ASSISTANT_LOG_LABEL = 'Agent'

function trimmedEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = trimmedEnv(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

// Keep the provider/model boundary explicit. Individual requests, stale
// worker environments, and client-supplied model names cannot silently route
// tasks back to another provider.
export const ASSISTANT_PROVIDER = 'openrouter' as const
export const ASSISTANT_SUPPORTS_IMAGE_INPUT = true
export const DEFAULT_MODEL = DEFAULT_OPENROUTER_MODEL

type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

function normalizeReasoningEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  const normalized = (value || fallback).toLowerCase().trim().replace(/[\s-]+/g, '_')
  if (normalized === 'none') return 'minimal'
  if (['x_high', 'extra_high'].includes(normalized)) return 'xhigh'
  if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) {
    return normalized as ReasoningEffort
  }
  return fallback
}

const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(
  trimmedEnv(process.env.OPENROUTER_REASONING_EFFORT),
  'minimal',
)
const DEFAULT_REASONING_EXCLUDE = booleanEnv(process.env.OPENROUTER_REASONING_EXCLUDE, true)

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'file'; file: { filename?: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: { url: string } }

export type ChatMessageParam = {
  role: string
  content?: string | null | ChatContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  reasoning_content?: string | null
  [key: string]: unknown
}

export type ChatCompletionTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export type ChatCompletionParams = {
  model?: string
  messages: ChatMessageParam[]
  tools?: ChatCompletionTool[]
  temperature?: number
  max_tokens?: number
  stream_options?: { include_usage?: boolean }
  usage?: { include?: boolean }
  parallel_tool_calls?: unknown
  tool_choice?: unknown
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'high' | 'max'
  reasoning?: {
    effort?: ReasoningEffort
    max_tokens?: number
    exclude?: boolean
    enabled?: boolean
  }
  provider?: {
    sort?: 'throughput' | 'price' | 'latency'
    require_parameters?: boolean
  }
  requestTimeoutMs?: number
  retryMaxAttempts?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  abortSignal?: AbortSignal
  includeTemporalContext?: boolean
  stream?: unknown
  [key: string]: unknown
}

export type ChatCompletionResponse = {
  id?: string
  choices: Array<{
    message?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: unknown[]
    }
    finish_reason?: string | null
    index?: number
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  [key: string]: unknown
}

export type StreamingChatCompletionChunk = {
  id?: string
  choices: Array<{
    delta?: Record<string, unknown>
    finish_reason?: string | null
    index?: number
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
  [key: string]: unknown
}

export type ChatCompletionUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost: number
}

type StreamingIterable = AsyncIterable<StreamingChatCompletionChunk> & {
  controller: AbortController
  response: Response
  cleanup?: () => void
}

/** The app is pinned to the configured assistant route. */
export function resolveModel(_model: string): string {
  return DEFAULT_MODEL
}

const temporalFormatters = new Map<string, Intl.DateTimeFormat>()
let temporalContextCache: { key: string; value: string } | null = null

function normalizeTimeZone(value: string | undefined | null): string | null {
  const trimmed = (value || '').trim()
  if (!trimmed) return null

  const withoutLeadingColon = trimmed.replace(/^:+/, '')
  if (/^(?:utc|etc\/utc|gmt|etc\/gmt)$/i.test(withoutLeadingColon)) return 'UTC'
  return withoutLeadingColon
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

function getRuntimeTimeZone(): string {
  const resolvedTimeZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return undefined
    }
  })()

  const candidates = [
    normalizeTimeZone(process.env.TZ),
    normalizeTimeZone(resolvedTimeZone),
    'UTC',
  ].filter((timeZone): timeZone is string => !!timeZone)

  return candidates.find(isValidTimeZone) || 'UTC'
}

function getTemporalFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = temporalFormatters.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  })
  temporalFormatters.set(timeZone, formatter)
  return formatter
}

export function getCurrentTemporalContext(now = new Date()): string {
  const timeZone = getRuntimeTimeZone()
  const utcMinute = `${now.toISOString().slice(0, 16)}Z`
  const cacheKey = `${timeZone}|${utcMinute}`
  if (temporalContextCache?.key === cacheKey) return temporalContextCache.value

  const localDateTime = getTemporalFormatter(timeZone).format(now)
  const value = `Now: ${localDateTime}; UTC ${utcMinute}; timezone ${timeZone}. Use for relative/current/recent dates.`
  temporalContextCache = { key: cacheKey, value }
  return value
}

function withCurrentTemporalContext(messages: ChatMessageParam[]): ChatMessageParam[] {
  const temporalContext = getCurrentTemporalContext()
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [
      {
        ...first,
        content: `${first.content}\n\n${temporalContext}`,
      },
      ...rest,
    ]
  }

  return [
    {
      role: 'system',
      content: temporalContext,
    },
    ...messages,
  ]
}

console.log(`[${ASSISTANT_LOG_LABEL}] Assistant service configured.`)

const MAX_RETRIES = 3
const BASE_DELAY_MS = 2000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MAX_ERROR_BODY_CHARS = 2000

function getAssistantApiKey(): string {
  const apiKey = trimmedEnv(process.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error('Missing assistant service credentials.')
  }
  return apiKey
}

function chatCompletionsUrl(): string {
  return `${OPENROUTER_BASE_URL}/chat/completions`
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function redactSecrets(text: string): string {
  let redacted = text.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-api-key]')
  const openRouterKey = process.env.OPENROUTER_API_KEY
  if (openRouterKey) {
    redacted = redacted.split(openRouterKey).join('[redacted-assistant-key]')
  }
  const serperKey = process.env.SERPER_API_KEY
  if (serperKey) {
    redacted = redacted.split(serperKey).join('[redacted-search-key]')
  }
  if (DEFAULT_MODEL) {
    redacted = redacted.split(DEFAULT_MODEL).join('[assistant-route]')
  }
  redacted = redacted
    .replace(/\b(?:qwen|openai|anthropic|google|gemini|meta-llama|mistralai|deepseek|x-ai|cohere|perplexity)\/[A-Za-z0-9._:-]+/gi, '[assistant-route]')
    .replace(/\bdeepseek-v[0-9][A-Za-z0-9._:-]*/gi, '[assistant-route]')
    .replace(/deepseek/gi, 'assistant service')
    .replace(/openrouter/gi, 'assistant service')
  return redacted
}

function createApiError(response: Response, body: string): Error & {
  status?: number
  headers?: Record<string, string>
  body?: string
} {
  const safeBody = redactSecrets(body).slice(0, MAX_ERROR_BODY_CHARS)
  const message = safeBody
    ? `Assistant service request failed (${response.status}): ${safeBody}`
    : `Assistant service request failed (${response.status} ${response.statusText})`
  const error = new Error(message) as Error & {
    status?: number
    headers?: Record<string, string>
    body?: string
  }
  error.status = response.status
  error.headers = headersToObject(response.headers)
  error.body = safeBody
  return error
}

function createAbortError(): Error {
  const error = new Error('Request aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError'
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error || '')
  return /\b(fetch failed|network|socket|terminated|timeout|timed out|econnreset|etimedout|eai_again|und_err|temporarily unavailable)\b/i.test(message)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

function createLinkedAbortController(parentSignal?: AbortSignal): {
  controller: AbortController
  cleanup: () => void
} {
  const controller = new AbortController()
  if (!parentSignal) {
    return { controller, cleanup: () => {} }
  }

  if (parentSignal.aborted) {
    controller.abort()
    return { controller, cleanup: () => {} }
  }

  const onAbort = () => controller.abort()
  parentSignal.addEventListener('abort', onAbort, { once: true })
  return {
    controller,
    cleanup: () => parentSignal.removeEventListener('abort', onAbort),
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    let timeout: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number },
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(options?.maxAttempts ?? MAX_RETRIES, MAX_RETRIES))
  const totalAttempts = maxRetries + 1
  const baseDelayMs = options?.baseDelayMs ?? BASE_DELAY_MS
  const maxDelayMs = options?.maxDelayMs ?? 30_000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      throwIfAborted(signal)
      return await fn()
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted) throw error

      const status = (error as { status?: number })?.status
      const isRateLimit = status === 429
      const isServerError = status !== undefined && status >= 500
      const isNetworkError = status === undefined && isTransientNetworkError(error)

      if ((isRateLimit || isServerError || isNetworkError) && attempt < maxRetries) {
        const retryAfter = (error as { headers?: Record<string, string> })
          ?.headers?.['retry-after']
        const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : NaN
        const rawDelay = !isNaN(parsedRetryAfter) && parsedRetryAfter > 0
          ? parsedRetryAfter * 1000
          : baseDelayMs * Math.pow(2, attempt)
        const jitter = Math.random() * 1000
        const delayMs = Math.min(rawDelay, maxDelayMs) + jitter
        const reason = isNetworkError ? 'network error' : isRateLimit ? '429' : String(status)
        console.log(`[${ASSISTANT_LOG_LABEL}] ${reason} on attempt ${attempt + 1}/${totalAttempts}, retrying in ${Math.round(delayMs)}ms`)
        await sleep(delayMs, signal)
        continue
      }
      throw error
    }
  }
  throw new Error('Max retries exceeded')
}

function getRequestTimeoutMs(params: ChatCompletionParams): number {
  return typeof params.requestTimeoutMs === 'number' && params.requestTimeoutMs > 0
    ? params.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS
}

function createTimeoutError(timeoutMs: number): Error {
  return new Error(`Assistant request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeGenerationUsage(data: unknown): ChatCompletionUsage | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const promptTokens = finiteNumber(record.native_tokens_prompt) ?? finiteNumber(record.tokens_prompt)
  const completionBase = finiteNumber(record.native_tokens_completion) ?? finiteNumber(record.tokens_completion)
  const reasoningTokens = finiteNumber(record.native_tokens_reasoning) ?? 0
  const cost = finiteNumber(record.total_cost) ?? finiteNumber(record.usage)

  if (promptTokens === null || completionBase === null || cost === null) return null

  const completionTokens = completionBase + Math.max(0, reasoningTokens)
  return {
    prompt_tokens: Math.max(0, Math.round(promptTokens)),
    completion_tokens: Math.max(0, Math.round(completionTokens)),
    total_tokens: Math.max(0, Math.round(promptTokens + completionTokens)),
    cost: Math.max(0, cost),
  }
}

async function fetchGenerationMetadata(id: string, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(GENERATION_URL)
  url.searchParams.set('id', id)

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${getAssistantApiKey()}`,
      'Content-Type': 'application/json',
    },
    signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw createApiError(response, body)
  }

  const json = await response.json().catch(() => null) as { data?: unknown } | null
  return json?.data ?? null
}

export async function fetchGenerationUsage(
  id: string | undefined,
  signal?: AbortSignal,
): Promise<ChatCompletionUsage | null> {
  const generationId = typeof id === 'string' ? id.trim() : ''
  if (!generationId) return null

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await fetchGenerationMetadata(generationId, signal)
      return normalizeGenerationUsage(data)
    } catch (error) {
      const status = (error as { status?: number })?.status
      if ((status === 404 || status === 429 || (status !== undefined && status >= 500)) && attempt < 4) {
        await sleep(400 + attempt * 350, signal)
        continue
      }
      if (status === 404 || status === 429 || (status !== undefined && status >= 500)) {
        return null
      }
      throw error
    }
  }

  return null
}

function completionHasBillableUsage(usage: ChatCompletionResponse['usage']): boolean {
  return !!usage &&
    Number.isFinite(usage.prompt_tokens) &&
    Number.isFinite(usage.completion_tokens) &&
    Number.isFinite(usage.cost)
}

type UsageWithCost = NonNullable<ChatCompletionResponse['usage']>

function normalizeUsageCost<T extends ChatCompletionResponse['usage'] | StreamingChatCompletionChunk['usage']>(
  usage: T,
  model = DEFAULT_MODEL,
): T {
  if (!usage || typeof usage !== 'object') return usage
  if (Number.isFinite(usage.cost)) return usage
  const cost = estimateUsageCost({ ...usage, model })
  if (cost === null) return usage
  return { ...usage, cost } as T
}

function normalizeResponseUsage<T extends { model?: string; usage?: UsageWithCost | null }>(data: T): T {
  if (!data.usage) return data
  return {
    ...data,
    usage: normalizeUsageCost(data.usage, data.model || DEFAULT_MODEL),
  }
}

function providerReasoningPayload(
  reasoning: ChatCompletionParams['reasoning'],
): Pick<ChatCompletionParams, 'thinking' | 'reasoning_effort' | 'reasoning'> {
  return {
    reasoning: reasoning ?? {
      effort: DEFAULT_REASONING_EFFORT,
      exclude: DEFAULT_REASONING_EXCLUDE,
    },
  }
}

function withPinnedModel(
  params: ChatCompletionParams,
  stream: boolean,
): ChatCompletionParams {
  const {
    parallel_tool_calls: _parallelToolCalls,
    thinking: _thinking,
    requestTimeoutMs: _requestTimeoutMs,
    abortSignal: _abortSignal,
    includeTemporalContext,
    stream: _stream,
    model: _model,
    reasoning: _reasoning,
    messages,
    tool_choice: _toolChoice,
    usage: _usage,
    reasoning_effort: _reasoningEffort,
    ...rest
  } = params

  const contextualMessages = includeTemporalContext === false
    ? messages
    : withCurrentTemporalContext(messages)
  return {
    ...rest,
    messages: contextualMessages,
    model: DEFAULT_MODEL,
    stream,
    usage: { include: true },
    provider: {
      sort: 'throughput',
      // Nitro should still be restricted to endpoints that implement every
      // requested parameter. Otherwise a fast provider may silently ignore
      // required tool choice or reasoning controls and return an empty action
      // turn in the middle of an agent loop.
      require_parameters: true,
    },
    ...(_toolChoice !== undefined ? { tool_choice: _toolChoice } : {}),
    ...(_parallelToolCalls !== undefined ? { parallel_tool_calls: _parallelToolCalls } : {}),
    ...providerReasoningPayload(_reasoning),
  }
}

async function postChatCompletion(
  params: ChatCompletionParams,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAssistantApiKey()}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': ASSISTANT_LOG_LABEL,
    },
    body: JSON.stringify(withPinnedModel(params, stream)),
    signal,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw createApiError(response, body)
  }

  return response
}

function findEventDelimiter(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1 && crlf === -1) return null
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

function parseSseEvent(event: string): StreamingChatCompletionChunk | 'DONE' | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()

  if (!data) return null
  if (data === '[DONE]') return 'DONE'

  return normalizeResponseUsage(JSON.parse(data) as StreamingChatCompletionChunk)
}

function createSseIterable(
  response: Response,
  controller: AbortController,
  cleanup?: () => void,
): StreamingIterable {
  const iterable: StreamingIterable = {
    controller,
    response,
    cleanup,
    async *[Symbol.asyncIterator]() {
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Assistant streaming response did not include a response body.')
      }

      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          let delimiter = findEventDelimiter(buffer)

          while (delimiter) {
            const rawEvent = buffer.slice(0, delimiter.index)
            buffer = buffer.slice(delimiter.index + delimiter.length)

            const parsed = parseSseEvent(rawEvent)
            if (parsed === 'DONE') return
            if (parsed) yield parsed

            delimiter = findEventDelimiter(buffer)
          }
        }

        buffer += decoder.decode()
        const parsed = parseSseEvent(buffer)
        if (parsed && parsed !== 'DONE') yield parsed
      } finally {
        reader.releaseLock()
        cleanup?.()
      }
    },
  }

  return iterable
}

export async function createStreamingCompletion(
  params: ChatCompletionParams,
): Promise<StreamingIterable> {
  return retryWithBackoff(async () => {
    const { controller, cleanup } = createLinkedAbortController(params.abortSignal)
    const timeoutMs = getRequestTimeoutMs(params)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await postChatCompletion(params, true, controller.signal)
      return createSseIterable(response, controller, cleanup)
    } catch (error) {
      cleanup()
      if (isAbortError(error) && !params.abortSignal?.aborted) {
        throw createTimeoutError(timeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }, params.abortSignal, {
    maxAttempts: params.retryMaxAttempts,
    baseDelayMs: params.retryBaseDelayMs,
    maxDelayMs: params.retryMaxDelayMs,
  })
}

export async function createCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResponse> {
  return retryWithBackoff(async () => {
    const { controller, cleanup } = createLinkedAbortController(params.abortSignal)
    const timeoutMs = getRequestTimeoutMs(params)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await postChatCompletion(params, false, controller.signal)
      const data = normalizeResponseUsage(await response.json() as ChatCompletionResponse)
      if (!completionHasBillableUsage(data.usage)) {
        const usage = await fetchGenerationUsage(data.id, controller.signal)
        if (usage) data.usage = usage
      }
      return data
    } catch (error) {
      if (isAbortError(error) && !params.abortSignal?.aborted) {
        throw createTimeoutError(timeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timeout)
      cleanup()
    }
  }, params.abortSignal, {
    maxAttempts: params.retryMaxAttempts,
    baseDelayMs: params.retryBaseDelayMs,
    maxDelayMs: params.retryMaxDelayMs,
  })
}
