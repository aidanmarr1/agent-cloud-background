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

let child = null
let stopping = false
let restartAttempt = 0
let restartTimer = null
let releaseRestartWait = null

function waitForRestart(delayMs) {
  return new Promise((resolveWait) => {
    releaseRestartWait = resolveWait
    restartTimer = setTimeout(() => {
      restartTimer = null
      releaseRestartWait = null
      resolveWait()
    }, delayMs)
  })
}

function stop(signal) {
  if (stopping) return
  stopping = true

  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
    releaseRestartWait?.()
    releaseRestartWait = null
  }

  if (child && !child.killed) child.kill(signal)
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

while (!stopping) {
  const startedAtMs = Date.now()

  child = spawn(process.execPath, [workerEntry, ...workerArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  const outcome = await new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', (error) => resolveExit({ code: 1, signal: null, error }))
  })
  child = null

  if (stopping) break

  if (outcome.error) {
    console.error('[TaskWorkerSupervisor] Worker process failed to start', {
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    })
  }

  if (outcome.signal) {
    console.error('[TaskWorkerSupervisor] Worker exited from a signal', {
      signal: outcome.signal,
    })
  }

  const exitCode = Number.isInteger(outcome.code) ? outcome.code : 1
  if (runOnce) {
    process.exitCode = exitCode
    break
  }

  const runtimeMs = Date.now() - startedAtMs
  restartAttempt = runtimeMs >= stableRunMs ? 0 : restartAttempt + 1
  const restartBackoffMs = restartBaseMs * (2 ** Math.min(restartAttempt, 5))
  const restartJitterMs = Math.floor(Math.random() * Math.min(250, Math.max(1, restartBackoffMs / 4)))
  const restartDelayMs = Math.min(restartMaxMs, restartBackoffMs + restartJitterMs)

  console.error('[TaskWorkerSupervisor] Worker exited unexpectedly; restarting', {
    exitCode,
    runtimeMs,
    restartDelayMs,
  })

  await waitForRestart(restartDelayMs)
}
