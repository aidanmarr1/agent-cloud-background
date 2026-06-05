const FINAL_CONTENT_START_PATTERN =
  /^(?:Done\s*[-:]\s|Task completed\b|\*\*?\s*(?:Summary|Deliverables|Result|Final)\b|#{1,6}\s|Here(?:'|\u2019)?s\b|Here (?:is|are)\b|Below\b|[-*]\s+|\d+[.)]\s+)/i

const ACTION_TITLE_START_PATTERN =
  /^(?:confirm|research|summari[sz]e|write|create|build|fix|implement|gather|find|open|verify|check|analy[sz]e|compile|draft|navigate|review|extract|locate|map|assess|identify|select|add|enter|click|scroll)\b/i

const ACK_CONTINUATION_START_PATTERN =
  /^(?:i(?:'|\u2019)?ll|i will|i(?:'|\u2019)?m going to|i am going to|then i(?:'|\u2019)?ll|and i(?:'|\u2019)?ll|covering|focused on|with|while|including|so)\b/i

const DANGLING_ACK_END_PATTERN =
  /(?:\b(?:quick|brief|short|step|2-step|3-step|three-step|plan|research|scan|about|around|covering|focused on|for|with|and|or|to|of|the|a|an|then|before|after|while|including|across|into|from|using|by)\b|[-,:;(/])$/i

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim())
}

function isFinalContentStart(text: string): boolean {
  return FINAL_CONTENT_START_PATTERN.test(text.trim())
}

function isLikelyStandaloneActionTitle(text: string): boolean {
  const trimmed = text.trim()
  if (!ACTION_TITLE_START_PATTERN.test(trimmed)) return false
  return countWords(trimmed) <= 18 && !/[.!?]$/.test(trimmed)
}

function shouldMergeAcknowledgmentParagraph(current: string, next: string, paragraphCount: number): boolean {
  if (paragraphCount >= 3) return false
  const trimmedNext = next.trim()
  if (!trimmedNext || isFinalContentStart(trimmedNext)) return false

  const currentWords = countWords(current)
  const nextWords = countWords(trimmedNext)
  if (currentWords > 55 || nextWords > 80) return false

  const stronglyIncomplete =
    !hasTerminalPunctuation(current) ||
    DANGLING_ACK_END_PATTERN.test(current.trim())

  if (stronglyIncomplete) return true
  if (isLikelyStandaloneActionTitle(trimmedNext)) return false

  const looksLikeContinuation =
    ACK_CONTINUATION_START_PATTERN.test(trimmedNext) ||
    /^[a-z0-9("'\u201c]/.test(trimmedNext)

  return looksLikeContinuation && currentWords < 45
}

export function splitTaskMessageContent(content: string, hasTaskChrome: boolean): { acknowledgment: string; finalContent: string } {
  const trimmed = content.trim()
  if (!hasTaskChrome) return { acknowledgment: '', finalContent: trimmed }
  if (!trimmed) return { acknowledgment: '', finalContent: '' }

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)

  if (paragraphs.length === 0) return { acknowledgment: '', finalContent: '' }

  let ackEnd = 1
  while (
    ackEnd < paragraphs.length &&
    shouldMergeAcknowledgmentParagraph(paragraphs.slice(0, ackEnd).join(' '), paragraphs[ackEnd], ackEnd)
  ) {
    ackEnd++
  }

  return {
    acknowledgment: paragraphs.slice(0, ackEnd).join(' ').replace(/\s+/g, ' ').trim(),
    finalContent: paragraphs.slice(ackEnd).join('\n\n').trim(),
  }
}

export function extractTaskAcknowledgment(content: string): string {
  return splitTaskMessageContent(content, true).acknowledgment
}
