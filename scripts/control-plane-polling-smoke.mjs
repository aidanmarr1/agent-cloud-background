#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const accountGate = await readFile(
  new URL('../src/components/auth/AccountDeletedGate.tsx', import.meta.url),
  'utf8',
)
const serverSync = await readFile(
  new URL('../src/store/chat/serverSync.ts', import.meta.url),
  'utf8',
)
const taskJobs = await readFile(
  new URL('../src/lib/agent/taskJobs.ts', import.meta.url),
  'utf8',
)

assert.match(
  accountGate,
  /const ACCOUNT_STATUS_POLL_MS = 60_000/,
  'account deletion polling must stay off the active-task hot path',
)
assert.match(
  accountGate,
  /accountCheckInFlightRef\.current\) return[\s\S]*accountCheckInFlightRef\.current = true[\s\S]*finally \{[\s\S]*accountCheckInFlightRef\.current = false/,
  'slow account checks must be single-flight instead of stacking requests',
)
assert.match(
  accountGate,
  /document\.visibilityState !== 'visible'/,
  'hidden tabs must not poll account state',
)
assert.match(
  serverSync,
  /const REFRESH_INTERVAL_MS = 30_000/,
  'conversation safety polling must leave capacity for task persistence',
)
assert.match(
  serverSync,
  /refreshTimer = setInterval\(\(\) => \{[\s\S]*document\.visibilityState !== 'visible'[\s\S]*refreshFromServer/,
  'hidden tabs must not poll the full conversation index',
)
assert.match(
  taskJobs,
  /const TASK_JOB_CANCEL_POLL_MS = 750/,
  'worker cancellation polling must remain responsive without querying four times per second',
)
assert.match(
  taskJobs,
  /function scheduleCancellationPoll|const scheduleCancellationPoll[\s\S]*setTimeout\([\s\S]*taskJobControlState[\s\S]*finally\(\(\) => \{[\s\S]*scheduleCancellationPoll\(\)/,
  'the next cancellation read must wait until the prior database read settles',
)
assert.doesNotMatch(
  taskJobs,
  /const cancelTimer = setInterval/,
  'fixed-interval cancellation polling must not resume after a slow read',
)

console.log('Control-plane polling smoke passed.')
