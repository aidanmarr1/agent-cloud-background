#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const queueName = `lease-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`

loadLocalEnvFiles(rootUrl)

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the worker lease smoke.`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    })(), timeoutMs, 'Timed out waiting for replayed lease-smoke events')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  return events
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
const {
  acquireActiveTaskLease,
  getActiveTaskLeaseForUser,
} = await jiti.import(fileURLToPath(new URL('../src/lib/activeTasks.ts', import.meta.url)))

const userId = `internal-background-smoke-${randomUUID()}`
const conversationId = `internal-background-smoke-${randomUUID()}`
const runId = `background-smoke-${randomUUID()}`
const exhaustedUserId = `internal-background-smoke-${randomUUID()}`
const exhaustedConversationId = `internal-background-smoke-${randomUUID()}`
const exhaustedRunId = `background-smoke-${randomUUID()}`

console.log(`Running worker lease smoke on isolated queue ${queueName}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

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

  const firstClaim = await claimNextTaskJob(`lease-smoke-dead-worker-${queueName}`, 10)
  if (!firstClaim || firstClaim.runId !== runId) {
    throw new Error(`Initial worker did not claim the diagnostic job. Claimed: ${firstClaim?.runId || 'none'}`)
  }
  if (firstClaim.attempts !== 1) {
    throw new Error(`Expected first claim attempt to be 1, got ${firstClaim.attempts}`)
  }

  await sleep(35)

  const replacementClaim = await claimNextTaskJob(`lease-smoke-replacement-worker-${queueName}`, 60_000)
  if (!replacementClaim || replacementClaim.runId !== runId) {
    throw new Error(`Replacement worker did not reclaim the expired diagnostic job. Claimed: ${replacementClaim?.runId || 'none'}`)
  }
  if (replacementClaim.attempts !== 2) {
    throw new Error(`Expected replacement claim attempt to be 2, got ${replacementClaim.attempts}`)
  }

  await runClaimedTaskJob(replacementClaim, async (emitter) => {
    emitter.plan(['Initial worker lease expired', 'Replacement worker reclaimed the task', 'Replacement worker completed the task'])
    emitter.textDelta(`__lease_smoke_reclaimed__ ${queueName}\n`)
    emitter.done()
  })

  const stream = createTaskJobEventStream({ userId, conversationId, runId, afterSeq: 0 })
  const events = await readStreamEvents(stream, (event) => event.type === 'done')
  const sawReclaimed = events.some((event) => event.type === 'text_delta' && String(event.content || '').includes('__lease_smoke_reclaimed__'))
  const sawDone = events.some((event) => event.type === 'done')
  if (!sawReclaimed || !sawDone) {
    throw new Error('Replayed event stream did not include the replacement-worker completion events.')
  }

  const cleanedUp = await cleanupInternalTaskJob(userId, runId)
  if (!cleanedUp) {
    throw new Error('Lease smoke completed but diagnostic rows were not cleaned up.')
  }

  process.env.AGENT_TASK_WORKER_MAX_ATTEMPTS = '1'
  const exhaustedLease = await acquireActiveTaskLease(exhaustedUserId, exhaustedConversationId, exhaustedRunId)
  if (!exhaustedLease.acquired) {
    throw new Error('Could not acquire diagnostic active-task lease for retry exhaustion smoke.')
  }
  await enqueueTaskJob({
    runId: exhaustedRunId,
    userId: exhaustedUserId,
    conversationId: exhaustedConversationId,
    payload: {
      kind: 'background_probe',
      delayMs: 0,
      message: `queue=${queueName}`,
    },
  })
  const exhaustedFirstClaim = await claimNextTaskJob(`lease-smoke-exhausted-worker-${queueName}`, 10)
  if (!exhaustedFirstClaim || exhaustedFirstClaim.runId !== exhaustedRunId) {
    throw new Error(`Retry exhaustion first worker did not claim the diagnostic job. Claimed: ${exhaustedFirstClaim?.runId || 'none'}`)
  }
  await sleep(35)
  const exhaustedReplacementClaim = await claimNextTaskJob(`lease-smoke-exhausted-replacement-${queueName}`, 60_000)
  if (exhaustedReplacementClaim) {
    throw new Error('Retry-exhausted diagnostic job was claimable after exceeding AGENT_TASK_WORKER_MAX_ATTEMPTS.')
  }
  const exhaustedStream = createTaskJobEventStream({
    userId: exhaustedUserId,
    conversationId: exhaustedConversationId,
    runId: exhaustedRunId,
    afterSeq: 0,
  })
  const exhaustedEvents = await readStreamEvents(exhaustedStream, (event) => event.type === 'error')
  const sawExhausted = exhaustedEvents.some((event) =>
    event.type === 'error' && String(event.message || '').includes('Task stopped after 1 worker claim attempt'))
  if (!sawExhausted) {
    throw new Error('Retry exhaustion did not replay a terminal max-attempts error event.')
  }
  const activeLeaseAfterExhaustion = await getActiveTaskLeaseForUser(exhaustedUserId)
  if (activeLeaseAfterExhaustion) {
    throw new Error('Retry exhaustion did not release the user active-task lease.')
  }
  const exhaustedCleanedUp = await cleanupInternalTaskJob(exhaustedUserId, exhaustedRunId)
  if (!exhaustedCleanedUp) {
    throw new Error('Retry exhaustion smoke completed but diagnostic rows were not cleaned up.')
  }

  console.log(JSON.stringify({
    ok: true,
    queueName,
    runId,
    exhaustedRunId,
    firstWorkerAttempts: firstClaim.attempts,
    replacementWorkerAttempts: replacementClaim.attempts,
    maxAttemptsError: sawExhausted,
    activeLeaseReleasedAfterMaxAttempts: !activeLeaseAfterExhaustion,
    replayedEvents: events.map((event) => ({ type: event.type, seq: event.seq })),
    exhaustedEvents: exhaustedEvents.map((event) => ({ type: event.type, seq: event.seq })),
    cleanedUp,
    exhaustedCleanedUp,
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    queueName,
    runId,
    exhaustedRunId,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}
