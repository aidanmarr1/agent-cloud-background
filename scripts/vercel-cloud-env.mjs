#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const target = readArg('--target') || 'production'
const applyAll = args.includes('--apply')
const applyAvailable = args.includes('--apply-available')
const apply = applyAll || applyAvailable
const verifyValues = args.includes('--verify-values') || args.includes('--verify')
const replaceDrift = args.includes('--replace-drift')
const json = args.includes('--json')
const vercelBin = process.env.VERCEL_CLI || 'vercel'

const CLOUD_ENV = [
  { name: 'AUTH_SECRET', source: 'local', required: true },
  { name: 'AGENT_INTERNAL_HEALTH_SECRET', source: 'local', required: true, hint: 'Generate one with npm run cloud:secrets, then add it locally and in Vercel.' },
  { name: 'AUTH_TRUST_HOST', value: 'true' },
  { name: 'AGENT_TRUST_PROXY_HEADERS', value: 'true' },
  { name: 'TURSO_DATABASE_URL', source: 'local', required: true },
  { name: 'TURSO_AUTH_TOKEN', source: 'local', required: true },
  { name: 'OPENROUTER_API_KEY', source: 'local', required: true },
  { name: 'BRAVE_SEARCH_API_KEY', source: 'local', required: false },
  { name: 'OPENROUTER_MODEL', value: process.env.OPENROUTER_MODEL || 'openai/gpt-5.4-mini' },
  { name: 'OPENROUTER_REASONING_EFFORT', value: process.env.OPENROUTER_REASONING_EFFORT || 'minimal' },
  { name: 'OPENROUTER_REASONING_EXCLUDE', value: process.env.OPENROUTER_REASONING_EXCLUDE || 'true' },
  { name: 'AGENT_STORAGE_DRIVER', value: 'turso' },
  { name: 'AGENT_TASK_WORKER_MODE', value: 'external' },
  { name: 'AGENT_TASK_QUEUE_NAME', value: 'production' },
  { name: 'AGENT_TASK_WORKER_HEARTBEAT_MS', value: '15000' },
  { name: 'AGENT_TASK_WORKER_STALE_MS', value: '60000' },
  { name: 'AGENT_TASK_WORKER_MAX_ATTEMPTS', value: process.env.AGENT_TASK_WORKER_MAX_ATTEMPTS || '3' },
  { name: 'AGENT_DEPLOYMENT_VERSION', source: 'local', required: false },
  { name: 'AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION', value: process.env.AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION || 'false' },
  { name: 'AGENT_REQUIRE_TASK_WORKER_HEARTBEAT', value: 'true' },
  { name: 'AGENT_SANDBOX_PROVIDER', value: 'e2b' },
  { name: 'E2B_API_KEY', source: 'local', required: true, hint: 'Create an E2B runtime API key and set E2B_API_KEY locally before applying.' },
  { name: 'E2B_TEMPLATE_ID', value: 'agent-cloud-browser' },
  { name: 'AGENT_E2B_SANDBOX_TIMEOUT_MS', value: '3600000' },
  { name: 'AGENT_E2B_COMMAND_TIMEOUT_MS', value: '120000' },
  { name: 'AGENT_E2B_ALLOW_INTERNET', value: 'true' },
  { name: 'AGENT_E2B_PAUSE_ON_TASK_END', value: 'true' },
  { name: 'AGENT_E2B_KILL_ON_RESET', value: 'true' },
  { name: 'AGENT_E2B_BROWSER_PORT', value: '9222' },
  { name: 'AGENT_E2B_BROWSER_START_TIMEOUT_MS', value: '30000' },
  { name: 'AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS', value: '30000' },
  { name: 'AGENT_E2B_WARM_POOL_ENABLED', value: 'true' },
]

loadLocalEnv()

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function loadLocalEnv() {
  for (const fileName of ['.env.local', '.env.production', '.env']) {
    const envPath = resolve(process.cwd(), fileName)
    if (!existsSync(envPath)) continue
    const text = readFileSync(envPath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals === -1) continue
      const key = trimmed.slice(0, equals).trim()
      let value = trimmed.slice(equals + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = value
    }
  }
}

