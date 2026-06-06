/**
 * Strategy pattern for task-type-specific behavior.
 *
 * Instead of scattered regex checks and if/else chains throughout the codebase,
 * each task type encapsulates its own configuration: temperature, timeouts,
 * budget allocation, narration thresholds, and tool prioritization.
 *
 * The strategy is selected once at the start of a task and provides
 * a unified interface for all task-type-specific decisions.
 */

import type { TierTimeouts } from '@/agent/guards/timeouts'
import { effectiveTaskRequest } from '@/lib/conversationContext'
import {
  TEMPERATURE_CODE, TEMPERATURE_RESEARCH, TEMPERATURE_DEFAULT, TEMPERATURE_CREATIVE,
  TIMEOUT_BUILD_MS, TIMEOUT_RESEARCH_MS,
  NARRATION_THRESHOLD_DEFAULT, NARRATION_THRESHOLD_BROWSER,
  RESEARCH_STEP_BUDGET_MULTIPLIER, DELIVERABLE_BUDGET_FRACTION,
  TIER_TIMEOUTS,
  BASE_ITERATIONS, COMPLEXITY_ITERATION_BONUS,
} from './config'

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskType = 'research' | 'build' | 'code' | 'browse' | 'analysis' | 'creative' | 'general'

export interface TaskStrategyConfig {
  type: TaskType
  temperature: number
  iterationTimeoutMs: number
  narrationThreshold: number
  researchBudgetMultiplier: number
  deliverableBudgetFraction: number
  allowParallelTools: boolean
  preferredPhaseOrder: Array<'research' | 'build' | 'deliver'>
  stepGuidance: {
    research: string
    deliverable: string
  }
  toolPriority: string[]  // Preferred tool order for this task type
}

// ── Strategy Definitions ────────────────────────────────────────────────────

