import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const [
  chatRoute,
  directiveRoute,
  liveDirectives,
  runner,
  loop,
  planner,
  pipeline,
  emitterSource,
  e2bSandbox,
  imageSearch,
  taskJobs,
  filesRoute,
] = await Promise.all([
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/directive/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/liveDirectives.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/SSEEmitter.ts'), 'utf8'),
  readFile(join(root, 'src/lib/e2bSandbox.ts'), 'utf8'),
  readFile(join(root, 'src/lib/imageSearch.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/files/route.ts'), 'utf8'),
])

assert.doesNotMatch(chatRoute, /async function runChatTaskJob\(/, 'the API route must use the shared task runner instead of a divergent private copy')
assert.match(chatRoute, /Promise\.all\(\[[\s\S]*creditsPromise,[\s\S]*messagesPromise,[\s\S]*workerAvailabilityPromise,[\s\S]*attachmentAccessPromise,/, 'credit, message hydration, worker readiness, and attachment access must settle before task acceptance')
assert.ok(chatRoute.indexOf('if (access && !access.ok)') < chatRoute.indexOf('enqueueTaskJob({'), 'task access denial must happen before enqueue')
assert.ok(chatRoute.indexOf('if (unavailableWorker)') < chatRoute.indexOf('enqueueTaskJob({'), 'worker unavailability must fail before enqueue')
assert.ok(chatRoute.indexOf('findActiveTaskJobForConversation(userId, conversationId)') < chatRoute.indexOf('enqueueTaskJob({'), 'same-conversation active work must be rejected before enqueue')
assert.match(chatRoute, /CONVERSATION_TASK_ALREADY_RUNNING/, 'same-conversation starts need an explicit conflict contract')
assert.match(chatRoute, /acceptsLiveDirectives: !directChat/, 'in-process direct chat jobs must reject live directives')
assert.match(directiveRoute, /if \(!activeJob\.acceptsLiveDirectives\)/, 'the directive API must reject execution modes that cannot consume directives')
assert.match(liveDirectives, /agent_live_directive_seals/, 'completion must use a durable directive acceptance cutoff')
assert.match(liveDirectives, /terminal_status is null and cancel_requested = 0[\s\S]*status = 'running' and attempts = \?/, 'durable directive claims must be fenced by the current worker attempt')
assert.match(loop, /NON_REOPENABLE_LIVE_DIRECTIVE_TERMINAL_REASONS[\s\S]*safety_leakage[\s\S]*runtime_deadline/, 'safety and hard runtime stops must seal rather than reopen for a live directive')

assert.ok(runner.indexOf('await taskStartCreditPromise') < runner.indexOf('ensureE2BRemoteBrowser(conversationId)'), 'task-start charging must succeed before paid remote sandbox startup')
assert.ok(runner.indexOf('await taskStartCreditPromise') < runner.indexOf('await runDirectChat('), 'task-start charging must succeed before direct model work')
assert.match(runner, /billingAbortController[\s\S]*AbortSignal\.any\(\[[\s\S]*signal,[\s\S]*billingAbortController\.signal,[\s\S]*runtimeDeadlineAbortController\.signal/, 'active-credit failure must be able to abort the running task')
assert.match(runner, /activeCreditFailure \?\?= error[\s\S]*billingAbortController\.abort\(error\)[\s\S]*throw error/, 'active-credit persistence failures must fail closed and abort work')
assert.match(runner, /beforeDone: async \(\) => \{[\s\S]*await startupReadyPromise[\s\S]*await finalizeUsageBilling\(\)/, 'startup and all final usage charges must settle before a successful agent terminal event')
assert.doesNotMatch(loop, /Failed to record (?:planner|iteration) token usage; continuing task/, 'token ledger persistence failures must not be swallowed')
assert.match(runner, /runtimeDeadlineAbortController[\s\S]*runMaxDurationMs - deadlineHardStopBufferMs[\s\S]*AbortSignal\.any/, 'every task needs a hard runtime abort signal in addition to soft finalization')
assert.match(runner, /claimedWorkerAttempt === null[\s\S]*AGENT_RUN_MAX_DURATION_MS[\s\S]*AGENT_WORKER_RUN_MAX_DURATION_MS/, 'in-process requests must use the hosting-safe runtime instead of the long worker budget')
assert.match(runner, /startupReadyPromise = Promise\.all\(\[[\s\S]*remoteSandboxReadyPromise/, 'tool startup readiness must include E2B creation and browser bootstrap')
assert.match(runner, /await activeCreditPromise[\s\S]*await chargeActiveCredit\(\)/, 'cleanup must drain an in-flight active charge before the final charge')
assert.match(loop, /if \(signal\?\.aborted\) \{\s*return\s*\}/, 'AgentLoop must leave abort terminalization to its runner without closing the emitter first')
assert.match(loop, /planManager\.dispose\(\)/, 'AgentLoop must dispose planner work on every exit')
const autosaveRecovery = loop.match(/private async recoverTextOnlyDraft\([\s\S]*?private maybeStartDeadlineFinalization/)?.[0] || ''
assert.ok(autosaveRecovery.indexOf('result = await savePromise') < autosaveRecovery.indexOf('state.createdFiles.add(path)'), 'slow autosaves must finish before completion state is recorded')
assert.ok(autosaveRecovery.indexOf('persistSandboxTaskFile({') < autosaveRecovery.indexOf('artifactCreated({'), 'autosaved deliverables must reach durable storage before artifacts are announced')
assert.match(planner, /abortSignal: this\.plannerAbortController\?\.signal/, 'planner and acknowledgement calls must share the abortable lifecycle')
assert.match(pipeline, /abortPromise\?\.cleanup\(\)/, 'completed tools must remove their abort listeners')
assert.match(pipeline, /if \(!timeoutTriggered\) throw error[\s\S]*Promise\.race\(\[[\s\S]*toolPromise,[\s\S]*abortPromise\.promise/, 'timed-out tools must settle before retry while still allowing task cancellation to unwind')
assert.match(pipeline, /const nonIdempotentExecution = isNonIdempotentToolCall\(tc\.name, args\)[\s\S]*if \(nonIdempotentExecution\) \{[\s\S]*await this\.emitter\.flush\?\.\(\)[\s\S]*this\.throwIfAborted\(\)/, 'non-idempotent tools need a durable pre-action event boundary')
const imagePersistence = pipeline.match(/private async persistGeneratedTaskFile[\s\S]*?private async/)?.[0] || ''
assert.match(imagePersistence, /toolName === 'image_search'[\s\S]*persistSandboxTaskFile\([\s\S]*if \(!persisted\) \{[\s\S]*throw new Error/, 'downloaded images must be copied to durable storage before success')
assert.match(pipeline, /await this\.persistGeneratedTaskFile\(tc\.name, args, result\)[\s\S]*\/\/ Emit success only after any generated file is durably persisted\.[\s\S]*this\.emitter\.toolResult\(tc\.id, tc\.name, sanitizeToolResultForEvent/, 'file/image tool success must follow durable persistence')
assert.match(pipeline, /private durableImageUrl[\s\S]*\/api\/files\?conversationId=[\s\S]*&inline=1/, 'image artifacts must replay through durable authenticated files')
assert.match(emitterSource, /if \(this\._isClosed \|\| this\._terminalStatus\) return/, 'terminal SSE emission must be one-way')
assert.match(e2bSandbox, /e2bCreationPromises = new Map[\s\S]*existingCreation[\s\S]*e2bCreationPromises\.set\(safeId, creation\)/, 'E2B sandbox creation must be singleflight per task')
assert.match(e2bSandbox, /lifecycle_generation integer not null default 0[\s\S]*lifecycle_state text not null default 'active'/, 'E2B durable state must include a lifecycle generation and state fence')
assert.match(e2bSandbox, /async function claimPersistedSandboxCandidate[\s\S]*lifecycle_generation = agent_cloud_sandboxes\.lifecycle_generation \+ 1[\s\S]*lifecycle_state = 'active'[\s\S]*lifecycle_generation = \?/, 'E2B candidate publication must compare-and-swap the expected durable generation')
assert.match(e2bSandbox, /async function beginDurableLifecycle[\s\S]*set lifecycle_generation = \?[\s\S]*lifecycle_state = \?[\s\S]*lifecycle_source_generation = \?[\s\S]*and lifecycle_generation = \?/, 'E2B reset and destroy must first acquire a durable generation fence and retain the displaced billing owner')
assert.match(e2bSandbox, /async function finishDurableLifecycle[\s\S]*and lifecycle_generation = \?[\s\S]*and lifecycle_state = \?[\s\S]*E2BLifecycleSupersededError/, 'E2B lifecycle completion must only clear the exact fence it acquired')
assert.match(e2bSandbox, /async function commitSandboxCandidate[\s\S]*claimPersistedSandboxCandidate\([\s\S]*expectedDurableGeneration[\s\S]*if \(!claimed\)[\s\S]*discardSupersededSandbox/, 'E2B candidates that lose the durable CAS must be killed instead of cached')
assert.match(e2bSandbox, /async function takeOverDurableLifecycle[\s\S]*and lifecycle_generation = \?[\s\S]*and lifecycle_state = \?[\s\S]*if \(taken\.rowsAffected !== 1\) return null/, 'stale E2B lifecycle takeover must CAS the exact fence that timed out')
assert.match(e2bSandbox, /async function fenceObservedActiveSandbox[\s\S]*and provider_sandbox_id = \?[\s\S]*and lifecycle_generation = \?[\s\S]*and lifecycle_state = 'active'/, 'failed reconnect cleanup must fence the exact active sandbox generation before killing it')
assert.match(e2bSandbox, /create table if not exists agent_cloud_sandbox_orphans/, 'provider kill failures must remain durably quarantined across process restarts')
assert.match(e2bSandbox, /async function drainQuarantinedSandboxes[\s\S]*agent_cloud_sandbox_orphans[\s\S]*await killTrackedE2BSandbox/, 'durable orphan sandboxes must be killed before replacement creation')
assert.match(e2bSandbox, /export async function getOrCreateE2BSandbox[\s\S]*await drainQuarantinedSandboxes\(safeId\)[\s\S]*await waitForDurableLifecycle\(safeId\)/, 'E2B creation must drain durable orphan sandboxes before serving or creating a replacement')
assert.match(e2bSandbox, /export async function resetE2BSandbox[\s\S]*await drainQuarantinedSandboxes\(safeId\)[\s\S]*finishDurableLifecycle/, 'E2B reset must drain durable orphans before releasing its lifecycle fence')
assert.match(e2bSandbox, /export async function destroyE2BSandbox[\s\S]*await drainQuarantinedSandboxes\(safeId\)[\s\S]*finishDurableLifecycle/, 'E2B destroy must drain durable orphans before releasing its lifecycle fence')
assert.match(e2bSandbox, /async function transferPersistedSandboxOwnership[\s\S]*tursoTransaction\('write'[\s\S]*sourceConversationId[\s\S]*targetConversationId[\s\S]*released\.rowsAffected !== 1/, 'warm-pool adoption must transfer durable source and target ownership atomically')
assert.match(imageSearch, /writeSandboxFileBytes\(conversationId, filePath, new Uint8Array\(buffer\)\)/, 'image downloads must write through the local/remote sandbox abstraction')
assert.match(taskJobs, /async flush\(\): Promise<void> \{[\s\S]*flushPendingEventPersistence\(this\.job\)[\s\S]*await this\.job\.persistChain[\s\S]*TaskJobClaimLostError/, 'durable emitters must flush and ownership-fence pre-action events')
assert.match(taskJobs, /const \{ imageDataUrl: _inlineImage, \.\.\.durableArtifact \} = artifact/, 'persisted image artifacts must omit oversized inline data instead of storing a fake placeholder')
assert.match(taskJobs, /const runLocalPreTerminalBarrier = async \(\) => \{[\s\S]*inflightToolDrain\(TASK_JOB_INFLIGHT_DRAIN_TIMEOUT_MS\)[\s\S]*for \(const cleanup of preTerminalCleanups\) await cleanup\(\)[\s\S]*beforeFinalCommit: runLocalPreTerminalBarrier/, 'in-process destructive cleanup must drain tools and finish before terminal state is committed')
assert.match(taskJobs, /const establishTerminalExecutionFence = async \(\) => \{[\s\S]*const ownedBeforeCleanup = await refreshTaskJobClaim[\s\S]*for \(const cleanup of preTerminalCleanups\) await cleanup\(\)[\s\S]*const ownedAfterCleanup = await refreshTaskJobClaim[\s\S]*beforeFinalCommit: async \(\) => \{[\s\S]*await establishTerminalExecutionFence\(\)/, 'worker cleanup must be enclosed by durable ownership checks before terminal commit')
assert.match(taskJobs, /const runLocalPreTerminalBarrier = async \(\) => \{[\s\S]*await runCleanups\(\)[\s\S]*const finalDrain =[\s\S]*await runCleanups\(\)/, 'local cleanup must run again after a late in-flight tool settles')
assert.match(taskJobs, /const establishTerminalExecutionFence = async \(\) => \{[\s\S]*await runCleanups\(\)[\s\S]*const finalDrain =[\s\S]*await runCleanups\(\)/, 'worker cleanup must run again after a late in-flight tool settles')
assert.match(filesRoute, /searchParams\.get\('inline'\) === '1'/, 'durable image URLs need authenticated inline file responses')

const workDir = await mkdtemp(join(root, 'scripts/.agent-orchestration-lifecycle-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { SSEEmitter } from ${JSON.stringify(join(root, 'src/lib/agent/SSEEmitter.ts'))}
import { StreamProcessor } from ${JSON.stringify(join(root, 'src/lib/agent/StreamProcessor.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}

const encoded: Uint8Array[] = []
let closeCount = 0
const controller = {
  enqueue(chunk: Uint8Array) { encoded.push(chunk) },
  close() { closeCount += 1 },
} as unknown as ReadableStreamDefaultController<Uint8Array>
const sse = new SSEEmitter(controller, { keepAliveMs: 0 })
sse.textDelta('before')
sse.done()
sse.error('late error')
sse.textDelta('late text')
sse.done()
sse.close()
sse.close()

const wire = new TextDecoder().decode(Buffer.concat(encoded.map(chunk => Buffer.from(chunk))))
assert.equal((wire.match(/\"type\":\"done\"/g) || []).length, 1, 'done must emit once')
assert.equal((wire.match(/\"type\":\"error\"/g) || []).length, 0, 'error must not overwrite done')
assert.doesNotMatch(wire, /late text/, 'post-terminal text must be suppressed')
assert.equal(sse.terminalStatus, 'done')
assert.equal(closeCount, 1, 'close must be idempotent')

const timeouts = {
  iterationTimeoutMs: 10_000,
  inactivityTimeoutMs: 10_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 20,
}
const abortController = new AbortController()
const events: unknown[] = []
const fakeEmitter = {
  get isClosed() { return false },
  get terminalStatus() { return null },
  heartbeat() {}, textDelta(value: string) { events.push(value) }, progressUpdate(value: string) { events.push(value) }, reasoningDelta() {}, reasoningDone() {},
  toolStart() {}, toolResult() {}, browserFrame() {}, terminalOutput() {}, fileContentStart() {}, fileContentDelta() {},
  plan() {}, artifactCreated() {}, creditEvent() {}, stepAdvance() {}, done() {}, error() {}, close() {},
}
const state = createInitialState(false, timeouts)
const processor = new StreamProcessor(fakeEmitter as any, timeouts, abortController.signal)
async function* stalledStream() {
  yield { choices: [{ delta: { content: 'started' } }] }
  await new Promise(resolve => setTimeout(resolve, 500))
  yield { choices: [{ delta: { content: 'too late' } }] }
}
const startedAt = Date.now()
setTimeout(() => abortController.abort(), 25)
await assert.rejects(
  processor.processStream(stalledStream() as any, state),
  (error: any) => error?.name === 'AbortError',
)
assert.ok(Date.now() - startedAt < 500, 'stream processing must stop promptly on abort')
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['fsevents', 'playwright-core', 'chromium-bidi/*'],
    logLevel: 'silent',
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('agent orchestration lifecycle smoke checks passed')
