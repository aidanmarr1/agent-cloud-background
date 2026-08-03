#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const withTurso = process.argv.includes('--with-turso')

const sourceFiles = {
  chatRoute: '../src/app/api/chat/route.ts',
  taskDispatch: '../src/lib/agent/taskDispatch.ts',
  taskJobs: '../src/lib/agent/taskJobs.ts',
  chatTaskRunner: '../src/lib/agent/chatTaskRunner.ts',
  taskWorker: '../src/worker/taskWorker.ts',
  taskWorkerHeartbeat: '../src/lib/agent/taskWorkerHeartbeat.ts',
  taskWorkflow: '../src/workflows/taskExecution.ts',
  backgroundWorkerSmoke: '../src/app/api/internal/background-worker-smoke/route.ts',
  cloudFinishSetup: './cloud-finish-setup.mjs',
  renderWorkerEnv: './render-worker-env.mjs',
  proxy: '../src/proxy.ts',
}

const sources = Object.fromEntries(await Promise.all(
  Object.entries(sourceFiles).map(async ([name, path]) => [
    name,
    await readFile(new URL(path, import.meta.url), 'utf8'),
  ]),
))

function exportedFunction(source, name) {
  const start = source.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `missing exported function ${name}`)
  const end = source.indexOf('\nexport ', start + 1)
  return source.slice(start, end === -1 ? source.length : end)
}

const passed = []

function check(name, assertion) {
  assertion()
  passed.push(name)
}

check('coordinator starts before enqueue and is atomically recorded', () => {
  const coordinatorStart = sources.chatRoute.indexOf(
    'await startTaskExecutionCoordinator(creditRunId)',
  )
  const enqueueStart = sources.chatRoute.indexOf('await enqueueTaskJob({', coordinatorStart)
  assert(coordinatorStart >= 0, 'chat route must start the durable coordinator')
  assert(
    enqueueStart > coordinatorStart,
    'the durable coordinator must start before its task is enqueued',
  )
  assert.match(
    sources.chatRoute.slice(coordinatorStart, enqueueStart),
    /dispatchId:\s*`coordinator:\$\{creditRunId\}`[\s\S]*backend:\s*'vercel-workflow'[\s\S]*providerJobId:\s*coordinator\.workflowRunId/,
    'the route must preserve the exact workflow identity for atomic enqueue',
  )

  const enqueue = exportedFunction(sources.taskJobs, 'enqueueTaskJob')
  const transaction = enqueue.indexOf("tursoTransaction('write'")
  const jobInsert = enqueue.indexOf('insert into agent_task_jobs', transaction)
  const insertFence = enqueue.indexOf('if (inserted.rowsAffected === 1)', jobInsert)
  const dispatchInsert = enqueue.indexOf('insert into agent_task_dispatches', insertFence)
  const eventInsert = enqueue.indexOf('insert or ignore into agent_task_events', dispatchInsert)
  assert(
    transaction >= 0 &&
      jobInsert > transaction &&
      insertFence > jobInsert &&
      dispatchInsert > insertFence &&
      eventInsert > dispatchInsert,
    'job, coordinator dispatch, and initial events must share the successful enqueue transaction',
  )
  assert.match(
    enqueue.slice(dispatchInsert, eventInsert),
    /values \(\?, \?, \?, \?, 'created', null, \?, null, \?, \?\)[\s\S]*input\.coordinatorDispatch\.providerJobId/,
    'the coordinator dispatch must be atomically recorded as created with its provider id',
  )
})

check('task intake hold is an atomic stable-base admission fence', () => {
  const enqueue = exportedFunction(sources.taskJobs, 'enqueueTaskJob')
  const transaction = enqueue.indexOf("tursoTransaction('write'")
  const existingRun = enqueue.indexOf('const existingRun = await transaction.execute', transaction)
  const holdRead = enqueue.indexOf('from agent_task_queue_controls', existingRun)
  const jobInsert = enqueue.indexOf('insert into agent_task_jobs', holdRead)
  assert(
    transaction >= 0 &&
      existingRun > transaction &&
      holdRead > existingRun &&
      jobInsert > holdRead,
    'exact-run replay, exact/base hold observation, and insertion must share one write transaction',
  )
  assert.match(
    enqueue.slice(existingRun, holdRead),
    /existingRunRow[\s\S]*user_id !== input\.userId[\s\S]*conversation_id !== input\.conversationId[\s\S]*queue_name !== queueName[\s\S]*return normalizeStatus\(existingRunRow\.status\)/,
    'an already-owned exact run must remain idempotent before the hold fence',
  )
  assert.match(
    enqueue.slice(holdRead, jobInsert),
    /where queue_name in \(\?, \?\)[\s\S]*args: \[queueName, queueBaseName, queueName\][\s\S]*TaskIntakePausedError/,
    'atomic admission must inspect both the protocol queue and its stable base hold',
  )
  assert.match(
    sources.taskJobs,
    /export class TaskIntakePausedError[\s\S]*readonly code = 'TASK_INTAKE_PAUSED'/,
    'held admission must use a typed error',
  )
  assert.match(
    sources.taskJobs,
    /create table if not exists agent_task_queue_controls/,
    'the enqueue schema bootstrap must create the controls table it reads',
  )
  assert.match(
    sources.chatRoute,
    /error instanceof TaskIntakePausedError[\s\S]*status: 503[\s\S]*'Retry-After': '30'/,
    'the authoritative enqueue fence must surface as a retryable 503',
  )
  assert.match(
    enqueue,
    /intakeAdmission\?: 'signed_internal_probe'[\s\S]*signedInternalProbe[\s\S]*input\.payload\.kind === 'background_probe'[\s\S]*intakeHoldId && !signedInternalProbe/,
    'only the explicitly authenticated internal probe shape may bypass rollout intake',
  )
})

