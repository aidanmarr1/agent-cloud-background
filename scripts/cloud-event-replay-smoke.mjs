#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const queueName = `event-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`

loadLocalEnvFiles(rootUrl)

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the event replay smoke.`)
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timeout))
}

async function readStreamEvents(stream, stopWhen, timeoutMs = 5000) {
  const { parseSSE } = await jiti.import(fileURLToPath(new URL('../src/lib/stream.ts', import.meta.url)))
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''

  try {
    await withTimeout((async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\n\n/)
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          const event = parseSSE(block)
          if (!event) continue
          events.push(event)
          if (stopWhen(event)) return
        }
      }
    })(), timeoutMs, 'Timed out waiting for persisted event replay')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  return events
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertContiguousSeq(events) {
  const seqs = events.map((event) => Number(event.seq)).filter(Number.isFinite)
  assert(seqs.length === events.length, 'Every replayed event must have a sequence number.')
  for (let index = 0; index < seqs.length; index += 1) {
    assert(seqs[index] === index + 1, `Persisted event sequence has a gap at index ${index}: ${seqs.join(', ')}`)
  }
}

requireEnv('TURSO_DATABASE_URL')
requireEnv('TURSO_AUTH_TOKEN')

process.env.AGENT_TASK_WORKER_MODE = 'external'
process.env.AGENT_TASK_QUEUE_NAME = queueName

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const {
  claimNextTaskJob,
  cleanupInternalTaskJob,
  createTaskJobEventStream,
  enqueueTaskJob,
  runClaimedTaskJob,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)))
const { tursoExecute } = await jiti.import(fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url)))

const userId = `internal-background-smoke-${randomUUID()}`
const conversationId = `internal-background-smoke-${randomUUID()}`
const runId = `background-smoke-${randomUUID()}`
const hugeText = 'x'.repeat(620_000)
let cleanedUp = false

console.log(`Running event replay smoke on isolated queue ${queueName}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

async function forceCleanup() {
  await tursoExecute('delete from agent_task_events where run_id = ?', [runId]).catch(() => undefined)
  await tursoExecute(
    'delete from agent_task_jobs where user_id = ? and run_id = ? and queue_name = ?',
    [userId, runId, queueName],
  ).catch(() => undefined)
}

try {
  await enqueueTaskJob({
    runId,
    userId,
    conversationId,
    payload: {
      kind: 'background_probe',
      delayMs: 0,
      message: `queue=${queueName}`,
    },
  })

  const claim = await claimNextTaskJob(`event-smoke-worker-${queueName}`, 60_000)
  if (!claim || claim.runId !== runId) {
    throw new Error(`Worker did not claim the diagnostic event job. Claimed: ${claim?.runId || 'none'}`)
  }

  await runClaimedTaskJob(claim, async (emitter) => {
    emitter.toolStart('huge-read', 'read_file', { path: 'huge.txt' })
    emitter.toolResult('huge-read', 'read_file', {
      action: 'read',
      path: 'huge.txt',
      content: hugeText,
    })
    emitter.browserFrame(`data:image/png;base64,${hugeText}`)
    emitter.terminalOutput('huge-terminal', 'stdout', hugeText)
    emitter.artifactCreated({
      id: 'huge-artifact',
      fileName: 'huge.txt',
      filePath: 'huge.txt',
      content: hugeText,
      type: 'document',
      createdAt: Date.now(),
    })
    emitter.done()
  })

  const rows = await tursoExecute(
    'select seq, event_json from agent_task_events where run_id = ? order by seq asc',
    [runId],
  )
  const persistedEvents = rows.rows.map((row) => JSON.parse(String(row.event_json)))
  assert(persistedEvents.length === 6, `Expected 6 persisted events, got ${persistedEvents.length}.`)
  assertContiguousSeq(persistedEvents)
  assert(
    persistedEvents.every((event) => JSON.stringify(event).length <= 256 * 1024),
    'Every persisted event must fit under the Turso event row limit.',
  )

  const toolResult = persistedEvents.find((event) => event.type === 'tool_result')
  const terminalOutput = persistedEvents.find((event) => event.type === 'terminal_output')
  const artifactCreated = persistedEvents.find((event) => event.type === 'artifact_created')
  const browserFallback = persistedEvents.find((event) => event.seq === 3)
  assert(toolResult?.result?.content?.includes('[truncated'), 'Oversized tool result content must be compacted, not dropped.')
  assert(terminalOutput?.data?.includes('[truncated'), 'Oversized terminal output must be compacted, not dropped.')
  assert(artifactCreated?.artifact?.content?.includes('[truncated'), 'Oversized artifact content must be compacted, not dropped.')
  assert(browserFallback?.type === 'heartbeat', 'Oversized live browser frames should persist as sequence-preserving heartbeats.')

  const stream = createTaskJobEventStream({ userId, conversationId, runId, afterSeq: 0 })
  const replayedEvents = await readStreamEvents(stream, (event) => event.type === 'done')
  assertContiguousSeq(replayedEvents)
  assert(replayedEvents.some((event) => event.type === 'tool_result'), 'Replay must include the compacted tool result.')
  assert(replayedEvents.some((event) => event.type === 'terminal_output'), 'Replay must include the compacted terminal output.')
  assert(replayedEvents.some((event) => event.type === 'artifact_created'), 'Replay must include the compacted artifact.')
  assert(replayedEvents.some((event) => event.type === 'done'), 'Replay must include the terminal done event.')

  cleanedUp = await cleanupInternalTaskJob(userId, runId)
  if (!cleanedUp) {
    throw new Error('Event replay smoke completed but diagnostic rows were not cleaned up.')
  }

  console.log(JSON.stringify({
    ok: true,
    queueName,
    runId,
    persistedEvents: persistedEvents.map((event) => ({ type: event.type, seq: event.seq })),
    replayedEvents: replayedEvents.map((event) => ({ type: event.type, seq: event.seq })),
    compactedLargeEvents: true,
    cleanedUp,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    queueName,
    runId,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
} finally {
  if (!cleanedUp) await forceCleanup()
}
