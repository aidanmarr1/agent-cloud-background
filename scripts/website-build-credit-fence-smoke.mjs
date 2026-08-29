import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [agentLoop, streamProcessor] = await Promise.all([
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
])
const [agentState, completionAudit] = await Promise.all([
  readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/CompletionAudit.ts'), 'utf8'),
])

function sourceBlock(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

assert.match(
  agentLoop,
  /const INITIAL_STANDALONE_WEBSITE_MAX_TOKENS = 12_288/,
  'one-shot website generation must have enough output room for complete HTML, CSS, and JavaScript',
)
assert.match(
  agentLoop,
  /INITIAL WEBSITE BUILD REQUIRED:[\s\S]*at or below about 16,000 characters[\s\S]*Do not use data URIs, embedded base64, long SVG paths/,
  'the initial website prompt must bound source size without reducing the site to a scaffold',
)
assert.match(
  agentLoop,
  /function compactInitialStandaloneWebsiteMessages\([\s\S]*latestUserMessage[\s\S]*Active build task:[\s\S]*Design\/build brief:[\s\S]*Applicable custom instructions/,
  'the initial website turn must preserve the real request, attachment-bearing user message, active brief, and custom instructions',
)
assert.match(
  agentLoop,
  /let requestMessages = explicitTerminalNeedsInitialAction[\s\S]*standaloneWebsiteNeedsInitialCreate[\s\S]*compactInitialStandaloneWebsiteMessages\(state, allMessages, this\.options\.customInstructions\)/,
  'the first website call must replace the full orchestration history with the compact one-shot build context',
)
assert.match(
  agentLoop,
  /useCompactFinalDeliverableHandoff[\s\S]*compactFinalDeliverableHandoffMessages\(state, allMessages, this\.options\.customInstructions\)/,
  'the personalized handoff must not resend the generated website source to the model',
)
assert.match(
  agentLoop,
  /const INITIAL_STANDALONE_WEBSITE_ITERATION_TIMEOUT_MS = 180_000[\s\S]*const INITIAL_STANDALONE_WEBSITE_INACTIVITY_TIMEOUT_MS = 90_000[\s\S]*isInitialStandaloneWebsiteCreateTurn\(state\)[\s\S]*INITIAL_STANDALONE_WEBSITE_ITERATION_TIMEOUT_MS[\s\S]*INITIAL_STANDALONE_WEBSITE_INACTIVITY_TIMEOUT_MS/,
  'the initial large website envelope must tolerate a bounded provider assembly pause instead of buying another turn',
)
assert.match(
  agentLoop,
  /isInitialStandaloneWebsiteCreateTurn\(state\)[\s\S]*state\.timeoutNudgeCount < 1[\s\S]*WEBSITE GENERATION RETRY:[\s\S]*incomplete internal attempts were not charged/,
  'website stream stalls must get only one unbilled retry instead of entering generic timeout route resets',
)

const fastActionBlock = sourceBlock(
  agentLoop,
  'function isFastActionToolTurn(',
  'function isFastSourceActionToolTurn(',
)
assert.match(
  fastActionBlock,
  /if \(isInitialStandaloneWebsiteCreateTurn\(state\)\) return false/,
  'initial create_website must never inherit the 1k-token fast-action cap',
)

const modelRequestBlock = sourceBlock(
  agentLoop,
  'const useRequiredToolCall =',
  'const response = await createStreamingCompletion({',
)
assert.match(
  modelRequestBlock,
  /const useRequiredToolCall = \(standaloneWebsiteNeedsInitialCreate \|\| requiredToolIntent\)[\s\S]*\? 'required'/,
  'initial website generation must require a native action without hard-pinning one function',
)
assert.doesNotMatch(
  modelRequestBlock,
  /\{ type: 'function', function: \{ name: 'create_website' \} \}/,
  'initial website generation must preserve the model\'s access to the healthy tool set',
)
assert.match(
  modelRequestBlock,
  /standaloneWebsiteNeedsInitialCreate[\s\S]*INITIAL_STANDALONE_WEBSITE_MAX_TOKENS[\s\S]*fastActionTurn[\s\S]*FAST_ACTION_MAX_TOKENS/,
  'website output budgeting must be selected before the ordinary fast-action cap',
)

const billingBlock = sourceBlock(
  agentLoop,
  'const rejectedInitialWebsiteCreateEmission =',
  'if (lastStreamResult.cadenceProgressViolation) {',
)
assert.match(
  billingBlock,
  /const nonBillableInternalTurn[\s\S]*!nonBillableInternalTurn[\s\S]*chargeServerTokenUsage/,
  'rejected internal website turns must not debit user credits',
)
assert.match(
  billingBlock,
  /rejectedInitialWebsiteCreateEmission[\s\S]*!hasCompleteInitialStandaloneWebsiteCreateCall/,
  'text-only, missing, or malformed initial website actions must enter the unbilled rejection fence',
)

const noProgressBlock = sourceBlock(
  agentLoop,
  'const initialWebsiteActionRetryFenced =',
  "if (progressDecision.kind === 'allow_recovery') {",
)
assert.match(
  noProgressBlock,
  /isInitialStandaloneWebsiteCreateTurn\(state\)[\s\S]*consecutiveInternalRecoveryTurns >= 2[\s\S]*initial_website_action_retry_fenced[\s\S]*phase = 'ERROR'/,
  'invalid initial website actions must stop after two unbilled internal attempts',
)

assert.match(
  agentLoop,
  /successfulStandaloneWebsiteCreate[\s\S]*shouldDefaultFrontendToStandaloneHtml[\s\S]*standaloneWebsiteRequiresPostBuildAction[\s\S]*standaloneWebsiteHandoffReady = true[\s\S]*continueFinalPhaseAfterVerifiedArtifact\(state, finalPath, contextManager\)[\s\S]*keeping the model-authored final phase open/,
  'a complete default website must avoid mechanical verification loops while leaving the final phase under model control',
)
assert.match(
  agentState,
  /standaloneWebsiteHandoffReady: boolean[\s\S]*standaloneWebsiteHandoffReady: false/,
  'standalone website completion must be tracked explicitly instead of inferred from a failed preview process',
)
assert.doesNotMatch(
  completionAudit,
  /browser verification|visual verification|standaloneWebsiteHandoffReady/,
  'website completion must not depend on forced browser, visual, or localhost verification infrastructure',
)

assert.match(
  streamProcessor,
  /const WEBSITE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS = 180_000/,
  'a visible healthy website tool stream must have enough time to finish its full source bundle',
)
assert.match(
  streamProcessor,
  /isStreamingWebsiteArgs[\s\S]*WEBSITE_TOOL_ARGUMENT_INACTIVITY_TIMEOUT_MS[\s\S]*WEBSITE_TOOL_ARGUMENT_ITERATION_TIMEOUT_MS/,
  'website-specific stream timeouts must apply only after the create_website action begins',
)

console.log('website build credit fence smoke checks passed')
