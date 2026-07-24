#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [chatRoute, taskJobs, planManager, taskWorker] = await Promise.all([
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
  readFile(join(root, 'src/worker/taskWorker.ts'), 'utf8'),
])

const postRoute = chatRoute.match(/export async function POST\(request: Request\) \{[\s\S]*$/)?.[0] || ''
const prepareCalls = postRoute.match(/prepareConversationForTaskStartInsert\(\{/g) || []
assert.equal(
  prepareCalls.length,
  1,
  'queued task start must prepare the conversation once rather than repeating its remote read',
)
assert.match(
  postRoute,
  /const conversationInsertPromise = timedRoutePromise\([\s\S]*prepareConversationForTaskStartInsert\(\{[\s\S]*const creditsPromise/,
  'read-only conversation preparation must begin before the parallel acceptance gates settle',
)
assert.match(
  postRoute,
  /Promise\.all\(\[[\s\S]*creditsPromise,[\s\S]*messagesPromise,[\s\S]*workerAvailabilityPromise,[\s\S]*attachmentAccessPromise,[\s\S]*conversationInsertPromise,/,
  'conversation preparation must overlap the existing credit, message, worker, and attachment gates',
)
assert.match(
  postRoute,
  /const \[requestedTask, activeCandidate\] = await Promise\.all\(\[[\s\S]*findTaskJobForRun\([\s\S]*findActiveTaskJobForConversation\(/,
  'the final exact-run and same-conversation checks must run concurrently',
)

const activeLookup = taskJobs.match(/export async function findActiveTaskJobForConversation\([\s\S]*?export async function findReplayableTaskJobForConversation/)?.[0] || ''
assert.match(
  activeLookup,
  /const result = await loadActive\(\)[\s\S]*if \(!active\) return null[\s\S]*reconcileExpiredDurableTaskJob/,
  'the no-active-task hot path must return before stale-task reconciliation performs another remote read',
)

const enqueue = taskJobs.match(/export async function enqueueTaskJob\([\s\S]*?async function loadPersistedTaskPayload/)?.[0] || ''
assert.doesNotMatch(
  enqueue.split("const status = await withTaskJobSchemaRepair")[0] || '',
  /await maybePrune(?:PreStartCancellations|TerminalTaskJobs)/,
  'retention maintenance must not block the external-worker durability transaction',
)
assert.match(
  enqueue,
  /const status = await withTaskJobSchemaRepair[\s\S]*scheduleTaskJobRetentionMaintenance\(createdAt\)[\s\S]*return \{ runId: input\.runId, status \}/,
  'retention maintenance must be scheduled only after the queue/conversation transaction commits',
)

const inProcessStart = taskJobs.match(/export async function startTaskJob\([\s\S]*?export async function enqueueTaskJob/)?.[0] || ''
assert.doesNotMatch(
  inProcessStart,
  /await maybePrune(?:PreStartCancellations|TerminalTaskJobs)/,
  'retention maintenance must not block in-process task reservation either',
)
assert.match(
  inProcessStart,
  /await reserveInProcessTaskJob\(job, input\.conversationInsert\)[\s\S]*scheduleTaskJobRetentionMaintenance\(startedAt\)/,
  'in-process retention must also remain behind the durable reservation fence',
)

const planStart = planManager.match(/startPlanCall\(\): void \{[\s\S]*?\n  dispose\(\): void \{/)?.[0] || ''
assert.doesNotMatch(
  planManager,
  /PLANNER_START_AFTER_ACK_WAIT_MS/,
  'planner startup must not carry an acknowledgement display delay',
)
assert.doesNotMatch(
  planStart,
  /await Promise\.race\(\[[\s\S]*acknowledgementDisplayPromise/,
  'planner request must start concurrently with acknowledgement generation',
)
assert.match(
  planStart,
  /\.then\(async \(result\) => \{[\s\S]*await this\.acknowledgementPromise[\s\S]*return result/,
  'planner completion must still require acknowledgement completion and accounting',
)

assert.match(
  taskWorker,
  /DEFAULT_WORKER_MAX_IDLE_POLL_MS = 500/,
  'an idle worker must remain responsive to newly queued tasks',
)
assert.match(
  taskWorker,
  /idlePollMs = Math\.min\(maxIdlePollMs, idlePollMs \* 2\)/,
  'idle polling may back off only to the bounded low-latency cap',
)

console.log('task start latency contract smoke checks passed')
