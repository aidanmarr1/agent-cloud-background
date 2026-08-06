import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [serverSync, conversations, taskJobs] = await Promise.all([
  readFile(join(root, 'src/store/chat/serverSync.ts'), 'utf8'),
  readFile(join(root, 'src/lib/conversations.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/taskJobs.ts'), 'utf8'),
])

assert.match(
  serverSync,
  /const pendingDeletedConversationIds = new Set<string>\(\)/,
  'deletion intent must be tracked separately from a client snapshot',
)
assert.match(
  serverSync,
  /function getDeletedIds[\s\S]*pendingDeletedConversationIds[\s\S]*knownConversationIds\.has/,
  'a missing local row must never be interpreted as a cross-device deletion',
)
assert.doesNotMatch(
  serverSync,
  /function getDeletedIds[\s\S]{0,300}knownConversationIds\)\.filter\(\(id\) => !currentIds\.has\(id\)\)/,
  'absence-based tombstoning must stay removed',
)
assert.match(
  serverSync,
  /explicitConversationRemovals\(previous\.conversations, state\.conversations\)[\s\S]*pendingDeletedConversationIds\.add/,
  'only an observed user-level store removal may create a deletion intent',
)
assert.match(
  serverSync,
  /if \(!storeApi \|\| !hydrated \|\| !serverBaselineEstablished\) return/,
  'a failed first server read must fence all outbound synchronization',
)
assert.match(
  serverSync,
  /const establishedBaselineNow = !serverBaselineEstablished[\s\S]*serverBaselineEstablished = true[\s\S]*mergeConversations/,
  'the next successful refresh must establish the baseline before reconciling local state',
)
assert.match(
  serverSync,
  /const REFRESH_INTERVAL_MS = 5_000/,
  'visible clients must discover another device within a short bounded interval',
)
assert.match(
  conversations,
  /const MAX_SYNC_CONVERSATIONS = 2_000/,
  'the metadata-only history index must not silently omit established task history at 500 rows',
)
assert.match(
  conversations,
  /export async function advanceUserConversationForTaskTerminal[\s\S]*deleted_at_ms is null[\s\S]*serverRevision: nextRevision/,
  'terminal work must advance the canonical account task record without reviving deleted history',
)
assert.match(
  taskJobs,
  /advanceUserConversationForTaskTerminal\([\s\S]*job\.userId,[\s\S]*job\.conversationId/,
  'terminal event publication must also advance cross-device history freshness',
)

console.log('Cross-device task history synchronization smoke test passed')
