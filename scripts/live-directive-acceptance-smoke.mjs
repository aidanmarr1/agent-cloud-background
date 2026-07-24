#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
process.env.AGENT_TASK_QUEUE_NAME = `live-directive-acceptance-${Date.now()}`

const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { '@': srcPath } })
const {
  clearLiveDirectivesForTest,
  clearLiveDirectivesForRun,
  drainLiveDirectives,
  enqueueLiveDirective,
  getLiveDirectiveQueueLength,
  getLiveDirectiveReceipt,
  liveDirectiveContinuationMessageId,
  sealLiveDirectiveRun,
} = await jiti.import(fileURLToPath(new URL('../src/lib/liveDirectives.ts', import.meta.url)))
const {
  appendRejectedLiveDirectiveOutcomeToConversation,
  appendAcceptedLiveDirectiveToConversation,
  mergeConversationWithDurableLiveDirectives,
  mergeConversationWithMonotonicAssistantState,
  mergeConversationForRevisionConflict,
  mergeConversationMessagesForTaskStart,
  taskStartMessageFallbackId,
} = await jiti.import(fileURLToPath(new URL('../src/lib/conversations.ts', import.meta.url)))
const {
  mergeSyncAcknowledgement,
} = await jiti.import(fileURLToPath(new URL('../src/store/chat/serverSync.ts', import.meta.url)))
const {
  normalizeConversationForPersistence,
} = await jiti.import(fileURLToPath(new URL('../src/lib/conversationSerialization.ts', import.meta.url)))

await clearLiveDirectivesForTest()

const continuationId = liveDirectiveContinuationMessageId('d9b52c84-cda7-43cc-8d65-5c61fd10d92c')
assert.match(
  continuationId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'directive continuations must use deterministic schema-valid UUID message ids',
)
assert.equal(
  continuationId,
  liveDirectiveContinuationMessageId('d9b52c84-cda7-43cc-8d65-5c61fd10d92c'),
  'directive continuation ids must remain stable across retries',
)

const originalConversation = {
  id: 'directive-history',
  title: 'Directive history',
  starred: false,
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: 'user-1', role: 'user', content: 'Start', timestamp: 1 },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Working',
      timestamp: 2,
      streamRunId: 'run-directive-history',
      streamSeq: 7,
      steps: [{ id: 'step-1', title: 'Work', status: 'running' }],
      artifacts: [],
      computerPanelData: [],
    },
  ],
}
const persistedConversation = appendAcceptedLiveDirectiveToConversation(originalConversation, {
  directiveId: 'directive-history-id',
  continuationMessageId: 'directive-history-id_continuation',
  content: 'Change direction',
  createdAt: 3,
})
assert.deepEqual(
  persistedConversation.messages.map((message) => [message.id, message.role, message.content]),
  [
    ['user-1', 'user', 'Start'],
    ['assistant-1', 'assistant', 'Working'],
    ['directive-history-id', 'user', 'Change direction'],
    ['directive-history-id_continuation', 'assistant', ''],
  ],
  'accepted instructions must be recoverable in conversation history with deterministic ids',
)
assert.equal(persistedConversation.messages[1].steps.length, 0, 'the previous assistant segment must release active progress UI')
assert.equal(persistedConversation.messages[3].steps.length, 1, 'the continuation must inherit active progress UI')
assert.equal(persistedConversation.messages[1].streamRunId, undefined, 'the split predecessor must release its replay cursor')
assert.equal(persistedConversation.messages[3].streamRunId, 'run-directive-history', 'the continuation must inherit the replay run')
assert.equal(persistedConversation.messages[3].streamSeq, 7, 'the continuation must inherit the replay cursor')
assert.deepEqual(
  persistedConversation.messages.slice(2).map((message) => [
    message.liveDirective?.directiveId,
    message.liveDirective?.part,
  ]),
  [
    ['directive-history-id', 'instruction'],
    ['directive-history-id', 'continuation'],
  ],
  'accepted directive messages must carry durable server markers',
)
assert.strictEqual(
  appendAcceptedLiveDirectiveToConversation(persistedConversation, {
    directiveId: 'directive-history-id',
    continuationMessageId: 'directive-history-id_continuation',
    content: 'Change direction',
    createdAt: 3,
  }),
  persistedConversation,
  'conversation persistence must be idempotent for the same directive id and content',
)

