#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createClient } from '@tursodatabase/serverless/compat'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const API_BASE = 'https://api.render.com/v1'
const DEFAULT_WORKER_SERVICE_NAME = 'agent-worker'
const DEFAULT_WORKER_REGION = 'singapore'
const DEFAULT_WORKER_PLAN = 'starter'
const DEFAULT_DEPLOY_WAIT_MS = 15 * 60 * 1000
const DEFAULT_DEPLOY_POLL_MS = 3_000
const DEFAULT_SERVICE_WAIT_MS = 5 * 60 * 1000
const DEFAULT_SERVICE_POLL_MS = 2_000
const DEFAULT_QUEUE_STABILITY_MS = 2_000
const DEFAULT_WORKER_STALE_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const READY_PATH = '/api/internal/background-worker-ready'
const SAFE_QUEUE_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/
const FULL_GIT_COMMIT = /^[a-f0-9]{40}$/i
const SUCCESSFUL_DEPLOY_STATUSES = new Set(['live'])
const FAILED_DEPLOY_STATUSES = new Set([
  'build_failed',
  'update_failed',
  'pre_deploy_failed',
  'canceled',
  'cancelled',
  'deactivated',
])
const REQUIRED_LOCAL_KEYS = new Set([
  'AUTH_SECRET',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'E2B_API_KEY',
])

loadLocalEnvFiles(rootUrl)

let interruptedSignal = ''
let activeRequestController = null
let activeSleepReject = null

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

function interruptionError() {
  const error = new Error(
    interruptedSignal
      ? `Rollout interrupted by ${interruptedSignal}.`
      : 'Rollout interrupted.',
  )
  error.name = 'RolloutInterruptedError'
  return error
}

function throwIfInterrupted(options = {}) {
  if (interruptedSignal && options.allowAfterInterrupt !== true) {
    throw interruptionError()
  }
}

function sleep(ms, options = {}) {
  throwIfInterrupted(options)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (activeSleepReject === rejectForSignal) activeSleepReject = null
      resolve()
    }, ms)
    const rejectForSignal = () => {
      if (settled || options.allowAfterInterrupt === true) return
      settled = true
      clearTimeout(timer)
      if (activeSleepReject === rejectForSignal) activeSleepReject = null
      reject(interruptionError())
    }
    if (options.allowAfterInterrupt !== true) activeSleepReject = rejectForSignal
  })
}

function handleTerminationSignal(signal) {
  if (!interruptedSignal) {
    interruptedSignal = signal
    console.error(
      `Received ${signal}; aborting the active request and preserving the intake hold ` +
      'while the guarded rollout suspends and verifies the Render base.',
    )
  }
  activeRequestController?.abort(interruptionError())
  activeSleepReject?.()
}

process.on('SIGINT', () => handleTerminationSignal('SIGINT'))
process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'))

function intakeBaseUrl() {
  return (
    readArg('--intake-hold-url') ||
    readArg('--url') ||
    env('AGENT_APP_URL') ||
    env('AUTH_URL') ||
    env('NEXTAUTH_URL')
  ).replace(/\/$/, '')
}

function internalHealthSecret() {
  return env('AGENT_INTERNAL_HEALTH_SECRET') || env('AUTH_SECRET')
}

function queueBaseName() {
  const value = readArg('--queue') || env('AGENT_TASK_QUEUE_NAME') || 'production'
  if (!SAFE_QUEUE_NAME.test(value)) {
    throw new Error('Invalid queue name. Use 1-128 letters, numbers, dots, colons, underscores, or hyphens.')
  }
  return value
}

function queueMatchesBase(queueName, baseName) {
  return queueName === baseName || queueName.startsWith(`${baseName}:orchestration-v`)
}

