#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const queueName = `cancel-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`

loadLocalEnvFiles(rootUrl)

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the worker cancel smoke.`)
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
    })(), timeoutMs, 'Timed out waiting for replayed cancel-smoke events')
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
  cancelTaskJob,
  claimNextTaskJob,
  cleanupInternalTaskJob,
  createTaskJobEventStream,
  enqueueTaskJob,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)))
const {
  acquireActiveTaskLease,
  getActiveTaskLeaseForUser,
  releaseActiveTaskLease,
} = await jiti.import(fileURLToPath(new URL('../src/lib/activeTasks.ts', import.meta.url)))
const {
  markTaskWorkerStopped,
  recordTaskWorkerHeartbeat,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/taskWorkerHeartbeat.ts', import.meta.url)))

const userId = `internal-background-smoke-${randomUUID()}`
const conversationId = `internal-background-smoke-${randomUUID()}`
const runId = `background-smoke-${randomUUID()}`

console.log(`Running worker cancel smoke on isolated queue ${queueName}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

try {
  const activeLease = await acquireActiveTaskLease(userId, conversationId, runId)
  if (!activeLease.acquired) {
    throw new Error(`Could not acquire the initial active task lease. Existing run: ${activeLease.lease.runId}`)
  }

  await enqueueTaskJob({
    runId,
    userId,
    conversationId,
    payload: {
      kind: 'background_probe',
      delayMs: 30_000,
      message: `queue=${queueName}`,
    },
  })

  const deadWorkerId = `cancel-smoke-dead-worker-${queueName}`
  const deadWorkerStartedAt = Date.now()
  await recordTaskWorkerHeartbeat({
    workerId: deadWorkerId,
    startedAtMs: deadWorkerStartedAt,
    pollMs: 100,
    heartbeatMs: 15_000,
    status: 'idle',
    currentRunId: null,
    completedTasks: 0,
  })
  const claim = await claimNextTaskJob(deadWorkerId, 1)
  if (!claim || claim.runId !== runId) {
    throw new Error(`Diagnostic worker did not claim the job. Claimed: ${claim?.runId || 'none'}`)
  }
  await recordTaskWorkerHeartbeat({
    workerId: deadWorkerId,
    startedAtMs: deadWorkerStartedAt,
    pollMs: 100,
    heartbeatMs: 15_000,
    status: 'running',
    currentRunId: runId,
    completedTasks: 0,
  })
  await markTaskWorkerStopped(deadWorkerId, deadWorkerStartedAt)
  await new Promise((resolve) => setTimeout(resolve, 10))

  const cancelled = await cancelTaskJob(userId, runId)
  if (!cancelled) {
    throw new Error('cancelTaskJob returned false for the claimed diagnostic job.')
  }

  const leaseAfterCancel = await getActiveTaskLeaseForUser(userId)
  if (leaseAfterCancel) {
    throw new Error(`Active task lease survived cancellation for run ${leaseAfterCancel.runId}.`)
  }

  const replacementRunId = `background-smoke-${randomUUID()}`
  const replacementLease = await acquireActiveTaskLease(userId, `${conversationId}-next`, replacementRunId)
  if (!replacementLease.acquired) {
    throw new Error(`Cancellation left the user blocked from starting a replacement task. Existing run: ${replacementLease.lease.runId}`)
  }
  await releaseActiveTaskLease(userId, replacementRunId)

  const stream = createTaskJobEventStream({ userId, conversationId, runId, afterSeq: 0 })
  const events = await readStreamEvents(stream, (event) => event.type === 'error')
  const stopError = events.find((event) => event.type === 'error' && /task stopped/i.test(String(event.message || '')))
  if (!stopError) {
    throw new Error('Replayed event stream did not include the terminal Task stopped error.')
  }

  const replacementWorkerId = `cancel-smoke-replacement-worker-${queueName}`
  await recordTaskWorkerHeartbeat({
    workerId: replacementWorkerId,
    startedAtMs: Date.now(),
    pollMs: 100,
    heartbeatMs: 15_000,
    status: 'idle',
    currentRunId: null,
    completedTasks: 0,
  })
  const replacementClaim = await claimNextTaskJob(replacementWorkerId, 60_000)
  if (replacementClaim) {
    throw new Error(`Cancelled diagnostic job was claimable again by ${replacementClaim.workerId}.`)
  }

  const cleanedUp = await cleanupInternalTaskJob(userId, runId)
  if (!cleanedUp) {
    throw new Error('Cancel smoke completed but diagnostic rows were not cleaned up.')
  }

  console.log(JSON.stringify({
    ok: true,
    queueName,
    runId,
    attempts: claim.attempts,
    activeLeaseReleased: true,
    replacementLeaseAcquired: replacementLease.acquired,
    replayedEvents: events.map((event) => ({
      type: event.type,
      seq: event.seq,
      message: event.type === 'error' ? event.message : undefined,
    })),
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
}
