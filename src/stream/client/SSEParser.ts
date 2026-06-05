import type { SSEEvent } from '@/types'

function findEventDelimiter(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1 && crlf === -1) return null
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

function parseSSEBlock(block: string): SSEEvent | null {
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

/**
 * Pure async generator that reads a ReadableStream and yields parsed SSEEvent objects.
 * No store interaction, no side effects.
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
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

        const event = parseSSEBlock(rawEvent)
        if (event) yield event

        delimiter = findEventDelimiter(buffer)
      }
    }

    // Process any remaining buffer content (final event without trailing \n\n)
    if (buffer.trim()) {
      const event = parseSSEBlock(buffer)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}
