#!/usr/bin/env node

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { rewriteE2BRemoteDebuggerUrl } = await jiti.import(fileURLToPath(new URL('../src/lib/e2bSandbox.ts', import.meta.url)))

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

console.log('e2b browser debugger URL smoke checks passed')
