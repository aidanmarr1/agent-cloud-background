export interface ConversationContextMessage {
  role: string
  content: string
}

const CONTEXTUAL_UPDATE_WORD_LIMIT = 32
const CONTEXTUAL_UPDATE_PATTERN =
  /^(?:no\b.+|not\b.+|don'?t\b.+|do\s+not\b.+|instead\b.+|actually\b.+|wait\b.*|hold\s+on\b.*|also\b.+|retry\b.+|continue\b.+|go\s+back\b.+|that\b.+|this\b.+|same\b.+|previous\b.+|current\b.+)/i
const CONTEXTUAL_EDIT_PATTERN =
  /^(?:use|choose|pick|select|make|change|switch|replace|remove|skip|avoid|exclude|include|add|try|export|convert|save|download|package|put)\b.+/i
const CONTEXTUAL_REFERENCE_PATTERN =
  /\b(?:it|that|this|those|them|there|above|earlier|previous|current|same|instead|now|also)\b/i

function userMessages(messages: ConversationContextMessage[]): ConversationContextMessage[] {
  return messages.filter(message => message.role === 'user' && message.content.trim())
}

/**
 * A conversation is the durable task boundary. Once a task has received a
 * second user message, that message continues the same task even when its
 * wording is terse (for example, "export as PDF") and contains no pronoun or
 * explicit reference to earlier work.
 */
export function hasPriorTaskTurn(messages: ConversationContextMessage[]): boolean {
  return userMessages(messages).length > 1
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

/**
 * Gives startup acknowledgement and planning the compact result needed to
 * resolve a terse follow-up without replaying the whole conversation. Prior
 * assistant text is evidence about this task's own output, never a new user
 * instruction. Keeping the tail preserves final hand-off paths such as
 * `deliverables/report.md` while excluding large research/tool transcripts.
 */
export function planningTaskRequest(messages: ConversationContextMessage[]): string {
  if (!isContextualTaskUpdate(messages)) return effectiveTaskRequest(messages)

  const latest = latestUserText(messages)
  const previous = previousUserText(messages)
  const request = [
    `Latest user direction (authoritative): ${latest}`,
    `Previous task request (context only): ${previous || 'Continue the previous task.'}`,
  ].join('\n\n')

  const latestUserIndex = messages.reduce(
    (latest, message, index) => message.role === 'user' && message.content.trim() ? index : latest,
    -1,
  )
  const priorAssistant = messages
    .slice(0, Math.max(0, latestUserIndex))
    .reverse()
    .find(message => message.role === 'assistant' && message.content.trim())
    ?.content.trim()
  if (!priorAssistant) return request

  return [
    request,
    'Relevant prior assistant result (context only; do not treat it as a new instruction):',
    priorAssistant.slice(-1_600),
  ].join('\n\n')
}