function exactCommitId() {
  const configured = readArg('--commit-id') || env('AGENT_DEPLOYMENT_COMMIT')
  if (configured) {
    if (!FULL_GIT_COMMIT.test(configured)) {
      throw new Error('--commit-id must be the full 40-character Git commit SHA.')
    }
    return configured.toLowerCase()
  }

  let current = ''
  try {
    const trackedChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (trackedChanges && !hasFlag('--allow-dirty-head')) {
      throw new Error(
        'Tracked files differ from HEAD. Commit the rollout source first, or pass --allow-dirty-head only ' +
        'when an explicit --commit-id identifies the already-pushed artifact.',
      )
    }
    current = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Tracked files differ from HEAD.')
    ) {
      throw error
    }
    throw new Error(
      `Could not resolve the current Git commit. Pass --commit-id explicitly. ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (!FULL_GIT_COMMIT.test(current)) {
    throw new Error('git rev-parse HEAD did not return a full 40-character commit SHA.')
  }
  return current.toLowerCase()
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

async function fetchTextWithTimeout(url, options = {}, requestOptions = {}) {
  throwIfInterrupted(requestOptions)
  const timeoutMs = positiveIntArg('--request-timeout-ms', DEFAULT_REQUEST_TIMEOUT_MS)
  const controller = new AbortController()
  const previousController = activeRequestController
  activeRequestController = controller
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms while reading headers or body.`))
  }, timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    // Keep the same deadline active while consuming the response. A provider
    // that sends headers and stalls the body must not bypass rollout bounds.
    const text = await response.text()
    return { response, text }
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      if (reason instanceof Error) throw reason
      throw new Error(
        interruptedSignal
          ? `Request aborted after ${interruptedSignal}.`
          : `Request timed out after ${timeoutMs}ms while reading headers or body.`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (activeRequestController === controller) {
      activeRequestController = previousController
    }
  }
}

async function renderRequest(path, options = {}) {
  const token = apiToken()
  if (!token) {
    throw new Error('RENDER_API_KEY is missing. Create a Render API key, set it locally, then rerun this command.')
  }

  const { allowAfterInterrupt = false, ...fetchOptions } = options
  const { response, text } = await fetchTextWithTimeout(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}),
      ...(fetchOptions.headers || {}),
    },
  }, { allowAfterInterrupt })
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
    throw new Error(`Render API ${fetchOptions.method || 'GET'} ${path} failed with ${response.status}: ${message}`)
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

