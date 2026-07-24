import { constants } from 'fs'
import { randomUUID } from 'crypto'
import { mkdir, open, rm } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join, relative, isAbsolute, basename, posix } from 'path'
import type { FileResult } from '@/types'
import { getTursoSetupStatus, tursoExecute, tursoTransaction } from '@/lib/db/turso'

const require = createRequire(import.meta.url)
const { Sandbox } = require('e2b') as typeof import('e2b')

type E2BSandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>

const SAFE_TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/
const DEFAULT_E2B_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_E2B_COMMAND_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_E2B_BROWSER_PORT = 9222
const DEFAULT_E2B_WARM_POOL_MAX_AGE_MS = 15 * 60 * 1000
const MAX_LIST_DEPTH = 10
const MAX_LIST_FILES = 5000
const E2B_KILL_RETRY_ATTEMPTS = 3
const E2B_CACHE_VALIDATION_TTL_MS = 2_000
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '__pycache__',
  '.agent', '.browser-profile',
  'venv', '.venv', 'env',
  'Library', '.matplotlib', '.cache', '.local', '.pip', '.fontconfig',
])

interface CachedE2BSandbox {
  sandboxId: string
  sandbox: E2BSandboxInstance
  generation: number
  lastUsed: number
  billingStartedAtMs: number
  lastValidatedAtMs: number
}

interface WarmE2BSandbox {
  conversationId: string
  sandboxId: string
  sandbox: E2BSandboxInstance
  createdAt: number
  billingStartedAtMs: number
}

interface PersistedSandboxState {
  sandboxId: string | null
  generation: number
  sourceGeneration: number | null
  lifecycleState: 'active' | 'resetting' | 'destroying'
}

interface DurableLifecycleFence {
  sandboxId: string | null
  generation: number
  sourceGeneration: number
  lifecycleState: 'resetting' | 'destroying'
}

export interface E2BSandboxBillingDescriptor {
  providerSandboxId: string
  lifecycleGeneration: number
  startedAtMs: number
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
const e2bCreationPromises = new Map<string, Promise<E2BSandboxInstance>>()
const e2bLifecycleEpochs = new Map<string, number>()
const e2bLifecyclePromises = new Map<string, Promise<void>>()
const e2bQuarantinedSandboxIds = new Map<string, string>()
const e2bBrowserLaunchPromises = new Map<string, Promise<string>>()
let schemaReady: Promise<void> | null = null
let warmSandbox: WarmE2BSandbox | null = null
let warmSandboxPromise: Promise<WarmE2BSandbox> | null = null

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

class E2BSandboxKillError extends Error {
  constructor(readonly sandboxId: string, readonly cause: unknown) {
    super(`Could not confirm E2B sandbox ${sandboxId} was stopped.`)
    this.name = 'E2BSandboxKillError'
  }
}

function e2bSandboxAlreadyGone(error: unknown): boolean {
  const status = Number((error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode)
  const message = error instanceof Error ? error.message : String(error || '')
  return status === 404 || /\b(?:404|not found|does not exist|already (?:stopped|killed|closed)|no such sandbox)\b/i.test(message)
}

async function killE2BSandboxWithRetry(sandboxId: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < E2B_KILL_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await Sandbox.kill(sandboxId, { apiKey: envString('E2B_API_KEY') })
      return
    } catch (error) {
      if (e2bSandboxAlreadyGone(error)) return
      lastError = error
      if (attempt + 1 < E2B_KILL_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
      }
    }
  }
  throw new E2BSandboxKillError(sandboxId, lastError)
}

async function killTrackedE2BSandbox(conversationId: string, sandboxId: string): Promise<void> {
  e2bQuarantinedSandboxIds.set(sandboxId, conversationId)
  let trackingError: unknown = null
  if (tursoConfigured()) {
    try {
      await ensureSchema()
      await tursoExecute(
        `
          insert into agent_cloud_sandbox_orphans (provider_sandbox_id, conversation_id, provider, created_at_ms)
          values (?, ?, 'e2b', ?)
          on conflict(provider_sandbox_id) do update set conversation_id = excluded.conversation_id
        `,
        [sandboxId, conversationId, Date.now()],
      )
    } catch (error) {
      trackingError = error
    }
  }
  try {
    await killE2BSandboxWithRetry(sandboxId)
  } catch (killError) {
    if (trackingError) {
      throw new AggregateError([trackingError, killError], `Could not durably track or stop E2B sandbox ${sandboxId}.`)
    }
    throw killError
  }
  e2bQuarantinedSandboxIds.delete(sandboxId)
  if (tursoConfigured()) {
    await tursoExecute(
      `delete from agent_cloud_sandbox_orphans where provider_sandbox_id = ? and provider = 'e2b'`,
      [sandboxId],
    ).catch(() => undefined)
  }
}

async function reconcileKilledE2BSandboxBilling(
  conversationId: string,
  sandboxId: string,
  lifecycleGeneration: number,
  endedAtMs = Date.now(),
): Promise<void> {
  if (!tursoConfigured()) return
  const { reconcileServerE2BRuntimeBillingForSandbox } = await import('@/lib/serverCredits')
  const checkpoints = await reconcileServerE2BRuntimeBillingForSandbox({
    conversationId,
    providerSandboxId: sandboxId,
    lifecycleGeneration,
    endedAtMs,
  })
  if (checkpoints.some((checkpoint) => checkpoint.outOfCredits)) {
    console.warn('[E2B] Runtime billing exhausted the owning account during sandbox cleanup', {
      conversationId,
      lifecycleGeneration,
    })
  }
}

function quarantinedSandboxIdsForConversation(conversationId: string): string[] {
  return Array.from(e2bQuarantinedSandboxIds.entries())
    .filter(([, owner]) => owner === conversationId)
    .map(([sandboxId]) => sandboxId)
}

async function drainQuarantinedSandboxes(conversationId: string): Promise<void> {
  const ids = new Set(quarantinedSandboxIdsForConversation(conversationId))
  if (tursoConfigured()) {
    await ensureSchema()
    const persisted = await tursoExecute(
      `
        select provider_sandbox_id
        from agent_cloud_sandbox_orphans
        where conversation_id = ? and provider = 'e2b'
      `,
      [conversationId],
    )
    for (const row of persisted.rows) {
      if (typeof row.provider_sandbox_id === 'string' && row.provider_sandbox_id) {
        ids.add(row.provider_sandbox_id)
      }
    }
  }
  for (const sandboxId of ids) await killTrackedE2BSandbox(conversationId, sandboxId)
}