const STRATEGIES: Record<TaskType, TaskStrategyConfig> = {
  research: {
    type: 'research',
    temperature: TEMPERATURE_RESEARCH,
    iterationTimeoutMs: TIMEOUT_RESEARCH_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.75,  // Reserve budget for synthesis while leaving room for opened source evidence
    deliverableBudgetFraction: DELIVERABLE_BUDGET_FRACTION,
    allowParallelTools: false,
    preferredPhaseOrder: ['research', 'research', 'deliver'],
    stepGuidance: {
      research: 'Do more work inside each phase instead of adding more phase titles. Use strong sources, not snippet-only coverage. Prefer web_search plus read_document/http extraction for normal research pages; use the full browser only when rendered state, interaction, screenshots, or page scripts are actually needed. One search can satisfy a narrow lookup, but explanatory, cultural, historical, technical, current, or contested phases need a real evidence packet: targeted searches, opened primary/academic/specialist pages, concrete extracted details, and enough comparison/caveat coverage to make the phase useful.',
      deliverable: 'Create a clean report-style deliverable when the user asks for research/report output: specific title, compact metadata when useful, Executive Summary, numbered thematic findings, Conclusion, and numbered References with inline [n] citations. Synthesize the why, examples, tradeoffs, and bottom line instead of stacking source notes. Cite sources and state source gaps plainly.',
    },
    toolPriority: ['web_search', 'read_document', 'browser_navigate', 'create_file'],
  },

  build: {
    type: 'build',
    temperature: TEMPERATURE_CODE,
    iterationTimeoutMs: TIMEOUT_BUILD_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.85,  // Leave room for implementation, inspection, and revision
    deliverableBudgetFraction: 0.95,
    allowParallelTools: false,
    preferredPhaseOrder: ['research', 'build', 'deliver'],
    stepGuidance: {
      research: 'Gather only task-specific facts/assets before building. Read the nearby code and design language first. If real images/assets are needed, use image_search before browsing image sites manually. Do not browse generic design best-practice posts, inspiration galleries, or template roundups unless explicitly requested.',
      deliverable: 'Create complete working files, not partial scaffolds. Preserve existing patterns, handle expected states, polish UX details, run targeted checks, open/inspect the preview when visual, and revise defects before delivering.',
    },
    toolPriority: ['create_file', 'append_file', 'browser_screenshot', 'browser_scroll', 'export_pdf', 'edit_file', 'image_search', 'web_search', 'read_file'],
  },

  code: {
    type: 'code',
    temperature: TEMPERATURE_CODE,
    iterationTimeoutMs: TIMEOUT_BUILD_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.75,  // Read context and relevant APIs before coding
    deliverableBudgetFraction: 0.95,
    allowParallelTools: false,
    preferredPhaseOrder: ['build', 'deliver'],
    stepGuidance: {
      research: 'Inspect the existing code paths, tests, and relevant APIs before editing. Prefer local patterns over new abstractions.',
      deliverable: 'Write clean, correct code end-to-end. Cover edge cases, update focused tests or smoke checks, run verification, and fix failures before delivering.',
    },
    toolPriority: ['create_file', 'append_file', 'export_pdf', 'edit_file', 'read_file'],
  },

  browse: {
    type: 'browse',
    temperature: TEMPERATURE_RESEARCH,  // 0.3 — browser interaction needs decisiveness, not creativity
    iterationTimeoutMs: TIMEOUT_BUILD_MS,
    narrationThreshold: NARRATION_THRESHOLD_BROWSER,
    researchBudgetMultiplier: RESEARCH_STEP_BUDGET_MULTIPLIER,
    deliverableBudgetFraction: DELIVERABLE_BUDGET_FRACTION,
    allowParallelTools: false,
    preferredPhaseOrder: ['build', 'deliver'],
    stepGuidance: {
      research: 'Navigate directly and complete the full interaction autonomously. Use browser_action_sequence for stable same-screen actions and browser_fill_form for multi-field forms. For multi-choice workflows, handle one visible choice or field group at a time, observe, then continue. Do not give up while the page still has actionable controls.',
      deliverable: 'Verify the final page state before reporting. State exactly what changed, what remains, and any concrete blocker only after checking the live UI.',
    },
    toolPriority: ['browser_navigate', 'browser_action_sequence', 'browser_fill_form', 'browser_screenshot', 'browser_click_at', 'browser_find_text', 'browser_scroll', 'browser_select', 'browser_type', 'browser_press_key', 'browser_get_content', 'web_search'],
  },

  analysis: {
    type: 'analysis',
    temperature: TEMPERATURE_CODE,
    iterationTimeoutMs: TIMEOUT_BUILD_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.8,
    deliverableBudgetFraction: 0.95,
    allowParallelTools: false,
    preferredPhaseOrder: ['research', 'build', 'deliver'],
    stepGuidance: {
      research: 'Gather the relevant data, definitions, and assumptions with enough source/action depth inside the phase to support the conclusion. Prefer source data over summaries, then identify the mechanism, caveat, comparison point, and practical implication that make the analysis useful.',
      deliverable: 'Use code or structured calculations where practical. Show methodology, validate results, include caveats, and connect results into a clear interpretation rather than a list of numbers.',
    },
    toolPriority: ['web_search', 'read_document', 'create_file'],
  },

  creative: {
    type: 'creative',
    temperature: TEMPERATURE_CREATIVE,
    iterationTimeoutMs: TIMEOUT_RESEARCH_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.3,  // Minimal research for creative tasks
    deliverableBudgetFraction: 0.95,
    allowParallelTools: false,
    preferredPhaseOrder: ['deliver'],
    stepGuidance: {
      research: 'Light research only if factual grounding is needed; otherwise invest the turns in structure, voice, and revision.',
      deliverable: 'Plan long work into chunks. Draft with texture and specificity, revise for coherence and style, then collate complete chapter/section files into the final manuscript.',
    },
    toolPriority: ['create_file', 'append_file', 'export_pdf', 'edit_file', 'read_file', 'web_search'],
  },

  general: {
    type: 'general',
    temperature: TEMPERATURE_DEFAULT,
    iterationTimeoutMs: TIMEOUT_RESEARCH_MS,
    narrationThreshold: NARRATION_THRESHOLD_DEFAULT,
    researchBudgetMultiplier: 0.2,
    deliverableBudgetFraction: DELIVERABLE_BUDGET_FRACTION,
    allowParallelTools: false,
    preferredPhaseOrder: ['deliver'],
    stepGuidance: {
      research: 'Answer directly from existing context when the user asks a normal question. Use tools only when the user asks for current/live information, external files, browsing, or a concrete artifact.',
      deliverable: 'Give the direct answer with useful nuance, examples or tradeoffs where they clarify the point, concrete next steps, and enough detail to be genuinely helpful without adding unnecessary research scaffolding.',
    },
    toolPriority: ['create_file', 'browser_navigate', 'web_search'],
  },
}

