const QUESTION_OR_COMPARISON_PATTERN =
  /^(?:what|why|how|who|when|where|is|are|do|does|did|can|could|would|should|tell me|explain|compare)\b|[?]$/i

const KNOWN_DYNAMIC_ENTITY_PATTERN =
  /\b(?:Manus(?:\s+AI)?|OpenAI|ChatGPT|Claude|Anthropic|Gemini|Google\s+Gemini|Grok|xAI|DeepSeek|Qwen|Perplexity|Mistral|Meta\s+AI|Microsoft\s+Copilot|Copilot|Cursor|Windsurf|Devin|Replit|Lovable|Vercel|Bolt|Runway|Sora)\b/i

const AI_OR_PRODUCT_CONTEXT_PATTERN =
  /\b(?:AI|AIs|artificial intelligence|agent|agents|model|models|LLM|LLMs|chatbot|tool|tools|platform|product|service|company|startup|capabilit(?:y|ies)|features?|pricing|release|launch|workflow|automation|different|difference|unique|compare|versus|vs\.?|better|worse)\b/i

export function isDynamicKnowledgeQuestion(text: string | null | undefined): boolean {
  if (!text) return false
  const normalized = text.trim()
  if (!normalized) return false

  return QUESTION_OR_COMPARISON_PATTERN.test(normalized) &&
    KNOWN_DYNAMIC_ENTITY_PATTERN.test(normalized) &&
    AI_OR_PRODUCT_CONTEXT_PATTERN.test(normalized)
}
