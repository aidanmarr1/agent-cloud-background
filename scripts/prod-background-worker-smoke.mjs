import { createHmac } from 'node:crypto'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const args = process.argv.slice(2)
const rootUrl = new URL('../', import.meta.url)

loadLocalEnvFiles(rootUrl)

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

const positionalUrl = args.find((arg) => !arg.startsWith('--')) || ''
const configuredUrl = positionalUrl || readArg('--url') || process.env.AGENT_APP_URL || process.env.AUTH_URL || process.env.NEXTAUTH_URL || ''
if (!configuredUrl) {
  throw new Error('Pass the deployed app URL, set --url, or set AGENT_APP_URL, AUTH_URL, or NEXTAUTH_URL.')
}

const baseUrl = configuredUrl.replace(/\/$/, '')
const path = '/api/internal/background-worker-smoke'
const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET
const timeoutMs = Number.parseInt(readArg('--timeout-ms') || process.env.AGENT_WORKER_SMOKE_TIMEOUT_MS || '120000', 10)

if (!secret) {
  throw new Error('Missing AGENT_INTERNAL_HEALTH_SECRET or AUTH_SECRET for signed background worker smoke request.')
}

const timestamp = Date.now().toString()
const signature = createHmac('sha256', secret)
  .update(`${timestamp}\n${path}`)
  .digest('hex')

const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000)

let response
try {
  response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'x-agent-health-ts': timestamp,
      'x-agent-health-signature': signature,
    },
    signal: abort.signal,
  })
} catch (error) {
  if (abort.signal.aborted) {
    console.log(JSON.stringify({
      ok: false,
      error: `Timed out after ${Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000}ms waiting for the deployed background-worker smoke endpoint.`,
      url: `${baseUrl}${path}`,
    }, null, 2))
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  clearTimeout(timeout)
}

if (!response) process.exit()

const text = await response.text()
let body = null
try {
  body = text ? JSON.parse(text) : null
} catch {
  body = text
}

const contentType = response.headers.get('content-type') || ''
const parsedOk = typeof body === 'object' && body !== null && body.ok === true
const hint = parsedOk
  ? undefined
  : text && !contentType.includes('application/json')
    ? 'Smoke endpoint did not return JSON. Check that the deployed app includes the latest build and that the URL points at this app.'
    : body === null
      ? 'Smoke endpoint returned an empty body. Rebuild/redeploy the web service, then retry.'
      : undefined
const displayBody = typeof body === 'string' && body.length > 1000
  ? `${body.slice(0, 1000)}...`
  : body

console.log(JSON.stringify({
  status: response.status,
  body: displayBody,
  contentType,
  ...(hint ? { hint } : {}),
}, null, 2))

if (!response.ok || !parsedOk) {
  process.exitCode = 1
}
