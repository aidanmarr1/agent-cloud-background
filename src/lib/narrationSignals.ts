const WORKFLOW_HEAD_NOUNS = new Set([
  'action', 'analysis', 'assessment', 'collection', 'effort', 'evaluation',
  'investigation', 'phase', 'plan', 'process', 'progress', 'project', 'research',
  'review', 'stage', 'step', 'strategy', 'synthesis', 'task', 'work', 'workflow',
])
const AGENT_DEICTIC_MODIFIERS = new Set([
  'assigned', 'current', 'next', 'remaining', 'requested', 'this',
])
const AGENT_SCOPE_DEICTICS = new Set(['assigned', 'requested', 'this'])
const AGENT_SCOPE_NOUNS = new Set(['request', 'task'])
const ATTRIBUTION_CLAUSE_RE = /^(?:(?:the|a|an|this|that|these|those)\s+)?((?:(?!(?:the|a|an|this|that|these|those)\b)[\p{L}\p{N}][\p{L}\p{N}'’.-]*\s+){1,6})(?:finds|found|confirms|confirmed|show|shows|showed|reports|reported|says|said|indicates|indicated|reveals|revealed|states|stated|documents|documented|verified|demonstrates|demonstrated|concludes|concluded|predicts|predicted|projects|projected)\b(?:\s+that)?\s+\S+/iu
const PROSPECTIVE_PREDICATE_RE = /\b(?:(?:will|would|shall|should|must|can|could)\s+|(?:am|is|are|was|were)\s+(?:(?:going|set|expected|planned|scheduled|supposed)\s+)?to\s+|(?:plans?|intends?|aims?|needs?|remains?)\s+to\s+)/i
const DESCRIPTIVE_PROCESS_PREDICATE_RE = /\b(?:continues?(?:\s+to)?\s+|(?:involves?|entails?)\s+|consists?\s+of\s+|(?:centers?|focuses?)\s+on\s+)/i
const AGENT_COMPLETION_TARGET_RE = /(?:\b(?:before|prior\s+to)\b[^.!?]{0,120}\b(?:final|completed|user-facing)\s+(?:answer|report|deliverable|response)\b|\b(?:final|user-facing)\s+(?:answer|report|deliverable|response)\s+for\s+(?:the\s+)?user\b|\bnext\s+(?:step|phase|stage)\b)/i
const AGENT_WORKFLOW_TARGET_RE = /\b(?:(?:more|additional|remaining|further|new)\s+(?:sources?|evidence|research|analysis|materials?|findings?|work)|(?:final|completed|user-facing)\s+(?:answer|report|deliverable|response)|(?:answer|report|deliverable|response)\s+for\s+the\s+user|before\s+(?:the\s+)?(?:final\s+)?(?:answer|report|deliverable|response)|next\s+(?:step|phase|stage))\b/i

function normalizeWorkflowHead(word: string): string {
  if (word === 'analyses') return 'analysis'
  if (word === 'syntheses') return 'synthesis'
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('es') && WORKFLOW_HEAD_NOUNS.has(word.slice(0, -2))) return word.slice(0, -2)
  if (word.endsWith('s') && WORKFLOW_HEAD_NOUNS.has(word.slice(0, -1))) return word.slice(0, -1)
  return word
}

function narrationWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []
}

function unpossessive(word: string): string {
  return word.replace(/['’]s$/, '')
}

function hasAgentScopeReference(text: string): boolean {
  const words = narrationWords(text).map(unpossessive)
  return words.some((word, index) => {
    if (!AGENT_SCOPE_DEICTICS.has(word)) return false
    return words.slice(index + 1, index + 4).some(candidate => AGENT_SCOPE_NOUNS.has(candidate))
  })
}

function hasExplicitAgentWorkflowContext(
  subjectWords: string[],
  normalizedHead: string,
  fullText: string,
): boolean {
  const normalizedSubjectWords = subjectWords.map(unpossessive)
  if (normalizedSubjectWords.some(word => AGENT_DEICTIC_MODIFIERS.has(word))) return true
  if (normalizedHead === 'progress' && normalizedSubjectWords.length <= 2) return true
  if (subjectWords.some(word => /['’]s$/i.test(word) && AGENT_SCOPE_NOUNS.has(unpossessive(word)))) return true
  return hasAgentScopeReference(fullText)
}

function isPossessiveAttributionModifier(match: RegExpExecArray): boolean {
  const sourceWords = narrationWords(match[1] || '')
  return Boolean(sourceWords.at(-1) && /['’]s$/i.test(sourceWords.at(-1)!))
}

/**
 * Detect a future agent-work clause without mistaking topical forecasts for
 * completed progress. The check is grammatical: a workflow noun phrase is the
 * subject, it takes a prospective/continuation predicate, and its object points
 * at remaining evidence or a future user-facing completion.
 */
export function isProspectiveWorkflowNarration(text: string): boolean {
  const trimmed = text.trim()
  const prospectivePredicate = PROSPECTIVE_PREDICATE_RE.exec(trimmed)
  const descriptivePredicate = DESCRIPTIVE_PROCESS_PREDICATE_RE.exec(trimmed)
  const predicate = !prospectivePredicate
    ? descriptivePredicate
    : !descriptivePredicate || prospectivePredicate.index <= descriptivePredicate.index
      ? prospectivePredicate
      : descriptivePredicate
  if (!predicate || predicate.index <= 0) return false
  const descriptiveProcess = predicate === descriptivePredicate

  const subject = trimmed.slice(0, predicate.index).trim()
  // Restrict the match to a sentence-opening noun phrase. This avoids treating
  // an attributed finding such as "Research shows sea levels will rise" as the
  // agent promising future work merely because a later clause uses "will".
  if (!subject || /[.!?;:]/.test(subject) || subject.split(/\s+/).length > 12) return false
  // Parenthetical discourse or appositive phrases do not change the outer
  // attribution grammar ("The audit, after reviewing the evidence, shows ...").
  // The whole subject is already bounded above, so removing a paired comma
  // phrase here does not create an unbounded parse.
  const attributionSubject = subject.replace(/,\s*[^,\n]+\s*,/gu, ' ').replace(/\s+/g, ' ').trim()
  const attribution = ATTRIBUTION_CLAUSE_RE.exec(attributionSubject)
  if (attribution && !isPossessiveAttributionModifier(attribution)) return false

  // English noun phrases normally place their semantic head last. Requiring a
  // workflow head ("research effort", "analysis phase", "next step") avoids
  // confusing an external actor that merely has a research modifier ("research
  // team") with the agent's own unfinished workflow. Attributed forecasts such
  // as "Research shows sea levels will rise" likewise end the pre-modal clause
  // in the topical subject ("sea levels"), not a workflow head.
  const subjectWords = narrationWords(subject)
  const headNoun = normalizeWorkflowHead(unpossessive(subjectWords.at(-1) || ''))
  if (!WORKFLOW_HEAD_NOUNS.has(headNoun)) return false

  const predicateAndObject = trimmed.slice(predicate.index)
  if (!AGENT_WORKFLOW_TARGET_RE.test(predicateAndObject)) return false
  return !descriptiveProcess ||
    hasExplicitAgentWorkflowContext(subjectWords, headNoun, trimmed) ||
    AGENT_COMPLETION_TARGET_RE.test(predicateAndObject)
}
