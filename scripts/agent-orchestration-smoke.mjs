#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))

// This smoke is intentionally local-only. The source assertions below cover the
// durable path while the runtime checks exercise queue scoping and event invariants
// without touching a developer or production database.
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
delete process.env.AGENT_TASK_WORKER_MODE
process.env.AGENT_TASK_QUEUE_NAME = `orchestration-smoke-${Date.now()}`

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const {
  clearLiveDirectivesForTest,
  drainLiveDirectives,
  enqueueLiveDirective,
  getLiveDirectiveReceipt,
  getLiveDirectiveQueueLength,
  openLiveDirectiveRun,
} = await jiti.import(fileURLToPath(new URL('../src/lib/liveDirectives.ts', import.meta.url)))
const {
  clearTaskJobsForTest,
  createTaskJobEventStream,
  startTaskJob,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)))
const { parseSSE } = await jiti.import(fileURLToPath(new URL('../src/lib/stream.ts', import.meta.url)))
const { parseSSEStream, SSEParseError } = await jiti.import(fileURLToPath(new URL('../src/stream/client/SSEParser.ts', import.meta.url)))
const { classifyStreamSequence } = await jiti.import(fileURLToPath(new URL('../src/stream/client/streamSequence.ts', import.meta.url)))

async function readAllEvents(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\n\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const event = parseSSE(block)
      if (event) events.push(event)
    }
  }
  return events
}

await clearLiveDirectivesForTest()

const conversationId = 'orchestration-smoke-task'
const userId = 'orchestration-smoke-user'
const currentRunId = 'orchestration-smoke-current'
const oldRunId = 'orchestration-smoke-old'

await enqueueLiveDirective(conversationId, 'old run direction', userId, oldRunId)
for (let index = 0; index < 12; index += 1) {
  await enqueueLiveDirective(
    conversationId,
    `direction ${index}`,
    userId,
    currentRunId,
    `orchestration-smoke-directive-${index}`,
  )
}
await assert.rejects(
  enqueueLiveDirective(
    conversationId,
    'direction 12',
    userId,
    currentRunId,
    'orchestration-smoke-directive-overflow',
  ),
  (error) => error?.code === 'LIVE_DIRECTIVE_QUEUE_FULL',
  'a full queue must reject a new instruction instead of deleting one already acknowledged',
)
const idempotentRetry = await enqueueLiveDirective(
  conversationId,
  'direction 0',
  userId,
  currentRunId,
  'orchestration-smoke-directive-0',
)
assert.equal(idempotentRetry.id, 'orchestration-smoke-directive-0', 'a retry must recover the original directive receipt')

assert.equal(
  await getLiveDirectiveQueueLength(conversationId, userId, currentRunId),
  12,
  'a run-scoped directive queue must enforce its bounded capacity',
)
assert.deepEqual(
  await drainLiveDirectives(conversationId, userId, 'orchestration-smoke-wrong-run'),
  [],
  'a different run must not consume directions from the active run',
)

const drained = await drainLiveDirectives(conversationId, userId, currentRunId)
assert.deepEqual(
  drained.map((directive) => directive.content),
  Array.from({ length: 12 }, (_, index) => `direction ${index}`),
  'the queue must retain every acknowledged instruction in chronological order',
)
assert.deepEqual(
  await drainLiveDirectives(conversationId, userId, currentRunId),
  [],
  'a drained directive must not be delivered twice',
)
assert.equal(
  (await getLiveDirectiveReceipt('orchestration-smoke-directive-0', userId, conversationId))?.status,
  'delivered',
  'a drained directive must retain a recoverable delivered outcome after leaving the queue',
)
await drainLiveDirectives(conversationId, userId, currentRunId, 1, { sealWhenEmpty: true })
await assert.rejects(
  enqueueLiveDirective(conversationId, 'too late', userId, currentRunId),
  (error) => error?.code === 'NO_ACTIVE_TASK_FOR_DIRECTIVE',
  'an atomically sealed run must reject directions accepted after its final drain',
)
await openLiveDirectiveRun(conversationId, userId, currentRunId, 1)
await enqueueLiveDirective(conversationId, 'reopened direction', userId, currentRunId)
assert.deepEqual(
  (await drainLiveDirectives(conversationId, userId, currentRunId, 1)).map((directive) => directive.content),
  ['reopened direction'],
  'a retry/current owner must be able to reopen directive acceptance',
)
assert.deepEqual(
  (await drainLiveDirectives(conversationId, userId, oldRunId)).map((directive) => directive.content),
  ['old run direction'],
  'draining one run must not erase another run\'s directions',
)

