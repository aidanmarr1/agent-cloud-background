/**
 * Frontend request helpers.
 *
 * This module intentionally does not load or embed any external instruction file.
 * It only detects frontend intent and enforces the local default that website
 * and app builds should use a Next.js + TSX structure unless standalone HTML
 * was explicitly requested.
 */

const STRONG_FRONTEND_REQUEST_PATTERNS: RegExp[] = [
  /\bweb\s*(?:site|page|app|ui)\b/i,
  /\b(?:website|webpage|site|landing\s*page|frontend|front-end|ui|ux)\b/i,
  /\b(?:dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz)\b/i,
  /\b(?:css|html|jsx|tsx|svg|tailwind|react\s+component)\b/i,
]

const CONDITIONAL_FRONTEND_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:build|create|make|design|develop|generate|implement|code|write|edit|update|improve|fix|style|style\s+up)\b[\s\S]{0,80}\b(?:component|widget|form|layout|template|card|page|chart|graph)\b/i,
  /\b(?:component|widget|form|layout|template|card|page|chart|graph)\b[\s\S]{0,80}\b(?:build|create|make|design|develop|generate|implement|code|write|edit|update|improve|fix|style)\b/i,
]

const FRONTEND_BUILD_INTENT_PATTERN = /\b(?:build|create|make|design|develop|generate|implement|code|write|edit|update|improve|fix|style|style\s+up|draft)\b/i
const DOCUMENT_PAGE_REQUEST_PATTERN = /\b(?:one|1|single)\s+page\s+(?:report|essay|paper|summary|document|article|story|writeup|write-up)\b/i
const STANDALONE_HTML_REQUEST_PATTERN = /\b(?:single|standalone|one-file|one file|plain|vanilla)\s+(?:html|html\/css|html\s+file)|\bindex\.html\b|\b(?:no|without)\s+(?:react|next\.?js|tsx)\b/i
const NEXT_TSX_FRONTEND_REQUEST_PATTERN = /\b(?:website|webpage|web\s*page|site|landing\s*page|web\s*app|frontend|front-end|ui|dashboard|interactive\s*tool|visuali[sz]ation|app|application)\b/i

export function isFrontendArtifactRequest(text: string): boolean {
  if (!text || !text.trim()) return false
  if (DOCUMENT_PAGE_REQUEST_PATTERN.test(text)) return false
  return CONDITIONAL_FRONTEND_REQUEST_PATTERNS.some(pattern => pattern.test(text)) ||
    (FRONTEND_BUILD_INTENT_PATTERN.test(text) && STRONG_FRONTEND_REQUEST_PATTERNS.some(pattern => pattern.test(text)))
}

export function requestExplicitlyWantsStandaloneHtml(text: string): boolean {
  return STANDALONE_HTML_REQUEST_PATTERN.test(text)
}

export function shouldDefaultFrontendToNextTsx(text: string): boolean {
  if (!isFrontendArtifactRequest(text)) return false
  if (requestExplicitlyWantsStandaloneHtml(text)) return false
  return NEXT_TSX_FRONTEND_REQUEST_PATTERN.test(text)
}
