#!/usr/bin/env node

import { createClient } from '@tursodatabase/serverless/compat'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const args = process.argv.slice(2)

loadLocalEnvFiles(rootUrl)

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function hasArg(name) {
  return args.includes(name)
}

function env(name) {
  return process.env[name]?.trim() || ''
}

function validateQueueName(queueName) {
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(queueName)
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function ageMs(timestampMs) {
  const timestamp = numberValue(timestampMs)
  if (!timestamp) return null
  return Math.max(0, Date.now() - timestamp)
}

function formatAge(timestampMs) {
  const age = ageMs(timestampMs)
  if (age === null) return 'unknown'
  if (age < 1_000) return `${age}ms`
  if (age < 60_000) return `${Math.round(age / 1_000)}s`
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m`
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h`
  return `${Math.round(age / 86_400_000)}d`
}

function truncate(value, length = 14) {
  const text = String(value || '')
  if (text.length <= length) return text
  return `${text.slice(0, length - 1)}...`
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

function printHelp() {
  console.log(`Usage: npm run cloud:queue -- [options]

Inspect and maintain the Turso-backed cloud task queue.

Options:
  --queue <name>              Queue namespace to inspect. Defaults to AGENT_TASK_QUEUE_NAME or "default".
  --json                      Print JSON instead of a human-readable report.
  --cleanup-smoke --yes       Delete terminal internal background-smoke jobs/events for this queue.
  --release-expired --yes     Requeue running jobs whose worker lease has already expired.
  --limit <n>                 Recent job row limit. Defaults to 10.
  --help                      Show this help.

The cleanup actions are queue-scoped. They do not delete user jobs unless --release-expired is used, and that
action only requeues jobs whose running lease has expired.`)
}

if (hasArg('--help') || hasArg('-h')) {
  printHelp()
  process.exit(0)
}

const databaseUrl = env('TURSO_DATABASE_URL')
const authToken = env('TURSO_AUTH_TOKEN')
const queueName = readArg('--queue') || env('AGENT_TASK_QUEUE_NAME') || 'default'
const json = hasArg('--json')
const yes = hasArg('--yes')
const cleanupSmoke = hasArg('--cleanup-smoke')
const releaseExpired = hasArg('--release-expired')
const limit = Math.min(100, Math.max(1, numberValue(readArg('--limit'), 10)))

if (!databaseUrl || !authToken) {
  const missing = [
    !databaseUrl ? 'TURSO_DATABASE_URL' : null,
    !authToken ? 'TURSO_AUTH_TOKEN' : null,
  ].filter(Boolean)
  console.error(`Turso is not configured. Missing: ${missing.join(', ')}`)
  process.exit(1)
}

if (!validateQueueName(queueName)) {
  console.error('Invalid queue name. Use 1-128 letters, numbers, dots, colons, underscores, or hyphens.')
  process.exit(1)
}

if ((cleanupSmoke || releaseExpired) && !yes) {
  console.error('Refusing to modify queue state without --yes.')
  process.exit(1)
}

const client = createClient({ url: databaseUrl, authToken })

async function tableExists(name) {
  const result = await client.execute({
    sql: "select name from sqlite_master where type = 'table' and name = ? limit 1",
    args: [name],
  })
  return result.rows.length > 0
}

async function executeIfTable(name, fallback, fn) {
  if (!(await tableExists(name))) return fallback
  return fn()
}

async function readJobCounts() {
  return executeIfTable('agent_task_jobs', [], async () => {
    const result = await client.execute({
      sql: `
        select status, count(*) as count
        from agent_task_jobs
        where queue_name = ?
        group by status
        order by status
      `,
      args: [queueName],
    })
    return result.rows.map((row) => ({
      status: String(row.status || 'unknown'),
      count: numberValue(row.count),
    }))
  })
}

async function readRecentJobs() {
  return executeIfTable('agent_task_jobs', [], async () => {
    const result = await client.execute({
      sql: `
        select run_id, user_id, conversation_id, status, terminal_status, updated_at_ms,
               completed_at_ms, worker_id, lease_expires_at_ms, attempts, cancel_requested
        from agent_task_jobs
        where queue_name = ?
        order by updated_at_ms desc
        limit ?
      `,
      args: [queueName, limit],
    })
    return result.rows.map((row) => ({
      runId: String(row.run_id || ''),
      userId: String(row.user_id || ''),
      conversationId: String(row.conversation_id || ''),
      status: String(row.status || 'unknown'),
      terminalStatus: row.terminal_status ? String(row.terminal_status) : null,
      updatedAtMs: numberValue(row.updated_at_ms),
      updatedAge: formatAge(row.updated_at_ms),
      completedAtMs: row.completed_at_ms === null || row.completed_at_ms === undefined ? null : numberValue(row.completed_at_ms),
      workerId: row.worker_id ? String(row.worker_id) : null,
      leaseExpiresAtMs: row.lease_expires_at_ms === null || row.lease_expires_at_ms === undefined ? null : numberValue(row.lease_expires_at_ms),
      leaseExpired: row.lease_expires_at_ms !== null && row.lease_expires_at_ms !== undefined && numberValue(row.lease_expires_at_ms) <= Date.now(),
      attempts: numberValue(row.attempts),
      cancelRequested: row.cancel_requested === 1 || row.cancel_requested === true,
    }))
  })
}

async function readWorkers() {
  return executeIfTable('agent_task_workers', [], async () => {
    const result = await client.execute({
      sql: `
        select worker_id, status, current_run_id, last_seen_at_ms, heartbeat_ms,
               completed_tasks, process_id, hostname
        from agent_task_workers
        where queue_name = ?
        order by last_seen_at_ms desc
        limit 20
      `,
      args: [queueName],
    })
    return result.rows.map((row) => ({
      workerId: String(row.worker_id || ''),
      status: String(row.status || 'unknown'),
      currentRunId: row.current_run_id ? String(row.current_run_id) : null,
      lastSeenAtMs: numberValue(row.last_seen_at_ms),
      lastSeenAge: formatAge(row.last_seen_at_ms),
      heartbeatMs: numberValue(row.heartbeat_ms),
      completedTasks: numberValue(row.completed_tasks),
      processId: numberValue(row.process_id),
      hostname: String(row.hostname || ''),
    }))
  })
}

async function readActiveLeases() {
  return executeIfTable('user_active_task_leases', [], async () => {
    const result = await client.execute({
      sql: `
        select user_id, conversation_id, run_id, started_at_ms, updated_at_ms, expires_at_ms
        from user_active_task_leases
        where queue_name = ?
        order by updated_at_ms desc
        limit 20
      `,
      args: [queueName],
    })
    return result.rows.map((row) => ({
      userId: String(row.user_id || ''),
      conversationId: String(row.conversation_id || ''),
      runId: String(row.run_id || ''),
      startedAtMs: numberValue(row.started_at_ms),
      updatedAtMs: numberValue(row.updated_at_ms),
      updatedAge: formatAge(row.updated_at_ms),
      expiresAtMs: numberValue(row.expires_at_ms),
      expired: numberValue(row.expires_at_ms) <= Date.now(),
    }))
  })
}

async function cleanupSmokeJobs() {
  return executeIfTable('agent_task_jobs', { jobsDeleted: 0, eventsDeleted: 0 }, async () => {
    const result = await client.execute({
      sql: `
        select run_id
        from agent_task_jobs
        where queue_name = ?
          and user_id like 'internal-background-smoke-%'
          and run_id like 'background-smoke-%'
          and status in ('done', 'error', 'cancelled')
      `,
      args: [queueName],
    })
    const runIds = result.rows.map((row) => String(row.run_id || '')).filter(Boolean)
    let eventsDeleted = 0
    let jobsDeleted = 0
    for (const runId of runIds) {
      const eventDelete = await client.execute({
        sql: 'delete from agent_task_events where run_id = ?',
        args: [runId],
      }).catch(() => ({ rowsAffected: 0 }))
      eventsDeleted += numberValue(eventDelete.rowsAffected)
      const jobDelete = await client.execute({
        sql: `
          delete from agent_task_jobs
          where queue_name = ?
            and run_id = ?
            and user_id like 'internal-background-smoke-%'
            and status in ('done', 'error', 'cancelled')
        `,
        args: [queueName, runId],
      })
      jobsDeleted += numberValue(jobDelete.rowsAffected)
    }
    return { jobsDeleted, eventsDeleted }
  })
}

async function releaseExpiredClaims() {
  return executeIfTable('agent_task_jobs', { jobsRequeued: 0 }, async () => {
    const now = Date.now()
    const result = await client.execute({
      sql: `
        update agent_task_jobs
        set status = 'queued',
            worker_id = null,
            lease_expires_at_ms = null,
            updated_at_ms = ?
        where queue_name = ?
          and status = 'running'
          and terminal_status is null
          and cancel_requested = 0
          and lease_expires_at_ms is not null
          and lease_expires_at_ms <= ?
      `,
      args: [now, queueName, now],
    })
    return { jobsRequeued: numberValue(result.rowsAffected) }
  })
}

function printHuman(report) {
  console.log(`Cloud queue report for "${report.queueName}"`)
  console.log('========================================')
  console.log(`Turso tables: jobs=${report.tables.agent_task_jobs ? 'yes' : 'no'}, workers=${report.tables.agent_task_workers ? 'yes' : 'no'}, leases=${report.tables.user_active_task_leases ? 'yes' : 'no'}`)

  console.log('\nJobs by status')
  if (report.jobCounts.length === 0) {
    console.log('  none')
  } else {
    for (const row of report.jobCounts) console.log(`  ${row.status}: ${row.count}`)
  }

  console.log('\nRecent jobs')
  if (report.recentJobs.length === 0) {
    console.log('  none')
  } else {
    for (const job of report.recentJobs) {
      const lease = job.leaseExpiresAtMs ? ` lease=${job.leaseExpired ? 'expired' : 'active'}` : ''
      console.log(`  ${truncate(job.runId)} ${job.status} attempts=${job.attempts} updated=${job.updatedAge}${lease}`)
    }
  }

  console.log('\nWorkers')
  if (report.workers.length === 0) {
    console.log('  none')
  } else {
    for (const worker of report.workers) {
      const current = worker.currentRunId ? ` current=${truncate(worker.currentRunId)}` : ''
      console.log(`  ${worker.workerId} ${worker.status} seen=${worker.lastSeenAge} completed=${worker.completedTasks}${current}`)
    }
  }

  console.log('\nActive leases')
  if (report.activeLeases.length === 0) {
    console.log('  none')
  } else {
    for (const lease of report.activeLeases) {
      console.log(`  ${truncate(lease.runId)} user=${truncate(lease.userId)} updated=${lease.updatedAge} ${lease.expired ? 'expired' : 'active'}`)
    }
  }

  if (report.actions.length > 0) {
    console.log('\nActions')
    for (const action of report.actions) console.log(`  ${action.name}: ${JSON.stringify(action.result)}`)
  }
}

const tables = {
  agent_task_jobs: await tableExists('agent_task_jobs'),
  agent_task_workers: await tableExists('agent_task_workers'),
  user_active_task_leases: await tableExists('user_active_task_leases'),
}

const actions = []
if (releaseExpired) {
  actions.push({ name: 'release-expired', result: await releaseExpiredClaims() })
}
if (cleanupSmoke) {
  actions.push({ name: 'cleanup-smoke', result: await cleanupSmokeJobs() })
}

const report = {
  ok: true,
  queueName,
  tables,
  jobCounts: await readJobCounts(),
  recentJobs: await readRecentJobs(),
  workers: await readWorkers(),
  activeLeases: await readActiveLeases(),
  actions,
}

if (json) printJson(report)
else printHuman(report)
