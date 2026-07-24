import { sanitizeNarrationText } from '@/lib/stream/cleaners'
import type { AgentStateData } from './AgentState'
import { NARRATION_MAX_VISIBLE_ACTION_GAP, NARRATION_THRESHOLD_DEFAULT } from './config'

export interface AcceptedNarrationRecord {
  text: string
  fingerprint: string
  stepIdx: number
  iteration: number
}

export type ProgressNarrationReview =
  | { status: 'accepted'; text: string }
  | { status: 'invalid'; text: null }
  | { status: 'duplicate'; text: string; duplicateOf: string }

interface ProgressNarrationOptions {
  requireSignal?: boolean
  remainingVisibleActions?: number
  clearPhaseEndPending?: boolean
  /**
   * Async narration is generated from a captured work snapshot while the main
   * action loop keeps moving. Preserve that snapshot's bookkeeping instead of
   * letting a later tool/step steal the narration frontier.
   */
  workLogFrontier?: string
  recordStepIdx?: number
  recordIteration?: number
  /**
   * Reset the 3–4 visible-action cadence only for a structured
   * progress_update emitted on an actual due action turn. Ordinary assistant
   * prose may still be remembered for duplicate prevention, but must not
   * postpone the next required progress update.
   */
  resetCadence?: boolean
}

export const CADENCE_PROGRESS_UPDATE_FIELD = 'progress_update'

/** Remaining visible actions before the cadence reaches its hard UI gap. */
export function visibleNarrationActionHeadroom(
  state: Pick<AgentStateData, 'visibleToolActionsSinceLastNarration'>,
): number {
  return Math.max(0, NARRATION_MAX_VISIBLE_ACTION_GAP - state.visibleToolActionsSinceLastNarration)
}

type NativeToolSchema = {
  function?: {
    parameters?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Add the progress lane only to the model-facing copy of native tool schemas.
 * Registry definitions stay unchanged, and non-cadence turns pay no schema or
 * generation cost for narration.
 */
export function withCadenceProgressUpdateSchemas<T extends NativeToolSchema>(
  tools: T[],
  enabled: boolean,
): T[] {
  if (!enabled) return tools
  return tools.map((tool) => {
    if (!tool.function) return tool
    const parameters = tool.function.parameters
    const schema = (
      parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? parameters
        : { type: 'object' }
    ) as {
      properties?: Record<string, unknown>
      required?: unknown
      [key: string]: unknown
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : []
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...schema,
          // Keep this first so providers that respect schema order can finish
          // the user-visible update before streaming large action arguments.
          properties: {
            [CADENCE_PROGRESS_UPDATE_FIELD]: {
              type: 'string',
              description: 'Required cadence field. Write one natural completed-result update advancing the user-visible evidence trace. Size it to the newest evidence: a sentence for one clear result, two when a contrast or implication matters, or a short paragraph for a dense milestone. Choose the wording and structure freely without repeating recent claims. A sentence beginning "Next, ..." is optional and only valid when it names the exact concrete action this same tool-call response begins immediately; never use it for a broader phase or vague later work. Never expose providers, APIs, service names, retries, quotas, rate limits, backend/runtime mechanics, or raw tool failures. Never write only a future action, plan, promise, tool accounting, empty string, cumulative-summary paraphrase, or generic Next sentence. This field is display-only and is removed before tool execution.',
              minLength: 1,
              maxLength: 300,
            },
            ...(schema.properties || {}),
          },
          required: [CADENCE_PROGRESS_UPDATE_FIELD, ...required.filter(key => key !== CADENCE_PROGRESS_UPDATE_FIELD)],
        },
      },
    } as T
  })
}

function progressUpdatePropertyMatch(rawArguments: string): RegExpMatchArray | null {
  return rawArguments.match(/"progress_update"\s*:\s*/)
}

export function hasCadenceProgressUpdateStarted(rawArguments: string): boolean {
  return progressUpdatePropertyMatch(rawArguments) !== null
}

