import { readFile } from 'node:fs/promises'
import { createClient } from '@tursodatabase/serverless/compat'

const baseUrl = process.env.AUTH_SMOKE_BASE_URL || 'http://127.0.0.1:3000'
const email = `auth-smoke-${Date.now()}@example.com`
const password = 'AuthSmoke123!'
let cachedEnv

function parseEnv(raw) {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return null
        const index = trimmed.indexOf('=')
        if (index === -1) return null
        return [trimmed.slice(0, index), trimmed.slice(index + 1)]
      })
      .filter(Boolean),
  )
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }
  const cookie = response.headers.get('set-cookie')
  return cookie ? [cookie] : []
}

function cookieHeaderFrom(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ')
}

async function cleanupUser() {
  const env = await readLocalEnv()
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) return

  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  })

  try {
    await client.execute('delete from users where email like ?', ['auth-smoke-%@example.com'])
    await client.execute('delete from signup_requests where email like ?', ['auth-smoke-%@example.com']).catch(() => undefined)
  } finally {
    client.close?.()
  }
}

async function readLocalEnv() {
  if (cachedEnv) return cachedEnv
  try {
    cachedEnv = parseEnv(await readFile('.env.local', 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    cachedEnv = {}
  }
  return cachedEnv
}

try {
  const env = await readLocalEnv()
  const publicSignupEnabled = env.AGENT_PUBLIC_SIGNUP === 'true' || process.env.AGENT_PUBLIC_SIGNUP === 'true'
  const origin = new URL(baseUrl).origin
  const signupResponse = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({
      name: 'Auth Smoke',
      email,
      password,
    }),
  })

  if (!publicSignupEnabled && signupResponse.status === 202) {
    const body = await signupResponse.json().catch(() => ({}))
    if (body?.status !== 'pending') {
      throw new Error('Invite-gated signup did not return pending status')
    }
    if (body?.adminEmailSent !== true) {
      throw new Error('Invite-gated signup did not report admin email delivery')
    }
    await cleanupUser()
    console.log(JSON.stringify({ ok: true, signup: false, reason: 'invite_request_pending', adminEmailSent: true }))
    process.exit(0)
  }

  if (!signupResponse.ok) {
    throw new Error(`Sign-up failed with HTTP ${signupResponse.status}`)
  }

  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`)
  if (!csrfResponse.ok) {
    throw new Error(`CSRF request failed with HTTP ${csrfResponse.status}`)
  }

  const csrf = await csrfResponse.json()
  const cookies = cookieHeaderFrom(getSetCookies(csrfResponse))
  const callbackResponse = await fetch(`${baseUrl}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookies,
    },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      redirect: 'false',
      json: 'true',
    }),
  })

  const sessionCookieIssued = getSetCookies(callbackResponse).some((cookie) =>
    /authjs\.session-token|next-auth\.session-token/i.test(cookie),
  )

  if (!sessionCookieIssued) {
    throw new Error(`Credentials callback did not issue a session cookie. HTTP ${callbackResponse.status}`)
  }

  console.log(JSON.stringify({ ok: true, signup: true, credentialsSession: true }))
} finally {
  await cleanupUser()
}
