import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  createCompletion,
  createStreamingCompletion,
  DEFAULT_MODEL,
  type ChatCompletionTool,
  type StreamingChatCompletionChunk,
} from '@/lib/llm'
import { getSystemPrompt } from '@/lib/prompts'
import { buildStepMessage } from '@/lib/agent/guards'
import { getStrategy } from '@/lib/agent/TaskStrategy'
import { toolDefinitions } from '@/lib/tools'

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/llm-stream-smoke'
const DEFAULT_PROMPT = 'research how AI models generate high-quality SVG code'
const RESEARCH_START_TOOL_NAMES = new Set([
  'web_search',
  'browser_navigate',
  'browser_scroll',
  'browser_find_text',
  'browser_get_content',
  'read_document',
])

function safeCompareHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function verifyInternalSignature(request: NextRequest): boolean {
  const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET
  if (!secret) return false

  const timestamp = request.headers.get('x-agent-health-ts') || ''
  const signature = request.headers.get('x-agent-health-signature') || ''
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false

  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs)) return false
  if (Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) return false

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${HEALTH_PATH}`)
    .digest('hex')

  return safeCompareHex(signature, expected)
}

function stripToolDisplayDescriptions(tool: ChatCompletionTool): ChatCompletionTool {
  const parameters = tool.function.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return tool
  const schema = parameters as { properties?: Record<string, unknown>; [key: string]: unknown }
  if (!schema.properties?.action_label && !schema.properties?.plan_step_index) return tool

  const properties = { ...schema.properties }
  for (const key of ['action_label', 'plan_step_index'] as const) {
    const prop = properties[key]
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue
    const { description: _description, ...rest } = prop as Record<string, unknown>
    properties[key] = rest
  }

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...schema,
        properties,
      },
    },
  }
}

function selectTools(mode: string): ChatCompletionTool[] {
  const selected = toolDefinitions.filter((tool) => {
    const name = tool.function.name
    if (mode === 'single') return name === 'web_search'
    return RESEARCH_START_TOOL_NAMES.has(name)
  })
  return selected.map(stripToolDisplayDescriptions)
}

function buildProbeMessages(mode: string, prompt: string) {
  if (mode !== 'agent') {
    return [
      {
        role: 'system',
        content: 'You are Agent. For this diagnostic request, make exactly one native tool call and no prose.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ]
  }

  const strategy = getStrategy('research')
  const plan = [
    'Identify why AI struggles to generate valid, accurate SVG',
    'Find authoritative sources on SVG generation by LLMs',
    'Collect concrete prompting and validation methods',
    'Synthesize best practices for high-quality SVG output',
    'Create the final answer with citations',
  ]

  return [
    {
      role: 'system',
      content: getSystemPrompt(undefined, {
        type: strategy.type,
        toolPriority: strategy.toolPriority,
        stepGuidance: strategy.stepGuidance,
        temperature: strategy.temperature,
      }),
    },
    {
      role: 'user',
      content: prompt,
    },
    {
      role: 'system',
      content: buildStepMessage(
        plan,
        0,
        'RULES:\n- Start with a concrete research tool call for the first phase.\n- Do not answer from memory. Do not write a final summary before tools produce evidence.',
        undefined,
        2,
        'research',
        'Understand the main failure modes and constraints behind SVG generation by AI models.',
      ),
    },
  ]
}

function summarizeDelta(chunk: StreamingChatCompletionChunk) {
  const choice = chunk.choices?.[0]
  const delta = choice?.delta || {}
  const toolCalls = Array.isArray(delta.tool_calls)
    ? delta.tool_calls.map((toolCall) => {
      const record = toolCall as {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }
      return {
        index: record.index,
        id: !!record.id,
        name: record.function?.name || '',
        argumentChars: record.function?.arguments?.length || 0,
        argumentPreview: (record.function?.arguments || '').slice(0, 80),
      }
    })
    : []

  return {
    id: typeof chunk.id === 'string' ? chunk.id.slice(0, 24) : null,
    choiceCount: chunk.choices?.length || 0,
    finishReason: choice?.finish_reason || null,
    deltaKeys: Object.keys(delta),
    contentChars: typeof delta.content === 'string' ? delta.content.length : 0,
    contentPreview: typeof delta.content === 'string' ? delta.content.slice(0, 120) : '',
    reasoningChars: typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content.length
      : typeof (delta as { reasoning?: unknown }).reasoning === 'string'
        ? String((delta as { reasoning?: unknown }).reasoning).length
        : 0,
    toolCalls,
    usageSeen: !!chunk.usage,
  }
}

async function runStreamingProbe(mode: string, tools: ChatCompletionTool[], prompt: string) {
  const startedAt = Date.now()
  const response = await createStreamingCompletion({
    messages: buildProbeMessages(mode, prompt),
    tools,
    tool_choice: 'required',
    parallel_tool_calls: false,
    temperature: 0.3,
    max_tokens: 1200,
    stream_options: { include_usage: true },
    includeTemporalContext: false,
    requestTimeoutMs: 60_000,
    retryMaxAttempts: 0,
  })

  const firstChunks = []
  const toolNames = new Set<string>()
  const finishReasons = new Set<string>()
  let chunkCount = 0
  let contentChars = 0
  let toolDeltaCount = 0
  let usageSeen = false

  for await (const chunk of response) {
    chunkCount++
    const summary = summarizeDelta(chunk)
    if (firstChunks.length < 12) firstChunks.push(summary)
    if (summary.finishReason) finishReasons.add(summary.finishReason)
    if (summary.usageSeen) usageSeen = true
    contentChars += summary.contentChars
    for (const toolCall of summary.toolCalls) {
      toolDeltaCount++
      if (toolCall.name) toolNames.add(toolCall.name)
    }
  }

  return {
    ok: toolDeltaCount > 0,
    durationMs: Date.now() - startedAt,
    chunkCount,
    contentChars,
    toolDeltaCount,
    toolNames: [...toolNames],
    finishReasons: [...finishReasons],
    usageSeen,
    firstChunks,
  }
}

async function runNonStreamingProbe(mode: string, tools: ChatCompletionTool[], prompt: string) {
  const startedAt = Date.now()
  const response = await createCompletion({
    messages: buildProbeMessages(mode, prompt),
    tools,
    tool_choice: 'required',
    parallel_tool_calls: false,
    temperature: 0.3,
    max_tokens: 1200,
    includeTemporalContext: false,
    requestTimeoutMs: 60_000,
    retryMaxAttempts: 0,
  })
  const message = response.choices?.[0]?.message
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

  return {
    ok: toolCalls.length > 0,
    durationMs: Date.now() - startedAt,
    choiceCount: response.choices?.length || 0,
    finishReason: response.choices?.[0]?.finish_reason || null,
    contentPreview: typeof message?.content === 'string' ? message.content.slice(0, 240) : message?.content ?? null,
    toolCalls: toolCalls.map((toolCall) => {
      const record = toolCall as {
        type?: string
        function?: { name?: string; arguments?: string }
      }
      return {
        type: record.type,
        name: record.function?.name || '',
        argumentChars: record.function?.arguments?.length || 0,
        argumentPreview: (record.function?.arguments || '').slice(0, 160),
      }
    }),
    usageSeen: !!response.usage,
  }
}

export async function GET(request: NextRequest) {
  if (!verifyInternalSignature(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const modeParam = request.nextUrl.searchParams.get('mode')
  const mode = modeParam === 'single' || modeParam === 'agent' ? modeParam : 'research'
  const prompt = (request.nextUrl.searchParams.get('prompt') || DEFAULT_PROMPT).slice(0, 500)
  const tools = selectTools(mode)

  try {
    const streaming = await runStreamingProbe(mode, tools, prompt)
    const nonStreaming = await runNonStreamingProbe(mode, tools, prompt)
    return NextResponse.json({
      ok: streaming.ok && nonStreaming.ok,
      mode,
      model: DEFAULT_MODEL,
      toolNames: tools.map((tool) => tool.function.name),
      streaming,
      nonStreaming,
    })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        mode,
        model: DEFAULT_MODEL,
        toolNames: tools.map((tool) => tool.function.name),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    )
  }
}
