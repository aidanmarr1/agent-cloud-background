import { createHmac, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url))
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

loadLocalEnvFiles(rootUrl)

const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const port = readArg('--port') || '3100'
const timeoutMs = Number.parseInt(readArg('--timeout-ms') || '90000', 10)
const hostname = '127.0.0.1'
const queueName = `local-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`
const baseUrl = `http://${hostname}:${port}`
const readyPath = '/api/internal/background-worker-ready'
const smokePath = '/api/internal/background-worker-smoke'

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the local worker smoke.`)
  }
}

function createChildEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    NODE_ENV: 'production',
    PORT: port,
    HOSTNAME: hostname,
    AGENT_TASK_WORKER_MODE: 'external',
    AGENT_TASK_QUEUE_NAME: queueName,
    AGENT_TASK_WORKER_ID: `local-smoke-worker-${queueName}`,
    AGENT_TASK_WORKER_POLL_MS: '100',
    AGENT_TASK_WORKER_HEARTBEAT_MS: '500',
    AGENT_TASK_WORKER_STALE_MS: '5000',
    AGENT_REQUIRE_TASK_WORKER_HEARTBEAT: 'true',
    AGENT_SANDBOX_PROVIDER: process.env.AGENT_SANDBOX_PROVIDER || 'e2b',
    E2B_API_KEY: process.env.E2B_API_KEY || 'local-smoke-dummy',
    E2B_TEMPLATE_ID: process.env.E2B_TEMPLATE_ID || 'agent-cloud-browser',
    AGENT_E2B_PAUSE_ON_TASK_END: process.env.AGENT_E2B_PAUSE_ON_TASK_END || 'true',
  }
}

function runChecked(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: options.stdio || 'inherit',
      env: options.env || process.env,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed with ${signal || `code ${code}`}`))
    })
  })
}

function spawnService(label, command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    if (!fatalServiceError || !/ChunkLoadError|Cannot find module .*\.next|MODULE_NOT_FOUND/.test(text)) {
      process.stderr.write(`[${label}] ${chunk}`)
    }
    maybeRecordFatalServiceError(label, text, child)
  })
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      if (!fatalServiceError) fatalServiceError = new Error(`${label} exited with ${signal || `code ${code}`}`)
      process.stderr.write(`[${label}] exited with ${signal || `code ${code}`}\n`)
    }
  })
  return child
}

async function stopService(child, label) {
  if (!child || child.exitCode !== null || child.signalCode) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) return
    await sleep(100)
  }
  process.stderr.write(`[${label}] did not stop after SIGTERM; sending SIGKILL\n`)
  child.kill('SIGKILL')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWeb(deadline) {
  while (Date.now() < deadline) {
    if (fatalServiceError) throw fatalServiceError
    try {
      const response = await fetch(baseUrl)
      if (response.status < 500) return
    } catch {
      // Server is still starting.
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for web process at ${baseUrl}`)
}

async function callSignedEndpoint(path) {
  const timestamp = Date.now().toString()
  const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${path}`)
    .digest('hex')

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'x-agent-health-ts': timestamp,
      'x-agent-health-signature': signature,
    },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, ok: response.ok && body?.ok === true, body }
}

function endpointErrorText(body) {
  if (typeof body === 'string') return body
  if (typeof body !== 'object' || body === null) return ''
  const errors = Array.isArray(body.errors) ? body.errors.join('\n') : ''
  return [body.error, errors].filter(Boolean).join('\n')
}

async function waitForSignedEndpoint(path, deadline) {
  let lastResult = null
  while (Date.now() < deadline) {
    if (fatalServiceError) throw fatalServiceError
    lastResult = await callSignedEndpoint(path)
    if (lastResult.ok) return lastResult
    const error = endpointErrorText(lastResult.body)
    if (lastResult.status !== 503 || !/heartbeat/i.test(error)) return lastResult
    await sleep(750)
  }
  return lastResult || { status: 0, ok: false, body: { error: 'Timed out before smoke request completed.' } }
}

requireEnv('TURSO_DATABASE_URL')
requireEnv('TURSO_AUTH_TOKEN')
requireEnv('AUTH_SECRET')

if (!existsSync(nextBin)) {
  throw new Error('Next.js binary was not found. Run npm install first.')
}

if (!skipBuild) {
  console.log('Building production app before local external-worker smoke...')
  await runChecked(npmBin, ['run', 'build'], { env: createChildEnv() })
}

console.log(`Starting local external-worker smoke on isolated queue ${queueName}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

let web = null
let worker = null
let fatalServiceError = null

function maybeRecordFatalServiceError(label, text, child) {
  if (fatalServiceError) return
  if (label === 'web' && /ChunkLoadError|Cannot find module .*\.next|MODULE_NOT_FOUND/.test(text)) {
    fatalServiceError = new Error('The production build is stale or incomplete. Re-run npm run cloud:worker-smoke:local without --skip-build so Next.js rebuilds .next.')
    child.kill('SIGTERM')
  }
}

try {
  const env = createChildEnv()
  web = spawnService('web', process.execPath, [nextBin, 'start', '-H', hostname, '-p', port], env)
  worker = spawnService('worker', npmBin, ['run', 'worker'], env)

  const deadline = Date.now() + Math.max(30_000, timeoutMs)
  await waitForWeb(deadline)
  const ready = await waitForSignedEndpoint(readyPath, deadline)
  console.log(JSON.stringify({
    isolatedQueue: queueName,
    readinessStatus: ready.status,
    readiness: ready.body,
  }, null, 2))

  if (!ready.ok) {
    process.exitCode = 1
  } else {
    const result = await waitForSignedEndpoint(smokePath, deadline)
    console.log(JSON.stringify({
      isolatedQueue: queueName,
      status: result.status,
      body: result.body,
    }, null, 2))

    if (!result.ok) {
      process.exitCode = 1
    }
  }
} catch (error) {
  process.exitCode = 1
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
} finally {
  await stopService(worker, 'worker')
  await stopService(web, 'web')
}
