#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const queueName = `shutdown-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`

loadLocalEnvFiles(rootUrl)

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the worker shutdown smoke.`)
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
    })(), timeoutMs, 'Timed out waiting for replayed shutdown-smoke events')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  return events
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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

const userId = `internal-background-smoke-${randomUUID()}`
const conversationId = `internal-background-smoke-${randomUUID()}`
const runId = `background-smoke-${randomUUID()}`
const shutdownController = new AbortController()

console.log(`Running worker shutdown smoke on isolated queue ${queueName}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

let runnerStarted = null

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

  const firstClaim = await claimNextTaskJob(`shutdown-smoke-stopping-worker-${queueName}`, 60_000)
  if (!firstClaim || firstClaim.runId !== runId) {
    throw new Error(`Stopping worker did not claim the diagnostic job. Claimed: ${firstClaim?.runId || 'none'}`)
  }
  if (firstClaim.attempts !== 1) {
    throw new Error(`Expected first claim attempt to be 1, got ${firstClaim.attempts}`)
  }

  runnerStarted = createDeferred()
  const taskResultPromise = runClaimedTaskJob(firstClaim, async (emitter, signal) => {
    emitter.plan(['Stopping worker claimed the task', 'Shutdown signal releases the lease', 'Replacement worker completes the task'])
    emitter.textDelta(`__shutdown_smoke_first_worker_started__ ${queueName}\n`)
    runnerStarted.resolve()
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', resolve, { once: true })
      setTimeout(() => reject(new Error('Stopping worker was not aborted by shutdown signal.')), 5_000)
    })
  }, { shutdownSignal: shutdownController.signal })

  await withTimeout(runnerStarted.promise, 5_000, 'Timed out waiting for stopping worker to start the diagnostic job.')
  shutdownController.abort()

  const taskResult = await withTimeout(taskResultPromise, 5_000, 'Timed out waiting for stopping worker to release the task claim.')
  if (taskResult !== 'requeued') {
    throw new Error(`Expected stopping worker result to be requeued, got ${taskResult}`)
  }

  const replacementClaim = await claimNextTaskJob(`shutdown-smoke-replacement-worker-${queueName}`, 60_000)
  if (!replacementClaim || replacementClaim.runId !== runId) {
    throw new Error(`Replacement worker did not immediately reclaim the released diagnostic job. Claimed: ${replacementClaim?.runId || 'none'}`)
  }
  if (replacementClaim.attempts !== 2) {
    throw new Error(`Expected replacement claim attempt to be 2, got ${replacementClaim.attempts}`)
  }

  await runClaimedTaskJob(replacementClaim, async (emitter) => {
    emitter.plan(['Replacement worker reclaimed the released task', 'Replacement worker completed the task'])
    emitter.textDelta(`__shutdown_smoke_reclaimed__ ${queueName}\n`)
    emitter.done()
  })

  const stream = createTaskJobEventStream({ userId, conversationId, runId, afterSeq: 0 })
  const events = await readStreamEvents(stream, (event) => event.type === 'done')
  const sawFirstWorker = events.some((event) => event.type === 'text_delta' && String(event.content || '').includes('__shutdown_smoke_first_worker_started__'))
  const sawReclaimed = events.some((event) => event.type === 'text_delta' && String(event.content || '').includes('__shutdown_smoke_reclaimed__'))
  const sawDone = events.some((event) => event.type === 'done')
  const sawPrematureError = events.some((event) => event.type === 'error')
  if (!sawFirstWorker || !sawReclaimed || !sawDone || sawPrematureError) {
    throw new Error('Replayed event stream did not prove clean shutdown handoff and replacement completion.')
  }

  const cleanedUp = await cleanupInternalTaskJob(userId, runId)
  if (!cleanedUp) {
    throw new Error('Shutdown smoke completed but diagnostic rows were not cleaned up.')
  }

  console.log(JSON.stringify({
    ok: true,
    queueName,
    runId,
    firstWorkerAttempts: firstClaim.attempts,
    stoppingWorkerResult: taskResult,
    replacementWorkerAttempts: replacementClaim.attempts,
    replayedEvents: events.map((event) => ({ type: event.type, seq: event.seq })),
    cleanedUp,
  }, null, 2))
} catch (error) {
  runnerStarted?.reject?.(error)
  console.error(JSON.stringify({
    ok: false,
    queueName,
    runId,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}
