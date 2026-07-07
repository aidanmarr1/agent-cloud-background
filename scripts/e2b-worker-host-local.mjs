#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Sandbox } from 'e2b'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const DEFAULT_TEMPLATE = 'agent-cloud-browser'
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

loadLocalEnvFiles(rootUrl)

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function env(name) {
  return process.env[name]?.trim() || ''
}

function requireEnv(name, reason) {
  const value = env(name)
  if (!value) throw new Error(`${name} is required (${reason}).`)
  return value
}

function envOrDefault(name, fallback) {
  return env(name) || fallback
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function optionalEnv(name) {
  const value = env(name)
  return value ? { [name]: value } : {}
}

function envFileContent(envs) {
  return `${Object.entries(envs)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, '')}`)
    .join('\n')}\n`
}

function workerEnvs(workerId) {
  return {
    ...optionalEnv('AUTH_SECRET'),
    ...optionalEnv('AGENT_INTERNAL_HEALTH_SECRET'),
    TURSO_DATABASE_URL: requireEnv('TURSO_DATABASE_URL', 'durable task queue'),
    TURSO_AUTH_TOKEN: requireEnv('TURSO_AUTH_TOKEN', 'durable task queue auth'),
    LLM_PROVIDER: 'openrouter',
    ...optionalEnv('DEEPSEEK_API_KEY'),
    DEEPSEEK_MODEL: envOrDefault('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
    DEEPSEEK_REASONING_EFFORT: envOrDefault('DEEPSEEK_REASONING_EFFORT', 'high'),
    DEEPSEEK_THINKING_ENABLED: envOrDefault('DEEPSEEK_THINKING_ENABLED', 'true'),
    OPENROUTER_API_KEY: requireEnv('OPENROUTER_API_KEY', 'task LLM calls'),
    SERPER_API_KEY: requireEnv('SERPER_API_KEY', 'Serper web and image search'),
    SERPER_BASE_URL: envOrDefault('SERPER_BASE_URL', 'https://google.serper.dev'),
    OPENROUTER_MODEL: envOrDefault('OPENROUTER_MODEL', 'google/gemini-3.1-flash-lite'),
    OPENROUTER_REASONING_EFFORT: envOrDefault('OPENROUTER_REASONING_EFFORT', 'minimal'),
    OPENROUTER_REASONING_EXCLUDE: envOrDefault('OPENROUTER_REASONING_EXCLUDE', 'true'),
    AGENT_STORAGE_DRIVER: 'turso',
    AGENT_TASK_WORKER_MODE: 'external',
    AGENT_TASK_QUEUE_NAME: envOrDefault('AGENT_TASK_QUEUE_NAME', 'production'),
    AGENT_TASK_WORKER_ID: workerId,
    AGENT_TASK_WORKER_POLL_MS: envOrDefault('AGENT_TASK_WORKER_POLL_MS', '100'),
    AGENT_TASK_WORKER_HEARTBEAT_MS: envOrDefault('AGENT_TASK_WORKER_HEARTBEAT_MS', '15000'),
    AGENT_TASK_WORKER_STALE_MS: envOrDefault('AGENT_TASK_WORKER_STALE_MS', '60000'),
    AGENT_TASK_WORKER_MAX_ATTEMPTS: envOrDefault('AGENT_TASK_WORKER_MAX_ATTEMPTS', '3'),
    AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION: envOrDefault('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION', 'false'),
    ...optionalEnv('AGENT_DEPLOYMENT_VERSION'),
    AGENT_SANDBOX_PROVIDER: 'e2b',
    E2B_API_KEY: requireEnv('E2B_API_KEY', 'E2B worker host and per-task sandboxes'),
    E2B_TEMPLATE_ID: envOrDefault('E2B_TEMPLATE_ID', DEFAULT_TEMPLATE),
    AGENT_E2B_SANDBOX_TIMEOUT_MS: envOrDefault('AGENT_E2B_SANDBOX_TIMEOUT_MS', '3600000'),
    AGENT_E2B_COMMAND_TIMEOUT_MS: envOrDefault('AGENT_E2B_COMMAND_TIMEOUT_MS', '120000'),
    AGENT_E2B_ALLOW_INTERNET: envOrDefault('AGENT_E2B_ALLOW_INTERNET', 'true'),
    AGENT_E2B_PAUSE_ON_TASK_END: envOrDefault('AGENT_E2B_PAUSE_ON_TASK_END', 'true'),
    AGENT_E2B_KILL_ON_RESET: envOrDefault('AGENT_E2B_KILL_ON_RESET', 'true'),
    AGENT_E2B_BROWSER_PORT: envOrDefault('AGENT_E2B_BROWSER_PORT', '9222'),
    AGENT_E2B_BROWSER_START_TIMEOUT_MS: envOrDefault('AGENT_E2B_BROWSER_START_TIMEOUT_MS', '30000'),
    AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS: envOrDefault('AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS', '30000'),
    AGENT_E2B_WARM_POOL_ENABLED: envOrDefault('AGENT_E2B_WARM_POOL_ENABLED', 'false'),
    AGENT_E2B_VERIFY_ON_WORKER_STARTUP: envOrDefault('AGENT_E2B_VERIFY_ON_WORKER_STARTUP', 'true'),
    AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP: envOrDefault('AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP', 'true'),
  }
}

const archivePath = readArg('--archive') || '/private/tmp/agent-worker-source.tgz'
const template = readArg('--template') || env('E2B_WORKER_TEMPLATE_ID') || env('E2B_TEMPLATE_ID') || DEFAULT_TEMPLATE
const timeoutMs = positiveInt(readArg('--timeout-ms') || env('E2B_WORKER_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS)
const installTimeoutMs = positiveInt(readArg('--install-timeout-ms') || env('E2B_WORKER_INSTALL_TIMEOUT_MS'), 10 * 60 * 1000)
const workerId = readArg('--worker-id') || env('E2B_WORKER_ID') || `e2b-worker-local-${randomUUID().slice(0, 8)}`
const workdir = readArg('--workdir') || env('E2B_WORKER_WORKDIR') || '/home/user/agent-worker'
const apiKey = requireEnv('E2B_API_KEY', 'creating the E2B worker host sandbox')

console.log(`Creating E2B worker host sandbox from ${template}.`)
console.log('Uploading local source archive; secret values are not printed.')

const archive = await readFile(archivePath)
const sandbox = await Sandbox.create({
  template,
  apiKey,
  timeoutMs,
  allowInternetAccess: true,
  secure: true,
  network: {
    allowPublicTraffic: false,
  },
  metadata: {
    app: 'agent',
    role: 'background-worker-host',
    workerId,
    source: 'local-upload',
  },
})

try {
  const envs = workerEnvs(workerId)
  await sandbox.files.write('/tmp/agent-worker-source.tgz', archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength), {
    requestTimeoutMs: 120_000,
    useOctetStream: true,
  })

  const setupScript = `
