import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [agentLoop, serverCredits, streamProcessor, taskJobs] = await Promise.all([
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/serverCredits.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
])

const persistEvents = taskJobs.match(/async function persistEvents\([\s\S]*?\n}\n\nfunction stringifyBrowserFrameForPersistence/)?.[0] || ''
assert.match(
  persistEvents,
  /eventBatchInsertStatement\(job, records\)[\s\S]*tursoExecuteIsolated\(statement\)/,
  'stream deltas should use one bound atomic insert on an isolated connection',
)
assert.doesNotMatch(
  persistEvents,
  /tursoBatch\(|tursoTransaction\(|transaction\.execute|transaction\.batch/,
  'ordinary durable delta persistence must neither use the broken compat batch nor open an interactive remote transaction',
)
assert.match(
  persistEvents,
  /existing = await withTaskJobSchemaRepair\(\(\) => tursoExecuteIsolated[\s\S]*existingBySeq[\s\S]*throw new TaskJobClaimLostError/,
  'atomic idempotent replay must retain the worker-ownership mismatch fence',
)

const recordCreditEvent = serverCredits.match(/async function recordServerCreditEvent\([\s\S]*?\n}\n\nexport async function readServerCreditLedger/)?.[0] || ''
assert.ok(
  (recordCreditEvent.match(/transaction\.batch\(/g) || []).length >= 2,
  'credit writes should batch their preflight and settlement statements inside the write transaction',
)
assert.match(
  recordCreditEvent,
  /where user_id = \? and id = \?/,
  'batched credit writes must retain idempotency-key lookup',
)
assert.match(
  recordCreditEvent,
  /where user_id = \? and monthly_balance >= \?/,
  'batched credit writes must retain the atomic non-negative debit fence',
)
assert.match(
  recordCreditEvent,
  /paidAmount < result\.requestedAmount[\s\S]*throw new OutOfCreditsError/,
  'a partially covered postpaid model call must still stop after recording the paid amount',
)

assert.match(
  agentLoop,
  /await chargeServerTokenUsage\([\s\S]*streamProcessor\.commitBufferedEmission\(\)/,
  'model output must remain hidden until its exact provider usage debit commits',
)
assert.match(
  agentLoop,
  /catch \(error\) \{\s*streamProcessor\.discardBufferedEmission\(\)\s*throw error/,
  'failed usage persistence must discard unbilled buffered output',
)
assert.match(streamProcessor, /beginBufferedEmission\(\)/, 'model-turn buffering must remain enabled')

console.log('stream persistence latency smoke checks passed')