const userEndedConversation = {
  ...originalConversation,
  id: 'directive-user-ended-history',
  messages: [
    ...originalConversation.messages,
    { id: 'current-user', role: 'user', content: 'Follow up', timestamp: 3 },
  ],
}
const userEndedPersisted = appendAcceptedLiveDirectiveToConversation(userEndedConversation, {
  directiveId: 'directive-after-current-user',
  continuationMessageId: 'directive-after-current-user_continuation',
  content: 'Change the follow-up',
  createdAt: 4,
})
assert.deepEqual(
  userEndedPersisted.messages.map((message) => message.id),
  [
    'user-1',
    'assistant-1',
    'current-user',
    'directive-after-current-user',
    'directive-after-current-user_continuation',
  ],
  'a body ending in the current user message must append the directive instead of splitting an older assistant',
)
assert.equal(
  userEndedPersisted.messages[1].steps.length,
  1,
  'an older assistant must keep its completed UI state when the final message is a user',
)
assert.equal(
  userEndedPersisted.messages[1].streamSeq,
  7,
  'an older assistant must keep its cursor when no final-assistant split occurs',
)

const staleFullSnapshot = {
  ...persistedConversation,
  updatedAt: persistedConversation.updatedAt + 1_000,
  messages: [
    persistedConversation.messages[0],
    {
      ...persistedConversation.messages[1],
      content: 'Client-rich progress',
      reasoning: 'Still working through the details',
      streamRunId: 'run-directive-history',
      streamSeq: 8,
      steps: [{ id: 'step-1', title: 'Work', status: 'running' }],
      artifacts: [{ id: 'artifact-1', type: 'code', title: 'Draft', content: 'draft' }],
      followUps: [{ id: 'follow-up-1', label: 'Continue', prompt: 'Continue' }],
    },
    { id: 'newer-user', role: 'user', content: 'A later message', timestamp: 20 },
  ],
}
const mergedStaleSnapshot = mergeConversationWithDurableLiveDirectives(
  persistedConversation,
  staleFullSnapshot,
)
assert.deepEqual(
  mergedStaleSnapshot.messages.map((message) => message.id),
  [
    'user-1',
    'assistant-1',
    'directive-history-id',
    'directive-history-id_continuation',
    'newer-user',
  ],
  'a newer full-body sync must restore omitted durable directive messages in server order',
)
assert.equal(
  mergedStaleSnapshot.messages[1].content,
  'Client-rich progress',
  'ordinary client-rich streaming state must survive the directive reconciliation',
)
assert.equal(
  mergedStaleSnapshot.messages[1].reasoning,
  'Still working through the details',
  'splitting stale active UI must preserve predecessor text and reasoning',
)
assert.equal(
  mergedStaleSnapshot.messages[1].steps.length,
  0,
  'a stale predecessor must release active progress UI when the continuation is reinserted',
)
assert.equal(
  mergedStaleSnapshot.messages[3].steps.length,
  1,
  'the durable continuation must inherit the stale tab\'s richer active progress UI',
)
assert.equal(
  mergedStaleSnapshot.messages[3].artifacts.length,
  1,
  'continuation reconciliation must preserve client-rich artifacts',
)
assert.equal(mergedStaleSnapshot.messages[1].streamSeq, undefined, 'the reconciled predecessor must release its cursor')
assert.equal(mergedStaleSnapshot.messages[3].streamSeq, 8, 'the reconciled continuation must inherit the newer cursor')
assert.equal(
  mergedStaleSnapshot.messages[1].followUps,
  undefined,
  'the stale predecessor must not remain a second active UI owner',
)
assert.ok(
  mergedStaleSnapshot.updatedAt > staleFullSnapshot.updatedAt,
  'a reconciled body must advance the server timestamp so the stale uploader reloads it',
)

