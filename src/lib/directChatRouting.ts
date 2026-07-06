import { isDynamicKnowledgeQuestion } from './dynamicKnowledge'
import { isContextualTaskUpdate } from './conversationContext'
import { isAgentIdentityDisclosureQuestion } from './agentIdentity'

export interface DirectChatRouteMessage {
  role: string
  content: string
  attachments?: unknown[]
}

const SIMPLE_SOCIAL_PATTERN = /^(hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks|thank you|thx|ok|okay|got it|sounds good|sure|alright)\b/i
const URL_OR_DOMAIN_PATTERN = /https?:\/\/|(?:^|\s)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i
const LIVE_OR_TIME_SENSITIVE_PATTERN = /\b(latest|current|today|yesterday|tomorrow|recent|news|price|stock|weather|score|schedule|live|up[-\s]?to[-\s]?date)\b/i
const BROWSER_ACTION_PATTERN = /\b(go to|navigate|open\s+(?:the\s+)?(?:site|website|page|url)|click|log in|sign in|fill out|select|choose|scroll|browser|browse)\b/i
const AI_CHAT_ACTION_PATTERN =
  /\b(?:debate|argue|chat|talk|message|ask|prompt|converse|discuss)\b.{0,100}\b(?:gemini|google\s+gemini|chatgpt|openai|claude|anthropic\s+claude|copilot|perplexity|grok)\b/i
const EXTERNAL_RESEARCH_PATTERN = /\b(research|search|find|investigate|cite|citation|sources?|look up|google|web|internet)\b/i
const FILE_OR_MEDIA_PATTERN = /\b(image|images|photo|photos|picture|pictures|asset|assets|file|files|folder|zip|\.skill|pdf|docx|spreadsheet|attachment|upload|download|retrieve|real one)\b/i
const MUTATION_OR_RUNTIME_PATTERN = /\b(remove|delete|edit|change|update|set up|setup|configure|install|run|test|start|stop|restart|deploy|commit|push)\b/i
const DELIVERABLE_PATTERN = /\b(build|create|make|develop|design|implement|debug|fix|refactor|write|draft|generate|produce)\b.*\b(app|website|site|webpage|page|code|function|script|file|report|dashboard|component|slides?|slide deck|deck|presentation|pdf|document)\b/i
const REPORT_WITH_EVIDENCE_PATTERN = /\b(report|analysis|deep dive|research brief|whitepaper|literature review)\b.*\b(cite|citation|sources?|evidence|references?)\b/i

const EXPLICIT_DIRECT_PATTERN =
  /\b(?:no|dont|don't|do not|without|skip)\s+(?:web|search(?:ing)?|research(?:ing)?|browse|browsing|sources?|citations?)\b|\b(?:just|simply|only)\s+(?:tell|answer|explain|say)\b|\banswer\s+(?:directly|from your knowledge|without research)\b|\b(?:tell me|explain)\s+(?:directly|without research)\b/i

const AGENT_META_QUESTION_PATTERN =
  /\b(?:what|which)\s+(?:instructions|rules|guidelines|system instructions)\b|\b(?:what can you do|what are your capabilities|how do you work|who are you|what model are you|which model are you|what agent are you)\b/i

const GENERAL_KNOWLEDGE_PATTERN =
  /^(?:what|why|how|who|when|where|can you explain|could you explain|explain|tell me about|define|summarize|compare|what's|whats|is|are|do|does|can)\b/i
const PRIOR_ATTACHMENT_REFERENCE_PATTERN =
  /\b(?:attached|attachment|file|image|photo|picture|document|pdf)\b|\b(?:summari[sz]e|describe|read|analy[sz]e|explain|review|what(?:'s| is| does)?|tell me about).{0,80}\b(?:it|that|this|them|those|above)\b|\b(?:it|that|this|them|those|above)\b.{0,80}\b(?:summari[sz]e|describe|read|analy[sz]e|explain|review)\b/i

function lastUserMessage(messages: DirectChatRouteMessage[]): DirectChatRouteMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'user')
}

function messageHasAttachments(message: DirectChatRouteMessage | undefined): boolean {
  return Array.isArray(message?.attachments) && message.attachments.length > 0
}

function hasPriorAttachments(messages: DirectChatRouteMessage[], latestMessage: DirectChatRouteMessage): boolean {
  const latestIndex = messages.lastIndexOf(latestMessage)
  const priorMessages = latestIndex >= 0 ? messages.slice(0, latestIndex) : messages.slice(0, -1)
  return priorMessages.some(messageHasAttachments)
}

function wordCount(content: string): number {
  return content.split(/\s+/).filter(Boolean).length
}

function isExplicitDirectAnswerRequest(content: string): boolean {
  return EXPLICIT_DIRECT_PATTERN.test(content)
}

function requestsExternalWork(content: string): boolean {
  if (AI_CHAT_ACTION_PATTERN.test(content)) return true
  if (BROWSER_ACTION_PATTERN.test(content)) return true
  if (FILE_OR_MEDIA_PATTERN.test(content)) return true
  if (MUTATION_OR_RUNTIME_PATTERN.test(content)) return true
  if (DELIVERABLE_PATTERN.test(content)) return true
  if (REPORT_WITH_EVIDENCE_PATTERN.test(content)) return true
  if (LIVE_OR_TIME_SENSITIVE_PATTERN.test(content)) return true
  if (isExplicitDirectAnswerRequest(content)) return false
  if (isDynamicKnowledgeQuestion(content)) return true
  return EXTERNAL_RESEARCH_PATTERN.test(content)
}

export function shouldUseDirectChat(messages: DirectChatRouteMessage[]): boolean {
  const lastUser = lastUserMessage(messages)
  if (!lastUser?.content) return false

  const content = lastUser.content.trim()
  if (!content) return false

  const hasPriorTaskContext = messages.length > 1
  const words = wordCount(content)

  if (messageHasAttachments(lastUser)) return false
  if (hasPriorAttachments(messages, lastUser) && PRIOR_ATTACHMENT_REFERENCE_PATTERN.test(content)) return false

  if (isAgentIdentityDisclosureQuestion(content)) return true
  if (URL_OR_DOMAIN_PATTERN.test(content)) return false
  if (requestsExternalWork(content)) return false

  if (isExplicitDirectAnswerRequest(content)) return true
  if (AGENT_META_QUESTION_PATTERN.test(content)) return true
  if (SIMPLE_SOCIAL_PATTERN.test(content)) return true
  if (hasPriorTaskContext && isContextualTaskUpdate(messages)) return false
  if (words <= 3) return true

  if (GENERAL_KNOWLEDGE_PATTERN.test(content) && words <= 80) return true

  // Longer follow-ups that are not clearly general Q&A often refer to an active task.
  if (hasPriorTaskContext) return false

  return false
}
