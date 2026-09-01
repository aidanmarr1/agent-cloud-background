#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp('/tmp/streaming-request-timeout-smoke-')
const bundlePath = join(workDir, 'llm.mjs')

try {
  await build({
    entryPoints: [join(root, 'src/lib/llm.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  process.env.OPENROUTER_API_KEY = 'stream-timeout-smoke-key'
  let providerSawAbort = false
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal
    const body = new ReadableStream({
      start(controller) {
        const abort = () => {
          providerSawAbort = true
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      },
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const llm = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  const startedAt = Date.now()
  const stream = await llm.createStreamingCompletion({
    messages: [{ role: 'user', content: 'Return one short acknowledgement.' }],
    includeTemporalContext: false,
    requestTimeoutMs: 50,
    retryMaxAttempts: 0,
    max_tokens: 64,
  })

  await assert.rejects(
    Promise.race([
      (async () => {
        for await (const _chunk of stream) {
          // The mocked provider never emits a body chunk.
        }
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stream body deadline did not fire')), 1000)),
    ]),
    (error) => error instanceof Error && /abort|deadline did not fire/i.test(`${error.name} ${error.message}`),
  )

  const elapsedMs = Date.now() - startedAt
  assert.equal(providerSawAbort, true, 'the request controller must abort a stalled SSE body after headers')
  assert.ok(elapsedMs < 800, `stream body timeout should fire promptly, observed ${elapsedMs}ms`)
  console.log('streaming request body timeout smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