export function extractCadenceProgressUpdate(rawArguments: string): string | undefined {
  const marker = progressUpdatePropertyMatch(rawArguments)
  if (!marker || marker.index === undefined) return undefined
  let cursor = marker.index + marker[0].length
  if (rawArguments[cursor] !== '"') return undefined
  cursor += 1
  let encoded = ''
  let escaped = false
  for (; cursor < rawArguments.length; cursor++) {
    const char = rawArguments[cursor]
    if (escaped) {
      encoded += `\\${char}`
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      try {
        return JSON.parse(`"${encoded}"`) as string
      } catch {
        return encoded.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }
    encoded += char
  }
  return undefined
}

/** Remove the display-only field before validation, caching, persistence, or execution. */
export function stripCadenceProgressUpdateFromArguments(rawArguments: string): string {
  if (!hasCadenceProgressUpdateStarted(rawArguments)) return rawArguments
  try {
    const parsed = JSON.parse(rawArguments) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean = { ...(parsed as Record<string, unknown>) }
      delete clean[CADENCE_PROGRESS_UPDATE_FIELD]
      return JSON.stringify(clean)
    }
  } catch {
    // Preserve malformed JSON byte-for-byte for the existing repair path. It
    // cannot execute or enter executed-tool provider history, while retaining
    // the exact provider failure makes repair deterministic and diagnosable.
  }
  return rawArguments
}

const RECENT_NARRATION_LIMIT = 8
const GENERIC_NARRATION_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'for', 'from',
  'has', 'have', 'i', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our',
  'that', 'the', 'their', 'these', 'this', 'those', 'to', 'was', 'we', 'were',
  'with', 'found', 'gathered', 'identified', 'confirmed', 'discovered', 'reviewed',
  'examined', 'research', 'researched', 'shows', 'showed', 'indicates', 'indicated',
  'sources', 'source', 'results', 'result', 'update', 'progress', 'latest', 'recent',
  'next', 'will', 'now', 'also', 'including', 'based', 'completed', 'finished',
])
const LEADING_FUTURE_ACTION_FRAGMENT_RE = /^(?:(?:next[,;:]?\s+)?(?:let\s+me|i(?:'|’)?ll|i\s+(?:will|need\s+to|have\s+to)|i(?:'|’)?m\s+going\s+to|we(?:'|’)?ll|we\s+will)\s+|(?:now\s+)?(?:extract|read|review|open|search|gather|scroll|find|get|try|check|verify|compare|continue|use|visit|fetch|inspect|navigate)\b)/i
const SPECULATIVE_SOURCE_FRAGMENT_RE = /\b(?:source|article|blog|post|guide|paper|report|documentation|website|page)\b[^.!?\n]{0,180}\b(?:likely|probably|perhaps|may|might|could|should|is expected to)\b[^.!?\n]{0,120}\b(?:contain(?:s|ed)?|provid(?:e|es|ed)|explain(?:s|ed)?|detail(?:s|ed)?|show(?:s|ed)?|cover(?:s|ed)?|offer(?:s|ed)?|include(?:s|d)?)\b/i
const COMPLETED_RESULT_SIGNAL_RE = /\b(?:found|confirmed|identified|verified|show(?:s|ed)|demonstrat(?:es|ed)|indicat(?:es|ed)|reveal(?:s|ed)|report(?:s|ed)|measur(?:es|ed)|document(?:s|ed)|return(?:s|ed)|produc(?:es|ed)|creat(?:es|ed)|sav(?:es|ed)|generat(?:es|ed)|updat(?:es|ed)|extract(?:s|ed)|gather(?:s|ed)|review(?:s|ed)|compar(?:es|ed)|analy[sz](?:es|ed)|failed|blocked|unavailable|completed)\b/i

function isFutureActionOnlyNarration(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (LEADING_FUTURE_ACTION_FRAGMENT_RE.test(trimmed)) return true
  return SPECULATIVE_SOURCE_FRAGMENT_RE.test(trimmed) && !COMPLETED_RESULT_SIGNAL_RE.test(trimmed)
}

function stemNarrationToken(token: string): string {
  if (/^\d/.test(token) || token.length < 5) return token
  if (token.endsWith('ies') && token.length > 6) return `${token.slice(0, -3)}y`
  if (token.endsWith('ing') && token.length > 7) return token.slice(0, -3)
  if (token.endsWith('ed') && token.length > 6) return token.slice(0, -2)
  if (token.endsWith('es') && token.length > 6) return token.slice(0, -2)
  if (token.endsWith('s') && token.length > 5) return token.slice(0, -1)
  return token
}

function narrationTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9%$.-]+/g, ' ')
    .split(/\s+/)
    .map(token => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean)
    .map(stemNarrationToken)
    .filter(token => !GENERIC_NARRATION_TOKENS.has(token))
}

