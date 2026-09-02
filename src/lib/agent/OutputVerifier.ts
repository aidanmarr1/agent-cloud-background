/**
 * OutputVerifier — heuristic quality checks on deliverables before completion.
 *
 * Runs strategy-specific checks (word count, citations, placeholder detection,
 * structure) to prevent premature completion with low-quality output.
 * No LLM call — purely structural analysis.
 */

import type { WorkingMemory } from './WorkingMemory'
import {
  CREATIVE_MIN_WORDS,
  BUILD_MIN_CONTENT_CHARS,
  PLACEHOLDER_PATTERNS,
  OUTLINE_ONLY_THRESHOLD,
  RESEARCH_MIN_WORDS_BY_COMPLEXITY,
} from './config'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'
import { requestedBriefInlineSourceCount } from './BriefInlineResearch'
import {
  duplicateNumberedMarkdownH2Sections,
  markdownTerminalSectionOrderingIssues,
} from '../fileAppend'

export interface VerificationResult {
  passed: boolean
  score: number        // 0-1 quality score
  failures: string[]   // Specific failures
  suggestions: string[]
}

export class OutputVerifier {
  private explicitlyLimitsContentLength(originalRequest: string): boolean {
    return /\b(?:one|two|three|four|five|\d+)[-\s]+sentences?\b/i.test(originalRequest) ||
      /\b\d{1,5}\s*(?:\+?\s*)?words?\b/i.test(originalRequest) ||
      /\b(?:brief|quick|short|concise|succinct)\b/i.test(originalRequest)
  }

