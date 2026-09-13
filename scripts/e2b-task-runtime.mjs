#!/usr/bin/env node
// Trusted per-task process. Never run model-generated commands in this VM.
import { spawn } from 'node:child_process'
import { Sandbox } from 'e2b'

const runId = process.argv[2]
const runtimeId = process.env.AGENT_E2B_TASK_RUNTIME_ID
if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId || '') || !runtimeId) {
  throw new Error('An exact task run and runtime sandbox are required.')
}
const apiOptions = { apiKey: process.env.E2B_API_KEY, requestTimeoutMs: 15_000 }
// Bound the entire VM lifetime, including startup, cleanup and any ignored
// abort. The normal worker has a 15-minute task deadline inside this backstop.
try {
  await Sandbox.setTimeout(runtimeId, 20 * 60_000, apiOptions)
  const child = spawn(process.execPath, ['scripts/task-worker.mjs', '--drain', '--run-id', runId], {
    cwd: '/opt/agent', env: process.env, stdio: 'inherit',
  })
  process.once('SIGTERM', () => child.kill('SIGTERM'))
  process.once('SIGINT', () => child.kill('SIGINT'))
  await new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
} finally {
  // Stop billing immediately after process exit. Workflow reconciliation and
  // the provider timeout remain independent cleanup backstops.
  await Sandbox.kill(runtimeId, apiOptions)
}
