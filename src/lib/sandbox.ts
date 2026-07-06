import { mkdir, rm, stat, unlink, readdir, realpath, open, lstat } from 'fs/promises'
import { constants } from 'fs'
import type { Dirent } from 'fs'
import { tmpdir } from 'os'
import { join, relative, dirname, isAbsolute } from 'path'
import type { FileResult } from '@/types'
import {
  appendFileInE2B,
  createFileInE2B,
  deleteFileInE2B,
  destroyE2BSandbox,
  e2bFileExists,
  editFileInE2B,
  executeCommandInE2B,
  getOrCreateE2BSandbox,
  listE2BFilesDetailed,
  listFilesInE2B,
  pauseE2BSandbox,
  readE2BFileBytes,
  readFileInE2B,
  resetE2BSandbox,
  shouldUseE2BSandbox,
  syncE2BWorkspaceToLocal,
  writeFileBytesInE2B,
  type SandboxFileReadResult,
} from './e2bSandbox'

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const IGNORED_SANDBOX_DIRECTORIES = new Set([
  'node_modules', '.git', '__pycache__',
  '.agent',
  'venv', '.venv', 'env',
  'Library', '.matplotlib', '.cache', '.local', '.pip', '.fontconfig',
])

function sanitizeConversationId(id: string): string {
  if (!SAFE_TASK_ID.test(id)) {
    throw new Error('Invalid task id: must contain only alphanumeric, hyphens, underscores')
  }
  return id
}

export function getSandboxDirPath(conversationId: string): string {
  const safeId = sanitizeConversationId(conversationId)
  return join(tmpdir(), `agent-sandbox-${safeId}`)
}

function shouldSkipSandboxEntry(name: string): boolean {
  return IGNORED_SANDBOX_DIRECTORIES.has(name)
}

export function isInsideSandbox(sandboxDir: string, resolved: string): boolean {
  const rel = relative(sandboxDir, resolved)
  // rel === '' means resolved IS sandboxDir — valid for parent-dir containment checks
  // (e.g., dirname of a file at the sandbox root resolves to the sandbox itself)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export async function resolveAndVerify(sandboxDir: string, resolved: string): Promise<boolean> {
  try {
    const real = await realpath(resolved)
    const realSandbox = await realpath(sandboxDir)
    const rel = relative(realSandbox, real)
    // rel === '' is valid: on macOS /tmp → /private/tmp symlink resolution can make
    // a path equal the sandbox root (e.g., when verifying dirname for a root-level file)
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    // File doesn't exist yet — fall back to string check (safe for new files)
    return isInsideSandbox(sandboxDir, resolved)
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
}

type OutputCallback = (stream: 'stdout' | 'stderr', data: string) => void

const sandboxDirs = new Map<string, { path: string; lastUsed: number }>()

const IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes
const CLEANUP_INTERVAL_MS = 60_000

export function isCloudSandboxProviderEnabled(): boolean {
  return shouldUseE2BSandbox()
}

export async function getOrCreateLocalSandboxDir(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const existing = sandboxDirs.get(safeId)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.path
  }

  const dir = getSandboxDirPath(safeId)
  await mkdir(dir, { recursive: true })
  sandboxDirs.set(safeId, { path: dir, lastUsed: Date.now() })
  return dir
}

