#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))

loadLocalEnvFiles(rootUrl)

function requireEnv(name) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required. Put it in .env.local before running the task-start persistence smoke.`)
  }
}

requireEnv('TURSO_DATABASE_URL')
requireEnv('TURSO_AUTH_TOKEN')

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const {
  ensureUserConversationForTaskStart,
  getUserConversationById,
  syncUserConversations,
} = await jiti.import(fileURLToPath(new URL('../src/lib/conversations.ts', import.meta.url)))
const { tursoExecute } = await jiti.import(fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url)))

const userId = `internal-task-start-smoke-${randomUUID()}`
const conversationId = `task-start-smoke-${randomUUID()}`
const firstPrompt = 'verify immediate close task history persistence'
const clientPrompt = 'client-synced richer task body'

console.log(`Running task-start persistence smoke for ${conversationId}`)
console.log('This smoke writes diagnostic rows to Turso but does not call the LLM or start E2B.')

async function readRawRow() {
  const result = await tursoExecute(
    `
      select body_json, server_placeholder, updated_at_ms
      from conversations
      where user_id = ? and id = ?
      limit 1
    `,
    [userId, conversationId],
  )
  return result.rows[0] || null
}

try {
  await ensureUserConversationForTaskStart(userId, {
    conversationId,
    messages: [{ role: 'user', content: firstPrompt }],
  })

  const placeholderRow = await readRawRow()
  if (!placeholderRow) {
    throw new Error('Task-start persistence did not insert a server conversation row.')
  }
  if (placeholderRow.server_placeholder !== 1 && placeholderRow.server_placeholder !== true) {
    throw new Error(`Expected server_placeholder=1 after task-start persistence, got ${String(placeholderRow.server_placeholder)}.`)
  }
  const placeholderBody = JSON.parse(String(placeholderRow.body_json || '{}'))
  if (placeholderBody.serverStartPlaceholder !== true) {
    throw new Error('Stored placeholder body is missing serverStartPlaceholder=true.')
  }

  const loadedPlaceholder = await getUserConversationById(userId, conversationId)
  if (!loadedPlaceholder || loadedPlaceholder.messages[0]?.content !== firstPrompt) {
    throw new Error('Server-created task conversation could not be loaded from account history.')
  }

  const olderClientUpdatedAt = Math.max(1, Number(placeholderRow.updated_at_ms || Date.now()) - 10_000)
  await syncUserConversations(userId, {
    conversations: [{
      id: conversationId,
      title: 'Client synced task',
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: clientPrompt,
        timestamp: olderClientUpdatedAt,
      }],
      starred: false,
      createdAt: olderClientUpdatedAt,
      updatedAt: olderClientUpdatedAt,
    }],
    deletedIds: [],
  })

  const syncedRow = await readRawRow()
  if (!syncedRow) {
    throw new Error('Conversation disappeared after client sync.')
  }
  if (syncedRow.server_placeholder === 1 || syncedRow.server_placeholder === true) {
    throw new Error('Client sync did not clear server_placeholder.')
  }
  const syncedConversation = await getUserConversationById(userId, conversationId)
  if (!syncedConversation || syncedConversation.messages[0]?.content !== clientPrompt) {
    throw new Error('Client sync did not replace the server placeholder with the richer conversation body.')
  }

  await tursoExecute('delete from conversations where user_id = ? and id = ?', [userId, conversationId])

  console.log(JSON.stringify({
    ok: true,
    userId,
    conversationId,
    placeholderInserted: true,
    placeholderLoadable: true,
    clientSyncReplacedPlaceholder: true,
  }, null, 2))
} catch (error) {
  await tursoExecute('delete from conversations where user_id = ? and id = ?', [userId, conversationId]).catch(() => undefined)
  console.error(JSON.stringify({
    ok: false,
    userId,
    conversationId,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}
