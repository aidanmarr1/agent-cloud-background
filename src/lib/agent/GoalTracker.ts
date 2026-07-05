/**
 * GoalTracker — explicit sub-goal state management for the agent.
 *
 * Decomposes the plan into tracked sub-goals with status, evidence collection,
 * and completion detection. Surfaces unmet goals in context to keep the agent
 * focused on what actually needs to be done.
 */

import { currentStepText, isResearchStepText, type AgentStateData } from './AgentState'
import type { ToolExecutionResult } from './ToolPipeline'
import type { WorkingMemory } from './WorkingMemory'
import {
  GOAL_MAX_EVIDENCE_PER_STEP,
  MIN_TOOL_CALLS_BY_COMPLEXITY,
  MIN_RESEARCH_CALLS_BY_COMPLEXITY,
} from './config'
import { isSubstantiveResearchState, researchDepthProfileForState } from './ResearchDepth'
import { currentStepHasSingleWebSearchLimit, currentStepWebSearchLimit } from './taskConstraints'

export type GoalStatus = 'pending' | 'active' | 'achieved' | 'blocked'

export interface SubGoal {
  id: string
  description: string
  status: GoalStatus
  stepIdx: number
  evidence: string[]
}

export class GoalTracker {
  private goals: SubGoal[] = []
  private initialized = false
  private readonly MAX_RENDERED_GOALS = 8

  isInitialized(): boolean {
    return this.initialized
  }

  /** Create one sub-goal per plan step. */
  initializeFromPlan(planItems: string[]): void {
    this.goals = planItems.map((item, idx) => ({
      id: `goal-${idx}`,
      description: item,
      status: idx === 0 ? 'active' : 'pending',
      stepIdx: idx,
      evidence: [],
    }))
    this.initialized = true
  }

  /** Record what a tool call contributed to the current step's goal. */
  recordToolContribution(
    toolName: string,
    result: ToolExecutionResult,
    stepIdx: number,
    workingMemory: WorkingMemory | null,
  ): void {
    const goal = this.goals.find(g => g.stepIdx === stepIdx)
    if (!goal || goal.evidence.length >= GOAL_MAX_EVIDENCE_PER_STEP) return

    if (result.isError) return

    let evidence: string | null = null

    switch (toolName) {
      case 'web_search': {
        const args = this.safeParseArgs(result.tc.arguments)
        const query = args?.query || 'unknown'
        evidence = `Searched: "${query}"`
        break
      }
      case 'image_search': {
        const downloadResult = result.result as { downloaded?: string[] } | undefined
        const count = downloadResult?.downloaded?.length || 0
        evidence = count > 0 ? `Downloaded ${count} image${count === 1 ? '' : 's'}` : 'Searched images'
        break
      }
      case 'browser_navigate': {
        const args = this.safeParseArgs(result.tc.arguments)
        const url = args?.url || 'unknown'
        const domain = this.extractDomain(String(url))
        evidence = `Visited: ${domain}`
        break
      }
      case 'browse_page':
      case 'browser_get_content': {
        evidence = 'Extracted page content'
        break
      }
      case 'create_file': {
        const args = this.safeParseArgs(result.tc.arguments)
        const path = args?.path || 'unknown'
        evidence = `Created: ${path}`
        break
      }
      case 'edit_file': {
        const args = this.safeParseArgs(result.tc.arguments)
        const path = args?.path || 'unknown'
        evidence = `Edited: ${path}`
        break
      }
      case 'append_file': {
        const args = this.safeParseArgs(result.tc.arguments)
        const path = args?.path || 'unknown'
        evidence = `Appended: ${path}`
        break
      }
      case 'export_pdf': {
        const pdfResult = result.result as { path?: string } | undefined
        const args = this.safeParseArgs(result.tc.arguments)
        const path = pdfResult?.path || args?.output_path || 'unknown'
        evidence = `Exported PDF: ${path}`
        break
      }
      case 'run_code':
      case 'execute_command': {
        evidence = 'Executed code/command'
        break
      }
      case 'read_document': {
        const args = this.safeParseArgs(result.tc.arguments)
        const source = args?.url || args?.path || 'document'
        evidence = `Read: ${this.truncate(String(source), 50)}`
        break
      }
      case 'http_request': {
        const args = this.safeParseArgs(result.tc.arguments)
        evidence = `API: ${args?.method || 'GET'} ${this.extractDomain(String(args?.url || ''))}`
        break
      }
      default: {
        if (toolName.startsWith('browser_')) {
          evidence = `Browser: ${toolName.replace('browser_', '')}`
        }
        break
      }
    }

    if (evidence && !goal.evidence.includes(evidence)) {
      goal.evidence.push(evidence)
    }
  }

