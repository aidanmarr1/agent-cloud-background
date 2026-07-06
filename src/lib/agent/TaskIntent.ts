import { effectiveTaskRequest } from '@/lib/conversationContext'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'

export type TaskDepth = 'quick' | 'normal' | 'deep'

export interface TaskIntent {
  rawText: string
  text: string
  asksForWriting: boolean
  asksForResearch: boolean
  wantsReport: boolean
  wantsInlineAnswer: boolean
  explicitSavedArtifact: boolean
  wantsCitations: boolean
  wantsCurrentInfo: boolean
  wantsQuick: boolean
  wantsDeep: boolean
  depth: TaskDepth
  isInlineReport: boolean
  isPlainInlineReport: boolean
  isEvidenceHeavyReport: boolean
}

const QUICK_RE = /\b(?:very quickly|real quick|asap|super quick|quickly|quick|briefly|brief|short|succinct|simple|one[-\s]?sentence|two[-\s]?sentence|in\s+\d+\s+sentences?)\b/i
const DEEP_RE = /\b(?:deep|comprehensive|thorough|detailed|in[-\s]?depth|deep[-\s]?dive|full report|serious analysis|strategic|technical|historical|cultural|comparative|market research|due diligence)\b/i
const WRITING_RE = /\b(?:write|draft|compose|prepare|create|make|produce|generate|give)\b/i
const RESEARCH_RE = /\b(?:research|find\s*out|investigate|look\s*(?:it\s*)?up|web\s*search|search(?:es|ing)?|source|sources|cited?|citations?|references?|bibliography|evidence|compare|analy[sz]e|latest|current|recent|today|news|up[-\s]?to[-\s]?date|current\s+state|state\s+of|landscape|ecosystem|real[-\s]?world\s+applications?|use\s+cases?)\b/i
const CITATION_RE = /\b(?:sources?|citations?|cited?|references?|bibliography|footnotes?|evidence-backed|source-backed)\b/i
const CURRENT_RE = /\b(?:latest|current|recent|today|tonight|this\s+week|this\s+month|this\s+year|news|newest|up[-\s]?to[-\s]?date|202[4-9])\b/i
const INLINE_RE = /\b(?:no file|no document|don'?t\s+create\s+(?:a\s+)?file|do\s+not\s+create\s+(?:a\s+)?file|answer\s+(?:directly|in chat|here)|just\s+answer|inline)\b/i
const REPORT_RE = /\b(?:report|write[-\s]?up|memo|overview)\b/i
const BRIEF_NOUN_RE = /\b(?:write|draft|compose|prepare|create|make|produce|generate|give)\b.{0,50}\bbrief\b|\bbrief\s+(?:on|about|for)\b/i

const NEGATED_ARTIFACT_RE = /\b(?:no|not|without)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck|spreadsheet|xlsx)\b/gi
const NEGATED_ARTIFACT_ACTION_RE = /\b(?:don'?t|do\s+not)\s+(?:create|make|save|export|generate|write|return|produce)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck|spreadsheet|xlsx)\b/gi
const ARTIFACT_NOUN_RE = /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|word\s+doc(?:ument)?|pptx|xlsx|slides?|presentation|deck|website|web\s*app|code|script|component|spreadsheet|csv|notebook)\b/i
const ARTIFACT_ACTION_RE = /\b(?:save|export|deliver|download|return|send)\b.{0,80}\b(?:file|pdf|markdown|document|docx?|word\s+doc(?:ument)?|slides?|presentation|deck|website|web\s*app|code|script|component|spreadsheet|csv|notebook)\b/i
const CREATE_ARTIFACT_RE = /\b(?:create|make|generate|produce|build)\b.{0,80}\b(?:file|pdf|markdown\s+file|document|docx?|word\s+doc(?:ument)?|slides?|presentation|deck|website|web\s*app|code|script|component|spreadsheet|csv|notebook)\b/i
const FORMAT_ARTIFACT_RE = /\b(?:as|in|to)\s+(?:a\s+|an\s+)?(?:pdf|markdown\s+file|md\s+file|docx?|word\s+doc(?:ument)?|pptx|slides?|presentation|deck|spreadsheet|xlsx|csv|notebook)\b/i

function normalizedTaskText(messages: Array<{ role: string; content: string }>): string {
  return effectiveTaskRequest(messages)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function artifactPositiveText(text: string): string {
  return text
    .replace(NEGATED_ARTIFACT_ACTION_RE, ' ')
    .replace(NEGATED_ARTIFACT_RE, ' ')
}

export function analyzeTaskIntent(messages: Array<{ role: string; content: string }>): TaskIntent {
  const rawText = normalizedTaskText(messages)
  const text = rawText.toLowerCase()
  const artifactText = artifactPositiveText(text)

  const wantsQuick = QUICK_RE.test(text)
  const wantsDeep = DEEP_RE.test(text)
  const asksForWriting = WRITING_RE.test(text)
  const wantsReport = REPORT_RE.test(text) || BRIEF_NOUN_RE.test(text)
  const wantsCitations = CITATION_RE.test(text)
  const wantsCurrentInfo = CURRENT_RE.test(text)
  const asksForResearch = RESEARCH_RE.test(text)
  const explicitSavedArtifact =
    ARTIFACT_ACTION_RE.test(artifactText) ||
    CREATE_ARTIFACT_RE.test(artifactText) ||
    FORMAT_ARTIFACT_RE.test(artifactText) ||
    ARTIFACT_NOUN_RE.test(artifactText)
  const defaultMarkdownReport = taskDefaultsToMarkdownDeliverable(rawText)
  const wantsInlineAnswer = INLINE_RE.test(text)
  const isInlineReport = wantsReport && wantsInlineAnswer && !explicitSavedArtifact && !defaultMarkdownReport
  const isEvidenceHeavyReport = isInlineReport && (asksForResearch || wantsCitations || wantsCurrentInfo || wantsDeep)
  const isPlainInlineReport = isInlineReport && !isEvidenceHeavyReport
  const depth: TaskDepth = wantsDeep ? 'deep' : wantsQuick ? 'quick' : 'normal'

  return {
    rawText,
    text,
    asksForWriting,
    asksForResearch,
    wantsReport,
    wantsInlineAnswer,
    explicitSavedArtifact,
    wantsCitations,
    wantsCurrentInfo,
    wantsQuick,
    wantsDeep,
    depth,
    isInlineReport,
    isPlainInlineReport,
    isEvidenceHeavyReport,
  }
}
