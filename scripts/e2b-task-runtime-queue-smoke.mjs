#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

loadLocalEnvFiles(new URL('../', import.meta.url))
const suffix = randomUUID()
process.env.AGENT_TASK_QUEUE_NAME = `e2b-runtime-smoke-${suffix}`
process.env.AGENT_TASK_WORKER_MODE = 'external'
process.env.AGENT_TASK_DISPATCH_MODE = 'e2b_job'
const jiti = createJiti(import.meta.url, { nativeModules: ['e2b'], alias: {
  '@': fileURLToPath(new URL('../src', import.meta.url)),
  'server-only': fileURLToPath(new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url)),
} })
const jobs = await jiti.import('../src/lib/agent/taskJobs.ts')
const identity = { runId: `background-smoke-${suffix}`, userId: `internal-background-smoke-${suffix}`,
  conversationId: `internal-background-smoke-${suffix}` }
const dispatchId = `e2b:${identity.runId}:1`
const providerJobId = `e2b:mock-${suffix}`
try {
  await jobs.enqueueTaskJob({ ...identity, payload: { kind: 'background_probe', delayMs: 0 } })
  const reservations = await Promise.all(Array.from({ length: 4 }, () => jobs.reserveTaskDispatchAttempt({
    runId: identity.runId, dispatchId, backend: 'e2b-task-runtime',
  })))
  const created = reservations.filter(result => result.created)
  assert.equal(created.length, 1, 'concurrent launch attempts must have exactly one owner')
  assert.equal(await jobs.completeTaskDispatchAttempt(dispatchId, created[0].reservationToken, providerJobId), true)
  const state = await jobs.inspectTaskExecutionDispatchState(identity.runId)
  assert.equal(state.renderDispatches.length, 1, 'recovery inspection must include E2B dispatches')
  assert.equal(state.renderDispatches[0].providerJobId, providerJobId)
  await jobs.recordTaskDispatchProviderStatus(dispatchId, providerJobId, 'canceled')
  const stopped = await jobs.inspectTaskExecutionDispatchState(identity.runId)
  assert.equal(stopped.renderDispatches[0].status, 'terminal')
  console.log('E2B queue smoke passed: one launch owner, persisted runtime identity, terminal reconciliation.')
} finally {
  // This test creates no provider resource; make its mock dispatch terminal
  // before cancelling the isolated diagnostic task and deleting its history.
  await jobs.recordTaskDispatchProviderStatus(dispatchId, providerJobId, 'canceled').catch(() => {})
  await jobs.cancelTaskJob(identity.userId, identity.runId, identity.conversationId)
  assert.equal(await jobs.cleanupInternalTaskJob(identity.userId, identity.runId), true)
}
