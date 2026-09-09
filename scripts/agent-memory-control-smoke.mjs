import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const dir = await mkdtemp(join(root, 'scripts/.memory-control-smoke-'))
try {
  const entry = join(dir, 'test.ts'), bundle = join(dir, 'test.mjs')
  await writeFile(entry, `
import assert from 'node:assert/strict'
import { WorkingMemory } from ${JSON.stringify(join(root, 'src/lib/agent/WorkingMemory.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { captureTaskCheckpoint, parseTaskCheckpoint, restoreTaskCheckpoint, reconcileTaskCheckpoint } from ${JSON.stringify(join(root, 'src/lib/agent/TaskCheckpoint.ts'))}
import { classifyFailure, retryDecision, waitForRetry, requestTimeoutWithinDeadline, canReopenCompletion, finalOutputRetryDecision } from ${JSON.stringify(join(root, 'src/lib/agent/ExecutionControl.ts'))}
import { ToolRetry } from ${JSON.stringify(join(root, 'src/lib/agent/ToolRetry.ts'))}
import { ErrorRecoveryEngine } from ${JSON.stringify(join(root, 'src/lib/agent/recovery/ErrorRecoveryEngine.ts'))}

const memory = new WorkingMemory('What is the maximum battery range of the Aurora bus?')
const relevant = 'The Aurora bus maximum battery range is 450 km under standard testing conditions.'
memory.extractFromBrowse('https://transport.example/specification',
  Array.from({length: 20}, (_, i) => 'Our company has a long history of innovation and customer service number ' + i + '.').join(' ') + ' ' + relevant,
  0, { publishedAt: '2026-08-01', observedAt: Date.parse('2026-09-09') })
assert.ok(memory.snapshot().facts.some(f => f.text === relevant), 'retain relevant evidence from late in the page')
assert.ok(!memory.snapshot().facts.some(f => /company/.test(f.text)), 'irrelevant introductory prose must not displace evidence')
assert.match(memory.render({maxChars: 2000})!, /published 2026-08-01; observed 2026-09-09/)

memory.extractFromBrowse('https://transport.example/specification', relevant, 0)
assert.equal(memory.snapshot().facts[0].corroborationCount, 1, 'cached/same-host reads cannot manufacture corroboration')
memory.extractFromBrowse('https://review.example/test', relevant, 0)
assert.equal(memory.snapshot().facts[0].corroborationCount, 2)
assert.ok(memory.snapshot().facts[0].sources.some(s => s.url === 'https://review.example/test'), 'keep corroborating citations')
const contradiction = 'The Aurora bus maximum battery range is 320 km under standard testing conditions.'
memory.extractFromBrowse('https://lab.example/test', contradiction, 1, { publishedAt: '2026-09-01' })
assert.equal(memory.size().facts, 2, 'conflicting quantities must not be merged as corroboration')
assert.match(memory.render({maxChars: 2400})!, /Possible conflict/)
assert.match(memory.render({maxChars: 2400})!, /320 km/)
assert.match(memory.render({maxChars: 2400})!, /450 km/)
const shortMemory = memory.render({maxChars: 250})!
assert.ok(shortMemory.length <= 250)
assert.ok(!shortMemory.includes('320 km') && !shortMemory.includes('450 km'), 'omit the whole conflicting pair when its citations cannot fit')

const negation = new WorkingMemory('Is the Aurora bus charging adapter available?')
negation.extractFromBrowse('https://vendor.example/info', 'The Aurora bus charging adapter is available for purchase.', 0)
negation.extractFromBrowse('https://news.example/info', 'The Aurora bus charging adapter is not available for purchase.', 0)
assert.equal(negation.detectContradictions('The Aurora bus charging adapter is available for purchase.').length, 1)
assert.equal(negation.size().facts, 2)
const spoof = new WorkingMemory('Aurora bus battery range')
spoof.extractFromBrowse('https://nature.com.evil.example/gov.org', relevant, 0)
assert.notEqual(spoof.snapshot().facts[0].confidence, 'high', 'trusted hostname matches must respect domain boundaries')
const search = new WorkingMemory('Aurora bus battery range')
search.extractFromSearch('Aurora bus battery range', [
  {url:'https://first.example', snippet:'The company offers customer support around the world.'},
  {url:'https://second.example', snippet:relevant, publishedDate:'2026-09-03'},
], 0)
assert.equal(search.snapshot().facts[0].text, relevant)
assert.equal(search.snapshot().facts[0].sources[0].publishedAt, '2026-09-03')
assert.equal(search.snapshot().facts[1].sources[0].publishedAt, undefined)

const timeouts = { iterationTimeoutMs: 30000, inactivityTimeoutMs: 30000, contentOnlyTimeoutMs: null, contentOnlyMinChars: 0, checkIntervalMs: 20 }
const state = createInitialState(false, timeouts)
state.originalUserRequest = 'What is the maximum battery range of the Aurora bus?'
state.currentPlanItems = ['Research range', 'Write report', 'Verify report']
state.currentPlanScopes = [null, null, null]
state.currentStepIdx = 1
state.stepCompletionTimes = [6]
state.iterations = 7
state.dynamicIterationLimit = 30
state.createdFiles.add('notes.md')
state.stepFindings.set(0, 'Compared range claims from two dated sources')
state.workLedger.remainingRequirements = ['Save report', 'Verify report']
state.stepResearchCallCount = 3
state.stepSearchQueries.add('Aurora bus range')
const checkpoint = captureTaskCheckpoint(state, memory)!
assert.ok(checkpoint)
assert.ok(parseTaskCheckpoint(JSON.stringify(checkpoint)))
assert.equal(parseTaskCheckpoint('{broken'), null)
assert.equal(parseTaskCheckpoint({...checkpoint, version: 2}), null)
assert.equal(parseTaskCheckpoint({...checkpoint, currentStepIdx: 88}), null)
const restored = createInitialState(false, timeouts)
restored.originalUserRequest = state.originalUserRequest
const restoredMemory = new WorkingMemory(state.originalUserRequest)
restoreTaskCheckpoint(restored, restoredMemory, checkpoint)
assert.deepEqual(restored.stepCompletionTimes, [6], 'completed phase history must prevent a false jump back to step zero')
assert.equal(restored.currentStepIdx, 1, 'resume the active step without restarting the plan')
assert.equal(restored.planItems, null, 'the restored plan must not trigger a reset to step zero')
assert.equal(restored.iterations, 7, 'restarts cannot reset the action budget')
assert.ok(restored.createdFiles.has('notes.md'))
assert.deepEqual(restored.workLedger.remainingRequirements, ['Save report', 'Verify report'])
assert.match(restoredMemory.render({maxChars:2400})!, /Possible conflict/)
assert.equal(restored.deliverableVerificationDone, false, 'historical files are not fresh verification')
assert.equal(restored.browserTaskCompleted, false, 'never restore a live browser completion claim')

const tail = reconcileTaskCheckpoint(checkpoint, [
 {type:'tool_result', id:'save', name:'create_file', result:{action:'created', path:'report.md', size:100}},
 {type:'tool_result', id:'failed', name:'create_file', result:{error:'disk full', path:'missing.md'}},
 {type:'step_advance', status:'done'},
])
assert.equal(tail.currentStepIdx, 2, 'reconcile a phase completed just before the crash')
assert.ok(tail.sets.createdFiles.includes('report.md'))
assert.ok(!tail.sets.createdFiles.includes('missing.md'))
assert.ok(tail.workLog.some(line => line.startsWith('Failed create_file: missing.md')))
assert.equal(tail.counts.stepResearchCallCount, 0)
assert.deepEqual(tail.sets.stepSearchQueries, [])
assert.equal(checkpoint.currentStepIdx, 1, 'reconciliation must not mutate the persisted input')

const policy = {maxRetries:2, baseDelayMs:500, maxDelayMs:1000}
assert.equal(classifyFailure(Object.assign(new Error('network timeout'), {status:401})), 'permanent')
assert.equal(classifyFailure(new Error('model expired, request timeout')), 'permanent')
assert.equal(classifyFailure(new TypeError('Cannot read properties of undefined')), 'unknown')
assert.equal(retryDecision(new Error('network timeout'), 0, policy, {sideEffects:true}).retry, false)
assert.equal(retryDecision(new Error('network timeout'), 2, policy).retry, false)
assert.equal(retryDecision(new Error('network timeout'), 1, policy, {random:1}).delayMs, 1000, 'jitter cannot exceed cap')
assert.equal(retryDecision(new Error('network timeout'), 0, policy, {now:1000, deadlineAtMs:1600}).retry, false)
const limited = Object.assign(new Error('rate limit'), {status:429, headers:{'retry-after':'3'}})
assert.equal(retryDecision(limited, 0, policy).delayMs, 3000, 'never shorten server retry-after')
assert.equal(retryDecision(limited, 0, policy, {now:1000, deadlineAtMs:2000}).retry, false)
const abort = new AbortController(); abort.abort()
await assert.rejects(waitForRetry(5000, abort.signal), {name:'AbortError'})
const midWait = new AbortController()
const waiting = waitForRetry(5000, midWait.signal); midWait.abort()
await assert.rejects(waiting, {name:'AbortError'})
assert.equal(requestTimeoutWithinDeadline(10000, 5000, 1000), 3850)
assert.throws(() => requestTimeoutWithinDeadline(10000, 1100, 1000), /deadline/)
for (const target of ['website','inline_answer','live_directive'] as const) assert.equal(canReopenCompletion('runtime_deadline', target), false)
assert.equal(canReopenCompletion('iteration_cap', 'website'), false)
assert.equal(canReopenCompletion('iteration_cap', 'live_directive'), true)
assert.equal(finalOutputRetryDecision(2, 2, false), 'error', 'unverified saved outputs cannot complete a timeout path')
assert.equal(finalOutputRetryDecision(2, 2, true), 'complete')
assert.equal(finalOutputRetryDecision(0, 2, false), 'retry')
let calls = 0
await assert.rejects(new ToolRetry().execute('http_request', async () => {calls++; throw new Error('network timeout')}, undefined, {method:'POST'}))
assert.equal(calls, 1, 'mutating requests are never automatically retried')
assert.equal(new ToolRetry().shouldRetryResult('web_search', {error:'network timeout'}), false, 'returned failures share the configured zero-retry budget')
const recovery = new ErrorRecoveryEngine()
assert.equal(recovery.diagnose({toolName:'http_request', args:{method:'POST'}, error:'401 network timeout'}).isTransient, false)
assert.notEqual(recovery.selectStrategy(recovery.diagnose({toolName:'create_file', error:'network timeout'}),
 {remainingBudget:30,totalFailures:1,consecutiveFailures:1,availableTools:[]}).type, 'retry_with_backoff')
console.log('research memory, checkpoint reconciliation, and execution control checks passed')
`)
  await build({entryPoints:[entry], outfile:bundle, bundle:true, platform:'node', format:'esm', target:['node22'], logLevel:'silent'})
  await import(pathToFileURL(bundle).href)
} finally { await rm(dir, {recursive:true, force:true}) }
console.log('agent memory/control smoke passed')
