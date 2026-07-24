import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

const [
  schemas,
  client,
  chatRoute,
  activeRoute,
  taskJobs,
  worker,
  agentLoop,
  chatPage,
  serverSync,
  conversations,
  messageSlice,
  latencyProbe,
] = await Promise.all([
  readFile(join(root, 'src/lib/validation/schemas.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/active/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
  readFile(join(root, 'src/worker/taskWorker.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
  readFile(join(root, 'src/store/chat/serverSync.ts'), 'utf8'),
  readFile(join(root, 'src/lib/conversations.ts'), 'utf8'),
  readFile(join(root, 'src/store/chat/messageSlice.ts'), 'utf8'),
  readFile(join(root, 'scripts/prod-chat-latency-probe.mjs'), 'utf8'),
])

function sourceSection(source, start, end, description) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing ${description} start marker`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing ${description} end marker`)
  return source.slice(startIndex, endIndex)
}

assert.match(
  schemas,
  /export const ChatRequestSchema = z\.object\(\{[\s\S]*?runId: z\.string\(\)\.uuid\(\),/,
  'task starts must require a UUID run id instead of accepting a server-generated fallback',
)
assert.match(
  latencyProbe,
  /runId = randomUUID\(\)[\s\S]*const body = \{[\s\S]*runId,[\s\S]*fetch\(`\$\{baseUrl\}\/api\/chat`/,
  'the production latency probe must use the same client-owned UUID task-start contract as the app',
)

const stablePostHelper = sourceSection(
  client,
  'async function postTaskStartWithStableRunId(',
  'interface ActiveRunRecord',
  'stable task-start transport helper',
)
assert.match(
  stablePostHelper,
  /for \(const delayMs of TASK_START_POST_RETRY_DELAYS_MS\)[\s\S]*fetch\('\/api\/chat', \{[\s\S]*method: 'POST'[\s\S]*body: JSON\.stringify\(body\)[\s\S]*signal,/,
  'all task-start transport retries must reuse the same immutable request body and abort signal',
)
assert.equal(
  (client.match(/fetch\('\/api\/chat',\s*\{[\s\S]{0,180}?method: 'POST'/g) || []).length,
  1,
  'client task starts must share one POST implementation so retry behavior cannot diverge',
)
assert.match(
  client,
  /function markAssistantStreamTerminal[\s\S]*streamTerminalStatus: status[\s\S]*if \(event\.type === 'done' \|\| event\.type === 'error'\)[\s\S]*markAssistantStreamTerminal/,
  'durable message cursors must record when their terminal event has been observed',
)
assert.match(
  chatPage,
  /latestMessage\?\.role === 'assistant'[\s\S]*!!latestMessage\.streamRunId[\s\S]*!latestMessage\.streamTerminalStatus/,
  'a reopened partial assistant stream must request terminal replay until its terminal marker is persisted',
)
assert.equal(
  (client.match(/pendingStartRunId: requestedRunId/g) || []).length,
  3,
  'both optimistic assistants and the normal-send user turn must remain local-only until start acceptance',
)
assert.match(
  serverSync,
  /messages: conversation\.messages\.filter\(\(message\) => !message\.pendingStartRunId\)/,
  'generic sync must omit optimistic task-start messages before acceptance',
)
assert.doesNotMatch(
  conversations.match(/export function mergeConversationForRevisionConflict[\s\S]*?\n\}/)?.[0] || '',
  /messages\.push\(message\)/,
  'a stale revision must rebase unknown ids instead of durably appending rejected optimistic turns',
)
assert.match(
  client,
  /async function rebaseToConflictingTaskRun[\s\S]*waitForKnownTaskRun\([\s\S]*input\.conflictRunId[\s\S]*\{ persist: false \}[\s\S]*rebaseConversationFromServerForRun\([\s\S]*input\.conflictRunId[\s\S]*assistantMessageForRun\(input\.conversationId, input\.conflictRunId\)/,
  'a different-run conflict must wait for the exact run, rebase canonical history, and attach only to its committed assistant',
)
assert.match(
  messageSlice,
  /rollbackPendingTaskStart: \(convId, runId\) => \{[\s\S]*messages\.filter\(\(message\) => message\.pendingStartRunId !== runId\)/,
  'definitively rejected starts must remove their run-scoped optimistic messages',
)
assert.match(
  client,
  /function rollbackRejectedTaskStart[\s\S]*rollbackPendingTaskStart\(conversationId, runId\)[\s\S]*clearStoredActiveRun\(conversationId, runId\)/,
  'client rejection handling must roll back optimistic messages and only its provisional run identity',
)
assert.equal(
  (client.match(/if \(!isTaskStartRejectedError\(error\)\) \{/g) || []).length,
  2,
  'both outer start catches must avoid finalizing a previous assistant after rollback',
)
assert.match(
  serverSync,
  /export async function rebaseConversationFromServerForRun\([\s\S]*for \(const delayMs of TASK_RUN_REBASE_RETRY_DELAYS_MS\)[\s\S]*conversationContainsRun\(conversation, runId\)[\s\S]*conversation\.serverRevision \|\| 0\) < \(existing\.serverRevision \|\| 0\)[\s\S]*mergeCanonicalRunRebase\(conversation, existing, runId\)/,
  'canonical conflict recovery must retry replica reads, require the exact run, reject older revisions, and preserve monotonic progress',
)
assert.match(
  client,
  /hasPendingTaskStartMarkers\(conversationId, stoppedRunId\)[\s\S]*rebaseConversationFromServerForRun\(conversationId, stoppedRunId\)[\s\S]*if \(!terminalStartCommitted\) rollbackRejectedTaskStart/,
  'a pre-start cancellation tombstone must prove the run reached canonical history before accepting optimistic messages',
)
assert.match(
  messageSlice,
  /streamTerminalStatus: message\.streamRunId === runId[\s\S]*\? message\.streamTerminalStatus[\s\S]*: undefined/,
  'switching an assistant cursor to another run must clear stale terminal proof',
)

const taskStartCalls = [...client.matchAll(
  /response = await postTaskStartWithStableRunId\(\{([\s\S]*?)\}, controller\.signal\)/g,
)]
assert.equal(taskStartCalls.length, 2, 'initial auto-start and normal send must both use the stable task-start transport')
for (const [index, call] of taskStartCalls.entries()) {
  assert.match(call[1], /runId: requestedRunId,/, `task-start call ${index + 1} must send its stable client run id`)
  assert.match(call[1], /assistantMessageId: assistantMsg\.id,/, `task-start call ${index + 1} must send its stable assistant message id`)
}
assert.equal(
  (client.match(/const requestedRunId = uuidv4\(\)/g) || []).length,
  2,
  'each distinct user start action must mint exactly one run id before transport retries',
)

const clientStartFragments = client.split('const requestedRunId = uuidv4()').slice(1)
assert.equal(clientStartFragments.length, 2, 'both client task-start paths must expose a stable-run fragment')
for (const [index, fragment] of clientStartFragments.entries()) {
  const throughRecovery = fragment.slice(0, fragment.indexOf('startRequestsAwaitingHeaders.delete(conversationId)', fragment.indexOf('catch (postError)')) + 1_200)
  assert.match(
    throughRecovery,
    /saveStoredActiveRun\(conversationId, \{[\s\S]*runId: requestedRunId,[\s\S]*assistantMessageId: assistantMsg\.id,[\s\S]*status: 'starting'/,
    `task-start path ${index + 1} must persist both identities before sending`,
  )
  assert.match(
    throughRecovery,
    /catch \(postError\)[\s\S]*openKnownTaskRunStream\(\{[\s\S]*conversationId,[\s\S]*runId: requestedRunId/,
    `task-start path ${index + 1} must recover an ambiguous POST using the exact same run id`,
  )
}

const postRoute = chatRoute.slice(chatRoute.indexOf('export async function POST'))
const firstExactRunLookup = postRoute.indexOf('findTaskJobForRun(userId, conversationId, creditRunId)')
const creditGate = postRoute.indexOf('assertServerCreditsAvailable(userId)')
assert.ok(firstExactRunLookup >= 0, 'POST must perform an exact idempotency lookup')
assert.ok(creditGate >= 0, 'POST must retain its credit availability gate')
assert.ok(
  firstExactRunLookup < creditGate,
  'an already-accepted exact run must reconnect before credits or worker readiness can reject its retry',
)
assert.match(
  postRoute.slice(firstExactRunLookup, creditGate),
  /TASK_RUN_ALREADY_EXISTS[\s\S]*runId: acceptedRun\.runId[\s\S]*terminal:/,
  'the early exact-run lookup must return enough identity and terminal state for deterministic replay',
)

const reservation = sourceSection(
  chatRoute,
  'function conversationStartReservations()',
  'function envPositiveInt(',
  'same-isolate conversation reservation',
)
assert.match(reservation, /Map<string, string>/, 'same-isolate reservations must retain the accepted run identity')
assert.match(
  reservation,
  /const existingRunId = reservations\.get\(key\)[\s\S]*if \(existingRunId\) return \{ existingRunId \}[\s\S]*reservations\.set\(key, runId\)/,
  'a concurrent same-isolate start must return the exact run already being admitted',
)
assert.match(
  postRoute,
  /const startReservation = reserveConversationStart\(userId, conversationId, creditRunId\)[\s\S]*if \(!startReservation\.release\) \{[\s\S]*runId: startReservation\.existingRunId,[\s\S]*status: 'starting'/,
  'the reservation conflict response must expose the existing run id for client replay',
)

const taskStartPersistence = sourceSection(
  chatRoute,
  'async function prepareConversationForTaskStartInsert(',
  'function routeTimingsHeaderValue(',
  'task-start conversation persistence helper',
)
assert.match(
  taskStartPersistence,
  /persistableMessages\.push\(\{[\s\S]*id: input\.assistantMessageId \|\| randomUUID\(\),[\s\S]*streamRunId: input\.runId,[\s\S]*streamSeq: 0,[\s\S]*role: 'assistant',[\s\S]*content: '',[\s\S]*\}\)/,
  'accepted task history must atomically include its blank assistant and initial stream cursor',
)
assert.match(
  postRoute,
  /prepareConversationForTaskStartInsert\(\{[\s\S]*runId: creditRunId,[\s\S]*assistantMessageId: validation\.data\.assistantMessageId/,
  'server persistence must preserve the assistant identity supplied with the stable run',
)

const exactLookup = sourceSection(
  taskJobs,
  'export async function findTaskJobForRun(',
  'export async function findActiveTaskJobForUser(',
  'exact task-run lookup',
)
assert.match(
  exactLookup,
  /taskJobState\.jobs\.get\(runId\)[\s\S]*inMemory\.userId === userId[\s\S]*inMemory\.conversationId === conversationId[\s\S]*inMemory\.queueName === queueName/,
  'in-memory exact-run lookup must enforce owner, conversation, and queue scope',
)
assert.match(
  exactLookup,
  /where user_id = \?[\s\S]*and conversation_id = \?[\s\S]*and run_id = \?[\s\S]*and queue_name = \?[\s\S]*\[userId, conversationId, runId, queueName\]/,
  'durable exact-run lookup must enforce owner, conversation, run, and queue scope',
)
assert.match(
  activeRoute,
  /const exactJob = requestedRunId[\s\S]*findTaskJobForRun\(userId, conversationId, requestedRunId\)[\s\S]*if \(requestedRunId\) \{[\s\S]*runId: exactJob\.runId/,
  'active-run recovery with a requested id must use the exact lookup rather than the newest conversation run',
)
assert.ok(
  activeRoute.indexOf('if (requestedRunId) {') < activeRoute.indexOf('findActiveTaskJobForConversation(userId, conversationId)'),
  'exact active lookup must return before the conversation-wide fallback is considered',
)

assert.match(
  worker,
  /const hardTaskExitMs = finitePositiveInt\([\s\S]*AGENT_WORKER_RUN_MAX_DURATION_MS \+ DEFAULT_WORKER_HARD_EXIT_GRACE_MS/,
  'the external process watchdog must default beyond the cooperative worker runtime deadline',
)
const watchdog = sourceSection(
  worker,
  '// Abort signals are cooperative;',
  "if (taskResult === 'requeued')",
  'claimed-task hard process watchdog',
)
const watchdogArm = watchdog.indexOf('const hardExitTimer = setTimeout(')
const claimedRun = watchdog.indexOf('taskResult = await runClaimedTaskJob(')
const watchdogClear = watchdog.indexOf('clearTimeout(hardExitTimer)')
assert.ok(watchdogArm >= 0 && claimedRun >= 0 && watchdogClear >= 0, 'claimed tasks must arm, run beneath, and clear a hard watchdog')
assert.ok(watchdogArm < claimedRun && claimedRun < watchdogClear, 'the watchdog must enclose the entire claimed task execution')
assert.match(
  watchdog.slice(watchdogArm, claimedRun),
  /Hard task deadline exceeded; terminating process for fenced recovery[\s\S]*process\.exit\(1\)[\s\S]*hardTaskExitMs/,
  'an ignored cooperative abort must terminate the worker process for fenced recovery',
)
assert.match(
  watchdog,
  /try \{[\s\S]*taskResult = await runClaimedTaskJob\([\s\S]*\} finally \{[\s\S]*clearTimeout\(hardExitTimer\)/,
  'normally settled tasks must always disarm their hard process watchdog',
)
assert.match(
  worker,
  /void sendHeartbeat\('stopping'\)[\s\S]*Cancellation deadline exceeded; terminating process to stop late side effects[\s\S]*process\.exit\(1\)/,
  'the sole claimed worker must hard-exit when a cancellation-ignoring runner exceeds its short grace period',
)
assert.match(
  worker,
  /onCancellationObserved: armCancellationHardExit/,
  'claimed-task cancellation observation must arm the worker hard-exit callback',
)
assert.match(
  taskJobs,
  /controlState === 'cancelled'[\s\S]*job\.abortController\.abort\(\)[\s\S]*options\.onCancellationObserved\?\.\(\)/,
  'worker cancellation polling must arm the process-level escalation when it observes the durable stop',
)
assert.doesNotMatch(
  taskJobs,
  /process\.exit\(/,
  'taskJobs must never terminate the shared web process while cancelling in-process work',
)
assert.match(
  taskJobs,
  /when cancel_requested = 1 and worker_id like 'in-process:%'[\s\S]*then max\(coalesce\(lease_expires_at_ms, \?\), \?\)/,
  'in-process cancellation must keep extending its exact claim while cooperative cleanup is still running',
)
assert.match(
  taskJobs,
  /select status, current_run_id, last_seen_at_ms, heartbeat_ms[\s\S]*worker\.current_run_id === runId[\s\S]*cancellationWorkerHeartbeatProofWindowMs/,
  'cross-instance forced cancellation must wait for hard-stop evidence from the exact worker boot and run heartbeat',
)

const supersededTools = sourceSection(
  agentLoop,
  "case 'EXECUTING_TOOLS': {",
  'if (!startupReadyAwaited',
  'live-directive superseded provisional tools',
)
assert.match(
  supersededTools,
  /if \(await injectRunLiveDirectives\(\)\) \{[\s\S]*for \(const toolCall of lastStreamResult\.toolCalls\.values\(\)\) \{[\s\S]*if \(!toolCall\.provisionalStartEmitted\) continue/,
  'a live directive must reconcile every provisional tool start it supersedes',
)
assert.match(
  supersededTools,
  /this\.emitter\.toolResult\(toolCall\.id, toolCall\.name, \{[\s\S]*superseded: true,[\s\S]*Superseded by a newer live instruction before execution/,
  'each abandoned provisional start must receive a durable superseded result',
)
assert.match(
  supersededTools,
  /state\.visibleNarrationToolStartIds\.delete\(toolCall\.id\)[\s\S]*state\.visibleToolActionsSinceLastNarration = Math\.max\([\s\S]*state\.visibleToolActionsSinceLastNarration - 1/,
  'superseded visible starts must also be removed from narration accounting',
)
assert.match(
  supersededTools,
  /Live user directive superseded pending tool calls[\s\S]*phase = 'STREAMING'[\s\S]*break/,
  'the loop may resume streaming only after provisional tool reconciliation finishes',
)

const workDir = await mkdtemp(join(root, 'scripts/.task-start-protocol-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { ChatRequestSchema } from ${JSON.stringify(join(root, 'src/lib/validation/schemas.ts'))}
import { createMessageSlice } from ${JSON.stringify(join(root, 'src/store/chat/messageSlice.ts'))}

const validRunId = '2e48f52b-23d4-4a80-ae0b-f9bd84e337e5'
const validAssistantMessageId = 'fa993d46-151c-4c4d-a6d9-0508d050e305'
const baseRequest = {
  conversationId: 'task-start-protocol-smoke',
  messages: [{ role: 'user', content: 'Start this task exactly once.' }],
}

assert.equal(
  ChatRequestSchema.safeParse(baseRequest).success,
  false,
  'a start without a client run id must fail validation',
)
assert.equal(
  ChatRequestSchema.safeParse({ ...baseRequest, runId: 'not-a-uuid' }).success,
  false,
  'an opaque but non-UUID run id must fail validation',
)
const parsed = ChatRequestSchema.safeParse({
  ...baseRequest,
  runId: validRunId,
  assistantMessageId: validAssistantMessageId,
})
assert.equal(parsed.success, true, 'a stable UUID run and assistant identity must validate')
if (!parsed.success) throw new Error('unreachable')
assert.equal(parsed.data.runId, validRunId, 'validation must preserve the exact client run id')
assert.equal(parsed.data.assistantMessageId, validAssistantMessageId, 'validation must preserve the exact assistant id')

let store = {
  activeId: 'rollback-conversation',
  folders: [],
  conversations: [{
    id: 'rollback-conversation',
    title: 'Rollback test',
    starred: false,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'durable', role: 'assistant', content: 'Keep me', timestamp: 1 },
      { id: 'rejected-user', role: 'user', content: 'Remove me', timestamp: 2, pendingStartRunId: 'rejected-run' },
      { id: 'rejected-assistant', role: 'assistant', content: '', timestamp: 3, pendingStartRunId: 'rejected-run' },
      { id: 'other-pending', role: 'assistant', content: '', timestamp: 4, pendingStartRunId: 'other-run' },
    ],
  }],
}
const set = (partial) => {
  const update = typeof partial === 'function' ? partial(store) : partial
  store = { ...store, ...update }
}
const messageActions = createMessageSlice(set, () => store)
messageActions.rollbackPendingTaskStart('rollback-conversation', 'rejected-run')
assert.deepEqual(
  store.conversations[0].messages.map((message) => message.id),
  ['durable', 'other-pending'],
  'rollback must remove only the rejected run pair and leave durable or unrelated messages untouched',
)
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    logLevel: 'silent',
    alias: {
      '@': join(root, 'src'),
    },
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('task-start protocol smoke checks passed')
