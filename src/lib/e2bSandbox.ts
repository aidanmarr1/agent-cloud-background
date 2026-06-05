import { constants } from 'fs'
import { mkdir, open, rm } from 'fs/promises'
import { dirname, join, relative, isAbsolute, basename, posix } from 'path'
import type { FileResult } from '@/types'
import { getTursoSetupStatus, tursoExecute } from '@/lib/db/turso'

type E2BSandboxInstance = Awaited<ReturnType<typeof import('e2b').Sandbox.create>>

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const DEFAULT_E2B_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_E2B_COMMAND_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_E2B_BROWSER_PORT = 9222
const MAX_LIST_DEPTH = 10
const MAX_LIST_FILES = 5000
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '__pycache__',
  '.agent',
  'venv', '.venv', 'env',
  'Library', '.matplotlib', '.cache', '.local', '.pip', '.fontconfig',
])

interface CachedE2BSandbox {
  sandboxId: string
  sandbox: E2BSandboxInstance
  lastUsed: number
}

export interface E2BFileInfo {
  name: string
  path: string
  size: number
  modifiedAt: number
}

export type SandboxFileReadResult =
  | { ok: true; body: Uint8Array; size: number }
  | { ok: false; status: 403 | 404 | 413 | 500; error: string }

const e2bCache = new Map<string, CachedE2BSandbox>()
let schemaReady: Promise<void> | null = null

function envString(name: string): string {
  return process.env[name]?.trim() || ''
}

function envPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(envString(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const value = envString(name).toLowerCase()
  if (!value) return fallback
  return value === '1' || value === 'true' || value === 'yes'
}

function sanitizeConversationId(conversationId: string): string {
  if (!SAFE_TASK_ID.test(conversationId)) {
    throw new Error('Invalid task id: must contain only alphanumeric, hyphens, underscores')
  }
  return conversationId
}

function workspaceRoot(conversationId: string): string {
  const base = envString('AGENT_E2B_WORKSPACE_ROOT') || '/home/user/agent-workspaces'
  return `${base.replace(/\/+$/, '')}/${sanitizeConversationId(conversationId)}`
}

function normalizeRelativePath(filePath: string, allowRoot = false): string | null {
  const normalized = posix.normalize(String(filePath || '').replace(/\\/g, '/').replace(/^\.?\/+/, ''))
  if (!normalized || normalized === '.') return allowRoot ? '' : null
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null
  return normalized
}

function remotePath(conversationId: string, filePath: string, allowRoot = false): { relativePath: string; absolutePath: string } | null {
  const relativePath = normalizeRelativePath(filePath, allowRoot)
  if (relativePath === null) return null
  const root = workspaceRoot(conversationId)
  return {
    relativePath,
    absolutePath: relativePath ? `${root}/${relativePath}` : root,
  }
}

function shouldSkipEntry(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name)
}

function tursoConfigured(): boolean {
  return getTursoSetupStatus().configured
}

async function ensureSchema(): Promise<void> {
  if (!tursoConfigured()) return
  if (!schemaReady) {
    schemaReady = (async () => {
      await tursoExecute(`
        create table if not exists agent_cloud_sandboxes (
          conversation_id text primary key,
          provider text not null,
          provider_sandbox_id text not null,
          created_at_ms integer not null,
          updated_at_ms integer not null,
          last_used_at_ms integer not null
        )
      `)
    })()
  }
  await schemaReady
}

async function loadPersistedSandboxId(conversationId: string): Promise<string | null> {
  if (!tursoConfigured()) return null
  await ensureSchema()
  const result = await tursoExecute(
    `
      select provider_sandbox_id
      from agent_cloud_sandboxes
      where conversation_id = ? and provider = 'e2b'
      limit 1
    `,
    [conversationId],
  )
  const row = result.rows[0]
  return typeof row?.provider_sandbox_id === 'string' ? row.provider_sandbox_id : null
}

async function persistSandboxId(conversationId: string, sandboxId: string): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  const now = Date.now()
  await tursoExecute(
    `
      insert into agent_cloud_sandboxes (
        conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms, last_used_at_ms
      )
      values (?, 'e2b', ?, ?, ?, ?)
      on conflict(conversation_id) do update set
        provider = 'e2b',
        provider_sandbox_id = excluded.provider_sandbox_id,
        updated_at_ms = excluded.updated_at_ms,
        last_used_at_ms = excluded.last_used_at_ms
    `,
    [conversationId, sandboxId, now, now, now],
  )
}

