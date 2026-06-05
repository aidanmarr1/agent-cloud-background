import { sanitizeNarrationText } from '@/lib/stream/cleaners'

const MAX_NARRATION_BUF = 1_500

export class NarrationBuffer {
  private buffer = ''

  append(text: string): void {
    this.buffer += text
  }

  get length(): number {
    return this.buffer.length
  }

  get isFull(): boolean {
    return this.buffer.length > MAX_NARRATION_BUF
  }

  /**
   * Flush buffer content, clean it, and return meaningful narration text.
   * Returns null if no meaningful narration found.
   */
  flush(): string | null {
    const text = sanitizeNarrationText(this.buffer, { maxSentences: 2, maxLength: 360, requireSignal: true })
    this.buffer = ''

    return text
  }

  reset(): void {
    this.buffer = ''
  }
}