function shouldUseWarmPool(): boolean {
  return shouldUseE2BSandbox() && envBool('AGENT_E2B_WARM_POOL_ENABLED', false)
}

function warmPoolMaxAgeMs(): number {
  return envPositiveInt('AGENT_E2B_WARM_POOL_MAX_AGE_MS', DEFAULT_E2B_WARM_POOL_MAX_AGE_MS)
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
      const columns = await tursoExecute('pragma table_info(agent_cloud_sandboxes)')
      const columnNames = new Set(columns.rows.map((row) => String(row.name || '')))
      if (!columnNames.has('lifecycle_generation')) {
        await tursoExecute('alter table agent_cloud_sandboxes add column lifecycle_generation integer not null default 0')
          .catch((error) => {
            if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error
          })
      }
      if (!columnNames.has('lifecycle_state')) {
        await tursoExecute("alter table agent_cloud_sandboxes add column lifecycle_state text not null default 'active'")
          .catch((error) => {
            if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error
          })
      }
      if (!columnNames.has('lifecycle_source_generation')) {
        await tursoExecute('alter table agent_cloud_sandboxes add column lifecycle_source_generation integer')
          .catch((error) => {
            if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error
          })
      }
      await tursoExecute(`
        create table if not exists agent_cloud_sandbox_orphans (
          provider_sandbox_id text primary key,
          conversation_id text not null,
          provider text not null,
          created_at_ms integer not null
        )
      `)
      await tursoExecute('create index if not exists agent_cloud_sandbox_orphans_conversation_idx on agent_cloud_sandbox_orphans(conversation_id, provider)')
    })().catch((error) => {
      schemaReady = null
      throw error
    })
  }
  await schemaReady
}

async function loadPersistedSandboxState(conversationId: string): Promise<PersistedSandboxState | null> {
  if (!tursoConfigured()) return null
  await ensureSchema()
  const result = await tursoExecute(
    `
      select provider_sandbox_id, lifecycle_generation, lifecycle_source_generation, lifecycle_state
      from agent_cloud_sandboxes
      where conversation_id = ? and provider = 'e2b'
      limit 1
    `,
    [conversationId],
  )
  const row = result.rows[0]
  if (!row) return null
  const rawState = row.lifecycle_state
  const lifecycleState = rawState === 'resetting' || rawState === 'destroying' ? rawState : 'active'
  const generation = Number(row.lifecycle_generation)
  const rawSourceGeneration = row.lifecycle_source_generation
  const sourceGeneration = rawSourceGeneration === null || rawSourceGeneration === undefined
    ? Number.NaN
    : Number(rawSourceGeneration)
  const sandboxId = typeof row.provider_sandbox_id === 'string' && row.provider_sandbox_id
    ? row.provider_sandbox_id
    : null
  return {
    sandboxId,
    generation: Number.isFinite(generation) ? Math.max(0, generation) : 0,
    sourceGeneration: Number.isFinite(sourceGeneration) ? Math.max(0, sourceGeneration) : null,
    lifecycleState,
  }
}

async function loadPersistedSandboxId(conversationId: string): Promise<string | null> {
  const state = await loadPersistedSandboxState(conversationId)
  return state?.lifecycleState === 'active' ? state.sandboxId : null
}

async function persistSandboxId(conversationId: string, sandboxId: string): Promise<boolean> {
  if (!tursoConfigured()) return true
  await ensureSchema()
  const now = Date.now()
  const persisted = await tursoExecute(
    `
      insert into agent_cloud_sandboxes (
        conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms, last_used_at_ms,
        lifecycle_generation, lifecycle_state
      )
      values (?, 'e2b', ?, ?, ?, ?, 1, 'active')
      on conflict(conversation_id) do update set
        updated_at_ms = excluded.updated_at_ms,
        last_used_at_ms = excluded.last_used_at_ms
      where agent_cloud_sandboxes.provider = 'e2b'
        and agent_cloud_sandboxes.lifecycle_state = 'active'
        and agent_cloud_sandboxes.provider_sandbox_id = excluded.provider_sandbox_id
    `,
    [conversationId, sandboxId, now, now, now],
  )
  return persisted.rowsAffected === 1
}

async function claimPersistedSandboxCandidate(
  conversationId: string,
  sandboxId: string,
  expectedGeneration: number,
): Promise<boolean> {
  if (!tursoConfigured()) return true
  await ensureSchema()
  const now = Date.now()
  const claimed = await tursoExecute(
    `
      insert into agent_cloud_sandboxes (
        conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms, last_used_at_ms,
        lifecycle_generation, lifecycle_state
      )
      values (?, 'e2b', ?, ?, ?, ?, 1, 'active')
      on conflict(conversation_id) do update set
        provider = 'e2b',
        provider_sandbox_id = excluded.provider_sandbox_id,
        lifecycle_generation = agent_cloud_sandboxes.lifecycle_generation + 1,
        lifecycle_state = 'active',
        lifecycle_source_generation = agent_cloud_sandboxes.lifecycle_generation,
        updated_at_ms = excluded.updated_at_ms,
        last_used_at_ms = excluded.last_used_at_ms
      where agent_cloud_sandboxes.provider = 'e2b'
        and agent_cloud_sandboxes.lifecycle_state = 'active'
        and agent_cloud_sandboxes.lifecycle_generation = ?
    `,
    [conversationId, sandboxId, now, now, now, expectedGeneration],
  )
  return claimed.rowsAffected === 1
}