async function touchSandbox(conversationId: string): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  const now = Date.now()
  await tursoExecute(
    `
      update agent_cloud_sandboxes
      set updated_at_ms = ?, last_used_at_ms = ?
      where conversation_id = ? and provider = 'e2b'
    `,
    [now, now, conversationId],
  )
}

async function deletePersistedSandboxId(conversationId: string): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  await tursoExecute(
    `delete from agent_cloud_sandboxes where conversation_id = ? and provider = 'e2b'`,
    [conversationId],
  )
}

async function createSandbox(conversationId: string): Promise<E2BSandboxInstance> {
  if (!envString('E2B_API_KEY')) {
    throw new Error('E2B is not configured. Missing: E2B_API_KEY')
  }

  const { Sandbox } = await import('e2b')
  const sandbox = await Sandbox.create({
    template: envString('E2B_TEMPLATE_ID') || undefined,
    apiKey: envString('E2B_API_KEY'),
    timeoutMs: envPositiveInt('AGENT_E2B_SANDBOX_TIMEOUT_MS', DEFAULT_E2B_TIMEOUT_MS),
    allowInternetAccess: envBool('AGENT_E2B_ALLOW_INTERNET', true),
    secure: true,
    metadata: {
      app: 'agent',
      conversationId,
    },
  })
  await sandbox.files.makeDir(workspaceRoot(conversationId)).catch(() => undefined)
  await persistSandboxId(conversationId, sandbox.sandboxId)
  return sandbox
}

