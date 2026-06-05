import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

function loadLocalEnv() {
  const envPath = join(root, '.env.local')
  if (!existsSync(envPath)) return
  const content = awaitableReadFile(envPath)
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

function awaitableReadFile(path) {
  return readFileSync(path, 'utf8')
}

loadLocalEnv()

const workDir = await mkdtemp(join(root, 'scripts/.agent-loop-debug-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import { AgentLoop } from ${JSON.stringify(join(root, 'src/lib/agent/AgentLoop.ts'))}
import { DEFAULT_OPENROUTER_MODEL } from ${JSON.stringify(join(root, 'src/lib/modelPricing.ts'))}

type EventRecord = { type: string; [key: string]: unknown }

function makeEmitter() {
  const events: EventRecord[] = []
  let closed = false
  return {
    events,
    textDelta(content: string) { events.push({ type: 'text_delta', content }) },
    reasoningDelta(content: string) { events.push({ type: 'reasoning_delta', content }) },
    reasoningDone() { events.push({ type: 'reasoning_done' }) },
    toolStart(id: string, name: string, args: Record<string, unknown>) {
      events.push({ type: 'tool_start', id, name, args })
      console.log('[smoke] tool_start', name, JSON.stringify(args).slice(0, 240))
    },
    toolResult(id: string, name: string, result: unknown) {
      events.push({ type: 'tool_result', id, name, result })
      const preview = typeof result === 'string' ? result : JSON.stringify(result)
      console.log('[smoke] tool_result', name, preview?.slice(0, 240))
    },
    terminalOutput(id: string, stream: 'stdout' | 'stderr', data: string) { events.push({ type: 'terminal_output', id, stream, data }) },
    fileContentStart(id: string, path: string, toolName?: string) { events.push({ type: 'file_content_start', id, path, toolName }) },
    fileContentDelta(id: string, content: string) { events.push({ type: 'file_content_delta', id, content }) },
    plan(items: string[]) {
      events.push({ type: 'plan', items })
      console.log('[smoke] plan', items.join(' | '))
    },
    artifactCreated(artifact: unknown) { events.push({ type: 'artifact_created', artifact }) },
    creditEvent(entry: unknown) { events.push({ type: 'credit_event', entry }) },
    stepAdvance(status?: string) { events.push({ type: 'step_advance', status }) },
    done(totalUsage?: unknown) {
      events.push({ type: 'done', totalUsage })
      closed = true
      console.log('[smoke] done')
    },
    error(message: string) {
      events.push({ type: 'error', message })
      console.log('[smoke] error', message)
    },
    close() { closed = true },
    heartbeat() {},
    get isClosed() { return closed },
    get terminalStatus() {
      const terminal = [...events].reverse().find(event => event.type === 'done' || event.type === 'error')
      return terminal?.type === 'done' ? 'done' : terminal?.type === 'error' ? 'error' : null
    },
  }
}

async function runSmoke() {
  const emitter = makeEmitter()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    const loop = new AgentLoop(emitter as any, {
      messages: [
        { role: 'user', content: 'research about ai broadly and cite multiple live sources' },
      ],
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      conversationId: 'debug-agent-loop-smoke',
      signal: controller.signal,
    })
    await loop.run()
  } finally {
    clearTimeout(timeout)
  }

  const toolStarts = emitter.events.filter(event => event.type === 'tool_start')
  const errors = emitter.events.filter(event => event.type === 'error')
  console.log('[smoke] summary', JSON.stringify({
    toolStarts: toolStarts.map(event => event.name),
    errors: errors.map(event => event.message),
    done: emitter.events.some(event => event.type === 'done'),
    eventCount: emitter.events.length,
  }))
}

await runSmoke()
`, 'utf-8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    logLevel: 'silent',
    alias: {
      '@': join(root, 'src'),
    },
    external: [
      'playwright',
      '@sparticuz/chromium',
      '@tursodatabase/serverless',
    ],
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
