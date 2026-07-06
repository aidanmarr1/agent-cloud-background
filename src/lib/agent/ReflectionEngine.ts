/**
 * ReflectionEngine — evaluates agent progress after each tool execution round.
 *
 * Purely heuristic (no LLM call). Scores progress 0-1, detects contradictions
 * via WorkingMemory, and recommends whether to continue, try an alternative
 * approach, or advance to the next step.
 */

import type { AgentStateData } from './AgentState'
import type { ToolExecutionResult } from './ToolPipeline'
import type { WorkingMemory } from './WorkingMemory'
import {
  REFLECTION_LOW_PROGRESS_THRESHOLD,
  REFLECTION_CONSECUTIVE_LOW_TRIGGER,
  REFLECTION_PROGRESS_WEIGHTS,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  DIMINISHING_RETURNS_WINDOW,
  DIMINISHING_RETURNS_NEW_FACT_MIN,
  DIMINISHING_RETURNS_TRIGGER_ITERATION,
} from './config'
import { researchDepthProfileForState } from './ResearchDepth'

export interface ReflectionResult {
  progressScore: number
  contradictionDetected: boolean
  recommendation: 'continue' | 'try_alternative' | 'advance_step'
  summary: string
}

export class ReflectionEngine {
  reflect(
    state: AgentStateData,
    toolResults: ToolExecutionResult[],
    currentStepGoal: string | undefined,
    previousFactCount: number,
  ): ReflectionResult {
    const memory = state.workingMemory

    // --- Score components ---

    // 1. Successful tool calls ratio
    const totalCalls = toolResults.length
    const successfulCalls = toolResults.filter(r => !r.isError).length
    const callScore = totalCalls > 0 ? successfulCalls / totalCalls : 0

    // 2. New facts added to working memory
    const newFactCount = memory ? memory.factCountSince(previousFactCount) : 0
    const factScore = Math.min(1, newFactCount / 3) // 3+ new facts = perfect score

    // 3. New source domains visited this iteration
    const domainsBefore = state.distinctSourceDomains.size
    const newDomains = this.countNewDomains(toolResults, state)
    const sourceScore = Math.min(1, newDomains / 2) // 2+ new domains = perfect score

    // 4. File write progress (relevant for deliverable steps)
    const isDeliverableStep = state.currentPlanItems
      ? state.currentStepIdx === state.currentPlanItems.length - 1
      : false
    const fileWritten = toolResults.some(r => (r.tc.name === 'create_file' || r.tc.name === 'append_file' || r.tc.name === 'export_pdf') && !r.isError)
    const fileScore = isDeliverableStep ? (fileWritten ? 1 : 0) : (fileWritten ? 0.5 : 0.3)

    // Weighted sum
    const w = REFLECTION_PROGRESS_WEIGHTS
    const progressScore = Math.min(1, Math.max(0,
      callScore * w.successfulCalls +
      factScore * w.newFacts +
      sourceScore * w.newSources +
      fileScore * w.fileProgress
    ))

    // --- Contradiction detection ---
    let contradictionDetected = false
    if (memory && toolResults.length > 0) {
      for (const result of toolResults) {
        if (result.isError || !result.result) continue
        const resultText = typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result)
        // Check the first 500 chars of each result for contradictions
        const snippet = resultText.slice(0, 500)
        const contradictions = memory.detectContradictions(snippet)
        if (contradictions.length > 0) {
          contradictionDetected = true
          break
        }
      }
    }

    // --- Recommendation ---
    const consecutiveLow = progressScore < REFLECTION_LOW_PROGRESS_THRESHOLD
      ? state.consecutiveLowProgress + 1
      : 0

    let recommendation: ReflectionResult['recommendation'] = 'continue'

    // Goal trajectory prediction — early warning if step is at risk
    let trajectoryWarning: string | null = null
    if (state.goalTracker && state.currentPlanItems) {
      const prediction = state.goalTracker.predictCompletion(state.currentStepIdx, state)
      if (prediction.risk === 'unlikely') {
        recommendation = 'try_alternative'
        trajectoryWarning = prediction.recommendation
      } else if (prediction.risk === 'at_risk' && consecutiveLow >= 1) {
        recommendation = 'try_alternative'
        trajectoryWarning = prediction.recommendation
      }
    }

