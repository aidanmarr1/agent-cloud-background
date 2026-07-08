#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const nodeBin = process.execPath

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

function envPresent(name) {
  return Boolean(env(name))
}

function envBoolEnabled(name, fallback = false) {
  const value = env(name).toLowerCase()
  if (!value) return fallback
  return value !== 'false' && value !== '0'
}

function runNodeScript(scriptPath, scriptArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [scriptPath, ...scriptArgs], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => resolve({ ok: false, stdout, stderr: error.message, code: 1 }))
    child.on('exit', (code, signal) => resolve({
      ok: code === 0,
      stdout,
      stderr,
      code: code ?? 1,
      signal,
    }))
  })
}

async function checkVercelEnv() {
  const result = await runNodeScript('scripts/vercel-cloud-env.mjs', ['--json', '--verify-values'])
  if (!result.ok) {
    return {
      ok: false,
      checked: false,
      error: result.stderr.trim() || result.stdout.trim() || `vercel-cloud-env failed with code ${result.code}`,
    }
  }

  try {
    const parsed = JSON.parse(result.stdout)
    const missing = parsed.rows.filter((row) => !row.exists)
    const missingRequired = missing.filter((row) => row.required)
    const missingOptional = missing.filter((row) => !row.required)
    const valueMismatches = parsed.rows.filter((row) => row.valueMismatch)
    const valueMismatchesRequired = valueMismatches.filter((row) => row.required)
    return {
      ok: missingRequired.length === 0 && valueMismatchesRequired.length === 0,
      checked: true,
      target: parsed.target,
      missing: missing.map((row) => row.name),
      missingRequired: missingRequired.map((row) => row.name),
      missingOptional: missingOptional.map((row) => row.name),
      valueMismatches: valueMismatches.map((row) => row.name),
      valueMismatchesRequired: valueMismatchesRequired.map((row) => row.name),
      canApply: parsed.rows.filter((row) => row.canApply).map((row) => row.name),
    }
  } catch (error) {
    return {
      ok: false,
      checked: false,
      error: `Could not parse Vercel env report: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function checkReadiness(baseUrl, timeoutMs) {
  const secret = env('AGENT_INTERNAL_HEALTH_SECRET') || env('AUTH_SECRET')
  if (!secret) {
    return {
      ok: false,
      checked: false,
      error: 'Missing AGENT_INTERNAL_HEALTH_SECRET or AUTH_SECRET for signed readiness.',
    }
  }

  const path = '/api/internal/background-worker-ready'
  const timestamp = Date.now().toString()
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${path}`)
    .digest('hex')

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        'x-agent-health-ts': timestamp,
        'x-agent-health-signature': signature,
      },
      signal: abort.signal,
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }

    return {
      ok: response.ok && typeof body === 'object' && body !== null && body.ok === true,
      checked: true,
      status: response.status,
      body,
    }
  } catch (error) {
    return {
      ok: false,
      checked: false,
      error: abort.signal.aborted
        ? `Timed out after ${timeoutMs}ms waiting for readiness.`
        : error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function statusWord(ok) {
  return ok ? 'PASS' : 'FAIL'
}

function printLine(ok, message) {
  console.log(`${statusWord(ok)} ${message}`)
}

function formatList(items) {
  return items.length > 0 ? items.join(', ') : 'none'
}

function readinessErrors(readiness) {
  const body = readiness.body
  if (typeof body === 'object' && body !== null && Array.isArray(body.errors)) return body.errors
  if (readiness.error) return [readiness.error]
  if (typeof body === 'string') return [body.slice(0, 200)]
  return []
}

const configuredUrl = readArg('--url') ||
  readArg('--deployed-url') ||
  env('AGENT_APP_URL') ||
  env('AUTH_URL') ||
  env('NEXTAUTH_URL') ||
  'https://agent1-0.vercel.app'
const baseUrl = configuredUrl.replace(/\/$/, '')
const timeoutMs = Math.max(1, Number.parseInt(readArg('--timeout-ms') || '30000', 10) || 30_000)
const skipVercel = args.includes('--skip-vercel')

const local = {
  signedReadinessSecret: envPresent('AGENT_INTERNAL_HEALTH_SECRET') || envPresent('AUTH_SECRET'),
  e2bApiKey: envPresent('E2B_API_KEY'),
  turso: envPresent('TURSO_DATABASE_URL') && envPresent('TURSO_AUTH_TOKEN'),
  deepSeek: envPresent('DEEPSEEK_API_KEY'),
  deploymentVersion: envPresent('AGENT_DEPLOYMENT_VERSION'),
  deploymentVersionRequired: envBoolEnabled('AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION'),
}

const vercel = skipVercel ? { ok: false, checked: false, skipped: true } : await checkVercelEnv()
const readiness = await checkReadiness(baseUrl, timeoutMs)
const errors = readinessErrors(readiness)
const liveReady = readiness.ok
const readinessChecks = typeof readiness.body === 'object' && readiness.body !== null && readiness.body.checks
  ? readiness.body.checks
  : {}
const vercelValueMismatches = vercel.checked
  ? (vercel.valueMismatches || [])
  : []

const nextActions = []
if (!local.e2bApiKey) nextActions.push('Create an E2B runtime API key and set E2B_API_KEY locally.')
if (vercel.checked && vercel.missingRequired?.length > 0) {
  nextActions.push(`Add missing Vercel production env values with npm run cloud:vercel-env -- --apply (${vercel.missingRequired.join(', ')}).`)
}
if (vercel.checked && vercelValueMismatches.length > 0) {
  nextActions.push(`Repair Vercel env value drift with npm run cloud:vercel-env -- --apply --verify-values --replace-drift (${vercelValueMismatches.join(', ')}).`)
}
if (vercel.checked && vercel.missingRequired?.length === 0 && !liveReady && errors.some((error) => /E2B_API_KEY/i.test(error))) {
  nextActions.push('Redeploy Vercel so the latest E2B_API_KEY is active: vercel deploy --prod --yes.')
}
if (!liveReady && errors.some((error) => /worker heartbeat/i.test(error))) {
  nextActions.push('Start a long-running worker host with npm run worker:cloud using render.worker.env.example and AGENT_TASK_QUEUE_NAME=production.')
}
if (!liveReady && errors.some((error) => /AGENT_DEPLOYMENT_VERSION/i.test(error))) {
  nextActions.push('Set the same AGENT_DEPLOYMENT_VERSION on Vercel and the worker host, then redeploy both services.')
}
if (!liveReady) nextActions.push(`Rerun npm run cloud:preflight -- --deployed-only --url ${baseUrl}.`)

console.log('\nCloud production status')
console.log('=======================')
console.log(`URL ${baseUrl}`)
console.log('Secret values are never printed.')

console.log('\nLocal prerequisites')
printLine(local.signedReadinessSecret, 'signed readiness secret is available locally')
printLine(local.turso, 'Turso queue credentials are available locally')
printLine(local.deepSeek, 'DeepSeek API key is available locally')
printLine(local.e2bApiKey, 'E2B_API_KEY is available locally')
if (local.deploymentVersionRequired) {
  printLine(local.deploymentVersion, 'AGENT_DEPLOYMENT_VERSION is set because worker version matching is required locally')
} else {
  console.log(`INFO worker version matching is disabled locally; AGENT_DEPLOYMENT_VERSION ${local.deploymentVersion ? 'is set but not enforced' : 'is not required'}.`)
}

console.log('\nVercel production env')
if (vercel.skipped) {
  console.log('SKIP Vercel env check skipped by --skip-vercel')
} else if (!vercel.checked) {
  printLine(false, vercel.error || 'Vercel env check failed')
} else {
  printLine(vercel.ok || (vercelValueMismatches.length === 0 && vercel.missingRequired?.length === 0), `required Vercel env names present; missing required: ${formatList(vercel.missingRequired)}`)
  if (vercel.missingOptional?.length > 0) console.log(`INFO optional missing names: ${vercel.missingOptional.join(', ')}`)
  if (vercelValueMismatches.length > 0) console.log(`FAIL Vercel env value drift: ${vercelValueMismatches.join(', ')}`)
}

console.log('\nLive worker readiness')
if (!readiness.checked) {
  printLine(false, readiness.error || 'readiness check failed')
} else {
  printLine(liveReady, `readiness endpoint status ${readiness.status}`)
  const body = readiness.body
  if (typeof body === 'object' && body !== null) {
    if (body.queueName) console.log(`INFO queue: ${body.queueName}`)
    if (body.checks) {
      for (const [key, value] of Object.entries(body.checks)) {
        console.log(`INFO check.${key}: ${value}`)
      }
    }
    if (Array.isArray(body.workers)) console.log(`INFO live workers reported: ${body.workers.length}`)
  }
  for (const error of errors) console.log(`FAIL ${error}`)
}

if (nextActions.length > 0) {
  console.log('\nNext actions')
  nextActions.forEach((action, index) => {
    console.log(`${index + 1}. ${action}`)
  })
}

if (liveReady) {
  console.log('\nProduction background worker readiness is live. Run the deployed preflight smoke to prove disconnect/reconnect completion.')
} else {
  process.exitCode = 1
}
