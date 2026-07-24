/**
 * OutputVerifier — heuristic quality checks on deliverables before completion.
 *
 * Runs strategy-specific checks (word count, citations, placeholder detection,
 * structure) to prevent premature completion with low-quality output.
 * No LLM call — purely structural analysis.
 */

import type { WorkingMemory } from './WorkingMemory'
import {
  RESEARCH_MIN_WORDS_BY_COMPLEXITY,
  RESEARCH_MIN_CITATIONS,
  RESEARCH_MIN_PARAGRAPHS,
  CREATIVE_MIN_WORDS,
  BUILD_MIN_CONTENT_CHARS,
  PLACEHOLDER_PATTERNS,
  OUTLINE_ONLY_THRESHOLD,
} from './config'
import { taskDefaultsToMarkdownDeliverable } from './taskConstraints'
import { requestedBriefInlineSourceCount } from './BriefInlineResearch'

export interface VerificationResult {
  passed: boolean
  score: number        // 0-1 quality score
  failures: string[]   // Specific failures
  suggestions: string[]
}

export class OutputVerifier {
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

    // --- Universal checks ---

    // Empty or near-empty content
    if (!fileContent || fileContent.trim().length < 50) {
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
    if (lines.length > 5 && headingOrBulletLines / lines.length > OUTLINE_ONLY_THRESHOLD) {
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

    const savedMarkdownReport = filePath.toLowerCase().endsWith('.md') &&
      taskDefaultsToMarkdownDeliverable(originalRequest)

    if (savedMarkdownReport) {
      const headingCount = (fileContent.match(/^#{1,3}\s+\S/gm) || []).length
      if (headingCount < 4) {
        failures.push('Saved Markdown report needs a title, executive summary, multiple substantive sections, conclusion, and references')
        suggestions.push('Expand the report structure before delivering')
        score -= 0.2
      }
      if (!/^#\s+\S/m.test(fileContent)) {
        failures.push('Saved Markdown report needs a clear top-level title')
        suggestions.push('Add a specific # title')
        score -= 0.1
      }
      if (!/^##\s+Executive Summary\b/im.test(fileContent)) {
        failures.push('Saved Markdown report needs an Executive Summary section')
        suggestions.push('Add ## Executive Summary with synthesized findings')
        score -= 0.1
      }
      if (!/^##\s+(?:References|Sources)\b/im.test(fileContent)) {
        failures.push('Saved Markdown report needs a References section with source URLs')
        suggestions.push('Add ## References with numbered source entries and URLs')
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
        this.checkCreative(fileContent, failures, suggestions)
        break
      case 'browse':
        this.checkBrowseAction(fileContent, failures, suggestions)
        break
      default:
        if (savedMarkdownReport) {
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
    // Word count
    const words = content.split(/\s+/).filter(w => w.length > 0).length
    const minWords = this.researchMinimumWords(originalRequest, taskComplexity, filePath)
    if (words < minWords) {
      failures.push(`Word count ${words}, minimum ${minWords} for this task depth`)
      suggestions.push('Expand the report with structured analysis, concrete evidence, caveats, and implications')
    }

    // Citation count (URLs or "Source:" references)
    const urlPattern = /https?:\/\/[^\s)\]]+/g
    const sourcePattern = /\bsource[s]?\s*:/gi
    const urls = content.match(urlPattern) || []
    const sourceRefs = content.match(sourcePattern) || []
    const citationCount = new Set([...urls]).size + sourceRefs.length
    const explicitSourceCount = requestedBriefInlineSourceCount(originalRequest)
    const requiredCitations = explicitSourceCount ?? RESEARCH_MIN_CITATIONS
    if (citationCount < requiredCitations) {
      failures.push(`Only ${citationCount} citation(s), minimum ${requiredCitations}`)
      suggestions.push('Add source URLs to support claims')
    }

    // Substantive paragraphs (50+ words)
    const paragraphs = content.split(/\n\s*\n/).filter(p => {
      const pWords = p.split(/\s+/).filter(w => w.length > 0).length
      return pWords >= 50
    })
    if (paragraphs.length < RESEARCH_MIN_PARAGRAPHS) {
      failures.push(`Only ${paragraphs.length} substantive paragraph(s), minimum ${RESEARCH_MIN_PARAGRAPHS}`)
      suggestions.push('Develop each section into full paragraphs with analysis')
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

  private researchMinimumWords(originalRequest: string, taskComplexity: number, filePath: string): number {
    const request = originalRequest.toLowerCase()
    const explicitWordTarget = request.match(/\b(\d{2,5})\s*(?:\+?\s*)?words?\b/)
    if (explicitWordTarget) {
      const requested = Number(explicitWordTarget[1])
      if (Number.isFinite(requested) && requested > 0) {
        return Math.max(80, Math.floor(requested * 0.9))
      }
    }

    if (/\b(?:brief|quick|short|concise|summary|summarise|summarize|one[-\s]?page|1[-\s]?page)\b/.test(request)) {
      const savedResearchReport = filePath.toLowerCase().endsWith('.md') && taskDefaultsToMarkdownDeliverable(originalRequest)
      return savedResearchReport ? 400 : 180
    }

    const normalizedComplexity = Math.min(5, Math.max(1, Math.round(taskComplexity))) as keyof typeof RESEARCH_MIN_WORDS_BY_COMPLEXITY
    return RESEARCH_MIN_WORDS_BY_COMPLEXITY[normalizedComplexity]
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
    failures: string[],
    suggestions: string[],
  ): void {
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
