import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const taskJobsUrl = new URL('../src/lib/agent/taskJobs.ts', import.meta.url)
const taskJobs = await readFile(taskJobsUrl, 'utf8')
const jiti = createJiti(import.meta.url)
const { drainOrderedEventBatches, utf8ByteWeight } = await jiti.import(fileURLToPath(
  new URL('../src/lib/agent/TaskEventPersistenceBatch.ts', import.meta.url),
))

assert.equal(utf8ByteWeight('plain'), 5)
assert.equal(
  utf8ByteWeight('🙂'),
  4,
  'transaction byte ceilings must measure UTF-8 bytes rather than JavaScript code units',
)

const adjacentStructural = [
  { seq: 1, type: 'plan' },
  { seq: 2, type: 'step_advance' },
  { seq: 3, type: 'tool_start' },
  { seq: 4, type: 'tool_result' },
]
const structuralTransactions = []
await drainOrderedEventBatches(adjacentStructural, 64, async (records) => {
  structuralTransactions.push(records.map(({ seq }) => seq))
})
assert.deepEqual(
  structuralTransactions,
  [[1, 2, 3, 4]],
  'adjacent structural events must use one durable transaction',
)

const pending = Array.from({ length: 130 }, (_, index) => ({ seq: index + 1 }))
const persisted = []
await drainOrderedEventBatches(pending, 64, async (records) => {
  persisted.push(records.map(({ seq }) => seq))
})
assert.deepEqual(persisted.map((records) => records.length), [64, 64, 2])
assert.deepEqual(persisted.flat(), Array.from({ length: 130 }, (_, index) => index + 1))
assert.deepEqual(pending, [], 'a successful drain must remove every persisted record')

const weightedPending = [
  { seq: 1, bytes: 300 },
  { seq: 2, bytes: 300 },
  { seq: 3, bytes: 100 },
]
const weightedBatches = []
await drainOrderedEventBatches(
  weightedPending,
  64,
  async (records) => weightedBatches.push(records.map(({ seq }) => seq)),
  { maxBatchWeight: 512, weightOf: ({ bytes }) => bytes },
)
assert.deepEqual(
  weightedBatches,
  [[1], [2, 3]],
  'large structural payloads must also respect the bounded transaction byte budget',
)

const ambiguousPending = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
await assert.rejects(
  drainOrderedEventBatches(ambiguousPending, 64, async () => {
    throw new Error('ambiguous write response')
  }),
  /ambiguous write response/,
)
assert.deepEqual(
  ambiguousPending.map(({ seq }) => seq),
  [1, 2, 3],
  'an ambiguous write must retain the exact contiguous batch for idempotent retry',
)
const retried = []
await drainOrderedEventBatches(ambiguousPending, 64, async (records) => {
  retried.push(records.map(({ seq }) => seq))
})
assert.deepEqual(retried, [[1, 2, 3]])

let releaseFirstWrite
const firstWriteStarted = new Promise((resolve) => {
  releaseFirstWrite = resolve
})
let unblockFirstWrite
const firstWriteBlocked = new Promise((resolve) => {
  unblockFirstWrite = resolve
})
const inflightPending = [{ seq: 1 }]
const inflightBatches = []
const inflightDrain = drainOrderedEventBatches(inflightPending, 64, async (records) => {
  inflightBatches.push(records.map(({ seq }) => seq))
  if (records[0]?.seq === 1) {
    releaseFirstWrite()
    await firstWriteBlocked
  }
})
await firstWriteStarted
inflightPending.push({ seq: 2 }, { seq: 3 }, { seq: 4 })
unblockFirstWrite()
await inflightDrain
assert.deepEqual(
  inflightBatches,
  [[1], [2, 3, 4]],
  'events arriving during a remote write must collapse into the next transaction instead of separate writes',
)