async function signedIntakeStatus(baseUrl) {
  const secret = internalHealthSecret()
  if (!baseUrl) {
    throw new Error(
      'A deployed app URL is required to prove the intake hold. Pass --intake-hold-url or set AGENT_APP_URL.',
    )
  }
  if (!secret) {
    throw new Error(
      'AGENT_INTERNAL_HEALTH_SECRET (or AUTH_SECRET fallback) is required to prove the deployed intake hold.',
    )
  }

  const timestamp = Date.now().toString()
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${READY_PATH}`)
    .digest('hex')
  const { response, text } = await fetchTextWithTimeout(`${baseUrl}${READY_PATH}`, {
    headers: {
      'x-agent-health-ts': timestamp,
      'x-agent-health-signature': signature,
    },
  })
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.queueName !== 'string' ||
    typeof body.taskIntake?.held !== 'boolean'
  ) {
    throw new Error(
      `The deployed readiness endpoint did not return the durable intake-hold contract (HTTP ${response.status}). ` +
      'Deploy the intake-hold-aware web code without enabling new dispatch, then retry.',
    )
  }
  return { status: response.status, body }
}

function createQueueClient() {
  const url = env('TURSO_DATABASE_URL')
  const authToken = env('TURSO_AUTH_TOKEN')
  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required to prove and hold task intake.')
  }
  return createClient({ url, authToken })
}

async function ensureQueueControlSchema(client) {
  await client.execute(`
    create table if not exists agent_task_queue_controls (
      queue_name text primary key,
      intake_hold_id text,
      intake_hold_reason text,
      intake_held_at_ms integer,
      updated_at_ms integer not null
    )
  `)
}

async function readIntakeHold(client, queueName) {
  const result = await client.execute({
    sql: `
      select intake_hold_id, intake_hold_reason, intake_held_at_ms
      from agent_task_queue_controls
      where queue_name = ?
      limit 1
    `,
    args: [queueName],
  })
  const row = result.rows[0]
  return {
    holdId: typeof row?.intake_hold_id === 'string' ? row.intake_hold_id.trim() : '',
    reason: typeof row?.intake_hold_reason === 'string' ? row.intake_hold_reason : '',
    heldAtMs: Number(row?.intake_held_at_ms || 0),
  }
}

async function acquireIntakeHold(client, queueName, holdId) {
  await ensureQueueControlSchema(client)
  const now = Date.now()
  await client.execute({
    sql: `
      insert into agent_task_queue_controls (
        queue_name, intake_hold_id, intake_hold_reason, intake_held_at_ms, updated_at_ms
      )
      values (?, ?, ?, ?, ?)
      on conflict(queue_name) do update set
        intake_hold_id = excluded.intake_hold_id,
        intake_hold_reason = excluded.intake_hold_reason,
        intake_held_at_ms = excluded.intake_held_at_ms,
        updated_at_ms = excluded.updated_at_ms
      where agent_task_queue_controls.intake_hold_id is null
         or agent_task_queue_controls.intake_hold_id = ''
         or agent_task_queue_controls.intake_hold_id = excluded.intake_hold_id
    `,
    args: [
      queueName,
      holdId,
      `Render suspended-base rollout for ${exactCommitId()}`,
      now,
      now,
    ],
  })
  const current = await readIntakeHold(client, queueName)
  if (current.holdId !== holdId) {
    throw new Error(
      `Task intake is already held by another rollout (${current.holdId || 'unknown hold'}). ` +
      'Refusing to replace its ownership.',
    )
  }
  console.log(`Acquired durable intake hold for queue ${queueName}.`)
}

async function releaseIntakeHold(client, queueName, holdId) {
  await ensureQueueControlSchema(client)
  const result = await client.execute({
    sql: `
      update agent_task_queue_controls
      set intake_hold_id = null,
          intake_hold_reason = null,
          intake_held_at_ms = null,
          updated_at_ms = ?
      where queue_name = ?
        and intake_hold_id = ?
    `,
    args: [Date.now(), queueName, holdId],
  })
  if (Number(result.rowsAffected || 0) !== 1) {
    const current = await readIntakeHold(client, queueName)
    if (!current.holdId) return
    throw new Error(
      `Refusing to release intake hold ${holdId}; queue ${queueName} is owned by ${current.holdId}.`,
    )
  }
  const current = await readIntakeHold(client, queueName)
  if (current.holdId) {
    throw new Error(`Intake hold ${holdId} still exists after its release update.`)
  }
  console.log(`Released durable intake hold for queue ${queueName}.`)
}

async function proveDeployedIntakeHold(baseUrl, queueName, holdId) {
  const status = await signedIntakeStatus(baseUrl)
  if (status.body.queueName !== queueName) {
    throw new Error(
      `Deployed app reports queue ${status.body.queueName}, but the rollout hold is on ${queueName}.`,
    )
  }
  if (status.body.taskIntake.held !== true || status.body.taskIntake.holdId !== holdId) {
    throw new Error(
      'The deployed app did not acknowledge the exact durable intake hold. ' +
      'Refusing to resume the Render worker while new task acceptance may still be open.',
    )
  }
  console.log(`Deployed app acknowledged intake hold ${holdId} for ${queueName}.`)
}

async function tableExists(client, name) {
  const result = await client.execute({
    sql: "select name from sqlite_master where type = 'table' and name = ? limit 1",
    args: [name],
  })
  return result.rows.length > 0
}

async function countScoped(client, table, condition, args) {
  const result = await client.execute({
    sql: `
      select count(*) as count
      from ${table}
      where (queue_name = ? or queue_name like ?)
        and ${condition}
    `,
    args,
  })
  return Math.max(0, Number(result.rows[0]?.count || 0))
}

async function readActiveQueueCounts(client, baseName) {
  const requiredTables = [
    'agent_task_jobs',
    'agent_task_dispatches',
    'user_active_task_leases',
    'agent_task_workers',
  ]
  const availability = await Promise.all(requiredTables.map((name) => tableExists(client, name)))
  const missing = requiredTables.filter((_, index) => !availability[index])
  if (missing.length > 0) {
    throw new Error(
      `Cannot prove the production queue is drained because these durable tables are missing: ${missing.join(', ')}.`,
    )
  }

  const prefix = `${baseName}:%`
  const now = Date.now()
  const staleMs = positiveIntArg('--worker-stale-ms', DEFAULT_WORKER_STALE_MS)
  const scopeArgs = [baseName, prefix]
  const [jobs, dispatches, leases, workers] = await Promise.all([
    countScoped(
      client,
      'agent_task_jobs',
      "status in ('queued', 'running')",
      [...scopeArgs],
    ),
    countScoped(
      client,
      'agent_task_dispatches',
      "backend = 'render-one-off' and status in ('creating', 'unknown', 'created')",
      [...scopeArgs],
    ),
    countScoped(
      client,
      'user_active_task_leases',
      'expires_at_ms > ?',
      [...scopeArgs, now],
    ),
    countScoped(
      client,
      'agent_task_workers',
      "status in ('starting', 'idle', 'running', 'stopping') and last_seen_at_ms >= ?",
      [...scopeArgs, now - staleMs],
    ),
  ])
  return { jobs, dispatches, leases, workers }
}

function activeQueueCountTotal(counts) {
  return counts.jobs + counts.dispatches + counts.leases + counts.workers
}

async function proveQueueDrained(client, baseName, deployedQueueName) {
  if (!queueMatchesBase(deployedQueueName, baseName)) {
    throw new Error(
      `Cannot prove deployed queue ${deployedQueueName}; it is outside stable queue base ${baseName}.`,
    )
  }
  const stabilityMs = positiveIntArg('--queue-stability-ms', DEFAULT_QUEUE_STABILITY_MS)
  const first = await readActiveQueueCounts(client, baseName)
  if (activeQueueCountTotal(first) > 0) {
    throw new Error(`Production queue is not drained: ${JSON.stringify(first)}.`)
  }
  await sleep(stabilityMs)
  const second = await readActiveQueueCounts(client, baseName)
  if (activeQueueCountTotal(second) > 0) {
    throw new Error(`Production queue changed during the drain proof: ${JSON.stringify(second)}.`)
  }
  console.log(
    `Deployed queue ${deployedQueueName}, stable base ${baseName}, and all protocol namespaces ` +
    `remained drained for ${stabilityMs}ms.`,
  )
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
    autoDeploy: readArg('--auto-deploy') || env('RENDER_WORKER_AUTO_DEPLOY') || 'no',
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

function unwrapService(body) {
  return body?.service && typeof body.service === 'object' ? body.service : body
}

function serviceType(service) {
  return String(service?.type || service?.serviceDetails?.type || '')
}

function serviceSuspendedState(service) {
  return String(service?.suspended || service?.serviceDetails?.suspended || '')
}

function serviceAutoDeployState(service) {
  const raw = service?.autoDeploy ?? service?.serviceDetails?.autoDeploy
  if (raw === false) return 'no'
  if (raw === true) return 'yes'
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'false' || value === 'off' || value === 'disabled') return 'no'
  if (value === 'true' || value === 'on' || value === 'enabled') return 'yes'
  return value
}

async function getService(serviceId, options = {}) {
  return unwrapService(await renderRequest(
    `/services/${encodeURIComponent(serviceId)}`,
    options,
  ))
}

async function waitForServiceState(serviceId, expectedState, options = {}) {
  const waitMs = positiveIntArg('--service-wait-ms', DEFAULT_SERVICE_WAIT_MS)
  const pollMs = positiveIntArg('--service-poll-ms', DEFAULT_SERVICE_POLL_MS)
  const startedAt = Date.now()
  let lastState = 'unknown'
  while (Date.now() - startedAt < waitMs) {
    const service = await getService(serviceId, options)
    lastState = serviceSuspendedState(service) || 'unknown'
    if (lastState === expectedState) return service
    await sleep(pollMs, options)
  }
  throw new Error(
    `Timed out after ${waitMs}ms waiting for Render service ${serviceId} to become ` +
    `${expectedState}; last state was ${lastState}.`,
  )
}

async function resumeService(serviceId) {
  await renderRequest(`/services/${encodeURIComponent(serviceId)}/resume`, { method: 'POST' })
  await waitForServiceState(serviceId, 'not_suspended')
  console.log(`Render worker ${serviceId} is temporarily resumed.`)
}

async function suspendAndVerifyService(serviceId, options = {}) {
  const service = await getService(serviceId, options)
  if (serviceSuspendedState(service) !== 'suspended') {
    await renderRequest(`/services/${encodeURIComponent(serviceId)}/suspend`, {
      method: 'POST',
      ...options,
    })
  }
  await waitForServiceState(serviceId, 'suspended', options)
  console.log(`Render worker ${serviceId} is suspended.`)
}

async function suspendAndVerifyForCleanup(serviceId) {
  const maxAttempts = 3
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await suspendAndVerifyService(serviceId, { allowAfterInterrupt: true })
      return
    } catch (error) {
      lastError = error
      if (attempt >= maxAttempts) break
      console.error(
        `Suspend-and-verify cleanup attempt ${attempt}/${maxAttempts} failed; retrying while ` +
        `intake remains held. ${error instanceof Error ? error.message : String(error)}`,
      )
      await sleep(DEFAULT_SERVICE_POLL_MS, { allowAfterInterrupt: true })
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Render suspend-and-verify cleanup failed without an error response.')
}

async function disableAndVerifyAutoDeploy(serviceId, options = {}) {
  let service = await getService(serviceId, options)
  if (serviceAutoDeployState(service) !== 'no') {
    await renderRequest(`/services/${encodeURIComponent(serviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ autoDeploy: 'no' }),
      ...options,
    })
    service = await getService(serviceId, options)
  }
  if (serviceAutoDeployState(service) !== 'no') {
    throw new Error(
      `Render service ${serviceId} still reports autoDeploy=${serviceAutoDeployState(service) || 'unknown'} ` +
      'after requesting autoDeploy=no.',
    )
  }
  console.log(`Render worker ${serviceId} auto-deploy is disabled and verified.`)
  return service
}

