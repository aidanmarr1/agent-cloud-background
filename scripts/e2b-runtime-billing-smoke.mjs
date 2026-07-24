import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const serverCredits = await readFile(join(root, 'src/lib/serverCredits.ts'), 'utf8')
const e2bSandbox = await readFile(join(root, 'src/lib/e2bSandbox.ts'), 'utf8')
const taskRunner = await readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8')

assert.match(serverCredits, /create table if not exists credit_e2b_runtime_segments/, 'E2B runtime segments must be durable')
assert.match(serverCredits, /provider_sandbox_id text not null[\s\S]*lifecycle_generation integer not null/, 'runtime segments must bind to an exact provider ownership generation')
assert.match(serverCredits, /select provider_sandbox_id, lifecycle_generation, lifecycle_state[\s\S]*owner\?\.lifecycle_state !== 'active'/, 'activation must verify current durable sandbox ownership')
assert.match(serverCredits, /No credits are debited by activation itself/, 'billing must not debit before confirmed activation')
assert.match(serverCredits, /const targetAssessed = e2bRuntimeAmount\(startedAt, targetEnd\)[\s\S]*targetAssessed - previousAssessed/, 'checkpoints must use cumulative pricing to avoid rounding drift')
assert.match(serverCredits, /tursoTransaction\('write'[\s\S]*update credit_accounts[\s\S]*insert into credit_ledger[\s\S]*update credit_e2b_runtime_segments/, 'account debit, ledger event, and segment advance must share one transaction')
assert.match(serverCredits, /next_sequence = \?[\s\S]*last_ledger_id = \?/, 'durable checkpoint sequences must make retries idempotent')
assert.match(serverCredits, /where conversation_id = \?[\s\S]*provider_sandbox_id = \?[\s\S]*lifecycle_generation = \?[\s\S]*status = 'open'/, 'cleanup reconciliation must select only the exact fenced provider generation')
assert.match(serverCredits, /ownsActiveSandbox[\s\S]*ownsFencedSandbox[\s\S]*runtimeRowInteger\(ownership\.lifecycle_source_generation, -1\) === segmentGeneration/, 'live checkpoints and cleanup checkpoints must both revalidate exact durable ownership')
assert.match(serverCredits, /attempt < \?[\s\S]*allowHandoffOwnership: true/, 'graceful handoff may close only older attempts on the same provider sandbox')
assert.match(e2bSandbox, /lifecycle_source_generation = \?[\s\S]*sourceGeneration/, 'lifecycle fences must durably preserve the generation they actually displaced')
assert.match(e2bSandbox, /sourceGeneration: observed\.sourceGeneration \?\? Math\.max\(0, observed\.generation - 1\)/, 'crash takeover must retain the original displaced generation')
assert.match(
  e2bSandbox,
  /for \(let attempt = 0; attempt < 4; attempt \+= 1\)[\s\S]*state\.generation > cached\.generation[\s\S]*setTimeout\(resolve, 75 \* \(attempt \+ 1\)\)/,
  'an immediately-following billing descriptor read must tolerate bounded Turso replica lag while still failing closed on a genuinely newer generation',
)
assert.match(
  e2bSandbox,
  /durableState\.generation < cached\.generation[\s\S]*setTimeout\(resolve, 75\)[\s\S]*continue/,
  'a lagging durable read must not invalidate the newer locally committed E2B generation',
)
assert.match(e2bSandbox, /await killTrackedE2BSandbox\(safeId, sandboxId\)[\s\S]*reconcileKilledE2BSandboxBilling[\s\S]*finishDurableLifecycle/, 'reset/destroy must reconcile billing after confirmed provider stop and before releasing ownership')
const sandboxResetIndex = taskRunner.indexOf('await resetE2BSandbox(conversationId)')
const sandboxConfirmationIndex = taskRunner.indexOf('await getOrCreateE2BSandbox(conversationId)')
const billingDescriptorIndex = taskRunner.indexOf('await getE2BSandboxBillingDescriptor(conversationId)')
const billingActivationIndex = taskRunner.indexOf('await activateServerE2BRuntimeBilling({')
const browserWarmupIndex = taskRunner.indexOf('await ensureE2BRemoteBrowser(conversationId)')
assert.ok(sandboxConfirmationIndex >= 0, 'task startup must create or adopt a real E2B sandbox')
assert.ok(
  sandboxResetIndex < sandboxConfirmationIndex,
  'an isolated task must finish its reset fence before creating and confirming the replacement sandbox',
)
assert.ok(
  sandboxConfirmationIndex < billingDescriptorIndex &&
  billingDescriptorIndex < billingActivationIndex,
  'task billing must activate only after the real E2B sandbox is confirmed and its durable descriptor is read',
)
assert.ok(
  billingActivationIndex < browserWarmupIndex,
  'optional Chromium warm-up must remain outside the sandbox confirmation and billing critical path',
)
assert.match(taskRunner, /setInterval\(\(\) => \{[\s\S]*checkpointRemoteSandboxCredit/, 'long E2B runs must checkpoint while executing')
assert.match(taskRunner, /E2B_BILLING_CHECKPOINT_INTERVAL_MS\s*=\s*30_000/, 'live E2B checkpoints must be infrequent enough to avoid needless transaction contention')
assert.match(taskRunner, /const transient = isTransientUsageAccountingError\(error\)[\s\S]*if \(finalize \|\| !transient\) throw error/, 'transient periodic E2B checkpoint failures must be deferred to durable cleanup instead of stopping the task')
assert.doesNotMatch(taskRunner, /if \(transient\)[\s\S]{0,320}billingAbortController\.abort/, 'transient periodic accounting failures must not abort active tool execution')
assert.match(taskRunner, /Exact remote-sandbox billing is finalized by the durable[\s\S]*pre-terminal cleanup fence/, 'normal completion must rely on the retryable pre-terminal cleanup fence for exact E2B reconciliation')
assert.doesNotMatch(taskRunner, /chargeServerE2BRuntime\(/, 'the task runner must not rely on one process-finally E2B charge')

async function runLiveTursoChecks() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) return

  const workDir = await mkdtemp(join(root, 'scripts/.e2b-runtime-billing-smoke-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')
  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { e2bSandboxRuntimeCreditCharge } from ${JSON.stringify(join(root, 'src/lib/creditPolicy.ts'))}
import {
  activateServerE2BRuntimeBilling,
  checkpointServerE2BRuntimeBilling,
  initializeAccountCredits,
  readServerCreditLedger,
  reconcileServerE2BRuntimeBillingForSandbox,
} from ${JSON.stringify(join(root, 'src/lib/serverCredits.ts'))}
import { tursoExecute } from ${JSON.stringify(join(root, 'src/lib/db/turso.ts'))}

export async function run() {
  const suffix = Date.now() + '-' + Math.random().toString(16).slice(2)
  const userId = 'e2b-billing-user-' + suffix
  const conversationId = 'e2b-billing-conversation-' + suffix
  const runId = 'e2b-billing-run-' + suffix
  const sandboxId = 'e2b-billing-sandbox-' + suffix
  const generation = 7
  const startedAtMs = Date.now() - 120_000
  try {
    await tursoExecute(\`
      create table if not exists agent_cloud_sandboxes (
        conversation_id text primary key,
        provider text not null,
        provider_sandbox_id text not null,
        created_at_ms integer not null,
        updated_at_ms integer not null,
        last_used_at_ms integer not null,
        lifecycle_generation integer not null default 0,
        lifecycle_source_generation integer,
        lifecycle_state text not null default 'active'
      )
    \`)
    await tursoExecute(\`
      insert into agent_cloud_sandboxes (
        conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms,
        last_used_at_ms, lifecycle_generation, lifecycle_state
      ) values (?, 'e2b', ?, ?, ?, ?, ?, 'active')
    \`, [conversationId, sandboxId, startedAtMs, startedAtMs, startedAtMs, generation])
    await initializeAccountCredits(userId, { monthlyAllowance: 50, monthlyBalance: 50 })

    const segmentId = await activateServerE2BRuntimeBilling({
      userId,
      conversationId,
      runId,
      attempt: 1,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation,
      startedAtMs,
      activatedAtMs: Date.now(),
    })
    const firstEnd = startedAtMs + 60_000
    await checkpointServerE2BRuntimeBilling(segmentId, firstEnd)
    await checkpointServerE2BRuntimeBilling(segmentId, firstEnd)
    await checkpointServerE2BRuntimeBilling(segmentId, startedAtMs + 120_000, { close: true })

    const ledger = await readServerCreditLedger(userId)
    const runtimeEntries = ledger.entries.filter((entry) => entry.runId === runId && entry.toolName === 'e2b_sandbox')
    assert.equal(runtimeEntries.length, 2, 'an identical checkpoint retry must not create a second debit')
    assert.equal(
      runtimeEntries.reduce((sum, entry) => Math.round((sum + entry.amount) * 100) / 100, 0),
      e2bSandboxRuntimeCreditCharge({ elapsedMs: 120_000 }),
      'checkpoint sums must equal one cumulative runtime charge',
    )

    const secondSegment = await activateServerE2BRuntimeBilling({
      userId,
      conversationId,
      runId,
      attempt: 2,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation,
      startedAtMs: Date.now() - 5_000,
      activatedAtMs: Date.now(),
    })
    const handoffStartedAt = Date.now()
    await tursoExecute(\`
      update agent_cloud_sandboxes
      set lifecycle_generation = ?,
          lifecycle_source_generation = ?,
          updated_at_ms = ?
      where conversation_id = ?
        and provider_sandbox_id = ?
        and lifecycle_generation = ?
        and lifecycle_state = 'active'
    \`, [generation + 1, generation, handoffStartedAt, conversationId, sandboxId, generation])
    const thirdSegment = await activateServerE2BRuntimeBilling({
      userId,
      conversationId,
      runId,
      attempt: 3,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation + 1,
      startedAtMs: handoffStartedAt,
      activatedAtMs: Date.now(),
    })
    assert.equal(
      (await checkpointServerE2BRuntimeBilling(secondSegment, handoffStartedAt, { close: true })).closed,
      true,
      'a newer attempt on the same provider must close the superseded segment idempotently',
    )
    assert.deepEqual(await reconcileServerE2BRuntimeBillingForSandbox({
      conversationId,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation + 2,
    }), [], 'a stale lifecycle generation must not close the current segment')
    await tursoExecute(\`
      update agent_cloud_sandboxes
      set lifecycle_generation = ?,
          lifecycle_source_generation = ?,
          lifecycle_state = 'destroying',
          updated_at_ms = ?
      where conversation_id = ?
        and provider_sandbox_id = ?
        and lifecycle_generation = ?
        and lifecycle_state = 'active'
    \`, [generation + 2, generation + 1, Date.now(), conversationId, sandboxId, generation + 1])
    const closed = await reconcileServerE2BRuntimeBillingForSandbox({
      conversationId,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation + 1,
    })
    assert.equal(closed.some((checkpoint) => checkpoint.segmentId === thirdSegment && checkpoint.closed), true)
    await assert.rejects(() => activateServerE2BRuntimeBilling({
      userId,
      conversationId,
      runId,
      attempt: 4,
      providerSandboxId: sandboxId,
      lifecycleGeneration: generation + 2,
      startedAtMs: Date.now(),
    }), /ownership changed/i)
  } finally {
    await tursoExecute('delete from credit_ledger where user_id = ?', [userId]).catch(() => undefined)
    await tursoExecute('delete from credit_e2b_runtime_segments where user_id = ?', [userId]).catch(() => undefined)
    await tursoExecute('delete from credit_accounts where user_id = ?', [userId]).catch(() => undefined)
    await tursoExecute('delete from agent_cloud_sandboxes where conversation_id = ?', [conversationId]).catch(() => undefined)
  }
}
`, 'utf8')
    await build({
      entryPoints: [runnerPath],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      logLevel: 'silent',
    })
    const { run } = await import(pathToFileURL(bundlePath).href)
    await run()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await runLiveTursoChecks()
console.log('E2B runtime billing smoke checks passed')
