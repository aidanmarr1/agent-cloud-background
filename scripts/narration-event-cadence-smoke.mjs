import assert from 'node:assert/strict'
import { auditPersistedNarrationCadence } from './lib/narration-event-audit.mjs'

function persisted(events) {
  return events.map((event, index) => ({
    seq: index + 1,
    event_json: JSON.stringify({ ...event, seq: index + 1, runId: 'narration-event-smoke' }),
  }))
}

function action(id, label) {
  return [
    { type: 'tool_start', id, name: 'web_search', args: { action_label: label } },
    { type: 'tool_result', id, name: 'web_search', result: [{ title: `${label} result` }] },
  ]
}

const onTime = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  { type: 'text_delta', content: 'I’ll gather current primary evidence before comparing it.' },
  ...action('a1', 'Search first primary source'),
  ...action('a2', 'Search second primary source'),
  ...action('a3', 'Search third primary source'),
  { type: 'text_delta', content: 'The first three sources agree that shorter action loops reduce user-visible latency.' },
  { type: 'credit_event', entry: { amount: -1 } },
  ...action('a4', 'Verify latency comparison'),
]))
assert.equal(onTime.ok, true, onTime.failures.join('\n'))
assert.equal(onTime.acceptedNarrations[0]?.gap, 3, 'normal narration must be accepted at action 3')
assert.equal(onTime.acceptedNarrations[0]?.continuesWithTool, true, 'narration must share the normal tool action turn')

const retryAtFour = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  ...action('b1', 'Search first benchmark'),
  ...action('b2', 'Search second benchmark'),
  ...action('b3', 'Search third benchmark'),
  ...action('b4', 'Search retry benchmark'),
  { type: 'text_delta', content: 'Four independent benchmarks now show that tool handoff overhead dominates short agent tasks.' },
  ...action('b5', 'Verify benchmark methodology'),
]))
assert.equal(retryAtFour.ok, true, retryAtFour.failures.join('\n'))
assert.equal(retryAtFour.acceptedNarrations[0]?.gap, 4, 'a missed action-3 update must get exactly one action-4 retry')
assert.ok(
  retryAtFour.acceptedActions[3]?.startSeq < retryAtFour.acceptedNarrations[0]?.startSeq,
  'missing action-3 narration must not gate the fourth tool start',
)

const asynchronousProgressUpdate = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  ...action('async-a1', 'Search first current source'),
  ...action('async-a2', 'Search second current source'),
  ...action('async-a3', 'Search third current source'),
  ...action('async-a4', 'Open the strongest current source'),
  {
    type: 'progress_update',
    content: 'The first three current sources agree that orchestration overhead dominates short agent tasks.',
    afterToolId: 'async-a3',
    remainingVisibleActions: 1,
    stepIndex: 0,
  },
]))
assert.equal(asynchronousProgressUpdate.ok, true, asynchronousProgressUpdate.failures.join('\n'))
assert.equal(asynchronousProgressUpdate.acceptedNarrations[0]?.gap, 3)
assert.equal(
  asynchronousProgressUpdate.acceptedNarrations[0]?.continuesWithTool,
  true,
  'a late asynchronous progress event must retain the captured action-3 placement instead of being treated as missing narration',
)
assert.equal(asynchronousProgressUpdate.acceptedNarrations[0]?.nextToolName, 'web_search')

const duplicateThenRetry = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  ...action('c1', 'Search first source set'),
  ...action('c2', 'Search second source set'),
  ...action('c3', 'Search third source set'),
  { type: 'text_delta', content: 'Three sources identify orchestration overhead as the main latency bottleneck.' },
  ...action('c4', 'Open first detailed source'),
  ...action('c5', 'Open second detailed source'),
  ...action('c6', 'Open third detailed source'),
  { type: 'text_delta', content: 'Three sources identify orchestration overhead as the main latency bottleneck.' },
  ...action('c7', 'Verify duplicate narration recovery'),
  { type: 'text_delta', content: 'The detailed evidence adds that deterministic routing removes repeated model-selection delays.' },
  ...action('c8', 'Compare deterministic routing'),
]))
assert.equal(duplicateThenRetry.uniqueOk, false, 'persisted duplicate narration must be detected')
assert.equal(duplicateThenRetry.duplicateAttemptCount, 1)
assert.equal(duplicateThenRetry.narrationAttempts.at(-1)?.gap, 4, 'duplicate action-3 narration must leave the action-4 retry open')
assert.ok(
  duplicateThenRetry.acceptedActions[6]?.startSeq < duplicateThenRetry.narrationAttempts.at(-1)?.startSeq,
  'duplicate narration must not gate the retry action',
)

const narrationOnly = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  ...action('d1', 'Search one source'),
  ...action('d2', 'Search another source'),
  ...action('d3', 'Search final source'),
  { type: 'text_delta', content: 'The evidence is sufficient to compare the three approaches.' },
  { type: 'done' },
]))
assert.equal(narrationOnly.toolProgressOk, false, 'a narration-only turn must fail the no-gating audit')
assert.match(narrationOnly.failures.join('\n'), /did not continue into an accepted tool start/)

