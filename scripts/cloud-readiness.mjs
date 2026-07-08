#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const live = process.argv.includes('--live')

loadLocalEnvFiles(rootUrl)

const failures = []
const warnings = []
const passes = []

function env(name) {
  return process.env[name]?.trim() || ''
}

function envPositiveInt(name, fallback) {
  const parsed = Number.parseInt(env(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envBoolEnabled(name, fallback = false) {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value !== 'false' && value !== '0'
}

function envBoolExact(name, fallback = false) {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value === 'true' || value === '1'
}

function workerMatchesConfiguredRuntime(worker) {
  const expectedDeploymentVersion = env('AGENT_DEPLOYMENT_VERSION') || null
  const requireDeploymentVersion = envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')
  const versionMatches = !requireDeploymentVersion ||
    (!!expectedDeploymentVersion && worker.deploymentVersion === expectedDeploymentVersion)

  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() === 'e2b') {
    return worker.taskWorkerMode === 'external' &&
      worker.sandboxProvider === 'e2b' &&
      worker.e2bApiKeyConfigured === true &&
      worker.e2bBrowserRuntimeConfigured === true &&
      versionMatches
  }

  return versionMatches
}

function pass(message) {
  passes.push(message)
}

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

function requireEnv(name, reason) {
  if (env(name)) {
    pass(`${name} is set`)
  } else {
    fail(`${name} is missing (${reason})`)
  }
}

function requireFile(path, reason) {
  if (existsSync(fileURLToPath(new URL(path, rootUrl)))) {
    pass(`${path} exists`)
  } else {
    fail(`${path} is missing (${reason})`)
  }
}

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', rootUrl)), 'utf8'))
  } catch (error) {
    fail(`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function checkPackageScripts(pkg) {
  const scripts = pkg.scripts || {}
  for (const name of ['build', 'start', 'worker', 'worker:once', 'worker:cloud', 'cloud:secrets', 'cloud:env-smoke', 'cloud:worker-env', 'cloud:vercel-env', 'cloud:render-worker-env', 'cloud:e2b-smoke', 'cloud:queue', 'cloud:status', 'cloud:finish-setup', 'cloud:preflight', 'cloud:check', 'cloud:render-smoke', 'cloud:worker-template-smoke', 'cloud:smoke', 'cloud:reconnect-smoke', 'cloud:event-smoke', 'cloud:task-start-smoke', 'cloud:worker-lease-smoke', 'cloud:worker-cancel-smoke', 'cloud:worker-shutdown-smoke', 'cloud:worker-ready', 'cloud:worker-smoke', 'e2b:template:build']) {
    if (scripts[name]) pass(`package script "${name}" exists`)
    else fail(`package script "${name}" is missing`)
  }
}

function checkDependencies(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  for (const name of ['@tursodatabase/serverless', 'e2b', 'jiti', 'next']) {
    if (deps[name]) pass(`dependency "${name}" exists`)
    else fail(`dependency "${name}" is missing`)
  }
}

async function checkToolExposure() {
  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() !== 'e2b' || !env('E2B_API_KEY')) return

  const jiti = createJiti(import.meta.url, {
    alias: {
      '@': srcPath,
    },
  })
  const toolsPath = fileURLToPath(new URL('src/lib/tools.ts', rootUrl))
  const { toolDefinitions } = await jiti.import(toolsPath)
  const names = toolDefinitions.map((tool) => tool.function?.name).filter(Boolean)
  if (names.includes('execute_command')) {
    pass('execute_command is exposed in E2B mode')
  } else {
    fail('execute_command is not exposed even though AGENT_SANDBOX_PROVIDER=e2b and E2B_API_KEY are set')
  }
}

async function checkLiveDatabase() {
  if (!live) {
    warn('live Turso connectivity and worker heartbeat were not checked; run npm run cloud:check -- --live to test them')
    return
  }

  const jiti = createJiti(import.meta.url, {
    alias: {
      '@': srcPath,
    },
  })
  const { getTursoClient } = await jiti.import(fileURLToPath(new URL('src/lib/db/turso.ts', rootUrl)))
  const {
    getRecentTaskWorkerHeartbeats,
    workerHeartbeatIsHosted,
  } = await jiti.import(fileURLToPath(new URL('src/lib/agent/taskWorkerHeartbeat.ts', rootUrl)))
  try {
    const result = await getTursoClient().execute('select 1 as ok')
    if (result.rows.length >= 1) pass('live Turso connectivity works')
    else fail('live Turso connectivity returned no rows')
  } catch (error) {
    fail(`live Turso connectivity failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  try {
    const staleMs = envPositiveInt('AGENT_TASK_WORKER_STALE_MS', 60_000)
    const workers = await getRecentTaskWorkerHeartbeats(staleMs)
    if (workers.length > 0) {
      const requireHostedWorker = envBoolEnabled('AGENT_REQUIRE_HOSTED_TASK_WORKER', false)
      const compatibleWorkers = workers
        .filter(workerMatchesConfiguredRuntime)
        .filter((worker) => !requireHostedWorker || workerHeartbeatIsHosted(worker))
      if (compatibleWorkers.length > 0) {
        pass(`live compatible task worker heartbeat found: ${compatibleWorkers.map((worker) => `${worker.workerId}:${worker.status}`).join(', ')}`)
      } else if (envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')) {
        fail(`no live compatible task worker heartbeat matched AGENT_DEPLOYMENT_VERSION=${env('AGENT_DEPLOYMENT_VERSION') || '<missing>'}; redeploy the worker with the same AGENT_DEPLOYMENT_VERSION as the web service`)
      } else {
        fail('live task worker heartbeat exists, but no worker matches the configured E2B runtime; use AGENT_TASK_WORKER_MODE=external, AGENT_SANDBOX_PROVIDER=e2b, E2B_API_KEY, and E2B_TEMPLATE_ID or AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')
      }
    } else {
      fail(`no live E2B worker heartbeat found in the last ${staleMs}ms; start npm run worker:cloud or deploy a worker service`)
    }
  } catch (error) {
    fail(`live task worker heartbeat check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function checkEnvironment() {
  requireEnv('TURSO_DATABASE_URL', 'persistent task queue and event replay')
  requireEnv('TURSO_AUTH_TOKEN', 'persistent task queue and event replay')
  requireEnv('DEEPSEEK_API_KEY', 'agent LLM calls from the worker')
  requireEnv('AUTH_SECRET', 'auth/session signing')
  requireEnv('E2B_API_KEY', 'hosted E2B sandbox creation')

  if (env('AGENT_TASK_WORKER_MODE') === 'external') {
    pass('AGENT_TASK_WORKER_MODE=external')
  } else {
    fail('AGENT_TASK_WORKER_MODE must be set to external for tab-close-safe cloud execution')
  }

  const queueName = env('AGENT_TASK_QUEUE_NAME') || 'default'
  if (/^[a-zA-Z0-9_.:-]{1,128}$/.test(queueName)) {
    pass(`AGENT_TASK_QUEUE_NAME=${queueName}`)
  } else {
    fail('AGENT_TASK_QUEUE_NAME must be 1-128 letters, numbers, dots, colons, underscores, or hyphens')
  }

  if (env('AGENT_SANDBOX_PROVIDER').toLowerCase() === 'e2b') {
    pass('AGENT_SANDBOX_PROVIDER=e2b')
  } else {
    fail('AGENT_SANDBOX_PROVIDER must be set to e2b for hosted task sandboxes')
  }

  const storageDriver = env('AGENT_STORAGE_DRIVER')
  if (!storageDriver || storageDriver === 'turso') {
    pass('AGENT_STORAGE_DRIVER is compatible with cloud persistence')
  } else {
    warn(`AGENT_STORAGE_DRIVER=${storageDriver}; use turso in production so files survive web/worker restarts`)
  }

  if (envBoolEnabled('AGENT_REQUIRE_HOSTED_TASK_WORKER', false)) {
    warn('AGENT_REQUIRE_HOSTED_TASK_WORKER=true; production requires a hosted worker heartbeat')
  } else {
    pass('AGENT_REQUIRE_HOSTED_TASK_WORKER=false')
  }

  if (!envBoolExact('AGENT_E2B_PAUSE_ON_TASK_END', false)) {
    pass('AGENT_E2B_PAUSE_ON_TASK_END=false')
  } else {
    fail('AGENT_E2B_PAUSE_ON_TASK_END must be false because completed tasks should destroy their E2B sandbox')
  }

  if (envBoolExact('AGENT_E2B_KILL_ON_RESET', true)) {
    pass('AGENT_E2B_KILL_ON_RESET=true')
  } else {
    fail('AGENT_E2B_KILL_ON_RESET must be true so each task starts from a fresh E2B sandbox')
  }

  if (!envBoolExact('AGENT_E2B_WARM_POOL_ENABLED', false)) {
    pass('AGENT_E2B_WARM_POOL_ENABLED=false')
  } else {
    fail('AGENT_E2B_WARM_POOL_ENABLED must be false so tasks do not reuse warm sandboxes')
  }

  const requireHeartbeat = env('AGENT_REQUIRE_TASK_WORKER_HEARTBEAT').toLowerCase()
  if (!requireHeartbeat || requireHeartbeat === 'true' || requireHeartbeat === '1') {
    pass('task requests require a recent worker heartbeat')
  } else {
    warn('AGENT_REQUIRE_TASK_WORKER_HEARTBEAT is disabled; tasks may queue even when no worker is running')
  }

  if (env('AGENT_INTERNAL_HEALTH_SECRET')) {
    pass('AGENT_INTERNAL_HEALTH_SECRET is set for signed internal readiness and smoke probes')
  } else {
    warn('AGENT_INTERNAL_HEALTH_SECRET is not set; internal readiness and smoke probes will fall back to AUTH_SECRET')
  }

  if (envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')) {
    if (env('AGENT_DEPLOYMENT_VERSION')) {
      pass('AGENT_DEPLOYMENT_VERSION is set for stale-worker rejection')
    } else {
      fail('AGENT_DEPLOYMENT_VERSION must be set when AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true')
    }
  } else if (env('AGENT_DEPLOYMENT_VERSION')) {
    warn('AGENT_DEPLOYMENT_VERSION is set, but AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION is not true; stale-worker rejection is not enforced')
  } else {
    warn('AGENT_DEPLOYMENT_VERSION is not set; set it with AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true if you need stale-worker rejection across web and worker deploys')
  }

  if (env('E2B_TEMPLATE_ID') || env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')) {
    pass('E2B browser runtime source is configured')
  } else {
    fail('E2B_TEMPLATE_ID or AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND must be set for hosted browser tools')
  }
}

function checkFiles() {
  requireFile('scripts/task-worker.mjs', 'worker entrypoint')
  requireFile('scripts/cloud-secrets.mjs', 'cloud deployment secret generator')
  requireFile('scripts/cloud-env-smoke.mjs', 'strict cloud environment value checker')
  requireFile('scripts/cloud-worker-env-smoke.mjs', 'strict cloud worker host environment checker')
  requireFile('scripts/vercel-cloud-env.mjs', 'Vercel production cloud env drift checker')
  requireFile('scripts/render-worker-env.mjs', 'Render worker env API checker and applier')
  requireFile('scripts/e2b-template-smoke.mjs', 'live E2B template browser and terminal smoke command')
  requireFile('scripts/cloud-queue.mjs', 'Turso cloud queue inspection and diagnostic cleanup command')
  requireFile('scripts/cloud-production-status.mjs', 'single production setup status checker')
  requireFile('scripts/cloud-finish-setup.mjs', 'single-command post-E2B-key production setup finisher')
  requireFile('scripts/cloud-preflight.mjs', 'single-command cloud preflight runner')
  requireFile('scripts/render-blueprint-smoke.mjs', 'Render blueprint consistency smoke command')
  requireFile('scripts/render-worker-env-smoke.mjs', 'Render worker env template consistency smoke command')
  requireFile('scripts/cloud-event-replay-smoke.mjs', 'oversized event replay persistence smoke command')
  requireFile('scripts/cloud-task-start-persistence-smoke.mjs', 'immediate-close task history persistence smoke command')
  requireFile('scripts/cloud-worker-lease-smoke.mjs', 'worker stale lease retry smoke command')
  requireFile('scripts/cloud-worker-cancel-smoke.mjs', 'worker cancellation terminal-state smoke command')
  requireFile('scripts/cloud-worker-shutdown-smoke.mjs', 'worker graceful shutdown handoff smoke command')
  requireFile('scripts/prod-background-worker-ready.mjs', 'deployed worker readiness command')
  requireFile('scripts/prod-background-worker-smoke.mjs', 'deployed worker reconnect smoke command')
  requireFile('src/worker/taskWorker.ts', 'worker loop')
  requireFile('src/lib/agent/taskJobs.ts', 'durable task queue')
  requireFile('src/lib/e2bSandbox.ts', 'E2B cloud sandbox provider')
  requireFile('src/lib/browser.ts', 'browser tool runtime')
  requireFile('src/app/api/health/route.ts', 'public deployment health check endpoint')
  requireFile('src/app/api/internal/background-worker-smoke/route.ts', 'signed deployed worker reconnect smoke endpoint')
  requireFile('src/app/api/internal/background-worker-ready/route.ts', 'signed deployed worker readiness endpoint')
  requireFile('docs/cloud-background-tasks.md', 'operator setup guide')
  requireFile('Dockerfile', 'container deployment')
  requireFile('Procfile', 'multi-process platform deployment')
  requireFile('docker-compose.cloud.yml', 'local production-shaped web plus worker deployment')
  requireFile('render.yaml', 'Render web plus worker deployment blueprint')
  requireFile('render.worker.env.example', 'Render worker environment checklist')
  requireFile('.node-version', 'cloud Node.js version pin')
  requireFile('e2b.Dockerfile', 'E2B cloud sandbox browser template')
}

async function main() {
  const pkg = readPackageJson()
  checkPackageScripts(pkg)
  checkDependencies(pkg)
  checkFiles()
  checkEnvironment()
  await checkToolExposure()
  await checkLiveDatabase()

  console.log('\nCloud readiness report')
  console.log('======================')
  for (const message of passes) console.log(`PASS ${message}`)
  for (const message of warnings) console.log(`WARN ${message}`)
  for (const message of failures) console.log(`FAIL ${message}`)

  if (failures.length > 0) {
    console.log(`\n${failures.length} blocking readiness issue(s) found.`)
    process.exitCode = 1
    return
  }

  console.log('\nCloud background task configuration is ready.')
}

main().catch((error) => {
  console.error(`Cloud readiness check crashed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
