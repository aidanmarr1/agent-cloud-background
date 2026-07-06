#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))

loadLocalEnvFiles(rootUrl)

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { createUser } = await jiti.import(fileURLToPath(new URL('../src/lib/auth/users.ts', import.meta.url)))
const { tursoExecute } = await jiti.import(fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url)))
const { topUpServerCredits } = await jiti.import(fileURLToPath(new URL('../src/lib/serverCredits.ts', import.meta.url)))
const { DEFAULT_MODEL } = await jiti.import(fileURLToPath(new URL('../src/lib/llm.ts', import.meta.url)))

const args = process.argv.slice(2)
const baseUrl = (readStringArg('--base-url') || args.find(arg => /^https?:\/\//.test(arg)) || 'https://agent1-0.vercel.app').replace(/\/$/, '')
const timeoutMs = readIntArg('--timeout-ms', 30_000)
const minToolResultsBeforeExit = readIntArg('--min-tool-results', 1)
const stopAfterPlan = args.includes('--stop-after-plan')
const prompt = readStringArg('--prompt') ||
  'Research one current fact about AI agent startup latency and answer in one sentence.'
const email = `latency-probe-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`
const password = `LatencyProbe-${randomUUID()}`
const conversationId = `latency_probe_${Date.now()}_${randomUUID().slice(0, 8)}`
let userId = ''
let runId = ''
let postStartedAt = 0

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

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }
  const cookie = response.headers.get('set-cookie')
  return cookie ? [cookie] : []
}

