/**
 * Strip special tokens that leak when models fall back to text-mode tool calls.
 * Catches fullwidth vertical bar tokens (U+FF5C ｜) and BOS/EOS boundary tokens.
 */
const SPECIAL_TOKEN_RE = /<\/?[\s]*(?:\uFF5C|[|])[\s]*[A-Za-z0-9_]+[\s]*(?:\uFF5C|[|])[^>]*>/g
const SENTENCE_TOKEN_RE = /<[\s]*(?:\uFF5C|[|])[\s]*[\w\u2581]+[\s]*(?:\uFF5C|[|])[\s]*>/g
const DSML_MARKER = String.raw`(?:\uFF5C|[|])\s*(?:\uFF5C|[|])\s*DSML\s*(?:\uFF5C|[|])\s*(?:\uFF5C|[|])`
const DSML_TOOL_CALL_OPEN_RE = new RegExp(String.raw`<\s*${DSML_MARKER}\s*tool_calls\b[^>]*>`, 'i')
const DSML_TOOL_CALL_CLOSE_RE = new RegExp(String.raw`<\/\s*${DSML_MARKER}\s*tool_calls\s*>`, 'i')
const DSML_TOOL_CALL_BLOCK_RE = new RegExp(String.raw`<\s*${DSML_MARKER}\s*tool_calls\b[^>]*>[\s\S]*?<\/\s*${DSML_MARKER}\s*tool_calls\s*>`, 'gi')
const DSML_INVOKE_BLOCK_RE = new RegExp(String.raw`<\s*${DSML_MARKER}\s*invoke\b[^>]*>[\s\S]*?<\/\s*${DSML_MARKER}\s*invoke\s*>`, 'gi')
const DSML_PARAMETER_BLOCK_RE = new RegExp(String.raw`<\s*${DSML_MARKER}\s*parameter\b[^>]*>[\s\S]*?<\/\s*${DSML_MARKER}\s*parameter\s*>`, 'gi')
const DSML_TAG_RE = new RegExp(String.raw`<\/?\s*${DSML_MARKER}\s*(?:tool_calls|invoke|parameter)\b[^>]*>`, 'gi')
const INTERNAL_POLICY_LINE_RE = /^\s*(?:[*_`#>\-\s]*)?(?:INTERNAL_RECOVERY|FINAL_STEP_REDIRECT|BROWSER_ACTION_PREFLIGHT_BLOCKED|BLOCKED|FINAL ANSWER REQUIRED|FINAL SYNTHESIS TOOL REQUIRED|PHASE-END NARRATION REQUIRED|NARRATION REQUIRED BEFORE NEXT ACTION|NARRATION REQUIRED NOW|NARRATION CADENCE STATE|NARRATION DUE|PLAN PROGRESS|FINAL PHASE SWITCH|PHASE SWITCH|TOOL CALL CONTRACT|TOOL HEALTH|FINDINGS|FOCUS|AVOID|MODE|Plan step index|Action label|Your plan for this step|Deliverable step)\b[^\n\r]*$/gim
const INTERNAL_STEP_LINE_RE = /^\s*(?:[*_`#>\-\s]*)?(?:Step\s+\d+\s*\/\s*\d+:\s*["“][^"”]+["”]|\[DONE\]\s*\d+\.|→\s*\[NOW\]\s*\d+\.|\[\s*\]\s*\d+\.)[^\n]*$/gim
const FUTURE_ACTION_SENTENCE_RE = /(?:^|(?<=[.!?]\s))\s*(?:let me)\b[^.!?\n]*(?:[.!?]|$)/gi

export function stripTextModeToolCallBlocks(
  text: string,
  insideBlock = false,
): { text: string; insideBlock: boolean } {
  let output = ''
  let cursor = 0
  let inside = insideBlock

  while (cursor < text.length) {
    if (inside) {
      const closeMatch = DSML_TOOL_CALL_CLOSE_RE.exec(text.slice(cursor))
      if (!closeMatch) return { text: output, insideBlock: true }
      cursor += (closeMatch.index || 0) + closeMatch[0].length
      inside = false
      continue
    }

    const openMatch = DSML_TOOL_CALL_OPEN_RE.exec(text.slice(cursor))
    if (!openMatch) {
      output += text.slice(cursor)
      break
    }

    output += text.slice(cursor, cursor + (openMatch.index || 0))
    cursor += (openMatch.index || 0) + openMatch[0].length
    inside = true
  }

  return { text: output, insideBlock: inside }
}

export function stripRawToolCallMarkup(text: string): string {
  const withoutDsmlBlocks = stripTextModeToolCallBlocks(text).text
  return withoutDsmlBlocks
    .replace(DSML_TOOL_CALL_BLOCK_RE, ' ')
    .replace(DSML_INVOKE_BLOCK_RE, ' ')
    .replace(DSML_PARAMETER_BLOCK_RE, ' ')
    .replace(DSML_TAG_RE, ' ')
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

export function stripInternalPolicyScaffolding(text: string): string {
  return text
    .replace(INTERNAL_POLICY_LINE_RE, '')
    .replace(INTERNAL_STEP_LINE_RE, '')
    .replace(FUTURE_ACTION_SENTENCE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
}

export function stripSpecialTokens(text: string): string {
  return stripInternalPolicyScaffolding(stripRawToolCallMarkup(text))
    .replace(SPECIAL_TOKEN_RE, '')
    .replace(SENTENCE_TOKEN_RE, '')
}

export function stripThinkingTags(text: string): string {
  return stripInternalPolicyScaffolding(stripRawToolCallMarkup(text))
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