const rejectedConversation = appendRejectedLiveDirectiveOutcomeToConversation(
  persistedConversation,
  'directive-history-id',
  'directive-history-id_continuation',
  persistedConversation.updatedAt + 2_000,
)
const stalePendingSnapshot = {
  ...rejectedConversation,
  updatedAt: rejectedConversation.updatedAt + 1_000,
  messages: persistedConversation.messages.map((message) => ({ ...message })),
}
const mergedRejectedSnapshot = mergeConversationWithDurableLiveDirectives(
  rejectedConversation,
  stalePendingSnapshot,
)
const durableRejection = mergedRejectedSnapshot.messages.find((message) => (
  message.id === 'directive-history-id_continuation'
))
assert.match(
  durableRejection?.content || '',
  /task finished before it could be delivered/,
  'a stale pending continuation must not erase the durable rejection outcome',
)
assert.equal(
  durableRejection?.liveDirective?.outcome,
  'rejected',
  'the terminal rejection marker must remain authoritative during full-body sync',
)
const mergedOmittedRejectedSnapshot = mergeConversationWithDurableLiveDirectives(
  rejectedConversation,
  {
    ...staleFullSnapshot,
    updatedAt: rejectedConversation.updatedAt + 2_000,
  },
)
const omittedPairRejection = mergedOmittedRejectedSnapshot.messages.find((message) => (
  message.id === 'directive-history-id_continuation'
))
assert.equal(
  omittedPairRejection?.steps?.length,
  1,
  'rejection must preserve the task progress inherited by the durable continuation',
)
assert.equal(omittedPairRejection?.streamSeq, 7, 'rejection must preserve the continuation replay cursor')

const generatedBeforeRejection = {
  ...persistedConversation,
  messages: persistedConversation.messages.map((message) => (
    message.id === 'directive-history-id_continuation'
      ? { ...message, content: 'Work completed before the pending instruction was drained.' }
      : message
  )),
}
const generatedRejection = appendRejectedLiveDirectiveOutcomeToConversation(
  generatedBeforeRejection,
  'directive-history-id',
  'directive-history-id_continuation',
  generatedBeforeRejection.updatedAt + 4_000,
)
const generatedRejectionContinuation = generatedRejection.messages.find((message) => (
  message.id === 'directive-history-id_continuation'
))
assert.match(generatedRejectionContinuation?.content || '', /Work completed before/, 'rejection must preserve generated assistant content')
assert.match(generatedRejectionContinuation?.content || '', /task finished before it could be delivered/, 'rejection must append a visible terminal outcome')

const storedOrdinaryConversation = {
  id: 'ordinary-monotonic-history',
  title: 'Original title',
  starred: false,
  folder: 'Original folder',
  createdAt: 1,
  updatedAt: 100,
  messages: [
    { id: 'ordinary-user', role: 'user', content: 'Start', timestamp: 1 },
    {
      id: 'ordinary-assistant',
      role: 'assistant',
      content: 'Complete canonical answer',
      timestamp: 2,
      streamRunId: 'ordinary-run',
      streamSeq: 20,
      steps: [{ id: 'ordinary-step', title: 'Done', status: 'completed' }],
    },
  ],
}
const staleOrdinarySnapshot = {
  ...storedOrdinaryConversation,
  title: 'Legitimate renamed task',
  starred: true,
  folder: 'New folder',
  updatedAt: 10_000,
  messages: [
    storedOrdinaryConversation.messages[0],
    {
      ...storedOrdinaryConversation.messages[1],
      content: 'Partial answer',
      streamSeq: 8,
      steps: [],
      pinned: true,
    },
  ],
}
const monotonicOrdinaryMerge = mergeConversationWithMonotonicAssistantState(
  storedOrdinaryConversation,
  staleOrdinarySnapshot,
)
assert.equal(monotonicOrdinaryMerge.title, 'Legitimate renamed task', 'assistant reconciliation must preserve title edits')
assert.equal(monotonicOrdinaryMerge.starred, true, 'assistant reconciliation must preserve starred metadata')
assert.equal(monotonicOrdinaryMerge.folder, 'New folder', 'assistant reconciliation must preserve folder metadata')
assert.equal(monotonicOrdinaryMerge.messages[1].content, 'Complete canonical answer', 'a later client clock must not erase completed assistant content')
assert.equal(monotonicOrdinaryMerge.messages[1].streamSeq, 20, 'a later client clock must not regress the assistant cursor')
assert.equal(monotonicOrdinaryMerge.messages[1].steps.length, 1, 'a later client clock must not erase assistant UI state')
assert.equal(monotonicOrdinaryMerge.messages[1].pinned, true, 'client-owned message metadata must still update')
assert.ok(monotonicOrdinaryMerge.updatedAt > staleOrdinarySnapshot.updatedAt, 'corrected stale assistant state must force the uploader to reload')

