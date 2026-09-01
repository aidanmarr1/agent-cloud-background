import type { AgentStateData } from './AgentState'
import { analyzeTaskIntent } from './TaskIntent'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'

type DeliverableContractState = Pick<
  AgentStateData,
  | 'originalUserRequest'
  | 'currentPlanItems'
  | 'currentPlanScopes'
  | 'createdFiles'
  | 'buildTask'
  | 'taskStrategy'
>

type ExistingInputEvidenceState = Pick<
  AgentStateData,
  | 'uploadedAttachmentContentAvailable'
  | 'inputArtifactPathsRead'
>

export interface FinalArtifactFormatContract {
  label: string
  extensions: string[]
}

const OUTPUT_FORMAT_RULES: Array<{
  contract: FinalArtifactFormatContract
  pattern: RegExp
}> = [
  {
    contract: { label: 'PDF', extensions: ['.pdf'] },
    pattern: /(?:\b(?:convert|export|render|turn|put|save|return|deliver|download|output|produce|generate|create|make)\b[^\n.!?]{0,100}\bpdf\b|\b(?:to|as|in|into)\s+(?:an?\s+)?pdf\b|\b(?:final|output|deliverable|downloadable)\s+pdf\b)/i,
  },
  {
    contract: { label: 'ZIP archive', extensions: ['.zip'] },
    pattern: /(?:\b(?:package|archive|zip|put|save|return|deliver|download|output|produce|generate|create|make)\b[^\n.!?]{0,100}\b(?:zip|archive)\b|\b(?:to|as|in|into)\s+(?:an?\s+)?zip\b)/i,
  },
  {
    contract: { label: 'PowerPoint presentation', extensions: ['.pptx'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export)\b[^\n.!?]{0,100}\b(?:pptx|powerpoint)\b|\b(?:to|as|in|into)\s+(?:an?\s+)?(?:pptx|powerpoint)\b)/i,
  },
  {
    contract: { label: 'Word document', extensions: ['.docx'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export)\b[^\n.!?]{0,100}\b(?:docx|word\s+document)\b|\b(?:to|as|in|into)\s+(?:an?\s+)?(?:docx|word\s+document)\b)/i,
  },
  {
    contract: { label: 'Excel workbook', extensions: ['.xlsx'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export)\b[^\n.!?]{0,100}\b(?:xlsx|excel\s+(?:file|workbook|spreadsheet))\b|\b(?:to|as|in|into)\s+(?:an?\s+)?(?:xlsx|excel)\b)/i,
  },
  {
    contract: { label: 'CSV file', extensions: ['.csv'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export)\b[^\n.!?]{0,100}\bcsv\b|\b(?:to|as|in|into)\s+(?:an?\s+)?csv\b)/i,
  },
  {
    contract: { label: 'Markdown file', extensions: ['.md', '.markdown'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export|write)\b[^\n.!?]{0,100}\b(?:markdown|md\s+file)\b|\b(?:to|as|in|into)\s+(?:an?\s+)?(?:markdown|md\s+file)\b)/i,
  },
  {
    contract: { label: 'text file', extensions: ['.txt'] },
    pattern: /(?:\b(?:put|save|return|deliver|download|output|produce|generate|create|make|export|write)\b[^\n.!?]{0,100}\b(?:text|txt)\s+file\b|\b(?:to|as|in|into)\s+(?:an?\s+)?(?:text|txt)\s+file\b)/i,
  },
]

/**
 * Resolve an explicitly requested final file format from the user's wording.
 * Source formats are intentionally ignored unless they appear in an output
 * phrase, so "read this PDF and write a summary" does not accidentally make
 * the summary itself a PDF.
 */
export function requestedFinalArtifactFormat(
  state: Pick<AgentStateData, 'originalUserRequest'>,
  fallbackRequest = '',
): FinalArtifactFormatContract | null {
  const request = state.originalUserRequest || fallbackRequest
  if (!request.trim()) return null
  return OUTPUT_FORMAT_RULES.find(rule => rule.pattern.test(request))?.contract || null
}

