/**
 * Frontend request helpers.
 *
 * This module intentionally does not load or embed any external instruction file.
 * It only detects frontend intent and enforces the local default that website
 * and app builds should use a Next.js + TSX structure unless standalone HTML
 * was explicitly requested.
 */

const FRONTEND_ARTIFACT_PATTERN =
  /\b(?:web\s*(?:site|page|app|ui)|website|webpage|site|landing\s*page|frontend|front-end|user\s+interface|ui|dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz|component|widget|form|layout|template|card|page|chart|graph|css|html|jsx|tsx|svg|tailwind|react\s+component)\b/i
const UNAMBIGUOUS_FRONTEND_ACTION_PATTERN =
  /\b(?:build|built|create|created|make|made|develop|developed|generate|generated|implement|implemented|code|coded|edit|edited|update|updated|improve|improved|fix|fixed|style|styled|style\s+up)\b/i
const FRONTEND_ACTION_THEN_ARTIFACT_PATTERN =
  /\b(?:build|create|make|develop|generate|implement|code|edit|update|improve|fix|style|style\s+up)\b[\s\S]{0,80}\b(?:web\s*(?:site|page|app|ui)|website|webpage|site|landing\s*page|frontend|front-end|user\s+interface|ui|dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz|component|widget|form|layout|template|card|page|chart|graph|css|html|jsx|tsx|svg|tailwind|react\s+component)\b/i
const FRONTEND_ARTIFACT_THEN_ACTION_PATTERN =
  /\b(?:web\s*(?:site|page|app|ui)|website|webpage|site|landing\s*page|frontend|front-end|user\s+interface|ui|dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz|component|widget|form|layout|template|card|page|chart|graph|css|html|jsx|tsx|svg|tailwind|react\s+component)\b[\s\S]{0,80}\b(?:build|built|create|created|make|made|develop|developed|generate|generated|implement|implemented|code|coded|edit|edited|update|updated|improve|improved|fix|fixed|style|styled|style\s+up)\b/i
const FRONTEND_DESIGN_COMMAND_PATTERN =
  /(?:^|[.!?]\s+|\b(?:please|then|and)\s+|\b(?:want|need|like)\s+(?:you\s+to\s+)?)design\b[\s\S]{0,80}\b(?:web\s*(?:site|page|app|ui)|website|webpage|site|landing\s*page|frontend|front-end|user\s+interface|ui|dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz|component|widget|form|layout|template|card|page|chart|graph)\b/i
const INFORMATIONAL_REQUEST_PREFIX_PATTERN =
  /^\s*(?:please\s+)?(?:research|analy[sz]e|explain|review|compare|investigate|summari[sz]e|describe|assess|evaluate|tell\s+me)\b/i
const INFORMATIONAL_THEN_FRONTEND_BUILD_PATTERN =
  /\b(?:then|and\s+then|after\s+that|also)\s+(?:build|create|make|design|develop|generate|implement|code|edit|update|improve|fix|style|style\s+up)\b[\s\S]{0,80}\b(?:web\s*(?:site|page|app|ui)|website|webpage|site|landing\s*page|frontend|front-end|user\s+interface|ui|dashboard|homepage|hero|navbar|sidebar|modal|interactive\s*tool|visuali[sz]ation|data\s*viz|component|widget|form|layout|template|card|page|chart|graph|css|html|jsx|tsx|svg|tailwind|react\s+component)\b/i
const DOCUMENT_PAGE_REQUEST_PATTERN = /\b(?:one|1|single)\s+page\s+(?:report|essay|paper|summary|document|article|story|writeup|write-up)\b/i
const STANDALONE_HTML_REQUEST_PATTERN = /\b(?:single|standalone|one-file|one file|plain|vanilla)\s+(?:html|html\/css|html\s+file)|\bindex\.html\b|\b(?:no|without)\s+(?:react|next\.?js|tsx)\b/i
const NEXT_TSX_FRONTEND_REQUEST_PATTERN = /\b(?:website|webpage|web\s*page|site|landing\s*page|web\s*app|frontend|front-end|ui|dashboard|interactive\s*tool|visuali[sz]ation|app|application)\b/i

export function isFrontendArtifactRequest(text: string): boolean {
  if (!text || !text.trim()) return false
  if (DOCUMENT_PAGE_REQUEST_PATTERN.test(text)) return false
  if (!FRONTEND_ARTIFACT_PATTERN.test(text)) return false
  if (
    INFORMATIONAL_REQUEST_PREFIX_PATTERN.test(text) &&
    !INFORMATIONAL_THEN_FRONTEND_BUILD_PATTERN.test(text)
  ) return false
  if (FRONTEND_DESIGN_COMMAND_PATTERN.test(text)) return true
  if (!UNAMBIGUOUS_FRONTEND_ACTION_PATTERN.test(text)) return false
  return FRONTEND_ACTION_THEN_ARTIFACT_PATTERN.test(text) ||
    FRONTEND_ARTIFACT_THEN_ACTION_PATTERN.test(text)
}

export function requestExplicitlyWantsStandaloneHtml(text: string): boolean {
  return STANDALONE_HTML_REQUEST_PATTERN.test(text)
}

export function shouldDefaultFrontendToNextTsx(text: string): boolean {
  if (!isFrontendArtifactRequest(text)) return false
  if (requestExplicitlyWantsStandaloneHtml(text)) return false
  return NEXT_TSX_FRONTEND_REQUEST_PATTERN.test(text)
}