function parseEnvFile(text) {
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals === -1) continue
    const key = trimmed.slice(0, equals).trim()
    let value = trimmed.slice(equals + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function runVercel(commandArgs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(vercelBin, commandArgs, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${vercelBin} ${commandArgs.join(' ')} failed with ${signal || `code ${code}`}\n${stderr || stdout}`))
    })
    if (typeof input === 'string') child.stdin.end(input)
    else child.stdin.end()
  })
}

function parseEnvNames(output) {
  const names = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z][A-Z0-9_]+)\s+/)
    if (match && match[1] !== 'NAME') names.add(match[1])
  }
  return names
}

function parseEnvNamesFromJson(output) {
  try {
    const parsed = JSON.parse(output.slice(output.indexOf('{')))
    if (!Array.isArray(parsed.envs)) return null
    return new Set(parsed.envs.map((row) => row?.key).filter((key) => typeof key === 'string'))
  } catch {
    return null
  }
}

async function pullVercelEnvValues() {
  const tempDir = mkdtempSync(join(tmpdir(), 'agent-vercel-env-'))
  const tempFile = join(tempDir, '.env.pulled')
  try {
    await runVercel(['env', 'pull', tempFile, '--environment', target, '--yes'])
    return parseEnvFile(readFileSync(tempFile, 'utf8'))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function valueFor(entry) {
  if ('value' in entry) return String(entry.value)
  const value = process.env[entry.name]?.trim()
  return value || ''
}

function normalizedCompareValue(value) {
  return String(value ?? '').trim()
}

function safeStatusRows(existingNames, pulledValues) {
  return CLOUD_ENV.map((entry) => {
    const exists = existingNames.has(entry.name)
    const expectedValue = valueFor(entry)
    const hasLocalValue = Boolean(expectedValue)
    const valueChecked = exists && Boolean(pulledValues) && hasLocalValue && 'value' in entry
    const valueMatches = valueChecked
      ? normalizedCompareValue(pulledValues.get(entry.name)) === normalizedCompareValue(expectedValue)
      : null
    return {
      name: entry.name,
      target,
      exists,
      canApply: (!exists || valueMatches === false) && hasLocalValue,
      missingLocalValue: !exists && !hasLocalValue,
      valueChecked,
      valueMatches,
      valueMismatch: valueMatches === false,
      required: entry.required === true,
      hint: !exists && !hasLocalValue && entry.required === true
        ? entry.hint || `Set ${entry.name} locally before applying.`
        : undefined,
    }
  })
}

function printReport(rows) {
  if (json) {
    console.log(JSON.stringify({ target, apply, rows }, null, 2))
    return
  }

  console.log(`Vercel ${target} cloud env report`)
  console.log('Values are intentionally not printed.')
  if (verifyValues) console.log('Value verification used a private temp file and deleted it.')
  for (const row of rows) {
    const state = row.exists
      ? row.valueMismatch
        ? 'present, value differs'
        : row.valueChecked
          ? 'present, value matches'
          : 'present'
      : row.canApply
        ? 'missing, local value/default available'
        : row.required
          ? 'missing, local value required'
          : 'missing, optional local value not set'
    console.log(`${state.padEnd(40)} ${row.name}`)
    if (row.hint) console.log(`  ${row.hint}`)
  }
}

const listed = await runVercel(['env', 'ls', target, '--format', 'json'])
const existingNames = parseEnvNamesFromJson(listed.stdout) || parseEnvNames(`${listed.stdout}\n${listed.stderr}`)
const pulledValues = verifyValues ? await pullVercelEnvValues() : null
const rows = safeStatusRows(existingNames, pulledValues)
printReport(rows)

if (!apply) {
  const missing = rows.filter((row) => !row.exists)
  if (missing.length > 0 && !json) {
    console.log('\nDry run only. Re-run with --apply after the missing local secret values exist.')
    console.log('Use --apply-available to add only fixed defaults and locally available values while required secrets are still missing.')
    console.log('After applying env changes, redeploy the web service and rerun cloud:worker-ready.')
  }
  process.exit(0)
}

const blockers = rows.filter((row) => row.missingLocalValue && row.required)
if (applyAll && blockers.length > 0) {
  console.error(`Cannot apply: ${blockers.length} required value(s) are missing locally.`)
  process.exitCode = 1
  process.exit()
}

let added = 0
let replaced = 0
for (const entry of CLOUD_ENV) {
  const row = rows.find((item) => item.name === entry.name)
  if (existingNames.has(entry.name)) {
    if (!row?.valueMismatch) continue
    if (!replaceDrift) continue
    console.log(`Replacing ${entry.name} in Vercel ${target}`)
    await runVercel(['env', 'rm', entry.name, target, '--yes'])
    replaced += 1
  }
  const value = valueFor(entry)
  if (!value) continue
  console.log(`Adding ${entry.name} to Vercel ${target}`)
  await runVercel(['env', 'add', entry.name, target], value)
  added += 1
}

const drift = rows.filter((row) => row.valueMismatch)
console.log(`Vercel cloud env apply finished. Added ${added} variable(s), replaced ${replaced} variable(s). Redeploy production so the new environment is active.`)
if (drift.length > replaced) {
  const unrepaired = drift.filter((row) => row.canApply).map((row) => row.name)
  if (unrepaired.length > 0) console.log(`Detected value drift not replaced without --replace-drift: ${unrepaired.join(', ')}`)
}
if (applyAvailable && blockers.length > 0) {
  console.log(`${blockers.length} required secret value(s) are still missing locally: ${blockers.map((row) => row.name).join(', ')}`)
}