const eventRunId = 'orchestration-smoke-events'
await startTaskJob({
  runId: eventRunId,
  userId,
  conversationId,
  runner: async (emitter) => {
    emitter.textDelta('Hello')
    emitter.textDelta(' ')
    emitter.textDelta('world')
    emitter.done()
    emitter.textDelta(' this must be ignored')
    emitter.done()
  },
})

const events = await readAllEvents(createTaskJobEventStream({
  userId,
  conversationId,
  runId: eventRunId,
  afterSeq: 0,
}))
assert.equal(
  events.filter((event) => event.type === 'text_delta').map((event) => event.content).join(''),
  'Hello world',
  'whitespace-only chunks must survive the event stream without post-terminal text',
)
assert.equal(events.filter((event) => event.type === 'done').length, 1, 'a task must emit exactly one terminal event')

let finishFirstTask
const firstTaskFinished = new Promise((resolve) => {
  finishFirstTask = resolve
})
await startTaskJob({
  runId: 'orchestration-smoke-concurrency-one',
  userId,
  conversationId: 'orchestration-smoke-concurrency-task',
  runner: async (emitter) => {
    await firstTaskFinished
    emitter.done()
  },
})
await assert.rejects(
  startTaskJob({
    runId: 'orchestration-smoke-concurrency-two',
    userId,
    conversationId: 'orchestration-smoke-concurrency-task',
    runner: async (emitter) => emitter.done(),
  }),
  /already running/i,
  'two runs for the same user task must not execute concurrently',
)
finishFirstTask()
await new Promise((resolve) => setTimeout(resolve, 0))

assert.deepEqual(
  classifyStreamSequence({ type: 'text_delta', content: 'one', seq: 1, runId: eventRunId }, eventRunId, 0),
  { kind: 'dispatch', seq: 1 },
  'the first durable client event must dispatch at the expected cursor',
)
assert.deepEqual(
  classifyStreamSequence({ type: 'text_delta', content: 'duplicate', seq: 1, runId: eventRunId }, eventRunId, 1),
  { kind: 'ignore' },
  'a duplicate durable client event must be ignored',
)
assert.deepEqual(
  classifyStreamSequence({ type: 'text_delta', content: 'gap', seq: 3, runId: eventRunId }, eventRunId, 1),
  { kind: 'reconnect', expectedSeq: 2, receivedSeq: 3 },
  'a sequence gap must reconnect from the last contiguous cursor',
)
assert.deepEqual(
  classifyStreamSequence({ type: 'heartbeat', timestamp: Date.now(), runId: eventRunId }, eventRunId, 1),
  { kind: 'ignore' },
  'an unsequenced keep-alive heartbeat must not move the durable cursor',
)
assert.deepEqual(
  classifyStreamSequence({ type: 'browser_frame', frame: 'frame', timestamp: Date.now(), runId: eventRunId }, eventRunId, 1),
  { kind: 'dispatch', seq: null },
  'a latest-only browser frame must render without moving the durable cursor',
)

const malformedSSE = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {not-json}\n\n'))
    controller.close()
  },
})
await assert.rejects(
  async () => {
    for await (const _event of parseSSEStream(malformedSSE.getReader())) {
      void _event
    }
  },
  (error) => error instanceof SSEParseError,
  'malformed SSE data must force replay instead of being silently skipped',
)

