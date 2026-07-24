import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const {
  explicitTaskToolConstraintFromText,
  taskDefaultsToMarkdownDeliverable,
  toolAllowedByExplicitTaskConstraint,
} = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/taskConstraints.ts', import.meta.url)),
)
const { trackSuccessfulToolExecution } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/AgentState.ts', import.meta.url)),
)
const { analyzeTaskIntent } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/TaskIntent.ts', import.meta.url)),
)

assert.deepEqual(
  explicitTaskToolConstraintFromText('Extract https://example.com using the terminal only that you have.'),
  { required: ['terminal'], exclusive: ['terminal'], forbidden: [] },
  'terminal-only URL extraction must become a hard method boundary',
)
assert.deepEqual(
  explicitTaskToolConstraintFromText('Use only web_search for this lookup.'),
  { required: ['web_search'], exclusive: ['web_search'], forbidden: [] },
  'raw web_search-only instructions must become an exclusive boundary',
)
assert.deepEqual(
  explicitTaskToolConstraintFromText('Use image_search to find a real photo.'),
  { required: ['image_search'], exclusive: [], forbidden: [] },
  'a plain raw tool instruction must require one use without becoming exclusive',
)
assert.deepEqual(
  explicitTaskToolConstraintFromText("Do this in the shell; don't use the browser."),
  { required: ['terminal'], exclusive: [], forbidden: ['browser'] },
  'required and forbidden natural tool aliases must compose',
)
assert.deepEqual(
  explicitTaskToolConstraintFromText('Do not use browser tools for this task.'),
  { required: [], exclusive: [], forbidden: ['browser'] },
  'a no-browser instruction must forbid browser actions',
)
assert.equal(
  explicitTaskToolConstraintFromText('You can use the terminal if it helps.'),
  null,
  'a non-exclusive terminal mention must preserve normal agent judgement',
)
assert.deepEqual(
  explicitTaskToolConstraintFromText("Don't only use the terminal; browse the supplied page."),
  { required: ['browser'], exclusive: [], forbidden: [] },
  'a release must clear terminal exclusivity while preserving a later browser instruction',
)
assert.equal(
  explicitTaskToolConstraintFromText('This is no longer terminal only.'),
  null,
  'an explicit release must clear the terminal-only interpretation',
)
assert.equal(
  explicitTaskToolConstraintFromText('Make this responsive and reliable in the browser.'),
  null,
  'incidental product/browser context must not become a required browser action',
)
assert.equal(
  explicitTaskToolConstraintFromText('Write a browser-compatible interface with browser support.'),
  null,
  'incidental with/in wording must not force a named tool',
)
const successfulToolState = { taskSuccessfulToolTypeCounts: new Map() }
trackSuccessfulToolExecution(successfulToolState, 'image_search')
assert.equal(
  successfulToolState.taskSuccessfulToolTypeCounts.get('image_search'),
  1,
  'successful accepted tool executions must have their own whole-task counter',
)
const terminalOnly = { required: ['terminal'], exclusive: ['terminal'], forbidden: [] }
const imageRequired = { required: ['image_search'], exclusive: [], forbidden: [] }
const noBrowser = { required: [], exclusive: [], forbidden: ['browser'] }
assert.equal(toolAllowedByExplicitTaskConstraint(terminalOnly, 'execute_command'), true)
assert.equal(toolAllowedByExplicitTaskConstraint(terminalOnly, 'web_search'), false)
assert.equal(toolAllowedByExplicitTaskConstraint(imageRequired, 'web_search'), true)
assert.equal(toolAllowedByExplicitTaskConstraint(noBrowser, 'browser_navigate'), false)
assert.equal(toolAllowedByExplicitTaskConstraint(noBrowser, 'web_search'), true)
assert.equal(
  taskDefaultsToMarkdownDeliverable(
    'Research one current fact about AI agent startup latency and answer in one sentence.',
  ),
  false,
  'an explicitly short inline research answer must not be misclassified as a saved Markdown report',
)
assert.equal(
  analyzeTaskIntent([
    {
      role: 'user',
      content: 'Find one current credible source explaining how AI models generate SVG code, then give a concise two-sentence summary.',
    },
  ]).explicitSavedArtifact,
  false,
  'a question about generated code must not become a code-file artifact request',
)
assert.equal(
  analyzeTaskIntent([
    {
      role: 'user',
      content: 'Write a report on DevRev AI very quickly.',
    },
  ]).requiresSavedArtifact,
  false,
  'an explicitly quick report without a requested file must remain an inline answer',
)
assert.equal(
  analyzeTaskIntent([
    {
      role: 'user',
      content: 'Write a TypeScript script that converts SVG paths to JSON.',
    },
  ]).explicitSavedArtifact,
  true,
  'an explicit request to write a script must remain an artifact request',
)