function mergeCookieHeader(...cookieGroups) {
  const cookies = new Map()
  for (const group of cookieGroups) {
    for (const cookie of group) {
      const pair = cookie.split(';')[0]
      const index = pair.indexOf('=')
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
  }
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function cleanup() {
  const runIds = [runId].filter(Boolean)
  try {
    if (runIds.length) {
      for (const id of runIds) {
        await tursoExecute('delete from agent_task_events where run_id = ?', [id]).catch(() => undefined)
        await tursoExecute('delete from agent_task_jobs where run_id = ?', [id]).catch(() => undefined)
        await tursoExecute('delete from user_active_task_leases where run_id = ?', [id]).catch(() => undefined)
        await tursoExecute('delete from active_tasks where run_id = ?', [id]).catch(() => undefined)
      }
    }
    if (userId) {
      await tursoExecute('delete from user_active_task_leases where user_id = ?', [userId]).catch(() => undefined)
      await tursoExecute('delete from conversations where user_id = ? or id = ?', [userId, conversationId]).catch(() => undefined)
      await tursoExecute('delete from credit_ledger where user_id = ?', [userId]).catch(() => undefined)
      await tursoExecute('delete from credit_accounts where user_id = ?', [userId]).catch(() => undefined)
      await tursoExecute('delete from users where id = ? or email = ?', [userId, email]).catch(() => undefined)
    } else {
      await tursoExecute('delete from users where email = ?', [email]).catch(() => undefined)
    }
  } catch {
    // Best-effort diagnostic cleanup.
  }
}

async function loadPersistedTimingSnapshot() {
  if (!runId) return null
  try {
    const [jobRows, eventRows] = await Promise.all([
      tursoExecute(
        'select status, started_at_ms, updated_at_ms, completed_at_ms, worker_id, attempts from agent_task_jobs where run_id = ? limit 1',
        [runId],
      ),
      tursoExecute(
        'select seq, event_json, created_at_ms from agent_task_events where run_id = ? order by seq asc limit 20',
        [runId],
      ),
    ])
    return {
      job: jobRows.rows[0] || null,
      events: eventRows.rows.map((row) => {
        let type = 'unknown'
        try {
          type = JSON.parse(String(row.event_json || '{}')).type || 'unknown'
        } catch {
          // Keep type unknown.
        }
        const createdAt = Number(row.created_at_ms)
        return {
          seq: Number(row.seq),
          type,
          createdAtMs: Number.isFinite(createdAt) ? createdAt : null,
          createdElapsedMs: Number.isFinite(createdAt) && postStartedAt ? createdAt - postStartedAt : null,
        }
      }),
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

try {
  const user = await createUser({
    name: 'Latency Probe',
    email,
    password,
    accessStatus: 'approved',
  })
  userId = user.id
  await topUpServerCredits(userId, 250, 'Temporary latency probe credits')

  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`)
  if (!csrfResponse.ok) throw new Error(`CSRF request failed with HTTP ${csrfResponse.status}`)
  const csrf = await csrfResponse.json()
  const csrfCookies = getSetCookies(csrfResponse)
  const callbackResponse = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: mergeCookieHeader(csrfCookies),
    },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      redirect: 'false',
      json: 'true',
    }),
  })
  const authCookies = getSetCookies(callbackResponse)
  const cookie = mergeCookieHeader(csrfCookies, authCookies)
  if (!/authjs\.session-token|next-auth\.session-token/i.test(cookie)) {
    throw new Error(`Credentials callback did not issue a session cookie. HTTP ${callbackResponse.status}`)
  }

  const body = {
    conversationId,
    model: DEFAULT_MODEL,
    startFreshSandbox: true,
    messages: [{ role: 'user', content: prompt }],
  }
  postStartedAt = Date.now()
  const fetchController = new AbortController()
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: new URL(baseUrl).origin,
    },
    body: JSON.stringify(body),
    signal: fetchController.signal,
  })
  const headersMs = Date.now() - postStartedAt
  runId = response.headers.get('x-agent-run-id') || ''
  const routeElapsedHeader = response.headers.get('x-agent-route-elapsed-ms')
  const routeTimingsHeader = response.headers.get('x-agent-route-timings')
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    console.log(JSON.stringify({
      ok: false,
      baseUrl,
      conversationId,
      runId,
      status: response.status,
      headersMs,
      routeElapsedHeader,
      routeTimingsHeader,
      errorBody: text.slice(0, 1000),
    }, null, 2))
    throw new Error(`Chat request failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const deadline = postStartedAt + timeoutMs
  let buffer = ''
  let firstText = null
  let firstPlan = null
  let firstTool = null
  let firstToolResult = null
  let firstPostToolText = null
  let secondTool = null
  let toolResultCount = 0
  let targetToolResult = null
  let firstTextAfterTargetToolResult = null
  let terminal = null
  const firstEvents = []

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const read = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ])
    if (read.timeout) break
    if (read.done) break
    buffer += decoder.decode(read.value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const event = parseSseBlock(block)
      if (!event) continue
      const elapsed = Date.now() - postStartedAt
      if (firstEvents.length < 8) {
        firstEvents.push({
          elapsed,
          type: event.type,
          seq: event.seq,
          content: typeof event.content === 'string' ? event.content.slice(0, 120) : undefined,
          name: event.name,
        })
      }
      if (!firstText && event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()) {
        firstText = { elapsed, seq: event.seq, content: event.content.slice(0, 240) }
      }
      if (!firstPlan && event.type === 'plan') {
        firstPlan = { elapsed, seq: event.seq, items: Array.isArray(event.items) ? event.items : [] }
      }
      if (!firstTool && event.type === 'tool_start') {
        firstTool = { elapsed, seq: event.seq, name: event.name, args: event.args || null }
      }
      if (!firstToolResult && event.type === 'tool_result') {
        firstToolResult = { elapsed, seq: event.seq, name: event.name }
      }
      if (event.type === 'tool_result') {
        toolResultCount++
        if (toolResultCount === minToolResultsBeforeExit) {
          targetToolResult = { elapsed, seq: event.seq, name: event.name, count: toolResultCount }
        }
      }
      if (firstToolResult && !firstPostToolText && event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()) {
        firstPostToolText = { elapsed, seq: event.seq, content: event.content.slice(0, 240) }
      }
      if (targetToolResult && !firstTextAfterTargetToolResult && event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()) {
        firstTextAfterTargetToolResult = { elapsed, seq: event.seq, content: event.content.slice(0, 240) }
      }
      if (firstToolResult && !secondTool && event.type === 'tool_start') {
        secondTool = { elapsed, seq: event.seq, name: event.name, args: event.args || null }
      }
      if (event.type === 'done' || event.type === 'error') {
        terminal = { elapsed, type: event.type, seq: event.seq, message: event.message }
      }
    }
    const targetSatisfied = stopAfterPlan
      ? !!(firstText && firstPlan)
      : minToolResultsBeforeExit <= 1
      ? !!(secondTool || firstPostToolText)
      : !!(targetToolResult && firstTextAfterTargetToolResult)
    if (firstText && firstPlan && firstTool && firstToolResult && targetSatisfied) break
    if (stopAfterPlan && targetSatisfied) break
    if (terminal) break
  }

  fetchController.abort()
  await Promise.race([
    reader.cancel().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ])

  const persistedTiming = await loadPersistedTimingSnapshot()

  console.log(JSON.stringify({
    ok: !!firstText && !!firstPlan,
    baseUrl,
    conversationId,
    runId,
    headersMs,
    routeElapsedHeader,
    routeTimingsHeader,
    firstTextMs: firstText?.elapsed ?? null,
    firstPlanMs: firstPlan?.elapsed ?? null,
    firstToolMs: firstTool?.elapsed ?? null,
    firstToolResultMs: firstToolResult?.elapsed ?? null,
    secondToolMs: secondTool?.elapsed ?? null,
    firstPostToolTextMs: firstPostToolText?.elapsed ?? null,
    firstToolResultToSecondToolMs: firstToolResult && secondTool ? secondTool.elapsed - firstToolResult.elapsed : null,
    firstToolResultToPostToolTextMs: firstToolResult && firstPostToolText ? firstPostToolText.elapsed - firstToolResult.elapsed : null,
    minToolResultsBeforeExit,
    stopAfterPlan,
    toolResultCount,
    targetToolResult,
    firstTextAfterTargetToolResult,
    targetToolResultToTextMs: targetToolResult && firstTextAfterTargetToolResult ? firstTextAfterTargetToolResult.elapsed - targetToolResult.elapsed : null,
    terminal,
    firstText,
    firstPlan,
    firstTool,
    firstToolResult,
    firstPostToolText,
    secondTool,
    firstEvents,
    persistedTiming,
  }, null, 2))
} finally {
  await cleanup()
}