async function transferPersistedSandboxOwnership(
  sourceConversationId: string,
  targetConversationId: string,
  sandboxId: string,
  expectedTargetGeneration: number,
): Promise<boolean> {
  if (!tursoConfigured()) return true
  await ensureSchema()
  return tursoTransaction('write', async (transaction) => {
    const source = await transaction.execute({
      sql: `
        select lifecycle_generation, lifecycle_state
        from agent_cloud_sandboxes
        where conversation_id = ? and provider = 'e2b' and provider_sandbox_id = ?
        limit 1
      `,
      args: [sourceConversationId, sandboxId],
    })
    const sourceRow = source.rows[0]
    if (!sourceRow || sourceRow.lifecycle_state !== 'active') return false
    const sourceGeneration = Number(sourceRow.lifecycle_generation)
    if (!Number.isFinite(sourceGeneration)) return false

    const target = await transaction.execute({
      sql: `
        select lifecycle_generation, lifecycle_state
        from agent_cloud_sandboxes
        where conversation_id = ? and provider = 'e2b'
        limit 1
      `,
      args: [targetConversationId],
    })
    const targetRow = target.rows[0]
    const now = Date.now()
    if (targetRow) {
      if (
        targetRow.lifecycle_state !== 'active' ||
        Number(targetRow.lifecycle_generation) !== expectedTargetGeneration
      ) return false
      const claimed = await transaction.execute({
        sql: `
          update agent_cloud_sandboxes
          set provider_sandbox_id = ?,
              lifecycle_generation = lifecycle_generation + 1,
              lifecycle_source_generation = lifecycle_generation,
              updated_at_ms = ?,
              last_used_at_ms = ?
          where conversation_id = ?
            and provider = 'e2b'
            and lifecycle_state = 'active'
            and lifecycle_generation = ?
        `,
        args: [sandboxId, now, now, targetConversationId, expectedTargetGeneration],
      })
      if (claimed.rowsAffected !== 1) return false
    } else {
      if (expectedTargetGeneration !== 0) return false
      await transaction.execute({
        sql: `
          insert into agent_cloud_sandboxes (
            conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms,
            last_used_at_ms, lifecycle_generation, lifecycle_state
          )
          values (?, 'e2b', ?, ?, ?, ?, 1, 'active')
        `,
        args: [targetConversationId, sandboxId, now, now, now],
      })
    }

    const released = await transaction.execute({
      sql: `
        delete from agent_cloud_sandboxes
        where conversation_id = ?
          and provider = 'e2b'
          and provider_sandbox_id = ?
          and lifecycle_state = 'active'
          and lifecycle_generation = ?
      `,
      args: [sourceConversationId, sandboxId, sourceGeneration],
    })
    if (released.rowsAffected !== 1) throw new E2BLifecycleSupersededError(sourceConversationId)
    return true
  })
}

async function deletePersistedSandboxIdIfMatches(conversationId: string, sandboxId: string): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  await tursoExecute(
    `
      update agent_cloud_sandboxes
      set provider_sandbox_id = '',
          lifecycle_generation = lifecycle_generation + 1,
          updated_at_ms = ?,
          last_used_at_ms = ?
      where conversation_id = ?
        and provider = 'e2b'
        and lifecycle_state = 'active'
        and provider_sandbox_id = ?
    `,
    [Date.now(), Date.now(), conversationId, sandboxId],
  )
}

async function deletePersistedWarmRowIfMatches(conversationId: string, sandboxId: string): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  await tursoExecute(
    `
      delete from agent_cloud_sandboxes
      where conversation_id = ? and provider = 'e2b' and provider_sandbox_id = ?
    `,
    [conversationId, sandboxId],
  )
}

