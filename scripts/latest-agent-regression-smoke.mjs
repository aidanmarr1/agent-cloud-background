#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { isCurrentSynthesisStep } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/AgentState.ts', import.meta.url)),
)

const analyticalResearchStep = {
  currentPlanItems: [
    'Trace the product history',
    'Analyze standard recipes, core ingredients, and milk-to-espresso ratios for classic variations',
    'Write the cited report',
  ],
  currentPlanScopes: [
    'Gather historical sources.',
    'Synthesize findings into a thorough comparison after researching standard recipes and ratios.',
    'Use the gathered evidence.',
  ],
  currentStepIdx: 1,
  distinctSourceDomains: new Set(['example.com', 'example.org', 'example.net']),
  visitedUrls: new Set(['https://example.com/a', 'https://example.org/b', 'https://example.net/c']),
  stepFindings: new Map([[0, ['history']]]),
  searchQueries: new Set(['history', 'recipes']),
}
assert.equal(
  isCurrentSynthesisStep(analyticalResearchStep),
  false,
  'an analytical title must not inherit synthesis-only behavior from a hidden scope',
)

assert.equal(
  isCurrentSynthesisStep({
    ...analyticalResearchStep,
    currentPlanItems: [
      analyticalResearchStep.currentPlanItems[0],
      'Analyze the gathered evidence and compare the established findings',
      analyticalResearchStep.currentPlanItems[2],
    ],
  }),
  true,
  'an analytical step that explicitly reuses sufficient gathered evidence may synthesize',
)

assert.equal(
  isCurrentSynthesisStep({
    ...analyticalResearchStep,
    currentStepIdx: 2,
  }),
  true,
  'an explicitly final writing step must remain synthesis-only',
)

const agentLoopSource = await readFile(new URL('../src/lib/agent/AgentLoop.ts', import.meta.url), 'utf8')
const taskRunnerSource = await readFile(new URL('../src/lib/agent/chatTaskRunner.ts', import.meta.url), 'utf8')
const localWebsiteSource = await readFile(new URL('../src/lib/localWebsiteServer.ts', import.meta.url), 'utf8')
const e2bSource = await readFile(new URL('../src/lib/e2bSandbox.ts', import.meta.url), 'utf8')

assert.match(
  agentLoopSource,
  /stepCompletionTimes\.length < state\.currentPlanItems\.length - 1\) return false/,
  'a final draft must not autosave before all preceding plan steps complete',
)
assert.match(
  agentLoopSource,
  /case 'STREAMING': \{\s+if \(repairPrematureFinalStepJump\(state\)\)/,
  'the main model loop must repair a premature final-step jump before another action',
)
assert.match(
  taskRunnerSource,
  /Periodic checkpoints are advisory[\s\S]*Only an authoritative out-of-credit result may stop user work/,
  'a checkpoint ownership transition must not terminate valid task work',
)
assert.match(
  localWebsiteSource,
  /isCloudSandboxProviderEnabled\(\)[\s\S]*ensureE2BWebsitePreview/,
  'cloud website previews must launch in the task sandbox rather than the worker',
)
assert.match(
  e2bSource,
  /python3 -m http\.server \$\{port\} --bind 0\.0\.0\.0 --directory/,
  'the task VM must host its own live website preview',
)
assert.match(
  e2bSource,
  /hostToHttpUrl\(sandbox\.getHost\(port\)\)/,
  'the live preview must be exposed through the task VM hostname',
)

console.log(JSON.stringify({
  ok: true,
  analyticalTitlePrecedence: true,
  sequentialFinalization: true,
  liveE2BPreview: true,
  advisoryUsageCheckpoints: true,
}, null, 2))
