import { constants } from 'fs'
import { mkdir, open, realpath, rm, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'

export interface StoredObjectInfo {
  key: string
  size: number
}

const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9._/-]+$/

function storageRoot(): string {
  const configured = process.env.AGENT_STORAGE_DIR?.trim() || '.agent-storage'
  return resolve(isAbsolute(configured) ? configured : join(/*turbopackIgnore: true*/ process.cwd(), configured))
}

export function normalizeStorageKey(key: string): string {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized.includes('..') || !STORAGE_KEY_PATTERN.test(normalized)) {
    throw new Error('Invalid storage key')
  }
  return normalized
}

function resolveStoragePath(key: string): string {
  const root = storageRoot()
  const normalized = normalizeStorageKey(key)
  const target = resolve(root, normalized)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid storage key')
  }
  return target
}

function isInsideStorageRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realStorageRoot(): Promise<string> {
  const root = storageRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  return realpath(root)
}

async function ensureSafeStorageParent(path: string): Promise<void> {
  const root = storageRoot()
  const rootReal = await realStorageRoot()
  let ancestor = dirname(path)

  while (true) {
    try {
      await stat(ancestor)
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor || !isInsideStorageRoot(root, parent)) break
      ancestor = parent
    }
  }

  const ancestorReal = await realpath(ancestor)
  if (!isInsideStorageRoot(rootReal, ancestorReal)) {
    throw new Error('Invalid storage key')
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const parentReal = await realpath(dirname(path))
  if (!isInsideStorageRoot(rootReal, parentReal)) {
    throw new Error('Invalid storage key')
  }
}

async function assertExistingStoragePath(path: string): Promise<void> {
  const rootReal = await realStorageRoot()
  const targetReal = await realpath(path)
  if (!isInsideStorageRoot(rootReal, targetReal)) {
    throw new Error('Invalid storage key')
  }
}

export async function putLocalObject(key: string, data: Buffer): Promise<StoredObjectInfo> {
  const path = resolveStoragePath(key)
  await ensureSafeStorageParent(path)
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(data)
  } finally {
    await file.close()
  }
  return { key: normalizeStorageKey(key), size: data.byteLength }
}

export async function readLocalObject(key: string): Promise<Buffer> {
  const path = resolveStoragePath(key)
  await assertExistingStoragePath(path)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await file.readFile()
  } finally {
    await file.close()
  }
}

export async function deleteLocalObject(key: string): Promise<void> {
  const path = resolveStoragePath(key)
  await assertExistingStoragePath(path)
  await rm(path, { force: true })
}

export async function getLocalObjectSize(key: string): Promise<number | null> {
  try {
    const path = resolveStoragePath(key)
    await assertExistingStoragePath(path)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      return info.size
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}