async function waitForDurableLifecycle(conversationId: string): Promise<PersistedSandboxState | null> {
  if (!tursoConfigured()) return null
  let observedFenceKey = ''
  let deadline = Date.now() + 2 * 60 * 1000
  while (true) {
    const state = await loadPersistedSandboxState(conversationId)
    if (!state || state.lifecycleState === 'active') return state
    const fenceKey = `${state.generation}:${state.lifecycleState}`
    if (fenceKey !== observedFenceKey) {
      observedFenceKey = fenceKey
      deadline = Date.now() + 2 * 60 * 1000
    }
    if (Date.now() >= deadline) {
      // The process that installed the durable fence may have crashed. Take
      // over with a newer generation, confirm the recorded provider is dead,
      // and only then reopen creation for this conversation.
      const takeover = await takeOverDurableLifecycle(conversationId, state)
      if (!takeover) continue
      if (takeover.sandboxId) {
        await killE2BSandboxWithRetry(takeover.sandboxId)
        await reconcileKilledE2BSandboxBilling(
          conversationId,
          takeover.sandboxId,
          takeover.sourceGeneration,
        )
      }
      await finishDurableLifecycle(conversationId, takeover)
      return loadPersistedSandboxState(conversationId)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function beginDurableLifecycle(
  conversationId: string,
  lifecycleState: 'resetting' | 'destroying',
): Promise<DurableLifecycleFence | null> {
  if (!tursoConfigured()) return null
  await ensureSchema()
  return tursoTransaction('write', async (transaction) => {
    const selected = await transaction.execute({
      sql: `
        select provider_sandbox_id, lifecycle_generation, lifecycle_source_generation, lifecycle_state
        from agent_cloud_sandboxes
        where conversation_id = ? and provider = 'e2b'
        limit 1
      `,
      args: [conversationId],
    })
    const row = selected.rows[0]
    const currentGeneration = Number.isFinite(Number(row?.lifecycle_generation))
      ? Math.max(0, Number(row?.lifecycle_generation))
      : 0
    const generation = currentGeneration + 1
    const rawPersistedSourceGeneration = row?.lifecycle_source_generation
    const persistedSourceGeneration = rawPersistedSourceGeneration === null || rawPersistedSourceGeneration === undefined
      ? Number.NaN
      : Number(rawPersistedSourceGeneration)
    const sourceGeneration = row?.lifecycle_state === 'active'
      ? currentGeneration
      : Number.isFinite(persistedSourceGeneration)
        ? Math.max(0, persistedSourceGeneration)
        : Math.max(0, currentGeneration - 1)
    const sandboxId = typeof row?.provider_sandbox_id === 'string' && row.provider_sandbox_id
      ? row.provider_sandbox_id
      : null
    const now = Date.now()
    if (!row) {
      await transaction.execute({
        sql: `
          insert into agent_cloud_sandboxes (
            conversation_id, provider, provider_sandbox_id, created_at_ms, updated_at_ms, last_used_at_ms,
            lifecycle_generation, lifecycle_state
          )
          values (?, 'e2b', '', ?, ?, ?, ?, ?)
        `,
        args: [conversationId, now, now, now, generation, lifecycleState],
      })
    } else {
      const fenced = await transaction.execute({
        sql: `
          update agent_cloud_sandboxes
          set lifecycle_generation = ?,
              lifecycle_state = ?,
              lifecycle_source_generation = ?,
              updated_at_ms = ?
          where conversation_id = ?
            and provider = 'e2b'
            and lifecycle_generation = ?
        `,
        args: [generation, lifecycleState, sourceGeneration, now, conversationId, currentGeneration],
      })
      if (fenced.rowsAffected !== 1) throw new E2BLifecycleSupersededError(conversationId)
    }
    return { sandboxId, generation, sourceGeneration, lifecycleState }
  })
}

async function takeOverDurableLifecycle(
  conversationId: string,
  observed: PersistedSandboxState,
): Promise<DurableLifecycleFence | null> {
  if (!tursoConfigured() || observed.lifecycleState === 'active') return null
  await ensureSchema()
  const generation = observed.generation + 1
  const now = Date.now()
  const taken = await tursoExecute(
    `
      update agent_cloud_sandboxes
      set lifecycle_generation = ?, lifecycle_state = 'destroying', updated_at_ms = ?
      where conversation_id = ?
        and provider = 'e2b'
        and lifecycle_generation = ?
        and lifecycle_state = ?
    `,
    [generation, now, conversationId, observed.generation, observed.lifecycleState],
  )
  if (taken.rowsAffected !== 1) return null
  return {
    sandboxId: observed.sandboxId,
    generation,
    sourceGeneration: observed.sourceGeneration ?? Math.max(0, observed.generation - 1),
    lifecycleState: 'destroying',
  }
}

async function fenceObservedActiveSandbox(
  conversationId: string,
  observed: PersistedSandboxState,
): Promise<DurableLifecycleFence | null> {
  if (
    !tursoConfigured() ||
    observed.lifecycleState !== 'active' ||
    !observed.sandboxId
  ) return null
  await ensureSchema()
  const generation = observed.generation + 1
  const now = Date.now()
  const fenced = await tursoExecute(
    `
      update agent_cloud_sandboxes
      set lifecycle_generation = ?,
          lifecycle_state = 'destroying',
          lifecycle_source_generation = ?,
          updated_at_ms = ?
      where conversation_id = ?
        and provider = 'e2b'
        and provider_sandbox_id = ?
        and lifecycle_generation = ?
        and lifecycle_state = 'active'
    `,
    [generation, observed.generation, now, conversationId, observed.sandboxId, observed.generation],
  )
  if (fenced.rowsAffected !== 1) return null
  return {
    sandboxId: observed.sandboxId,
    generation,
    sourceGeneration: observed.generation,
    lifecycleState: 'destroying',
  }
}

async function finishDurableLifecycle(
  conversationId: string,
  fence: DurableLifecycleFence | null,
): Promise<void> {
  if (!fence || !tursoConfigured()) return
  const now = Date.now()
  const finished = await tursoExecute(
    `
      update agent_cloud_sandboxes
      set provider_sandbox_id = '',
          lifecycle_state = 'active',
          lifecycle_source_generation = null,
          updated_at_ms = ?,
          last_used_at_ms = ?
      where conversation_id = ?
        and provider = 'e2b'
        and lifecycle_generation = ?
        and lifecycle_state = ?
    `,
    [now, now, conversationId, fence.generation, fence.lifecycleState],
  )
  if (finished.rowsAffected !== 1) throw new E2BLifecycleSupersededError(conversationId)
}

async function createSandbox(conversationId: string): Promise<E2BSandboxInstance> {
  if (!envString('E2B_API_KEY')) {
    throw new Error('E2B is not configured. Missing: E2B_API_KEY')
  }

  const sandbox = await Sandbox.create({
    template: envString('E2B_TEMPLATE_ID') || undefined,
    apiKey: envString('E2B_API_KEY'),
    timeoutMs: envPositiveInt('AGENT_E2B_SANDBOX_TIMEOUT_MS', DEFAULT_E2B_TIMEOUT_MS),
    allowInternetAccess: envBool('AGENT_E2B_ALLOW_INTERNET', true),
    secure: true,
    network: {
      allowPublicTraffic: true,
      maskRequestHost: 'localhost:${PORT}',
    },
    metadata: {
      app: 'agent',
      conversationId,
    },
  })
  await sandbox.files.makeDir(workspaceRoot(conversationId)).catch(() => undefined)
  return sandbox
}

async function connectSandbox(conversationId: string, sandboxId: string): Promise<E2BSandboxInstance | null> {
  try {
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey: envString('E2B_API_KEY'),
      timeoutMs: envPositiveInt('AGENT_E2B_SANDBOX_TIMEOUT_MS', DEFAULT_E2B_TIMEOUT_MS),
    })
    await sandbox.files.makeDir(workspaceRoot(conversationId)).catch(() => undefined)
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

export async function getE2BSandboxBillingDescriptor(
  conversationId: string,
): Promise<E2BSandboxBillingDescriptor> {
  const safeId = sanitizeConversationId(conversationId)
  if (!tursoConfigured()) {
    throw new Error('Durable E2B runtime billing requires Turso.')
  }

  // A sandbox commit and the immediately-following descriptor read can land
  // on different Turso replicas. Give the durable row a short bounded window
  // to catch up instead of failing an otherwise healthy task during startup.
  // A genuinely newer lifecycle generation still fails closed immediately.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cached = e2bCache.get(safeId)
    if (!cached) {
      throw new Error('E2B sandbox was not confirmed before runtime billing activation.')
    }
    const state = await loadPersistedSandboxState(safeId)
    if (
      state?.lifecycleState === 'active' &&
      state.sandboxId === cached.sandboxId &&
      state.generation === cached.generation
    ) {
      return {
        providerSandboxId: cached.sandboxId,
        lifecycleGeneration: cached.generation,
        startedAtMs: cached.billingStartedAtMs,
      }
    }
    if (
      state?.lifecycleState === 'active' &&
      state.sandboxId === cached.sandboxId &&
      state.generation > cached.generation
    ) {
      throw new E2BLifecycleSupersededError(safeId)
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)))
      continue
    }
    throw new E2BLifecycleSupersededError(safeId)
  }
  throw new E2BLifecycleSupersededError(safeId)
}

class E2BLifecycleSupersededError extends Error {
  constructor(readonly conversationId: string) {
    super(`E2B lifecycle changed while preparing sandbox for ${conversationId}.`)
    this.name = 'E2BLifecycleSupersededError'
  }
}

function e2bLifecycleEpoch(conversationId: string): number {
  return e2bLifecycleEpochs.get(conversationId) ?? 0
}

function bumpE2BLifecycleEpoch(conversationId: string): number {
  const next = e2bLifecycleEpoch(conversationId) + 1
  e2bLifecycleEpochs.set(conversationId, next)
  return next
}

