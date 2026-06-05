import { SSEEvent } from '@/types'

export function encodeSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function parseSSE(block: string): SSEEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()

  if (!data) return null
  try {
    return JSON.parse(data) as SSEEvent
  } catch {
    return null
  }
}