export function artifactPathSatisfiesFinalOutputContract(
  state: Pick<AgentStateData, 'originalUserRequest'>,
  filePath: string,
  fallbackRequest = '',
): boolean {
  const contract = requestedFinalArtifactFormat(state, fallbackRequest)
  if (!contract) return true
  const normalized = filePath.trim().toLowerCase().split(/[?#]/, 1)[0]
  return contract.extensions.some(extension => normalized.endsWith(extension))
}

/** Narrow integrity guard for requests that refer to an already-existing item. */
export function taskRequiresExistingInputArtifact(
  state: Pick<AgentStateData, 'originalUserRequest'>,
  fallbackRequest = '',
): boolean {
  const rawRequest = state.originalUserRequest || fallbackRequest
  // Contextual follow-ups deliberately retain the previous request, but the
  // labelled latest direction owns the action contract. Otherwise an earlier
  // "create a report" instruction can incorrectly turn a later "put it in a
  // PDF" conversion back into a source-creation task.
  const request = rawRequest.match(
    /^Latest user direction \(authoritative(?:; do this now)?\):\s*([\s\S]*?)(?:\n\nPrevious task request|$)/i,
  )?.[1]?.trim() || rawRequest
  if (!requestedFinalArtifactFormat(state, fallbackRequest)) return false

  // "Create/design X and export it" is a creation workflow, not a conversion
  // of an existing workspace item.
  if (/\b(?:create|design|write|draft|build|generate)\b[^\n.!?]{0,180}\b(?:new\s+)?(?:cover|file|document|page|report|website|html|markdown)\b/i.test(request) &&
      !/\b(?:attached|uploaded|existing|current|this|that|the\s+existing)\b/i.test(request)) {
    return false
  }

  const conversion = /\b(?:convert|export|render|turn|put)\b[^\n.!?]{0,140}\b(?:pdf|zip|pptx|powerpoint|docx|word\s+document|xlsx|excel|csv)\b/i.test(request) ||
    /\b(?:attached|uploaded|existing|current|this|that|it|my|the|cover|file|document|page|report|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html?|md|txt|docx?|pptx|xlsx|csv))\b[^\n.!?]{0,80}\b(?:to|as|in|into)\s+(?:an?\s+)?(?:pdf|zip|pptx|powerpoint|docx|word\s+document|xlsx|excel|csv)\b/i.test(request)
  const existingReference = /\b(?:attached|uploaded|existing|current|this|that|it|my|return\s+it|send\s+it|the\s+(?:cover|file|document|page|report))\b/i.test(request) ||
    /\b[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html?|md|txt|docx?|pptx|xlsx|csv)\b/i.test(request) ||
    /\b(?:cover|file|document|page|report)\s+(?:to|as|in|into)\s+(?:an?\s+)?(?:pdf|zip|pptx|powerpoint|docx|word\s+document|xlsx|excel|csv)\b/i.test(request)
  return conversion && existingReference
}

export function hasExistingInputArtifactEvidence(state: ExistingInputEvidenceState): boolean {
  return state.uploadedAttachmentContentAvailable ||
    state.inputArtifactPathsRead.size > 0
}

function browseRequestCreatesSavedArtifact(request: string): boolean {
  const artifactTarget = String.raw`(?:file|artifact|pdf|markdown|document|docx?|word\s+doc(?:ument)?|pptx|slides?|presentation|deck|spreadsheet|xlsx|csv|notebook|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|pdf|docx?|pptx|xlsx|csv))`
  const outputAction = new RegExp(
    String.raw`\b(?:save|export|deliver|download|return|send|write|create|make|generate|produce)\b[^\n.!?]{0,120}\b${artifactTarget}\b`,
    'i',
  )
  const savePriorTarget = new RegExp(
    String.raw`\b${artifactTarget}\b[^\n.!?]{0,120}\b(?:save|export|deliver|download|return|send)\s+(?:it|that|the\s+(?:file|artifact|result))\b`,
    'i',
  )
  return outputAction.test(request) || savePriorTarget.test(request)
}

/**
 * Single source of truth for the final-output contract.
 *
 * The original user request has priority over planner wording: an explicit
 * inline/quick request must not become a file merely because a generated plan
 * happens to say "report". Planner wording is advisory and must never silently
 * expand the user's output contract.
 */
export function taskRequiresSavedFinalArtifact(
  state: DeliverableContractState,
  fallbackRequest = '',
): boolean {
  const userRequest = state.originalUserRequest || fallbackRequest
  const userIntent = analyzeTaskIntent([{ role: 'user', content: userRequest }])

  // A browser-led task can still explicitly request a saved result after the
  // live interaction (for example, "open this URL, read the title, then create
  // live-check.md"). Strategy classification describes how the task starts; it
  // must not erase an unambiguous user-authored output contract.
  if (
    userIntent.explicitSavedArtifact &&
    (
      state.taskStrategy !== 'browse' ||
      browseRequestCreatesSavedArtifact(userRequest)
    )
  ) {
    return true
  }
  // Explicit inline/brevity constraints describe the output contract and win
  // over a planner's inferred strategy. A two-sentence comparison must not
  // become an 800-word creative file merely because the planner called the
  // turn "creative". Explicit website/file creation was already handled above.
  if (userIntent.wantsInlineAnswer || userIntent.wantsQuick) return false
  if (state.taskStrategy === 'browse') return false
  if (
    state.buildTask ||
    state.taskStrategy === 'build' ||
    state.taskStrategy === 'code' ||
    state.taskStrategy === 'creative'
  ) {
    return true
  }

  if (userIntent.requiresSavedArtifact) return true

  return taskDefaultsToMarkdownDeliverable(userRequest)
}
