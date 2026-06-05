import { createHmac, timingSafeEqual, randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { browserNavigate, destroyBrowserSession } from '@/lib/browser'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000
const HEALTH_PATH = '/api/internal/browser-health'

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

export async function GET(request: NextRequest) {
  if (!verifyInternalSignature(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const conversationId = `health-${Date.now()}-${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()

  try {
    const result = await browserNavigate(conversationId, 'https://example.com/')
    if (!result.success) {
      console.error('[BrowserHealth] Navigation failed', {
        action: result.action,
        error: result.error,
        url: result.url,
      })
      return NextResponse.json(
        { ok: false, error: 'Browser health check failed.' },
        { status: 502 },
      )
    }

    return NextResponse.json({
      ok: true,
      title: result.title,
      url: result.url,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    console.error('[BrowserHealth] Browser runtime failed', error)
    return NextResponse.json(
      { ok: false, error: 'Browser health check failed.' },
      { status: 502 },
    )
  } finally {
    await destroyBrowserSession(conversationId).catch((error) => {
      console.error('[BrowserHealth] Cleanup failed', error)
    })
  }
}
