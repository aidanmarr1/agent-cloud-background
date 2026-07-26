#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [
  renderHelper,
  finishSetup,
  chatRoute,
  readinessRoute,
  intakeHold,
  renderBlueprint,
  backgroundDocs,
] = await Promise.all([
  readFile(join(root, 'scripts/render-worker-env.mjs'), 'utf8'),
  readFile(join(root, 'scripts/cloud-finish-setup.mjs'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/internal/background-worker-ready/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskIntakeHold.ts'), 'utf8'),
  readFile(join(root, 'render.yaml'), 'utf8'),
  readFile(join(root, 'docs/cloud-background-tasks.md'), 'utf8'),
])

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `Could not isolate source section ${startMarker}`)
  return source.slice(start, end)
}

const boundedFetch = sourceSection(
  renderHelper,
  'async function fetchTextWithTimeout',
  'async function renderRequest',
)
const queueCount = sourceSection(
  renderHelper,
  'async function readActiveQueueCounts',
  'function activeQueueCountTotal',
)
const autoDeployGuard = sourceSection(
  renderHelper,
  'async function disableAndVerifyAutoDeploy',
  'function deployCommitId',
)
const guardedRollout = sourceSection(
  renderHelper,
  'async function runGuardedSuspendedDeploy',
  'async function main',
)

