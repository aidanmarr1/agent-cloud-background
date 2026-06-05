import { effectiveTaskRequest } from '@/lib/conversationContext'
import type { TaskType } from './TaskStrategy'

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

export function requestSubject(messages: Array<{ role: string; content: string }>, maxLength = 72): string {
  const request = effectiveTaskRequest(messages)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const cleaned = request
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:please\s+)?(?:research|find out|look up|investigate|analy[sz]e|explain|tell me|write|create|build|make|implement|fix|update)\s+(?:all\s+)?(?:about\s+)?/i, '')
    .replace(/^(?:all\s+)?(?:about\s+)/i, '')
    .trim()
  return humanTopicLabel(cleaned || request, 'the requested topic', maxLength)
}

export function humanTopicLabel(topic: string | null | undefined, fallback = 'the task', maxLength = 72): string {
  let cleaned = (topic || '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()

  if (!cleaned) return fallback
  cleaned = cleaned.slice(0, maxLength).replace(/\s+\S*$/, '').trim() || cleaned.slice(0, maxLength).trim()
  cleaned = cleaned
    .replace(/\bai\b/gi, 'AI')
    .replace(/\bml\b/gi, 'machine learning')

  const words = cleaned.split(/\s+/)
  if (/^[a-z0-9][a-z0-9\s'&./-]*$/i.test(cleaned) && words.length <= 5) {
    return words
      .map((word) => {
        if (/^(AI|API|UI|UX|ML)$/i.test(word)) return word.toUpperCase()
        if (/^[a-z][a-z'-]*$/.test(word)) return `${word[0].toUpperCase()}${word.slice(1)}`
        return word
      })
      .join(' ')
  }

  return cleaned
}

export function sandboxReadyAcknowledgementForTask(
  messages: Array<{ role: string; content: string }>,
  taskType?: TaskType | 'action',
): string {
  const raw = effectiveTaskRequest(messages) || latestUserTaskText(messages)
  const subject = requestSubject(messages, 64)
  const lower = raw.toLowerCase()
  const resolvedType = taskType === 'action' ? 'browse' : taskType

  if (resolvedType === 'build' || resolvedType === 'code') {
    return `Cloud sandbox and browser are ready; building ${subject} in the workspace.`
  }
  if (resolvedType === 'browse') {
    return `Cloud sandbox and browser are ready; working on ${subject} in the browser.`
  }
  if (/\b(?:research|find out|look up|investigate|compare|current|latest|source|sources)\b/.test(lower)) {
    return `Cloud sandbox and browser are ready; researching ${subject} with live sources.`
  }
  return `Cloud sandbox and browser are ready; starting ${subject}.`
}