async function awaitE2BLifecycle(conversationId: string): Promise<void> {
  while (true) {
    const pending = e2bLifecyclePromises.get(conversationId)
    if (!pending) return
    await pending
    if (e2bLifecyclePromises.get(conversationId) === pending) return
  }
}

async function runE2BLifecycle(
  conversationId: string,
  operation: (epoch: number) => Promise<void>,
): Promise<number> {
  // Advance synchronously before any await so already-running creation work can
  // never commit after reset/destroy begins.
  const epoch = bumpE2BLifecycleEpoch(conversationId)
  const previous = e2bLifecyclePromises.get(conversationId)
  const lifecycle = (async () => {
    await previous?.catch(() => undefined)
    await operation(epoch)
  })()
  e2bLifecyclePromises.set(conversationId, lifecycle)
  try {
    await lifecycle
  } finally {
    if (e2bLifecyclePromises.get(conversationId) === lifecycle) {
      e2bLifecyclePromises.delete(conversationId)
    }
  }
  return epoch
}

async function discardSupersededSandbox(
  conversationId: string,
  sandbox: E2BSandboxInstance,
): Promise<never> {
  await killTrackedE2BSandbox(conversationId, sandbox.sandboxId)
  await deletePersistedSandboxIdIfMatches(conversationId, sandbox.sandboxId)
  throw new E2BLifecycleSupersededError(conversationId)
}

async function commitSandboxCandidate(
  conversationId: string,
  sandbox: E2BSandboxInstance,
  billingStartedAtMs: number,
  expectedEpoch: number,
  expectedDurableGeneration: number,
): Promise<E2BSandboxInstance> {
  if (e2bLifecycleEpoch(conversationId) !== expectedEpoch) {
    return discardSupersededSandbox(conversationId, sandbox)
  }

  const authoritative = e2bCache.get(conversationId)
  if (authoritative) {
    authoritative.lastUsed = Date.now()
    if (authoritative.sandboxId !== sandbox.sandboxId) {
      await killTrackedE2BSandbox(conversationId, sandbox.sandboxId)
    }
    const persisted = await persistSandboxId(conversationId, authoritative.sandboxId)
    if (!persisted) {
      e2bCache.delete(conversationId)
      await killTrackedE2BSandbox(conversationId, authoritative.sandboxId)
      throw new E2BLifecycleSupersededError(conversationId)
    }
    if (e2bLifecycleEpoch(conversationId) !== expectedEpoch) {
      e2bCache.delete(conversationId)
      await killTrackedE2BSandbox(conversationId, authoritative.sandboxId)
      await deletePersistedSandboxIdIfMatches(conversationId, authoritative.sandboxId).catch(() => undefined)
      throw new E2BLifecycleSupersededError(conversationId)
    }
    return authoritative.sandbox
  }

  let committedGeneration = expectedDurableGeneration + 1
  try {
    const claimed = await claimPersistedSandboxCandidate(
      conversationId,
      sandbox.sandboxId,
      expectedDurableGeneration,
    )
    if (!claimed) {
      const current = await loadPersistedSandboxState(conversationId)
      if (
        current?.lifecycleState !== 'active' ||
        current.sandboxId !== sandbox.sandboxId
      ) {
        return discardSupersededSandbox(conversationId, sandbox)
      }
      committedGeneration = current.generation
    }
  } catch (persistenceError) {
    if (persistenceError instanceof E2BLifecycleSupersededError) throw persistenceError
    // Retain process-local ownership until the provider instance is confirmed
    // dead. Otherwise a transient DB failure can leak a paid sandbox and a
    // retry can create a second writer for the same conversation.
    try {
      await killTrackedE2BSandbox(conversationId, sandbox.sandboxId)
      await deletePersistedSandboxIdIfMatches(conversationId, sandbox.sandboxId).catch(() => undefined)
    } catch (cleanupError) {
      throw new AggregateError(
        [persistenceError, cleanupError],
        `Could not persist or safely dispose E2B sandbox ${sandbox.sandboxId}.`,
      )
    }
    throw persistenceError
  }
  if (e2bLifecycleEpoch(conversationId) !== expectedEpoch) {
    return discardSupersededSandbox(conversationId, sandbox)
  }
  e2bCache.set(conversationId, {
    sandboxId: sandbox.sandboxId,
    sandbox,
    generation: committedGeneration,
    lastUsed: Date.now(),
    billingStartedAtMs,
    lastValidatedAtMs: Date.now(),
  })
  return sandbox
}

