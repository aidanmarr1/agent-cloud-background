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
const streamSource = await readFile(
  new URL('../src/lib/agent/StreamProcessor.ts', import.meta.url),
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
  /const rejectedModelEmission\s*=\s*truncatedFinalResponse\s*\|\|\s*rejectedCompactNarrationEmission\s*\|\|\s*rejectedHandoffEmission\s*\|\|\s*rejectedBuildTextOnlyEmission/,
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

assert.match(
  source,
  /FINAL_DELIVERABLE_HANDOFF_MAX_TOKENS = MODEL_MAX_COMPLETION_TOKENS/,
  'final handoffs must use the full model output allowance instead of a legacy summary-sized cap',
)
assert.match(
  source,
  /truncatedFinalResponse[\s\S]*finishReason === 'length'[\s\S]*textOverflowSuppressed[\s\S]*rejectedModelEmission[\s\S]*Retrying a provider-truncated final response/,
  'provider and local text truncation must be withheld and retried instead of persisted as completion',
)
assert.match(
  source,
  /MAX_TRUNCATED_FINAL_RESPONSE_REPAIR_ATTEMPTS = 2[\s\S]*truncatedFinalResponseRepairAttempts >=[\s\S]*Exhausted truncated final-response repairs/,
  'provider truncation repair must be bounded so a faulty provider cannot create an infinite task loop',
)
assert.ok(
  source.includes("if (/^(?:#{1,6}\\s+|[-+*]|\\d+[.)]?)$/.test(lastLine)) return false") &&
    source.includes("if ((text.match(/```/g) || []).length % 2 !== 0) return false"),
  'bare list markers and unclosed Markdown must not qualify as a completed handoff',
)
assert.match(
  streamSource,
  /finish_reason\?: string \| null[\s\S]*finishReason: string \| null[\s\S]*chunkFinishReason[\s\S]*finishReason,/,
  'the stream processor must retain the provider finish reason for completion validation',
)
assert.match(
  source,
  /allowLongAssistantText:[\s\S]*isFinalDeliveryStep\(state\)[\s\S]*isFinalDeliverableHandoffTurn[\s\S]*useTextFinalDeliverable/,
  'final delivery streams must bypass the generic non-action prose cap',
)
assert.match(
  source,
  /function shouldWithholdPreFinalInlineDraft\([\s\S]*currentStepIdx >= state\.currentPlanItems\.length - 1[\s\S]*isBriefInlineDirectAnswerTask[\s\S]*finalAssistantResponseEndsCleanly/,
  'a complete direct-chat draft from a pre-final plan phase must be recognized before it can duplicate the final response',
)
assert.match(
  modelEmissionBlock,
  /withheldPreFinalInlineDraft[\s\S]*streamProcessor\.discardBufferedEmission\(\)[\s\S]*Held back a pre-final inline deliverable draft[\s\S]*!withheldPreFinalInlineDraft/,
  'pre-final inline drafts must remain in model context without being released or counted as visible terminal prose',
)

console.log('final deliverable handoff smoke checks passed')
