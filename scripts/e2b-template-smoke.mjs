#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const args = process.argv.slice(2)
const skipBrowser = args.includes('--skip-browser')
const keepSandbox = args.includes('--keep-sandbox')
const testCancellation = args.includes('--test-cancel')

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
  ensureE2BRemoteBrowserDebuggerUrl,
  executeCommandInE2B,
  getOrCreateE2BSandbox,
  pauseE2BSandbox,
} = await jiti.import(fileURLToPath(new URL('../src/lib/e2bSandbox.ts', import.meta.url)))
const {
  browserNavigate,
  browserResize,
  destroyBrowserSession,
  subscribeToBrowserFrames,
} = await jiti.import(fileURLToPath(new URL('../src/lib/browser.ts', import.meta.url)))

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
    'command -v file',
    'command -v tesseract',
    'command -v pdftotext',
    'command -v pdfinfo',
    'command -v identify',
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

  let cancellationInfo = null
  if (testCancellation) {
    const abortController = new AbortController()
    const cancelStartedAt = Date.now()
    const cancelTimer = setTimeout(() => abortController.abort(), 750)
    let cancelled = false
    try {
      await withTimeout(
        executeCommandInE2B(
          conversationId,
          'printf ready; sleep 300',
          undefined,
          undefined,
          undefined,
          abortController.signal,
        ),
        5_000,
        'Timed out cancelling E2B command.',
      )
    } catch (error) {
      cancelled = abortController.signal.aborted &&
        error instanceof Error &&
        error.name === 'AbortError'
    } finally {
      clearTimeout(cancelTimer)
    }
    if (!cancelled) throw new Error('E2B command did not unwind cleanly after cancellation.')

    const afterCancel = await withTimeout(
      executeCommandInE2B(conversationId, 'printf after-cancel'),
      5_000,
      'E2B sandbox did not accept a command after cancellation.',
    )
    if (afterCancel.exitCode !== 0 || afterCancel.stdout !== 'after-cancel') {
      throw new Error('E2B sandbox was not healthy after command cancellation.')
    }
    cancellationInfo = {
      unwoundMs: Date.now() - cancelStartedAt,
      sandboxReusable: true,
    }
  }

  let browserInfo = null
  if (!skipBrowser) {
    const endpoint = await ensureE2BRemoteBrowser(conversationId)
    const browserSandbox = await getOrCreateE2BSandbox(conversationId)
    if (browserSandbox.sandboxId !== sandboxId) {
      throw new Error('E2B Chromium and terminal resolved different task sandboxes.')
    }
    const browserPort = Number.parseInt(env('AGENT_E2B_BROWSER_PORT') || '9222', 10)
    if (!Number.isFinite(browserPort) || browserPort < 1 || browserPort > 65_535) {
      throw new Error('AGENT_E2B_BROWSER_PORT must be a valid TCP port.')
    }
    const sameVmProbe = await executeCommandInE2B(
      conversationId,
      `curl -fsS http://127.0.0.1:${browserPort}/json/version >/dev/null && printf shared-e2b-vm`,
    )
    if (sameVmProbe.exitCode !== 0 || sameVmProbe.stdout !== 'shared-e2b-vm') {
      throw new Error('The task terminal could not reach task Chromium over sandbox localhost.')
    }
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
    const debuggerUrl = await ensureE2BRemoteBrowserDebuggerUrl(conversationId)
    let liveFrameCount = 0
    let firstLiveFrameAt = 0
    let largestLiveFrameBytes = 0
    const liveFrameFingerprints = new Set()
    let resolveLiveFrames
    const liveFramesReady = new Promise((resolve) => {
      resolveLiveFrames = resolve
    })
    const unsubscribe = subscribeToBrowserFrames(conversationId, (frame) => {
      const byteLength = Buffer.from(frame, 'base64').byteLength
      if (byteLength > 0) {
        liveFrameCount++
        liveFrameFingerprints.add(createHash('sha1').update(frame).digest('hex'))
        if (!firstLiveFrameAt) firstLiveFrameAt = Date.now()
        largestLiveFrameBytes = Math.max(largestLiveFrameBytes, byteLength)
        if (liveFrameCount >= 3 && liveFrameFingerprints.size >= 2) resolveLiveFrames()
      }
    })
    const navigationStartedAt = Date.now()
    let navigation
    try {
      navigation = await withTimeout(
        browserNavigate(conversationId, 'https://example.com'),
        20_000,
        'Timed out navigating from the E2B browser runtime.',
      )
      if (!navigation.success) {
        throw new Error(`E2B browser navigation failed: ${navigation.error || navigation.action}`)
      }
      await browserResize(conversationId, 1100, 700)
      await browserResize(conversationId, 900, 620)
      await withTimeout(
        liveFramesReady,
        10_000,
        'E2B Chromium did not emit distinct live frames through the browser subscriber.',
      )
    } finally {
      unsubscribe?.()
      await destroyBrowserSession(conversationId).catch(() => undefined)
    }
    const pageTitle = navigation?.title || ''
    if (
      pageTitle !== 'Example Domain' ||
      liveFrameCount < 3 ||
      liveFrameFingerprints.size < 2 ||
      largestLiveFrameBytes < 1_000
    ) {
      throw new Error('E2B Chromium did not return the expected navigated page and live frame stream.')
    }
    browserInfo = {
      endpoint,
      sameSandboxId: true,
      terminalReachedBrowserOverLocalhost: true,
      debuggerHostMatchesEndpoint: new URL(debuggerUrl).host === new URL(endpoint).host,
      browser: version.Browser || null,
      webSocketDebuggerUrl: typeof version.webSocketDebuggerUrl === 'string',
      navigatedTitle: pageTitle,
      navigationMs: Date.now() - navigationStartedAt,
      liveFrameTransport: 'browser-subscriber-cdp-screencast',
      liveFrameCount,
      distinctLiveFrames: liveFrameFingerprints.size,
      firstLiveFrameMs: firstLiveFrameAt - navigationStartedAt,
      largestLiveFrameBytes,
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
    cancellation: cancellationInfo,
    browser: browserInfo,
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