    // Loop signal from ToolPipeline — strong indicator to change approach
    let loopWarning: string | null = null
    if (state.lastLoopSignal) {
      const sig = state.lastLoopSignal
      switch (sig.type) {
        case 'browser_state':
          loopWarning = `Browser is cycling through visited states (${sig.tool}) — try a different page or approach`
          break
        case 'search_duplicate':
          loopWarning = 'Duplicate search detected — browse existing results or search for something different'
          break
        case 'near_dup_search':
          loopWarning = 'Searches are getting similar — use a different angle or open an existing result'
          break
        case 'file_rewrite':
          loopWarning = 'Attempted to recreate an existing file — use append_file to continue it or edit_file for targeted replacements'
          break
        case 'tool_rate_limit':
          loopWarning = `Rate limit hit for ${sig.tool} — you've used this tool too many times this step. Try a different approach`
          break
        case 'cross_tool_cycle':
          loopWarning = 'Detected a repeating tool pattern (e.g. search→browse→search→browse). Break the cycle with a different action'
          break
      }
      recommendation = 'try_alternative'
    }

    // Diminishing returns detection — no new facts being learned
    let diminishingWarning: string | null = null
    state.iterationNewFactCounts.push(newFactCount)
    if (state.stepIterationCount >= DIMINISHING_RETURNS_TRIGGER_ITERATION && !state.diminishingReturnsNudged) {
      const recentFacts = state.iterationNewFactCounts.slice(-DIMINISHING_RETURNS_WINDOW)
      if (recentFacts.length >= DIMINISHING_RETURNS_WINDOW) {
        const totalNewFacts = recentFacts.reduce((a, b) => a + b, 0)
        if (totalNewFacts < DIMINISHING_RETURNS_NEW_FACT_MIN) {
          diminishingWarning = `No new facts learned in the last ${DIMINISHING_RETURNS_WINDOW} iterations — research is stalling. Advance to the next step or switch approach`
          recommendation = 'advance_step'
          state.diminishingReturnsNudged = true
        }
      }
    }

    if (contradictionDetected) {
      recommendation = 'try_alternative'
    } else if (consecutiveLow >= REFLECTION_CONSECUTIVE_LOW_TRIGGER && recommendation === 'continue') {
      recommendation = 'try_alternative'
    } else if (progressScore > 0.7 && !isDeliverableStep && recommendation === 'continue') {
      const minCalls = researchDepthProfileForState(state).requiredCalls ||
        MIN_TOOL_CALLS_BY_COMPLEXITY[state.taskComplexity as 1 | 2 | 3] ||
        3
      if (state.stepResearchCallCount >= minCalls) {
        recommendation = 'advance_step'
      }
    }

    // --- Summary ---
    const parts: string[] = []
    parts.push(`Progress: ${(progressScore * 100).toFixed(0)}%`)
    if (newFactCount > 0) parts.push(`${newFactCount} new fact${newFactCount > 1 ? 's' : ''} learned`)
    if (newDomains > 0) parts.push(`${newDomains} new source${newDomains > 1 ? 's' : ''} visited`)
    if (contradictionDetected) parts.push('Contradicting information detected — verify claims')
    if (loopWarning) parts.push(loopWarning)
    if (diminishingWarning) parts.push(diminishingWarning)
    if (trajectoryWarning) parts.push(trajectoryWarning)
    if (recommendation === 'try_alternative' && !trajectoryWarning && !loopWarning) {
      parts.push('Current approach not productive — try a different angle')
    } else if (recommendation === 'advance_step') {
      parts.push('Sufficient research gathered — ready to advance')
    }
    const summary = parts.join('. ') + '.'

    return { progressScore, contradictionDetected, recommendation, summary }
  }

  private countNewDomains(toolResults: ToolExecutionResult[], state: AgentStateData): number {
    let count = 0
    for (const result of toolResults) {
      if (result.isError) continue
      // Extract domain from browse/navigate URLs
      const args = this.safeParseArgs(result.tc.arguments)
      const url = args?.url || args?.query || ''
      if (typeof url === 'string' && url.includes('.')) {
        try {
          const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
          if (!state.distinctSourceDomains.has(domain)) count++
        } catch { /* ignore invalid URLs */ }
      }
    }
    return count
  }

  private safeParseArgs(args: string): Record<string, unknown> | null {
    try { return JSON.parse(args) } catch { return null }
  }
}
