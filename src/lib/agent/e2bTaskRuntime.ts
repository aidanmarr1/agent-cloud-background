import 'server-only'
import { Sandbox, SandboxNotFoundError, type SandboxInfo } from 'e2b'
import { taskQueueName } from './taskQueue'
import type { TaskDispatchProviderJob } from './taskDispatch'
import { TaskDispatchProviderError } from './taskDispatchError'

const ROLE = 'task-runtime'
const BOOT_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/

function apiOptions(signal?: AbortSignal) {
  return { apiKey: process.env.E2B_API_KEY, requestTimeoutMs: REQUEST_TIMEOUT_MS, signal }
}

function sandboxId(providerJobId: string): string {
  const id = providerJobId.startsWith('e2b:') ? providerJobId.slice(4) : ''
  if (!SAFE_ID.test(id)) throw new Error('Invalid E2B task runtime id.')
  return id
}

function assertOwned(info: SandboxInfo): void {
  if (info.metadata?.app !== 'agent' || info.metadata?.role !== ROLE ||
      info.metadata?.queue !== taskQueueName()) {
    throw new Error('Sandbox does not belong to this task runtime queue.')
  }
}

function toJob(info: SandboxInfo): TaskDispatchProviderJob {
  assertOwned(info)
  return {
    providerJobId: `e2b:${info.sandboxId}`,
    // Paused trusted runtimes must be killed, never automatically resumed.
    // Treat them as possibly live until kill/404 proves execution stopped.
    status: 'running',
    startCommand: null,
    createdAtMs: new Date(info.startedAt).getTime(),
    startedAtMs: new Date(info.startedAt).getTime(),
    finishedAtMs: null,
  }
}

// Only the trusted runtime receives these credentials. Generated commands run
// in a separate task-computer sandbox with none of these service credentials.
export function taskRuntimeEnvironment(runId: string, runtimeId: string): Record<string, string> {
  const keys = [
    'AUTH_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL', 'OPENROUTER_REASONING_EFFORT', 'OPENROUTER_PROVIDER_SORT',
    'SERPER_API_KEY', 'SERPER_BASE_URL', 'E2B_API_KEY', 'E2B_TEMPLATE_ID',
    'AGENT_TASK_QUEUE_NAME', 'AGENT_DEPLOYMENT_VERSION',
    'AGENT_E2B_VCPU_COUNT', 'AGENT_E2B_MEMORY_GIB',
    'AGENT_E2B_SANDBOX_TIMEOUT_MS', 'AGENT_E2B_COMMAND_TIMEOUT_MS',
    'AGENT_E2B_BROWSER_PORT', 'AGENT_E2B_BROWSER_START_TIMEOUT_MS',
    'AGENT_E2B_BROWSER_LAUNCH_TIMEOUT_MS',
  ]
  const forwarded = Object.fromEntries(keys.flatMap(key =>
    process.env[key] ? [[key, process.env[key]!]] : [],
  ))
  return {
    ...forwarded,
    LLM_PROVIDER: 'openrouter',
    AGENT_STORAGE_DRIVER: 'turso',
    AGENT_TASK_WORKER_MODE: 'external',
    AGENT_TASK_DISPATCH_MODE: 'e2b_job',
    AGENT_TASK_WORKER_ID: `e2b-task-${runId}`,
    AGENT_REQUIRE_HOSTED_TASK_WORKER: 'true',
    AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION: 'false',
    AGENT_TASK_WORKER_HEARTBEAT_MS: '15000',
    AGENT_TASK_WORKER_STALE_MS: '60000',
    AGENT_TASK_WORKER_MAX_ATTEMPTS: '3',
    AGENT_SANDBOX_PROVIDER: 'e2b',
    AGENT_E2B_ALLOW_INTERNET: 'true',
    AGENT_E2B_WARM_POOL_ENABLED: 'false',
    AGENT_E2B_PAUSE_ON_TASK_END: 'true',
    AGENT_E2B_KILL_ON_RESET: 'true',
    AGENT_E2B_VERIFY_ON_WORKER_STARTUP: 'false',
    AGENT_E2B_VERIFY_BROWSER_ON_WORKER_STARTUP: 'false',
    AGENT_E2B_TASK_RUNTIME_ID: runtimeId,
  }
}