export async function resetLocalSandboxDir(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const dir = getSandboxDirPath(safeId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  sandboxDirs.set(safeId, { path: dir, lastUsed: Date.now() })
  return dir
}

export async function getOrCreateSandboxDir(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const dir = await getOrCreateLocalSandboxDir(safeId)
  if (shouldUseE2BSandbox()) await getOrCreateE2BSandbox(safeId)
  return dir
}

export async function resetSandboxDir(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const dir = await resetLocalSandboxDir(safeId)
  if (shouldUseE2BSandbox()) await resetE2BSandbox(safeId)
  return dir
}

export async function executeInSandbox(
  conversationId: string,
  command: string,
  onOutput?: OutputCallback
): Promise<ExecResult> {
  if (shouldUseE2BSandbox()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return executeCommandInE2B(conversationId, command, onOutput, localRoot, MAX_SANDBOX_FILE_SIZE)
  }

  await getOrCreateSandboxDir(conversationId)
  const startTime = Date.now()
  return {
    stdout: '',
    stderr: 'Local process execution is disabled until an OS-level sandbox is available.',
    exitCode: 1,
    durationMs: Date.now() - startTime,
    timedOut: false,
  }
}

// --- File operations ---

export async function createFileInSandbox(
  conversationId: string,
  filePath: string,
  content: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return createFileInE2B(conversationId, filePath, content, localRoot)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const resolved = join(sandboxDir, filePath)
  if (!isInsideSandbox(sandboxDir, resolved)) {
    return { action: 'created', path: filePath, content: 'Error: path traversal not allowed' }
  }
  // Walk up to the nearest existing ancestor and verify it via realpath BEFORE
  // mkdir. Without this, a planted symlink anywhere in the existing path (e.g.
  // /tmp/agent-sandbox-XXX/foo → /etc) would cause mkdir(..., { recursive: true })
  // to create directories OUTSIDE the sandbox before post-hoc verification could
  // reject it. realpath() requires the path to exist, hence the walk-up.
  let ancestor = dirname(resolved)
  while (true) {
    try {
      await stat(ancestor)
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  if (!await resolveAndVerify(sandboxDir, ancestor)) {
    return { action: 'created', path: filePath, content: 'Error: path traversal not allowed' }
  }
  await mkdir(dirname(resolved), { recursive: true })
  // Open with O_NOFOLLOW so a planted symlink at the leaf path (e.g., the agent
  // creates `foo.txt` as a symlink to /etc/passwd via the bash tool, then calls
  // create_file on it) fails with ELOOP instead of writing to the symlink target.
  // Without this, the post-write resolveAndVerify+unlink below would only remove
  // the symlink — the target file would already contain the written content.
  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(
      resolved,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') {
      return { action: 'created', path: filePath, content: 'Error: path traversal not allowed' }
    }
    throw err
  }
  try {
    await fd.writeFile(content, 'utf-8')
  } finally {
    await fd.close()
  }
  // Verify the final written file resolves inside the sandbox (TOCTOU defense
  // against a symlink raced into place between mkdir and open)
  if (!await resolveAndVerify(sandboxDir, resolved)) {
    try { await unlink(resolved) } catch { /* best effort */ }
    return { action: 'created', path: filePath, content: 'Error: path traversal not allowed' }
  }
  const s = await stat(resolved)
  return { action: 'created', path: filePath, size: s.size }
}

export async function readFileInSandbox(
  conversationId: string,
  filePath: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    return readFileInE2B(conversationId, filePath, MAX_SANDBOX_FILE_SIZE)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const resolved = join(sandboxDir, filePath)
  if (!isInsideSandbox(sandboxDir, resolved)) {
    return { action: 'read', path: filePath, content: 'Error: path traversal not allowed' }
  }
  try {
    if (!await resolveAndVerify(sandboxDir, resolved)) {
      return { action: 'read', path: filePath, content: 'Error: path traversal not allowed' }
    }
    let fd: Awaited<ReturnType<typeof open>>
    try {
      fd = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'EMLINK') {
        return { action: 'read', path: filePath, content: 'Error: path traversal not allowed' }
      }
      throw err
    }
    let content: string
    try {
      content = await fd.readFile('utf-8')
    } finally {
      await fd.close()
    }
    return { action: 'read', path: filePath, content, size: content.length }
  } catch {
    return { action: 'read', path: filePath, content: 'Error: file not found' }
  }
}

export async function deleteFileInSandbox(
  conversationId: string,
  filePath: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return deleteFileInE2B(conversationId, filePath, localRoot)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const resolved = join(sandboxDir, filePath)
  if (!isInsideSandbox(sandboxDir, resolved)) {
    return { action: 'deleted', path: filePath }
  }
  try {
    await unlink(resolved)
    return { action: 'deleted', path: filePath }
  } catch {
    return { action: 'deleted', path: filePath, content: 'Error: file not found' }
  }
}

// Listing limits — guard against poisoned sandboxes that can OOM the response
// or stack-overflow the recursive walk.
const MAX_LIST_DEPTH = 10
const MAX_LIST_FILES = 5000

// Shared file-size cap for HTTP file serving (sandbox + files routes).
// Keep this generous enough for long manuscripts, exported HTML/PDFs, and
// image-heavy artifacts while still bounding single-response memory usage.
export const MAX_SANDBOX_FILE_SIZE = 100 * 1024 * 1024

export interface SandboxFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: number
}

export async function readSandboxFileBytes(
  conversationId: string,
  filePath: string,
): Promise<SandboxFileReadResult> {
  if (shouldUseE2BSandbox()) {
    return readE2BFileBytes(conversationId, filePath, MAX_SANDBOX_FILE_SIZE)
  }

  const sandboxDir = getSandboxDirPath(conversationId)
  const resolved = join(sandboxDir, filePath)
  const rel = relative(sandboxDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, status: 403, error: 'Invalid path' }
  }
  if (!await resolveAndVerify(sandboxDir, resolved)) {
    return { ok: false, status: 403, error: 'Invalid path' }
  }

  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    const fileStat = await file.stat()
    if (fileStat.size > MAX_SANDBOX_FILE_SIZE) {
      return { ok: false, status: 413, error: 'File too large' }
    }
    const body = await file.readFile()
    return { ok: true, body: new Uint8Array(body), size: body.byteLength }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') {
      return { ok: false, status: 403, error: 'Invalid path' }
    }
    return { ok: false, status: 404, error: 'File not found' }
  } finally {
    await file?.close()
  }
}

