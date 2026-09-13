#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
import { SandboxNotFoundError } from 'e2b'

const jiti = createJiti(import.meta.url, { nativeModules: ['e2b'], alias: { 'server-only': fileURLToPath(new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url)), '@': fileURLToPath(new URL('../src', import.meta.url)) } })
const { e2bTaskRuntimeProvider, taskRuntimeEnvironment } = await jiti.import('../src/lib/agent/e2bTaskRuntime.ts')
const { getTaskDispatchConfigurationStatus, usesOnDemandTaskDispatch } = await jiti.import('../src/lib/agent/taskDispatch.ts')
const { isLikelyLocalWorkerHostname } = await jiti.import('../src/lib/agent/taskWorkerHeartbeat.ts')
assert.equal(isLikelyLocalWorkerHostname('e2b.local'), false)
for (const hostname of ['localhost', '127.0.0.1', 'my-macbook.local', 'desktop.localdomain']) {
  assert.equal(isLikelyLocalWorkerHostname(hostname), true)
}
process.env.AGENT_TASK_QUEUE_NAME = 'e2b-provider-smoke'
process.env.AGENT_TASK_DISPATCH_MODE = 'e2b_job'
process.env.E2B_API_KEY = 'test-only'
process.env.E2B_TASK_RUNTIME_TEMPLATE = 'test-template'
process.env.E2B_TASK_RUNTIME_REVISION = 'a'.repeat(64)
delete process.env.RENDER_API_KEY
delete process.env.RENDER_WORKER_SERVICE_ID
delete process.env.RENDER_ON_DEMAND_JOB_PLAN_ID
assert.equal(usesOnDemandTaskDispatch(), true)
assert.equal(getTaskDispatchConfigurationStatus().configured, true)
assert.equal(getTaskDispatchConfigurationStatus().backend, 'e2b-task-runtime')
const env = taskRuntimeEnvironment('run1', 'sandbox1')
assert.equal(env.RENDER_API_KEY, undefined)
assert.equal(env.AGENT_E2B_WARM_POOL_ENABLED, 'false')
assert.equal(env.AGENT_E2B_VERIFY_ON_WORKER_STARTUP, 'false')
assert.equal(env.AGENT_TASK_WORKER_ID, 'e2b-task-run1')

let creates = 0, kills = 0, failStart = false, failKill = false, revision = 'a'.repeat(64)
let info = { sandboxId: 'sandbox1', state: 'running', startedAt: new Date(), metadata: {
  app: 'agent', role: 'task-runtime', queue: 'e2b-provider-smoke:orchestration-v4', runId: 'run1',
} }
let createOptions
const runtime = {
  sandboxId: 'sandbox1', files: { read: async () => revision },
  commands: { run: async (command, options) => {
    assert.equal(command, 'node scripts/e2b-task-runtime.mjs run1')
    assert.equal(options.background, true)
    if (failStart) throw new Error('lost launch acknowledgement')
  } },
  kill: async () => { kills++; if (failKill) throw new Error('unknown kill'); return true },
}
const sdk = {
  create: async (_template, options) => { creates++; createOptions = options; return runtime },
  getInfo: async () => { if (!info) throw new SandboxNotFoundError('not found'); return info },
  kill: runtime.kill,
  list: options => {
    assert.equal(options.query.metadata.runId, 'run1')
    let hasNext = true
    return { get hasNext() { return hasNext }, nextItems: async () => { hasNext = false; return info ? [info] : [] } }
  },
}
const provider = e2bTaskRuntimeProvider(sdk)
assert.equal(await provider.launch('run1', 'e2b:run1:1'), 'e2b:sandbox1')
assert.equal(creates, 1)
assert.equal(createOptions.timeoutMs, 60_000)
assert.equal(createOptions.network.allowPublicTraffic, false)
assert.deepEqual(createOptions.lifecycle, { onTimeout: 'kill', autoResume: false })
assert.equal(createOptions.envs, undefined, 'no credentials baked into startup/template environment')
assert.equal((await provider.list('run1')).jobs.length, 1)
assert.equal((await provider.retrieve('e2b:sandbox1')).outcome, 'found')
failStart = true
await assert.rejects(provider.launch('run1', 'e2b:run1:2'), error => error.launchDisposition === 'known_rejection')
assert.equal(kills, 1)
failKill = true
await assert.rejects(provider.launch('run1', 'e2b:run1:3'), error => error.launchDisposition === 'ambiguous')
failKill = false; failStart = false; revision = 'b'.repeat(64)
await assert.rejects(provider.launch('run1', 'e2b:run1:4'), error => error.launchDisposition === 'known_rejection')
info = { ...info, metadata: { ...info.metadata, role: 'customer-computer' } }
const before = kills
assert.equal((await provider.cancel('e2b:sandbox1')).outcome, 'unknown')
assert.equal(kills, before, 'must never kill a customer computer through the runtime API')
info = null
assert.equal((await provider.retrieve('e2b:sandbox1')).outcome, 'not_found')
assert.equal((await provider.list('run1')).jobs.length, 0)
console.log('E2B runtime smoke passed: Render-free config, bounded startup, exact revision, unknown outcomes, queue isolation, cleanup.')
