import type { SSEEvent } from '@/types'

export type StreamSequenceDecision =
  | { kind: 'dispatch'; seq: number | null }
  | { kind: 'ignore' }
  | { kind: 'reconnect'; expectedSeq: number; receivedSeq: number | null }

/**
 * Durable task events must be applied exactly in sequence order. Keep-alive
 * heartbeats and latest-only browser frames deliberately live outside that
 * sequence: neither is allowed to advance the durable replay cursor.
 */
export function classifyStreamSequence(
  event: SSEEvent,
  runId: string | undefined,
  highestContiguousSeq: number,
): StreamSequenceDecision {
  if (!runId) return { kind: 'dispatch', seq: null }

  const seq = event.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
    if (event.type === 'heartbeat') return { kind: 'ignore' }
    if (event.type === 'browser_frame') return { kind: 'dispatch', seq: null }
    return {
      kind: 'reconnect',
      expectedSeq: highestContiguousSeq + 1,
      receivedSeq: null,
    }
  }

  if (seq <= highestContiguousSeq) return { kind: 'ignore' }

  const expectedSeq = highestContiguousSeq + 1
  if (seq !== expectedSeq) {
    return { kind: 'reconnect', expectedSeq, receivedSeq: seq }
  }

  return { kind: 'dispatch', seq }
}