const scheduleEventPersistence = taskJobs.match(
  /function scheduleEventPersistence\([\s\S]*?\n}\n\nfunction queueEventPersistence/,
)?.[0] || ''
assert.match(
  scheduleEventPersistence,
  /job\.eventPersistenceQueued \|\| job\.pendingEventPersistence\.length === 0/,
  'only one structural-event drain may occupy the persistence chain',
)
assert.match(
  scheduleEventPersistence,
  /drainOrderedEventBatches\([\s\S]*TASK_JOB_EVENT_PERSIST_BATCH_LIMIT[\s\S]*persistEventsThenPublish/,
  'the production drain must use the tested bounded ordered batch helper',
)
assert.match(
  scheduleEventPersistence,
  /maxBatchWeight: TASK_JOB_EVENT_PERSIST_BATCH_BYTES[\s\S]*utf8ByteWeight\(stringifyEventForPersistence/,
  'the production batch must cap serialized UTF-8 event bytes as well as record count',
)
assert.match(
  scheduleEventPersistence,
  /job\.eventPersistenceQueued = false[\s\S]*scheduleEventPersistence\(job\)/,
  'an event arriving at drain settlement must receive a fresh chain slot',
)

const queueEventPersistence = taskJobs.match(
  /function queueEventPersistence\([\s\S]*?\n}\n\nfunction clearPendingTextPersistenceTimer/,
)?.[0] || ''
assert.match(
  queueEventPersistence,
  /job\.pendingEventPersistence\.push\(\.\.\.records\)[\s\S]*scheduleEventPersistence\(job\)/,
  'a first visible text or tool boundary must schedule persistence immediately',
)
assert.doesNotMatch(
  queueEventPersistence,
  /setTimeout/,
  'structural boundaries must not wait on an artificial batching timer',
)

const queueDeltaPersistence = taskJobs.match(
  /function queueDeltaPersistence\([\s\S]*?\n}\n\nfunction compactStringForPersistence/,
)?.[0] || ''
assert.match(
  queueDeltaPersistence,
  /if \(eventChars === null\) \{[\s\S]*flushPendingTextPersistence\(job\)[\s\S]*queueEventPersistence\(job, \[record\]\)/,
  'adjacent structural events must enter the shared batch after older text is flushed',
)
assert.match(
  queueDeltaPersistence,
  /if \(isFirstVisibleText\) \{[\s\S]*queueEventPersistence\(job, \[record\]\)[\s\S]*return/,
  'the first visible text must start persistence immediately without the text debounce',
)

const recordTaskJobEvent = taskJobs.match(
  /function recordTaskJobEvent\([\s\S]*?\n}\n\nclass TaskJobEmitter/,
)?.[0] || ''
assert.match(
  recordTaskJobEvent,
  /event\.type === 'done' \|\| event\.type === 'error'[\s\S]*flushPendingEventPersistence\(job\)/,
  'terminal events must flush all preceding progress but remain outside ordinary event batches',
)
assert.match(
  taskJobs,
  /await job\.persistChain\.catch\(\(\) => undefined\)[\s\S]*await awaitTaskJobPersistenceIdle\(job\)[\s\S]*const finalized = await persistFinalJobState\(job\)/,
  'terminal row/event atomic commit must wait for every ordinary event batch',
)
assert.match(
  taskJobs,
  /async function awaitTaskJobPersistenceIdle[\s\S]*observedChain === job\.persistChain[\s\S]*job\.pendingEventPersistence\.length === 0/,
  'terminal persistence must recheck the chain if a settlement-boundary event schedules one final batch',
)
assert.doesNotMatch(
  taskJobs,
  /async function persistEvent\(/,
  'ordinary task events must not retain a one-transaction-per-record persistence path',
)
const persistEvents = taskJobs.match(
  /async function persistEvents\([\s\S]*?\n}\n\nfunction stringifyBrowserFrameForPersistence/,
)?.[0] || ''
assert.match(
  persistEvents,
  /eventBatchInsertStatement\(job, records\)[\s\S]*tursoExecuteIsolated\(statement\)/,
  'the common event path must use one bound, isolated atomic insert',
)
assert.doesNotMatch(
  persistEvents,
  /tursoBatch\(|tursoTransaction\(|transaction\.batch/,
  'the common event path must neither use the parameter-dropping compat batch nor pay interactive transaction round trips',
)
assert.match(
  taskJobs,
  /with pending_events\(run_id, seq, event_json, created_at_ms\) as \([\s\S]*values \$\{values\}[\s\S]*where exists \([\s\S]*worker_id = \?[\s\S]*attempts = \?/,
  'one bound INSERT statement must retain the exact worker ownership fence for every event in the batch',
)

console.log(JSON.stringify({
  ok: true,
  structuralTransactions,
  boundedBatchSizes: persisted.map((records) => records.length),
  weightedBatches,
  inflightBatches,
  retryPreserved: retried[0],
}, null, 2))
