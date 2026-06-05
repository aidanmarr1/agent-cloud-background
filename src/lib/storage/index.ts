import { deleteLocalObject, putLocalObject, readLocalObject, type StoredObjectInfo } from './local'
import { deleteTursoObject, putTursoObject, readTursoObject } from './turso'

export type StorageDriver = 'local' | 'turso'

export interface StoredObject {
  body: Buffer
}

export function getStorageDriver(): StorageDriver {
  const configured = process.env.AGENT_STORAGE_DRIVER?.trim().toLowerCase()
  const hasTursoConfig = !!process.env.TURSO_DATABASE_URL?.trim() && !!process.env.TURSO_AUTH_TOKEN?.trim()
  const driver = configured || (process.env.VERCEL || hasTursoConfig ? 'turso' : 'local')
  if (driver === 'database' || driver === 'db') return 'turso'
  if (driver !== 'local' && driver !== 'turso') {
    throw new Error(`Unsupported storage driver: ${driver}`)
  }
  return driver
}

export async function putObject(key: string, body: Buffer): Promise<StoredObjectInfo> {
  if (getStorageDriver() === 'turso') return putTursoObject(key, body)
  return putLocalObject(key, body)
}

export async function getObject(key: string): Promise<StoredObject> {
  if (getStorageDriver() === 'turso') {
    try {
      return { body: await readTursoObject(key) }
    } catch (error) {
      if (process.env.VERCEL) throw error
      return { body: await readLocalObject(key) }
    }
  }
  return { body: await readLocalObject(key) }
}

export async function deleteObject(key: string): Promise<void> {
  if (getStorageDriver() === 'turso') {
    await deleteTursoObject(key)
    if (!process.env.VERCEL) await deleteLocalObject(key).catch(() => undefined)
    return
  }
  await deleteLocalObject(key)
}
