#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const READY_PATH = '/api/internal/background-worker-ready'

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

function hasFlag(name) {
  return args.includes(name)
}

function formatEnvValue(value) {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseEnvValue(raw) {
  const trimmed = String(raw || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseWorkerEnvTemplate(text) {
  const entries = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) throw new Error(`Invalid render.worker.env.example line: ${line}`)
    const [, key, rawValue] = match
    if (seen.has(key)) throw new Error(`Duplicate render.worker.env.example key: ${key}`)
    seen.add(key)
    entries.push({ key, templateValue: parseEnvValue(rawValue) })
  }
  return entries
}

function runStep(label, command, commandArgs) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`)
    console.log(`$ ${[command, ...commandArgs].join(' ')}`)
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with ${signal || `code ${code}`}`))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readinessErrorText(body) {
  if (typeof body === 'string') return body.slice(0, 240)
  if (typeof body !== 'object' || body === null) return ''
  const errors = Array.isArray(body.errors) ? body.errors.join('; ') : ''
  return [body.error, errors].filter(Boolean).join('; ').slice(0, 500)
}

async function signedWorkerReadyCheck(attemptTimeoutMs) {
  const secret = env('AGENT_INTERNAL_HEALTH_SECRET') || env('AUTH_SECRET')
  if (!secret) throw new Error('Missing AGENT_INTERNAL_HEALTH_SECRET or AUTH_SECRET for signed worker readiness.')

  const timestamp = Date.now().toString()
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${READY_PATH}`)
    .digest('hex')
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), attemptTimeoutMs)
  try {
    const response = await fetch(`${deployedUrl}${READY_PATH}`, {
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
      status: response.status,
      body,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: abort.signal.aborted
          ? `Timed out after ${attemptTimeoutMs}ms waiting for readiness.`
          : error instanceof Error ? error.message : String(error),
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForWorkerReadiness() {
  const waitMs = parsePositiveInt(
    readArg('--worker-ready-wait-ms') || env('AGENT_FINISH_SETUP_WORKER_READY_WAIT_MS') || timeoutMs,
    180_000,
  )
  const pollMs = parsePositiveInt(readArg('--worker-ready-poll-ms') || env('AGENT_FINISH_SETUP_WORKER_READY_POLL_MS'), 5_000)
  const startedAt = Date.now()
  let attempt = 0
  let last = null

  console.log(`\n==> Wait for deployed worker readiness (${waitMs}ms max)`)
  while (Date.now() - startedAt < waitMs) {
    attempt += 1
    const remainingMs = Math.max(1_000, waitMs - (Date.now() - startedAt))
    last = await signedWorkerReadyCheck(Math.min(30_000, remainingMs))
    if (last.ok) {
      console.log(`Worker readiness passed after ${Date.now() - startedAt}ms.`)
      return
    }
    const errorText = readinessErrorText(last.body)
    console.log(`WAIT attempt ${attempt}: status ${last.status}${errorText ? `; ${errorText}` : ''}`)
    await sleep(Math.min(pollMs, Math.max(0, waitMs - (Date.now() - startedAt))))
  }

  throw new Error(`Timed out after ${waitMs}ms waiting for a live compatible worker heartbeat at ${deployedUrl}. Last status: ${last?.status || 0}${last ? `; ${readinessErrorText(last.body)}` : ''}`)
}

const deployedUrl = (
  readArg('--url') ||
  readArg('--deployed-url') ||
  env('AGENT_APP_URL') ||
  env('AUTH_URL') ||
  env('NEXTAUTH_URL') ||
  'https://agent1-0.vercel.app'
).replace(/\/$/, '')
const timeoutMs = readArg('--timeout-ms') || '180000'
const workerEnvPath = readArg('--write-worker-env')
const buildE2BTemplate = hasFlag('--build-e2b-template') || hasFlag('--e2b-template-build')
const allowExistingE2BCLIAuth = hasFlag('--allow-existing-e2b-cli-auth')
const runE2BSmoke = hasFlag('--e2b-smoke') || hasFlag('--run-e2b-smoke')
const skipVercelEnv = hasFlag('--skip-vercel-env')
const skipDeploy = hasFlag('--skip-deploy')
const skipRenderEnv = hasFlag('--skip-render-env')
const waitForWorkerReady = hasFlag('--wait-for-worker-ready')
const skipWorkerReadyWait = hasFlag('--skip-worker-ready-wait')
const skipDeployedPreflight = hasFlag('--skip-deployed-preflight')

const requiredLocalEnv = [
  'AUTH_SECRET',
  'AGENT_INTERNAL_HEALTH_SECRET',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'E2B_API_KEY',
]

const missing = requiredLocalEnv.filter((name) => !env(name))
if (missing.length > 0) {
  console.error('\nCloud finish setup cannot run yet.')
  console.error(`Missing local env values: ${missing.join(', ')}`)
  console.error('Set the missing values in .env.local first. Secret values are never printed by this command.')
  process.exit(1)
}

async function writeWorkerEnvFile(path) {
  const templateText = await readFile(`${root}/render.worker.env.example`, 'utf8')
  const templateEntries = parseWorkerEnvTemplate(templateText)

  const lines = [
    '# Generated by npm run cloud:finish-setup. Do not commit this file.',
    '# Paste these values into the Render agent-worker environment.',
    '# Generated from render.worker.env.example so manual setup matches the Render API path.',
    '',
  ]
  for (const entry of templateEntries) {
    const value = env(entry.key) || entry.templateValue
    lines.push(`${entry.key}=${formatEnvValue(value)}`)
  }
  lines.push('')

  await writeFile(path, lines.join('\n'), { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
  console.log(`\nWrote private worker env file to ${path}.`)
  console.log('Secret values were written to that file but were not printed.')
}

try {
  let renderWorkerDeployTriggered = false
  if (workerEnvPath) await writeWorkerEnvFile(workerEnvPath)

  await runStep('Production cloud env smoke', npmBin, ['run', 'cloud:env-smoke'])
  if (buildE2BTemplate) {
    if (!env('E2B_ACCESS_TOKEN') && !allowExistingE2BCLIAuth) {
      throw new Error('E2B_ACCESS_TOKEN is required for non-interactive E2B template builds. Set it locally, or pass --allow-existing-e2b-cli-auth if the E2B CLI is already authenticated on this machine.')
    }
    await runStep('Build E2B browser template', npmBin, ['run', 'e2b:template:build'])
  } else {
    console.log('\nSKIP E2B template build. Pass --build-e2b-template after setting E2B_ACCESS_TOKEN to build agent-cloud-browser.')
  }
  if (runE2BSmoke) {
    await runStep('Live E2B template smoke', npmBin, ['run', 'cloud:e2b-smoke'])
  } else {
    console.log('\nSKIP Live E2B template smoke. Pass --e2b-smoke to run the paid sandbox probe.')
  }
  if (!skipVercelEnv) {
    await runStep('Apply Vercel production env', npmBin, ['run', 'cloud:vercel-env', '--', '--apply', '--verify-values', '--replace-drift'])
  }
  if (!skipDeploy) {
    await runStep('Deploy Vercel production', 'vercel', ['deploy', '--prod', '--yes'])
  }
  if (!skipRenderEnv && env('RENDER_API_KEY')) {
    const renderArgs = ['run', 'cloud:render-worker-env', '--', '--apply', '--trigger-deploy']
    const renderServiceId = readArg('--render-service-id')
    const renderServiceName = readArg('--render-service-name')
    if (renderServiceId) renderArgs.push('--service-id', renderServiceId)
    if (renderServiceName) renderArgs.push('--service-name', renderServiceName)
    if (hasFlag('--create-render-worker')) renderArgs.push('--create-if-missing')
    for (const [finishArg, renderArg] of [
      ['--render-owner-id', '--owner-id'],
      ['--render-repo', '--repo'],
      ['--render-branch', '--branch'],
      ['--render-root-dir', '--root-dir'],
      ['--render-environment-id', '--environment-id'],
      ['--render-plan', '--plan'],
      ['--render-region', '--region'],
    ]) {
      const value = readArg(finishArg)
      if (value) renderArgs.push(renderArg, value)
    }
    if (hasFlag('--render-clear-cache')) renderArgs.push('--clear-cache')
    await runStep('Apply and deploy Render worker env', npmBin, renderArgs)
    renderWorkerDeployTriggered = true
  } else if (!skipRenderEnv) {
    console.log('\nSKIP Render worker env apply. Set RENDER_API_KEY locally to let this command configure and deploy agent-worker through the Render API.')
  }
  if (!skipWorkerReadyWait && (renderWorkerDeployTriggered || waitForWorkerReady)) {
    await waitForWorkerReadiness()
  } else if (!skipWorkerReadyWait) {
    console.log('\nSKIP worker readiness wait. Pass --wait-for-worker-ready to wait for an already-running manual worker before final status/preflight.')
  }
  await runStep('Production status', npmBin, ['run', 'cloud:status', '--', '--url', deployedUrl, '--timeout-ms', timeoutMs])
  if (!skipDeployedPreflight) {
    await runStep('Deployed background worker preflight', npmBin, [
      'run',
      'cloud:preflight',
      '--',
      '--deployed-only',
      '--url',
      deployedUrl,
      '--timeout-ms',
      timeoutMs,
    ])
  }
} catch (error) {
  console.error(`\nCloud finish setup stopped: ${error instanceof Error ? error.message : String(error)}`)
  console.error('Fix the failing step above, then rerun this command.')
  process.exit(1)
}
