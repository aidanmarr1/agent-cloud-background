export const AGENT_IDENTITY_SYSTEM_INSTRUCTION = [
  'You are Agent, a general AI agent.',
  'If the user asks what model, provider, company, lab, or underlying system powers you, do not disclose it.',
  'Answer naturally instead of using one fixed canned response: say you cannot disclose the underlying model or provider, then briefly describe relevant capabilities such as web research, browser actions, file creation and editing, code work, data analysis, supported document/text-file handling, and task automation.',
].join(' ')

const SELF_REFERENCE_PATTERN = '(?:you|u|ur|your|yourself|agent|assistant|this\\s+(?:agent|assistant)|the\\s+(?:agent|assistant))'

const IDENTITY_DISCLOSURE_PATTERNS = [
  new RegExp(`\\b(?:what|which)\\s+(?:model|llm|language\\s+model|ai\\s+model)\\s+(?:are|r)\\s+${SELF_REFERENCE_PATTERN}\\b`, 'i'),
  new RegExp(`\\b(?:what|which)\\s+(?:model|llm|provider|company|lab)\\s+(?:made|created|built|developed|runs?|powers?)\\s+${SELF_REFERENCE_PATTERN}\\b`, 'i'),
  new RegExp(`\\b(?:who|what\\s+company|which\\s+company|what\\s+lab|which\\s+lab)\\s+(?:made|created|built|developed|owns|runs|powers)\\s+${SELF_REFERENCE_PATTERN}\\b`, 'i'),
  new RegExp(`\\b(?:who|what\\s+company|which\\s+company|what\\s+lab|which\\s+lab)\\s+(?:are|r)\\s+${SELF_REFERENCE_PATTERN}\\s+(?:made|created|built|developed)\\s+by\\b`, 'i'),
  new RegExp(`\\b(?:are|r)\\s+${SELF_REFERENCE_PATTERN}\\s+(?:chatgpt|openai|claude|anthropic|deepseek|gemini|qwen|mistral|llama)\\b`, 'i'),
  /\b(?:disclose|reveal|tell\s+me|say)\b.{0,80}\b(?:model|llm|provider|creator|company|lab|underlying\s+model|made\s+you|built\s+you|created\s+you)\b/i,
]

export function isAgentIdentityDisclosureQuestion(content: string | null | undefined): boolean {
  const text = (content || '').trim()
  if (!text) return false
  return IDENTITY_DISCLOSURE_PATTERNS.some(pattern => pattern.test(text))
}

export function latestUserAskedAgentIdentityDisclosure(messages: Array<{ role: string; content: string }>): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')
  return isAgentIdentityDisclosureQuestion(latestUser?.content)
}