async function connectSandbox(conversationId: string, sandboxId: string): Promise<E2BSandboxInstance | null> {
  try {
    const { Sandbox } = await import('e2b')
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: envString('E2B_API_KEY'),
      timeoutMs: envPositiveInt('AGENT_E2B_SANDBOX_TIMEOUT_MS', DEFAULT_E2B_TIMEOUT_MS),
    })
    await sandbox.files.makeDir(workspaceRoot(conversationId)).catch(() => undefined)
    await touchSandbox(conversationId)
    return sandbox
  } catch (error) {
    console.warn('[E2B] Could not connect to existing sandbox; creating a replacement', {
      conversationId,
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

export function shouldUseE2BSandbox(): boolean {
  return envString('AGENT_SANDBOX_PROVIDER').toLowerCase() === 'e2b'
}

export function getE2BSetupStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = []
  if (!envString('E2B_API_KEY')) missing.push('E2B_API_KEY')
  return { configured: missing.length === 0, missing }
}

export async function getOrCreateE2BSandbox(conversationId: string): Promise<E2BSandboxInstance> {
  const safeId = sanitizeConversationId(conversationId)
  const cached = e2bCache.get(safeId)
  if (cached) {
    cached.lastUsed = Date.now()
    return cached.sandbox
  }

  const persistedId = await loadPersistedSandboxId(safeId)
  const connected = persistedId ? await connectSandbox(safeId, persistedId) : null
  const sandbox = connected || await createSandbox(safeId)

  e2bCache.set(safeId, {
    sandboxId: sandbox.sandboxId,
    sandbox,
    lastUsed: Date.now(),
  })
  return sandbox
}

export async function resetE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  const existing = e2bCache.get(safeId)?.sandboxId || await loadPersistedSandboxId(safeId)
  e2bCache.delete(safeId)
  await deletePersistedSandboxId(safeId)

  if (existing && envBool('AGENT_E2B_KILL_ON_RESET', true)) {
    try {
      const { Sandbox } = await import('e2b')
      await Sandbox.kill(existing, { apiKey: envString('E2B_API_KEY') })
    } catch {
      // The sandbox may already be gone or paused past its retention window.
    }
  }

  await getOrCreateE2BSandbox(safeId)
}

export async function pauseE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  const sandboxId = e2bCache.get(safeId)?.sandboxId || await loadPersistedSandboxId(safeId)
  if (!sandboxId || !envBool('AGENT_E2B_PAUSE_ON_TASK_END', true)) return

  try {
    const { Sandbox } = await import('e2b')
    await Sandbox.pause(sandboxId, { apiKey: envString('E2B_API_KEY') })
    e2bCache.delete(safeId)
  } catch (error) {
    console.warn('[E2B] Could not pause sandbox', {
      conversationId: safeId,
      sandboxId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function destroyE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  const sandboxId = e2bCache.get(safeId)?.sandboxId || await loadPersistedSandboxId(safeId)
  e2bCache.delete(safeId)
  await deletePersistedSandboxId(safeId)

  if (!sandboxId) return
  try {
    const { Sandbox } = await import('e2b')
    await Sandbox.kill(sandboxId, { apiKey: envString('E2B_API_KEY') })
  } catch {
    // Best effort cleanup.
  }
}

async function writeLocalMirror(localRoot: string, relativePath: string, body: Uint8Array | string): Promise<void> {
  const resolved = join(localRoot, relativePath)
  const rel = relative(localRoot, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return

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
}

async function removeLocalMirror(localRoot: string, relativePath: string): Promise<void> {
  const resolved = join(localRoot, relativePath)
  const rel = relative(localRoot, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
  await rm(resolved, { recursive: true, force: true }).catch(() => undefined)
}

export async function syncE2BWorkspaceToLocal(conversationId: string, localRoot: string, maxFileBytes: number): Promise<void> {
  const listed = await listE2BFilesDetailed(conversationId)
  for (const file of listed.files) {
    if (file.size > maxFileBytes) continue
    const read = await readE2BFileBytes(conversationId, file.path, maxFileBytes)
    if (read.ok) await writeLocalMirror(localRoot, file.path, read.body)
  }
}

export async function executeCommandInE2B(
  conversationId: string,
  command: string,
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void,
  localMirrorRoot?: string,
  maxFileBytes?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean }> {
  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const startTime = Date.now()
  try {
    const result = await sandbox.commands.run(command, {
      cwd: workspaceRoot(conversationId),
      timeoutMs: envPositiveInt('AGENT_E2B_COMMAND_TIMEOUT_MS', DEFAULT_E2B_COMMAND_TIMEOUT_MS),
      onStdout: (data) => onOutput?.('stdout', data),
      onStderr: (data) => onOutput?.('stderr', data),
    })
    if (localMirrorRoot && maxFileBytes) {
      await syncE2BWorkspaceToLocal(conversationId, localMirrorRoot, maxFileBytes).catch(() => undefined)
    }
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
      timedOut: false,
    }
  } catch (error) {
    const candidate = error as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; error?: unknown; message?: unknown }
    const message = typeof candidate.message === 'string' ? candidate.message : String(error)
    return {
      stdout: typeof candidate.stdout === 'string' ? candidate.stdout : '',
      stderr: typeof candidate.stderr === 'string'
        ? candidate.stderr
        : typeof candidate.error === 'string'
          ? candidate.error
          : message,
      exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : 1,
      durationMs: Date.now() - startTime,
      timedOut: /timed?\s*out|timeout/i.test(message),
    }
  }
}

export async function createFileInE2B(conversationId: string, filePath: string, content: string, localMirrorRoot?: string): Promise<FileResult> {
  const target = remotePath(conversationId, filePath)
  if (!target) return { action: 'created', path: filePath, content: 'Error: path traversal not allowed' }

  const sandbox = await getOrCreateE2BSandbox(conversationId)
  await sandbox.files.write(target.absolutePath, content)
  if (localMirrorRoot) await writeLocalMirror(localMirrorRoot, target.relativePath, content).catch(() => undefined)
  return { action: 'created', path: target.relativePath, size: Buffer.byteLength(content, 'utf8') }
}

export async function readFileInE2B(conversationId: string, filePath: string, maxFileBytes: number): Promise<FileResult> {
  const read = await readE2BFileBytes(conversationId, filePath, maxFileBytes)
  if (!read.ok) return { action: 'read', path: filePath, content: `Error: ${read.error.toLowerCase()}` }
  return {
    action: 'read',
    path: normalizeRelativePath(filePath) || filePath,
    content: Buffer.from(read.body).toString('utf8'),
    size: read.size,
  }
}

export async function deleteFileInE2B(conversationId: string, filePath: string, localMirrorRoot?: string): Promise<FileResult> {
  const target = remotePath(conversationId, filePath)
  if (!target) return { action: 'deleted', path: filePath }

  const sandbox = await getOrCreateE2BSandbox(conversationId)
  await sandbox.files.remove(target.absolutePath).catch(() => undefined)
  if (localMirrorRoot) await removeLocalMirror(localMirrorRoot, target.relativePath)
  return { action: 'deleted', path: target.relativePath }
}

export async function listE2BFilesDetailed(conversationId: string): Promise<{ files: E2BFileInfo[]; truncated: boolean }> {
  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const root = workspaceRoot(conversationId)
  const files: E2BFileInfo[] = []
  let truncated = false

  async function walk(remoteDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_LIST_DEPTH || files.length >= MAX_LIST_FILES) {
      truncated = true
      return
    }

    let entries: Array<{ name: string; path: string; type?: unknown; size?: number; modifiedTime?: Date }> = []
    try {
      entries = await sandbox.files.list(remoteDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) {
        truncated = true
        return
      }
      if (!entry.name || shouldSkipEntry(entry.name)) continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const entryType = String(entry.type || '')

      if (entryType === 'dir') {
        await walk(entry.path || `${remoteDir}/${entry.name}`, childRel, depth + 1)
        continue
      }

      if (entryType && entryType !== 'file') continue
      files.push({
        name: entry.name,
        path: childRel,
        size: Math.max(0, Number(entry.size || 0)),
        modifiedAt: entry.modifiedTime instanceof Date ? entry.modifiedTime.getTime() : Date.now(),
      })
    }
  }

  await walk(root, '', 0)
  files.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { files, truncated }
}

export async function listFilesInE2B(conversationId: string, directory?: string): Promise<FileResult> {
  const target = remotePath(conversationId, directory || '', true)
  if (!target) return { action: 'listed', path: directory || '.', files: [] }

  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const files: string[] = []
  let truncated = false

  async function walk(remoteDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_LIST_DEPTH || files.length >= MAX_LIST_FILES) {
      truncated = true
      return
    }

    let entries: Array<{ name: string; path: string; type?: unknown }> = []
    try {
      entries = await sandbox.files.list(remoteDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_LIST_FILES) {
        truncated = true
        return
      }
      if (!entry.name || shouldSkipEntry(entry.name)) continue
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const entryType = String(entry.type || '')

      if (entryType === 'dir') {
        await walk(entry.path || `${remoteDir}/${entry.name}`, childRel, depth + 1)
      } else if (!entryType || entryType === 'file') {
        files.push(childRel)
      }
    }
  }

  await walk(target.absolutePath, target.relativePath, 0)
  return { action: 'listed', path: directory || '.', files, truncated }
}

export async function editFileInE2B(
  conversationId: string,
  filePath: string,
  oldString: string,
  newString: string,
  localMirrorRoot?: string,
): Promise<FileResult> {
  const target = remotePath(conversationId, filePath)
  if (!target) return { action: 'edited', path: filePath, error: 'File edit blocked: path traversal not allowed' }

  try {
    const sandbox = await getOrCreateE2BSandbox(conversationId)
    const content = await sandbox.files.read(target.absolutePath)
    const idx = content.indexOf(oldString)
    if (idx === -1) {
      return {
        action: 'edited',
        path: target.relativePath,
        error: 'INTERNAL_RECOVERY: edit_file did not apply because old_string did not match the current file. Read the file for fresh content, then retry with an exact current string or use append_file if extending. Do not show this internal edit error to the user.',
      }
    }
    const updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
    await sandbox.files.write(target.absolutePath, updated)
    if (localMirrorRoot) await writeLocalMirror(localMirrorRoot, target.relativePath, updated).catch(() => undefined)
    return { action: 'edited', path: target.relativePath, content: updated, size: Buffer.byteLength(updated, 'utf8') }
  } catch {
    return {
      action: 'edited',
      path: target.relativePath,
      error: 'INTERNAL_RECOVERY: edit_file could not read the target file. Read/list files to find the correct path, or use create_file if this should be a new file. Do not show this internal edit error to the user.',
    }
  }
}

export async function appendFileInE2B(conversationId: string, filePath: string, content: string, localMirrorRoot?: string): Promise<FileResult> {
  const target = remotePath(conversationId, filePath)
  if (!target) return { action: 'appended', path: filePath, content: 'Error: path traversal not allowed' }

  const sandbox = await getOrCreateE2BSandbox(conversationId)
  let previous = ''
  try {
    previous = await sandbox.files.read(target.absolutePath)
  } catch {
    previous = ''
  }
  const updated = `${previous}${content}`
  await sandbox.files.write(target.absolutePath, updated)
  if (localMirrorRoot) await writeLocalMirror(localMirrorRoot, target.relativePath, updated).catch(() => undefined)
  return { action: 'appended', path: target.relativePath, size: Buffer.byteLength(updated, 'utf8') }
}

export async function readE2BFileBytes(conversationId: string, filePath: string, maxFileBytes: number): Promise<SandboxFileReadResult> {
  const target = remotePath(conversationId, filePath)
  if (!target) return { ok: false, status: 403, error: 'Invalid path' }

  try {
    const sandbox = await getOrCreateE2BSandbox(conversationId)
    const info = await sandbox.files.getInfo(target.absolutePath)
    if (String(info.type || '') === 'dir') return { ok: false, status: 404, error: 'File not found' }
    if (info.size > maxFileBytes) return { ok: false, status: 413, error: 'File too large' }
    const body = await sandbox.files.read(target.absolutePath, { format: 'bytes' })
    return { ok: true, body, size: body.byteLength }
  } catch {
    return { ok: false, status: 404, error: 'File not found' }
  }
}

export async function e2bFileExists(conversationId: string, filePath: string): Promise<boolean> {
  const target = remotePath(conversationId, filePath)
  if (!target) return false
  try {
    const sandbox = await getOrCreateE2BSandbox(conversationId)
    const info = await sandbox.files.getInfo(target.absolutePath)
    return String(info.type || '') !== 'dir'
  } catch {
    return false
  }
}

export function e2bDisplayPath(filePath: string): string {
  return normalizeRelativePath(filePath) || basename(filePath) || 'output.md'
}

function e2bBrowserPort(): number {
  return envPositiveInt('AGENT_E2B_BROWSER_PORT', DEFAULT_E2B_BROWSER_PORT)
}

function hostToHttpUrl(host: string): string {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '')
  return `https://${host.replace(/\/+$/, '')}`
}