export async function writeSandboxFileBytes(
  conversationId: string,
  filePath: string,
  body: Uint8Array,
): Promise<void> {
  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  if (shouldUseE2BSandbox()) {
    await writeFileBytesInE2B(conversationId, filePath, body, sandboxDir)
    return
  }

  const resolved = join(sandboxDir, filePath)
  const rel = relative(sandboxDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid sandbox path')
  }

  let ancestor = dirname(resolved)
  while (true) {
    try {
      await stat(ancestor)
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  if (!await resolveAndVerify(sandboxDir, ancestor)) {
    throw new Error('Invalid sandbox path')
  }

  await mkdir(dirname(resolved), { recursive: true })
  const fd = await open(
    resolved,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  )
  try {
    await fd.writeFile(body)
  } finally {
    await fd.close()
  }

  if (!await resolveAndVerify(sandboxDir, resolved)) {
    try { await unlink(resolved) } catch { /* best effort */ }
    throw new Error('Sandbox output path escaped sandbox')
  }
}

export async function syncCloudSandboxToLocal(conversationId: string): Promise<void> {
  if (!shouldUseE2BSandbox()) return
  const localRoot = await getOrCreateSandboxDir(conversationId)
  await syncE2BWorkspaceToLocal(conversationId, localRoot, MAX_SANDBOX_FILE_SIZE)
}

export async function pauseSandboxIfIdle(conversationId: string): Promise<void> {
  if (!shouldUseE2BSandbox()) return
  await pauseE2BSandbox(conversationId)
}

export async function fileExistsInActiveSandbox(conversationId: string, filePath: string): Promise<boolean> {
  if (shouldUseE2BSandbox()) return e2bFileExists(conversationId, filePath)

  const sandboxDir = getSandboxDirPath(conversationId)
  const resolved = join(sandboxDir, filePath)
  const rel = relative(sandboxDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  if (!await resolveAndVerify(sandboxDir, resolved)) return false
  try {
    const fileStat = await stat(resolved)
    return fileStat.isFile()
  } catch {
    return false
  }
}

export async function listSandboxFilesDetailed(
  conversationId: string,
): Promise<{ files: SandboxFileInfo[]; truncated: boolean }> {
  if (shouldUseE2BSandbox()) {
    return listE2BFilesDetailed(conversationId)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const files: SandboxFileInfo[] = []
  let truncated = false
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sandboxDir, depth: 0 }]

  while (stack.length > 0) {
    if (files.length >= MAX_LIST_FILES) {
      truncated = true
      break
    }

    const { dir, depth } = stack.pop()!
    if (depth > MAX_LIST_DEPTH) {
      truncated = true
      continue
    }

    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) {
        truncated = true
        break
      }
      if (shouldSkipSandboxEntry(entry.name)) continue

      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (await resolveAndVerify(sandboxDir, fullPath)) {
          stack.push({ dir: fullPath, depth: depth + 1 })
        }
        continue
      }

      if (!entry.isFile()) continue
      if (!await resolveAndVerify(sandboxDir, fullPath)) continue

      try {
        const s = await lstat(fullPath)
        files.push({
          name: entry.name,
          path: relative(sandboxDir, fullPath),
          size: s.size,
          modifiedAt: s.mtimeMs,
        })
      } catch {
        // File may have disappeared between readdir and stat.
      }
    }
  }

  files.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { files, truncated }
}

