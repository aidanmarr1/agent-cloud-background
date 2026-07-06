import { effectiveTaskRequest } from '@/lib/conversationContext'

export function latestUserTaskText(messages: Array<{ role: string; content: string }>): string {
  const latest = [...messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string')
  return latest?.content || ''
}

export function conciseTaskSubject(text: string, maxLength = 84): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:please\s+)?use\s+(?:your\s+)?(?:chromium\s+)?browser\s+and\s+sandbox\s+(?:to\s+)?/i, '')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= maxLength) return cleaned
  const clipped = cleaned.slice(0, maxLength).replace(/\s+\S*$/, '').trim()
  return clipped || cleaned.slice(0, maxLength).trim()
}

export function cleanTaskSubjectText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:i\s+(?:need|want)\s+you\s+to|make\s+sure\s+to|just)\s+/i, '')
    .replace(/^(?:conduct|do|perform|run|carry\s+out)\s+(?:the\s+)?(?:(?:deepest\s+possible|deep|comprehensive|thorough|detailed|in[-\s]?depth|extensive|complete|full)\s+)*(?:research|investigation|analysis)\s+(?:all\s+)?(?:about|on|into|regarding|for)\s+/i, '')
    .replace(/^(?:a\s+|an\s+|the\s+)?(?:(?:extremely|really|very|super|ultra|highly|incredibly)\s+)*(?:(?:deep|comprehensive|thorough|detailed|in[-\s]?depth|extensive|complete|full)\s+)*(?:research|investigation|analysis|overview|guide|report|write[-\s]?up)\s+(?:all\s+)?(?:about|on|into|regarding|for)\s+/i, '')
    .replace(/^(?:a\s+|an\s+|the\s+)?(?:(?:extremely|really|very|super|ultra|highly|incredibly)\s+)*(?:(?:deep|comprehensive|thorough|detailed|in[-\s]?depth|extensive|complete|full)\s+)*(?:research|find\s+out|look\s+up|investigate|analy[sz]e|explain|tell\s+me|write|draft|compose|prepare|create|build|make|implement|fix|update)\s+(?:all\s+)?(?:about\s+)?/i, '')
    .replace(/\s+(?:and|then)\s+(?:produce|create|write|draft|deliver|make|prepare)\b[\s\S]*$/i, '')
    .replace(/\s+that\s+(?:answers?|explains?|covers?|includes?)\b[\s\S]*$/i, '')
    .replace(/^(?:a\s+|an\s+|the\s+)?(?:quick|brief|concise|short)\s+/i, '')
    .replace(/^(?:a\s+|an\s+|the\s+)?(?:report|write[-\s]?up|memo|overview|brief)\s+(?:on|about|for)\s+/i, '')
    .replace(/\b(?:very quickly|real quick|asap|super quick|quickly|quick|briefly|brief|short|concise|succinct)\b/gi, ' ')
    .replace(/^(?:all\s+)?(?:about\s+)/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
}

export function requestSubject(messages: Array<{ role: string; content: string }>, maxLength = 72): string {
  const request = effectiveTaskRequest(messages)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const cleaned = cleanTaskSubjectText(request)
  return humanTopicLabel(cleaned || request, 'the requested topic', maxLength)
}

export function humanTopicLabel(topic: string | null | undefined, fallback = 'the task', maxLength = 72): string {
  let cleaned = (topic || '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()

  if (!cleaned) return fallback
  cleaned = cleaned.length > maxLength
    ? (cleaned.slice(0, maxLength).replace(/\s+\S*$/, '').trim() || cleaned.slice(0, maxLength).trim())
    : cleaned
  cleaned = cleaned
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bml\b/gi, 'machine learning')
    .replace(/\biphones?\b/gi, (match) => match.toLowerCase().endsWith('s') ? 'iPhones' : 'iPhone')

  const words = cleaned.split(/\s+/)
  const hasPhraseStopword = /\b(?:a|an|the|of|for|and|or|to|in|on|with|about)\b/i.test(cleaned)
  if (/^[a-z0-9][a-z0-9\s'&./-]*$/i.test(cleaned) && words.length <= 5 && !hasPhraseStopword) {
    return words
      .map((word) => {
        if (/^(AI|API|UI|UX|ML)$/i.test(word)) return word.toUpperCase()
        if (/^iPhones?$/.test(word)) return word
        if (/^[a-z][a-z'-]*$/.test(word)) return `${word[0].toUpperCase()}${word.slice(1)}`
        return word
      })
      .join(' ')
  }

  return cleaned
}