export async function getOrCreateE2BSandbox(conversationId: string): Promise<E2BSandboxInstance> {
  const safeId = sanitizeConversationId(conversationId)
  while (true) {
    await drainQuarantinedSandboxes(safeId)
    await awaitE2BLifecycle(safeId)
    const durableState = await waitForDurableLifecycle(safeId)
    const cached = e2bCache.get(safeId)
    if (cached) {
      if (
        tursoConfigured() &&
        durableState?.sandboxId === cached.sandboxId &&
        durableState.generation !== cached.generation
      ) {
        // The same provider process was handed to a newer durable owner. A
        // stale process must neither keep using it nor kill it. A lower
        // durable generation can only be a lagging read immediately after this
        // process committed the cached generation, so re-read instead of
        // turning a healthy task startup into a lifecycle error.
        if (durableState.generation < cached.generation) {
          await new Promise((resolve) => setTimeout(resolve, 75))
          continue
        }
        e2bCache.delete(safeId)
        throw new E2BLifecycleSupersededError(safeId)
      }
      if (
        !tursoConfigured() ||
        (
          durableState?.sandboxId === cached.sandboxId &&
          durableState.generation === cached.generation
        )
      ) {
        const now = Date.now()
        const running = now - cached.lastValidatedAtMs <= E2B_CACHE_VALIDATION_TTL_MS ||
          await cached.sandbox.isRunning({ requestTimeoutMs: 5_000 })
        if (running) {
          cached.lastUsed = now
          cached.lastValidatedAtMs = now
          return cached.sandbox
        }
        e2bCache.delete(safeId)
      } else {
        // Another process advanced the durable lifecycle. Never serve the stale
        // cached handle after that ownership change.
        e2bCache.delete(safeId)
        try {
          await killTrackedE2BSandbox(safeId, cached.sandboxId)
        } catch (error) {
          e2bCache.set(safeId, cached)
          throw error
        }
      }
    }

    const existingCreation = e2bCreationPromises.get(safeId)
    if (existingCreation) {
      try {
        return await existingCreation
      } catch (error) {
        if (!(error instanceof E2BLifecycleSupersededError)) throw error
        if (e2bCreationPromises.get(safeId) === existingCreation) {
          e2bCreationPromises.delete(safeId)
        }
        continue
      }
    }

    const expectedEpoch = e2bLifecycleEpoch(safeId)
    const creation = (async (): Promise<E2BSandboxInstance> => {
      const cachedInsideCreation = e2bCache.get(safeId)
      if (cachedInsideCreation) {
        cachedInsideCreation.lastUsed = Date.now()
        return cachedInsideCreation.sandbox
      }

      let persistedState = await waitForDurableLifecycle(safeId)
      const persistedId = persistedState?.sandboxId || null
      const connectStartedAtMs = Date.now()
      const connected = persistedId ? await connectSandbox(safeId, persistedId) : null
      if (persistedId && !connected) {
        // A failed reconnect is not proof that the old provider process is
        // dead. First CAS-fence the exact observed generation so a stale
        // reconnect failure cannot kill a sandbox another process just claimed.
        const reconnectFence = persistedState
          ? await fenceObservedActiveSandbox(safeId, persistedState)
          : null
        if (!reconnectFence) throw new E2BLifecycleSupersededError(safeId)
        await killE2BSandboxWithRetry(persistedId)
        await reconcileKilledE2BSandboxBilling(
          safeId,
          persistedId,
          reconnectFence.sourceGeneration,
        )
        await finishDurableLifecycle(safeId, reconnectFence)
        persistedState = await waitForDurableLifecycle(safeId)
        if (persistedState?.sandboxId) throw new E2BLifecycleSupersededError(safeId)
      }
      const expectedDurableGeneration = persistedState?.generation ?? 0
      const adopted = connected
        ? null
        : await adoptWarmE2BSandbox(safeId, expectedEpoch, expectedDurableGeneration)
      const billingStartedAtMs = connected ? connectStartedAtMs : Date.now()
      const sandbox = connected || adopted || await createSandbox(safeId)
      return commitSandboxCandidate(
        safeId,
        sandbox,
        billingStartedAtMs,
        expectedEpoch,
        expectedDurableGeneration,
      )
    })()
    e2bCreationPromises.set(safeId, creation)
    try {
      return await creation
    } catch (error) {
      if (!(error instanceof E2BLifecycleSupersededError)) throw error
    } finally {
      if (e2bCreationPromises.get(safeId) === creation) {
        e2bCreationPromises.delete(safeId)
      }
    }
  }
}

async function awaitPendingE2BCreation(conversationId: string): Promise<void> {
  const pending = e2bCreationPromises.get(conversationId)
  if (!pending) return
  try {
    await pending
  } catch (error) {
    // Only the explicit local supersession sentinel is safe to ignore. Commit,
    // provider-kill, and aggregate cleanup failures must keep reset/destroy
    // non-successful so a live candidate can never escape the fence.
    if (!(error instanceof E2BLifecycleSupersededError)) throw error
  }
  if (e2bCreationPromises.get(conversationId) === pending) {
    e2bCreationPromises.delete(conversationId)
  }
}

export async function resetE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  const cachedAtStart = e2bCache.get(safeId)?.sandboxId || null
  e2bCache.delete(safeId)
  await runE2BLifecycle(safeId, async () => {
    const fence = await beginDurableLifecycle(safeId, 'resetting')
    await awaitPendingE2BCreation(safeId)
    await drainQuarantinedSandboxes(safeId)
    // Reset is a hard isolation fence. A replacement must never overlap an old
    // uncancellable browser/process action, even if a legacy opt-out env flag
    // was configured.
    for (const sandboxId of new Set([
      cachedAtStart,
      fence?.sandboxId,
      ...quarantinedSandboxIdsForConversation(safeId),
    ].filter((id): id is string => !!id))) {
      await killTrackedE2BSandbox(safeId, sandboxId)
    }
    if (fence?.sandboxId) {
      await reconcileKilledE2BSandboxBilling(
        safeId,
        fence.sandboxId,
        fence.sourceGeneration,
      )
    }
    await finishDurableLifecycle(safeId, fence)
  })
}

