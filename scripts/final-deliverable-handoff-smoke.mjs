import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/lib/agent/AgentLoop.ts', import.meta.url),
  'utf8',
)
const policySource = await readFile(
  new URL('../src/lib/agent/PolicyEngine.ts', import.meta.url),
  'utf8',
)

function sourceBlock(start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

const verifiedOutcomeBlock = sourceBlock(
  'function continueFinalPhaseAfterVerifiedArtifact(',
  'function finalInlineAnswerPrompt(',
)
assert.match(
  verifiedOutcomeBlock,
  /already saved[\s\S]*Do not re-read it or run generic verification commands[\s\S]*one completed outcome[\s\S]*anything explicitly requested remains[\s\S]*natural handoff is the completion decision/,
  'a verified artifact must keep genuinely remaining outcomes open without inviting redundant verification loops',
)

assert.match(
  source,
  /function verifiedFinalPhaseNaturalHandoffPath\([\s\S]*LLM-authored completion decision[\s\S]*completionCue[\s\S]*const naturalVerifiedHandoffPath[\s\S]*!processedCompactNarrationTurn[\s\S]*Natural verified-phase handoff accepted[\s\S]*terminalReason = 'deliverable_handoff_complete'/,
  'a natural LLM-authored handoff after a verified saved artifact must complete the phase without requiring an internal marker or another tool loop',
)

const promptInjectionCount = (
  source.match(/content:\s*finalDeliverableHandoffPrompt\(state\)/g) || []
).length
assert.equal(
  promptInjectionCount,
  1,
  'each handoff request must receive exactly one canonical handoff instruction',
)

const modelEmissionBlock = sourceBlock(
  'const pendingHandoffText =',
  'if (lastStreamResult.cadenceProgressViolation) {',
)
assert.match(
  modelEmissionBlock,
  /const rejectedModelEmission\s*=\s*rejectedCompactNarrationEmission\s*\|\|\s*rejectedHandoffEmission\s*\|\|\s*rejectedBuildTextOnlyEmission/,
  'narration, handoff, and build-text drift rejection must share one model-emission fence',
)
assert.match(
  modelEmissionBlock,
  /const nonBillableInternalTurn[\s\S]*lastStreamResult\.cadenceProgressViolation[\s\S]*rejectedModelEmission[\s\S]*streamProcessor\.discardBufferedEmission\(\)/,
  'every rejected model emission must be discarded before buffered text reaches the client',
)
assert.match(
  modelEmissionBlock,
  /visibleText:[\s\S]*!rejectedModelEmission[\s\S]*nonBillableInternalTurn[\s\S]*internalRecoveryScheduled: 'display_contract'/,
  'every withheld model emission must be recorded as an intentional display recovery',
)

const autosaveCompletionBlock = sourceBlock(
  'state.deliverableVerificationDone = true\n      state.pendingDeliverableRevision = null',
  'const stepIdxBefore = state.currentStepIdx',
)
assert.match(
  autosaveCompletionBlock,
  /continueFinalPhaseAfterVerifiedArtifact\(state, path, contextManager\)[\s\S]*return 'STREAMING'/,
  'a verified text-only autosave must return control to the active phase',
)
assert.doesNotMatch(
  autosaveCompletionBlock,
  /state\.currentStepIdx = state\.currentPlanItems\.length|return 'COMPLETE'/,
  'a verified text-only autosave must not complete before its handoff',
)

assert.match(
  policySource,
  /advanceStep\(state, `Saved and verified final deliverable:[\s\S]*state\.finalDeliverableHandoffPending[\s\S]*continueLoop: true/,
  'the personalized handoff must be scheduled only after the model explicitly completes the whole phase',
)

const timeoutHandoffBlock = sourceBlock(
  '// Nudgeable timeout',
  'if (finalInlineAnswerTurn(state, this.options.messages)) {',
)
assert.match(
  timeoutHandoffBlock,
  /shouldAcceptFinalDeliverableHandoff[\s\S]*this\.emitter\.textDelta\(partialContent\)[\s\S]*return 'COMPLETE'/,
  'an accepted timeout partial must be emitted before task completion',
)

console.log('final deliverable handoff smoke checks passed')
