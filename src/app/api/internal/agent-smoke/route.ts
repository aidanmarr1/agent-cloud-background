import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { AgentLoop } from '@/lib/agent/AgentLoop'
import { DEFAULT_MODEL } from '@/lib/llm'
import type { SSEEmitter } from '@/lib/agent/SSEEmitter'

export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/agent-smoke'
const SMOKE_TIMEOUT_MS = 120_000
const DEFAULT_SMOKE_PROMPT = 'research current credible sources on how AI models generate high-quality SVG code and summarize the main methods'

type SmokeEvent = {
  type: string
  [key: string]: unknown
}

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

function preview(value: unknown, maxLength = 280): string {
  if (typeof value === 'string') return value.slice(0, maxLength)
  try {
    return JSON.stringify(value).slice(0, maxLength)
  } catch {
    return String(value).slice(0, maxLength)
  }
}

function createSmokeEmitter(startedAt: number) {
  const events: SmokeEvent[] = []
  let closed = false
  let terminalStatus: 'done' | 'error' | null = null

  const push = (event: SmokeEvent) => {
    if (closed && event.type !== 'done' && event.type !== 'error') return
    events.push({ elapsedMs: Date.now() - startedAt, ...event })
  }

  return {
    events,
    emitter: {
      textDelta(content: string) {
        push({ type: 'text_delta', content: preview(content) })
      },
      reasoningDelta(content: string) {
        push({ type: 'reasoning_delta', content: preview(content) })
      },
      reasoningDone() {
        push({ type: 'reasoning_done' })
      },
      toolStart(id: string, name: string, args: Record<string, unknown>) {
        push({ type: 'tool_start', id, name, argsPreview: preview(args) })
      },
      toolResult(id: string, name: string, result: unknown) {
        push({ type: 'tool_result', id, name, resultPreview: preview(result) })
      },
      browserFrame(frame: string) {
        push({ type: 'browser_frame', bytes: frame.length })
      },
      terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string) {
        push({ type: 'terminal_output', id, stream, data: preview(data) })
      },
      fileContentStart(id: string, path: string, toolName?: string) {
        push({ type: 'file_content_start', id, path, toolName })
      },
      fileContentDelta(id: string, content: string) {
        push({ type: 'file_content_delta', id, content: preview(content) })
      },
      plan(items: string[]) {
        push({ type: 'plan', items })
      },
      artifactCreated(artifact: unknown) {
        push({ type: 'artifact_created', artifactPreview: preview(artifact) })
      },
      creditEvent(entry: unknown) {
        push({ type: 'credit_event', entryPreview: preview(entry) })
      },
      stepAdvance(status?: string, reason?: string) {
        push({ type: 'step_advance', status, reason })
      },
      done(usage?: unknown) {
        terminalStatus = 'done'
        push({ type: 'done', usagePreview: preview(usage) })
      },
      error(message: string) {
        terminalStatus = 'error'
        push({ type: 'error', message })
      },
      close() {
        closed = true
      },
      heartbeat() {
        push({ type: 'heartbeat' })
      },
      get isClosed() {
        return closed
      },
      get terminalStatus() {
        return terminalStatus
      },
    } as unknown as SSEEmitter,
  }
}

export async function GET(request: NextRequest) {
  if (!verifyInternalSignature(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const prompt = (request.nextUrl.searchParams.get('prompt') || DEFAULT_SMOKE_PROMPT).slice(0, 500)
  const conversationId = `agent-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS)
  const { events, emitter } = createSmokeEmitter(startedAt)
  const diagnostics: Array<{ type: string; data: Record<string, unknown> }> = []

  try {
    console.log('[AgentSmoke] Starting production agent smoke', {
      conversationId,
      promptChars: prompt.length,
      model: DEFAULT_MODEL,
    })

    const loop = new AgentLoop(emitter, {
      messages: [{ role: 'user', content: prompt }],
      model: DEFAULT_MODEL,
      conversationId,
      signal: controller.signal,
      diagnostics: (event) => {
        diagnostics.push(event)
      },
    })

    await loop.run()

    const toolStarts = events
      .filter(event => event.type === 'tool_start')
      .map(event => ({ name: event.name, argsPreview: event.argsPreview }))
    const errors = events
      .filter(event => event.type === 'error')
      .map(event => String(event.message || ''))
    const plans = events
      .filter(event => event.type === 'plan')
      .map(event => event.items)
    const browserFrames = events.filter(event => event.type === 'browser_frame').length
    const firstTextMs = events.find(event => event.type === 'text_delta')?.elapsedMs ?? null
    const planMs = events.find(event => event.type === 'plan')?.elapsedMs ?? null
    const firstToolMs = events.find(event => event.type === 'tool_start')?.elapsedMs ?? null

    console.log('[AgentSmoke] Production agent smoke finished', {
      conversationId,
      terminalStatus: emitter.terminalStatus,
      events: events.length,
      toolStarts: toolStarts.length,
      browserFrames,
      firstTextMs,
      planMs,
      firstToolMs,
      errors: errors.length,
      durationMs: Date.now() - startedAt,
    })

    return NextResponse.json({
      ok: emitter.terminalStatus === 'done',
      terminalStatus: emitter.terminalStatus,
      durationMs: Date.now() - startedAt,
      firstTextMs,
      planMs,
      firstToolMs,
      eventCount: events.length,
      browserFrames,
      plan: plans[0] || null,
      toolStarts,
      errors,
      textPreview: events
        .filter(event => event.type === 'text_delta')
        .map(event => String(event.content || ''))
        .join('')
        .slice(0, 1200),
      diagnostics: diagnostics.slice(-12),
      tail: events.slice(-12),
    })
  } catch (error) {
    console.error('[AgentSmoke] Production agent smoke failed', {
      conversationId,
      aborted: controller.signal.aborted,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    })
    return NextResponse.json(
      {
        ok: false,
        terminalStatus: emitter.terminalStatus,
        durationMs: Date.now() - startedAt,
        eventCount: events.length,
        error: error instanceof Error ? error.message : 'Agent smoke failed.',
        diagnostics: diagnostics.slice(-12),
        tail: events.slice(-12),
      },
      { status: 502 },
    )
  } finally {
    clearTimeout(timeout)
    emitter.close()
  }
}
