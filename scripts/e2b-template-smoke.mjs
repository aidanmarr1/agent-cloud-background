#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const args = process.argv.slice(2)
const skipBrowser = args.includes('--skip-browser')
const keepSandbox = args.includes('--keep-sandbox')

loadLocalEnvFiles(rootUrl)

function printFatal(error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exit(1)
}

process.on('uncaughtException', printFatal)
process.on('unhandledRejection', printFatal)

function env(name) {
  return process.env[name]?.trim() || ''
}

function requireEnv(name, reason) {
  if (!env(name)) {
    throw new Error(`${name} is required (${reason}).`)
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timeout))
}

requireEnv('E2B_API_KEY', 'runtime access to E2B cloud sandboxes')
if (!env('E2B_TEMPLATE_ID') && !env('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')) {
  throw new Error('Set E2B_TEMPLATE_ID=agent-cloud-browser, or set AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND for a base template.')
}

process.env.AGENT_SANDBOX_PROVIDER = 'e2b'
process.env.AGENT_E2B_PAUSE_ON_TASK_END = process.env.AGENT_E2B_PAUSE_ON_TASK_END || 'true'

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const {
  destroyE2BSandbox,
  ensureE2BRemoteBrowser,
  executeCommandInE2B,
  getOrCreateE2BSandbox,
  pauseE2BSandbox,
} = await jiti.import(fileURLToPath(new URL('../src/lib/e2bSandbox.ts', import.meta.url)))

const conversationId = `e2b-smoke-${randomUUID().slice(0, 8)}`
const startedAt = Date.now()
let sandboxId = null

console.log(`Running E2B template smoke for ${env('E2B_TEMPLATE_ID') || 'base template'} using ${conversationId}`)
console.log('This creates a short-lived E2B sandbox and may use E2B credits. It does not call the LLM.')

try {
  const sandbox = await withTimeout(
    getOrCreateE2BSandbox(conversationId),
    Number.parseInt(env('AGENT_E2B_SANDBOX_CREATE_TIMEOUT_MS') || '120000', 10),
    'Timed out creating E2B sandbox.',
  )
  sandboxId = sandbox.sandboxId

  const command = [
    'set -e',
    'echo "workspace=$PWD"',
    'test -d "$PWD"',
    'node --version',
    'python3 --version',
    'command -v bash',
    'command -v git',
    'command -v curl',
    'CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true)"',
    'test -n "$CHROME"',
    '"$CHROME" --version',
    'echo smoke-ok > e2b-smoke.txt',
    'test -f e2b-smoke.txt',
  ].join('\n')

  const commandResult = await executeCommandInE2B(conversationId, command)
  if (commandResult.exitCode !== 0) {
    throw new Error(`E2B template command smoke failed: ${commandResult.stderr || commandResult.stdout || `exit ${commandResult.exitCode}`}`)
  }

  let browser = null
  if (!skipBrowser) {
    const endpoint = await ensureE2BRemoteBrowser(conversationId)
    const response = await withTimeout(
      fetch(`${endpoint}/json/version`),
      Number.parseInt(env('AGENT_E2B_BROWSER_VERIFY_TIMEOUT_MS') || '15000', 10),
      'Timed out verifying E2B Chromium debugging endpoint.',
    )
    if (!response.ok) {
      throw new Error(`E2B Chromium endpoint returned HTTP ${response.status}`)
    }
    const version = await response.json().catch(() => null)
    if (!version || typeof version !== 'object') {
      throw new Error('E2B Chromium endpoint did not return JSON.')
    }
    browser = {
      endpoint,
      browser: version.Browser || null,
      webSocketDebuggerUrl: typeof version.webSocketDebuggerUrl === 'string',
    }
  }

  if (keepSandbox) {
    await pauseE2BSandbox(conversationId).catch(() => undefined)
  } else {
    await destroyE2BSandbox(conversationId).catch(() => undefined)
    sandboxId = null
  }

  console.log(JSON.stringify({
    ok: true,
    template: env('E2B_TEMPLATE_ID') || null,
    conversationId,
    sandboxId,
    keptSandbox: keepSandbox,
    command: {
      stdout: commandResult.stdout.trim().split(/\r?\n/).slice(0, 12),
      durationMs: commandResult.durationMs,
    },
    browser,
    durationMs: Date.now() - startedAt,
  }, null, 2))
} catch (error) {
  if (!keepSandbox) {
    await destroyE2BSandbox(conversationId).catch(() => undefined)
  }
  console.error(JSON.stringify({
    ok: false,
    template: env('E2B_TEMPLATE_ID') || null,
    conversationId,
    sandboxId,
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - startedAt,
  }, null, 2))
  process.exitCode = 1
}