set -e
rm -rf ${shellQuote(workdir)}
mkdir -p ${shellQuote(workdir)}
tar -xzf /tmp/agent-worker-source.tgz -C ${shellQuote(workdir)}
cd ${shellQuote(workdir)}
npm ci
`

  await sandbox.commands.run(setupScript, {
    timeoutMs: installTimeoutMs,
  })
  await sandbox.files.write(`${workdir}/.env.local`, envFileContent(envs))

  const startScript = `
set -e
cd ${shellQuote(workdir)}
set -a
. ./.env.local
set +a
nohup npm run worker:cloud > /tmp/agent-worker.log 2>&1 < /dev/null &
echo "$!" > /tmp/agent-worker.pid
sleep 10
if ! kill -0 "$(cat /tmp/agent-worker.pid)" 2>/dev/null; then
  tail -120 /tmp/agent-worker.log >&2 || true
  exit 1
fi
echo "worker-pid=$(cat /tmp/agent-worker.pid)"
tail -80 /tmp/agent-worker.log || true
`

  const started = await sandbox.commands.run(startScript, {
    timeoutMs: 60_000,
    envs,
  })

  console.log(JSON.stringify({
    ok: true,
    sandboxId: sandbox.sandboxId,
    workerId,
    queueName: envOrDefault('AGENT_TASK_QUEUE_NAME', 'production'),
    timeoutMs,
    archivePath,
    sourceBytes: archive.byteLength,
    startOutput: started.stdout.trim().split(/\r?\n/).slice(-20),
  }, null, 2))
} catch (error) {
  await sandbox.kill().catch(() => undefined)
  throw error
}