const newerOrdinarySnapshot = {
  ...staleOrdinarySnapshot,
  messages: [
    storedOrdinaryConversation.messages[0],
    {
      ...storedOrdinaryConversation.messages[1],
      content: 'Strictly newer canonical answer',
      streamSeq: 21,
      steps: [{ id: 'ordinary-step', title: 'Done again', status: 'completed' }],
    },
  ],
}
const newerOrdinaryMerge = mergeConversationWithMonotonicAssistantState(
  storedOrdinaryConversation,
  newerOrdinarySnapshot,
)
assert.equal(newerOrdinaryMerge.messages[1].content, 'Strictly newer canonical answer', 'a strictly higher same-run cursor must advance assistant state')
assert.equal(newerOrdinaryMerge.messages[1].streamSeq, 21, 'the winning same-run cursor must persist')
const terminalOrdinaryMerge = mergeConversationWithMonotonicAssistantState(
  storedOrdinaryConversation,
  {
    ...storedOrdinaryConversation,
    updatedAt: 101,
    messages: [
      storedOrdinaryConversation.messages[0],
      { ...storedOrdinaryConversation.messages[1], streamTerminalStatus: 'done' },
    ],
  },
)
assert.equal(
  terminalOrdinaryMerge.messages[1].streamTerminalStatus,
  'done',
  'a same-cursor terminal marker must advance monotonically instead of being discarded',
)

const storedRevisionTail = {
  ...storedOrdinaryConversation,
  serverRevision: 5,
  messages: [
    ...storedOrdinaryConversation.messages,
    { id: 'tail-user', role: 'user', content: 'Newer stored user turn', timestamp: 3 },
    {
      id: 'tail-assistant-placeholder',
      role: 'assistant',
      content: '',
      timestamp: 4,
      streamRunId: 'tail-run',
      streamSeq: 0,
      steps: [],
    },
  ],
}
const staleRevisionSnapshot = {
  ...staleOrdinarySnapshot,
  serverRevision: 4,
  title: 'Metadata edit from stale tab',
  messages: [
    storedRevisionTail.messages[0],
    storedRevisionTail.messages[1],
    { id: 'stale-tab-new-user', role: 'user', content: 'A local suffix', timestamp: 40 },
  ],
}
const revisionConflictMerge = mergeConversationForRevisionConflict(
  storedRevisionTail,
  mergeConversationWithDurableLiveDirectives(storedRevisionTail, staleRevisionSnapshot),
)
assert.deepEqual(
  revisionConflictMerge.messages.map((message) => message.id),
  [
    'ordinary-user',
    'ordinary-assistant',
    'tail-user',
    'tail-assistant-placeholder',
  ],
  'an older base revision must preserve stored tails without immediately accepting unknown IDs',
)
assert.equal(revisionConflictMerge.title, 'Metadata edit from stale tab', 'revision conflict merge must preserve legitimate metadata edits')
assert.equal(
  revisionConflictMerge.messages[3].streamRunId,
  'tail-run',
  'revision conflict merge must retain an omitted server-inserted assistant placeholder',
)
const rebasedRevisionConflict = mergeSyncAcknowledgement(
  staleRevisionSnapshot,
  revisionConflictMerge,
  staleRevisionSnapshot,
)
assert.equal(rebasedRevisionConflict.localAdvanced, true, 'a rejected stale suffix must be scheduled for a CAS retry')
assert.deepEqual(
  rebasedRevisionConflict.conversation.messages.map((message) => message.id),
  [
    'ordinary-user',
    'ordinary-assistant',
    'tail-user',
    'tail-assistant-placeholder',
    'stale-tab-new-user',
  ],
  'the client must rebase a legitimate local suffix onto the returned canonical revision',
)
assert.equal(
  rebasedRevisionConflict.conversation.serverRevision,
  revisionConflictMerge.serverRevision,
  'the CAS retry must use the canonical revision returned by the server',
)

