/**
 * Strip special tokens that leak when models fall back to text-mode tool calls.
 * Catches fullwidth vertical bar tokens (U+FF5C ｜) and BOS/EOS boundary tokens.
 */
const SPECIAL_TOKEN_RE = /<\/?[\s]*(?:\uFF5C|[|])[\s]*[A-Za-z0-9_]+[\s]*(?:\uFF5C|[|])[^>]*>/g
const SENTENCE_TOKEN_RE = /<[\s]*(?:\uFF5C|[|])[\s]*[\w\u2581]+[\s]*(?:\uFF5C|[|])[\s]*>/g

export function stripRawToolCallMarkup(text: string): string {
  return text
    .replace(/<\s*tool[_\s-]*calls?\b[^>]*>[\s\S]*?<\/\s*tool[_\s-]*calls?\s*>/gi, ' ')
    .replace(/&lt;\s*tool[_\s-]*calls?\b[^&]*&gt;[\s\S]*?&lt;\/\s*tool[_\s-]*calls?\s*&gt;/gi, ' ')
    .replace(/<\s*function\s*=\s*["']?[\w.-]+["']?\s*>[\s\S]*?<\/\s*function\s*>/gi, ' ')
    .replace(/&lt;\s*function\s*=\s*["']?[\w.-]+["']?\s*&gt;[\s\S]*?&lt;\/\s*function\s*&gt;/gi, ' ')
    .replace(/<\/?\s*tool[_\s-]*calls?\b[^>]*>/gi, ' ')
    .replace(/&lt;\/?\s*tool[_\s-]*calls?\b[^&]*&gt;/gi, ' ')
    .replace(/<\s*function\s*=\s*[^>]+>/gi, ' ')
    .replace(/<\/\s*function\s*>/gi, ' ')
    .replace(/&lt;\s*function\s*=\s*[^&]+&gt;/gi, ' ')
    .replace(/&lt;\/\s*function\s*&gt;/gi, ' ')
}

export function stripSpecialTokens(text: string): string {
  return stripRawToolCallMarkup(text)
    .replace(SPECIAL_TOKEN_RE, '')
    .replace(SENTENCE_TOKEN_RE, '')
}

export function stripThinkingTags(text: string): string {
  return stripRawToolCallMarkup(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\s*\|?\s*(?:begin|end)[_\s]*of[_\s]*thinking\s*\|?\s*>/gi, '')
    .replace(/\(end_of_thinking\)/g, '')
    .replace(/\b(?:end_of_thinking|begin_of_thinking|end_thinking|begin_thinking)\b/gi, '')
    .replace(/^\]\s+/, '')
}

export function stripStepMarkers(text: string): string {
  return text.replace(/<next_step\s*\/?>\n?/g, '')
}

export function stripPlanMarkers(text: string): string {
  return text
    // XML form: <plan>...</plan> (the model emits this around its per-step micro-plan)
    .replace(/<plan>[\s\S]*?<\/plan>\s*/gi, '')
    // Bare opening <plan> with no closing tag (mid-stream / partial flush)
    .replace(/<plan>\s*/gi, '')
    .replace(/<\/plan>\s*/gi, '')
    // Bracket form: [PLAN]...[/PLAN]
    .replace(/\\?\[PLAN\\?\][\s\S]*?\\?\[\/PLAN\\?\]/gi, '')
    .replace(/\\?\[PLAN\\?\]\s*\n(?:[ \t]*(?:\d+[.)]\s+|-\s+|\*\s+).+(?:\n|$))+/gi, '')
    .replace(/\\?\[STEP \d+:[\s\S]*?\\?\[\/STEP \d+\\?\]/gi, '')
    .replace(/\\?\[STEP \d+:.*?\\?\]/gi, '')
    .replace(/\\?\[\/STEP \d+\\?\]/gi, '')
}
