#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const root = process.cwd()
const [taskJobs, streamSequence] = await Promise.all([
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/streamSequence.ts'), 'utf8'),
])

const eventStream = taskJobs.match(
  /export function createTaskJobEventStream\([\s\S]*?export function clearTaskJobsForTest/,
)?.[0] || ''
const startBody = eventStream.match(/async start\(controller\) \{[\s\S]*?\n    \},\n    cancel\(\)/)?.[0] || ''

const preambleIndex = startBody.indexOf('controller.enqueue(encoder.encode(encodeSSE({')
const reconcileIndex = startBody.indexOf('await reconcileExpiredDurableTaskJob({')
const snapshotIndex = startBody.indexOf('await loadPersistedTaskJobSnapshot(')

assert.ok(preambleIndex >= 0, 'the task event stream must emit an immediate SSE transport preamble')
assert.ok(reconcileIndex > preambleIndex, 'the preamble must be emitted before stale-run reconciliation')
assert.ok(snapshotIndex > preambleIndex, 'the preamble must be emitted before durable snapshot replay')
assert.match(
  startBody.slice(preambleIndex, reconcileIndex),
  /type: 'heartbeat'[\s\S]*runId: input\.runId/,
  'the immediate preamble must be a run-scoped heartbeat rather than a sequenced task event',
)
const preamble = startBody.slice(
  preambleIndex,
  startBody.indexOf('})))', preambleIndex) + 4,
)
assert.doesNotMatch(
  preamble,
  /\bseq\s*:/,
  'the transport preamble must not advance the durable replay cursor',
)
assert.match(
  streamSequence,
  /if \(event\.type === 'heartbeat'\) return \{ kind: 'ignore' \}/,
  'the client sequence gate must continue to ignore unsequenced heartbeat preambles',
)

// Exercise the real stream implementation without a remote database. A
// missing run will eventually produce a terminal error, but its first chunk
// must still be the synchronous transport heartbeat.
process.env.TURSO_DATABASE_URL = ''
process.env.TURSO_AUTH_TOKEN = ''
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': fileURLToPath(new URL('../src', import.meta.url)),
  },
})
const { createTaskJobEventStream } = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)),
)
const stream = createTaskJobEventStream({
  userId: 'header-smoke-user',
  runId: 'header-smoke-run',
  conversationId: 'header-smoke-conversation',
})
const reader = stream.getReader()
const firstRead = await reader.read()
assert.equal(firstRead.done, false, 'the task stream must expose a first chunk before durable replay completes')
const firstBlock = new TextDecoder().decode(firstRead.value)
const firstEvent = JSON.parse(firstBlock.replace(/^data:\s*/, '').trim())
assert.equal(firstEvent.type, 'heartbeat', 'the task stream first chunk must be the transport heartbeat')
assert.equal(firstEvent.runId, 'header-smoke-run', 'the first heartbeat must be scoped to the requested run')
await reader.cancel()

console.log('task stream header latency smoke checks passed')
