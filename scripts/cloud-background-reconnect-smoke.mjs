import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function main() {
  const workDir = await mkdtemp(join(root, 'scripts/.cloud-reconnect-smoke-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
process.env.TURSO_DATABASE_URL = ''
process.env.TURSO_AUTH_TOKEN = ''

import {
  clearTaskJobsForTest,
  createTaskJobEventStream,
  findActiveTaskJobForConversation,
  startTaskJob,
} from ${JSON.stringify(join(root, 'src/lib/agent/taskJobs.ts'))}
import { parseSSE } from ${JSON.stringify(join(root, 'src/lib/stream.ts'))}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readEventsUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (event: any) => boolean,
  timeoutMs = 2000,
): Promise<any[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: any[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ timeout: true as const })),
      ])
      if ('timeout' in result) {
        throw new Error('Timed out waiting for stream event')
      }
      if (result.done) break

      buffer += decoder.decode(result.value, { stream: true })
      while (true) {
        const boundary = buffer.indexOf('\\n\\n')
        if (boundary === -1) break
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSSE(block)
        if (!event) continue
        events.push(event)
        if (predicate(event)) return events
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  throw new Error('Stream ended before expected event')
}

export async function runClosedTabReconnectSmoke(): Promise<void> {
  clearTaskJobsForTest()

  const userId = 'cloud-reconnect-user'
  const conversationId = 'cloud-reconnect-task'
  const runId = 'cloud-reconnect-run'

  await startTaskJob({
    runId,
    userId,
    conversationId,
    runner: async (emitter, signal) => {
      emitter.textDelta('first')
      await sleep(40)
      assert.equal(signal.aborted, false, 'closing the viewer stream must not abort the background job')
      emitter.textDelta('second')
      await sleep(40)
      emitter.done()
    },
  })

  const activeJob = await findActiveTaskJobForConversation(userId, conversationId)
  assert.equal(activeJob?.runId, runId, 'server active-run discovery must find a running job when localStorage is empty')
  assert.equal(activeJob?.conversationId, conversationId, 'server active-run discovery must return the correct conversation')

  const firstStream = createTaskJobEventStream({ userId, runId, conversationId, afterSeq: 0 })
  const firstEvents = await readEventsUntil(firstStream, (event) => (
    event.type === 'text_delta' && event.content === 'first'
  ))
  const firstSeq = Math.max(...firstEvents.map((event) => Number(event.seq || 0)))
  assert.ok(firstSeq > 0, 'first stream must receive a sequenced event before disconnect')

  await sleep(150)

  const reconnectStream = createTaskJobEventStream({ userId, runId, conversationId, afterSeq: firstSeq })
  const replayedEvents = await readEventsUntil(reconnectStream, (event) => event.type === 'done')
  assert.ok(
    replayedEvents.some((event) => event.type === 'text_delta' && event.content === 'second'),
    'reconnected stream must replay events emitted after the viewer disconnected',
  )
  assert.ok(
    replayedEvents.some((event) => event.type === 'done'),
    'reconnected stream must replay the terminal done event',
  )
  assert.equal(
    replayedEvents.some((event) => event.type === 'text_delta' && event.content === 'first'),
    false,
    'reconnected stream with afterSeq must not duplicate already-seen events',
  )

  const wrongConversationStream = createTaskJobEventStream({
    userId,
    runId,
    conversationId: 'other-task',
    afterSeq: 0,
  })
  const deniedEvents = await readEventsUntil(wrongConversationStream, (event) => event.type === 'error')
  assert.ok(
    deniedEvents.some((event) => event.type === 'error' && /access denied/i.test(String(event.message || ''))),
    'stream replay must reject a run id attached to a different conversation',
  )

  clearTaskJobsForTest()
}
`, 'utf8')

    await build({
      entryPoints: [runnerPath],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      logLevel: 'silent',
      packages: 'external',
    })

    const { runClosedTabReconnectSmoke } = await import(pathToFileURL(bundlePath).href)
    await runClosedTabReconnectSmoke()
    console.log('cloud background reconnect smoke checks passed')
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await main()