  /**
   * Check whether the current step's sub-goal has been sufficiently met.
   * Uses different criteria for research vs. deliverable steps.
   */
  checkGoalCompletion(
    stepIdx: number,
    state: AgentStateData,
  ): { allMet: boolean; unmetGoals: SubGoal[] } {
    const goal = this.goals.find(g => g.stepIdx === stepIdx)
    if (!goal) return { allMet: false, unmetGoals: [] }

    const isLastStep = state.currentPlanItems
      ? stepIdx === state.currentPlanItems.length - 1
      : false

    const complexity = state.taskComplexity as 1 | 2 | 3
    const stepText = currentStepText(state) || goal.description
    const researchLike = state.taskStrategy === 'research' ||
      state.currentPhase === 'research' ||
      isResearchStepText(stepText)
    const fixedSearchLimit = currentStepWebSearchLimit(state)
    const fixedSearchOnly = fixedSearchLimit !== null || currentStepHasSingleWebSearchLimit(state)
    const researchDepth = researchDepthProfileForState(state)
    const substantiveResearch = isSubstantiveResearchState(state)
    const minCalls = researchLike
      ? (fixedSearchLimit ?? researchDepth.requiredCalls)
      : (MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 3)
    let met = false

    if (!isLastStep && state.taskStrategy === 'browse') {
      // Browser action steps cannot be proven from generic evidence such as
      // "Visited: amazon.com" or "Browser: click". They require the browser
      // completion detector to verify the exact live page state for the active
      // step; otherwise the UI can tick off actions that never happened.
      met = state.browserTaskCompleted && state.browserTaskCompletionEvidence.length > 0
    } else if (isLastStep) {
      // Deliverable step: need at least one file written
      met = state.createdFiles.size > 0 && goal.evidence.some(e => e.startsWith('Created:') || e.startsWith('Appended:') || e.startsWith('Exported PDF:'))
    } else if (state.emittedImageArtifacts.size > 0 && /image|photo|picture|asset|retrieve|return|download/i.test(goal.description)) {
      met = goal.evidence.some(e => e.toLowerCase().includes('image'))
    } else {
      // Research step: complex phases need both enough actions and actual source
      // extraction, otherwise shallow search snippets can tick off the plan.
      const openedSourceEvidence =
        state.stepVisitedUrls.size > 0 ||
        state.stepSourceDomainCounts.size > 0
      const directResearchEvidence =
        (fixedSearchOnly || !researchLike || (complexity <= 1 && !substantiveResearch))
          ? state.stepSearchQueries.size > 0 || goal.evidence.length > 0 || openedSourceEvidence
          : openedSourceEvidence
      const requiredOpenedSources = researchDepth.requiredSourceBreadth
      const sourceBreadthSatisfied =
        fixedSearchOnly ||
        !researchLike ||
        (complexity <= 1 && !substantiveResearch) ||
        state.stepSourceDomainCounts.size >= requiredOpenedSources
      met = state.stepResearchCallCount >= minCalls &&
        (!researchLike || (directResearchEvidence && sourceBreadthSatisfied))
    }

    if (met && goal.status !== 'achieved') {
      goal.status = 'achieved'
    }

    const unmetGoals = this.goals.filter(g => g.stepIdx === stepIdx && g.status !== 'achieved')
    return { allMet: unmetGoals.length === 0, unmetGoals }
  }

  /** Advance the active goal to the next step. */
  advanceToStep(stepIdx: number): void {
    for (const goal of this.goals) {
      if (goal.stepIdx < stepIdx && goal.status === 'active') {
        goal.status = 'achieved'
      }
      if (goal.stepIdx === stepIdx) {
        goal.status = 'active'
      }
    }
  }

