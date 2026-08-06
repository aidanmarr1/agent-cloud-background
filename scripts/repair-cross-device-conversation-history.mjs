#!/usr/bin/env node

import { createClient } from '@tursodatabase/serverless/compat'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
loadLocalEnvFiles(rootUrl)

const args = process.argv.slice(2)
const apply = args.includes('--apply')

function readArg(name) {
  const prefix = `${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length).trim()
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] || '').trim() : ''
}

function requireEnv(name) {
  const value = process.env[name]?.trim() || ''
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function finiteInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

const userId = readArg('--user-id')
if (!/^[A-Za-z0-9_-]{8,160}$/.test(userId)) {
  throw new Error('Pass a valid account id with --user-id.')
}

const client = createClient({
  url: requireEnv('TURSO_DATABASE_URL'),
  authToken: requireEnv('TURSO_AUTH_TOKEN'),
})

try {
  const selected = await client.execute({
    sql: `
      select
        c.id,
        c.body_json,
        c.revision,
        c.updated_at_ms,
        max(j.updated_at_ms) as job_updated_at_ms
      from conversations c
      join agent_task_jobs j
        on j.user_id = c.user_id and j.conversation_id = c.id
      where c.user_id = ? and c.deleted_at_ms is not null
      group by c.id, c.body_json, c.revision, c.updated_at_ms
      order by c.id
    `,
    args: [userId],
  })

  const repairs = []
  const malformedIds = []
  for (const row of selected.rows) {
    if (typeof row.id !== 'string' || typeof row.body_json !== 'string') continue
    let body
    try {
      body = JSON.parse(row.body_json)
    } catch {
      malformedIds.push(row.id)
      continue
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      malformedIds.push(row.id)
      continue
    }

    const revision = Math.max(1, finiteInteger(row.revision, 1))
    const nextRevision = revision + 1
    const updatedAt = Math.max(
      finiteInteger(body.updatedAt),
      finiteInteger(row.updated_at_ms),
      finiteInteger(row.job_updated_at_ms),
    )
    repairs.push({
      id: row.id,
      revision,
      nextRevision,
      updatedAt,
      bodyJson: JSON.stringify({
        ...body,
        updatedAt,
        serverRevision: nextRevision,
      }),
    })
  }

  console.log(JSON.stringify({
    userId,
    apply,
    eligible: selected.rows.length,
    repairable: repairs.length,
    malformed: malformedIds.length,
  }, null, 2))

  if (malformedIds.length > 0) {
    throw new Error(`Refusing to continue: ${malformedIds.length} eligible task bodies are malformed.`)
  }
  if (apply && repairs.length > 0) {
    const batchSize = 50
    let restored = 0
    for (let offset = 0; offset < repairs.length; offset += batchSize) {
      const batch = repairs.slice(offset, offset + batchSize)
      const results = await client.batch(batch.map((repair) => ({
        sql: `
          update conversations
          set body_json = ?,
              revision = ?,
              updated_at_ms = ?,
              deleted_at_ms = null,
              updated_at = ?
          where user_id = ? and id = ? and deleted_at_ms is not null and revision = ?
        `,
        args: [
          repair.bodyJson,
          repair.nextRevision,
          repair.updatedAt,
          new Date(repair.updatedAt).toISOString(),
          userId,
          repair.id,
          repair.revision,
        ],
      })), 'write')
      restored += results.reduce((sum, result) => sum + Number(result.rowsAffected || 0), 0)
    }

    if (restored !== repairs.length) {
      throw new Error(`Restored ${restored} of ${repairs.length} rows; concurrent changes prevented a complete repair.`)
    }

    const verified = await client.execute({
      sql: `
        select
          sum(case when c.deleted_at_ms is null then 1 else 0 end) as active,
          sum(case when c.deleted_at_ms is not null then 1 else 0 end) as deleted
        from conversations c
        where c.user_id = ?
      `,
      args: [userId],
    })
    console.log(JSON.stringify({
      restored,
      active: finiteInteger(verified.rows[0]?.active),
      deleted: finiteInteger(verified.rows[0]?.deleted),
    }, null, 2))
  }
} finally {
  client.close()
}