const pendingStartConflict = mergeSyncAcknowledgement(
  {
    ...storedRevisionTail,
    messages: [
      ...storedRevisionTail.messages,
      {
        id: 'pending-start-user',
        role: 'user',
        content: 'Not accepted yet',
        timestamp: 41,
        pendingStartRunId: 'pending-run',
      },
    ],
  },
  revisionConflictMerge,
  normalizeConversationForPersistence(storedRevisionTail),
)
assert.equal(pendingStartConflict.localAdvanced, false, 'pending task starts must not be scheduled for conversation sync')
assert.equal(
  pendingStartConflict.conversation.messages.at(-1)?.id,
  'pending-start-user',
  'pending task starts must remain visible locally while acceptance is unresolved',
)

const branchSubmitted = normalizeConversationForPersistence({
  ...storedRevisionTail,
  updatedAt: 50,
  serverRevision: 5,
})
const branchServerAck = normalizeConversationForPersistence({
  ...branchSubmitted,
  messages: [
    ...branchSubmitted.messages,
    { id: 'server-only-during-save', role: 'user', content: 'Concurrent server turn', timestamp: 51 },
  ],
  updatedAt: 51,
  serverRevision: 6,
})
const branchTail = branchSubmitted.messages.slice(2)
const branchAdvancedCurrent = normalizeConversationForPersistence({
  ...branchSubmitted,
  messages: branchSubmitted.messages.slice(0, 2),
  branches: [{
    id: 'inflight-branch',
    parentMessageId: 'ordinary-assistant',
    messages: branchTail,
    createdAt: 52,
  }],
  updatedAt: 52,
})
const branchAcknowledgement = mergeSyncAcknowledgement(
  branchAdvancedCurrent,
  branchServerAck,
  branchSubmitted,
)
assert.deepEqual(
  branchAcknowledgement.conversation.messages.map((message) => message.id),
  ['ordinary-user', 'ordinary-assistant', 'server-only-during-save'],
  'an acknowledgement must apply post-submit local deletions without dropping concurrent server-only IDs',
)
assert.deepEqual(
  branchAcknowledgement.conversation.branches?.[0]?.messages.map((message) => message.id),
  ['tail-user', 'tail-assistant-placeholder'],
  'an in-flight branch must keep its tail only in the branch instead of duplicating it into main history',
)

const pendingAcceptedSubmitted = normalizeConversationForPersistence({
  ...storedOrdinaryConversation,
  updatedAt: 60,
  serverRevision: 8,
})
const pendingAcceptedUser = {
  id: 'accepted-pending-user',
  role: 'user',
  content: 'Start the accepted task',
  timestamp: 61,
  pendingStartRunId: 'accepted-pending-run',
}
const pendingAcceptedAssistant = {
  id: 'accepted-pending-assistant',
  role: 'assistant',
  content: '',
  timestamp: 62,
  pendingStartRunId: 'accepted-pending-run',
  steps: [],
}
const pendingAcceptedCurrent = normalizeConversationForPersistence({
  ...pendingAcceptedSubmitted,
  messages: [
    ...pendingAcceptedSubmitted.messages,
    pendingAcceptedUser,
    pendingAcceptedAssistant,
  ],
  updatedAt: 62,
})
const pendingAcceptedServer = normalizeConversationForPersistence({
  ...pendingAcceptedSubmitted,
  messages: [
    ...pendingAcceptedSubmitted.messages,
    { ...pendingAcceptedUser, pendingStartRunId: undefined },
    {
      ...pendingAcceptedAssistant,
      pendingStartRunId: undefined,
      streamRunId: 'accepted-pending-run',
      streamSeq: 0,
    },
  ],
  updatedAt: 63,
  serverRevision: 9,
})
const pendingAcceptedAcknowledgement = mergeSyncAcknowledgement(
  pendingAcceptedCurrent,
  pendingAcceptedServer,
  pendingAcceptedSubmitted,
)
for (const messageId of ['accepted-pending-user', 'accepted-pending-assistant']) {
  assert.equal(
    pendingAcceptedAcknowledgement.conversation.messages.find((message) => message.id === messageId)?.pendingStartRunId,
    undefined,
    'a canonical same-ID acknowledgement must strip the local-only pending-start marker',
  )
}
assert.equal(
  pendingAcceptedAcknowledgement.conversation.messages.find((message) => message.id === 'accepted-pending-assistant')?.streamRunId,
  'accepted-pending-run',
  'the accepted assistant must retain its canonical run cursor while pending markers are stripped',
)