function deployCommitId(body) {
  const candidates = [
    body?.commit?.id,
    body?.commit?.commitId,
    body?.commitId,
    body?.commit_id,
  ]
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate)
  return value ? String(value).toLowerCase() : ''
}

function verifyDeployCommit(body, expectedCommitId, deployId) {
  const actualCommitId = deployCommitId(body)
  if (!actualCommitId) {
    throw new Error(
      `Render deploy ${deployId} did not expose a commit identity, so the worker artifact cannot be proven exact.`,
    )
  }
  if (actualCommitId !== expectedCommitId.toLowerCase()) {
    throw new Error(
      `Render deploy ${deployId} uses commit ${actualCommitId}, expected ${expectedCommitId}.`,
    )
  }
}

async function triggerDeploy(serviceId, commitId = '') {
  const clearCache = hasFlag('--clear-cache') ? 'clear' : 'do_not_clear'
  const body = await renderRequest(`/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: 'POST',
    body: JSON.stringify({
      clearCache,
      ...(commitId ? { commitId } : {}),
    }),
  })
  const deployId = typeof body?.id === 'string' ? body.id : ''
  console.log(`Triggered Render worker deploy ${deployId || '<unknown>'} (${body?.status || 'created'}).`)
  return { deployId, body }
}

function positiveIntArg(name, fallback) {
  const raw = readArg(name)
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer.`)
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

async function waitForDeploy(serviceId, deployId) {
  if (!deployId) {
    throw new Error('Render did not return a deploy id, so deployment completion cannot be verified.')
  }
  const waitMs = positiveIntArg('--deploy-wait-ms', DEFAULT_DEPLOY_WAIT_MS)
  const pollMs = positiveIntArg('--deploy-poll-ms', DEFAULT_DEPLOY_POLL_MS)
  const startedAt = Date.now()
  let lastStatus = 'unknown'

  console.log(`Waiting for Render worker deploy ${deployId} to become live (${waitMs}ms max).`)
  while (Date.now() - startedAt < waitMs) {
    const body = await renderRequest(
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    )
    lastStatus = typeof body?.status === 'string' ? body.status : 'unknown'
    if (SUCCESSFUL_DEPLOY_STATUSES.has(lastStatus)) {
      console.log(`Render worker deploy ${deployId} is live.`)
      return body
    }
    if (FAILED_DEPLOY_STATUSES.has(lastStatus)) {
      throw new Error(`Render worker deploy ${deployId} ended with status ${lastStatus}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(
    `Timed out after ${waitMs}ms waiting for Render worker deploy ${deployId}; ` +
    `last status was ${lastStatus}.`,
  )
}

async function readDeploy(serviceId, deployId) {
  return renderRequest(
    `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
  )
}

const apply = hasFlag('--apply')
const triggerDeployAfterApply = hasFlag('--trigger-deploy') || hasFlag('--deploy')
const waitForDeployAfterTrigger = hasFlag('--wait-for-deploy')
const safeSuspendedDeploy = hasFlag('--safe-suspended-deploy') ||
  hasFlag('--guarded-suspended-deploy')
const releaseIntakeOnly = hasFlag('--release-intake-hold')
const keepIntakeHeld = hasFlag('--keep-intake-held')
const disableAutoDeployOnly = hasFlag('--disable-auto-deploy') ||
  hasFlag('--disable-auto-deploy-only')

function validateHoldId(value) {
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
    throw new Error('The intake hold id must be 8-128 letters, numbers, dots, colons, underscores, or hyphens.')
  }
  return value
}

async function resolveDeployedQueueName(baseUrl, baseName) {
  const explicit = readArg('--intake-queue')
  if (explicit) {
    if (!SAFE_QUEUE_NAME.test(explicit)) throw new Error('Invalid --intake-queue value.')
    if (!queueMatchesBase(explicit, baseName)) {
      throw new Error(`Intake queue ${explicit} does not belong to queue base ${baseName}.`)
    }
    return explicit
  }
  const status = await signedIntakeStatus(baseUrl)
  const queueName = status.body.queueName
  if (!SAFE_QUEUE_NAME.test(queueName) || !queueMatchesBase(queueName, baseName)) {
    throw new Error(
      `Deployed queue ${queueName} does not match the expected queue base ${baseName}.`,
    )
  }
  return queueName
}

async function releaseHeldIntake() {
  const holdId = validateHoldId(readArg('--intake-hold-id') || env('AGENT_INTAKE_HOLD_ID'))
  const baseUrl = intakeBaseUrl()
  const baseName = queueBaseName()
  const deployedQueueName = await resolveDeployedQueueName(baseUrl, baseName)
  console.log(
    `Deployed app reports exact queue ${deployedQueueName}; releasing stable base hold ${baseName}.`,
  )
  const client = createQueueClient()
  try {
    await releaseIntakeHold(client, baseName, holdId)
  } finally {
    client.close()
  }
}

async function runDisableAutoDeployOnly(serviceId) {
  if (!apply) {
    throw new Error('--disable-auto-deploy-only requires --apply.')
  }
  if (hasFlag('--create-if-missing')) {
    throw new Error('--disable-auto-deploy-only only operates on an existing Render service.')
  }
  const service = await getService(serviceId)
  if (serviceType(service) !== 'background_worker') {
    throw new Error(
      `Render service ${serviceId} is ${serviceType(service) || 'an unknown type'}, not background_worker.`,
    )
  }
  if (serviceSuspendedState(service) !== 'suspended') {
    throw new Error(
      `Render service ${serviceId} must be suspended before disabling auto-deploy; ` +
      `current state is ${serviceSuspendedState(service) || 'unknown'}.`,
    )
  }
  const verified = await disableAndVerifyAutoDeploy(serviceId)
  if (serviceSuspendedState(verified) !== 'suspended') {
    throw new Error(
      `Render service ${serviceId} changed suspension state while disabling auto-deploy.`,
    )
  }
}

async function runGuardedSuspendedDeploy(input) {
  if (!apply) throw new Error('--safe-suspended-deploy requires --apply.')
  if (!triggerDeployAfterApply || !waitForDeployAfterTrigger) {
    throw new Error(
      '--safe-suspended-deploy requires both --trigger-deploy and --wait-for-deploy.',
    )
  }

  const service = await getService(input.serviceId)
  if (serviceType(service) !== 'background_worker') {
    throw new Error(
      `Render service ${input.serviceId} is ${serviceType(service) || 'an unknown type'}, not background_worker.`,
    )
  }
  if (serviceSuspendedState(service) !== 'suspended') {
    throw new Error(
      `Render service ${input.serviceId} must already be suspended before a guarded rollout; ` +
      `current state is ${serviceSuspendedState(service) || 'unknown'}.`,
    )
  }

  const commitId = exactCommitId()
  const holdId = validateHoldId(
    readArg('--intake-hold-id') || env('AGENT_INTAKE_HOLD_ID') || randomUUID(),
  )
  const baseUrl = intakeBaseUrl()
  const baseName = queueBaseName()
  const deployedQueueName = await resolveDeployedQueueName(baseUrl, baseName)
  const client = createQueueClient()
  let holdAcquired = false
  let resumeAttempted = false
  let deployId = ''
  let deployVerified = false
  let suspendError = null
  let operationError = null

  try {
    // Hold the stable base namespace so the same owner survives a protocol
    // suffix change between the old and new web deployments. The signed app
    // response still proves the exact queue currently accepting tasks.
    await acquireIntakeHold(client, baseName, holdId)
    holdAcquired = true
    await proveDeployedIntakeHold(baseUrl, deployedQueueName, holdId)
    await proveQueueDrained(client, baseName, deployedQueueName)

    await disableAndVerifyAutoDeploy(input.serviceId)
    await applyEnvVars(input.serviceId, input.expected, input.rows)
    console.log('Render worker env apply finished.')

    // Repeat both proofs immediately before resume. The durable hold closes
    // new acceptance, while the second stable drain check rules out work that
    // was already in flight when the hold first became visible.
    await proveDeployedIntakeHold(baseUrl, deployedQueueName, holdId)
    await proveQueueDrained(client, baseName, deployedQueueName)

    resumeAttempted = true
    await resumeService(input.serviceId)
    const triggered = await triggerDeploy(input.serviceId, commitId)
    deployId = triggered.deployId
    const liveDeploy = await waitForDeploy(input.serviceId, deployId)
    verifyDeployCommit(liveDeploy, commitId, deployId)
    deployVerified = true
  } catch (error) {
    operationError = error
  } finally {
    if (holdAcquired || resumeAttempted) {
      try {
        await suspendAndVerifyForCleanup(input.serviceId)
      } catch (error) {
        suspendError = error
      }
    }
  }

  if (interruptedSignal && !operationError) operationError = interruptionError()
  if (operationError) {
    client.close()
    if (suspendError) {
      throw new Error(
        `Render rollout failed and cleanup could not prove the base is suspended. ` +
        `Intake hold ${holdId} remains active. Rollout error: ${
          operationError instanceof Error ? operationError.message : String(operationError)
        }. Suspension error: ${
          suspendError instanceof Error ? suspendError.message : String(suspendError)
        }`,
      )
    }
    throw new Error(
      `${operationError instanceof Error ? operationError.message : String(operationError)} ` +
      `Intake hold ${holdId} remains active.`,
    )
  }
  if (suspendError) {
    client.close()
    throw new Error(
      `Render deploy cleanup could not prove the base is suspended. Intake hold ${holdId} remains active. ` +
      `${suspendError instanceof Error ? suspendError.message : String(suspendError)}`,
    )
  }
  if (!deployVerified || !deployId) {
    client.close()
    throw new Error(
      `Render deploy did not reach exact-artifact verification. Intake hold ${holdId} remains active.`,
    )
  }

  const finalService = await getService(input.serviceId)
  if (serviceSuspendedState(finalService) !== 'suspended') {
    client.close()
    throw new Error(
      `Render base suspension changed after cleanup. Intake hold ${holdId} remains active.`,
    )
  }
  if (serviceAutoDeployState(finalService) !== 'no') {
    client.close()
    throw new Error(
      `Render base auto-deploy changed after cleanup. Intake hold ${holdId} remains active.`,
    )
  }
  const finalDeploy = await readDeploy(input.serviceId, deployId)
  if (!SUCCESSFUL_DEPLOY_STATUSES.has(String(finalDeploy?.status || ''))) {
    client.close()
    throw new Error(
      `Render deploy ${deployId} is no longer live after suspension. Intake hold ${holdId} remains active.`,
    )
  }
  verifyDeployCommit(finalDeploy, commitId, deployId)
  console.log(
    `Verified suspended Render base ${input.serviceId} uses exact commit ${commitId} (deploy ${deployId}).`,
  )

  if (interruptedSignal) {
    client.close()
    throwIfInterrupted()
  }
  if (keepIntakeHeld) {
    console.log(
      `Intake hold ${holdId} remains active for the web rollout. ` +
      `Release it only after readiness with --release-intake-hold --intake-hold-id ${holdId}.`,
    )
  } else {
    throwIfInterrupted()
    await releaseIntakeHold(client, baseName, holdId)
    if (interruptedSignal) {
      await acquireIntakeHold(client, baseName, holdId)
      client.close()
      throw interruptionError()
    }
  }
  client.close()
}

async function main() {
  if (releaseIntakeOnly) {
    await releaseHeldIntake()
    return
  }

  const templateText = await readFile(`${root}/render.worker.env.example`, 'utf8')
  const templateEntries = parseEnvTemplate(templateText)
  const { expected, missingLocal } = buildExpectedEntries(templateEntries)
  if (disableAutoDeployOnly && hasFlag('--create-if-missing')) {
    throw new Error('--disable-auto-deploy-only only operates on an existing Render service.')
  }
  const serviceId = await resolveServiceId(expected, missingLocal)
  if (disableAutoDeployOnly) {
    await runDisableAutoDeployOnly(serviceId)
    return
  }
  const current = await listEnvVars(serviceId)
  const rows = buildRows(expected, current)

  printReport({ serviceId, apply, triggerDeploy: triggerDeployAfterApply, rows, missingLocal })

  if (missingLocal.length > 0) process.exitCode = 1
  if (!apply || missingLocal.length > 0) process.exit()

  if (waitForDeployAfterTrigger && !triggerDeployAfterApply) {
    throw new Error('--wait-for-deploy requires --trigger-deploy or --deploy.')
  }
  if (safeSuspendedDeploy) {
    await runGuardedSuspendedDeploy({ serviceId, expected, rows })
    return
  }

  await applyEnvVars(serviceId, expected, rows)
  console.log('Render worker env apply finished.')

  if (triggerDeployAfterApply) {
    const service = await getService(serviceId)
    if (serviceSuspendedState(service) === 'suspended') {
      throw new Error(
        'The Render base is suspended. Use --safe-suspended-deploy with an intake-hold-aware deployed app; ' +
        'an unguarded deploy trigger can fail or briefly expose the production queue.',
      )
    }
    const triggered = await triggerDeploy(serviceId)
    if (waitForDeployAfterTrigger) await waitForDeploy(serviceId, triggered.deployId)
  }
}

try {
  await main()
} catch (error) {
  console.error(`Render worker env check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
