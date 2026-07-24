#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [chatRoute, conversations] = await Promise.all([
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/conversations.ts'), 'utf8'),
])

const post = chatRoute.slice(chatRoute.indexOf('export async function POST'))
const prepareIndex = post.indexOf('const conversationInsertPromise = timedRoutePromise(')
const accessIndex = post.indexOf("await timedRoutePromise('taskAccessReadyMs'")
const earlyIdempotencyIndex = post.indexOf('const acceptedRun = await findTaskJobForRun')
const conflictWaveIndex = post.indexOf('const taskConflictChecksPromise = (async () =>')
const acceptanceWaveIndex = post.indexOf(';[, messages, unavailableWorker, , conversationInsert, taskConflictChecks] = await Promise.all([')
const reservationIndex = post.indexOf('const startReservation = reserveConversationStart')
const enqueueIndex = post.indexOf('await enqueueTaskJob({')

assert.ok(prepareIndex >= 0, 'chat POST must prepare its durable conversation statement')
assert.ok(
  prepareIndex < accessIndex && prepareIndex < earlyIdempotencyIndex,
  'read-only conversation preparation must overlap task access and early idempotency reads',
)
assert.ok(
  conflictWaveIndex > earlyIdempotencyIndex && conflictWaveIndex < acceptanceWaveIndex,
  'final exact-run and active-conversation reads must start inside the parallel acceptance wave',
)
assert.match(
  post.slice(conflictWaveIndex, acceptanceWaveIndex + 800),
  /const \[requestedTask, activeCandidate\] = await Promise\.all\(\[[\s\S]*findTaskJobForRun\([\s\S]*findActiveTaskJobForConversation\([\s\S]*taskConflictChecksPromise,/,
  'both advisory conflict reads must be awaited with the other acceptance gates',
)
assert.doesNotMatch(
  post.slice(reservationIndex, enqueueIndex),
  /await (?:findTaskJobForRun|findActiveTaskJobForConversation)\(/,
  'no serial remote conflict read may remain between the settled acceptance wave and atomic enqueue',
)
assert.match(
  post.slice(enqueueIndex, enqueueIndex + 500),
  /await enqueueTaskJob\(\{[\s\S]*conversationInsert,/,
  'the prepared conversation statement must remain inside the durable enqueue transaction',
)

const schema = conversations.match(/export async function ensureConversationSchema\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] || ''
assert.match(schema, /getTursoClient\(\)\.executeMultiple\(/, 'idempotent schema DDL must share one sequence round trip')
assert.match(schema, /const tableInfo = await tursoExecute\('pragma table_info\(conversations\)'\)/, 'legacy-column inspection must use a row-producing query')
assert.doesNotMatch(schema, /getTursoClient\(\)\.batch\(/, 'compat batch cannot be used when individual row-producing results are required')
assert.match(schema, /pragma table_info\(conversations\)/, 'cold schema setup must inspect legacy columns before migration')
assert.match(schema, /if \(!columns\.has\('server_placeholder'\)\)[\s\S]*addConversationColumn/, 'legacy placeholder-column repair must remain available')
assert.match(schema, /if \(!columns\.has\('revision'\)\)[\s\S]*addConversationColumn/, 'legacy revision-column repair must remain available')
assert.doesNotMatch(
  schema,
  /await tursoExecute\('create index if not exists conversations_/,
  'idempotent index maintenance must not regress to serial remote calls',
)

console.log('chat route startup overlap smoke checks passed')