function uniqueTokens(text: string): Set<string> {
  return new Set(narrationTokens(text))
}

function numberTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/\$?\d[\d,.]*(?:%|[a-z]+)?/g) || [])
      .map(token => token.replace(/,/g, '')),
  )
}

export function narrationFingerprint(text: string): string {
  return [...uniqueTokens(text)].sort().join(' ')
}

export function narrationSimilarity(left: string, right: string): number {
  const leftTokens = uniqueTokens(left)
  const rightTokens = uniqueTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return normalize(left) === normalize(right) ? 1 : 0
  }

  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  const jaccard = intersection / Math.max(1, union)
  const containment = intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size))
  return Math.max(jaccard, containment * 0.92)
}

/**
 * Coarse rhetorical shape used only to stop a third consecutive update from
 * falling into the same cadence. It intentionally ignores exact vocabulary:
 * semantic novelty and structural novelty are separate checks.
 */
export function narrationStructureSignature(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const sentenceCount = Math.min(
    2,
    normalized.split(/[.!?]+(?:\s+|$)/).map(sentence => sentence.trim()).filter(Boolean).length,
  )
  const lead = /^(?:i|we)\b/i.test(normalized)
    ? 'agency'
    : /^(?:current|recent|new|research|evidence|data|findings?|sources?|analysis)\b/i.test(normalized)
      ? 'evidence'
      : /^(?:after|across|while|although|unlike|compared|taken together)\b/i.test(normalized)
        ? 'relation'
        : /^(?:created|built|generated|updated|implemented|verified|completed|fixed|produced)\b/i.test(normalized)
          ? 'state'
          : 'subject'
  const relation = /\b(?:however|whereas|while|although|unlike|but|contrast|compared)\b/i.test(normalized)
    ? 'contrast'
    : /\b(?:because|therefore|thereby|which means|making|so that|leaving|indicating|suggesting)\b/i.test(normalized)
      ? 'implication'
      : 'direct'
  const transition = /(?:^|[.!?]\s+)(?:next|now|from here)\b|\b(?:i|we)(?:'|’)?ll\b|\b(?:i|we)\s+will\b/i.test(normalized)
    ? 'transition'
    : 'closed'
  return `${lead}:${relation}:${transition}:${sentenceCount || 1}`
}

function hasNovelNumber(candidate: string, previous: string): boolean {
  const candidateNumbers = numberTokens(candidate)
  const previousNumbers = numberTokens(previous)
  return [...candidateNumbers].some(token => !previousNumbers.has(token))
}

export function reviewProgressNarration(
  state: Pick<AgentStateData, 'recentNarrations'>,
  content: string,
  options: Pick<ProgressNarrationOptions, 'requireSignal'> = {},
): ProgressNarrationReview {
  const text = sanitizeNarrationText(content, {
    requireSignal: options.requireSignal ?? true,
    maxSentences: 2,
    maxLength: 300,
  })
  if (!text) return { status: 'invalid', text: null }
  if (isFutureActionOnlyNarration(text)) return { status: 'invalid', text: null }

  const fingerprint = narrationFingerprint(text)
  for (const previous of state.recentNarrations.slice(-RECENT_NARRATION_LIMIT)) {
    if (fingerprint && fingerprint === previous.fingerprint) {
      return { status: 'duplicate', text, duplicateOf: previous.text }
    }
    if (!hasNovelNumber(text, previous.text) && narrationSimilarity(text, previous.text) >= 0.64) {
      return { status: 'duplicate', text, duplicateOf: previous.text }
    }
  }

  return { status: 'accepted', text }
}

export function acceptProgressNarration(
  state: AgentStateData,
  content: string,
  options: ProgressNarrationOptions = {},
): ProgressNarrationReview {
  const review = reviewProgressNarration(state, content, options)
  if (review.status !== 'accepted') return review

  state.recentNarrations.push({
    text: review.text,
    fingerprint: narrationFingerprint(review.text),
    stepIdx: options.recordStepIdx ?? state.currentStepIdx,
    iteration: options.recordIteration ?? state.iterations,
  })
  if (state.recentNarrations.length > RECENT_NARRATION_LIMIT) {
    state.recentNarrations.splice(0, state.recentNarrations.length - RECENT_NARRATION_LIMIT)
  }
  state.narrationWorkLogFrontier =
    options.workLogFrontier ||
    state.workLog.at(-1) ||
    state.narrationWorkLogFrontier
  if (options.recordStepIdx === undefined || options.recordStepIdx === state.currentStepIdx) {
    state.phaseNarrationEmittedThisStep = true
  }
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
  state.iterationsSinceLastContent = 0
  if (options.resetCadence) {
    state.narrationCadenceInFlight = false
    state.narrationNextAttemptAt = NARRATION_THRESHOLD_DEFAULT
    state.visibleToolActionsSinceLastNarration = options.remainingVisibleActions ?? Math.max(
      0,
      state.visibleToolActionsSinceLastNarration - NARRATION_MAX_VISIBLE_ACTION_GAP,
    )
  }
  if (options.clearPhaseEndPending) state.phaseEndNarrationPending = false
  return review
}

export function workLogSinceAcceptedNarration(state: AgentStateData, fallback = 6): string[] {
  const frontier = state.narrationWorkLogFrontier
  if (!frontier) return state.workLog.slice(-fallback)
  const frontierIndex = state.workLog.lastIndexOf(frontier)
  return frontierIndex >= 0
    ? state.workLog.slice(frontierIndex + 1)
    : state.workLog.slice(-fallback)
}

export function recentNarrationPromptExclusions(state: AgentStateData, limit = 3): string[] {
  return state.recentNarrations.slice(-limit).map(record => record.text)
}

export function beginNarrationCadenceAttempt(state: AgentStateData): boolean {
  if (state.narrationCadenceInFlight) return false
  if (state.visibleToolActionsSinceLastNarration < state.narrationNextAttemptAt) return false
  state.narrationCadenceInFlight = true
  // A missed/duplicate update never resets completed-action cadence. Retry on
  // the next visible action, not after another full cadence window.
  state.narrationNextAttemptAt = state.visibleToolActionsSinceLastNarration + 1
  return true
}

export function finishNarrationCadenceAttempt(state: AgentStateData): void {
  state.narrationCadenceInFlight = false
}

export function retryNarrationCadenceAttemptWithoutNewAction(state: AgentStateData): void {
  state.forceTextNextIteration = false
  state.forcedNarrationRepairAttempts = 0
  state.narrationCadenceInFlight = false
  // The cadence turn itself failed before completing any visible action. Keep
  // the update due on the next ordinary action-selection retry at this exact
  // frontier instead of waiting for an action that never happened.
  state.narrationNextAttemptAt = Math.min(
    state.narrationNextAttemptAt,
    state.visibleToolActionsSinceLastNarration,
  )
}

export function retryNarrationCadenceAfterNoProgress(
  state: AgentStateData,
  outcome: {
    attemptIteration: number
    visibleActionFrontier: number
    acceptedVisibleAction: boolean
  },
): boolean {
  const acceptedNarration = state.recentNarrations.at(-1)?.iteration === outcome.attemptIteration
  if (acceptedNarration || outcome.acceptedVisibleAction) return false

  // A completed response is not cadence progress by itself. If its narration
  // was rejected/empty and its malformed tool never executed, retry cadence on
  // the next ordinary action-selection turn at the same visible frontier.
  retryNarrationCadenceAttemptWithoutNewAction(state)
  return true
}

export function deferNarrationCadenceAttempt(state: AgentStateData): void {
  state.forceTextNextIteration = false
  state.phaseEndNarrationPending = false
  state.forcedNarrationRepairAttempts = 0
  state.iterationsSinceLastContent = 0
  state.narrationCadenceInFlight = false
  state.narrationNextAttemptAt = Math.max(
    state.narrationNextAttemptAt,
    state.visibleToolActionsSinceLastNarration + 1,
  )
}

export function narrationAcceptedThisIteration(state: AgentStateData): boolean {
  return state.recentNarrations.at(-1)?.iteration === state.iterations
}
