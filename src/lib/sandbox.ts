import { mkdir, rm, stat, unlink, readdir, realpath, open, lstat } from 'fs/promises'
import { constants } from 'fs'
import type { Dirent } from 'fs'
import { tmpdir } from 'os'
import { join, relative, dirname, isAbsolute } from 'path'
import type { FileResult } from '@/types'
import { acquireRegisteredBrowserSessionFence } from './browserSessionLifecycle'
import { markdownAppendStructureConflict, trimReplayedAppendOverlap } from './fileAppend'

export type SandboxFileReadResult =
  | { ok: true; body: Uint8Array; size: number }
  | { ok: false; status: number; error: string }

type E2BSandboxModule = typeof import('./e2bSandbox')

let e2bModulePromise: Promise<E2BSandboxModule> | null = null

function sandboxProvider(): string {
  return process.env.AGENT_SANDBOX_PROVIDER?.trim().toLowerCase() || ''
}

function shouldUseE2BProvider(): boolean {
  return sandboxProvider() === 'e2b'
}

async function e2bSandbox(): Promise<E2BSandboxModule> {
  if (!e2bModulePromise) e2bModulePromise = import('./e2bSandbox')
  return e2bModulePromise
}

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const IGNORED_SANDBOX_DIRECTORIES = new Set([
  'node_modules', '.git', '__pycache__',
  '.agent', '.browser-profile',
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
  return shouldUseE2BProvider()
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
  if (shouldUseE2BProvider()) await (await e2bSandbox()).getOrCreateE2BSandbox(safeId)
  return dir
}

export async function resetSandboxDir(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const releaseBrowserFence = await acquireRegisteredBrowserSessionFence(safeId)
  try {
    const dir = await resetLocalSandboxDir(safeId)
    if (shouldUseE2BProvider()) await (await e2bSandbox()).resetE2BSandbox(safeId)
    return dir
  } finally {
    releaseBrowserFence()
  }
}

export async function executeInSandbox(
  conversationId: string,
  command: string,
  onOutput?: OutputCallback,
  signal?: AbortSignal,
): Promise<ExecResult> {
  if (shouldUseE2BProvider()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return (await e2bSandbox()).executeCommandInE2B(
      conversationId,
      command,
      onOutput,
      localRoot,
      MAX_SANDBOX_FILE_SIZE,
      signal,
    )
  }

  await getOrCreateSandboxDir(conversationId)
  const startTime = Date.now()
  return {
    stdout: '',
    stderr: 'Command execution is disabled because no isolated task runner is configured.',
    exitCode: 1,
    durationMs: Date.now() - startTime,
    timedOut: false,
  }
}

// --- File operations ---

export async function createFileInSandbox(
  conversationId: string,
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<FileResult> {
  if (shouldUseE2BProvider()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return (await e2bSandbox()).createFileInE2B(conversationId, filePath, content, localRoot, signal)
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
  filePath: string,
  signal?: AbortSignal,
): Promise<FileResult> {
  if (shouldUseE2BProvider()) {
    return (await e2bSandbox()).readFileInE2B(conversationId, filePath, MAX_SANDBOX_FILE_SIZE, signal)
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
  if (shouldUseE2BProvider()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return (await e2bSandbox()).deleteFileInE2B(conversationId, filePath, localRoot)
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
  if (shouldUseE2BProvider()) {
    return (await e2bSandbox()).readE2BFileBytes(conversationId, filePath, MAX_SANDBOX_FILE_SIZE)
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
  if (shouldUseE2BProvider()) {
    await (await e2bSandbox()).writeFileBytesInE2B(conversationId, filePath, body, sandboxDir)
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

const ZIP_MAX_SOURCE_FILES = 100
const ZIP_MAX_TOTAL_SOURCE_BYTES = 100 * 1024 * 1024

function normalizeArchivePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized === '.' || normalized.split('/').some(part => part === '..')) return null
  return normalized
}

let crc32Table: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let value = n
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
      crc32Table[n] = value >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of bytes) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function zipHeader(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

/** Create a portable, uncompressed ZIP without relying on shell utilities. */
export async function packageFilesInSandbox(
  conversationId: string,
  outputPath: string,
  sourcePaths: string[],
): Promise<FileResult> {
  const normalizedOutput = normalizeArchivePath(outputPath)
  if (!normalizedOutput || !normalizedOutput.toLowerCase().endsWith('.zip')) {
    return { action: 'packaged', path: outputPath, error: 'The archive output path must be a safe .zip path.' }
  }
  const normalizedSources = [...new Set(sourcePaths.map(normalizeArchivePath).filter((path): path is string => !!path))]
  if (normalizedSources.length === 0) {
    return { action: 'packaged', path: normalizedOutput, error: 'At least one existing source file is required.' }
  }
  if (normalizedSources.length > ZIP_MAX_SOURCE_FILES) {
    return { action: 'packaged', path: normalizedOutput, error: `Too many source files (maximum ${ZIP_MAX_SOURCE_FILES}).` }
  }
  if (normalizedSources.includes(normalizedOutput)) {
    return { action: 'packaged', path: normalizedOutput, error: 'The output archive cannot include itself.' }
  }

  const entries: Array<{ path: string; name: Uint8Array; body: Uint8Array; crc: number; offset: number }> = []
  let sourceBytes = 0
  const encoder = new TextEncoder()
  for (const path of normalizedSources) {
    const read = await readSandboxFileBytes(conversationId, path)
    if (!read.ok) return { action: 'packaged', path: normalizedOutput, error: `Source file not found: ${path}` }
    sourceBytes += read.size
    if (sourceBytes > ZIP_MAX_TOTAL_SOURCE_BYTES) {
      return { action: 'packaged', path: normalizedOutput, error: 'Archive sources exceed the 100 MB limit.' }
    }
    const name = encoder.encode(path)
    if (name.byteLength > 0xffff) return { action: 'packaged', path: normalizedOutput, error: `Source path is too long: ${path}` }
    entries.push({ path, name, body: read.body, crc: crc32(read.body), offset: 0 })
  }

  const localChunks: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    entry.offset = localOffset
    const header = zipHeader(30, view => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 0, true)
      view.setUint16(8, 0, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint32(14, entry.crc, true)
      view.setUint32(18, entry.body.byteLength, true)
      view.setUint32(22, entry.body.byteLength, true)
      view.setUint16(26, entry.name.byteLength, true)
      view.setUint16(28, 0, true)
    })
    localChunks.push(header, entry.name, entry.body)
    localOffset += header.byteLength + entry.name.byteLength + entry.body.byteLength
  }

  const centralChunks: Uint8Array[] = []
  let centralSize = 0
  for (const entry of entries) {
    const header = zipHeader(46, view => {
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(8, 0, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint16(14, 0, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, entry.body.byteLength, true)
      view.setUint32(24, entry.body.byteLength, true)
      view.setUint16(28, entry.name.byteLength, true)
      view.setUint16(30, 0, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, entry.offset, true)
    })
    centralChunks.push(header, entry.name)
    centralSize += header.byteLength + entry.name.byteLength
  }

  const end = zipHeader(22, view => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, entries.length, true)
    view.setUint16(10, entries.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, localOffset, true)
    view.setUint16(20, 0, true)
  })
  const archive = concatBytes([...localChunks, ...centralChunks, end])
  await writeSandboxFileBytes(conversationId, normalizedOutput, archive)
  return {
    action: 'packaged',
    path: normalizedOutput,
    size: archive.byteLength,
    files: normalizedSources,
  }
}

/**
 * Save an editable HTML/CSS/JS source set and a self-contained HTML bundle.
 * The bundle is the previewable deliverable; source files remain available in
 * Project Files and can also be packaged into a ZIP.
 */
export async function createWebsiteBundleInSandbox(
  conversationId: string,
  outputPath: string,
  html: string,
  css: string,
  javascript: string,
): Promise<FileResult> {
  const normalizedOutput = normalizeArchivePath(outputPath || 'index.html')
  if (!normalizedOutput || !normalizedOutput.toLowerCase().endsWith('.html')) {
    return { action: 'created', path: outputPath, error: 'The bundled website output must use a safe .html path.' }
  }
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) {
    return { action: 'created', path: normalizedOutput, error: 'Website HTML must be a complete document containing html and body elements.' }
  }
  if (css.trim().length < 80) {
    return { action: 'created', path: normalizedOutput, error: 'Website CSS is too short to be a substantive design.' }
  }

  const sourceHtmlPath = 'website-src/index.html'
  const sourceCssPath = 'website-src/styles.css'
  const sourceJsPath = 'website-src/script.js'
  const sourceHtml = html
    .replace(/<link\b[^>]*href=["'](?:\.\/)?styles\.css["'][^>]*>\s*/gi, '')
    .replace(/<script\b[^>]*src=["'](?:\.\/)?script\.js["'][^>]*>\s*<\/script>\s*/gi, '')
  const styleBlock = `\n<style>\n${css.trim()}\n</style>\n`
  const scriptBlock = javascript.trim() ? `\n<script>\n${javascript.trim()}\n</script>\n` : ''
  const editableSourceHtml = sourceHtml
    .replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>')
    .replace(/<\/body>/i, `${javascript.trim() ? '  <script src="script.js"></script>\n' : ''}</body>`)
  let bundled = /<\/head>/i.test(sourceHtml)
    ? sourceHtml.replace(/<\/head>/i, `${styleBlock}</head>`)
    : sourceHtml.replace(/<body\b/i, `${styleBlock}<body`)
  bundled = /<\/body>/i.test(bundled)
    ? bundled.replace(/<\/body>/i, `${scriptBlock}</body>`)
    : `${bundled}${scriptBlock}`

  const writes = [
    await createFileInSandbox(conversationId, sourceHtmlPath, `${editableSourceHtml.trim()}\n`),
    await createFileInSandbox(conversationId, sourceCssPath, `${css.trim()}\n`),
    await createFileInSandbox(conversationId, sourceJsPath, `${javascript.trim()}\n`),
    await createFileInSandbox(conversationId, normalizedOutput, `${bundled.trim()}\n`),
  ]
  const failed = writes.find(result => result.size === undefined)
  if (failed) {
    return { action: 'created', path: normalizedOutput, error: failed.error || failed.content || 'Website files could not be saved.' }
  }
  return {
    action: 'created',
    path: normalizedOutput,
    size: writes[writes.length - 1].size,
    files: [sourceHtmlPath, sourceCssPath, sourceJsPath, normalizedOutput],
  }
}

export async function syncCloudSandboxToLocal(conversationId: string): Promise<void> {
  if (!shouldUseE2BProvider()) return
  const localRoot = await getOrCreateSandboxDir(conversationId)
  await (await e2bSandbox()).syncE2BWorkspaceToLocal(conversationId, localRoot, MAX_SANDBOX_FILE_SIZE)
}

export async function pauseSandboxIfIdle(conversationId: string): Promise<void> {
  if (!shouldUseE2BProvider()) return
  await (await e2bSandbox()).pauseE2BSandbox(conversationId)
}

export async function fileExistsInActiveSandbox(conversationId: string, filePath: string): Promise<boolean> {
  if (shouldUseE2BProvider()) return (await e2bSandbox()).e2bFileExists(conversationId, filePath)

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
  if (shouldUseE2BProvider()) {
    return (await e2bSandbox()).listE2BFilesDetailed(conversationId)
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
  if (shouldUseE2BProvider()) {
    return (await e2bSandbox()).listFilesInE2B(conversationId, directory)
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
  newString: string,
  signal?: AbortSignal,
): Promise<FileResult> {
  if (shouldUseE2BProvider()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return (await e2bSandbox()).editFileInE2B(conversationId, filePath, oldString, newString, localRoot, signal)
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
  content: string,
  signal?: AbortSignal,
): Promise<FileResult> {
  if (shouldUseE2BProvider()) {
    const localRoot = await getOrCreateSandboxDir(conversationId)
    return (await e2bSandbox()).appendFileInE2B(conversationId, filePath, content, localRoot, signal)
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

  let appendContent = content
  let existingContent = ''
  try {
    const readFd = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      existingContent = await readFd.readFile('utf-8')
      appendContent = trimReplayedAppendOverlap(existingContent, content)
    } finally {
      await readFd.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        action: 'appended',
        path: filePath,
        error: 'INTERNAL_RECOVERY: append_file requires an existing file. Start a new report with create_file, then append only continuation sections.',
      }
    }
    throw err
  }

  if (!appendContent) {
    const existingStat = await stat(resolved)
    return { action: 'appended', path: filePath, size: existingStat.size }
  }

  if (/\.md(?:own)?$/i.test(filePath)) {
    const structureConflict = markdownAppendStructureConflict(existingContent, appendContent)
    if (structureConflict) {
      return {
        action: 'appended',
        path: filePath,
        error: `INTERNAL_RECOVERY: append_file was blocked because it would corrupt the Markdown report structure: ${structureConflict}. Read the existing report and use edit_file to merge, replace, or reorder the existing section instead. Do not append another title or repeated section.`,
      }
    }
  }

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
    await fd.writeFile(appendContent, 'utf-8')
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
  const safeId = sanitizeConversationId(conversationId)
  const releaseBrowserFence = await acquireRegisteredBrowserSessionFence(safeId)
  try {
    if (shouldUseE2BProvider()) {
      await (await e2bSandbox()).destroyE2BSandbox(safeId)
    }
    const entry = sandboxDirs.get(safeId)
    sandboxDirs.delete(safeId)
    try {
      // The process-local registry is only a cache. After a crash/restart it can
      // be empty while the deterministic sandbox directory still exists.
      await rm(entry?.path ?? getSandboxDirPath(safeId), { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
  } finally {
    releaseBrowserFence()
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