export async function pauseE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  if (!envBool('AGENT_E2B_PAUSE_ON_TASK_END', true)) return
  const cachedAtStart = e2bCache.get(safeId)?.sandboxId || null
  e2bCache.delete(safeId)
  await runE2BLifecycle(safeId, async () => {
    await awaitPendingE2BCreation(safeId)
    const sandboxId = cachedAtStart || await loadPersistedSandboxId(safeId)
    if (!sandboxId) return
    try {
      await Sandbox.pause(sandboxId, { apiKey: envString('E2B_API_KEY') })
    } catch (error) {
      console.warn('[E2B] Could not pause sandbox', {
        conversationId: safeId,
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

export async function destroyE2BSandbox(conversationId: string): Promise<void> {
  const safeId = sanitizeConversationId(conversationId)
  const cachedAtStart = e2bCache.get(safeId)?.sandboxId || null
  e2bCache.delete(safeId)
  await runE2BLifecycle(safeId, async () => {
    const fence = await beginDurableLifecycle(safeId, 'destroying')
    await awaitPendingE2BCreation(safeId)
    await drainQuarantinedSandboxes(safeId)
    for (const sandboxId of new Set([
      cachedAtStart,
      fence?.sandboxId,
      ...quarantinedSandboxIdsForConversation(safeId),
    ].filter((id): id is string => !!id))) {
      await killTrackedE2BSandbox(safeId, sandboxId)
    }
    if (fence?.sandboxId) {
      await reconcileKilledE2BSandboxBilling(
        safeId,
        fence.sandboxId,
        fence.sourceGeneration,
      )
    }
    await finishDurableLifecycle(safeId, fence)
  })
}

async function createWarmE2BSandbox(reason: string): Promise<WarmE2BSandbox> {
  const warmId = sanitizeConversationId(`warm-${randomUUID()}`)
  console.log('[E2B] Prewarming sandbox', { warmId, reason })
  const billingStartedAtMs = Date.now()
  const sandbox = await createSandbox(warmId)
  try {
    if (!await persistSandboxId(warmId, sandbox.sandboxId)) {
      throw new E2BLifecycleSupersededError(warmId)
    }
    e2bCache.set(warmId, {
      sandboxId: sandbox.sandboxId,
      sandbox,
      generation: 1,
      lastUsed: Date.now(),
      billingStartedAtMs,
      lastValidatedAtMs: Date.now(),
    })
    await ensureE2BRemoteBrowser(warmId)
    const warm = {
      conversationId: warmId,
      sandboxId: sandbox.sandboxId,
      sandbox,
      createdAt: billingStartedAtMs,
      billingStartedAtMs,
    }
    warmSandbox = warm
    console.log('[E2B] Warm sandbox ready', { warmId, sandboxId: warm.sandboxId })
    return warm
  } catch (error) {
    e2bCache.delete(warmId)
    await killTrackedE2BSandbox(warmId, sandbox.sandboxId)
    await deletePersistedWarmRowIfMatches(warmId, sandbox.sandboxId)
    throw error
  }
}

async function cleanupStalePersistedWarmSandboxes(): Promise<void> {
  if (!tursoConfigured()) return
  await ensureSchema()
  const orphanRows = await tursoExecute(
    `
      select provider_sandbox_id, conversation_id
      from agent_cloud_sandbox_orphans
      where provider = 'e2b'
      order by created_at_ms asc
      limit 50
    `,
  )
  for (const row of orphanRows.rows) {
    if (typeof row.provider_sandbox_id !== 'string' || typeof row.conversation_id !== 'string') continue
    await killTrackedE2BSandbox(row.conversation_id, row.provider_sandbox_id)
  }
  const cutoff = Date.now() - warmPoolMaxAgeMs()
  const rows = await tursoExecute(
    `
      select conversation_id
      from agent_cloud_sandboxes
      where provider = 'e2b'
        and conversation_id like 'warm-%'
        and last_used_at_ms < ?
      order by last_used_at_ms asc
      limit 20
    `,
    [cutoff],
  )
  for (const row of rows.rows) {
    const warmId = typeof row.conversation_id === 'string' ? row.conversation_id : ''
    if (!warmId) continue
    const state = await loadPersistedSandboxState(warmId)
    if (!state?.sandboxId) {
      await tursoExecute(
        `delete from agent_cloud_sandboxes where conversation_id = ? and provider = 'e2b' and provider_sandbox_id = ''`,
        [warmId],
      )
      continue
    }
    const fence = await fenceObservedActiveSandbox(warmId, state)
    if (!fence) continue
    await killTrackedE2BSandbox(warmId, state.sandboxId)
    await tursoExecute(
      `
        delete from agent_cloud_sandboxes
        where conversation_id = ?
          and provider = 'e2b'
          and provider_sandbox_id = ?
          and lifecycle_generation = ?
          and lifecycle_state = 'destroying'
      `,
      [warmId, state.sandboxId, fence.generation],
    )
  }
}

export async function prewarmE2BSandbox(reason = 'background'): Promise<void> {
  if (!shouldUseWarmPool()) return
  if (warmSandbox) return
  if (!warmSandboxPromise) {
    warmSandboxPromise = cleanupStalePersistedWarmSandboxes().then(() => createWarmE2BSandbox(reason)).catch((error) => {
      warmSandboxPromise = null
      warmSandbox = null
      throw error
    })
  }
  await warmSandboxPromise
}

async function adoptWarmE2BSandbox(
  conversationId: string,
  expectedEpoch: number,
  expectedDurableGeneration: number,
): Promise<E2BSandboxInstance | null> {
  if (!shouldUseWarmPool()) return null
  const safeId = sanitizeConversationId(conversationId)
  let warm = warmSandbox
  if (!warm && warmSandboxPromise) {
    const candidate = await warmSandboxPromise
    if (warmSandbox !== candidate) return null
    warm = candidate
  }
  if (!warm) return null
  if (warmSandbox !== warm) return null

  // Claim the single warm sandbox synchronously before any cleanup await so two
  // concurrent task starts can never adopt the same provider instance.
  warmSandbox = null
  warmSandboxPromise = null

  const warmAgeMs = Date.now() - warm.createdAt
  if (warmAgeMs > warmPoolMaxAgeMs()) {
    try {
      await killE2BSandboxWithRetry(warm.sandboxId)
    } catch (error) {
      warmSandbox = warm
      warmSandboxPromise = Promise.resolve(warm)
      throw error
    }
    e2bCache.delete(warm.conversationId)
    await deletePersistedWarmRowIfMatches(warm.conversationId, warm.sandboxId)
    console.warn('[E2B] Discarded stale warm sandbox', {
      conversationId: safeId,
      sandboxId: warm.sandboxId,
      warmAgeMs,
    })
    return null
  }

  try {
    const transferred = await transferPersistedSandboxOwnership(
      warm.conversationId,
      safeId,
      warm.sandboxId,
      expectedDurableGeneration,
    )
    if (!transferred) throw new E2BLifecycleSupersededError(safeId)
  } catch (error) {
    // A transaction ACK can be lost after commit. Reconcile both durable rows
    // before deciding whether the sandbox is still warm-pool owned.
    const [sourceState, targetState] = await Promise.all([
      loadPersistedSandboxState(warm.conversationId),
      loadPersistedSandboxState(safeId),
    ]).catch(() => [null, null] as const)
    const targetOwnsSandbox = targetState?.sandboxId === warm.sandboxId
    const sourceOwnsSandbox = sourceState?.lifecycleState === 'active' && sourceState.sandboxId === warm.sandboxId
    if (targetOwnsSandbox && !sourceOwnsSandbox) {
      // The transfer committed; continue adoption and never restore a pointer
      // that could later kill the task-owned sandbox.
    } else if (sourceOwnsSandbox && !targetOwnsSandbox) {
      if (!warmSandbox) {
        warmSandbox = warm
        warmSandboxPromise = Promise.resolve(warm)
      }
      throw error
      } else {
      // Unknown commit outcome: do not restore or kill. Atomic transfer means
      // either the source or target durable row still owns the sandbox; a
      // later read can reconcile it without risking the task-owned target.
      throw error
    }
  }
  e2bCache.delete(warm.conversationId)

  await warm.sandbox.files.makeDir(workspaceRoot(safeId)).catch(() => undefined)
  if (e2bLifecycleEpoch(safeId) !== expectedEpoch) {
    return discardSupersededSandbox(safeId, warm.sandbox)
  }

  console.log('[E2B] Adopted warm sandbox for task', {
    conversationId: safeId,
    sandboxId: warm.sandboxId,
    warmAgeMs,
  })

  queueMicrotask(() => {
    void prewarmE2BSandbox('warm-pool-replenish').catch((error) => {
      console.warn('[E2B] Warm pool replenishment failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })

  return warm.sandbox
}

export async function destroyWarmE2BSandbox(): Promise<void> {
  const pending = warmSandboxPromise
  let warm = warmSandbox
  if (!warm && pending) {
    const candidate = await pending.catch(() => null)
    if (!candidate || warmSandbox !== candidate) return
    warm = candidate
  }
  if (!warm) return
  if (warmSandbox !== warm) return
  warmSandbox = null
  warmSandboxPromise = null

  try {
    await killE2BSandboxWithRetry(warm.sandboxId)
  } catch (error) {
    warmSandbox = warm
    warmSandboxPromise = Promise.resolve(warm)
    throw error
  }
  e2bCache.delete(warm.conversationId)
  await deletePersistedWarmRowIfMatches(warm.conversationId, warm.sandboxId)
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

async function appendLocalMirror(localRoot: string, relativePath: string, body: Uint8Array | string): Promise<void> {
  const resolved = join(localRoot, relativePath)
  const rel = relative(localRoot, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return

  await mkdir(dirname(resolved), { recursive: true })
  const fd = await open(
    resolved,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
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
  _localMirrorRoot?: string,
  _maxFileBytes?: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean }> {
  const sandbox = await getOrCreateE2BSandbox(conversationId)
  const startTime = Date.now()
  const timeoutMs = envPositiveInt('AGENT_E2B_COMMAND_TIMEOUT_MS', DEFAULT_E2B_COMMAND_TIMEOUT_MS)
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let abortHandler: (() => void) | null = null

  try {
    if (signal?.aborted) throw new DOMException('Command execution aborted', 'AbortError')

    const commandHandle = await sandbox.commands.run(command, {
      background: true,
      cwd: workspaceRoot(conversationId),
      timeoutMs,
      signal,
      onStdout: (data) => onOutput?.('stdout', data),
      onStderr: (data) => onOutput?.('stderr', data),
    })

    let abortPromise: Promise<never> | null = null
    if (signal) {
      abortPromise = new Promise<never>((_, reject) => {
        const handler = () => {
          void sandbox.commands.kill(commandHandle.pid, { requestTimeoutMs: 2_000 }).catch(() => undefined)
          reject(new DOMException('Command execution aborted', 'AbortError'))
        }
        abortHandler = handler
        signal.addEventListener('abort', handler, { once: true })
      })
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        void sandbox.commands.kill(commandHandle.pid, { requestTimeoutMs: 2_000 }).catch(() => undefined)
        reject(new Error(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const result = await Promise.race([
      commandHandle.wait(),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ])

    // Shell-created files remain in the task's E2B workspace and are read,
    // listed, persisted and downloaded directly from there. Mirroring the
    // entire workspace here used to copy Chromium's live profile after every
    // command and could block a completed command for minutes.
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      durationMs: Date.now() - startTime,
      timedOut: false,
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('Command execution aborted', 'AbortError')
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
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
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
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
  const root = workspaceRoot(conversationId)
  const tempDir = `${root}/.agent/tmp`
  const tempPath = `${tempDir}/append-${randomUUID()}.txt`
  await sandbox.files.makeDir(tempDir).catch(() => undefined)
  await sandbox.files.write(tempPath, content)

  const script = `
set -e
mkdir -p ${shellQuote(posix.dirname(target.absolutePath))}
cat ${shellQuote(tempPath)} >> ${shellQuote(target.absolutePath)}
rm -f ${shellQuote(tempPath)}
wc -c < ${shellQuote(target.absolutePath)}
`
  const result = await sandbox.commands.run(script, {
    timeoutMs: envPositiveInt('AGENT_E2B_COMMAND_TIMEOUT_MS', DEFAULT_E2B_COMMAND_TIMEOUT_MS),
  })
  if (localMirrorRoot) await appendLocalMirror(localMirrorRoot, target.relativePath, content).catch(() => undefined)
  const parsedSize = Number.parseInt((result.stdout || '').trim().split(/\s+/)[0] || '', 10)
  const size = Number.isFinite(parsedSize) && parsedSize >= 0
    ? parsedSize
    : Buffer.byteLength(content, 'utf8')
  return { action: 'appended', path: target.relativePath, size }
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

export function rewriteE2BRemoteDebuggerUrl(endpoint: string, debuggerUrl: string): string {
  const endpointUrl = new URL(endpoint)
  const debuggerEndpoint = new URL(debuggerUrl)
  debuggerEndpoint.protocol = endpointUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  debuggerEndpoint.username = endpointUrl.username
  debuggerEndpoint.password = endpointUrl.password
  debuggerEndpoint.hostname = endpointUrl.hostname
  debuggerEndpoint.port = endpointUrl.port
  return debuggerEndpoint.toString()
}

export async function ensureE2BRemoteBrowserDebuggerUrl(conversationId: string): Promise<string> {
  const endpoint = await ensureE2BRemoteBrowser(conversationId)
  const response = await fetch(`${endpoint}/json/version`)
  if (!response.ok) {
    throw new Error(`E2B Chromium debugging endpoint returned HTTP ${response.status}.`)
  }

  const version = await response.json().catch(() => null) as { webSocketDebuggerUrl?: unknown } | null
  const debuggerUrl = version?.webSocketDebuggerUrl
  if (typeof debuggerUrl !== 'string' || !debuggerUrl) {
    throw new Error('E2B Chromium debugging endpoint did not expose a WebSocket debugger URL.')
  }

  return rewriteE2BRemoteDebuggerUrl(endpoint, debuggerUrl)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function launchOrReuseE2BRemoteBrowser(conversationId: string): Promise<string> {
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
  --remote-allow-origins=* \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=${port} \
  --user-data-dir=${shellQuote(profileDir)} \
  --window-size=1280,720 \
  about:blank > ${shellQuote(logPath)} 2>&1 < /dev/null &
`

  try {
    await sandbox.commands.run(script, {
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

export async function ensureE2BRemoteBrowser(conversationId: string): Promise<string> {
  const safeId = sanitizeConversationId(conversationId)
  const existing = e2bBrowserLaunchPromises.get(safeId)
  if (existing) return existing

  const pending = launchOrReuseE2BRemoteBrowser(safeId).finally(() => {
    if (e2bBrowserLaunchPromises.get(safeId) === pending) {
      e2bBrowserLaunchPromises.delete(safeId)
    }
  })
  e2bBrowserLaunchPromises.set(safeId, pending)
  return pending
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
