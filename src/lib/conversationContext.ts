export interface ConversationContextMessage {
  role: string
  content: string
}

const CONTEXTUAL_UPDATE_WORD_LIMIT = 32
const CONTEXTUAL_UPDATE_PATTERN =
  /^(?:no\b.+|not\b.+|don'?t\b.+|do\s+not\b.+|instead\b.+|actually\b.+|wait\b.*|hold\s+on\b.*|also\b.+|retry\b.+|continue\b.+|go\s+back\b.+|that\b.+|this\b.+|same\b.+|previous\b.+|current\b.+)/i
const CONTEXTUAL_EDIT_PATTERN =
  /^(?:use|choose|pick|select|make|change|switch|replace|remove|skip|avoid|exclude|include|add|try)\b.+/i
const CONTEXTUAL_REFERENCE_PATTERN =
  /\b(?:it|that|this|those|them|there|above|earlier|previous|current|same|instead|now|also)\b/i

function userMessages(messages: ConversationContextMessage[]): ConversationContextMessage[] {
  return messages.filter(message => message.role === 'user' && message.content.trim())
}

export function latestUserText(messages: ConversationContextMessage[]): string {
  return userMessages(messages).at(-1)?.content.trim() || ''
}

export function previousUserText(messages: ConversationContextMessage[]): string {
  const users = userMessages(messages)
  return users.length >= 2 ? users[users.length - 2]?.content.trim() || '' : ''
}

export function isContextualTaskUpdateText(text: string | null | undefined): boolean {
  const trimmed = text?.trim()
  if (!trimmed) return false
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  if (wordCount > CONTEXTUAL_UPDATE_WORD_LIMIT) return false
  if (CONTEXTUAL_UPDATE_PATTERN.test(trimmed)) return true
  return CONTEXTUAL_EDIT_PATTERN.test(trimmed) && CONTEXTUAL_REFERENCE_PATTERN.test(trimmed)
}

export function isContextualTaskUpdate(messages: ConversationContextMessage[]): boolean {
  const latest = latestUserText(messages)
  if (!isContextualTaskUpdateText(latest)) return false
  return !!previousUserText(messages) || messages.some(message => message.role === 'assistant' && message.content.trim())
}

export function effectiveTaskRequest(messages: ConversationContextMessage[]): string {
  const latest = latestUserText(messages)
  if (!isContextualTaskUpdate(messages)) return latest

  const previous = previousUserText(messages)
  return [
    previous || 'Continue the previous task.',
    `Latest user interruption/correction: ${latest}`,
  ].filter(Boolean).join('\n\n')
}
