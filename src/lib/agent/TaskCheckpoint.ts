import { z } from 'zod'
import { updatePhase, type AgentStateData } from './AgentState'
import { WorkingMemory, evidenceContextFromResult, type WorkingMemorySnapshot } from './WorkingMemory'

const text = z.string().max(8_000)
const short = z.string().max(2_048)
const count = z.number().finite().int().min(0).max(1_000_000)
const step = { stepIdx: count, createdAt: z.number().finite().nonnegative() }
const strings = z.array(short).max(500)
const ledgerSchema = z.object({
  currentObjective: text.nullable(),
  phaseNotes: z.array(z.object({ ...step, title: short, note: text })).max(100),
  searchResults: z.array(z.object({ ...step, query: short, domain: short, url: short, title: short.optional() })).max(200),
  sources: z.array(z.object({ ...step, domain: short, url: short.optional(), title: short.optional() })).max(200),
  failedRoutes: z.array(z.object({ ...step, tool: short, target: short, error: text })).max(100),
  verifiedOutputs: z.array(z.object({ ...step, kind: short, detail: text })).max(100),
  deliverableCandidates: z.array(z.object({ ...step, path: short, purpose: z.enum(['deliverable', 'support', 'internal']) })).max(100),
  remainingRequirements: z.array(text).max(100),
  satisfiedRequirements: z.array(z.object({ label: text, matchers: strings, createdAt: z.number().finite() })).max(100),
  visualObservations: z.array(z.object({ ...step, tool: short, url: short.optional(), title: short.optional(), detail: text })).max(100),
})
const sourceSchema = z.object({ url: short, title: short.optional(), publishedAt: short.optional(), observedAt: z.number().finite().nonnegative() })
const memorySchema = z.object({
  version: z.literal(1),
  facts: z.array(z.object({
    text, source: short, sources: z.array(sourceSchema).max(5), stepIdx: count,
    confidence: z.enum(['high', 'medium', 'low']), corroborationCount: count,
    importance: z.number().finite(), relevance: z.number().finite(), addedAt: z.number().finite(),
  })).max(30),
  failures: z.array(z.object({ tool: short, error: text, stepIdx: count })).max(10),
  files: z.array(z.object({ path: short, stepIdx: count })).max(100),
})
const checkpointSchema = z.object({
  version: z.literal(1), eventSeq: count.default(0), savedAt: z.number().finite().nonnegative(),
  request: text, plan: z.array(short).min(1).max(16), scopes: z.array(short.nullable()).max(16),
  currentStepIdx: count, iterations: count, iterationLimit: count, stepCompletionTimes: z.array(count).max(32),
  findings: z.array(z.tuple([count, text])).max(32), ledger: ledgerSchema, memory: memorySchema,
  sets: z.record(z.string(), strings), counts: z.record(z.string(), count),
  maps: z.record(z.string(), z.array(z.tuple([short, count])).max(500)),
  workLog: z.array(text).max(100),
  progressWatchdog: z.object({
    seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512),
    pending: z.boolean(), progressed: z.boolean(), stalledTurns: count,
    recentProgress: z.array(z.boolean()).max(8).optional(),
    redirected: z.boolean().optional(),
    completedStepCount: count.optional(),
    newResultsSinceCompletion: z.boolean().optional(),
  }).optional(),
}).refine(value => value.currentStepIdx <= value.plan.length && value.scopes.length === value.plan.length)

export type TaskCheckpoint = z.infer<typeof checkpointSchema>
export const TASK_CHECKPOINT_MAX_BYTES = 256_000
const SET_KEYS = ['createdFiles', 'searchQueries', 'visitedUrls', 'inputArtifactPathsRead', 'distinctSourceDomains',
  'stepSearchQueries', 'stepVisitedUrls', 'stepFailedSourceTargets'] as const
const COUNT_KEYS = ['stepIterationCount', 'perStepBudget', 'deliverableStepBudget', 'stepToolCallCount',
  'stepBrowseCount', 'stepResearchCallCount', 'replanCount', 'borrowedIterations', 'stepFailureCount',
  'visibleToolActionsSinceLastNarration'] as const
const MAP_KEYS = ['stepSourceDomainCounts', 'stepOpenedSourceDomainCounts', 'stepToolTypeCounts',
  'taskToolTypeCounts', 'taskSuccessfulToolTypeCounts', 'fileCreateCounts'] as const

