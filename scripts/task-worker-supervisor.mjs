#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerEntry = process.env.AGENT_TASK_WORKER_SUPERVISOR_ENTRY
  ? resolve(projectRoot, process.env.AGENT_TASK_WORKER_SUPERVISOR_ENTRY)
  : fileURLToPath(new URL('./task-worker.mjs', import.meta.url))
const workerArgs = process.argv.slice(2)
const runOnce = workerArgs.includes('--once')
const restartBaseMs = 250
const restartMaxMs = 5_000
const stableRunMs = 30_000
const maxWorkerConcurrency = 32

let stopping = false

function workerConcurrency() {
  const raw = process.env.AGENT_TASK_WORKER_CONCURRENCY?.trim()
  if (!raw) return 1
  if (!/^\d+$/.test(raw)) {
    throw new Error('AGENT_TASK_WORKER_CONCURRENCY must be a positive integer.')
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxWorkerConcurrency) {
    throw new Error(`AGENT_TASK_WORKER_CONCURRENCY must be between 1 and ${maxWorkerConcurrency}.`)
  }
  return parsed
}

const configuredConcurrency = workerConcurrency()
// A one-shot worker has historically claimed at most one job. Preserve that
// contract even if the persistent service normally runs a larger process pool.
const concurrency = runOnce ? 1 : configuredConcurrency
const slots = Array.from({ length: concurrency }, (_, index) => ({
  index,
  child: null,
  restartAttempt: 0,
  restartTimer: null,
  releaseRestartWait: null,
}))

function waitForRestart(slot, delayMs) {
  return new Promise((resolveWait) => {
    slot.releaseRestartWait = resolveWait
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null
      slot.releaseRestartWait = null
      resolveWait()
    }, delayMs)
  })
}

function stop(signal) {
  if (stopping) return
  stopping = true

  for (const slot of slots) {
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer)
      slot.restartTimer = null
      slot.releaseRestartWait?.()
      slot.releaseRestartWait = null
    }
    if (slot.child && !slot.child.killed) slot.child.kill(signal)
  }
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

async function runWorkerSlot(slot) {
  while (!stopping) {
    const startedAtMs = Date.now()
    const slotNumber = slot.index + 1

    slot.child = spawn(process.execPath, [workerEntry, ...workerArgs], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_TASK_WORKER_SUPERVISOR_SLOT: String(slotNumber),
      },
    })

    const activeChild = slot.child
    const outcome = await new Promise((resolveExit) => {
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        resolveExit(result)
      }
      activeChild.once('exit', (code, signal) => settle({ code, signal }))
      activeChild.once('error', (error) => settle({ code: 1, signal: null, error }))
    })
    if (slot.child === activeChild) slot.child = null

    if (stopping) return 0

    if (outcome.error) {
      console.error('[TaskWorkerSupervisor] Worker process failed to start', {
        slot: slotNumber,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      })
    }

    if (outcome.signal) {
      console.error('[TaskWorkerSupervisor] Worker exited from a signal', {
        slot: slotNumber,
        signal: outcome.signal,
      })
    }

    const exitCode = Number.isInteger(outcome.code) ? outcome.code : 1
    if (runOnce) return exitCode

    const runtimeMs = Date.now() - startedAtMs
    slot.restartAttempt = runtimeMs >= stableRunMs ? 0 : slot.restartAttempt + 1
    const restartBackoffMs = restartBaseMs * (2 ** Math.min(slot.restartAttempt, 5))
    const restartJitterMs = Math.floor(Math.random() * Math.min(250, Math.max(1, restartBackoffMs / 4)))
    const restartDelayMs = Math.min(restartMaxMs, restartBackoffMs + restartJitterMs)

    console.error('[TaskWorkerSupervisor] Worker exited unexpectedly; restarting', {
      slot: slotNumber,
      exitCode,
      runtimeMs,
      restartDelayMs,
    })

    await waitForRestart(slot, restartDelayMs)
  }
  return 0
}

console.log(`[TaskWorkerSupervisor] Starting ${concurrency} isolated worker process${concurrency === 1 ? '' : 'es'}.`)

if (runOnce) {
  process.exitCode = await runWorkerSlot(slots[0])
} else {
  await Promise.all(slots.map((slot) => runWorkerSlot(slot)))
}