const fallbackId = taskStartMessageFallbackId('directive-history', {
  role: 'user',
  content: 'Legacy request without an id',
  timestamp: 123,
}, 0)
assert.match(
  fallbackId,
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  'deterministic fallback message ids must remain valid when the next request validates them as UUIDs',
)
assert.equal(
  taskStartMessageFallbackId('directive-history', {
    role: 'user',
    content: 'Legacy request without an id',
    timestamp: 123,
  }, 0),
  fallbackId,
  'a retry without client message ids must derive the same UUID',
)

const canonicalTaskHistory = persistedConversation.messages.map((message) => (
  message.id === 'assistant-1'
    ? { ...message, streamRunId: 'canonical-run', streamSeq: 12 }
    : message
))
const taskStartMerged = mergeConversationMessagesForTaskStart(canonicalTaskHistory, [
  { ...canonicalTaskHistory[0] },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Work',
    timestamp: 2,
  },
  { ...canonicalTaskHistory[2] },
  { ...canonicalTaskHistory[3] },
  { id: 'latest-user', role: 'user', content: 'Continue', timestamp: 30 },
])
assert.deepEqual(
  taskStartMerged.map((message) => message.id),
  [
    'user-1',
    'assistant-1',
    'directive-history-id',
    'directive-history-id_continuation',
    'latest-user',
  ],
  'task start must preserve canonical server ordering and append only the genuinely new suffix',
)
assert.equal(
  taskStartMerged[1].content,
  'Working',
  'a stale compact task request must not overwrite canonical assistant content',
)
assert.equal(
  taskStartMerged[1].streamSeq,
  12,
  'a stale compact task request must not strip durable assistant stream metadata',
)
const extendedTaskHistory = mergeConversationMessagesForTaskStart(canonicalTaskHistory, [
  { ...canonicalTaskHistory[0] },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Working with the completed suffix',
    timestamp: 2,
  },
  { ...canonicalTaskHistory[2] },
  { ...canonicalTaskHistory[3] },
])
assert.equal(
  extendedTaskHistory[1].content,
  'Working with the completed suffix',
  'a monotonic assistant text extension must survive task-start persistence even for cursorless legacy requests',
)
assert.equal(extendedTaskHistory[1].streamSeq, 12, 'text extension must preserve canonical rich stream metadata')
const cursorAdvancedTaskHistory = mergeConversationMessagesForTaskStart(canonicalTaskHistory, [
  { ...canonicalTaskHistory[0] },
  {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Newer cursor-proven assistant content',
    timestamp: 2,
    streamRunId: 'canonical-run',
    streamSeq: 13,
  },
  { ...canonicalTaskHistory[2] },
  { ...canonicalTaskHistory[3] },
])
assert.equal(cursorAdvancedTaskHistory[1].content, 'Newer cursor-proven assistant content', 'a higher same-run task-start cursor must advance content')
assert.equal(cursorAdvancedTaskHistory[1].streamSeq, 13, 'a higher same-run task-start cursor must advance the canonical cursor')
const acceptedPlaceholderHistory = mergeConversationMessagesForTaskStart(
  [
    { id: 'placeholder-user', role: 'user', content: 'Start', timestamp: 1 },
    { id: 'placeholder-assistant', role: 'assistant', content: '', timestamp: 2 },
  ],
  [
    { id: 'placeholder-user', role: 'user', content: 'Start', timestamp: 1 },
    {
      id: 'placeholder-assistant',
      role: 'assistant',
      content: '',
      timestamp: 2,
      streamRunId: 'accepted-placeholder-run',
      streamSeq: 0,
    },
  ],
)
assert.equal(acceptedPlaceholderHistory[1].streamRunId, 'accepted-placeholder-run', 'task acceptance must bind an existing client placeholder to the durable run')
assert.equal(acceptedPlaceholderHistory[1].streamSeq, 0, 'the accepted placeholder must begin at the durable zero cursor')
assert.throws(
  () => mergeConversationMessagesForTaskStart(canonicalTaskHistory, [
    { ...canonicalTaskHistory[0] },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Working',
      timestamp: 2,
    },
    { id: 'stale-new-user', role: 'user', content: 'Start from stale context', timestamp: 31 },
  ]),
  /saved task has newer messages/,
  'a new task suffix must not start until the request covers the full canonical history',
)
assert.throws(
  () => mergeConversationMessagesForTaskStart(
    [
      ...canonicalTaskHistory,
      { id: 'already-synced-stale-user', role: 'user', content: 'Stale suffix', timestamp: 32 },
    ],
    [
      { ...canonicalTaskHistory[0] },
      { ...canonicalTaskHistory[1] },
      { id: 'already-synced-stale-user', role: 'user', content: 'Stale suffix', timestamp: 32 },
    ],
  ),
  /saved task has newer messages/,
  'an already-synced stale suffix id must not bypass full canonical-history coverage',
)
assert.throws(
  () => mergeConversationMessagesForTaskStart(canonicalTaskHistory, [
    { ...canonicalTaskHistory[0], content: 'rewritten accepted user message' },
  ]),
  /saved user message changed/,
  'task start must fail closed when a same-id user message changes content',
)

