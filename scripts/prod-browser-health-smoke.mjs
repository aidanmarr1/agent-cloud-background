import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return

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

loadLocalEnv()

const baseUrl = (process.argv[2] || 'https://agent1-0.vercel.app').replace(/\/$/, '')
const path = '/api/internal/browser-health'
const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET

if (!secret) {
  throw new Error('Missing AGENT_INTERNAL_HEALTH_SECRET or AUTH_SECRET for signed browser health request.')
}

const timestamp = Date.now().toString()
const signature = createHmac('sha256', secret)
  .update(`${timestamp}\n${path}`)
  .digest('hex')

const response = await fetch(`${baseUrl}${path}`, {
  headers: {
    'x-agent-health-ts': timestamp,
    'x-agent-health-signature': signature,
  },
})

const body = await response.text()

console.log(JSON.stringify({
  status: response.status,
  body: body ? JSON.parse(body) : null,
}, null, 2))

if (!response.ok) {
  process.exitCode = 1
}
