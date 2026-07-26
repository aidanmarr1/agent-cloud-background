#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const nodeBin = process.execPath
const READY_PATH = '/api/internal/background-worker-ready'

loadLocalEnvFiles(rootUrl)

function resolveVercelCommand() {
  const configuredVercel = env('VERCEL_CLI')
  if (configuredVercel) {
    return { bin: configuredVercel, baseArgs: [], label: configuredVercel }
  }

  const localVercel = resolve(root, 'node_modules/.bin/vercel')
  if (existsSync(localVercel)) {
    return { bin: localVercel, baseArgs: [], label: localVercel }
  }

  const configuredPnpm = env('PNPM_BIN')
  const pathPnpm = (process.env.PATH || '')
    .split(delimiter)
    .map((directory) => join(directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'))
    .find((candidate) => existsSync(candidate)) || ''
  const bundledPnpm = resolve(
    dirname(process.execPath),
    process.platform === 'win32' ? '../../bin/fallback/pnpm.cmd' : '../../bin/fallback/pnpm',
  )
  const pnpm = configuredPnpm || pathPnpm || (existsSync(bundledPnpm) ? bundledPnpm : '')
  if (pnpm) {
    return { bin: pnpm, baseArgs: ['dlx', 'vercel'], label: `${pnpm} dlx vercel` }
  }

  const npx = env('NPX_BIN') || (process.platform === 'win32' ? 'npx.cmd' : 'npx')
  return { bin: npx, baseArgs: ['--yes', 'vercel'], label: `${npx} --yes vercel` }
}

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

  console.log(`\n==> Wait for deployed task executor readiness (${waitMs}ms max)`)
  while (Date.now() - startedAt < waitMs) {
    attempt += 1
    const remainingMs = Math.max(1_000, waitMs - (Date.now() - startedAt))
    last = await signedWorkerReadyCheck(Math.min(30_000, remainingMs))
    if (last.ok) {
      console.log(`Task executor readiness passed after ${Date.now() - startedAt}ms.`)
      return
    }
    const errorText = readinessErrorText(last.body)
    console.log(`WAIT attempt ${attempt}: status ${last.status}${errorText ? `; ${errorText}` : ''}`)
    await sleep(Math.min(pollMs, Math.max(0, waitMs - (Date.now() - startedAt))))
  }

  throw new Error(`Timed out after ${waitMs}ms waiting for the deployed task executor at ${deployedUrl}. Last status: ${last?.status || 0}${last ? `; ${readinessErrorText(last.body)}` : ''}`)
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
// cloud:vercel-env defaults production to render_job. Treat an unset local
// dispatch mode the same way so this rollout helper cannot activate the web
// coordinator before the exact-run worker image is live on Render.
const onDemandDispatch = (env('AGENT_TASK_DISPATCH_MODE') || 'render_job') === 'render_job'

const requiredLocalEnv = [
  'AUTH_SECRET',
  'AGENT_INTERNAL_HEALTH_SECRET',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
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

let renderRolloutAttempted = false
const intakeHoldId = randomUUID()

try {
  let renderWorkerDeployTriggered = false
  let renderIntakeHoldActive = false
  let deployedWorkerSmokeProven = false
  if (workerEnvPath) await writeWorkerEnvFile(workerEnvPath)

  await runStep('Production cloud env smoke (cloud:env-smoke)', nodeBin, ['scripts/cloud-env-smoke.mjs'])
  if (buildE2BTemplate) {
    if (!env('E2B_ACCESS_TOKEN') && !allowExistingE2BCLIAuth) {
      throw new Error('E2B_ACCESS_TOKEN is required for non-interactive E2B template builds. Set it locally, or pass --allow-existing-e2b-cli-auth if the E2B CLI is already authenticated on this machine.')
    }
    await runStep('Build E2B browser template (e2b:template:build)', nodeBin, [
      'scripts/e2b-template-build-v2.mjs',
      '--dockerfile',
      'e2b.Dockerfile',
      '--name',
      env('E2B_TEMPLATE_ID') || 'agent-cloud-browser',
    ])
  } else {
    console.log('\nSKIP E2B template build. Pass --build-e2b-template after setting E2B_ACCESS_TOKEN to build agent-cloud-browser.')
  }
  if (runE2BSmoke) {
    await runStep('Live E2B template smoke (cloud:e2b-smoke)', nodeBin, ['scripts/e2b-template-smoke.mjs'])
  } else {
    console.log('\nSKIP Live E2B template smoke. Pass --e2b-smoke to run the paid sandbox probe.')
  }

  // Render must finish first. Once Vercel activates render_job, every accepted
  // task can immediately launch `worker:drain`; activating the web deployment
  // against an older worker image would create paid jobs that cannot claim.
  if (!skipRenderEnv && env('RENDER_API_KEY')) {
    const renderArgs = [
      'scripts/render-worker-env.mjs',
      '--apply',
      '--trigger-deploy',
      '--wait-for-deploy',
      '--safe-suspended-deploy',
      '--keep-intake-held',
      '--intake-hold-id',
      intakeHoldId,
      '--intake-hold-url',
      deployedUrl,
    ]
    const renderServiceId = readArg('--render-service-id')
    const renderServiceName = readArg('--render-service-name')
    const renderDeployWaitMs = readArg('--render-deploy-wait-ms')
    const renderDeployPollMs = readArg('--render-deploy-poll-ms')
    if (renderServiceId) renderArgs.push('--service-id', renderServiceId)
    if (renderServiceName) renderArgs.push('--service-name', renderServiceName)
    if (renderDeployWaitMs) renderArgs.push('--deploy-wait-ms', renderDeployWaitMs)
    if (renderDeployPollMs) renderArgs.push('--deploy-poll-ms', renderDeployPollMs)
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
    const renderCommitId = readArg('--render-commit-id')
    if (renderCommitId) renderArgs.push('--commit-id', renderCommitId)
    renderRolloutAttempted = true
    await runStep('Apply and deploy Render worker env (cloud:render-worker-env)', nodeBin, renderArgs)
    renderWorkerDeployTriggered = true
    renderIntakeHoldActive = true
  } else if (!skipRenderEnv) {
    if (onDemandDispatch) {
      throw new Error(
        'RENDER_API_KEY is required to deploy and verify the on-demand worker image before Vercel. ' +
        'Set it locally, or pass --skip-render-env only after verifying the Render deployment manually.',
      )
    }
    console.log('\nSKIP Render worker env apply. Set RENDER_API_KEY locally to let this command configure and deploy agent-worker through the Render API.')
  } else if (onDemandDispatch) {
    console.log('\nSKIP Render worker deploy by explicit request. Verify the exact-run worker image is already live before Vercel is activated.')
  }

  if (!skipVercelEnv) {
    await runStep('Apply Vercel production env (cloud:vercel-env)', nodeBin, [
      'scripts/vercel-cloud-env.mjs',
      '--apply',
      '--verify-values',
      '--replace-drift',
    ])
  }
  if (!skipDeploy) {
    const vercel = resolveVercelCommand()
    await runStep('Deploy Vercel production', vercel.bin, [
      ...vercel.baseArgs,
      'deploy',
      '--prod',
      '--yes',
    ])
  }
  if (renderIntakeHoldActive && skipWorkerReadyWait) {
    throw new Error(
      'Cannot release the rollout intake hold while --skip-worker-ready-wait is set. ' +
      'Prove the new web deployment is ready before reopening task intake.',
    )
  }
  if (!skipWorkerReadyWait && (renderWorkerDeployTriggered || waitForWorkerReady)) {
    await waitForWorkerReadiness()
  } else if (!skipWorkerReadyWait) {
    console.log('\nSKIP task executor readiness wait. Pass --wait-for-worker-ready to verify an already-prepared manual executor before final status/preflight.')
  }
  if (renderIntakeHoldActive) {
    await runStep('Prove deployed one-off worker execution before reopening intake', nodeBin, [
      'scripts/prod-background-worker-smoke.mjs',
      '--url',
      deployedUrl,
      '--timeout-ms',
      timeoutMs,
    ])
    deployedWorkerSmokeProven = true
    await runStep('Release verified rollout intake hold', nodeBin, [
      'scripts/render-worker-env.mjs',
      '--release-intake-hold',
      '--intake-hold-id',
      intakeHoldId,
      '--intake-hold-url',
      deployedUrl,
    ])
    renderIntakeHoldActive = false
  }
  await runStep('Production status (cloud:status)', nodeBin, [
    'scripts/cloud-production-status.mjs',
    '--url',
    deployedUrl,
    '--timeout-ms',
    timeoutMs,
  ])
  if (!skipDeployedPreflight) {
    await runStep('Deployed background worker preflight (cloud:preflight)', nodeBin, [
      'scripts/cloud-preflight.mjs',
      '--deployed-only',
      '--url',
      deployedUrl,
      '--timeout-ms',
      timeoutMs,
      ...(deployedWorkerSmokeProven ? ['--skip-worker-smoke'] : []),
    ])
  }
} catch (error) {
  console.error(`\nCloud finish setup stopped: ${error instanceof Error ? error.message : String(error)}`)
  if (renderRolloutAttempted) {
    console.error(
      'The queue-scoped intake hold may still be active. First verify the Render base is suspended, then ' +
      `release only this rollout hold with: ${nodeBin} scripts/render-worker-env.mjs ` +
      `--release-intake-hold --intake-hold-id ${intakeHoldId} --intake-hold-url ${deployedUrl}`,
    )
  }
  console.error('Fix the failing step above, then rerun this command.')
  process.exit(1)
}
