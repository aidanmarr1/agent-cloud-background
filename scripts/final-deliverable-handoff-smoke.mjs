import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/lib/agent/AgentLoop.ts', import.meta.url),
  'utf8',
)

function sourceBlock(start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

const scheduleBlock = sourceBlock(
  'function scheduleFinalDeliverableHandoff(',
  'function finalInlineAnswerPrompt(',
)
assert.doesNotMatch(
  scheduleBlock,
  /contextManager\.push|finalDeliverableHandoffPrompt\(state\)/,
  'scheduling must not persist a duplicate handoff instruction in shared context',
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
  /const rejectedModelEmission\s*=\s*rejectedHandoffEmission\s*\|\|\s*rejectedBuildTextOnlyEmission/,
  'handoff and build-text drift rejection must share one model-emission fence',
)
assert.match(
  modelEmissionBlock,
  /lastStreamResult\.cadenceProgressViolation \|\| rejectedModelEmission[\s\S]*streamProcessor\.discardBufferedEmission\(\)/,
  'every rejected model emission must be discarded before buffered text reaches the client',
)
assert.match(
  modelEmissionBlock,
  /visibleText:[\s\S]*!rejectedModelEmission[\s\S]*lastStreamResult\.cadenceProgressViolation \|\| rejectedModelEmission[\s\S]*internalRecoveryScheduled: 'display_contract'/,
  'every withheld model emission must be recorded as an intentional display recovery',
)

const autosaveCompletionBlock = sourceBlock(
  'state.deliverableVerificationDone = true\n      state.pendingDeliverableRevision = null',
  'const stepIdxBefore = state.currentStepIdx',
)
assert.match(
  autosaveCompletionBlock,
  /scheduleFinalDeliverableHandoff\(state, path, 'file'\)[\s\S]*return 'STREAMING'/,
  'a verified text-only autosave must reserve a personalized handoff turn',
)
assert.doesNotMatch(
  autosaveCompletionBlock,
  /state\.currentStepIdx = state\.currentPlanItems\.length|return 'COMPLETE'/,
  'a verified text-only autosave must not complete before its handoff',
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
