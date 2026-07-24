import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const taskJobs = await readFile(new URL('../src/lib/agent/taskJobs.ts', import.meta.url), 'utf8')
const chatRoute = await readFile(new URL('../src/app/api/chat/route.ts', import.meta.url), 'utf8')

assert.match(
  taskJobs,
  /create table if not exists agent_task_prestart_cancellations[\s\S]*primary key \(queue_name, user_id, conversation_id, run_id\)/,
  'pre-start cancellation tombstones must be durable and exactly ownership scoped',
)
assert.match(
  taskJobs,
  /delete from agent_task_prestart_cancellations where expires_at_ms <= \?/,
  'expired durable cancellation tombstones must be pruned',
)
assert.match(
  taskJobs,
  /async function reserveInProcessTaskJob[\s\S]*from agent_task_prestart_cancellations[\s\S]*TaskPreStartCancelledError[\s\S]*insert into agent_task_jobs/,
  'in-process reservation must reject an exact tombstone before committing a job',
)
assert.match(
  taskJobs,
  /export async function enqueueTaskJob[\s\S]*from agent_task_prestart_cancellations[\s\S]*TaskPreStartCancelledError[\s\S]*insert into agent_task_jobs/,
  'external queue reservation must reject an exact tombstone before committing a job',
)
assert.match(
  taskJobs,
  /insert into agent_task_prestart_cancellations[\s\S]*on conflict\(queue_name, user_id, conversation_id, run_id\) do update set[\s\S]*expires_at_ms = max/,
  'repeated stop-before-start requests must be idempotent and retain the later expiry',
)
assert.match(
  chatRoute,
  /cancelTaskJob\(authenticated\.userId, authenticated\.runId, authenticated\.conversationId\)/,
  'DELETE must pass its authenticated conversation scope when recording a missing-run tombstone',
)
assert.match(
  chatRoute,
  /authenticateTaskRunRequest\(request, \{ allowCreateTaskAccess: true \}\)/,
  'a stop that beats the first POST must be able to establish authenticated task ownership before tombstoning',
)
assert.match(
  chatRoute,
  /const terminalJob = cancellation\.ok && cancellation\.terminal[\s\S]*findTaskJobForRun\([\s\S]*terminalError: terminalJob\.terminalError/,
  'DELETE must return the persisted terminal warning instead of collapsing forced recovery to a generic stop',
)
assert.equal((chatRoute.match(/error instanceof TaskPreStartCancelledError/g) || []).length, 2, 'both start modes must return an explicit tombstone rejection')
assert.equal((chatRoute.match(/status: 410/g) || []).length, 2, 'tombstoned starts must not use the existing-run 409 replay contract')

const claimNext = taskJobs.match(/export async function claimNextTaskJob[\s\S]*?export async function refreshTaskJobClaim/)?.[0] || ''
assert.match(
  claimNext,
  /await ensureTaskJobSchema\(\)[\s\S]*await ensureTaskWorkerHeartbeatSchema\(\)[\s\S]*tursoTransaction\('write'/,
  'a fresh worker must repair the full job schema before its first raw claim transaction',
)

const staleCancellationSelection = claimNext.match(/const staleCancelled =[\s\S]*?const staleRow =/)?.[0] || ''
assert.match(
  staleCancellationSelection,
  /cancel_requested = 1[\s\S]*lease_expires_at_ms is null or lease_expires_at_ms <= \?/,
  'expired cancellation leases must be selected autonomously',
)
assert.match(
  staleCancellationSelection,
  /payload_json is not null[\s\S]*agent_task_workers[\s\S]*current_run_id[\s\S]*last_seen_at_ms/,
  'stale cancellation selection must exclude in-process claims and heartbeat-live external workers',
)

const cancellation = taskJobs.match(/export async function cancelTaskJob[\s\S]*?export async function cleanupInternalTaskJob/)?.[0] || ''
assert.doesNotMatch(
  cancellation,
  /if \(job\.terminalStatus\) \{[\s\S]{0,900}status: 'stopping'/,
  'a staged terminal must not bypass cancellation and leave cleanup hung forever',
)
assert.match(
  cancellation,
  /job\.cancelRequested = true[\s\S]*job\.abortController\.abort\(\)[\s\S]*cancel_requested = 1[\s\S]*worker_id like 'in-process:%'[\s\S]*max\(coalesce\(lease_expires_at_ms, \?\), \?\)[\s\S]*min\(coalesce\(lease_expires_at_ms, \?\), \?\)/,
  'cancellation must abort locally, retain in-process ownership, and shorten only the dedicated worker claim',
)
assert.match(
  cancellation,
  /scheduleCancellationFence\(userId, runId, cancellationDeadline\)[\s\S]*scheduleCancellationFence\(userId, runId, now \+ TASK_JOB_CANCEL_EXECUTION_GRACE_MS\)/,
  'cancellation must schedule cleanup beyond the request acknowledgement window',
)
assert.match(
  taskJobs,
  /function scheduleCancellationFence[\s\S]*if \(finalized\) return[\s\S]*worker_last_seen_at_ms[\s\S]*heartbeatProofAt[\s\S]*scheduleCancellationFence\([\s\S]*Transient DB\/provider failures[\s\S]*scheduleCancellationFence\(/,
  'autonomous cancellation fencing must reschedule at the ownership or heartbeat proof deadline without hot polling',
)
assert.doesNotMatch(taskJobs, /process\.exit\(/, 'in-process cancellation must never terminate the shared web process')

assert.match(
  taskJobs,
  /async function applyCancellationTerminalSafety[\s\S]*markTaskJobCancelled\(job\)[\s\S]*uncertainNonIdempotentActionMessage[\s\S]*await applyCancellationTerminalSafety\(job\)/,
  'provisional terminal cancellation must be converted before atomic terminal publication',
)
assert.match(
  taskJobs,
  /async function fenceAndFinalizeTaskCancellation[\s\S]*select seq, event_json[\s\S]*assessTaskRecoveryEvents[\s\S]*may have completed before its result was saved|async function fenceAndFinalizeTaskCancellation[\s\S]*uncertainNonIdempotentActionMessage/,
  'forced cancellation must derive an explicit uncertainty terminal from unmatched durable action starts',
)
assert.match(
  taskJobs,
  /inProcessRecovery[\s\S]*Task stop could not be confirmed because its in-process execution host became unreachable[\s\S]*late external side effects could not be ruled out/,
  'lease-expired in-process cancellation recovery must disclose that a shared-process hard stop could not be proven',
)

assert.match(
  taskJobs,
  /async function reconcileExpiredDurableTaskJob[\s\S]*payload_json is null[\s\S]*attempts > 0[\s\S]*fenceAndFinalizeStaleTask/,
  'expired payload-less in-process claims must be destroyed and terminalized instead of requeued unreadably',
)
assert.match(
  taskJobs,
  /findActiveTaskJobForConversation[\s\S]*reconcileExpiredDurableTaskJob\(\{ userId, conversationId \}\)[\s\S]*findActiveTaskJobForUser[\s\S]*reconcileExpiredDurableTaskJob\(\{ userId \}\)/,
  'active discovery must reconcile crashed in-process rows even without an external worker',
)
assert.match(
  taskJobs,
  /const replayPersistedEvents[\s\S]*reconcileExpiredDurableTaskJob\(\{[\s\S]*runId: input\.runId[\s\S]*loadPersistedTaskJobStatus/,
  'durable SSE polling must reconcile a crashed in-process run before reporting its status',
)

assert.match(
  taskJobs,
  /!job\.requeueRequested\s*&&\s*!job\.closed[\s\S]*findActiveTaskJobForConversation/,
  'claim-loss objects must be excluded from in-memory active discovery',
)
assert.match(
  taskJobs,
  /const stopForLocalClaimLoss[\s\S]*taskJobState\.jobs\.delete\(job\.runId\)[\s\S]*job\.promise[\s\S]*\.finally\(\(\) => \{[\s\S]*taskJobState\.jobs\.delete\(job\.runId\)/,
  'claim-loss objects must be deleted immediately and again at settlement',
)

assert.match(
  taskJobs,
  /export async function findTaskJobForRun\([\s\S]*user_id = \?[\s\S]*conversation_id = \?[\s\S]*run_id = \?[\s\S]*queue_name = \?/,
  'exact-run idempotency lookup must be owner, conversation, run, and queue scoped',
)

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.task-job-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  cancelTaskJob,
  clearTaskJobsForTest,
  findTaskJobForRun,
  startTaskJob,
  TaskPreStartCancelledError,
} from ${JSON.stringify(join(root, 'src/lib/agent/taskJobs.ts'))}

delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
clearTaskJobsForTest()

async function waitForStatus(userId: string, conversationId: string, runId: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await findTaskJobForRun(userId, conversationId, runId)
    if (job?.status === expected) return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for task status ' + expected)
}

const stoppedBeforeStart = await cancelTaskJob('prestart-user', 'prestart-run', 'prestart-conversation')
assert.deepEqual(stoppedBeforeStart, { ok: true, status: 'cancelled', terminal: true })
assert.deepEqual(
  await cancelTaskJob('prestart-user', 'prestart-run', 'prestart-conversation'),
  stoppedBeforeStart,
  'repeated stop-before-start must remain idempotent',
)
await assert.rejects(
  startTaskJob({
    runId: 'prestart-run',
    userId: 'prestart-user',
    conversationId: 'prestart-conversation',
    async runner(emitter) { emitter.done() },
  }),
  (error: unknown) => error instanceof TaskPreStartCancelledError,
  'a stopped client run must never start later',
)

await startTaskJob({
  runId: 'prestart-run',
  userId: 'prestart-user',
  conversationId: 'different-conversation',
  async runner(emitter) { emitter.done() },
})
assert.equal((await waitForStatus('prestart-user', 'different-conversation', 'prestart-run', 'done')).status, 'done', 'tombstones must not cross conversation scope')
clearTaskJobsForTest()

process.env.AGENT_TASK_PRESTART_CANCEL_TTL_MS = '10'
await cancelTaskJob('ttl-user', 'ttl-run', 'ttl-conversation')
await new Promise(resolve => setTimeout(resolve, 20))
await startTaskJob({
  runId: 'ttl-run',
  userId: 'ttl-user',
  conversationId: 'ttl-conversation',
  async runner(emitter) { emitter.done() },
})
assert.equal((await waitForStatus('ttl-user', 'ttl-conversation', 'ttl-run', 'done')).status, 'done', 'expired memory tombstones must not block a new start')
delete process.env.AGENT_TASK_PRESTART_CANCEL_TTL_MS
clearTaskJobsForTest()

const runId = 'runtime-staged-terminal-cancel'
const userId = 'runtime-user'
const conversationId = 'runtime-conversation'
await startTaskJob({
  runId,
  userId,
  conversationId,
  async runner(emitter, signal) {
    emitter.toolStart('runtime-side-effect', 'create_file', { path: '/workspace/report.txt' })
    emitter.done()
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  },
})

const provisional = await findTaskJobForRun(userId, conversationId, runId)
assert.equal(provisional?.status, 'running', 'a staged terminal remains active until its cleanup barrier commits')
assert.equal(provisional?.terminalStatus, null, 'exact lookup must not expose an uncommitted terminal')
assert.equal(await findTaskJobForRun('wrong-owner', conversationId, runId), null, 'exact lookup must enforce ownership')
assert.equal(await findTaskJobForRun(userId, 'wrong-conversation', runId), null, 'exact lookup must enforce conversation scope')

const cancelled = await cancelTaskJob(userId, runId)
assert.deepEqual(cancelled, { ok: true, status: 'cancelled', terminal: true }, 'a staged terminal must remain cancellable')
const committed = await findTaskJobForRun(userId, conversationId, runId)
assert.equal(committed?.status, 'cancelled')
assert.equal(committed?.terminalStatus, 'error')
assert.match(committed?.terminalError || '', /create_file action may have completed before its result was saved/, 'unmatched side effects must be reported as uncertain')

clearTaskJobsForTest()

const provisionalRunId = 'runtime-provisional-preview-cancel'
await startTaskJob({
  runId: provisionalRunId,
  userId,
  conversationId,
  async runner(emitter, signal) {
    emitter.toolStart(
      'preview-only-write',
      'create_file',
      { path: '/workspace/preview-only.txt' },
      { provisional: true },
    )
    emitter.done()
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  },
})

const provisionalCancelled = await cancelTaskJob(userId, provisionalRunId)
assert.deepEqual(provisionalCancelled, { ok: true, status: 'cancelled', terminal: true })
const provisionalCommitted = await findTaskJobForRun(userId, conversationId, provisionalRunId)
assert.equal(provisionalCommitted?.status, 'cancelled')
assert.doesNotMatch(
  provisionalCommitted?.terminalError || '',
  /create_file action may have completed before its result was saved/,
  'a crash after a provisional preview start must not be misclassified as an uncertain side effect',
)

clearTaskJobsForTest()
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22'],
    external: ['fsevents', 'playwright-core', 'chromium-bidi/*'],
    logLevel: 'silent',
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('task job recovery smoke checks passed')