async function isE2BBrowserReady(endpoint: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_500)
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForE2BBrowser(endpoint: string): Promise<void> {
  const deadline = Date.now() + envPositiveInt('AGENT_E2B_BROWSER_START_TIMEOUT_MS', 30_000)
  while (Date.now() < deadline) {
    if (await isE2BBrowserReady(endpoint)) return
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error('Timed out waiting for E2B Chromium to expose its debugging endpoint.')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function ensureE2BRemoteBrowser(conversationId: string): Promise<string> {
  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const port = e2bBrowserPort()
  const endpoint = hostToHttpUrl(sandbox.getHost(port))
  if (await isE2BBrowserReady(endpoint)) return endpoint

  const root = workspaceRoot(conversationId)
  const profileDir = `${root}/.browser-profile`
  const logPath = `/tmp/agent-chromium-${sanitizeConversationId(conversationId)}.log`
  const bootstrap = envString('AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND')
  const bootstrapBlock = bootstrap
    ? `
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1; then
  ${bootstrap}
fi
`
    : ''

  const script = `
set -e
${bootstrapBlock}
CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true)"
if [ -z "$CHROME" ]; then
  echo "Chromium is not installed in this E2B template. Set E2B_TEMPLATE_ID to a template with Chromium, or set AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND." >&2
  exit 127
fi
mkdir -p ${shellQuote(profileDir)}
if command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:${port}/json/version >/dev/null 2>&1; then
  exit 0
fi
nohup "$CHROME" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=${port} \
  --user-data-dir=${shellQuote(profileDir)} \
  --window-size=1280,720 \
  about:blank > ${shellQuote(logPath)} 2>&1 < /dev/null &
`

  try {
    await sandbox.commands.run(`bash -lc ${JSON.stringify(script)}`, {
      cwd: root,
      timeoutMs: envPositiveInt('AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS', 30_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not start E2B Chromium. ${message}`)
  }

  await waitForE2BBrowser(endpoint)
  return endpoint
}

export async function writeFileBytesInE2B(
  conversationId: string,
  filePath: string,
  body: Uint8Array,
  localMirrorRoot?: string,
): Promise<void> {
  const target = remotePath(conversationId, filePath)
  if (!target) throw new Error('Invalid sandbox path')
  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const bytes = new ArrayBuffer(body.byteLength)
  new Uint8Array(bytes).set(body)
  await sandbox.files.write(target.absolutePath, bytes)
  if (localMirrorRoot) await writeLocalMirror(localMirrorRoot, target.relativePath, body).catch(() => undefined)
}