const terminalSynthesis = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Gather primary evidence', 'Synthesize the final answer'] },
  ...action('terminal-a1', 'Open first official source'),
  ...action('terminal-a2', 'Open second official source'),
  { type: 'step_advance', status: 'done' },
  ...action('terminal-a3', 'Open third official source'),
  ...action('terminal-a4', 'Compare official findings'),
  { type: 'text_delta', content: 'The official evidence now supports the final comparison, including the key latency and throughput differences.' },
  { type: 'step_advance', status: 'done' },
  { type: 'done' },
]))
assert.equal(terminalSynthesis.ok, true, terminalSynthesis.failures.join('\n'))
assert.equal(terminalSynthesis.acceptedNarrations[0]?.continuesWithTool, false)
assert.equal(
  terminalSynthesis.acceptedNarrations[0]?.verifiedTerminalSynthesis,
  true,
  'action-4 final synthesis must count only after the persisted plan is conclusively completed',
)

const terminalSynthesisMissingFinalAdvance = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Synthesize the final answer'] },
  ...action('missing-a1', 'Open first official source'),
  ...action('missing-a2', 'Open second official source'),
  ...action('missing-a3', 'Open third official source'),
  ...action('missing-a4', 'Compare official findings'),
  { type: 'text_delta', content: 'The evidence appears ready for the final answer, but the persisted plan has not been completed.' },
  { type: 'done' },
]))
assert.equal(terminalSynthesisMissingFinalAdvance.ok, false, 'done without the final plan advance must remain a premature narration-only termination')
assert.equal(terminalSynthesisMissingFinalAdvance.acceptedNarrations[0]?.verifiedTerminalSynthesis, false)

const terminalSynthesisIncompleteAdvance = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Synthesize the final answer'] },
  ...action('incomplete-a1', 'Open first official source'),
  ...action('incomplete-a2', 'Open second official source'),
  ...action('incomplete-a3', 'Open third official source'),
  { type: 'text_delta', content: 'The evidence is assembled, but the persisted plan explicitly remains incomplete.' },
  { type: 'step_advance', status: 'incomplete', reason: 'Final synthesis did not pass completion audit.' },
  { type: 'done' },
]))
assert.equal(terminalSynthesisIncompleteAdvance.ok, false, 'an incomplete final advance must never verify terminal synthesis')
assert.equal(terminalSynthesisIncompleteAdvance.acceptedNarrations[0]?.verifiedTerminalSynthesis, false)

const terminalSynthesisError = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Synthesize the final answer'] },
  ...action('error-a1', 'Open first official source'),
  ...action('error-a2', 'Open second official source'),
  ...action('error-a3', 'Open third official source'),
  { type: 'text_delta', content: 'The evidence is assembled, but the task then fails instead of completing successfully.' },
  { type: 'step_advance', status: 'done' },
  { type: 'error', message: 'Final response persistence failed.' },
]))
assert.equal(terminalSynthesisError.ok, false, 'an error terminal must never qualify as terminal synthesis')
assert.equal(terminalSynthesisError.acceptedNarrations[0]?.verifiedTerminalSynthesis, false)

const terminalSynthesisNotLastText = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Synthesize the final answer'] },
  ...action('later-text-a1', 'Open first official source'),
  ...action('later-text-a2', 'Open second official source'),
  ...action('later-text-a3', 'Open third official source'),
  { type: 'text_delta', content: 'The evidence supports a concise final comparison across all three official sources.' },
  { type: 'step_advance', status: 'done' },
  { type: 'text_delta', content: 'A later substantive text run means the cadence candidate was not the terminal synthesis.' },
  { type: 'done' },
]))
assert.equal(terminalSynthesisNotLastText.ok, false, 'only the last substantive text run may verify as terminal synthesis')
assert.equal(terminalSynthesisNotLastText.acceptedNarrations[0]?.verifiedTerminalSynthesis, false)

const terminalSynthesisWithoutText = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Synthesize the final answer'] },
  ...action('silent-a1', 'Open first official source'),
  ...action('silent-a2', 'Open second official source'),
  ...action('silent-a3', 'Open third official source'),
  ...action('silent-a4', 'Compare official findings'),
  { type: 'step_advance', status: 'done' },
  { type: 'done' },
]))
assert.equal(terminalSynthesisWithoutText.ok, false, 'plan completion without cadence text must still fail the action-4 cadence boundary')
assert.match(terminalSynthesisWithoutText.failures.join('\n'), /without narration/)

const blockedProvisional = auditPersistedNarrationCadence(persisted([
  { type: 'plan', items: ['Research sources'] },
  ...action('e1', 'Search valid source one'),
  ...action('e2', 'Search valid source two'),
  { type: 'tool_start', id: 'blocked', name: 'web_search', args: { action_label: 'Repeat blocked search' } },
  { type: 'tool_result', id: 'blocked', name: 'web_search', result: { error: 'INTERNAL_RECOVERY: duplicate search was skipped.' } },
  ...action('e3', 'Search valid source three'),
  { type: 'text_delta', content: 'Three accepted searches produced distinct evidence despite one preflight rejection.' },
  ...action('e4', 'Verify accepted evidence only'),
]))
assert.equal(blockedProvisional.ok, true, blockedProvisional.failures.join('\n'))
assert.equal(blockedProvisional.acceptedNarrations[0]?.gap, 3, 'preflight-rejected provisional starts must not consume cadence')

console.log('persisted SSE narration cadence smoke checks passed')