  /**
   * Predict whether the current step's goal will be completed given the current
   * trajectory (evidence gathered vs. iteration budget consumed).
   * Returns a risk level and recommendation.
   */
  predictCompletion(
    stepIdx: number,
    state: AgentStateData,
  ): { risk: 'on_track' | 'at_risk' | 'unlikely'; budgetUsed: number; recommendation: string | null } {
    const goal = this.goals.find(g => g.stepIdx === stepIdx)
    if (!goal) return { risk: 'on_track', budgetUsed: 0, recommendation: null }

    const isLastStep = state.currentPlanItems
      ? stepIdx === state.currentPlanItems.length - 1
      : false

    const budget = isLastStep
      ? (state.deliverableStepBudget || state.perStepBudget || 10)
      : (state.perStepBudget || 10)
    const used = state.stepIterationCount
    const budgetUsed = budget > 0 ? used / budget : 0

    const complexity = state.taskComplexity as 1 | 2 | 3
    const fixedSearchLimit = currentStepWebSearchLimit(state)
    const minCalls = state.taskStrategy === 'research' || state.currentPhase === 'research'
      ? (fixedSearchLimit ?? MIN_RESEARCH_CALLS_BY_COMPLEXITY[complexity] ?? MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 3)
      : (MIN_TOOL_CALLS_BY_COMPLEXITY[complexity] ?? 3)
    const evidenceProgress = goal.evidence.length / Math.max(2, minCalls)
    const callProgress = state.stepResearchCallCount / Math.max(1, minCalls)

    // If >60% budget used but <30% progress, unlikely to complete
    if (budgetUsed > 0.6 && evidenceProgress < 0.3 && callProgress < 0.3) {
      return {
        risk: 'unlikely',
        budgetUsed,
        recommendation: `Step is ${Math.round(budgetUsed * 100)}% through budget but only ${Math.round(evidenceProgress * 100)}% evidence gathered. Consider pivoting approach or advancing to next step.`,
      }
    }

    // If >40% budget used but <20% progress, at risk
    if (budgetUsed > 0.4 && evidenceProgress < 0.2) {
      return {
        risk: 'at_risk',
        budgetUsed,
        recommendation: `Slow progress on this step. Try a different search angle or tool.`,
      }
    }

    return { risk: 'on_track', budgetUsed, recommendation: null }
  }

  /** Mark a step's goal as blocked. */
  markBlocked(stepIdx: number, reason: string): void {
    const goal = this.goals.find(g => g.stepIdx === stepIdx)
    if (goal) {
      goal.status = 'blocked'
      goal.evidence.push(`BLOCKED: ${reason}`)
    }
  }

  /**
   * Render a compact goal status line for injection into step messages.
   * Returns null if not initialized.
   */
  renderForContext(): string | null {
    if (!this.initialized || this.goals.length === 0) return null

    const statusIcons: Record<GoalStatus, string> = {
      achieved: 'DONE',
      active: 'NOW',
      pending: '    ',
      blocked: 'SKIP',
    }

    const activeIndex = this.goals.findIndex(g => g.status === 'active')
    const renderedGoals = this.visibleGoalsForContext(activeIndex)
    const line = renderedGoals.map(({ goal: g, index: i }) => {
      const icon = statusIcons[g.status]
      const num = i + 1
      const desc = this.truncate(g.description, 40)
      return `[${icon}] ${num}. ${desc}`
    }).join(' | ')
    const compactPrefix = renderedGoals.length < this.goals.length
      ? `${this.goals.filter(g => g.status === 'achieved').length} done, ${this.goals.filter(g => g.status === 'blocked').length} blocked, ${this.goals.length} total | `
      : ''

    // Show unmet details for active goal
    const active = this.goals.find(g => g.status === 'active')
    let detail = ''
    if (active && active.evidence.length > 0) {
      detail = `\nEvidence so far: ${active.evidence.slice(-3).join(', ')}`
    }

    return `GOALS: ${compactPrefix}${line}${detail}`
  }

  private visibleGoalsForContext(activeIndex: number): Array<{ goal: SubGoal; index: number }> {
    if (this.goals.length <= this.MAX_RENDERED_GOALS) {
      return this.goals.map((goal, index) => ({ goal, index }))
    }

    const active = activeIndex >= 0 ? activeIndex : this.goals.findIndex(g => g.status !== 'achieved')
    const center = active >= 0 ? active : 0
    const indexes = new Set<number>([0, this.goals.length - 1, center])

    for (let offset = 1; indexes.size < this.MAX_RENDERED_GOALS && offset < this.goals.length; offset++) {
      if (center - offset > 0) indexes.add(center - offset)
      if (indexes.size >= this.MAX_RENDERED_GOALS) break
      if (center + offset < this.goals.length - 1) indexes.add(center + offset)
    }

    return [...indexes]
      .sort((a, b) => a - b)
      .map(index => ({ goal: this.goals[index], index }))
  }

  private safeParseArgs(args: string): Record<string, unknown> | null {
    try { return JSON.parse(args) } catch { return null }
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname
    } catch {
      return url.slice(0, 30)
    }
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen - 3) + '...' : text
  }
}
