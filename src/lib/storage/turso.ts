import { tursoExecute } from '@/lib/db/turso'

export interface StoredObjectInfo {
  key: string
  size: number
}

const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._/-]+$/

let storageSchemaPromise: Promise<void> | null = null

export function normalizeTursoStorageKey(key: string): string {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized.includes('..') || !STORAGE_KEY_PATTERN.test(normalized)) {
    throw new Error('Invalid storage key')
  }
  return normalized
}

async function ensureTursoStorageSchema(): Promise<void> {
  if (!storageSchemaPromise) {
    storageSchemaPromise = (async () => {
      await tursoExecute(`
        create table if not exists storage_objects (
          key text primary key,
          body_base64 text not null,
          size integer not null,
          created_at text not null
        )
      `)
      await tursoExecute('create index if not exists storage_objects_created_idx on storage_objects(created_at desc)')
    })().catch((error) => {
      storageSchemaPromise = null
      throw error
    })
  }

  return storageSchemaPromise
}

export async function putTursoObject(key: string, data: Buffer): Promise<StoredObjectInfo> {
  const normalized = normalizeTursoStorageKey(key)
  await ensureTursoStorageSchema()
  await tursoExecute(
    `
      insert into storage_objects (key, body_base64, size, created_at)
      values (?, ?, ?, ?)
    `,
    [normalized, data.toString('base64'), data.byteLength, new Date().toISOString()],
  )
  return { key: normalized, size: data.byteLength }
}

export async function readTursoObject(key: string): Promise<Buffer> {
  const normalized = normalizeTursoStorageKey(key)
  await ensureTursoStorageSchema()
  const result = await tursoExecute(
    'select body_base64 from storage_objects where key = ? limit 1',
    [normalized],
  )
  const bodyBase64 = result.rows[0]?.body_base64
  if (typeof bodyBase64 !== 'string') {
    throw new Error('Storage object not found')
  }
  return Buffer.from(bodyBase64, 'base64')
}

export async function deleteTursoObject(key: string): Promise<void> {
  const normalized = normalizeTursoStorageKey(key)
  await ensureTursoStorageSchema()
  await tursoExecute('delete from storage_objects where key = ?', [normalized])
}
