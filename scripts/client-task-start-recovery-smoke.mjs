import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const [client, serverSync, messageSlice] = await Promise.all([
  readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
  readFile(join(root, 'src/store/chat/serverSync.ts'), 'utf8'),
  readFile(join(root, 'src/store/chat/messageSlice.ts'), 'utf8'),
])

assert.match(
  messageSlice,
  /rollbackPendingTaskStart: \(convId, runId\) => \{[\s\S]*messages\.filter\(\(message\) => message\.pendingStartRunId !== runId\)/,
  'rejected starts must remove only their run-scoped optimistic messages',
)
assert.match(
  client,
  /function rollbackRejectedTaskStart[\s\S]*rollbackPendingTaskStart\(conversationId, runId\)[\s\S]*clearStoredActiveRun\(conversationId, runId\)/,
  'client rejection handling must roll back the provisional messages and run identity together',
)
assert.equal(
  (client.match(/if \(!isTaskStartRejectedError\(error\)\) \{/g) || []).length,
  2,
  'both start catches must avoid writing a rejection into the previous assistant',
)
assert.match(
  client,
  /async function rebaseToConflictingTaskRun[\s\S]*waitForKnownTaskRun\([\s\S]*input\.conflictRunId[\s\S]*\{ persist: false \}[\s\S]*rebaseConversationFromServerForRun\([\s\S]*assistantMessageForRun\(input\.conversationId, input\.conflictRunId\)/,
  'different-run conflicts must prove exact-run visibility before attaching to its committed assistant',
)
assert.match(
  serverSync,
  /export async function rebaseConversationFromServerForRun\([\s\S]*for \(const delayMs of TASK_RUN_REBASE_RETRY_DELAYS_MS\)[\s\S]*conversationContainsRun\(conversation, runId\)[\s\S]*conversation\.serverRevision \|\| 0\) < \(existing\.serverRevision \|\| 0\)[\s\S]*mergeCanonicalRunRebase\(conversation, existing, runId\)/,
  'canonical rebase must retry lagging reads, require the exact run, reject older revisions, and merge monotonic progress',
)
assert.match(
  serverSync,
  /function mergeCanonicalRunRebase[\s\S]*localAssistantHasStrictlyNewerCursor[\s\S]*localAssistantHasMonotonicTerminalState[\s\S]*streamTerminalStatus: serverMessage\.streamTerminalStatus \|\| durableLocalMessage\.streamTerminalStatus/,
  'same-run cursor recovery must never regress either local progress or a canonical terminal marker',
)
assert.match(
  client,
  /hasPendingTaskStartMarkers\(conversationId, stoppedRunId\)[\s\S]*rebaseConversationFromServerForRun\(conversationId, stoppedRunId\)[\s\S]*if \(!terminalStartCommitted\) rollbackRejectedTaskStart/,
  'a cancellation tombstone must not promote optimistic messages without canonical run proof',
)
assert.match(
  client,
  /interface StopTaskResponse[\s\S]*terminalError\?: unknown[\s\S]*const terminalWarning =[\s\S]*Task stopped with a recovery warning[\s\S]*setStreamError\(terminalWarning\)/,
  'the stop UI must preserve a forced-recovery uncertainty warning returned by the durable terminal row',
)
const conflictStartSections = client.split('const conflictRunId = errorBody.runId').slice(1)
assert.equal(conflictStartSections.length, 2, 'both task-start paths must implement conflict replay')
for (const [index, section] of conflictStartSections.entries()) {
  const openExactRun = section.indexOf('const replayResponse = await openKnownTaskRunStream({')
  const acceptOptimisticMessages = section.indexOf('acceptPendingTaskStart(conversationId, requestedRunId)')
  assert.ok(openExactRun >= 0, `conflict path ${index + 1} must wait for exact-run visibility`)
  assert.ok(
    acceptOptimisticMessages > openExactRun,
    `conflict path ${index + 1} must not accept optimistic messages before exact-run visibility`,
  )
}
const stableStartSections = client.split('const requestedRunId = uuidv4()').slice(1)
assert.equal(stableStartSections.length, 2, 'both task-start paths must mint one stable run id')
for (const [index, section] of stableStartSections.entries()) {
  assert.match(
    section,
    /response\.status === 402[\s\S]*rollbackRejectedTaskStart\(conversationId, requestedRunId\)[\s\S]*throw taskStartRejectedError/,
    `start path ${index + 1} must roll back a definitive credit rejection`,
  )
  assert.match(
    section,
    /rollbackRejectedTaskStart\(conversationId, requestedRunId\)[\s\S]*throw taskStartRejectedError\(errorBody\?\.error \?\? errorBody, 'The task could not start/,
    `start path ${index + 1} must roll back generic non-acceptance`,
  )
  assert.match(
    section,
    /if \(responseRunId !== requestedRunId\) \{[\s\S]*rollbackRejectedTaskStart\(conversationId, requestedRunId\)[\s\S]*throw taskStartRejectedError/,
    `start path ${index + 1} must not durably promote a mismatched start response`,
  )
}

const workDir = await mkdtemp(join(root, 'scripts/.client-task-start-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { createMessageSlice } from ${JSON.stringify(join(root, 'src/store/chat/messageSlice.ts'))}

let store: any = {
  activeId: 'conversation',
  folders: [],
  conversations: [{
    id: 'conversation',
    title: 'Rollback',
    starred: false,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'durable', role: 'assistant', content: 'Keep me', timestamp: 1 },
      { id: 'rejected-user', role: 'user', content: 'Remove me', timestamp: 2, pendingStartRunId: 'rejected-run' },
      { id: 'rejected-assistant', role: 'assistant', content: '', timestamp: 3, pendingStartRunId: 'rejected-run' },
      { id: 'other-run', role: 'assistant', content: '', timestamp: 4, pendingStartRunId: 'other-run' },
    ],
  }],
}
const set = (partial: any) => {
  const update = typeof partial === 'function' ? partial(store) : partial
  store = { ...store, ...update }
}
const actions = createMessageSlice(set, () => store)
actions.rollbackPendingTaskStart('conversation', 'rejected-run')
assert.deepEqual(
  store.conversations[0].messages.map((message: any) => message.id),
  ['durable', 'other-run'],
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
    alias: { '@': join(root, 'src') },
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('client task-start recovery smoke checks passed')
