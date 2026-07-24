#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const API_BASE = 'https://api.render.com/v1'
const DEFAULT_WORKER_SERVICE_NAME = 'agent-worker'
const DEFAULT_WORKER_REGION = 'singapore'
const DEFAULT_WORKER_PLAN = 'starter'
const REQUIRED_LOCAL_KEYS = new Set([
  'AUTH_SECRET',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'E2B_API_KEY',
])

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

function parseValue(raw) {
  const trimmed = String(raw || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseEnvTemplate(text) {
  const entries = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) throw new Error(`Invalid env template line: ${line}`)
    const [, key, rawValue] = match
    if (seen.has(key)) throw new Error(`Duplicate env template key: ${key}`)
    seen.add(key)
    entries.push({ key, templateValue: parseValue(rawValue) })
  }
  return entries
}

function valueForEntry(entry) {
  // The checked-in worker template is the source of truth for public runtime
  // configuration. Otherwise a stale developer .env can silently roll an old
  // provider or model back into production during an env sync. Local values
  // remain authoritative for secrets and the optional deployment identity.
  if ((looksSecret(entry.key) && !entry.templateValue) || entry.key === 'AGENT_DEPLOYMENT_VERSION') {
    const local = env(entry.key)
    if (local) return local
  }
  return entry.templateValue
}

function shouldIncludeEntry(entry, value) {
  if (value) return true
  return REQUIRED_LOCAL_KEYS.has(entry.key)
}

function looksSecret(key) {
  return /(SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL|API_KEY|AUTH)/.test(key)
}

function apiToken() {
  return readArg('--api-key') || env('RENDER_API_KEY')
}

function serviceName() {
  return readArg('--service-name') || env('RENDER_WORKER_SERVICE_NAME') || DEFAULT_WORKER_SERVICE_NAME
}

function ownerId() {
  return readArg('--owner-id') || env('RENDER_OWNER_ID')
}

function repoUrl() {
  return readArg('--repo') || readArg('--repo-url') || env('RENDER_REPO_URL')
}

async function renderRequest(path, options = {}) {
  const token = apiToken()
  if (!token) {
    throw new Error('RENDER_API_KEY is missing. Create a Render API key, set it locally, then rerun this command.')
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null
      ? JSON.stringify(body)
      : String(body || response.statusText)
    throw new Error(`Render API ${options.method || 'GET'} ${path} failed with ${response.status}: ${message}`)
  }
  return body
}

async function listAll(path, params) {
  const rows = []
  let cursor = ''
  while (true) {
    const search = new URLSearchParams(params)
    search.set('limit', '100')
    if (cursor) search.set('cursor', cursor)
    const batch = await renderRequest(`${path}?${search.toString()}`)
    if (!Array.isArray(batch)) throw new Error(`Render API returned an unexpected response for ${path}`)
    rows.push(...batch)
    const nextCursor = batch.at(-1)?.cursor
    if (!nextCursor || batch.length === 0) break
    cursor = nextCursor
  }
  return rows
}

async function resolveServiceId(expected, missingLocal) {
  const explicit = readArg('--service-id') || env('RENDER_WORKER_SERVICE_ID')
  if (explicit) return explicit

  const name = serviceName()
  const rows = await listAll('/services', {
    name,
    type: 'background_worker',
    includePreviews: 'false',
  })
  const matches = rows.map((row) => row.service).filter(Boolean)
  if (matches.length === 1) return matches[0].id
  if (matches.length === 0) {
    if (!hasFlag('--create-if-missing')) {
      throw new Error(`No Render background worker named "${name}" was found. Create the Render Blueprint first, pass --service-id srv_..., or rerun with --apply --create-if-missing plus RENDER_OWNER_ID and RENDER_REPO_URL.`)
    }
    if (!apply) {
      throw new Error(`No Render background worker named "${name}" was found. Dry run will not create it; rerun with --apply --create-if-missing.`)
    }
    if (missingLocal.length > 0) {
      throw new Error(`Cannot create Render worker until required local values exist: ${missingLocal.join(', ')}`)
    }
    return createWorkerService(expected)
  }
  throw new Error(`Multiple Render background workers named "${name}" were found. Pass --service-id srv_...`)
}

function createEnvVarsForService(expected) {
  return expected
    .filter((entry) => entry.value || REQUIRED_LOCAL_KEYS.has(entry.key))
    .map((entry) => ({ key: entry.key, value: entry.value }))
}