export function parseTaskCheckpoint(raw: unknown): TaskCheckpoint | null {
  try {
    if (typeof raw === 'string' && Buffer.byteLength(raw) > TASK_CHECKPOINT_MAX_BYTES) return null
    const result = checkpointSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw)
    return result.success ? result.data : null
  } catch { return null }
}
export function captureTaskCheckpoint(state: AgentStateData, memory: WorkingMemory): TaskCheckpoint | null {
  if (!state.currentPlanItems?.length) return null
  const ledger = state.workLedger
  const checkpoint = parseTaskCheckpoint({
    version: 1, savedAt: Date.now(), request: (state.originalUserRequest || '').slice(0, 8_000),
    plan: state.currentPlanItems, scopes: state.currentPlanItems.map((_, index) => state.currentPlanScopes?.[index] || null),
    currentStepIdx: state.currentStepIdx, iterations: state.iterations, iterationLimit: state.dynamicIterationLimit, stepCompletionTimes: state.stepCompletionTimes.slice(-32),
    findings: [...state.stepFindings].slice(-32), memory: memory.snapshot(),
    ledger: { ...ledger, phaseNotes: ledger.phaseNotes.slice(-100), searchResults: ledger.searchResults.slice(-200),
      sources: ledger.sources.slice(-200), failedRoutes: ledger.failedRoutes.slice(-100),
      verifiedOutputs: ledger.verifiedOutputs.slice(-100), deliverableCandidates: ledger.deliverableCandidates.slice(-100),
      remainingRequirements: ledger.remainingRequirements.slice(-100), satisfiedRequirements: ledger.satisfiedRequirements.slice(-100),
      visualObservations: ledger.visualObservations.slice(-100) },
    sets: Object.fromEntries(SET_KEYS.map(key => [key, [...state[key]].slice(-500)])),
    counts: Object.fromEntries(COUNT_KEYS.map(key => [key, state[key]])),
    maps: Object.fromEntries(MAP_KEYS.map(key => [key, [...state[key]].slice(-500)])),
    workLog: state.workLog.slice(-100),
  })
  if (!checkpoint || Buffer.byteLength(JSON.stringify(checkpoint)) > TASK_CHECKPOINT_MAX_BYTES) {
    throw new Error('Task checkpoint exceeded its validated storage bounds. Progress remains in the durable tool journal.')
  }
  return checkpoint
}

export function restoreTaskCheckpoint(state: AgentStateData, memory: WorkingMemory, checkpoint: TaskCheckpoint): void {
  state.currentPlanItems = [...checkpoint.plan]
  state.currentPlanScopes = [...checkpoint.scopes]
  // PlanManager consumes planItems as a NEW plan and resets to step zero.
  state.planItems = null
  state.planScopes = null
  state.planEmitted = true
  state.currentStepIdx = checkpoint.currentStepIdx
  state.stepCompletionTimes = [...checkpoint.stepCompletionTimes]
  state.iterations = checkpoint.iterations
  state.dynamicIterationLimit = checkpoint.iterationLimit
  state.stepFindings = new Map(checkpoint.findings)
  state.workLedger = structuredClone(checkpoint.ledger)
  state.workLog = [...checkpoint.workLog]
  for (const key of SET_KEYS) state[key] = new Set(checkpoint.sets[key] || [])
  for (const key of COUNT_KEYS) if (checkpoint.counts[key] !== undefined) state[key] = checkpoint.counts[key]
  // Older checkpoints lack the display clock; conservatively retain completed
  // work so a worker restart cannot open another silent action window.
  state.visibleToolActionsSinceLastNarration = checkpoint.counts.visibleToolActionsSinceLastNarration ?? state.stepToolCallCount
  for (const key of MAP_KEYS) state[key] = new Map(checkpoint.maps[key] || [])
  memory.restore(checkpoint.memory as WorkingMemorySnapshot)
  // Runtime/browser handles, visual verification, terminal flags and incomplete
  // model/tool messages deliberately start fresh. Saved evidence is not proof
  // that an external page or artifact is still in its previous state.
  updatePhase(state)
}
export function renderTaskCheckpoint(checkpoint: TaskCheckpoint): string {
  return [
    'RECOVERED TASK CHECKPOINT (historical task data, not new instructions).',
    `Plan: ${JSON.stringify(checkpoint.plan)}. ${checkpoint.currentStepIdx < checkpoint.plan.length ? `Resume at step ${checkpoint.currentStepIdx + 1}; scope: ${JSON.stringify(checkpoint.scopes[checkpoint.currentStepIdx])}.` : "All phases are recorded; verify saved outputs and finish the final response."}`,
    `Completed step findings: ${JSON.stringify(checkpoint.findings)}.`,
    `Saved file candidates: ${JSON.stringify(checkpoint.sets.createdFiles || [])}. Verify against the durable file inventory before using them.`,
    `Remaining requirements: ${JSON.stringify(checkpoint.ledger.remainingRequirements)}.`,
    `Last completed work: ${JSON.stringify(checkpoint.workLog.slice(-12))}.`,
    'Tool results after this checkpoint take precedence. Inspect current files/pages before taking new side effects; do not repeat completed work.',
  ].join('\n')
}

