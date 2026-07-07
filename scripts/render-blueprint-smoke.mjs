#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function parseValue(raw) {
  const trimmed = String(raw || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'false') return false
  if (trimmed === 'true') return true
  return trimmed
}

function parseRenderBlueprint(text) {
  const services = []
  let currentService = null
  let inEnvVars = false
  let currentEnvKey = null

  for (const line of text.split(/\r?\n/)) {
    const serviceMatch = line.match(/^  - type:\s*(.+)$/)
    if (serviceMatch) {
      currentService = {
        type: parseValue(serviceMatch[1]),
        env: new Map(),
      }
      services.push(currentService)
      inEnvVars = false
      currentEnvKey = null
      continue
    }

    if (!currentService) continue

    const servicePropMatch = line.match(/^    ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (servicePropMatch) {
      const [, key, value] = servicePropMatch
      if (key === 'envVars') {
        inEnvVars = true
        currentEnvKey = null
      } else {
        currentService[key] = parseValue(value)
        inEnvVars = false
        currentEnvKey = null
      }
      continue
    }

    if (!inEnvVars) continue

    const envKeyMatch = line.match(/^      - key:\s*(.+)$/)
    if (envKeyMatch) {
      currentEnvKey = parseValue(envKeyMatch[1])
      currentService.env.set(currentEnvKey, {})
      continue
    }

    const envPropMatch = line.match(/^        (value|sync):\s*(.+)$/)
    if (envPropMatch && currentEnvKey) {
      const [, key, value] = envPropMatch
      currentService.env.get(currentEnvKey)[key] = parseValue(value)
    }
  }

  return { services }
}

function envValue(service, key) {
  return service.env.get(key)?.value
}

function envSync(service, key) {
  return service.env.get(key)?.sync
}

function requireEnv(service, key, description) {
  assert.ok(service.env.has(key), `${service.name} must define ${key} (${description})`)
}

function requireSecret(service, key) {
  requireEnv(service, key, 'secret value supplied in Render dashboard')
  assert.equal(envSync(service, key), false, `${service.name} ${key} must use sync: false`)
}

function requireValue(service, key, expected) {
  requireEnv(service, key, `expected ${expected}`)
  assert.equal(envValue(service, key), expected, `${service.name} ${key} must equal ${expected}`)
}

const blueprintPath = resolve(process.cwd(), 'render.yaml')
const blueprint = parseRenderBlueprint(readFileSync(blueprintPath, 'utf8'))

assert.equal(blueprint.services.length, 2, 'render.yaml must define exactly one web service and one worker service')

const web = blueprint.services.find((service) => service.type === 'web')
const worker = blueprint.services.find((service) => service.type === 'worker')
assert.ok(web, 'render.yaml must define a web service')
assert.ok(worker, 'render.yaml must define a worker service')

assert.equal(web.name, 'agent-web', 'web service must be named agent-web')
assert.equal(worker.name, 'agent-worker', 'worker service must be named agent-worker')
assert.equal(web.runtime, 'node', 'web service must use Render node runtime')
assert.equal(worker.runtime, 'node', 'worker service must use Render node runtime')
assert.equal(web.region, 'singapore', 'web service should run near the Turso ap-south database')
assert.equal(worker.region, 'singapore', 'worker service should run near the Turso ap-south database')
assert.equal(web.buildCommand, 'npm ci && npm run build', 'web service must build the production app')
assert.equal(worker.buildCommand, 'npm ci && npm run build', 'worker service must build the same production app')
assert.equal(web.startCommand, 'npm start', 'web service must start Next.js')
assert.equal(worker.startCommand, 'npm run worker:cloud', 'worker service must validate env before starting the task worker')
assert.equal(web.healthCheckPath, '/api/health', 'web service must use the public health endpoint')
assert.ok(Number(worker.maxShutdownDelaySeconds) >= 300, 'worker service should use a long shutdown window for graceful handoff')

for (const service of [web, worker]) {
  for (const key of ['AUTH_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'E2B_API_KEY']) {
    requireSecret(service, key)
  }
  requireValue(service, 'NODE_VERSION', '22')
  requireValue(service, 'NODE_ENV', 'production')
  requireValue(service, 'AUTH_TRUST_HOST', 'true')
  requireValue(service, 'AGENT_TRUST_PROXY_HEADERS', 'true')
  requireValue(service, 'LLM_PROVIDER', 'openrouter')
  requireValue(service, 'DEEPSEEK_MODEL', 'deepseek-v4-flash')
  requireValue(service, 'DEEPSEEK_REASONING_EFFORT', 'high')
  requireValue(service, 'DEEPSEEK_THINKING_ENABLED', 'true')
  requireValue(service, 'OPENROUTER_MODEL', 'google/gemini-3.1-flash-lite')
  requireValue(service, 'OPENROUTER_REASONING_EFFORT', 'high')
  requireValue(service, 'OPENROUTER_REASONING_EXCLUDE', 'true')
  requireValue(service, 'AGENT_STORAGE_DRIVER', 'turso')
  requireValue(service, 'AGENT_TASK_WORKER_MODE', 'external')
  requireValue(service, 'AGENT_TASK_QUEUE_NAME', 'production')
  requireValue(service, 'AGENT_TASK_WORKER_HEARTBEAT_MS', '15000')
  requireValue(service, 'AGENT_TASK_WORKER_STALE_MS', '60000')
  requireValue(service, 'AGENT_TASK_WORKER_MAX_ATTEMPTS', '3')
  requireValue(service, 'AGENT_DEPLOYMENT_VERSION', '')
  requireValue(service, 'AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION', 'false')
  requireValue(service, 'AGENT_REQUIRE_TASK_WORKER_HEARTBEAT', 'true')
  requireValue(service, 'AGENT_REQUIRE_HOSTED_TASK_WORKER', 'true')
  requireValue(service, 'AGENT_SANDBOX_PROVIDER', 'e2b')
  requireValue(service, 'E2B_TEMPLATE_ID', 'agent-cloud-browser')
  requireValue(service, 'AGENT_E2B_PAUSE_ON_TASK_END', 'true')
  requireValue(service, 'AGENT_E2B_WARM_POOL_ENABLED', 'false')
}

requireSecret(web, 'AGENT_INTERNAL_HEALTH_SECRET')
requireValue(worker, 'AGENT_TASK_WORKER_ID', 'render-worker-1')
requireValue(worker, 'AGENT_TASK_WORKER_POLL_MS', '100')
requireValue(worker, 'AGENT_E2B_VERIFY_ON_WORKER_STARTUP', 'true')
requireValue(worker, 'AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP', 'true')

for (const key of [
  'AGENT_TASK_QUEUE_NAME',
  'AGENT_TASK_WORKER_MODE',
  'AGENT_TASK_WORKER_HEARTBEAT_MS',
  'AGENT_TASK_WORKER_STALE_MS',
  'AGENT_TASK_WORKER_MAX_ATTEMPTS',
  'AGENT_DEPLOYMENT_VERSION',
  'AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION',
  'AGENT_REQUIRE_TASK_WORKER_HEARTBEAT',
  'AGENT_REQUIRE_HOSTED_TASK_WORKER',
  'AGENT_STORAGE_DRIVER',
  'AGENT_SANDBOX_PROVIDER',
  'E2B_TEMPLATE_ID',
  'AGENT_E2B_PAUSE_ON_TASK_END',
  'AGENT_E2B_WARM_POOL_ENABLED',
]) {
  assert.equal(envValue(web, key), envValue(worker, key), `${key} must match between web and worker`)
}

console.log('Render blueprint smoke checks passed')
