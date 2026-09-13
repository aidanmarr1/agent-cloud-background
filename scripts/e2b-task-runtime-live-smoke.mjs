#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

loadLocalEnvFiles(new URL('../', import.meta.url))
const built = JSON.parse(await readFile('.agent-runtime/e2b-task-runtime-build.json', 'utf8'))
process.env.AGENT_TASK_QUEUE_NAME = `e2b-live-smoke-${randomUUID()}`
process.env.AGENT_TASK_WORKER_MODE = 'external'
process.env.AGENT_TASK_DISPATCH_MODE = 'e2b_job'
process.env.E2B_TASK_RUNTIME_TEMPLATE = built.template
process.env.E2B_TASK_RUNTIME_REVISION = built.revision
delete process.env.RENDER_API_KEY
delete process.env.RENDER_WORKER_SERVICE_ID
delete process.env.RENDER_ON_DEMAND_JOB_PLAN_ID
const jiti = createJiti(import.meta.url, { nativeModules: ['e2b'], alias: {
  '@': fileURLToPath(new URL('../src', import.meta.url)),
  'server-only': fileURLToPath(new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url)),
} })
const jobs = await jiti.import('../src/lib/agent/taskJobs.ts')
const dispatch = await jiti.import('../src/lib/agent/taskDispatch.ts')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(1000) }
  throw new Error(`Timed out: ${label}`)
}

const realAgent = process.argv.includes('--agent')
for (const cancel of (realAgent ? [false] : [false, true])) {
  const suffix = randomUUID()
  const identity = { runId: `background-smoke-${suffix}`, userId: `internal-background-smoke-${suffix}`,
    conversationId: `internal-background-smoke-${suffix}` }
  const dispatchId = `e2b:${identity.runId}:1`
  let providerJobId = null
  const startedAt = Date.now()
  try {
    console.log(JSON.stringify({ stage: 'starting', cancel, ...identity }))
    if (realAgent) {
      const { topUpServerCredits } = await jiti.import('../src/lib/serverCredits.ts')
      await topUpServerCredits(identity.userId, 500, 'Isolated E2B migration diagnostic; removed after test')
    }
    await jobs.enqueueTaskJob({ ...identity, payload: realAgent ? {
      kind: 'chat', model: process.env.OPENROUTER_MODEL,
      messages: [{ role: 'user', content: 'Use the terminal to run Python to calculate 17 * 19. Reply with the result. Do not browse or create files.' }],
      startIsolatedTaskSandbox: true, startFreshSandbox: true, directChat: false,
      skipStartupAcknowledgement: true, startupPlanExpected: false,
      startupPlan: { items: ['Calculate 17 × 19 with Python and report the result'] },
    } : { kind: 'background_probe', delayMs: cancel ? 30_000 : 2500 } })
    const launched = await dispatch.dispatchTaskExecution({ runId: identity.runId, dispatchId })
    assert.equal(launched.status, 'launched')
    providerJobId = launched.providerJobId
    console.log(JSON.stringify({ stage: 'launched', cancel, providerJobId, runId: identity.runId }))
    if (cancel) {
      await waitFor(async () => (await jobs.inspectTaskExecutionDispatchState(identity.runId)).state === 'running', 'task claimed')
      await jobs.cancelTaskJob(identity.userId, identity.runId, identity.conversationId)
    }
    const terminal = await waitFor(async () => {
      const state = await jobs.inspectTaskExecutionDispatchState(identity.runId)
      return state.state === 'terminal' ? state : null
    }, 'task terminal', realAgent ? 180_000 : 90_000)
    if (realAgent) {
      const { tursoExecute } = await jiti.import('../src/lib/db/turso.ts')
      const result = await tursoExecute('select event_json from agent_task_events where run_id = ? order by seq', [identity.runId])
      const events = result.rows.map(row => JSON.parse(row.event_json))
      console.log(JSON.stringify({ stage: 'agent-events', events: events.filter(e => ['tool_start', 'error', 'text_delta'].includes(e.type)) }))
      assert.ok(events.some(e => e.type === 'tool_start'), 'real agent must execute a tool')
    }
    assert.equal(terminal.status, cancel ? 'cancelled' : 'done')
    await waitFor(async () => {
      const observation = await dispatch.retrieveTaskDispatchProviderJob(providerJobId)
      return observation.outcome === 'not_found'
    }, 'runtime self-termination', 30_000)
    const listed = await dispatch.listTaskDispatchProviderJobs({ runId: identity.runId, createdAfterMs: startedAt })
    assert.equal(listed.outcome, 'complete')
    assert.equal(listed.jobs.length, 0)
    console.log(JSON.stringify({ passed: true, cancel, elapsedMs: Date.now() - startedAt, runtimeStopped: true }))
  } finally {
    const listed = await dispatch.listTaskDispatchProviderJobs({ runId: identity.runId, createdAfterMs: startedAt })
    assert.equal(listed.outcome, 'complete', 'cleanup requires authoritative provider listing')
    for (const job of listed.jobs) await dispatch.cancelTaskDispatchProviderJob(job.providerJobId)
    await waitFor(async () => {
      const remaining = await dispatch.listTaskDispatchProviderJobs({ runId: identity.runId, createdAfterMs: startedAt })
      return remaining.outcome === 'complete' && remaining.jobs.length === 0
    }, 'cleanup of test runtimes', 30_000)
    await jobs.recordTaskDispatchProviderStatus(dispatchId, providerJobId, 'not_found')
    await jobs.cancelTaskJob(identity.userId, identity.runId, identity.conversationId)
    assert.equal(await jobs.cleanupInternalTaskJob(identity.userId, identity.runId), true)
    if (realAgent) {
      const { destroyE2BSandbox } = await jiti.import('../src/lib/e2bSandbox.ts')
      await destroyE2BSandbox(identity.conversationId)
      const { tursoExecute } = await jiti.import('../src/lib/db/turso.ts')
      for (const table of ['credit_e2b_runtime_segments', 'credit_ledger', 'credit_accounts']) {
        await tursoExecute(`delete from ${table} where user_id = ?`, [identity.userId])
      }
    }
  }
}