  private repeatedSubstantiveBlocks(content: string): string[] {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    const blocks = content.split(/\n\s*\n/)

    for (const block of blocks) {
      const readable = block
        .replace(/^\s*#{1,6}\s+/gm, '')
        .replace(/^\s*[-*]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (readable.length < 180 || readable.split(/\s+/).length < 28) continue

      const normalized = readable
        .toLowerCase()
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!normalized) continue

      const first = seen.get(normalized)
      if (first) {
        duplicates.push(readable.slice(0, 90))
      } else {
        seen.set(normalized, readable)
      }
    }

    return duplicates
  }

  private isExplicitlyConciseDeliverableRequest(originalRequest: string, filePath: string): boolean {
    const artifactRequest = originalRequest.replace(
      /\b(?:keep|make)\s+(?:the\s+)?final\s+(?:response|reply|answer|message|handoff)\s+(?:very\s+)?(?:brief|quick|short|concise|succinct)\b/gi,
      ' ',
    )
    return filePath.toLowerCase().endsWith('.md') &&
      /\b(?:brief|quick|short|concise|succinct|one[-\s]?page|1[-\s]?page)\b/i.test(artifactRequest)
  }

  private isCompactStructuredDataRequest(originalRequest: string, filePath: string): boolean {
    if (!filePath.toLowerCase().endsWith('.md')) return false
    if (!/\b[A-Za-z0-9][A-Za-z0-9._-]*\.md\b/i.test(originalRequest)) return false
    if (/\b(?:report|research|analysis|assessment|essay|memo|briefing|white\s+paper)\b/i.test(originalRequest)) {
      return false
    }
    const fieldSignals = [
      /\btitle\b/i,
      /\b(?:source\s+)?url\b/i,
      /\blink\b/i,
      /\bstatus\b/i,
      /\bvalue\b/i,
      /\bresult\b/i,
    ].filter(pattern => pattern.test(originalRequest)).length
    return fieldSignals >= 2
  }

  private isDeepResearchRequest(originalRequest: string): boolean {
    return /\b(?:deep|deeper|deepest|comprehensive|thorough|detailed|in[-\s]?depth|extensive|exhaustive)\b/i.test(originalRequest)
  }

  private explicitlyRequestsProseReport(originalRequest: string): boolean {
    return /\b(?:full|complete|comprehensive|thorough|detailed|in[-\s]?depth|substantive|professional)\b[\s\S]{0,80}\b(?:report|analysis|assessment|briefing|white\s+paper)\b/i.test(originalRequest) ||
      /\b(?:report|analysis|assessment|briefing|white\s+paper)\b[\s\S]{0,80}\b(?:full|complete|comprehensive|thorough|detailed|in[-\s]?depth|substantive|professional)\b/i.test(originalRequest)
  }

  private explicitlyRequestsOpeningSynthesis(originalRequest: string): boolean {
    return /\b(?:executive\s+summary|opening\s+(?:summary|overview)|key\s+findings\s+section)\b/i.test(originalRequest)
  }

  private explicitlyRequestsSourcesSection(originalRequest: string): boolean {
    return /\b(?:references|bibliography|works\s+cited|sources)\s+(?:section|list)\b/i.test(originalRequest) ||
      /\b(?:include|add|provide|finish\s+with|end\s+with)\b[^.!?\n]{0,80}\b(?:references|bibliography|works\s+cited|source\s+list)\b/i.test(originalRequest)
  }

  private explicitlyRequestsSourceEvidence(originalRequest: string): boolean {
    return /\b(?:cite|cited|citation|citations|source|sources|source\s+urls?|links?|references|bibliography|works\s+cited)\b/i.test(originalRequest)
  }

  private compactDeliverableHasSubstance(content: string): boolean {
    const headingCount = (content.match(/^#{1,3}\s+\S/gm) || []).length
    const bulletItems = (content.match(/^\s*[-*]\s+(?!\[[ xX]\])\S.+$/gm) || []).length
    const checklistItems = (content.match(/^\s*[-*]\s+\[[ xX]\]\s+\S.+$/gm) || []).length
    const labeledFacts = (content.match(/^\s*\*\*[^*\n]{2,48}:\*\*\s+\S.+$/gm) || []).length
    const wordCount = content.split(/\s+/).filter(Boolean).length
    const informativeBlocks = content.split(/\n\s*\n/).filter(block => {
      const withoutMarkdown = block
        .replace(/^\s*#{1,6}\s+/gm, '')
        .replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/gm, '')
        .trim()
      const words = withoutMarkdown.split(/\s+/).filter(Boolean).length
      return words >= 18
    }).length

    return (
      headingCount >= 1 &&
      wordCount >= 35 &&
      (bulletItems >= 3 || checklistItems >= 3)
    ) || (
      headingCount >= 1 &&
      wordCount >= 8 &&
      bulletItems + checklistItems + labeledFacts >= 2 &&
      /\bhttps?:\/\/\S+/i.test(content)
    ) || (
      headingCount >= 4 &&
      (checklistItems >= 5 || informativeBlocks >= 6)
    )
  }

  verify(
    fileContent: string,
    filePath: string,
    originalRequest: string,
    strategy: string,
    workingMemory: WorkingMemory | null,
    taskComplexity: number = 3,
  ): VerificationResult {
    const failures: string[] = []
    const suggestions: string[] = []
    let score = 1.0
    const conciseStructuredDeliverable =
      !this.isDeepResearchRequest(originalRequest) &&
      (
        this.isExplicitlyConciseDeliverableRequest(originalRequest, filePath) ||
        this.isCompactStructuredDataRequest(originalRequest, filePath)
      ) &&
      this.compactDeliverableHasSubstance(fileContent)

    // --- Universal checks ---

    // Empty or near-empty content
    const userLimitedContentLength = this.explicitlyLimitsContentLength(originalRequest)
    if (!fileContent || fileContent.trim().length < (userLimitedContentLength ? 8 : 50)) {
      failures.push('Deliverable is empty or nearly empty')
      return { passed: false, score: 0, failures, suggestions }
    }

    // Placeholder detection
    const lowerContent = fileContent.toLowerCase()
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (lowerContent.includes(pattern.toLowerCase())) {
        failures.push(`Contains placeholder text: "${pattern}"`)
        score -= 0.2
      }
    }

    // Outline-only detection
    const lines = fileContent.split('\n').filter(l => l.trim().length > 0)
    const headingOrBulletLines = lines.filter(l => /^\s*[#\-*•]/.test(l)).length
    const substantiveProseParagraphs = fileContent.split(/\n\s*\n/).filter(block => {
      const trimmed = block.trim()
      if (!trimmed || /^\s*(?:#{1,6}|[-*•])\s+/.test(trimmed)) return false
      return trimmed.split(/\s+/).filter(Boolean).length >= 50
    }).length
    if (
      lines.length > 5 &&
      headingOrBulletLines / lines.length > OUTLINE_ONLY_THRESHOLD &&
      substantiveProseParagraphs < 2 &&
      this.explicitlyRequestsProseReport(originalRequest) &&
      !conciseStructuredDeliverable
    ) {
      failures.push(`Content appears to be an outline (${Math.round(headingOrBulletLines / lines.length * 100)}% headings/bullets) — write substantive paragraphs`)
      score -= 0.3
    }

    const trimmedContent = fileContent.trim()
    if (/(?:^|\n)\s*(?:\*\*|__|#{1,6}|[-*]\s*)$/.test(trimmedContent) ||
      /(?:[,;:]|\b(?:and|or|but|because|with|including|such as|to|of|the|a|an|in|on|for|from|by|as|that|which))$/i.test(trimmedContent)) {
      failures.push('Content appears cut off or unfinished at the end')
      suggestions.push('Finish the final section cleanly before delivering')
      score -= 0.25
    }

    const repeatedBlocks = this.repeatedSubstantiveBlocks(fileContent)
    if (repeatedBlocks.length > 0) {
      failures.push(`Contains ${repeatedBlocks.length} duplicated substantive passage${repeatedBlocks.length === 1 ? '' : 's'}`)
      suggestions.push('Use edit_file to remove repeated passages while preserving the single complete version')
      score -= Math.min(0.35, 0.18 + repeatedBlocks.length * 0.06)
    }

    const structuredMarkdownReport = filePath.toLowerCase().endsWith('.md') &&
      (
        strategy === 'research' ||
        strategy === 'analysis' ||
        /\b(?:report|research|analysis|assessment|white\s+paper|briefing)\b/i.test(originalRequest)
      )

    if (structuredMarkdownReport) {
      const duplicateSectionNumbers = duplicateNumberedMarkdownH2Sections(fileContent)
      if (duplicateSectionNumbers.length > 0) {
        failures.push(`Contains duplicate numbered level-2 section heading${duplicateSectionNumbers.length === 1 ? '' : 's'}: ${duplicateSectionNumbers.join(', ')}`)
        suggestions.push('Use edit_file to merge or remove repeated numbered sections; do not append another copy')
        score -= Math.min(0.3, 0.16 + duplicateSectionNumbers.length * 0.05)
      }

      const terminalOrderingIssues = markdownTerminalSectionOrderingIssues(fileContent)
      if (terminalOrderingIssues.length > 0) {
        const firstIssue = terminalOrderingIssues[0]
        failures.push(`Report structure restarts after its ending: "${firstIssue.terminalHeading}" is followed by later substantive section "${firstIssue.laterHeading}"`)
        suggestions.push('Use edit_file to restore section order and keep the conclusion and references at the end')
        score -= 0.22
      }
    }

    const savedMarkdownReport = filePath.toLowerCase().endsWith('.md') &&
      taskDefaultsToMarkdownDeliverable(originalRequest)

    if (savedMarkdownReport && !conciseStructuredDeliverable) {
      if (
        this.explicitlyRequestsOpeningSynthesis(originalRequest) &&
        !/^##\s+(?:Executive Summary|Summary|Overview|Key Findings)\b/im.test(fileContent)
      ) {
        failures.push('The requested opening synthesis section is missing')
        suggestions.push('Add the opening synthesis section the user requested')
        score -= 0.1
      }
      if (
        this.explicitlyRequestsSourcesSection(originalRequest) &&
        !/^##\s+(?:References|Sources|Bibliography|Works Cited)\b/im.test(fileContent)
      ) {
        failures.push('The requested references or sources section is missing')
        suggestions.push('Add the references section the user requested')
        score -= 0.1
      }
    }

    // --- Strategy-specific checks ---
    switch (strategy) {
      case 'research':
      case 'analysis':
        this.checkResearch(fileContent, filePath, originalRequest, taskComplexity, workingMemory, failures, suggestions)
        break
      case 'build':
      case 'code':
        this.checkBuildCode(fileContent, filePath, failures, suggestions)
        break
      case 'creative':
        this.checkCreative(fileContent, originalRequest, failures, suggestions)
        break
      case 'browse':
        if (!conciseStructuredDeliverable) {
          this.checkBrowseAction(fileContent, failures, suggestions)
        }
        break
      default:
        if (savedMarkdownReport && !conciseStructuredDeliverable) {
          this.checkResearch(fileContent, filePath, originalRequest, taskComplexity, workingMemory, failures, suggestions)
        }
        break
    }

    // Compute final score
    score = Math.max(0, score - (failures.length * 0.15))
    const passed = failures.length === 0

    return { passed, score, failures, suggestions }
  }

  private checkResearch(
    content: string,
    filePath: string,
    originalRequest: string,
    taskComplexity: number,
    workingMemory: WorkingMemory | null,
    failures: string[],
    suggestions: string[],
  ): void {
    // Enforce an exact user-authored word target, never a runtime-default
    // length. The model remains free to choose the natural depth otherwise.
    const words = content.split(/\s+/).filter(w => w.length > 0).length
    const requestedWordTarget = this.explicitWordTarget(originalRequest)
    if (requestedWordTarget && words < requestedWordTarget.minimum) {
      failures.push(`Word count ${words}, requested approximately ${requestedWordTarget.requested}`)
      suggestions.push('Meet the user-authored length target without adding repetitive filler')
    } else if (!requestedWordTarget && this.isDeepResearchRequest(originalRequest)) {
      // A request for a concise executive summary does not make the complete
      // comprehensive/in-depth report concise. Keep this floor scoped to an
      // explicit depth request, and let any user-authored word target win.
      const complexity = Math.max(1, Math.min(5, Math.round(taskComplexity))) as 1 | 2 | 3 | 4 | 5
      const minimumWords = RESEARCH_MIN_WORDS_BY_COMPLEXITY[complexity]
      if (words < minimumWords) {
        failures.push(`Word count ${words}, minimum ${minimumWords} for the requested research depth`)
        suggestions.push('Expand the report with substantive evidence, analysis, caveats, and implications')
      }
    }

    // Citation count (URLs or "Source:" references)
    const urlPattern = /https?:\/\/[^\s)\]]+/g
    const sourcePattern = /\bsource[s]?\s*:/gi
    const urls = content.match(urlPattern) || []
    const sourceRefs = content.match(sourcePattern) || []
    const citationCount = new Set([...urls]).size + sourceRefs.length
    const explicitSourceCount = requestedBriefInlineSourceCount(originalRequest)
    const requiredCitations = explicitSourceCount ?? (this.explicitlyRequestsSourceEvidence(originalRequest) ? 1 : 0)
    if (requiredCitations > 0 && citationCount < requiredCitations) {
      failures.push(`Only ${citationCount} source reference(s), requested at least ${requiredCitations}`)
      suggestions.push('Add source URLs to support claims')
    }

    if (requiredCitations > 0 && filePath.toLowerCase().endsWith('.md')) {
      const terminalSourcesIndex = content.search(/^##\s+(?:References|Sources|Bibliography|Works Cited)\b/im)
      const reportBody = terminalSourcesIndex >= 0 ? content.slice(0, terminalSourcesIndex) : content
      const inlineUrls = new Set(reportBody.match(/https?:\/\/[^\s)\]]+/g) || [])
      const explicitlyRequiresClaimLevelLinks =
        /\b(?:every|each)\s+(?:major|material|important|factual)?\s*claim\b[\s\S]{0,80}\b(?:link|cite|source)\b/i.test(originalRequest) ||
        /\b(?:inline|claim[-\s]?level)\s+(?:links?|citations?|sources?)\b/i.test(originalRequest) ||
        /\blink\b[\s\S]{0,50}\boriginal\s+source\b/i.test(originalRequest)
      const requiredInlineUrls = explicitlyRequiresClaimLevelLinks
        ? Math.min(5, Math.max(3, explicitSourceCount || 0))
        : 1
      if (inlineUrls.size < requiredInlineUrls) {
        failures.push(`Only ${inlineUrls.size} inline source link(s) appear beside the report's claims; required at least ${requiredInlineUrls}`)
        suggestions.push('Place Markdown source links directly beside the claims they support, not only in a terminal source list')
      }
    }

    // Cross-reference with working memory
    if (workingMemory) {
      const rendered = workingMemory.render()
      if (rendered) {
        // Extract fact texts from rendered memory
        const factLines = rendered.split('\n').slice(1) // Skip header
        const contentLower = content.toLowerCase()
        let factsFound = 0
        for (const line of factLines) {
          // Extract the fact text between the confidence marker and the source
          const match = line.match(/\[.\]\s+(.+?)\s+\(/)
          if (match) {
            const factSnippet = match[1].toLowerCase().slice(0, 60)
            if (factSnippet.length > 15 && contentLower.includes(factSnippet)) {
              factsFound++
            }
          }
        }
        if (factsFound < 2 && factLines.length >= 3) {
          suggestions.push('Consider incorporating more research findings into the deliverable')
        }
      }
    }
  }

  private explicitWordTarget(originalRequest: string): { requested: number; minimum: number } | null {
    const match = originalRequest.match(/\b(\d{2,5})\s*(?:\+?\s*)?words?\b/i)
    if (!match) return null
    const requested = Number(match[1])
    if (!Number.isFinite(requested) || requested <= 0) return null
    return { requested, minimum: Math.max(40, Math.floor(requested * 0.9)) }
  }

  private checkBuildCode(
    content: string,
    filePath: string,
    failures: string[],
    suggestions: string[],
  ): void {
    if (content.length < BUILD_MIN_CONTENT_CHARS) {
      failures.push(`Content too short (${content.length} chars, minimum ${BUILD_MIN_CONTENT_CHARS})`)
    }

    // Check for balanced braces in code files
    const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cs']
    const ext = filePath.toLowerCase().match(/\.[a-z]+$/)?.[0] || ''
    if (codeExtensions.includes(ext)) {
      const opens = (content.match(/\{/g) || []).length
      const closes = (content.match(/\}/g) || []).length
      if (Math.abs(opens - closes) > 2) {
        failures.push(`Unbalanced braces: ${opens} opening, ${closes} closing`)
        suggestions.push('Check for truncated or incomplete code')
      }
    }

    // JSON validation
    if (ext === '.json') {
      try {
        JSON.parse(content)
      } catch {
        failures.push('Invalid JSON syntax')
      }
    }

    // HTML basic structure
    if (ext === '.html' || ext === '.htm') {
      if (!content.includes('<html') && !content.includes('<!DOCTYPE') && !content.includes('<!doctype')) {
        suggestions.push('Consider adding proper HTML document structure')
      }
    }

    // Truncation detection
    if (content.trimEnd().endsWith('...') || content.trimEnd().endsWith('// ...')) {
      failures.push('Content appears truncated')
      suggestions.push('Complete the file — do not end with ellipsis')
    }
  }

  private checkCreative(
    content: string,
    originalRequest: string,
    failures: string[],
    suggestions: string[],
  ): void {
    // User-authored brevity beats the generic long-form creative floor. The
    // universal checks still reject empty, clipped, placeholder, or duplicated
    // output, so this does not weaken integrity verification.
    if (this.explicitlyLimitsContentLength(originalRequest)) return

    const words = content.split(/\s+/).filter(w => w.length > 0).length
    if (words < CREATIVE_MIN_WORDS) {
      failures.push(`Word count ${words}, minimum ${CREATIVE_MIN_WORDS}`)
      suggestions.push('Expand the narrative with more detail')
    }

    // Multiple paragraphs check
    const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0)
    if (paragraphs.length < 3) {
      failures.push('Content lacks paragraph structure')
      suggestions.push('Break content into multiple paragraphs')
    }
  }

  private checkBrowseAction(
    content: string,
    failures: string[],
    suggestions: string[],
  ): void {
    const words = content.split(/\s+/).filter(w => w.length > 0).length
    if (words < 100) {
      failures.push(`Action report too brief (${words} words)`)
      suggestions.push('Describe what was done and what was observed')
    }
  }
}