export async function listFilesInSandbox(
  conversationId: string,
  directory?: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    return listFilesInE2B(conversationId, directory)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const targetDir = directory ? join(sandboxDir, directory) : sandboxDir
  if (targetDir !== sandboxDir && !isInsideSandbox(sandboxDir, targetDir)) {
    return { action: 'listed', path: directory || '.', files: [] }
  }
  if (!await resolveAndVerify(sandboxDir, targetDir)) {
    return { action: 'listed', path: directory || '.', files: [] }
  }

  const files: string[] = []
  let truncated = false
  async function walk(dir: string, depth: number) {
    if (depth > MAX_LIST_DEPTH || files.length >= MAX_LIST_FILES) {
      truncated = true
      return
    }
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (files.length >= MAX_LIST_FILES) {
          truncated = true
          return
        }
        if (shouldSkipSandboxEntry(entry.name)) continue
        const full = join(dir, entry.name)

        if (!await resolveAndVerify(sandboxDir, full)) continue
        if (entry.isSymbolicLink()) continue

        if (entry.isDirectory()) {
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          files.push(relative(sandboxDir, full))
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  await walk(targetDir, 0)
  return { action: 'listed', path: directory || '.', files, truncated }
}

export async function editFileInSandbox(
  conversationId: string,
  filePath: string,
  oldString: string,
  newString: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return editFileInE2B(conversationId, filePath, oldString, newString, localRoot)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const resolved = join(sandboxDir, filePath)
  if (!isInsideSandbox(sandboxDir, resolved)) {
    return { action: 'edited', path: filePath, error: 'File edit blocked: path traversal not allowed' }
  }
  try {
    if (!await resolveAndVerify(sandboxDir, resolved)) {
      return { action: 'edited', path: filePath, error: 'File edit blocked: path traversal not allowed' }
    }
    let readFd: Awaited<ReturnType<typeof open>>
    try {
      readFd = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'EMLINK') {
        return { action: 'edited', path: filePath, error: 'File edit blocked: path traversal not allowed' }
      }
      throw err
    }
    let content: string
    try {
      content = await readFd.readFile('utf-8')
    } finally {
      await readFd.close()
    }
    const idx = content.indexOf(oldString)
    if (idx === -1) {
      return {
        action: 'edited',
        path: filePath,
        error: 'INTERNAL_RECOVERY: edit_file did not apply because old_string did not match the current file. Read the file for fresh content, then retry with an exact current string or use append_file if extending. Do not show this internal edit error to the user.',
      }
    }
    const updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
    // O_NOFOLLOW closes the TOCTOU window between resolveAndVerify above and the
    // write — without it, a symlink raced into place between the two would be
    // followed and the target file outside the sandbox would be overwritten.
    let editFd: Awaited<ReturnType<typeof open>>
    try {
      editFd = await open(
        resolved,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ELOOP' || code === 'EMLINK') {
        return { action: 'edited', path: filePath, error: 'File edit blocked: path traversal not allowed' }
      }
      throw err
    }
    try {
      await editFd.writeFile(updated, 'utf-8')
    } finally {
      await editFd.close()
    }
    const s = await stat(resolved)
    return { action: 'edited', path: filePath, content: updated, size: s.size }
  } catch {
    return {
      action: 'edited',
      path: filePath,
      error: 'INTERNAL_RECOVERY: edit_file could not read the target file. Read/list files to find the correct path, or use create_file if this should be a new file. Do not show this internal edit error to the user.',
    }
  }
}

export async function appendFileInSandbox(
  conversationId: string,
  filePath: string,
  content: string
): Promise<FileResult> {
  if (shouldUseE2BSandbox()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return appendFileInE2B(conversationId, filePath, content, localRoot)
  }

  const sandboxDir = await getOrCreateSandboxDir(conversationId)
  const resolved = join(sandboxDir, filePath)
  if (!isInsideSandbox(sandboxDir, resolved)) {
    return { action: 'appended', path: filePath, content: 'Error: path traversal not allowed' }
  }

  let ancestor = dirname(resolved)
  while (true) {
    try {
      await stat(ancestor)
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  if (!await resolveAndVerify(sandboxDir, ancestor)) {
    return { action: 'appended', path: filePath, content: 'Error: path traversal not allowed' }
  }

  await mkdir(dirname(resolved), { recursive: true })

  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(
      resolved,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o644,
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') {
      return { action: 'appended', path: filePath, content: 'Error: path traversal not allowed' }
    }
    throw err
  }
  try {
    await fd.writeFile(content, 'utf-8')
  } finally {
    await fd.close()
  }

  if (!await resolveAndVerify(sandboxDir, resolved)) {
    try { await unlink(resolved) } catch { /* best effort */ }
    return { action: 'appended', path: filePath, content: 'Error: path traversal not allowed' }
  }

  const s = await stat(resolved)
  return { action: 'appended', path: filePath, size: s.size }
}

export async function destroySandbox(conversationId: string): Promise<void> {
  if (shouldUseE2BSandbox()) {
    await destroyE2BSandbox(conversationId)
  }
  const entry = sandboxDirs.get(conversationId)
  if (!entry) return
  sandboxDirs.delete(conversationId)
  try {
    await rm(entry.path, { recursive: true, force: true })
  } catch {
    // Best effort cleanup
  }
}

export async function destroyAllSandboxes(): Promise<void> {
  const ids = Array.from(sandboxDirs.keys())
  await Promise.all(ids.map((id) => destroySandbox(id)))
}

// Idle cleanup: remove sandboxes inactive for 15+ minutes
const cleanupInterval = setInterval(async () => {
  const now = Date.now()
  const toDestroy: string[] = []
  for (const [id, entry] of sandboxDirs) {
    if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
      sandboxDirs.delete(id)
      toDestroy.push(entry.path)
    }
  }
  for (const p of toDestroy) {
    try { await rm(p, { recursive: true, force: true }) } catch {}
  }
}, CLEANUP_INTERVAL_MS)

// Don't prevent process exit
if (cleanupInterval.unref) {
  cleanupInterval.unref()
}