assert.match(
  renderHelper,
  /--safe-suspended-deploy[\s\S]*--apply[\s\S]*--trigger-deploy[\s\S]*--wait-for-deploy/,
  'guarded suspended deploy must require apply, trigger, and bounded deploy verification',
)
assert.match(
  renderHelper,
  /serviceSuspendedState\(service\) !== 'suspended'[\s\S]*must already be suspended/,
  'guarded rollout must refuse to adopt a base that was already running',
)
assert.match(
  renderHelper,
  /\.\.\.\(commitId \? \{ commitId \} : \{\}\)[\s\S]*verifyDeployCommit\(liveDeploy, commitId, deployId\)/,
  'Render deploy must request and verify the exact full Git commit',
)
assert.match(
  guardedRollout,
  /resumeAttempted = true[\s\S]*await resumeService[\s\S]*finally \{[\s\S]*suspendAndVerifyForCleanup/,
  'every attempted resume must flow through a guaranteed suspend-and-verify finally block',
)
assert.match(
  guardedRollout,
  /const finalService = await getService[\s\S]*serviceSuspendedState\(finalService\) !== 'suspended'[\s\S]*const finalDeploy = await readDeploy[\s\S]*verifyDeployCommit/,
  'the post-cleanup gate must re-read both suspension state and exact deployed artifact',
)
assert.match(
  guardedRollout,
  /acquireIntakeHold\(client, baseName, holdId\)[\s\S]*proveDeployedIntakeHold\(baseUrl, deployedQueueName, holdId\)[\s\S]*proveQueueDrained\(client, baseName, deployedQueueName\)[\s\S]*applyEnvVars[\s\S]*proveDeployedIntakeHold\(baseUrl, deployedQueueName, holdId\)[\s\S]*proveQueueDrained\(client, baseName, deployedQueueName\)[\s\S]*resumeAttempted/,
  'intake ownership and a stable empty queue must be proven before env mutation and again before resume',
)
assert.match(
  guardedRollout,
  /releaseIntakeHold\(client, baseName, holdId\)/,
  'intake release must use the protocol-stable base namespace',
)
assert.match(
  queueCount,
  /agent_task_jobs[\s\S]*agent_task_dispatches[\s\S]*user_active_task_leases[\s\S]*agent_task_workers/,
  'drain proof must cover jobs, provider dispatches, active leases, and fresh workers',
)
assert.match(
  queueCount,
  /'agent_task_dispatches',[\s\S]*"backend = 'render-one-off' and status in \('creating', 'unknown', 'created'\)"/,
  'drain proof must count only live Render one-off launches, not permanent Workflow history rows',
)
assert.match(
  boundedFetch,
  /setTimeout\(\(\) => \{[\s\S]*controller\.abort[\s\S]*await fetch\([\s\S]*await response\.text\(\)[\s\S]*finally \{[\s\S]*clearTimeout\(timeout\)/,
  'one bounded deadline must cover both response headers and body for every guarded fetch',
)
assert.match(
  renderHelper,
  /activeRequestController\?\.abort\(interruptionError\(\)\)[\s\S]*process\.on\('SIGINT'[\s\S]*process\.on\('SIGTERM'[\s\S]*const maxAttempts = 3[\s\S]*suspendAndVerifyService\(serviceId, \{ allowAfterInterrupt: true \}\)[\s\S]*sleep\(DEFAULT_SERVICE_POLL_MS, \{ allowAfterInterrupt: true \}\)[\s\S]*finally \{[\s\S]*suspendAndVerifyForCleanup/,
  'termination signals must abort active work and retain the guaranteed suspension path',
)
assert.match(
  guardedRollout,
  /if \(interruptedSignal\) \{[\s\S]*throwIfInterrupted\(\)[\s\S]*if \(keepIntakeHeld\)/,
  'a late termination signal must preserve the hold before either success branch',
)
assert.match(
  renderHelper,
  /--disable-auto-deploy-only requires --apply[\s\S]*must be suspended before disabling auto-deploy[\s\S]*disableAndVerifyAutoDeploy/,
  'the pre-push auto-deploy guard must require an explicit apply on a suspended worker',
)
assert.match(
  autoDeployGuard,
  /method: 'PATCH',[\s\S]*JSON\.stringify\(\{ autoDeploy: 'no' \}\)[\s\S]*serviceAutoDeployState\(service\) !== 'no'/,
  'auto-deploy disablement must be patched and independently re-read',
)
assert.match(
  renderHelper,
  /const raw = service\?\.autoDeploy \?\?[\s\S]*if \(raw === false\) return 'no'[\s\S]*if \(raw === true\) return 'yes'/,
  'Render boolean autoDeploy responses must normalize to the requested yes/no contract',
)
assert.match(
  guardedRollout,
  /await proveQueueDrained\(client, baseName, deployedQueueName\)[\s\S]*await disableAndVerifyAutoDeploy\(input\.serviceId\)[\s\S]*await applyEnvVars[\s\S]*await resumeService/,
  'the guarded rollout must disable auto-deploy before env changes or resume',
)
assert.match(
  renderHelper,
  /autoDeploy: readArg\('--auto-deploy'\) \|\| env\('RENDER_WORKER_AUTO_DEPLOY'\) \|\| 'no'/,
  'new Render bases must default to auto-deploy disabled',
)
assert.match(
  renderBlueprint,
  /- type: worker[\s\S]*autoDeployTrigger: off[\s\S]*startCommand: npm run worker:cloud/,
  'the worker Blueprint must keep repository-triggered deploys off',
)
assert.match(
  backgroundDocs,
  /before pushing any new commit[\s\S]*--disable-auto-deploy/i,
  'operator docs must disable and verify auto-deploy before a commit is pushed',
)
assert.match(
  guardedRollout,
  /Intake hold \$\{holdId\} remains active/,
  'a failed or unverified rollout must retain its fail-closed intake hold',
)
assert.match(
  renderHelper,
  /--release-intake-hold[\s\S]*releaseIntakeHold/,
  'the exact hold owner must have an explicit recovery release path',
)

const idempotencyIndex = chatRoute.indexOf('const acceptedRun = await findTaskJobForRun')
const holdIndex = chatRoute.indexOf('const intakeHold = await taskIntakeHoldResponse()')
const creditIndex = chatRoute.indexOf('const creditsPromise = assertServerCreditsAvailable')
const enqueueIndex = chatRoute.indexOf('await enqueueTaskJob({')
assert(idempotencyIndex >= 0 && holdIndex > idempotencyIndex, 'idempotent reconnect recovery must remain available while intake is held')
assert(holdIndex < creditIndex && holdIndex < enqueueIndex, 'the hold must reject new work before credit checks or queue acceptance')
assert.match(
  chatRoute,
  /TASK_INTAKE_PAUSED[\s\S]*Retry-After/,
  'held intake must produce a visible retryable response',
)
assert.match(
  chatRoute,
  /TASK_INTAKE_HOLD_CHECK_FAILED/,
  'external task acceptance must fail closed when the durable hold cannot be read',
)
assert.match(
  readinessRoute,
  /taskIntake:\s*\{[\s\S]*held:[\s\S]*holdId:/,
  'the signed readiness contract must report the exact hold identity',
)
assert.match(
  intakeHold,
  /where queue_name in \(\?, \?\)[\s\S]*return null[\s\S]*holdId/,
  'the app must enforce the queue-scoped durable hold',
)

assert.match(
  finishSetup,
  /const nodeBin = process\.execPath/,
  'the orchestrator must invoke Node scripts with its own bundled-capable runtime',
)
assert.match(
  finishSetup,
  /--safe-suspended-deploy[\s\S]*--keep-intake-held[\s\S]*waitForWorkerReadiness[\s\S]*--release-intake-hold/,
  'the full rollout must retain intake hold through Vercel deployment and readiness',
)
assert.ok(
  finishSetup.indexOf("runStep('Apply and deploy Render worker env") <
    finishSetup.indexOf("runStep('Apply Vercel production env"),
  'the exact Render artifact must still be ready before on-demand Vercel env activation',
)

console.log('Guarded suspended Render rollout smoke checks passed')
