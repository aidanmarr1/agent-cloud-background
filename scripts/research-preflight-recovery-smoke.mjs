#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: { '@': srcPath },
})

const [loopSource, pipelineSource, registrySource, configSource, strategySource] = await Promise.all([
  readFile(`${root}/src/lib/agent/AgentLoop.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/ToolPipeline.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/ToolRegistry.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/config.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/TaskStrategy.ts`, 'utf8'),
])

assert.match(
  loopSource,
  /Phase, strategy, urgency, and recovery state guide ordering and[\s\S]*they never hide a healthy tool from the model[\s\S]*activeTools = toolRegistry\.getActiveDefinitions\(state\)/,
  'normal agentic turns must start from the complete healthy configured registry',
)
assert.match(
  registrySource,
  /priorityList\.forEach[\s\S]*for \(const \[name, metadata\] of this\.tools\)[\s\S]*active\.sort/,
  'strategy preferences should order the full registry rather than choose an allowlist',
)
assert.match(
  registrySource,
  /runtime && !runtime\.enabled[\s\S]*isToolDisabled\(state, name\)[\s\S]*name === 'web_search' && state\.searchDisabled/,
  'actual runtime health and configuration state may remove unavailable tools',
)
assert.doesNotMatch(
  `${configSource}\n${registrySource}`,
  /PHASE_TOOL_FILTER/,
  'phase allowlists must not exist in configuration or registry selection',
)
assert.doesNotMatch(
  pipelineSource,
  /phaseSemanticBlockReason|researchFileDetourBlockReason|researchSourceBalanceBlockReason|direct_navigation_required|research_source_balance|finalSynthesisCarryoverBlockReason|synthesisPhaseResearchBlockReason/,
  'phase/source preferences must not be enforced as execution-time preflight blockers',
)
assert.doesNotMatch(
  loopSource,
  /mustKeepSourceOnlyMenu|activeTools = filtered\.length > 0|loopRecoveryToolForState\(state, filtered\)|hasDirectSourceTool[\s\S]{0,1200}activeTools = activeTools\.filter\(tool => tool\.function\?\.name !== 'web_search'\)/,
  'source recovery and exact URLs must not replace the healthy menu with a hardcoded subset',
)
assert.match(
  loopSource,
  /pendingExplicitTaskToolTargets[\s\S]*activeTools = permittedAvailableTools[\s\S]*explicitTaskToolConstraint\.forbidden[\s\S]*toolAllowedByExplicitTaskConstraint/,
  'an explicit user-authored exclusive or forbidden tool instruction may constrain the menu',
)
assert.match(
  pipelineSource,
  /toolAllowedByExplicitTaskConstraint\(explicitTaskToolConstraint, tc\.name\)[\s\S]*violates the user's explicit exclusive\/forbidden tool instruction/,
  'execution must preserve explicit user tool constraints',
)
assert.match(
  loopSource,
  /pruneExhaustedStepToolsForCurrentTurn\(state, activeTools\)[\s\S]*activeTools = exhaustedStepToolPrune\.tools[\s\S]*STEP TOOL LIMIT REACHED/,
  'a genuinely exhausted per-phase runtime limit may remove that exhausted tool',
)
assert.match(
  loopSource,
  /availability remains governed by registry health\/config checks,[\s\S]*explicit user constraints, permissions, and execution safety/,
  'the tool-selection contract must keep safety and permissions authoritative',
)
assert.match(
  strategySource,
  /research:[\s\S]*toolPriority: \['web_search', 'read_document', 'browser_navigate', 'create_file'\]/,
  'research strategy should express a preference order rather than an availability boundary',
)

const { createInitialState } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/AgentState.ts', import.meta.url)),
)
const { ToolRegistry } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/ToolRegistry.ts', import.meta.url)),
)
const {
  explicitTaskToolConstraintFromText,
  toolAllowedByExplicitTaskConstraint,
} = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/taskConstraints.ts', import.meta.url)),
)

const state = createInitialState(false, {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
})

const registeredToolNames = [
  'web_search',
  'read_document',
  'browser_navigate',
  'create_file',
  'execute_command',
]
const definitions = registeredToolNames.map(name => ({
  type: 'function',
  function: {
    name,
    description: `${name} smoke definition`,
    parameters: { type: 'object', properties: {} },
  },
}))
const registry = new ToolRegistry().registerFromDefinitions(definitions)
const activeNames = currentState => registry
  .getActiveDefinitions(currentState)
  .map(definition => definition.function.name)

state.currentPhase = 'research'
state.taskStrategy = 'research'
state.strategyConfig = { toolPriority: ['read_document', 'web_search', 'browser_navigate'] }
const researchTools = activeNames(state)
assert.deepEqual(
  [...researchTools].sort(),
  [...registeredToolNames].sort(),
  'research must expose search, extraction, browser, file, and terminal tools together',
)
assert.deepEqual(
  researchTools.slice(0, 3),
  ['read_document', 'web_search', 'browser_navigate'],
  'research preferences should affect ordering only',
)

state.currentPhase = 'deliver'
state.taskStrategy = 'build'
state.strategyConfig = { toolPriority: ['create_file', 'execute_command'] }
const deliverTools = activeNames(state)
assert.deepEqual(
  [...deliverTools].sort(),
  [...registeredToolNames].sort(),
  'delivery/build phases must retain the same healthy cross-capability menu',
)
assert.deepEqual(
  deliverTools.slice(0, 2),
  ['create_file', 'execute_command'],
  'delivery/build preferences should reorder rather than hide tools',
)

registry.disable('browser_navigate', 'smoke runtime outage')
assert.equal(activeNames(state).includes('browser_navigate'), false, 'a runtime-disabled tool must be unavailable')
registry.enable('browser_navigate')
assert.equal(activeNames(state).includes('browser_navigate'), true, 'a recovered runtime tool must return to the shared menu')

state.toolHealth.set('execute_command', {
  successes: 0,
  failures: 3,
  consecutiveFailures: 3,
  disabledUntil: Date.now() + 60_000,
})
assert.equal(activeNames(state).includes('execute_command'), false, 'an open health circuit may remove its unhealthy tool')

state.searchDisabled = true
assert.equal(activeNames(state).includes('web_search'), false, 'a genuinely disabled search configuration may remove web_search')
assert.equal(activeNames(state).includes('read_document'), true, 'disabling search must not remove independent extraction tools')

const browserForbidden = explicitTaskToolConstraintFromText('Do not use browser tools for this task.')
assert.equal(toolAllowedByExplicitTaskConstraint(browserForbidden, 'browser_navigate'), false)
assert.equal(toolAllowedByExplicitTaskConstraint(browserForbidden, 'read_document'), true)

console.log('Research tool-autonomy and restriction-boundary smoke passed.')