const liveDirectiveSource = await readFile(new URL('../src/lib/liveDirectives.ts', import.meta.url), 'utf8')
const taskJobSource = await readFile(new URL('../src/lib/agent/taskJobs.ts', import.meta.url), 'utf8')
const clientStreamSource = await readFile(new URL('../src/stream/client/useAgentStream.ts', import.meta.url), 'utf8')
const serverSyncSource = await readFile(new URL('../src/store/chat/serverSync.ts', import.meta.url), 'utf8')
const chatPageSource = await readFile(new URL('../src/app/chat/[id]/page.tsx', import.meta.url), 'utf8')
assert.match(liveDirectiveSource, /create table if not exists agent_live_directives/, 'directives must have durable storage')
assert.match(liveDirectiveSource, /create table if not exists agent_live_directive_seals/, 'final directive acceptance must have a durable cutoff')
assert.match(liveDirectiveSource, /tursoTransaction\('write'/, 'directive drains must use a write transaction')
assert.match(liveDirectiveSource, /queue_name = \? and user_id = \? and conversation_id = \? and run_id = \?/, 'durable directives must be queue/user/task/run scoped')
assert.match(liveDirectiveSource, /claimed_attempt is null or claimed_attempt < \?/, 'a replacement worker attempt must be able to reclaim unacknowledged directions')
assert.match(liveDirectiveSource, /terminal_status is null and cancel_requested = 0[\s\S]*status = 'running' and attempts = \?/, 'directive drains must be fenced to the current running claim attempt')
assert.match(liveDirectiveSource, /LiveDirectiveQueueFullError/, 'a full directive queue must reject instead of evicting acknowledged work')
assert.match(liveDirectiveSource, /agent_live_directive_receipts/, 'idempotency and post-cleanup outcomes must have durable receipts')
assert.doesNotMatch(liveDirectiveSource, /limit -1 offset \?/, 'queue bounds must never be enforced by silently deleting accepted instructions')
assert.match(taskJobSource, /pendingTextPersistence: RecordedTaskEvent\[\]/, 'text persistence must retain each original event sequence')
assert.doesNotMatch(taskJobSource, /pending\.event\.content \+=/, 'text persistence must not merge later text into an earlier cursor')
assert.match(taskJobSource, /and attempts = \?/, 'worker event and lease operations must be fenced by claim attempt')
assert.match(taskJobSource, /TaskConversationConflictError/, 'same-task concurrency must have a typed durable conflict')
assert.match(taskJobSource, /maybePruneTerminalTaskJobs/, 'terminal queue history must have bounded retention cleanup')
assert.match(clientStreamSource, /classifyStreamSequence\(event, runId, highestDispatchedSeq\)/, 'client replay must classify every run-scoped event before dispatch')
assert.match(clientStreamSource, /after: String\(highestDispatchedSeq\)/, 'client replay must resume from only the last contiguous dispatched cursor')
assert.ok(
  clientStreamSource.indexOf('pendingStopRequests.set(conversationId, stopRequest)') < clientStreamSource.indexOf("controller?.abort('user-stop')"),
  'stop tracking must be visible before aborting the headerless POST stream',
)
assert.match(clientStreamSource, /response\.status === 202[\s\S]*TASK_STOP_ACK_POLL_MS[\s\S]*continue/, 'accepted cancellation must remain stopping and poll until terminal acknowledgement')
assert.match(clientStreamSource, /TASK_STOP_DISCOVERY_DELAYS_MS[\s\S]*discoverStartingRun/, 'a stop before POST headers must use bounded active-run discovery')
assert.match(clientStreamSource, /conversation\.serverSummary \|\| conversation\.serverBodyStale/, 'a stale or summary-only task must not start work from incomplete history')
assert.match(serverSyncSource, /serverSummary: true,[\s\S]*serverBodyStale: true/, 'a newer server summary must fence the stale local body from upload')
assert.match(serverSyncSource, /!isServerSummaryConversation\(conversation\)/, 'summary-fenced bodies must be excluded from client persistence')
assert.match(serverSyncSource, /conversation\.serverBodyStale !== true/, 'a stale body must remain excluded even if another view accidentally removes its summary marker')
assert.match(
  serverSyncSource,
  /existing\.serverBodyStale && conversationVersionIsOlder\(conversation, existing\)/,
  'an older body response must not clear a newer revision/time summary fence',
)
assert.match(serverSyncSource, /const refreshToken = \{ generation, userId \}[\s\S]*if \(refreshInFlight === refreshToken\) refreshInFlight = null/, 'an older account refresh must not clear a newer sync generation token')
assert.match(chatPageSource, /if \(item\.serverBodyStale\) return item/, 'live replay must not reveal and upload a stale local body')

clearTaskJobsForTest()
await clearLiveDirectivesForTest()

console.log(JSON.stringify({
  ok: true,
  directiveCount: drained.length,
  text: events.filter((event) => event.type === 'text_delta').map((event) => event.content).join(''),
  terminalEvents: events.filter((event) => event.type === 'done' || event.type === 'error').length,
}, null, 2))