// ── Detection ───────────────────────────────────────────────────────────────

const TASK_PATTERNS: Array<{ type: TaskType; patterns: RegExp[] }> = [
  {
    type: 'build',
    patterns: [
      /\b(build|create|make|design|develop|generate)\b.*\b(website|webpage|web\s*page|site|landing\s*page|app|application|portfolio|dashboard|page|frontend|ui|component|widget|form|layout|template)/i,
    ],
  },
  {
    type: 'code',
    patterns: [
      /\b(write\s*(?:a|me|the)?\s*(?:function|class|script|program|module|test|code)|implement|debug|fix\s*(?:this|the)\s*bug|refactor|algorithm|solve|code\s*(?:a|the|this))\b/i,
    ],
  },
  {
    type: 'analysis',
    patterns: [
      /\b(chart|graph|plot|visualize|data\s*analysis|spreadsheet|csv|statistics|trend|correlation|regression|dashboard)\b/i,
    ],
  },
  {
    type: 'creative',
    patterns: [
      /\b(write\s*(?:a|me|an)\s*(?:story|poem|essay|song|script|novel)|creative|brainstorm|imagine)\b/i,
    ],
  },
  {
    type: 'research',
    patterns: [
      /\b(research|find\s*out|investigate|compare|analy[sz]e|report\s*on|deep\s*dive|latest|current|recent|today|news|up[-\s]?to[-\s]?date|sources?|citations?|cite)\b/i,
      /\b(?:web\s*)?search(?:es|ing)?\b|\blook\s*(?:it\s*)?up\b/i,
    ],
  },
  {
    type: 'browse',
    patterns: [
      /\b(go\s*to|go\s+on|head\s+to|navigate|click|tap|press|log\s*in|sign\s*in|fill\s*out|browse|open\s+(?:the\s+)?(?:site|website|page|url)|visit|use\s+(?:the\s+)?(?:site|website|browser|page))\b/i,
      /\b(add|put|place|move)\b.{0,80}\b(cart|bag|basket)\b|\b(cart|bag|basket)\b.{0,80}\b(add|put|place)\b/i,
      /\b(?:debate|argue|chat|talk|message|ask|prompt|converse|discuss)\b.{0,100}\b(?:gemini|google\s+gemini|chatgpt|openai|claude|anthropic\s+claude|copilot|perplexity|grok)\b/i,
      /\b(select|pick|choose|configure|set)\b.{0,120}\b(color|colour|finish|storage|capacity|size|model|variant|option|section|field|control|setting|filter|tab|layer|date|time)\b/i,
      /\b(locate|find|search\s+for)\b.{0,100}\b(product|item|page|section|button|link|option|field|control|setting|filter|tab|layer|color|colour|finish|storage|capacity|size|model|variant)\b/i,
      /\b(?:buy|shop|order|checkout|book|reserve|schedule|cancel|unsubscribe|download|upload)\b.{0,100}\b(?:product|item|ticket|cart|bag|basket|appointment|reservation|file|document|receipt|invoice|page|site|website)\b/i,
      /\b(?:web\s*automation|browser\s*task|automate\s+(?:the\s+)?web|complete\s+(?:this\s+)?(?:website|browser|web)\s+task)\b/i,
    ],
  },
]

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect task type from task messages and return the full strategy.
 */