check('deployed smoke uses the real on-demand coordinator', () => {
  assert.match(
    sources.backgroundWorkerSmoke,
    /const onDemandDispatch = usesOnDemandTaskDispatch\(\)[\s\S]*if \(!onDemandDispatch\) \{[\s\S]*getRecentTaskWorkerHeartbeats/,
    'the diagnostic probe must bypass only the idle-heartbeat gate in on-demand mode',
  )
  const coordinatorStart = sources.backgroundWorkerSmoke.indexOf(
    'await startTaskExecutionCoordinator(runId)',
  )
  const enqueueStart = sources.backgroundWorkerSmoke.indexOf(
    'await enqueueTaskJob({',
    coordinatorStart,
  )
  assert(coordinatorStart >= 0, 'the diagnostic probe must start a durable coordinator')
  assert(
    enqueueStart > coordinatorStart,
    'the diagnostic coordinator must start before the durable probe is enqueued',
  )
  assert.match(
    sources.backgroundWorkerSmoke.slice(coordinatorStart, enqueueStart + 350),
    /dispatchId:\s*`coordinator:\$\{runId\}`[\s\S]*backend:\s*'vercel-workflow'[\s\S]*providerJobId:\s*coordinator\.workflowRunId[\s\S]*coordinatorDispatch,/,
    'the diagnostic probe must atomically record its exact Workflow run identity',
  )
  assert.match(
    sources.backgroundWorkerSmoke.slice(enqueueStart, enqueueStart + 500),
    /intakeAdmission:\s*'signed_internal_probe'/,
    'the signed diagnostic must use the narrow rollout-hold admission bypass',
  )
})

check('rollout holds intake and verifies Render before activating Vercel', () => {
  const renderDeploy = sources.cloudFinishSetup.indexOf(
    "runStep('Apply and deploy Render worker env",
  )
  const vercelEnv = sources.cloudFinishSetup.indexOf(
    "runStep('Apply Vercel production env",
  )
  const vercelDeploy = sources.cloudFinishSetup.indexOf(
    "runStep('Deploy Vercel production",
  )
  const readiness = sources.cloudFinishSetup.indexOf('await waitForWorkerReadiness()', vercelDeploy)
  const workerSmoke = sources.cloudFinishSetup.indexOf(
    "runStep('Prove deployed one-off worker execution before reopening intake'",
    readiness,
  )
  const releaseHold = sources.cloudFinishSetup.indexOf(
    "runStep('Release verified rollout intake hold'",
    workerSmoke,
  )
  assert(renderDeploy >= 0, 'rollout must deploy the Render worker image')
  assert(
    renderDeploy < vercelEnv && vercelEnv < vercelDeploy,
    'Render must finish before Vercel environment activation and deployment',
  )
  assert.match(
    sources.cloudFinishSetup,
    /--trigger-deploy'[\s\S]*--wait-for-deploy'[\s\S]*--safe-suspended-deploy'[\s\S]*--keep-intake-held'/,
    'the Render deploy must use the guarded suspended-base path and retain intake hold',
  )
  assert(
    readiness > vercelDeploy && workerSmoke > readiness && releaseHold > workerSmoke,
    'task intake must remain held until the new Vercel deployment passes signed readiness and one-off execution',
  )
  assert.match(
    sources.cloudFinishSetup.slice(workerSmoke, releaseHold),
    /scripts\/prod-background-worker-smoke\.mjs'[\s\S]*--url'[\s\S]*deployedUrl[\s\S]*--timeout-ms'[\s\S]*timeoutMs/,
    'the held rollout must run the paid production smoke against the deployed URL with a bounded timeout',
  )
  assert.match(
    sources.cloudFinishSetup,
    /deployedWorkerSmokeProven = true[\s\S]*scripts\/cloud-preflight\.mjs'[\s\S]*deployedWorkerSmokeProven \? \['--skip-worker-smoke'\] : \[\]/,
    'post-release preflight must skip the paid worker smoke only after that proof passed',
  )
  assert.match(
    sources.renderWorkerEnv,
    /resumeAttempted = true[\s\S]*resumeService[\s\S]*finally \{[\s\S]*suspendAndVerifyForCleanup[\s\S]*finalDeploy[\s\S]*verifyDeployCommit/,
    'the Render helper must resume only under guard, always re-suspend, and verify the exact artifact',
  )
})

check('immediate progress is durable and truthful', () => {
  const initialEvents = sources.chatRoute.indexOf('const initialEvents: SSEEvent[]')
  const progress = sources.chatRoute.indexOf(
    "content: 'Thinking…'",
    initialEvents,
  )
  const enqueue = sources.chatRoute.indexOf('await enqueueTaskJob({', progress)
  assert(initialEvents >= 0, 'task acceptance must construct initial events')
  assert(progress >= 0, 'task acceptance must emit an immediate preparation event')
  assert(enqueue > progress, 'the preparation event must exist before enqueue begins')
  assert.match(
    sources.chatRoute.slice(initialEvents, enqueue + 300),
    /type:\s*'progress_update'[\s\S]*Thinking…[\s\S]*initialEvents,/,
    'task acceptance must enqueue a truthful thinking event instead of claiming work already happened',
  )
  assert.match(
    exportedFunction(sources.taskJobs, 'enqueueTaskJob'),
    /for \(const rawEvent of input\.initialEvents \|\| \[\]\)[\s\S]*insert or ignore into agent_task_events/,
    'initial progress must be committed to durable replay storage',
  )
})

check('exact run claims filter every recovery path and reject malformed targets', () => {
  const claim = exportedFunction(sources.taskJobs, 'claimNextTaskJob')
  assert.match(
    claim,
    /targetRunId !== undefined[\s\S]*typeof targetRunId !== 'string' \|\| !\/\^\[a-zA-Z0-9_-\]\{1,128\}\$\/\.test\(targetRunId\)[\s\S]*throw new Error\('Invalid target task run id'\)/,
    'malformed exact-run targets must fail before queue access',
  )
  assert.equal(
    claim.match(/and \(\? is null or run_id = \?\)/g)?.length,
    4,
    'stale-terminal, stale-cancel, stale-requeue, and queued-selection paths must all be exact-run scoped',
  )
  assert.equal(
    claim.match(/targetRunId \?\? null/g)?.length,
    8,
    'each exact-run SQL predicate must bind the same target twice',
  )
  assert.match(
    sources.taskWorker,
    /const targetRunId = options\.runId\?\.trim\(\) \|\| ''[\s\S]*drainMode[\s\S]*claimNextTaskJob\(workerId, undefined, targetRunId\)/,
    'a one-off worker must pass its exact run id into the atomic queue claim',
  )
})

check('dispatch generations are immutable, globally capped, and token fenced', () => {
  const reserve = exportedFunction(sources.taskJobs, 'reserveTaskDispatchAttempt')
  const complete = exportedFunction(sources.taskJobs, 'completeTaskDispatchAttempt')
  const fail = exportedFunction(sources.taskJobs, 'failTaskDispatchAttempt')
  const unknown = exportedFunction(sources.taskJobs, 'markTaskDispatchAttemptUnknown')
  assert.match(
    reserve,
    /const reservationToken = randomUUID\(\)[\s\S]*values \(\?, \?, \?, \?, 'creating', \?, null, null, \?, \?\)/,
    'a new dispatch must receive an unguessable ownership token',
  )
  assert.match(
    reserve,
    /Dispatch IDs are immutable[\s\S]*select run_id, queue_name, backend, status, provider_job_id[\s\S]*if \(existingRow\)[\s\S]*created: false/,
    'a replayed dispatch ID must return its immutable row without another provider POST',
  )
  assert.doesNotMatch(
    reserve,
    /update agent_task_dispatches[\s\S]*set status = 'creating'/,
    'an old generation must never be reopened',
  )
  assert.match(
    reserve,
    /select count\(\*\) as attempt_count[\s\S]*attemptCount >= taskDispatchMaxAttempts\(\)[\s\S]*status: 'budget_exhausted'/,
    'the write transaction must enforce one shared per-run launch budget',
  )
  for (const [name, source] of [
    ['completion', complete],
    ['known failure', fail],
    ['ambiguous outcome', unknown],
  ]) {
    assert.match(
      source,
      /where dispatch_id = \?[\s\S]*and status = 'creating'[\s\S]*and reservation_token = \?/,
      `dispatch ${name} must compare status and reservation token`,
    )
    assert.match(
      source,
      /return result\.rowsAffected === 1/,
      `dispatch ${name} must report whether its compare-and-swap won`,
    )
  }
})

check('Render dispatch ids use deterministic single-POST generations', () => {
  assert.match(
    sources.taskWorkflow,
    /Number\.isSafeInteger\(generation\)[\s\S]*generation < 1[\s\S]*const dispatchId = `render:\$\{safeRunId\}:\$\{generation\}`/,
    'the workflow step must validate and deterministically derive each dispatch generation',
  )
  assert.match(
    sources.taskWorkflow,
    /dispatchTaskExecutionStep\.maxRetries = 0[\s\S]*let nextDispatchGeneration = 1[\s\S]*dispatchGeneration\(dispatch\.dispatchId, runId\)[\s\S]*generation \+ 1/,
    'the Workflow SDK must not hide a second POST and generations must resume from durable rows',
  )
})

check('cancellation is an atomic spend fence before every provider launch', () => {
  const reserve = exportedFunction(sources.taskJobs, 'reserveTaskDispatchAttempt')
  const finalizeCancellation = exportedFunction(
    sources.taskJobs,
    'finalizeRequestedTaskCancellation',
  )
  const dispatch = exportedFunction(sources.taskDispatch, 'dispatchTaskExecution')
  const workflow = exportedFunction(sources.taskWorkflow, 'taskExecutionWorkflow')
  const cancelFence = reserve.indexOf('taskRow.cancel_requested === 1')
  const existingDispatch = reserve.indexOf('const existing = await transaction.execute')
  const dispatchInsert = reserve.indexOf('insert into agent_task_dispatches')
  assert.match(
    reserve,
    /tursoTransaction\('write'[\s\S]*select status, terminal_status, worker_id, cancel_requested[\s\S]*status: 'task_cancelled'/,
    'the write transaction must observe and reject a cancellation request atomically',
  )
  assert(
    cancelFence >= 0 &&
      cancelFence < existingDispatch &&
      cancelFence < dispatchInsert,
    'cancellation must win before replay, budget, or generation insertion logic',
  )
  assert.match(
    dispatch,
    /if \(!reservation\.created\) \{[\s\S]*reservation\.status === 'task_cancelled'[\s\S]*\? 'cancelled'[\s\S]*return \{[\s\S]*createRenderOneOffJob\(runId\)/,
    'a cancelled reservation must return before the Render POST helper',
  )
  assert.match(
    finalizeCancellation,
    /cancel_requested[\s\S]*fenceAndFinalizeTaskCancellation\(row\.user_id, runId\)[\s\S]*clearLiveDirectivesForRun[\s\S]*releaseActiveTaskLease/,
    'the coordinator cancellation branch must reuse the sandbox/worker execution fence',
  )
  const cancellationBranch = workflow.indexOf(
    'if (!taskIsTerminal && state.cancelRequested)',
  )
  const hardDeadlineCalculation = workflow.indexOf(
    'const hardDeadlineReached = observedAtMs >= hardDeadlineAtMs',
  )
  const liveWorkerBranch = workflow.indexOf("if (state.state === 'running')")
  const providerObservation = workflow.indexOf(
    'observeTaskExecutionProviderStep({',
  )
  const providerLaunch = workflow.indexOf(
    'dispatchTaskExecutionStep(runId, generation)',
  )
  assert(
    hardDeadlineCalculation >= 0 &&
      cancellationBranch > hardDeadlineCalculation &&
      cancellationBranch < liveWorkerBranch &&
      cancellationBranch < providerObservation &&
      cancellationBranch < providerLaunch,
    'the workflow must initialize its deadline, then finish or wait on cancellation before worker/provider observation or launch',
  )
  assert.match(
    workflow.slice(cancellationBranch, liveWorkerBranch),
    /finalizeRequestedTaskCancellationStep\(runId\)[\s\S]*if \(finalized\) \{[\s\S]*sleep\(INITIAL_RUNTIME_WAIT_MS\)[\s\S]*continue[\s\S]*catch \{[\s\S]*hardDeadlineReached[\s\S]*outcome: 'coordinator_deadline'[\s\S]*taskStillActive: true[\s\S]*if \(hardDeadlineReached\)[\s\S]*outcome: 'coordinator_deadline'[\s\S]*taskStillActive: true[\s\S]*continue/,
    'successful cancellation must re-enter terminal provider reconciliation, while failed or unfinished cleanup remains bounded and sleep-only',
  )
})

check('terminal tasks reconcile Render dispatches before Workflow completion', () => {
  const workflow = exportedFunction(sources.taskWorkflow, 'taskExecutionWorkflow')
  const terminalState = workflow.indexOf(
    "const taskIsTerminal = state.state === 'terminal'",
  )
  const providerObservation = workflow.indexOf(
    'providerObservation = await observeTaskExecutionProviderStep({',
  )
  const terminalCompletion = workflow.lastIndexOf(
    'if (taskIsTerminal) return terminalWorkflowResult(runId, state)',
  )
  const eligibleNotFoundBranch = workflow.indexOf(
    'if (eligibleNotFoundDispatches.length > 0)',
  )
  const terminalCancellation = workflow.indexOf(
    'const providerJobIdsToCancel',
    providerObservation,
  )
  const unresolvedDispatchCheck = workflow.indexOf(
    'const unresolvedDispatchExists',
    eligibleNotFoundBranch,
  )
  const liveDispatchCheck = workflow.indexOf(
    'if (providerObservation.possiblyLive || unresolvedDispatchExists)',
    unresolvedDispatchCheck,
  )
  const providerLaunch = workflow.indexOf(
    'dispatchTaskExecutionStep(runId, generation)',
  )
  assert(
    terminalState >= 0 &&
      providerObservation > terminalState &&
      terminalCancellation > providerObservation &&
      eligibleNotFoundBranch > providerObservation &&
      eligibleNotFoundBranch > terminalCancellation &&
      unresolvedDispatchCheck > eligibleNotFoundBranch &&
      liveDispatchCheck > unresolvedDispatchCheck &&
      terminalCompletion > liveDispatchCheck &&
      providerLaunch > terminalCompletion,
    'terminal state must reconcile every provider branch before completing and before any replacement launch',
  )
  assert.doesNotMatch(
    workflow.slice(terminalState, providerObservation),
    /return terminalWorkflowResult/,
    'terminal state must not bypass Render reconciliation',
  )
  assert.match(
    workflow.slice(eligibleNotFoundBranch, unresolvedDispatchCheck),
    /resolveTaskDispatchesNotFoundStep[\s\S]*sleep\(INITIAL_RUNTIME_WAIT_MS\)[\s\S]*continue/,
    'settling one not-found subset must re-inspect all generations before terminal completion',
  )
  assert.doesNotMatch(
    workflow.slice(eligibleNotFoundBranch, unresolvedDispatchCheck),
    /terminalWorkflowResult/,
    'one eligible not-found dispatch must not hide another live or unresolved generation',
  )
  assert.match(
    workflow.slice(terminalCancellation, terminalCompletion + 100),
    /liveProviderJobIds\.filter[\s\S]*terminalCancellationAttempted\[providerJobId\] = true[\s\S]*cancelTerminalTaskProviderJobsStep[\s\S]*providerObservation\.possiblyLive \|\| unresolvedDispatchExists[\s\S]*outcome: 'coordinator_deadline'[\s\S]*if \(taskIsTerminal\) return terminalWorkflowResult/,
    'terminal tasks must cancel each exact live provider job once, preserve uncertain rows at the deadline, and complete only after authoritative settlement',
  )
  assert.match(
    sources.taskWorkflow,
    /const liveProviderJobIds = new Set<string>\(\)[\s\S]*liveProviderJobIds\.add\(observation\.job\.providerJobId\)[\s\S]*liveProviderJobIds\.add\(job\.providerJobId\)[\s\S]*liveProviderJobIds: Array\.from\(liveProviderJobIds\)\.sort\(\)/,
    'provider observation must retain every live exact job across retrieval and listing for multi-generation cancellation',
  )
})

check('provider rejection terminalization respects live launches and execution fences', () => {
  assert.match(
    sources.taskWorkflow,
    /dispatchResult\.status === 'provider_rejected'[\s\S]*if \(!dispatchResult\.retryable\)[\s\S]*observeOnlyReason = 'provider_rejected'/,
    'a permanent rejection must enter observation before terminalization',
  )
  assert.match(
    sources.taskWorkflow,
    /providerObservation\.possiblyLive \|\| unresolvedDispatchExists[\s\S]*continue[\s\S]*observeOnlyReason[\s\S]*failTaskExecutionDispatchStep\([\s\S]*lastRejectedDispatchId/,
    'an earlier accepted or ambiguous job must block a later rejection from killing the task',
  )

  const terminalize = exportedFunction(sources.taskJobs, 'failTaskExecutionDispatch')
  assert.match(
    terminalize,
    /row\.status === 'running'[\s\S]*fenceAndFinalizeStaleTask\([\s\S]*terminalStatus:\s*'error'/,
    'a rejected running task must use the execution fence before terminalization',
  )
  assert.match(
    terminalize,
    /requireNoLiveTaskDispatches:\s*true[\s\S]*ignoredDispatchId:\s*rejectedDispatchId/,
    'the finalizer must ignore only the rejected generation and refuse all other possibly-live launches',
  )
  assert.match(
    terminalize,
    /row\.status === 'queued' && Math\.max\(0, Number\(row\.attempts \|\| 0\)\) > 0[\s\S]*fenceAndFinalizeStaleTask\([\s\S]*expectedStatus:\s*'queued'[\s\S]*expectedAttempts:\s*Math\.max\(0, Number\(row\.attempts \|\| 0\)\)/,
    'a previously attempted queued task must reserve and destroy its sandbox before terminalization',
  )
  assert.match(
    terminalize,
    /row\.status === 'queued'[\s\S]*tursoTransaction\('write'[\s\S]*set status = 'error',[\s\S]*terminal_status = 'error'[\s\S]*and attempts = 0[\s\S]*insert or ignore into agent_task_events[\s\S]*type: 'error'/,
    'only a never-attempted queued task may commit its rejection and error event without a sandbox fence',
  )
  assert.match(
    terminalize,
    /clearLiveDirectivesForRun[\s\S]*releaseActiveTaskLease/,
    'terminalization must clear live input and release the active-task lease',
  )
})

check('drain startup failures requeue behind an execution fence', () => {
  const bootstrapHelper = sources.chatTaskRunner.indexOf(
    'const runClaimedPreChargeBootstrap',
  )
  const taskStartCharge = sources.chatTaskRunner.indexOf(
    'taskStartCreditPromise = chargeServerTaskStart',
  )
  assert(
    bootstrapHelper >= 0 && taskStartCharge > bootstrapHelper,
    'claimed-worker bootstrap recovery must be defined before task-start credit',
  )
  assert.match(
    sources.chatTaskRunner.slice(bootstrapHelper, taskStartCharge),
    /claimedWorkerAttempt !== null[\s\S]*!directChat[\s\S]*isRetryableTaskInfrastructureStartupFailure\(error\)[\s\S]*RetryableTaskInfrastructureInitializationError\(stage, error\)/,
    'only claimed non-direct tasks may convert transient bootstrap failures into fenced retries',
  )
  assert.match(
    sources.chatTaskRunner.slice(bootstrapHelper, taskStartCharge),
    /runClaimedPreChargeBootstrap\(\s*'task_bootstrap',\s*\(\) => openLiveDirectiveRun[\s\S]*runClaimedPreChargeBootstrap\(\s*'task_bootstrap',\s*\(\) => acquireBrowserSessionFence[\s\S]*runClaimedPreChargeBootstrap\(\s*'task_bootstrap',\s*\(\) => clearLiveDirectives[\s\S]*runClaimedPreChargeBootstrap\(\s*'task_bootstrap',\s*\(\) => hydrateMessageAttachmentsForUser/,
    'every blocking pre-charge directive, browser-fence, and attachment bootstrap operation must use the typed retry boundary',
  )
  assert.match(
    sources.chatTaskRunner.slice(bootstrapHelper, taskStartCharge),
    /runClaimedPreChargeBootstrap\(\s*'sandbox_startup',\s*\(\) => pendingStartupReady/,
    'a claimed worker must prove computer startup through the same retry boundary before charging task-start credit',
  )
  const startupClassifier = sources.chatTaskRunner.slice(
    sources.chatTaskRunner.indexOf('function isRetryableTaskInfrastructureStartupFailure'),
    sources.chatTaskRunner.indexOf('async function destroyCloudSandboxAfterTask'),
  )
  assert(
    startupClassifier.indexOf('status === 401') >= 0 &&
      startupClassifier.indexOf('status === 401') < startupClassifier.indexOf('status === 408'),
    'permanent authentication failures must be rejected before transient status classification',
  )
  assert.match(
    startupClassifier,
    /invalid\.\?api\.\?key[\s\S]*not\.\?configured[\s\S]*return false/,
    'permanent credential and configuration failures must remain terminal',
  )
  assert.match(
    sources.taskWorker,
    /ensureAgentRuntimePreloaded\(\)[\s\S]*!isRetryableTaskInfrastructureStartupFailure\(error\)[\s\S]*throw error[\s\S]*RetryableTaskInfrastructureInitializationError\([\s\S]*'agent_runtime_preload'[\s\S]*requestInfrastructureRetry/,
    'runtime preload must retry only transient failures and terminalize permanent defects',
  )
  const claimedRun = exportedFunction(sources.taskJobs, 'runClaimedTaskJob')
  assert.match(
    claimedRun,
    /requestInfrastructureRetry[\s\S]*stopForRequeue\('infrastructure_failure'\)[\s\S]*job\.requeueReason === 'infrastructure_failure'[\s\S]*await establishTerminalExecutionFence\(\)[\s\S]*releaseClaimOnce\(\)[\s\S]*return 'retryable_failure'/,
    'infrastructure recovery must clean up under exact claim ownership before requeue release',
  )
  assert.match(
    sources.taskWorker,
    /taskResult === 'retryable_failure'[\s\S]*sendHeartbeat\('stopping'\)[\s\S]*safely requeued after a transient infrastructure initialization failure/,
    'a safely requeued drain must exit non-zero so its supervisor can restart',
  )
})

check('application proxy excludes Workflow callbacks', () => {
  assert.match(
    sources.proxy,
    /matcher:\s*\['\/\(\(\?!_next\/static\|_next\/image\|favicon\.ico\|\\\\\.well-known\/workflow\)\.\*\)'\]/,
    'Workflow callback paths must bypass the application proxy',
  )
})

check('Render request carries the exact drain command and plan id', () => {
  assert.match(
    sources.taskDispatch,
    /return `npm run worker:drain -- --run-id \$\{validateTaskExecutionRunId\(runId\)\}`/,
    'Render must launch an exact-run drain worker',
  )
  assert.match(
    sources.taskDispatch,
    /body: JSON\.stringify\(\{\s*startCommand: renderTaskExecutionCommand\(safeRunId\),\s*planId,\s*\}\)/,
    'Render one-off creation must send both the exact command and configured plan id',
  )
})

check('stopped worker heartbeats are retained long enough for diagnosis', () => {
  assert.match(
    sources.taskWorkerHeartbeat,
    /STOPPED_WORKER_RETENTION_MS = 24 \* 60 \* 60 \* 1000[\s\S]*ABANDONED_WORKER_RETENTION_MS = 7 \* STOPPED_WORKER_RETENTION_MS/,
    'stopped and abandoned worker retention windows must remain explicit',
  )
  assert.match(
    sources.taskWorkerHeartbeat,
    /if \(input\.status === 'starting'\)[\s\S]*status = 'stopped' and last_seen_at_ms < \?[\s\S]*or last_seen_at_ms < \?[\s\S]*now - STOPPED_WORKER_RETENTION_MS[\s\S]*now - ABANDONED_WORKER_RETENTION_MS/,
    'worker startup must prune only expired stopped or abandoned heartbeats',
  )
})

check('workflow tolerates enqueue lag and observes Render before bounded recovery', () => {
  assert.match(
    sources.taskWorkflow,
    /MISSING_TASK_POLL_MS = 2_000[\s\S]*MISSING_TASK_GRACE_MS = 2 \* 60_000[\s\S]*UNKNOWN_DISPATCH_SETTLE_MS = 2 \* 60_000[\s\S]*COORDINATOR_LAUNCH_DEADLINE_MS = 2 \* 60 \* 60_000/,
    'enqueue lag, ambiguous launch observation, and the launch deadline must be explicit',
  )
  assert.match(
    sources.taskWorkflow,
    /state\.state === 'missing'[\s\S]*missingTaskWaitMs < MISSING_TASK_GRACE_MS[\s\S]*sleep\(MISSING_TASK_POLL_MS\)[\s\S]*missingTaskWaitMs \+= MISSING_TASK_POLL_MS[\s\S]*outcome: 'missing'/,
    'a workflow started before enqueue must poll through the missing-row grace period',
  )
  assert.match(
    sources.taskWorkflow,
    /state\.state === 'running'[\s\S]*hardDeadlineReached[\s\S]*outcome: 'coordinator_deadline'[\s\S]*taskStillActive: true[\s\S]*sleep\(RUNNING_POLL_MS\)/,
    'a live exact worker must remain observed until the finite coordinator backstop without false terminalization',
  )
  assert.match(
    sources.taskWorkflow,
    /catch \{[\s\S]*observedAtMs = await coordinatorClockStep\(\)[\s\S]*observedAtMs >= hardDeadlineAtMs[\s\S]*taskStillActive: true[\s\S]*sleep\(providerBackoffMs\(providerFailureCount\)\)/,
    'persistent database inspection failure must stop at the finite coordinator backstop',
  )
  assert.match(
    sources.taskWorkflow,
    /if \(!providerObservation\.authoritative\)[\s\S]*hardDeadlineReached[\s\S]*taskStillActive: true[\s\S]*sleep\(providerBackoffMs\(providerFailureCount\)\)/,
    'non-authoritative provider observation must stop at the finite coordinator backstop',
  )
  assert.match(
    sources.taskWorkflow,
    /providerObservation\.possiblyLive \|\| unresolvedDispatchExists[\s\S]*hardDeadlineReached[\s\S]*taskStillActive: true[\s\S]*sleep\(providerBackoffMs\(1\)\)/,
    'possibly-live or unresolved provider state must not poll past the finite coordinator backstop',
  )
  assert.match(
    sources.taskWorkflow,
    /observeTaskExecutionProviderStep\([\s\S]*providerObservation\.possiblyLive \|\| unresolvedDispatchExists[\s\S]*continue[\s\S]*dispatchTaskExecutionStep\(runId, generation\)/,
    'no replacement generation may launch until provider observation proves prior work inactive',
  )
  assert.match(
    sources.taskDispatch,
    /\/jobs\/\$\{encodeURIComponent\(normalizedJobId\)\}[\s\S]*\/jobs\?\$\{query\.toString\(\)\}[\s\S]*startCommand === renderTaskExecutionCommand\(runId\)/,
    'recovery must use Render retrieve/list APIs and exact start-command matching',
  )
})

if (withTurso) {
  loadLocalEnvFiles(rootUrl)
  assert(
    process.env.TURSO_DATABASE_URL?.trim() && process.env.TURSO_AUTH_TOKEN?.trim(),
    '--with-turso requires existing TURSO_DATABASE_URL and TURSO_AUTH_TOKEN values',
  )
} else {
  // Runtime validation must remain local-only unless database coverage is
  // explicitly requested. This prevents a routine source smoke from writing to
  // a developer or production Turso database loaded by the surrounding shell.
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
}

const rawQueueName = `on-demand-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`
process.env.AGENT_TASK_QUEUE_NAME = rawQueueName
process.env.AGENT_TASK_WORKER_MODE = 'external'

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
    'server-only': fileURLToPath(
      new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url),
    ),
  },
})

const taskJobs = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/taskJobs.ts', import.meta.url)),
)
const taskDispatch = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/taskDispatch.ts', import.meta.url)),
)
const {
  isRetryableTaskInfrastructureStartupFailure,
} = await jiti.import(
  fileURLToPath(new URL('../src/lib/agent/chatTaskRunner.ts', import.meta.url)),
)

assert.equal(
  isRetryableTaskInfrastructureStartupFailure(
    Object.assign(new Error('upstream gateway timed out'), { status: 504 }),
  ),
  true,
  'transient runtime preload failures must consume a fenced retry',
)
assert.equal(
  isRetryableTaskInfrastructureStartupFailure(
    Object.assign(new Error('E2B API key is invalid'), { status: 401 }),
  ),
  false,
  'permanent authentication failures must terminalize without another paid worker',
)
assert.equal(
  isRetryableTaskInfrastructureStartupFailure(
    Object.assign(new Error('Cannot find module AgentLoop'), { code: 'ERR_MODULE_NOT_FOUND' }),
  ),
  false,
  'permanent runtime bundle defects must terminalize without another paid worker',
)
passed.push('runtime preload transient/permanent classifier boundary')

for (const malformedTarget of ['', null, 'bad/run', 'contains spaces']) {
  await assert.rejects(
    () => taskJobs.claimNextTaskJob('on-demand-smoke-worker', 1_000, malformedTarget),
    /Invalid target task run id/,
    `malformed exact-run target ${JSON.stringify(malformedTarget)} must fail closed`,
  )
}
assert.equal(
  taskDispatch.renderTaskExecutionCommand('runtime-smoke_run-1'),
  'npm run worker:drain -- --run-id runtime-smoke_run-1',
  'the runtime Render command must preserve the validated exact run id',
)
assert.throws(
  () => taskDispatch.renderTaskExecutionCommand('runtime smoke/run'),
  /Invalid task run id/,
  'the runtime Render command must reject a shell-unsafe run id',
)
passed.push('runtime malformed-target and exact-command validation')

{
  const renderEnvironment = {
    RENDER_API_KEY: process.env.RENDER_API_KEY,
    RENDER_WORKER_SERVICE_ID: process.env.RENDER_WORKER_SERVICE_ID,
  }
  const originalFetch = globalThis.fetch
  const serviceId = 'srv-00000000000000000000'
  const providerJobId = 'job-00000000000000000000'
  const requests = []
  process.env.RENDER_API_KEY = 'render-cancellation-smoke-key'
  process.env.RENDER_WORKER_SERVICE_ID = serviceId
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response('{}', {
        status: requests.length === 1 ? 200 : requests.length === 2 ? 404 : 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    assert.deepEqual(
      await taskDispatch.cancelTaskDispatchProviderJob(providerJobId),
      { outcome: 'accepted', providerJobId },
      'a successful Render cancellation must be reported as accepted',
    )
    assert.equal(
      requests[0]?.url,
      `https://api.render.com/v1/services/${serviceId}/jobs/${providerJobId}/cancel`,
      'Render cancellation must target the exact service and one-off job',
    )
    assert.equal(
      requests[0]?.init?.method,
      'POST',
      'Render cancellation must use the provider cancellation POST',
    )
    assert.deepEqual(
      await taskDispatch.cancelTaskDispatchProviderJob(providerJobId),
      { outcome: 'not_found', providerJobId },
      'an authoritative missing Render job must be distinguished from an uncertain cancellation',
    )
    const uncertainCancellation =
      await taskDispatch.cancelTaskDispatchProviderJob(providerJobId)
    assert.equal(uncertainCancellation.outcome, 'unknown')
    assert.equal(uncertainCancellation.errorCode, 'PROVIDER_UNAVAILABLE')

    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        )
      })
    const smokeDeadline = new AbortController()
    const startedAtMs = Date.now()
    const smokeDeadlineTimer = setTimeout(() => smokeDeadline.abort(), 25)
    const abortedCancellation =
      await taskDispatch.cancelTaskDispatchProviderJob(providerJobId, {
        signal: smokeDeadline.signal,
      })
    clearTimeout(smokeDeadlineTimer)
    assert.equal(abortedCancellation.outcome, 'unknown')
    assert.equal(abortedCancellation.errorCode, 'REQUEST_TIMEOUT')
    assert.ok(
      Date.now() - startedAtMs < 1_000,
      'a smoke-scoped provider deadline must abort a hanging cancellation well before the default 20s request timeout',
    )
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of Object.entries(renderEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
passed.push('bounded exact Render cancellation outcomes')

if (withTurso) {
  const {
    cleanupInternalTaskJob,
    completeTaskDispatchAttempt,
    enqueueTaskJob,
    failTaskDispatchAttempt,
    failTaskExecutionDispatch,
    finalizeRequestedTaskCancellation,
    inspectTaskExecutionDispatchState,
    markTaskDispatchAttemptUnknown,
    reconcileTaskDispatchAttempt,
    recordTaskDispatchProviderStatus,
    reserveTaskDispatchAttempt,
    runClaimedTaskJob,
    TaskIntakePausedError,
  } = taskJobs
  const {
    acquireActiveTaskLease,
    getActiveTaskLeaseForUser,
    releaseActiveTaskLease,
  } = await jiti.import(fileURLToPath(new URL('../src/lib/activeTasks.ts', import.meta.url)))
  const {
    markTaskWorkerStopped,
    recordTaskWorkerHeartbeat,
  } = await jiti.import(
    fileURLToPath(new URL('../src/lib/agent/taskWorkerHeartbeat.ts', import.meta.url)),
  )
  const { taskQueueBaseName, taskQueueName } = await jiti.import(
    fileURLToPath(new URL('../src/lib/agent/taskQueue.ts', import.meta.url)),
  )
  const { tursoExecute } = await jiti.import(
    fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url)),
  )

  const suffix = randomUUID()
  const first = {
    userId: `internal-background-smoke-${suffix}`,
    conversationId: `internal-background-smoke-${suffix}`,
    runId: `background-smoke-${suffix}`,
  }
  const secondSuffix = randomUUID()
  const second = {
    userId: `internal-background-smoke-${secondSuffix}`,
    conversationId: `internal-background-smoke-${secondSuffix}`,
    runId: `background-smoke-${secondSuffix}`,
  }
  const thirdSuffix = randomUUID()
  const third = {
    userId: `internal-background-smoke-${thirdSuffix}`,
    conversationId: `internal-background-smoke-${thirdSuffix}`,
    runId: `background-smoke-${thirdSuffix}`,
  }
  const fourthSuffix = randomUUID()
  const fourth = {
    userId: `internal-background-smoke-${fourthSuffix}`,
    conversationId: `internal-background-smoke-${fourthSuffix}`,
    runId: `background-smoke-${fourthSuffix}`,
  }
  const fifthSuffix = randomUUID()
  const fifth = {
    userId: `internal-background-smoke-${fifthSuffix}`,
    conversationId: `internal-background-smoke-${fifthSuffix}`,
    runId: `background-smoke-${fifthSuffix}`,
  }
  const baseHeldSuffix = randomUUID()
  const baseHeld = {
    userId: `internal-background-smoke-${baseHeldSuffix}`,
    conversationId: `internal-background-smoke-${baseHeldSuffix}`,
    runId: `background-smoke-${baseHeldSuffix}`,
  }
  const exactHeldSuffix = randomUUID()
  const exactHeld = {
    userId: `internal-background-smoke-${exactHeldSuffix}`,
    conversationId: `internal-background-smoke-${exactHeldSuffix}`,
    runId: `background-smoke-${exactHeldSuffix}`,
  }
  const signedProbeSuffix = randomUUID()
  const signedProbe = {
    userId: `internal-background-smoke-${signedProbeSuffix}`,
    conversationId: `internal-background-smoke-${signedProbeSuffix}`,
    runId: `background-smoke-${signedProbeSuffix}`,
  }
  const workerId = `on-demand-smoke-worker-${suffix}`
  const heartbeatIds = {
    expiredStopped: `on-demand-smoke-expired-stopped-${suffix}`,
    recentStopped: `on-demand-smoke-recent-stopped-${suffix}`,
    abandoned: `on-demand-smoke-abandoned-${suffix}`,
    trigger: `on-demand-smoke-trigger-${suffix}`,
  }
  const runIds = [
    first.runId,
    second.runId,
    third.runId,
    fourth.runId,
    fifth.runId,
    baseHeld.runId,
    exactHeld.runId,
    signedProbe.runId,
  ]
  const workerIds = [workerId, ...Object.values(heartbeatIds)]
  const queueName = taskQueueName()
  const queueBaseName = taskQueueBaseName()

  async function hardCleanup() {
    await Promise.all([
      releaseActiveTaskLease(first.userId, first.runId).catch(() => undefined),
      releaseActiveTaskLease(second.userId, second.runId).catch(() => undefined),
      releaseActiveTaskLease(third.userId, third.runId).catch(() => undefined),
      releaseActiveTaskLease(fourth.userId, fourth.runId).catch(() => undefined),
      releaseActiveTaskLease(fifth.userId, fifth.runId).catch(() => undefined),
    ])
    for (const runId of runIds) {
      await tursoExecute('delete from agent_task_events where run_id = ?', [runId]).catch(() => undefined)
      await tursoExecute('delete from agent_task_live_frames where run_id = ?', [runId]).catch(() => undefined)
      await tursoExecute('delete from agent_task_dispatches where run_id = ?', [runId]).catch(() => undefined)
      await tursoExecute(
        'delete from agent_task_jobs where run_id = ? and queue_name = ?',
        [runId, queueName],
      ).catch(() => undefined)
    }
    for (const smokeWorkerId of workerIds) {
      await tursoExecute(
        'delete from agent_task_workers where worker_id = ? and queue_name = ?',
        [smokeWorkerId, queueName],
      ).catch(() => undefined)
    }
    await tursoExecute(
      'delete from agent_task_queue_controls where queue_name in (?, ?)',
      [queueName, queueBaseName],
    ).catch(() => undefined)
  }

  try {
    const lease = await acquireActiveTaskLease(
      first.userId,
      first.conversationId,
      first.runId,
    )
    assert.equal(lease.acquired, true, 'runtime smoke must acquire its isolated active-task lease')

    await enqueueTaskJob({
      ...first,
      payload: {
        kind: 'background_probe',
        delayMs: 0,
        message: rawQueueName,
      },
      initialEvents: [
        { type: 'heartbeat', timestamp: Date.now() },
        {
          type: 'progress_update',
          content: 'Thinking…',
        },
      ],
      coordinatorDispatch: {
        dispatchId: `coordinator:${first.runId}`,
        backend: 'vercel-workflow',
        providerJobId: `workflow-${suffix}`,
      },
    })
    await enqueueTaskJob({
      ...second,
      payload: {
        kind: 'background_probe',
        delayMs: 0,
        message: rawQueueName,
      },
    })
    await enqueueTaskJob({
      ...third,
      payload: {
        kind: 'background_probe',
        delayMs: 0,
        message: rawQueueName,
      },
    })
    await enqueueTaskJob({
      ...fourth,
      payload: {
        kind: 'background_probe',
        delayMs: 0,
        message: rawQueueName,
      },
    })
    await enqueueTaskJob({
      ...fifth,
      payload: {
        kind: 'background_probe',
        delayMs: 0,
        message: rawQueueName,
      },
    })

    const heldAtMs = Date.now()
    await tursoExecute(
      `
        insert into agent_task_queue_controls (
          queue_name, intake_hold_id, intake_hold_reason, intake_held_at_ms, updated_at_ms
        )
        values (?, ?, ?, ?, ?)
        on conflict(queue_name) do update set
          intake_hold_id = excluded.intake_hold_id,
          intake_hold_reason = excluded.intake_hold_reason,
          intake_held_at_ms = excluded.intake_held_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `,
      [queueBaseName, `base-hold-${suffix}`, 'atomic admission smoke', heldAtMs, heldAtMs],
    )
    assert.deepEqual(
      await enqueueTaskJob({
        ...first,
        payload: {
          kind: 'background_probe',
          delayMs: 0,
          message: rawQueueName,
        },
      }),
      { runId: first.runId, status: 'queued' },
      'an already-owned exact run must replay idempotently while base intake is held',
    )
    await assert.rejects(
      () => enqueueTaskJob({
        ...baseHeld,
        payload: {
          kind: 'background_probe',
          delayMs: 0,
          message: rawQueueName,
        },
      }),
      (error) => (
        error instanceof TaskIntakePausedError &&
        error.queueName === queueBaseName &&
        error.holdId === `base-hold-${suffix}`
      ),
      'a stable base-name hold must atomically reject a new protocol-queue run',
    )
    const baseHeldRows = await tursoExecute(
      'select count(*) as job_count from agent_task_jobs where run_id = ?',
      [baseHeld.runId],
    )
    assert.equal(
      Number(baseHeldRows.rows[0]?.job_count || 0),
      0,
      'a rejected base-held admission must not leave a ghost task row',
    )
    await tursoExecute(
      'delete from agent_task_queue_controls where queue_name = ?',
      [queueBaseName],
    )

    await tursoExecute(
      `
        insert into agent_task_queue_controls (
          queue_name, intake_hold_id, intake_hold_reason, intake_held_at_ms, updated_at_ms
        )
        values (?, ?, ?, ?, ?)
      `,
      [queueName, `exact-hold-${suffix}`, 'exact admission smoke', heldAtMs, heldAtMs],
    )
    await assert.rejects(
      () => enqueueTaskJob({
        ...exactHeld,
        payload: {
          kind: 'background_probe',
          delayMs: 0,
          message: rawQueueName,
        },
      }),
      (error) => (
        error instanceof TaskIntakePausedError &&
        error.queueName === queueName &&
        error.holdId === `exact-hold-${suffix}`
      ),
      'an exact protocol-queue hold must atomically reject a new run',
    )
    assert.deepEqual(
      await enqueueTaskJob({
        ...signedProbe,
        payload: {
          kind: 'background_probe',
          delayMs: 0,
          message: rawQueueName,
        },
        intakeAdmission: 'signed_internal_probe',
      }),
      { runId: signedProbe.runId, status: 'queued' },
      'the explicit signed internal probe capability must bypass rollout intake',
    )
    await tursoExecute(
      'delete from agent_task_queue_controls where queue_name = ?',
      [queueName],
    )

    const atomicRows = await tursoExecute(
      `
        select
          (select status from agent_task_jobs where run_id = ? and queue_name = ?) as job_status,
          (select status from agent_task_dispatches where dispatch_id = ?) as dispatch_status,
          (select provider_job_id from agent_task_dispatches where dispatch_id = ?) as provider_job_id,
          (select event_json from agent_task_events where run_id = ? and seq = 2) as progress_event
      `,
      [
        first.runId,
        queueName,
        `coordinator:${first.runId}`,
        `coordinator:${first.runId}`,
        first.runId,
      ],
    )
    const atomic = atomicRows.rows[0]
    assert.equal(atomic?.job_status, 'queued')
    assert.equal(atomic?.dispatch_status, 'created')
    assert.equal(atomic?.provider_job_id, `workflow-${suffix}`)
    assert.equal(
      JSON.parse(String(atomic?.progress_event || '{}')).content,
      'Thinking…',
    )

    await tursoExecute(
      `
        update agent_task_jobs
        set status = 'running',
            cancel_requested = 1,
            worker_id = null,
            lease_expires_at_ms = 0,
            updated_at_ms = ?
        where run_id = ? and queue_name = ?
      `,
      [Date.now(), fifth.runId, queueName],
    )
    const cancelledDispatchId = `render:${fifth.runId}:1`
    const cancelledReservation = await reserveTaskDispatchAttempt({
      runId: fifth.runId,
      dispatchId: cancelledDispatchId,
      backend: 'render-one-off',
    })
    assert.equal(cancelledReservation.created, false)
    assert.equal(cancelledReservation.status, 'task_cancelled')
    assert.equal(cancelledReservation.reservationToken, null)

    const renderEnvironment = {
      RENDER_API_KEY: process.env.RENDER_API_KEY,
      RENDER_WORKER_SERVICE_ID: process.env.RENDER_WORKER_SERVICE_ID,
      RENDER_ON_DEMAND_JOB_PLAN_ID: process.env.RENDER_ON_DEMAND_JOB_PLAN_ID,
    }
    process.env.RENDER_API_KEY = ''
    process.env.RENDER_WORKER_SERVICE_ID = ''
    process.env.RENDER_ON_DEMAND_JOB_PLAN_ID = ''
    try {
      assert.deepEqual(
        await taskDispatch.dispatchTaskExecution({
          runId: fifth.runId,
          dispatchId: cancelledDispatchId,
        }),
        {
          status: 'cancelled',
          dispatchId: cancelledDispatchId,
          providerJobId: null,
        },
        'a cancelled task must return before provider configuration or POST',
      )
    } finally {
      for (const [name, value] of Object.entries(renderEnvironment)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    const cancelledDispatchRows = await tursoExecute(
      `
        select count(*) as dispatch_count
        from agent_task_dispatches
        where run_id = ? and queue_name = ? and backend = 'render-one-off'
      `,
      [fifth.runId, queueName],
    )
    assert.equal(
      Number(cancelledDispatchRows.rows[0]?.dispatch_count || 0),
      0,
      'cancellation must prevent both generation insertion and a provider launch path',
    )

    const previousSandboxProvider = process.env.AGENT_SANDBOX_PROVIDER
    process.env.AGENT_SANDBOX_PROVIDER = 'local'
    try {
      assert.equal(
        await finalizeRequestedTaskCancellation(fifth.runId),
        true,
        'the workflow cancellation step must complete through the existing execution fence',
      )
    } finally {
      if (previousSandboxProvider === undefined) {
        delete process.env.AGENT_SANDBOX_PROVIDER
      } else {
        process.env.AGENT_SANDBOX_PROVIDER = previousSandboxProvider
      }
    }
    const cancelledTaskState = await inspectTaskExecutionDispatchState(fifth.runId)
    assert.equal(cancelledTaskState.state, 'terminal')
    assert.equal(cancelledTaskState.status, 'cancelled')
    assert.equal(cancelledTaskState.renderDispatches.length, 0)

    const dispatchId = `render:${first.runId}:1`
    const firstReservation = await reserveTaskDispatchAttempt({
      runId: first.runId,
      dispatchId,
      backend: 'render-one-off',
    })
    assert(firstReservation.created && firstReservation.reservationToken)
    await tursoExecute(
      'update agent_task_dispatches set updated_at_ms = 0 where dispatch_id = ?',
      [dispatchId],
    )
    const replayedReservation = await reserveTaskDispatchAttempt({
      runId: first.runId,
      dispatchId,
      backend: 'render-one-off',
    })
    assert.equal(replayedReservation.created, false)
    assert.equal(replayedReservation.status, 'creating')
    assert.equal(replayedReservation.reservationToken, null)
    assert.equal(
      await completeTaskDispatchAttempt(
        dispatchId,
        firstReservation.reservationToken,
        `render-current-${suffix}`,
      ),
      true,
      'the immutable generation owner must retain its completion CAS',
    )
    assert.equal(
      await failTaskDispatchAttempt(
        dispatchId,
        firstReservation.reservationToken,
        new Error('late failure'),
      ),
      false,
      'a completed generation must reject a late failure',
    )

    const ambiguousDispatchId = `render:${first.runId}:2`
    const ambiguousReservation = await reserveTaskDispatchAttempt({
      runId: first.runId,
      dispatchId: ambiguousDispatchId,
      backend: 'render-one-off',
    })
    assert(ambiguousReservation.created && ambiguousReservation.reservationToken)
    assert.equal(
      await markTaskDispatchAttemptUnknown(
        ambiguousDispatchId,
        ambiguousReservation.reservationToken,
        new Error('simulated accepted-then-timeout result'),
      ),
      true,
      'an ambiguous provider response must become sticky unknown state',
    )
    const replayedUnknown = await reserveTaskDispatchAttempt({
      runId: first.runId,
      dispatchId: ambiguousDispatchId,
      backend: 'render-one-off',
    })
    assert.equal(replayedUnknown.created, false)
    assert.equal(replayedUnknown.status, 'unknown')
    const reconciledProviderJobId = `render-reconciled-${suffix}`
    assert.equal(
      await reconcileTaskDispatchAttempt(
        ambiguousDispatchId,
        first.runId,
        'render-one-off',
        reconciledProviderJobId,
      ),
      true,
      'authoritative Render listing must be able to adopt an ambiguous job',
    )
    assert.equal(
      await recordTaskDispatchProviderStatus(
        ambiguousDispatchId,
        reconciledProviderJobId,
        'failed',
      ),
      true,
      'a terminal provider job must stop blocking later recovery',
    )
    assert.equal(
      await recordTaskDispatchProviderStatus(
        dispatchId,
        `render-current-${suffix}`,
        'failed',
      ),
      true,
      'the accepted CAS test job must be observed terminal before finalization',
    )

    const budgetReservations = await Promise.all(
      Array.from({ length: 12 }, (_, index) => reserveTaskDispatchAttempt({
        runId: third.runId,
        dispatchId: `render:${third.runId}:${index + 1}`,
        backend: 'render-one-off',
      })),
    )
    assert.equal(
      budgetReservations.filter((reservation) => reservation.created).length,
      8,
      'concurrent coordinators must share the eight-generation database budget',
    )
    assert.equal(
      budgetReservations.filter(
        (reservation) => reservation.status === 'budget_exhausted',
      ).length,
      4,
      'every generation beyond the shared cap must be observe-only',
    )
    const budgetState = await inspectTaskExecutionDispatchState(third.runId)
    assert.equal(budgetState.renderDispatches.length, 8)

    const acceptedDispatchId = `render:${fourth.runId}:1`
    const acceptedReservation = await reserveTaskDispatchAttempt({
      runId: fourth.runId,
      dispatchId: acceptedDispatchId,
      backend: 'render-one-off',
    })
    assert(acceptedReservation.created && acceptedReservation.reservationToken)
    const acceptedProviderJobId = `render-accepted-${fourthSuffix}`
    assert.equal(
      await completeTaskDispatchAttempt(
        acceptedDispatchId,
        acceptedReservation.reservationToken,
        acceptedProviderJobId,
      ),
      true,
    )
    const laterRejectedDispatchId = `render:${fourth.runId}:2`
    const laterRejectedReservation = await reserveTaskDispatchAttempt({
      runId: fourth.runId,
      dispatchId: laterRejectedDispatchId,
      backend: 'render-one-off',
    })
    assert(laterRejectedReservation.created && laterRejectedReservation.reservationToken)
    assert.equal(
      await reconcileTaskDispatchAttempt(
        laterRejectedDispatchId,
        fourth.runId,
        'render-one-off',
        acceptedProviderJobId,
      ),
      false,
      'one provider job identity must never be adopted by two dispatch rows',
    )
    assert.equal(
      await failTaskDispatchAttempt(
        laterRejectedDispatchId,
        laterRejectedReservation.reservationToken,
        new Error('simulated permanent rejection'),
      ),
      true,
    )
    assert.equal(
      await failTaskExecutionDispatch(
        fourth.runId,
        laterRejectedDispatchId,
        'A later launch was rejected.',
      ),
      false,
      'a later rejection must not kill an earlier accepted job that may still provision',
    )
    const protectedAcceptedTask = await tursoExecute(
      `
        select status, terminal_status,
          (select count(*) from agent_task_events
           where run_id = ? and event_json like '%"type":"error"%') as error_events
        from agent_task_jobs
        where run_id = ? and queue_name = ?
      `,
      [fourth.runId, fourth.runId, queueName],
    )
    assert.equal(protectedAcceptedTask.rows[0]?.status, 'queued')
    assert.equal(protectedAcceptedTask.rows[0]?.terminal_status, null)
    assert.equal(Number(protectedAcceptedTask.rows[0]?.error_events || 0), 0)
    assert.equal(
      await recordTaskDispatchProviderStatus(
        acceptedDispatchId,
        acceptedProviderJobId,
        'failed',
      ),
      true,
    )
    assert.equal(
      await failTaskExecutionDispatch(
        fourth.runId,
        laterRejectedDispatchId,
        'A later launch was rejected.',
      ),
      true,
      'terminalization may proceed only after the earlier accepted job is observed terminal',
    )

    const workerStartedAt = Date.now()
    await recordTaskWorkerHeartbeat({
      workerId,
      startedAtMs: workerStartedAt,
      pollMs: 100,
      heartbeatMs: 15_000,
      status: 'idle',
      currentRunId: null,
      completedTasks: 0,
    })
    const exactClaim = await taskJobs.claimNextTaskJob(workerId, 60_000, second.runId)
    assert.equal(
      exactClaim?.runId,
      second.runId,
      'exact-run claim must skip an older queued task',
    )
    const untouched = await tursoExecute(
      'select status from agent_task_jobs where run_id = ? and queue_name = ?',
      [first.runId, queueName],
    )
    assert.equal(untouched.rows[0]?.status, 'queued')
    await recordTaskWorkerHeartbeat({
      workerId,
      startedAtMs: workerStartedAt,
      pollMs: 100,
      heartbeatMs: 15_000,
      status: 'running',
      currentRunId: second.runId,
      completedTasks: 0,
    })
    await runClaimedTaskJob(exactClaim, async (emitter) => {
      emitter.done()
    })
    await recordTaskWorkerHeartbeat({
      workerId,
      startedAtMs: workerStartedAt,
      pollMs: 100,
      heartbeatMs: 15_000,
      status: 'idle',
      currentRunId: null,
      completedTasks: 1,
    })
    const previouslyAttemptedClaim = await taskJobs.claimNextTaskJob(
      workerId,
      60_000,
      first.runId,
    )
    assert.equal(previouslyAttemptedClaim?.runId, first.runId)
    assert.equal(
      await runClaimedTaskJob(previouslyAttemptedClaim, async (_emitter, _signal, context) => {
        assert.equal(
          context.requestInfrastructureRetry('runtime_smoke_startup_failure'),
          true,
          'runtime smoke must accept a pre-terminal infrastructure retry',
        )
        throw new Error('simulated transient startup failure')
      }),
      'retryable_failure',
      'an infrastructure startup failure must fence and safely requeue the task',
    )
    await markTaskWorkerStopped(workerId, workerStartedAt)

    const rejectionMessage = 'The isolated Render launch was rejected.'
    assert.equal(
      await failTaskExecutionDispatch(first.runId, dispatchId, rejectionMessage),
      true,
      'provider rejection must terminalize the queued task',
    )
    const rejected = await tursoExecute(
      `
        select status, terminal_status, terminal_error, attempts,
          (select event_json
           from agent_task_events
           where agent_task_events.run_id = agent_task_jobs.run_id
           order by seq desc
           limit 1) as latest_event
        from agent_task_jobs
        where run_id = ? and queue_name = ?
      `,
      [first.runId, queueName],
    )
    assert.equal(rejected.rows[0]?.status, 'error')
    assert.equal(rejected.rows[0]?.terminal_status, 'error')
    assert.equal(rejected.rows[0]?.terminal_error, rejectionMessage)
    assert.equal(
      rejected.rows[0]?.attempts,
      1,
      'provider rejection must preserve the attempted-run fence generation',
    )
    assert.deepEqual(
      JSON.parse(String(rejected.rows[0]?.latest_event || '{}')),
      {
        type: 'error',
        message: rejectionMessage,
        seq: 3,
        runId: first.runId,
      },
    )
    assert.equal(
      await getActiveTaskLeaseForUser(first.userId),
      null,
      'provider rejection terminalization must release its active-task lease',
    )

    const heartbeatStartedAt = Date.now()
    for (const [worker, status] of [
      [heartbeatIds.expiredStopped, 'stopped'],
      [heartbeatIds.recentStopped, 'stopped'],
      [heartbeatIds.abandoned, 'idle'],
    ]) {
      await recordTaskWorkerHeartbeat({
        workerId: worker,
        startedAtMs: heartbeatStartedAt,
        pollMs: 100,
        heartbeatMs: 15_000,
        status,
        currentRunId: null,
        completedTasks: 0,
      })
    }
    await tursoExecute(
      'update agent_task_workers set last_seen_at_ms = ? where worker_id = ? and queue_name = ?',
      [Date.now() - (2 * 24 * 60 * 60 * 1000), heartbeatIds.expiredStopped, queueName],
    )
    await tursoExecute(
      'update agent_task_workers set last_seen_at_ms = ? where worker_id = ? and queue_name = ?',
      [Date.now() - (8 * 24 * 60 * 60 * 1000), heartbeatIds.abandoned, queueName],
    )
    await recordTaskWorkerHeartbeat({
      workerId: heartbeatIds.trigger,
      startedAtMs: heartbeatStartedAt,
      pollMs: 100,
      heartbeatMs: 15_000,
      status: 'starting',
      currentRunId: null,
      completedTasks: 0,
    })
    const retainedWorkers = await tursoExecute(
      'select worker_id from agent_task_workers where queue_name = ?',
      [queueName],
    )
    const retainedIds = new Set(retainedWorkers.rows.map((row) => row.worker_id))
    assert.equal(retainedIds.has(heartbeatIds.expiredStopped), false)
    assert.equal(retainedIds.has(heartbeatIds.abandoned), false)
    assert.equal(retainedIds.has(heartbeatIds.recentStopped), true)

    assert.equal(await cleanupInternalTaskJob(first.userId, first.runId), true)
    assert.equal(await cleanupInternalTaskJob(second.userId, second.runId), true)
    assert.equal(await cleanupInternalTaskJob(fourth.userId, fourth.runId), true)
    assert.equal(await cleanupInternalTaskJob(fifth.userId, fifth.runId), true)
    passed.push('isolated Turso atomic hold admission, idempotent replay, cancellation spend fence, immutable dispatch budget, accepted-job protection, exact claim, fenced retry, terminalization, and retention')
  } finally {
    await hardCleanup()
  }
}

console.log(JSON.stringify({
  ok: true,
  checks: passed,
  tursoRuntime: withTurso ? 'passed' : 'skipped (use --with-turso with existing credentials)',
}, null, 2))
