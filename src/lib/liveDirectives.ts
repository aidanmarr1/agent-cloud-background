import { randomUUID } from 'crypto'
import { MAX_TASK_INPUT_CHARS, clampTaskInput } from '@/lib/inputLimits'

export const MAX_LIVE_DIRECTIVE_CHARS = MAX_TASK_INPUT_CHARS
export const MAX_QUEUED_LIVE_DIRECTIVES = 12

export interface LiveDirective {
  id: string
  conversationId: string
  content: string
  createdAt: number
  userId?: string
}

interface LiveDirectiveState {
  queues: Map<string, LiveDirective[]>
}

const stateKey = '__agentLiveDirectiveState' as const
const liveDirectiveState: LiveDirectiveState =
  (globalThis as unknown as Record<string, LiveDirectiveState>)[stateKey] ??
  ((globalThis as unknown as Record<string, LiveDirectiveState>)[stateKey] = {
    queues: new Map(),
  })

function normalizeDirectiveContent(content: string): string {
  return clampTaskInput(content
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim())
}

export function enqueueLiveDirective(
  conversationId: string,
  content: string,
  userId?: string,
): LiveDirective {
  const normalized = normalizeDirectiveContent(content)
  if (!normalized) {
    throw new Error('Live directive cannot be empty.')
  }

  const directive: LiveDirective = {
    id: randomUUID(),
    conversationId,
    content: normalized,
    createdAt: Date.now(),
    userId,
  }

  const existing = liveDirectiveState.queues.get(conversationId) ?? []
  const next = [...existing, directive].slice(-MAX_QUEUED_LIVE_DIRECTIVES)
  liveDirectiveState.queues.set(conversationId, next)
  return directive
}

export function drainLiveDirectives(conversationId: string, userId?: string): LiveDirective[] {
  const queue = liveDirectiveState.queues.get(conversationId)
  if (!queue?.length) return []

  const drained: LiveDirective[] = []
  const remaining: LiveDirective[] = []
  for (const directive of queue) {
    if (!userId || !directive.userId || directive.userId === userId) {
      drained.push(directive)
    } else {
      remaining.push(directive)
    }
  }

  if (remaining.length > 0) {
    liveDirectiveState.queues.set(conversationId, remaining)
  } else {
    liveDirectiveState.queues.delete(conversationId)
  }

  return drained
}

export function getLiveDirectiveQueueLength(conversationId: string): number {
  return liveDirectiveState.queues.get(conversationId)?.length ?? 0
}

export function clearLiveDirectives(conversationId?: string): void {
  if (conversationId) {
    liveDirectiveState.queues.delete(conversationId)
    return
  }
  liveDirectiveState.queues.clear()
}

export const clearLiveDirectivesForTest = clearLiveDirectives