export function resolveStrategy(
  messages: Array<{ role: string; content: string }>
): TaskStrategyConfig {
  const content = effectiveTaskRequest(messages)

  for (const { type, patterns } of TASK_PATTERNS) {
    if (!['build', 'code', 'analysis', 'creative'].includes(type)) continue
    if (patterns.some(p => p.test(content))) {
      return STRATEGIES[type]
    }
  }

  // Browser-action intent is often phrased with "find" or "locate" plus a
  // concrete page operation. Prefer the action strategy over generic research
  // when the user wants the agent to manipulate a live site.
  const browsePatterns = TASK_PATTERNS.find(item => item.type === 'browse')?.patterns || []
  if (browsePatterns.some(p => p.test(content))) {
    return STRATEGIES.browse
  }

  for (const { type, patterns } of TASK_PATTERNS) {
    if (type === 'browse' || ['build', 'code', 'analysis', 'creative'].includes(type)) continue
    if (patterns.some(p => p.test(content))) {
      return STRATEGIES[type]
    }
  }

  return STRATEGIES.general
}

/**
 * Get strategy by explicit type name.
 */
export function getStrategy(type: TaskType): TaskStrategyConfig {
  return STRATEGIES[type]
}

/**
 * Compute iteration limit based on task complexity and strategy.
 */
export function computeIterationLimit(complexity: number): number {
  const bonus = COMPLEXITY_ITERATION_BONUS[complexity as keyof typeof COMPLEXITY_ITERATION_BONUS] || 0
  return BASE_ITERATIONS + bonus
}

/**
 * Compute tier timeouts from strategy.
 */
export function computeTimeouts(strategy: TaskStrategyConfig): TierTimeouts {
  const isBuild = strategy.type === 'build' || strategy.type === 'code'
  const tier = isBuild ? TIER_TIMEOUTS.build : TIER_TIMEOUTS.research
  return {
    iterationTimeoutMs: strategy.iterationTimeoutMs,
    inactivityTimeoutMs: TIER_TIMEOUTS.inactivityTimeoutMs,
    contentOnlyTimeoutMs: tier.contentOnlyTimeoutMs,
    contentOnlyMinChars: tier.contentOnlyMinChars,
    checkIntervalMs: TIER_TIMEOUTS.checkIntervalMs,
  }
}

/**
 * Compute step budgets for a plan based on strategy and complexity.
 */
export function computeStepBudgets(
  strategy: TaskStrategyConfig,
  numSteps: number,
  iterationLimit: number,
  complexity: number,
): { perStepBudget: number; deliverableStepBudget: number } {
  const { COMPLEXITY_BUDGET_MULTIPLIERS, MIN_STEP_BUDGET, MIN_DELIVERABLE_BUDGET } = require('./config')
  const complexityMultiplier = COMPLEXITY_BUDGET_MULTIPLIERS[complexity as keyof typeof COMPLEXITY_BUDGET_MULTIPLIERS] || 1.0
  const iterationsForWork = Math.floor(iterationLimit * strategy.deliverableBudgetFraction)

  if (numSteps === 1) {
    return { perStepBudget: iterationsForWork, deliverableStepBudget: iterationsForWork }
  }

  const baseBudget = iterationsForWork / numSteps
  const researchBudget = Math.max(
    MIN_STEP_BUDGET,
    Math.floor(baseBudget * strategy.researchBudgetMultiplier * complexityMultiplier)
  )
  const researchTotal = researchBudget * (numSteps - 1)
  const deliverableBudget = Math.max(MIN_DELIVERABLE_BUDGET, iterationsForWork - researchTotal)

  return { perStepBudget: researchBudget, deliverableStepBudget: deliverableBudget }
}
