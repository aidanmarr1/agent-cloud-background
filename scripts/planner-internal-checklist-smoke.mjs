import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [prompts, planManager, agentLoop, policyEngine] = await Promise.all([
  readFile(new URL('../src/lib/prompts.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/agent/PlanManager.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/agent/AgentLoop.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/agent/PolicyEngine.ts', import.meta.url), 'utf8'),
])

assert.match(
  prompts,
  /hidden "checklist"[\s\S]*concrete task-specific outcomes[\s\S]*not immutable rules/,
  'the planner must decompose visible phases into adaptable internal outcomes',
)
assert.match(
  planManager,
  /checklist\?: unknown[\s\S]*slice\(0, 7\)[\s\S]*Internal outcomes:/,
  'planner checklist output must be parsed into bounded hidden phase scope',
)
assert.match(
  agentLoop,
  /A final phase is an outcome boundary, not a file-only tool lane[\s\S]*activeTools = toolRegistry\.getActiveDefinitions\(state\)/,
  'ordinary final phases must keep the full relevant tool menu',
)
assert.match(
  agentLoop,
  /state\.finalSavedDeliverableRecoveryAttempts > 0[\s\S]*partialFileWriteRecoveryPending[\s\S]*pendingDeliverableRevision/,
  'compact file-only prompting must be limited to concrete recovery states',
)
assert.match(
  policyEngine,
  /state\.finalDeliverableHandoffPending[\s\S]*complete final phase is finished/,
  'handoff must begin only after the model completes the entire final phase',
)

console.log('planner internal checklist smoke checks passed')
