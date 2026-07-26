import 'server-only'

import { taskQueueBaseName, taskQueueName } from './taskQueue'
import { tursoExecute } from '@/lib/db/turso'

export type TaskIntakeHold = {
  queueName: string
  holdId: string
  reason: string | null
  heldAtMs: number
}

let schemaPromise: Promise<void> | null = null

async function ensureTaskIntakeHoldSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = tursoExecute(`
      create table if not exists agent_task_queue_controls (
        queue_name text primary key,
        intake_hold_id text,
        intake_hold_reason text,
        intake_held_at_ms integer,
        updated_at_ms integer not null
      )
    `).then(() => undefined).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  await schemaPromise
}

export async function getTaskIntakeHold(
  queueName = taskQueueName(),
  queueBaseName = taskQueueBaseName(),
): Promise<TaskIntakeHold | null> {
  await ensureTaskIntakeHoldSchema()
  const result = await tursoExecute(
    `
      select queue_name, intake_hold_id, intake_hold_reason, intake_held_at_ms
      from agent_task_queue_controls
      where queue_name in (?, ?)
        and length(trim(coalesce(intake_hold_id, ''))) > 0
      order by case when queue_name = ? then 0 else 1 end
      limit 1
    `,
    [queueName, queueBaseName, queueName],
  )
  const row = result.rows[0]
  const holdId = typeof row?.intake_hold_id === 'string'
    ? row.intake_hold_id.trim()
    : ''
  if (!holdId) return null

  return {
    queueName: typeof row.queue_name === 'string' ? row.queue_name : queueName,
    holdId,
    reason: typeof row.intake_hold_reason === 'string' && row.intake_hold_reason
      ? row.intake_hold_reason
      : null,
    heldAtMs: Math.max(0, Number(row.intake_held_at_ms || 0)),
  }
}