// SDK injection permits exercising ambiguous launches and cleanup without
// purchasing sandboxes or exposing credentials in tests.
export function e2bTaskRuntimeProvider(sdk = Sandbox) {
  return {
    async launch(runId: string, dispatchId: string): Promise<string> {
      if (!SAFE_ID.test(runId)) throw new Error('Invalid task run id.')
      const template = process.env.E2B_TASK_RUNTIME_TEMPLATE?.trim()
      const revision = process.env.E2B_TASK_RUNTIME_REVISION?.trim()
      if (!template || !revision || !process.env.E2B_API_KEY) {
        throw new TaskDispatchProviderError('CONFIGURATION_MISSING',
          'E2B task runtime template is not configured.', false, null, 'known_rejection')
      }
      // A lost create response can leave an unstarted VM. It expires after one
      // minute; metadata lets the coordinator find it without another create.
      const runtime = await sdk.create(template, {
        ...apiOptions(), timeoutMs: BOOT_TIMEOUT_MS,
        secure: true, allowInternetAccess: true,
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: 'kill', autoResume: false },
        metadata: { app: 'agent', role: ROLE, queue: taskQueueName(), runId, dispatchId },
      })
      try {
        const bakedRevision = await runtime.files.read('/opt/agent/runtime-revision', { format: 'text' })
        if (bakedRevision.trim() !== revision) throw new Error('E2B task runtime revision mismatch.')
        await runtime.commands.run(`node scripts/e2b-task-runtime.mjs ${runId}`, {
          cwd: '/opt/agent', background: true, timeoutMs: 0,
          envs: taskRuntimeEnvironment(runId, runtime.sandboxId),
        })
        return `e2b:${runtime.sandboxId}`
      } catch {
        // A launch acknowledgement can be lost after execution started. Only
        // report a known failure once a provider kill proves it cannot run.
        try { await runtime.kill() } catch {
          throw new TaskDispatchProviderError('PROVIDER_UNAVAILABLE',
            'E2B task startup outcome is uncertain.', true, null, 'ambiguous')
        }
        throw new TaskDispatchProviderError('PROVIDER_REJECTED',
          'E2B task runtime could not start.', false, null, 'known_rejection')
      }
    },
    async retrieve(providerJobId: string, options: { signal?: AbortSignal } = {}) {
      try {
        return { outcome: 'found' as const, job: toJob(await sdk.getInfo(sandboxId(providerJobId), apiOptions(options.signal))) }
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return { outcome: 'not_found' as const, providerJobId }
        return { outcome: 'unknown' as const, providerJobId, errorCode: 'PROVIDER_UNAVAILABLE' as const, retryable: true, status: null }
      }
    },
    async cancel(providerJobId: string, options: { signal?: AbortSignal } = {}) {
      const observed = await this.retrieve(providerJobId, options)
      if (observed.outcome !== 'found') return observed
      try {
        await sdk.kill(sandboxId(providerJobId), apiOptions(options.signal))
        return { outcome: 'accepted' as const, providerJobId }
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return { outcome: 'not_found' as const, providerJobId }
        return { outcome: 'unknown' as const, providerJobId, errorCode: 'PROVIDER_UNAVAILABLE' as const, retryable: true, status: null }
      }
    },
    async list(runId: string, options: { signal?: AbortSignal } = {}) {
      if (!SAFE_ID.test(runId)) throw new Error('Invalid task run id.')
      try {
        const pager = sdk.list({ ...apiOptions(), limit: 100,
          query: { metadata: { app: 'agent', role: ROLE, queue: taskQueueName(), runId } } })
        const jobs: TaskDispatchProviderJob[] = []
        for (let page = 0; pager.hasNext && page < 5; page++) jobs.push(...(await pager.nextItems({ signal: options.signal })).map(toJob))
        if (pager.hasNext) throw new Error('Runtime observation exceeded pagination limit.')
        return { outcome: 'complete' as const, jobs }
      } catch {
        return { outcome: 'unknown' as const, jobs: [], errorCode: 'PROVIDER_UNAVAILABLE' as const, retryable: true, status: null }
      }
    },
  }
}
