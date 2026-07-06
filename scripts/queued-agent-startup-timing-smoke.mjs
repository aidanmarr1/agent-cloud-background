#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))

loadLocalEnvFiles(rootUrl)

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { enqueueTaskJob } = await jiti.import(fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)))
const { tursoExecute } = await jiti.import(fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url)))
const { DEFAULT_MODEL } = await jiti.import(fileURLToPath(new URL('../src/lib/llm.ts', import.meta.url)))

const args = process.argv.slice(2)
const timeoutMs = readIntArg('--timeout-ms', 90_000)
const pollMs = readIntArg('--poll-ms', 150)
const waitDone = args.includes('--wait-done')
const prompt = readStringArg('--prompt') ||
  'Research whether Exa AI can expand beyond AI-native companies; answer concisely with evidence.'

const runId = `queued-startup-${randomUUID()}`
const userId = `internal-queued-smoke-${randomUUID()}`
const conversationId = `internal-queued-smoke-${randomUUID()}`

function readStringArg(name) {
  const prefix = `${name}=`
  const equal = args.find((arg) => arg.startsWith(prefix))
  if (equal) return equal.slice(prefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function readIntArg(name, fallback) {
  const parsed = Number.parseInt(readStringArg(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseEvent(row) {
  if (!row || typeof row.event_json !== 'string') return null
  try {
    return JSON.parse(row.event_json)
  } catch {
    return null
  }
}

async function cleanup() {
  await tursoExecute('delete from agent_task_events where run_id = ?', [runId]).catch(() => undefined)
  await tursoExecute('delete from agent_task_jobs where run_id = ?', [runId]).catch(() => undefined)
  await tursoExecute('delete from active_tasks where run_id = ?', [runId]).catch(() => undefined)
}

await cleanup()

const t0 = Date.now()
await enqueueTaskJob({
  runId,
  userId,
  conversationId,
  payload: {
    kind: 'chat',
    messages: [{ role: 'user', content: prompt }],
    model: DEFAULT_MODEL,
    startFreshSandbox: true,
    startIsolatedTaskSandbox: true,
    directChat: false,
  },
})
const enqueuedAt = Date.now()

let jobInsertedAt = null
let firstText = null
let plan = null
let firstTool = null
let done = null
let error = null
const deadline = t0 + timeoutMs

while (Date.now() < deadline) {
  const jobRows = await tursoExecute(
    'select started_at_ms, status, terminal_status, terminal_error from agent_task_jobs where run_id = ? limit 1',
    [runId],
  )
  const job = jobRows.rows[0]
  if (job && jobInsertedAt === null) {
    const started = Number(job.started_at_ms)
    if (Number.isFinite(started)) jobInsertedAt = started
  }

  const eventRows = await tursoExecute(
    'select seq, event_json, created_at_ms from agent_task_events where run_id = ? order by seq asc',
    [runId],
  )
  for (const row of eventRows.rows) {
    const event = parseEvent(row)
    if (!event) continue
    const createdAt = Number(row.created_at_ms)
    if (!firstText && event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()) {
      firstText = {
        seq: Number(row.seq),
        createdAt,
        observedAt: Date.now(),
        snippet: event.content.replace(/\s+/g, ' ').slice(0, 160),
      }
    }
    if (!plan && event.type === 'plan') {
      plan = {
        seq: Number(row.seq),
        createdAt,
        observedAt: Date.now(),
        items: Array.isArray(event.items) ? event.items : [],
      }
    }
    if (!firstTool && event.type === 'tool_start') {
      firstTool = {
        seq: Number(row.seq),
        createdAt,
        observedAt: Date.now(),
        name: event.name,
        label: event.args?.action_label || event.args?.query || event.args?.url || null,
      }
    }
    if (!done && event.type === 'done') {
      done = { seq: Number(row.seq), createdAt, observedAt: Date.now() }
    }
    if (!error && event.type === 'error') {
      error = { seq: Number(row.seq), createdAt, observedAt: Date.now(), message: event.message }
    }
  }

  const startupObserved = !!firstText && !!plan && (!!firstTool || !!done)
  if ((!waitDone && startupObserved) || done || error) break
  await sleep(pollMs)
}

const metric = (entry) => entry ? {
  fromEnqueueMs: entry.createdAt - t0,
  fromEnqueueDoneMs: entry.createdAt - enqueuedAt,
  observedFromEnqueueMs: entry.observedAt - t0,
  observedFromEnqueueDoneMs: entry.observedAt - enqueuedAt,
  persistenceLagMs: entry.observedAt - entry.createdAt,
  fromJobInsertMs: jobInsertedAt ? entry.createdAt - jobInsertedAt : null,
  ...entry,
} : null

const result = {
  ok: !!firstText && !!plan && !error && (!!firstTool || !!done) && (!waitDone || !!done),
  runId,
  conversationId,
  status: error ? 'error' : done ? 'done' : 'running',
  prompt,
  enqueueDurationMs: enqueuedAt - t0,
  jobInsertedAfterStartMs: jobInsertedAt ? jobInsertedAt - t0 : null,
  firstText: metric(firstText),
  plan: metric(plan),
  firstTool: metric(firstTool),
  done: metric(done),
  error: metric(error),
}

console.log(JSON.stringify(result, null, 2))

await cleanup()

if (!result.ok) {
  process.exitCode = 1
}
