import { normalizeMarkdownForDisplay } from './cleaners'

const FINAL_CONTENT_START_PATTERN =
  /^(?:Done\s*[-:]\s|Task completed\b|\*\*?\s*(?:Summary|Deliverables|Result|Final)\b|#{1,6}\s?|Here(?:'|\u2019)?s\b|Here (?:is|are)\b|Below\b|[-*]\s+|\d+[.)]\s+)/i

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

function findFinalContentStart(text: string): number {
  let offset = 0
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const leading = line.match(/^\s*/)?.[0].length ?? 0
    const trimmed = line.trim()
    if (trimmed && isFinalContentStart(trimmed)) return offset + leading
    offset += line.length + 1
  }
  return -1
}

function repairHeadingLine(line: string): string {
  const heading = line.match(/^(#{1,6})\s+(.+)$/)
  if (!heading) return line

  const marker = heading[1]
  const body = heading[2].trim()
  const brokenBoldLabel = body.match(/^([^:\n]{2,80}):\*\*\s+(.+)$/)
  if (brokenBoldLabel) {
    return `${marker} ${brokenBoldLabel[1].trim()}\n\n${brokenBoldLabel[2].trim()}`
  }

  const punctuationBoundary = body.match(/^(.{4,120}?[.!?])(?=[A-Z0-9])/)
  if (punctuationBoundary) {
    const title = punctuationBoundary[1].trim()
    const rest = body.slice(punctuationBoundary[1].length).trim()
    if (rest.length >= 12) return `${marker} ${title}\n\n${rest}`
  }

  const narrativeBoundary = body.match(/^(.{8,120}?)(?=(?:The|This|These|Those|It|Apple|MacRumors|According|However)\b)/)
  if (narrativeBoundary) {
    const title = narrativeBoundary[1].trim()
    const rest = body.slice(narrativeBoundary[1].length).trim()
    if (title.length >= 8 && rest.length >= 20) return `${marker} ${title}\n\n${rest}`
  }

  return line
}

function normalizeFinalContent(content: string): string {
  return normalizeMarkdownForDisplay(content)
    .replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2')
    .split('\n')
    .filter(line => !isProcessMetricCompletionLine(line))
    .map(repairHeadingLine)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isProcessMetricCompletionLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^i\s+grounded\s+it\s+with\s+\d+\s+completed\s+(?:search|browse|search\/browse|tool|source|check)/i.test(trimmed)) return true
  if (/^i\s+(?:completed|ran|performed|used)\s+\d+\s+(?:completed\s+)?(?:searches|browses|checks|tool calls|source checks|search\/browse checks)\b/i.test(trimmed)) return true
  if (/^here(?:'|\u2019)?s\s+the\s+completed\s+(?:synthesi[sz]e|compile|write|draft|deliver|finali[sz]e|review)\b/i.test(trimmed)) return true
  return false
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
  if (!hasTaskChrome) return { acknowledgment: '', finalContent: normalizeFinalContent(trimmed) }
  if (!trimmed) return { acknowledgment: '', finalContent: '' }
  const normalized = normalizeMarkdownForDisplay(trimmed.replace(/\r\n/g, '\n'))

  const finalStart = findFinalContentStart(normalized)
  if (finalStart === 0) {
    return { acknowledgment: '', finalContent: normalizeFinalContent(normalized) }
  }
  if (finalStart > 0) {
    const possibleAck = normalized.slice(0, finalStart).trim()
    const possibleFinal = normalized.slice(finalStart).trim()
    if (possibleAck && countWords(possibleAck) <= 90) {
      return {
        acknowledgment: possibleAck.replace(/\s+/g, ' ').trim(),
        finalContent: normalizeFinalContent(possibleFinal),
      }
    }
  }

  const paragraphs = normalized
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
    finalContent: normalizeFinalContent(paragraphs.slice(ackEnd).join('\n\n')),
  }
}

export function extractTaskAcknowledgment(content: string): string {
  return splitTaskMessageContent(content, true).acknowledgment
}