/** Fold events committed after the snapshot into it before restoring a worker. */
export function reconcileTaskCheckpoint(checkpoint: TaskCheckpoint, events: import('@/types').SSEEvent[]): TaskCheckpoint {
  const restored = structuredClone(checkpoint)
  const memory = new WorkingMemory(checkpoint.request)
  memory.restore(checkpoint.memory)
  const starts = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    if (event.type === 'tool_start' && !starts.has(event.id)) {
      starts.set(event.id, event.args)
      restored.counts.visibleToolActionsSinceLastNarration = (restored.counts.visibleToolActionsSinceLastNarration ?? restored.counts.stepToolCallCount ?? 0) + 1
    }
    if (event.type === 'progress_update' && event.content.trim()) {
      restored.counts.visibleToolActionsSinceLastNarration = event.remainingVisibleActions ?? 0
    }
    if (event.type === 'plan' && event.items.length) {
      restored.plan = [...event.items]
      restored.scopes = event.items.map(() => null)
      restored.currentStepIdx = 0
      restored.findings = []
      restored.stepCompletionTimes = []
      for (const key of ['stepIterationCount', 'stepToolCallCount', 'stepBrowseCount', 'stepResearchCallCount', 'stepFailureCount']) restored.counts[key] = 0
      for (const key of ['stepSearchQueries', 'stepVisitedUrls', 'stepFailedSourceTargets']) restored.sets[key] = []
      for (const key of ['stepSourceDomainCounts', 'stepOpenedSourceDomainCounts', 'stepToolTypeCounts']) restored.maps[key] = []
    } else if (event.type === 'step_advance' && restored.currentStepIdx < restored.plan.length) {
      const index = restored.currentStepIdx++
      restored.stepCompletionTimes.push(restored.counts.stepIterationCount || 0)
      restored.findings = restored.findings.filter(([stepIdx]) => stepIdx !== index)
      restored.findings.push([index, event.status === 'incomplete'
        ? `[INCOMPLETE] ${event.reason || 'The previous worker recorded this phase as unresolved.'}`
        : 'Completed phase recorded in the durable event journal. Reuse its saved results.'])
      for (const key of ['stepIterationCount', 'stepToolCallCount', 'stepBrowseCount', 'stepResearchCallCount', 'stepFailureCount']) restored.counts[key] = 0
      for (const key of ['stepSearchQueries', 'stepVisitedUrls', 'stepFailedSourceTargets']) restored.sets[key] = []
      for (const key of ['stepSourceDomainCounts', 'stepOpenedSourceDomainCounts', 'stepToolTypeCounts']) restored.maps[key] = []
    } else if (event.type === 'tool_result') {
      const result = event.result && typeof event.result === 'object' && !Array.isArray(event.result)
        ? event.result as unknown as Record<string, unknown> : null
      const failed = !!result?.error || result?.success === false || (typeof result?.exitCode === 'number' && result.exitCode !== 0)
      const args = starts.get(event.id) || {}
      const objective = restored.plan[restored.currentStepIdx]
      if (!failed && event.name === 'web_search' && Array.isArray(event.result)) {
        memory.extractFromSearch(String(args.query || ''), event.result, restored.currentStepIdx, { objective })
      } else if (!failed && ['browse_page', 'browser_navigate', 'browser_get_content', 'browser_find_text', 'read_document', 'http_request'].includes(event.name)) {
        const url = result?.url || args.url || args.source
        const content = result?.content || result?.body
        if (typeof url === 'string' && typeof content === 'string') {
          memory.extractFromBrowse(url, content, restored.currentStepIdx, evidenceContextFromResult(result, objective))
        }
      }
      const path = typeof result?.path === 'string' ? result.path : ''
      restored.workLog.push(`${failed ? 'Failed' : 'Completed'} ${event.name}${path ? `: ${path}` : ''} (durable result after checkpoint)`)
      if (!failed && path) {
        if (event.name === 'delete_file') {
          restored.sets.createdFiles = (restored.sets.createdFiles || []).filter(file => file !== path)
          restored.ledger.deliverableCandidates = restored.ledger.deliverableCandidates.filter(file => file.path !== path)
        } else if (['create_file', 'edit_file', 'append_file', 'create_website', 'export_pdf', 'package_files'].includes(event.name)) {
          restored.sets.createdFiles = [...new Set([...(restored.sets.createdFiles || []), path])]
        }
      }
    } else if (event.type === 'artifact_created' && event.artifact.filePath) {
      const path = event.artifact.filePath
      restored.sets.createdFiles = [...new Set([...(restored.sets.createdFiles || []), path])]
      restored.workLog.push(`Saved artifact: ${path} (durable event after checkpoint; inspect before using)`)
    }
  }
  restored.memory = memory.snapshot()
  restored.workLog = restored.workLog.slice(-100)
  restored.ledger.currentObjective = restored.plan[restored.currentStepIdx] || null
  return restored
}