const conversationId = 'directive-queue'
const userId = 'directive-user'
const runId = 'directive-run'
for (let index = 0; index < 12; index += 1) {
  await enqueueLiveDirective(conversationId, `instruction ${index}`, userId, runId, `directive-${index}`)
}
await enqueueLiveDirective(conversationId, 'instruction 0', userId, runId, 'directive-0')
assert.equal(await getLiveDirectiveQueueLength(conversationId, userId, runId), 12, 'an idempotent retry must not consume capacity')
await assert.rejects(
  enqueueLiveDirective(conversationId, 'overflow', userId, runId, 'directive-overflow'),
  (error) => error?.code === 'LIVE_DIRECTIVE_QUEUE_FULL',
)
assert.equal(await getLiveDirectiveQueueLength(conversationId, userId, runId), 12, 'overflow rejection must not evict accepted work')

await drainLiveDirectives(conversationId, userId, runId, 1)
assert.equal((await getLiveDirectiveReceipt('directive-0', userId, conversationId))?.status, 'delivered')

const pendingId = 'directive-pending-at-seal'
await enqueueLiveDirective(conversationId, 'too close to completion', userId, runId, pendingId)
await sealLiveDirectiveRun(conversationId, userId, runId, 1)
const rejectedReceipt = await getLiveDirectiveReceipt(pendingId, userId, conversationId)
assert.equal(rejectedReceipt?.status, 'rejected', 'sealing must leave an explicit outcome for accepted but undelivered work')
assert.equal(await getLiveDirectiveQueueLength(conversationId, userId, runId), 0, 'rejected pending work must leave the consumable queue')
assert.equal(
  (await enqueueLiveDirective(conversationId, 'too close to completion', userId, runId, pendingId)).status,
  'rejected',
  'a retry after cleanup must recover the rejection instead of losing the accepted request',
)
await clearLiveDirectivesForRun(userId, runId)
await assert.rejects(
  enqueueLiveDirective(conversationId, 'accepted during terminal cleanup', userId, runId, 'post-terminal-race'),
  (error) => error?.code === 'NO_ACTIVE_TASK_FOR_DIRECTIVE',
  'terminal cleanup must retain the memory seal so a route-check race cannot lose an accepted instruction',
)

