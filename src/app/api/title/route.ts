import { randomUUID } from 'crypto'
import { auth } from '@/auth'
import { createCompletion, DEFAULT_MODEL } from '@/lib/llm'
import { checkRateLimit } from '@/lib/rateLimit'
import { TitleRequestSchema } from '@/lib/validation/schemas'
import { assertSameOriginRequest, getClientIp, rateLimitResponse, readJsonBody } from '@/lib/api'
import { assertTaskAccess } from '@/lib/taskAccess'
import {
  assertServerCreditsAvailable,
  chargeServerTokenUsage,
  isOutOfCreditsError,
} from '@/lib/serverCredits'
import { OUT_OF_CREDITS_CODE, OUT_OF_CREDITS_MESSAGE } from '@/lib/creditPolicy'
import { assertInviteAccessApproved } from '@/lib/inviteAccess'

const TITLE_BODY_LIMIT_BYTES = 512 * 1024

function cleanTitle(title: string | undefined): string {
  const cleaned = (title || '')
    .replace(/^["']+|["']+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()
    .slice(0, 80)

  return cleaned || 'New task'
}

function normalizeProviderUsage(usage: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
} | undefined): { promptTokens: number; completionTokens: number; totalTokens: number; cost: number } | null {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens) || !Number.isFinite(usage.cost)) return null
  const promptTokens = Math.max(0, Math.round(usage.prompt_tokens || 0))
  const completionTokens = Math.max(0, Math.round(usage.completion_tokens || 0))
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(usage.total_tokens)
      ? Math.max(0, Math.round(usage.total_tokens || 0))
      : promptTokens + completionTokens,
    cost: Math.max(0, Number(usage.cost || 0)),
  }
}

export async function POST(request: Request) {
  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  // Rate limiting
  const ip = getClientIp(request)
  const rateCheck = checkRateLimit(`title:${ip}`, { maxRequests: 30 })
  if (!rateCheck.allowed) {
    return rateLimitResponse(rateCheck.retryAfterMs, 'Rate limited')
  }

  try {
    const body = await readJsonBody(request, TITLE_BODY_LIMIT_BYTES)
    if (!body.success) return body.response

    const parsed = TitleRequestSchema.safeParse(body.data)
    if (!parsed.success) {
      return Response.json({ error: 'Invalid messages' }, { status: 400 })
    }
    const { messages, conversationId } = parsed.data

    const session = await auth().catch(() => null)
    const userId = session?.user?.id
    if (!userId) {
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    }
    const inviteAccessError = await assertInviteAccessApproved(userId)
    if (inviteAccessError) return inviteAccessError

    const access = await assertTaskAccess(request, conversationId, { userId })
    if (!access.ok) return access.response

    const userMessage = (messages.find(m => m.role === 'user')?.content ?? '').slice(0, 500)
    await assertServerCreditsAvailable(userId)

    const assistantMessage = (messages.find(m => m.role === 'assistant')?.content ?? '').slice(0, 500)

    const titleMessages = [
      {
        role: 'system' as const,
        content: 'Generate a short, descriptive title (3-6 words) for this task. Return ONLY the title, nothing else. No quotes, no punctuation at the end.',
      },
      {
        role: 'user' as const,
        content: `User: ${userMessage.slice(0, 300)}\n\nAssistant: ${assistantMessage.slice(0, 300)}`,
      },
    ]

    const response = await createCompletion({
      model: DEFAULT_MODEL,
      messages: titleMessages,
      temperature: 0.3,
      max_tokens: 20,
      requestTimeoutMs: 15_000,
      abortSignal: request.signal,
      includeTemporalContext: false,
    })

    const title = cleanTitle(response.choices[0]?.message?.content?.trim())
    const usage = normalizeProviderUsage(response.usage)
    if (!usage) {
      throw new Error('The assistant provider did not return billable usage.')
    }
    await chargeServerTokenUsage(
      userId,
      conversationId,
      randomUUID(),
      usage,
      'title-tokens',
    )

    return Response.json({ title })
  } catch (error) {
    if (isOutOfCreditsError(error)) {
      return Response.json({
        error: error.message || OUT_OF_CREDITS_MESSAGE,
        code: error.code || OUT_OF_CREDITS_CODE,
        balance: error.balanceAfter,
        requiredCredits: error.requiredCredits,
      }, { status: 402 })
    }
    console.error('Title generation error:', error)
    return Response.json({ title: 'New task', error: 'Title generation failed' }, { status: 502 })
  }
}
