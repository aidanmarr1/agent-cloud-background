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
const agentStateSource = await readFile(new URL('../src/lib/agent/AgentState.ts', import.meta.url), 'utf8')
const toolPipelineSource = await readFile(new URL('../src/lib/agent/ToolPipeline.ts', import.meta.url), 'utf8')
const toolsSource = await readFile(new URL('../src/lib/tools.ts', import.meta.url), 'utf8')
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
  /case 'STREAMING': \{[\s\S]{0,2200}if \(repairPrematureFinalStepJump\(state\)\)/,
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
assert.match(
  toolsSource,
  /Never put a known or user-supplied URL\/domain in query/,
  'web search tool guidance must keep exact user URLs out of discovery queries',
)
assert.match(
  agentLoopSource,
  /Phase, strategy, urgency, and recovery state guide ordering and[\s\S]*they never hide a healthy tool from the model[\s\S]*activeTools = toolRegistry\.getActiveDefinitions\(state\)/,
  'normal action turns must expose every healthy configured tool instead of applying phase/source allowlists',
)
assert.match(
  agentLoopSource,
  /DIRECT USER TARGET:[\s\S]*Use the exact target directly when it is the best route[\s\S]*The full healthy tool set remains available/,
  'an exact user URL should guide the model toward the direct route without removing discovery or other healthy tools',
)
assert.doesNotMatch(
  agentLoopSource,
  /hasDirectSourceTool[\s\S]{0,1200}activeTools = activeTools\.filter\(tool => tool\.function\?\.name !== 'web_search'\)/,
  'an exact user URL must not hard-remove web_search from the healthy tool menu',
)
assert.match(
  agentStateSource,
  /fileWriteRepairPending:\s*\{\s*path: string\s*reason:[\s\S]*inspected: boolean/,
  'file write repair state must survive between paid model turns',
)
assert.match(
  agentLoopSource,
  /FILE REVISION REQUIRED:[\s\S]*prefer one targeted edit[\s\S]*Use another available tool only when it is genuinely the better recovery/,
  'a file conflict should strongly guide the repair while preserving unrelated healthy tools',
)
assert.match(
  toolPipelineSource,
  /!pending\.inspected[\s\S]*toolName === 'read_file' && exactTarget/,
  'a file write conflict must first force one exact read',
)
assert.match(
  toolPipelineSource,
  /isCodeLikeFilePath\(pending\.path\)[\s\S]*new Set\(\['edit_file'\]\)/,
  'an inspected code-file conflict must then narrow recovery to one exact edit',
)
assert.match(
  toolPipelineSource,
  /toolName === 'append_file'[\s\S]*isCodeLikeFilePath\(requestedPath\)[\s\S]*reason: 'code_append_disallowed'/,
  'code files must reject ordinary append_file calls before duplicate modules or exports are introduced',
)
assert.match(
  agentLoopSource,
  /shouldRejectBuildTextOnlyEmission[\s\S]*rejectedBuildTextOnlyEmission[\s\S]*discardBufferedEmission/,
  'raw code and false completion prose from tool-required build turns must stay out of the task stream',
)
const policyEngineSource = await readFile(new URL('../src/lib/agent/PolicyEngine.ts', import.meta.url), 'utf8')
assert.match(
  policyEngineSource,
  /repeatedBuildNoTool[\s\S]*buildNoToolRecoveryAttempts >= 3[\s\S]*BUILD ROUTE RESET[\s\S]*continueLoop: true/,
  'repeated text-only build recovery must change workspace strategy instead of terminating the task',
)
assert.doesNotMatch(policyEngineSource, /build_no_tool_recovery_exhausted/, 'recoverable build action selection must never become a terminal task error')
assert.match(
  toolPipelineSource,
  /E2B lifecycle changed while preparing sandbox[\s\S]*readFileInSandbox/,
  'an ambiguous E2B create must reconcile the actual file before asking the model to retry',
)
assert.match(
  toolPipelineSource,
  /if \(state\.nextWebsitePreviewDone\) \{\s*state\.nextWebsitePreviewDone = false[\s\S]*Preview is stale after a newer website file change/,
  'a one-shot website preview must become stale after a newer frontend write',
)
assert.match(
  toolPipelineSource,
  /state\.nextWebsitePreviewAttempted && !isPreviewEntryRepair/,
  'a failed website preview must not retry after unrelated component writes',
)

console.log(JSON.stringify({
  ok: true,
  analyticalTitlePrecedence: true,
  sequentialFinalization: true,
  liveE2BPreview: true,
  advisoryUsageCheckpoints: true,
  exactUrlRouting: true,
  fileWriteReconciliation: true,
  codeAppendGuard: true,
  hiddenBuildTextDrift: true,
  boundedBuildRecovery: true,
  freshLivePreview: true,
}, null, 2))
