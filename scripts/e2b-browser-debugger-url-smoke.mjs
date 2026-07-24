#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { rewriteE2BRemoteDebuggerUrl } = await jiti.import(fileURLToPath(new URL('../src/lib/e2bSandbox.ts', import.meta.url)))
const browserSource = await readFile(new URL('../src/lib/browser.ts', import.meta.url), 'utf8')
const sandboxSource = await readFile(new URL('../src/lib/sandbox.ts', import.meta.url), 'utf8')
const e2bSandboxSource = await readFile(new URL('../src/lib/e2bSandbox.ts', import.meta.url), 'utf8')

assert.equal(
  rewriteE2BRemoteDebuggerUrl(
    'https://9222-example-sandbox.e2b.dev',
    'ws://127.0.0.1:9222/devtools/browser/abc123',
  ),
  'wss://9222-example-sandbox.e2b.dev/devtools/browser/abc123',
)

assert.equal(
  rewriteE2BRemoteDebuggerUrl(
    'https://9222-example-sandbox.e2b.dev',
    'ws://[::1]:9222/devtools/browser/abc123',
  ),
  'wss://9222-example-sandbox.e2b.dev/devtools/browser/abc123',
)

assert.equal(
  rewriteE2BRemoteDebuggerUrl(
    'http://localhost:9222',
    'ws://127.0.0.1:9222/devtools/browser/local',
  ),
  'ws://localhost:9222/devtools/browser/local',
)

const browserRuntimeStart = browserSource.indexOf('async function createBrowserRuntime')
const browserRuntimeEnd = browserSource.indexOf('async function getOrCreateSession', browserRuntimeStart)
assert.ok(
  browserRuntimeStart >= 0 && browserRuntimeEnd > browserRuntimeStart,
  'browser runtime factory must exist',
)
const browserRuntime = browserSource.slice(browserRuntimeStart, browserRuntimeEnd)
const e2bBranch = browserRuntime.indexOf('if (isCloudSandboxProviderEnabled())')
const remoteDebugger = browserRuntime.indexOf('ensureE2BRemoteBrowserDebuggerUrl(conversationId)', e2bBranch)
const remoteConnection = browserRuntime.indexOf('playwrightChromium.connectOverCDP(debuggerUrl)', remoteDebugger)
const remoteReturn = browserRuntime.indexOf("remoteProvider: 'e2b'", remoteConnection)
const localLaunch = browserRuntime.indexOf('playwrightChromium.launch', e2bBranch)
assert.ok(
  e2bBranch >= 0 &&
    remoteDebugger > e2bBranch &&
    remoteConnection > remoteDebugger &&
    remoteReturn > remoteConnection &&
    localLaunch > remoteReturn,
  'E2B mode must return a CDP connection to sandbox Chromium before the local launch path is reachable',
)

const commandRouterStart = sandboxSource.indexOf('export async function executeInSandbox')
const commandRouterEnd = sandboxSource.indexOf('// --- File operations ---', commandRouterStart)
assert.ok(commandRouterStart >= 0 && commandRouterEnd > commandRouterStart, 'sandbox command router must exist')
const commandRouter = sandboxSource.slice(commandRouterStart, commandRouterEnd)
assert.match(
  commandRouter,
  /if \(shouldUseE2BProvider\(\)\)[\s\S]*executeCommandInE2B\(\s*conversationId,/,
  'E2B terminal commands must preserve the task conversation id when routed to E2B',
)

const browserLauncherStart = e2bSandboxSource.indexOf('async function launchOrReuseE2BRemoteBrowser')
const browserLauncherEnd = e2bSandboxSource.indexOf('export async function ensureE2BRemoteBrowser', browserLauncherStart)
assert.ok(browserLauncherStart >= 0 && browserLauncherEnd > browserLauncherStart, 'E2B browser launcher must exist')
const browserLauncher = e2bSandboxSource.slice(browserLauncherStart, browserLauncherEnd)
assert.match(
  browserLauncher,
  /getOrCreateE2BSandbox\(conversationId\)/,
  'E2B Chromium must resolve the same task-owned sandbox as terminal commands',
)
assert.match(
  browserLauncher,
  /const root = workspaceRoot\(conversationId\)[\s\S]*cwd: root/,
  'E2B Chromium must launch from the task workspace inside that sandbox',
)

const commandExecutorStart = e2bSandboxSource.indexOf('export async function executeCommandInE2B')
const commandExecutorEnd = e2bSandboxSource.indexOf('export async function createFileInE2B', commandExecutorStart)
assert.ok(commandExecutorStart >= 0 && commandExecutorEnd > commandExecutorStart, 'E2B command executor must exist')
const commandExecutor = e2bSandboxSource.slice(commandExecutorStart, commandExecutorEnd)
assert.match(
  commandExecutor,
  /getOrCreateE2BSandbox\(conversationId\)/,
  'E2B terminal commands must resolve the same task-owned sandbox as Chromium',
)
assert.match(
  commandExecutor,
  /cwd: workspaceRoot\(conversationId\)/,
  'E2B terminal commands must execute from the same task workspace',
)

console.log('e2b browser debugger URL smoke checks passed')