const [
  liveSource,
  routeSource,
  clientSource,
  conversationSource,
  messageSliceSource,
  conversationSliceSource,
  conversationRouteSource,
  serverSyncSource,
] = await Promise.all([
  readFile(new URL('../src/lib/liveDirectives.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/api/chat/directive/route.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/stream/client/useAgentStream.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/conversations.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/chat/messageSlice.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/chat/conversationSlice.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/api/conversations/route.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/store/chat/serverSync.ts', import.meta.url), 'utf8'),
])
assert.match(liveSource, /create table if not exists agent_live_directive_receipts/, 'receipts must survive queue-row cleanup')
assert.match(liveSource, /LiveDirectiveQueueFullError/, 'capacity must reject explicitly')
assert.doesNotMatch(liveSource, /limit -1 offset \?/, 'capacity must not delete previously accepted rows')
assert.match(liveSource, /persistAcceptedLiveDirectiveInConversation\(transaction/, 'queue and conversation acceptance must share one transaction')
assert.match(routeSource, /directiveId: z\.string\(\)\.uuid\(\)/, 'the API must require a client idempotency id')
assert.ok(
  routeSource.indexOf('getLiveDirectiveReceipt(directiveId') < routeSource.indexOf('const activeJob = await findActiveTaskJobForConversation'),
  'a retry must recover its receipt even after the target task becomes terminal',
)
assert.match(clientSource, /postLiveDirectiveWithRetry\(\{[\s\S]*directiveId: uuidv4\(\)/, 'ambiguous client retries must reuse a generated directive id')
assert.match(conversationSource, /where user_id = \? and id = \? and deleted_at_ms is null and body_json = \?/, 'conversation acceptance must use a compare-and-swap update')
assert.match(clientSource, /liveDirective: \{[\s\S]*part: 'instruction'/, 'the accepting client must retain the durable message marker')
assert.match(
  conversationSource,
  /messages\.push\(userMessage, \{[\s\S]*streamRunId: current\.streamRunId,[\s\S]*streamSeq: current\.streamSeq/,
  'durable acceptance must move the predecessor replay cursor onto the continuation',
)
assert.match(
  messageSliceSource,
  /addLiveDirectiveExchange:[\s\S]*const lastIndex = messages\.length - 1[\s\S]*if \(current\?\.role === 'assistant'\)[\s\S]*messages\.push\(boundedUserMessage, continuation\)/,
  'the client must only split the final assistant instead of inserting before a newer user message',
)
assert.match(
  messageSliceSource,
  /const continuation: Message = \{[\s\S]*streamRunId: current\.streamRunId,[\s\S]*streamSeq: current\.streamSeq/,
  'client acceptance must move the replay cursor onto the continuation',
)
assert.match(
  conversationSource,
  /tursoTransaction\('write',[\s\S]*select body_json, server_placeholder, revision, created_at_ms, updated_at_ms, deleted_at_ms[\s\S]*mergeConversationWithDurableLiveDirectives/,
  'generic sync must read and merge the current body inside the write transaction',
)
assert.match(conversationSource, /revision integer not null default 1/, 'conversation bodies must have a monotonic server revision')
assert.match(
  conversationSource,
  /if \(!baseRevisionMatches\)[\s\S]*mergeConversationForRevisionConflict/,
  'a stale base revision must use non-destructive stored-tail reconciliation',
)
assert.match(conversationRouteSource, /Response\.json\(\{ ok: true, conversations \}\)/, 'sync POST must return reconciled bodies and revisions')
assert.match(serverSyncSource, /mergeSyncAcknowledgement\(current, server, submitted\)/, 'the client must adopt the reconciled server body')
assert.match(
  conversationSliceSource,
  /toggleStar:[\s\S]*starred: !c\.starred, updatedAt: Math\.max\(Date\.now\(\), c\.updatedAt \+ 1\)/,
  'single-task starring must advance the conversation dirty timestamp',
)
assert.match(
  conversationSliceSource,
  /starConversations:[\s\S]*starred: true, updatedAt: Math\.max\(Date\.now\(\), c\.updatedAt \+ 1\)/,
  'bulk starring must advance each conversation dirty timestamp',
)
assert.match(
  serverSyncSource,
  /catch \(error\) \{[\s\S]*scheduleSaveRetry\(\)[\s\S]*function scheduleSaveRetry/,
  'a failed save must schedule bounded retry instead of stranding dirty state',
)
assert.match(
  serverSyncSource,
  /function conversationVersionIsOlder[\s\S]*candidateRevision[\s\S]*candidate\.updatedAt < existing\.updatedAt[\s\S]*wouldBypassStaleFence = existing\.serverBodyStale && conversationVersionIsOlder/,
  'legacy/full-body merging must not bypass a newer server summary upload fence',
)
assert.match(
  conversationSource,
  /for \(const id of input\.deletedIds\)[\s\S]*set deleted_at_ms = \?/,
  'whole-conversation deletion must remain an explicit allowed operation',
)

await clearLiveDirectivesForTest()
console.log(JSON.stringify({ ok: true, capacity: 12, rejectedOutcome: rejectedReceipt?.outcomeCode }, null, 2))