const [agentLoop, prompts, planManager, config, toolPipeline] = await Promise.all([
  readFile(fileURLToPath(new URL('../src/lib/agent/AgentLoop.ts', import.meta.url)), 'utf8'),
  readFile(fileURLToPath(new URL('../src/lib/prompts.ts', import.meta.url)), 'utf8'),
  readFile(fileURLToPath(new URL('../src/lib/agent/PlanManager.ts', import.meta.url)), 'utf8'),
  readFile(fileURLToPath(new URL('../src/lib/agent/config.ts', import.meta.url)), 'utf8'),
  readFile(fileURLToPath(new URL('../src/lib/agent/ToolPipeline.ts', import.meta.url)), 'utf8'),
])

assert.match(
  agentLoop,
  /pendingExplicitTaskToolTargets[\s\S]*taskSuccessfulToolTypeCounts[\s\S]*toolMatchesExplicitTaskToolTarget/,
  'runtime tool selection must keep a plain named tool required until its first successful accepted use',
)
assert.match(
  agentLoop,
  /permittedAvailableTools[\s\S]*toolAllowedByExplicitTaskConstraint[\s\S]*pendingExplicitTaskToolTargets[\s\S]*activeTools = permittedAvailableTools/,
  'runtime tool selection must apply required-once and persistent exclusive/forbidden filters',
)
assert.match(
  agentLoop,
  /USER TOOL INSTRUCTION BLOCKER:[\s\S]*Do not silently substitute another tool/,
  'an unavailable named tool must become a concrete blocker instead of a substitution',
)
assert.match(
  prompts,
  /explicit process, ordered checklist, and named-tool instructions are binding execution constraints/,
  'the runtime prompt must treat explicit process and tool restrictions as binding',
)
assert.match(
  prompts,
  /If the user explicitly requires terminal, HTTP extraction, or another named method, follow that method instead of opening the browser/,
  'the URL default must yield to the user’s explicit method',
)
assert.match(
  planManager,
  /Preserve explicit user-authored steps in their stated order/,
  'planner repair must retain the user-authored workflow order',
)
assert.match(
  planManager,
  /quickInlineAnswer[\s\S]*singleStepNeedsSavedArtifact[\s\S]*taskDefaultsToMarkdownDeliverable[\s\S]*isFirstStepDeliverable = resolvedPlan\.length === 1 && singleStepNeedsSavedArtifact/,
  'a one-step plan must only become a file-writing deliverable when the request actually needs a saved artifact',
)
assert.match(
  agentLoop,
  /function explicitSavedFinalArtifactRequested\(text: string\)[\s\S]*analyzeTaskIntent\(\[\{ role: 'user', content: text \}\]\)\.requiresSavedArtifact/,
  'the final-output decision must use the shared directive-aware intent classifier instead of a broad verb/object regex',
)
assert.match(
  config,
  /build:\s*\[[\s\S]*?'execute_command', 'run_code'/,
  'E2B command execution must be available to constrained build/runtime steps',
)
assert.match(
  toolPipeline,
  /toolAllowedByExplicitTaskConstraint\(explicitTaskToolConstraint, tc\.name\)[\s\S]*INTERNAL_RECOVERY:[\s\S]*explicit exclusive\/forbidden tool instruction/,
  'the executor must backstop exclusive or forbidden violations with a generic hidden error',
)
assert.match(
  toolPipeline,
  /const isError = isToolExecutionErrorResult\(tc\.name, result\)[\s\S]*if \(!isError\) trackSuccessfulToolExecution\(state, tc\.name\)/,
  'only non-error accepted results may satisfy a required-once named tool instruction',
)

console.log('Task instruction-adherence smoke checks passed.')
