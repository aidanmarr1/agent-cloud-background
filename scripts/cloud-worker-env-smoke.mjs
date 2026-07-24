#!/usr/bin/env node

import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const allowDummy = args.includes('--allow-dummy')

loadLocalEnvFiles(rootUrl)

const failures = []
const warnings = []
const passes = []

function env(name) {
  return process.env[name]?.trim() || ''
}

function pass(message) {
  passes.push(message)
}

function warn(message) {
  warnings.push(message)
}

function fail(message) {
  failures.push(message)
}

function isPlaceholder(value) {
  if (!value) return true
  if (allowDummy) return false
  return /^(?:dummy|test|example|placeholder|changeme|change-me|todo|xxx|your[-_]?.+|\.\.\.)$/i.test(value) ||
    /(?:dummy|placeholder|changeme|replace[-_ ]?me|your[-_ ]?(?:key|token|secret|url))/i.test(value)
}

function requireRealEnv(name, reason, validator) {
  const value = env(name)
  if (!value) {
    fail(`${name} is missing (${reason})`)
    return
  }
  if (isPlaceholder(value)) {
    fail(`${name} looks like a placeholder; set the real ${reason}`)
    return
  }
  if (validator && !validator(value)) {
    fail(`${name} is set but does not look valid for ${reason}`)
    return
  }
  pass(`${name} is set`)
}

function requireExact(name, expected, reason) {
  const value = env(name)
  if (value === expected) pass(`${name}=${expected}`)
  else fail(`${name} must be ${expected} (${reason})`)
}

function requireExactBool(name, expected, reason) {
  const value = env(name).toLowerCase()
  const normalized = value || (expected ? 'true' : 'false')
  const matches = expected
    ? normalized === 'true' || normalized === '1'
    : normalized === 'false' || normalized === '0'
  if (matches) pass(`${name}=${expected ? 'true' : 'false'}`)
  else fail(`${name} must be ${expected ? 'true' : 'false'} (${reason})`)
}

function validateQueueName(value) {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
}

function validateTursoUrl(value) {
  return /^libsql:\/\/.+/i.test(value) || /^https:\/\/.+/i.test(value)
}

function validateNonShortToken(value) {
  return value.length >= 20
}

function validatePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0
}

requireExact('AGENT_TASK_WORKER_MODE', 'external', 'worker must claim durable cloud jobs')
requireRealEnv('AGENT_TASK_QUEUE_NAME', 'worker queue namespace', validateQueueName)
if (env('AGENT_TASK_QUEUE_NAME') === 'default') {
  fail('AGENT_TASK_QUEUE_NAME must not be default on a deployed worker; use production, staging, or another explicit namespace')
}

requireRealEnv('TURSO_DATABASE_URL', 'Turso task queue URL', validateTursoUrl)
requireRealEnv('TURSO_AUTH_TOKEN', 'Turso task queue token', validateNonShortToken)
requireExact('LLM_PROVIDER', 'openrouter', 'OpenRouter model provider')
requireRealEnv('OPENROUTER_API_KEY', 'OpenRouter API key for task execution', validateNonShortToken)
requireExact('OPENROUTER_MODEL', 'google/gemini-3.6-flash:nitro', 'Gemini 3.6 Flash Nitro route')
requireExact('OPENROUTER_REASONING_EFFORT', 'minimal', 'lowest supported reasoning effort')
requireExact('OPENROUTER_REASONING_EXCLUDE', 'true', 'hidden reasoning must stay out of the response')
requireExact('AGENT_SANDBOX_PROVIDER', 'e2b', 'hosted E2B task sandbox execution')
requireExact('AGENT_REQUIRE_HOSTED_TASK_WORKER', 'false', 'local workers may satisfy production readiness')
requireRealEnv('E2B_API_KEY', 'E2B hosted sandbox API key', validateNonShortToken)
if (env('E2B_TEMPLATE_ID') || env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')) {
  pass('E2B browser runtime is configured')
} else {
  fail('E2B_TEMPLATE_ID or AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND must be set')
}
requireExactBool('AGENT_E2B_PAUSE_ON_TASK_END', false, 'finished tasks must destroy their E2B sandbox instead of pausing it')
requireExactBool('AGENT_E2B_KILL_ON_RESET', true, 'each new task must start from a fresh E2B sandbox')
requireExactBool('AGENT_E2B_WARM_POOL_ENABLED', false, 'tasks must not reuse a warm sandbox')
requireExactBool('AGENT_E2B_VERIFY_ON_WORKER_STARTUP', true, 'hosted worker should prove E2B command execution before serving tasks')
requireExactBool('AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP', true, 'hosted worker should prove E2B browser readiness before serving tasks')
requireRealEnv('SERPER_API_KEY', 'Serper web and image search API key', validateNonShortToken)

const storageDriver = env('AGENT_STORAGE_DRIVER') || 'turso'
if (storageDriver === 'turso') pass('AGENT_STORAGE_DRIVER=turso')
else fail('AGENT_STORAGE_DRIVER must be turso so task files survive web/worker restarts')

if (['true', '1'].includes(env('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION').toLowerCase())) {
  requireRealEnv('AGENT_DEPLOYMENT_VERSION', 'web/worker deployment version match')
} else if (env('AGENT_DEPLOYMENT_VERSION')) {
  warn('AGENT_DEPLOYMENT_VERSION is set but AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION is not true; readiness will report it but not enforce it')
} else {
  warn('AGENT_DEPLOYMENT_VERSION is not set; set it with AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION=true if you need stale-worker rejection')
}

if (!env('AGENT_TASK_WORKER_ID')) {
  warn('AGENT_TASK_WORKER_ID is not set; the worker will generate a unique ID at startup')
} else {
  pass('AGENT_TASK_WORKER_ID is set')
}

for (const name of [
  'AGENT_TASK_WORKER_POLL_MS',
  'AGENT_TASK_WORKER_HEARTBEAT_MS',
  'AGENT_TASK_WORKER_STALE_MS',
  'AGENT_TASK_WORKER_MAX_ATTEMPTS',
  'AGENT_E2B_SANDBOX_TIMEOUT_MS',
  'AGENT_E2B_COMMAND_TIMEOUT_MS',
  'AGENT_E2B_BROWSER_PORT',
  'AGENT_E2B_BROWSER_START_TIMEOUT_MS',
  'AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS',
]) {
  const value = env(name)
  if (!value) {
    warn(`${name} is not set; the worker will use its built-in default`)
  } else if (validatePositiveInteger(value)) {
    pass(`${name}=${value}`)
  } else {
    fail(`${name} must be a positive integer`)
  }
}

console.log('\nCloud worker environment smoke report')
console.log('=====================================')
for (const message of passes) console.log(`PASS ${message}`)
for (const message of warnings) console.log(`WARN ${message}`)
for (const message of failures) console.log(`FAIL ${message}`)

if (failures.length > 0) {
  console.log(`\n${failures.length} worker env issue(s) found. Do not start npm run worker:cloud on this host yet.`)
  process.exitCode = 1
} else {
  console.log('\nCloud worker environment values look ready for npm run worker:cloud.')
}