async function createWorkerService(expected) {
  const workspaceOwnerId = ownerId()
  const repo = repoUrl()
  if (!workspaceOwnerId) {
    throw new Error('RENDER_OWNER_ID is required to create the worker service. Copy it from Render workspace settings or pass --owner-id.')
  }
  if (!repo) {
    throw new Error('RENDER_REPO_URL is required to create the worker service. Pass --repo https://github.com/<owner>/<repo> or set RENDER_REPO_URL.')
  }

  const body = {
    type: 'background_worker',
    name: serviceName(),
    ownerId: workspaceOwnerId,
    repo,
    autoDeploy: readArg('--auto-deploy') || env('RENDER_WORKER_AUTO_DEPLOY') || 'yes',
    envVars: createEnvVarsForService(expected),
    serviceDetails: {
      runtime: 'node',
      plan: readArg('--plan') || env('RENDER_WORKER_PLAN') || DEFAULT_WORKER_PLAN,
      region: readArg('--region') || env('RENDER_WORKER_REGION') || DEFAULT_WORKER_REGION,
      numInstances: Number.parseInt(readArg('--instances') || env('RENDER_WORKER_INSTANCES') || '1', 10) || 1,
      maxShutdownDelaySeconds: Number.parseInt(readArg('--max-shutdown-delay-seconds') || env('RENDER_WORKER_MAX_SHUTDOWN_DELAY_SECONDS') || '300', 10) || 300,
      envSpecificDetails: {
        buildCommand: readArg('--build-command') || env('RENDER_WORKER_BUILD_COMMAND') || 'npm ci && npm run build',
        startCommand: readArg('--start-command') || env('RENDER_WORKER_START_COMMAND') || 'npm run worker:cloud',
      },
    },
  }

  const branch = readArg('--branch') || env('RENDER_WORKER_BRANCH')
  const rootDir = readArg('--root-dir') || env('RENDER_WORKER_ROOT_DIR')
  const environmentId = readArg('--environment-id') || env('RENDER_ENVIRONMENT_ID')
  if (branch) body.branch = branch
  if (rootDir) body.rootDir = rootDir
  if (environmentId) body.environmentId = environmentId

  console.log(`Creating Render background worker ${body.name}. Secret values are sent to Render but not printed.`)
  const created = await renderRequest('/services', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const createdServiceId = created?.service?.id
  if (!createdServiceId) throw new Error('Render created the worker but did not return a service id.')
  console.log(`Created Render background worker ${createdServiceId}.`)
  return createdServiceId
}

async function listEnvVars(serviceId) {
  const rows = await listAll(`/services/${encodeURIComponent(serviceId)}/env-vars`, {})
  const vars = new Map()
  for (const row of rows) {
    const key = row.envVar?.key
    if (typeof key === 'string') vars.set(key, String(row.envVar?.value ?? ''))
  }
  return vars
}

function buildExpectedEntries(templateEntries) {
  const expected = []
  const missingLocal = []
  for (const entry of templateEntries) {
    const value = valueForEntry(entry)
    if (!shouldIncludeEntry(entry, value)) continue
    if (REQUIRED_LOCAL_KEYS.has(entry.key) && !env(entry.key)) missingLocal.push(entry.key)
    expected.push({
      key: entry.key,
      value,
      secret: looksSecret(entry.key),
      requiredLocal: REQUIRED_LOCAL_KEYS.has(entry.key),
    })
  }

  const requireDeploymentVersion = expected.find((entry) => entry.key === 'AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION')?.value === 'true'
  const deploymentVersion = expected.find((entry) => entry.key === 'AGENT_DEPLOYMENT_VERSION')?.value || ''
  if (requireDeploymentVersion && !deploymentVersion) {
    missingLocal.push('AGENT_DEPLOYMENT_VERSION')
  }

  return { expected, missingLocal: [...new Set(missingLocal)] }
}

function buildRows(expected, current) {
  return expected.map((entry) => {
    const currentValue = current.get(entry.key)
    const exists = current.has(entry.key)
    const matches = exists && currentValue === entry.value
    return {
      key: entry.key,
      exists,
      matches,
      secret: entry.secret,
      action: exists && matches ? 'keep' : exists ? 'update' : 'create',
    }
  })
}

function printReport(input) {
  if (hasFlag('--json')) {
    console.log(JSON.stringify({
      serviceId: input.serviceId,
      apply: input.apply,
      triggerDeploy: input.triggerDeploy,
      rows: input.rows,
      missingLocal: input.missingLocal,
    }, null, 2))
    return
  }

  console.log('\nRender worker env report')
  console.log('========================')
  console.log(`serviceId ${input.serviceId}`)
  console.log('Secret values are never printed.')
  for (const row of input.rows) {
    const state = row.exists
      ? row.matches ? 'present, matches' : 'present, will update'
      : 'missing, will create'
    console.log(`${state.padEnd(24)} ${row.key}`)
  }
  if (input.missingLocal.length > 0) {
    console.log(`\nMissing local required values: ${input.missingLocal.join(', ')}`)
  }
  if (!input.apply) {
    console.log('\nDry run only. Re-run with --apply after required local values exist.')
  }
}

async function applyEnvVars(serviceId, expected, rows) {
  for (const row of rows) {
    if (row.action === 'keep') continue
    const entry = expected.find((item) => item.key === row.key)
    if (!entry) continue
    console.log(`${row.action === 'create' ? 'Creating' : 'Updating'} ${entry.key} on Render worker`)
    await renderRequest(`/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(entry.key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value: entry.value }),
    })
  }
}

async function triggerDeploy(serviceId) {
  const clearCache = hasFlag('--clear-cache') ? 'clear' : 'do_not_clear'
  const body = await renderRequest(`/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ clearCache, deployMode: 'build_and_deploy' }),
  })
  console.log(`Triggered Render worker deploy ${body?.id || '<unknown>'} (${body?.status || 'created'}).`)
}

const apply = hasFlag('--apply')
const triggerDeployAfterApply = hasFlag('--trigger-deploy') || hasFlag('--deploy')

try {
  const templateText = await readFile(`${root}/render.worker.env.example`, 'utf8')
  const templateEntries = parseEnvTemplate(templateText)
  const { expected, missingLocal } = buildExpectedEntries(templateEntries)
  const serviceId = await resolveServiceId(expected, missingLocal)
  const current = await listEnvVars(serviceId)
  const rows = buildRows(expected, current)

  printReport({ serviceId, apply, triggerDeploy: triggerDeployAfterApply, rows, missingLocal })

  if (missingLocal.length > 0) process.exitCode = 1
  if (!apply || missingLocal.length > 0) process.exit()

  await applyEnvVars(serviceId, expected, rows)
  console.log('Render worker env apply finished.')

  if (triggerDeployAfterApply) await triggerDeploy(serviceId)
} catch (error) {
  console.error(`Render worker env check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
