#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = process.cwd()
loadLocalEnvFiles(rootUrl)

assert.ok(process.env.OPENROUTER_API_KEY?.trim(), 'OPENROUTER_API_KEY is required')

const workDir = await mkdtemp('/tmp/openrouter-live-route-smoke-')
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

  const llm = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  const startedAt = Date.now()
  const response = await llm.createCompletion({
    model: 'ignored/stale-model',
    includeTemporalContext: false,
    retryMaxAttempts: 0,
    requestTimeoutMs: 45_000,
    messages: [{ role: 'user', content: 'Call the route_probe tool exactly once.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'route_probe',
        description: 'Confirm native tool routing.',
        parameters: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'route_probe' } },
    parallel_tool_calls: false,
    temperature: 0.3,
    max_tokens: 512,
    reasoning: { effort: 'minimal', exclude: true },
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(response.model, 'google/gemini-3.8-flash')
  assert.ok(response.choices?.[0]?.message?.tool_calls?.length, 'Gemini 3.8 Flash must return the required native tool call')

  const reasoningTokens = Number(response.usage?.completion_tokens_details?.reasoning_tokens || 0)
  assert.ok(response.choices[0].message.reasoning_details?.length, 'tool calls must include Gemini thought signatures')

  const assistant = response.choices[0].message
  const call = assistant.tool_calls[0]
  const history = [
    { role: 'user', content: 'Call the route_probe tool exactly once. After its result, reply READY only.' },
    assistant,
    { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' },
  ]
  const followup = await llm.createStreamingCompletion({
    includeTemporalContext: false,
    retryMaxAttempts: 0,
    requestTimeoutMs: 45_000,
    messages: history,
    tools: [{ type: 'function', function: { name: 'route_probe', parameters: { type: 'object', properties: {} } } }],
    max_tokens: 1024,
  })
  let text = ''
  let streamUsage = null
  for await (const chunk of followup) {
    text += chunk.choices?.[0]?.delta?.content || ''
    if (chunk.usage) streamUsage = chunk.usage
  }
  assert.match(text, /READY/)
  assert.ok(streamUsage && Number.isFinite(streamUsage.cost), 'streaming must include priced token usage')
  // Verify the pinned preview accepts real image input without another model.
  const { default: sharp } = await import('sharp')
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const vision = await llm.createCompletion({
    includeTemporalContext: false,
    retryMaxAttempts: 0,
    requestTimeoutMs: 45_000,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'What color fills this image? Reply with one word.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
    ] }],
    max_tokens: 512,
  })
  assert.equal(vision.model, llm.DEFAULT_MODEL)
  assert.match(vision.choices[0].message.content, /red/i)

  console.log(JSON.stringify({
    model: response.model,
    provider: response.provider,
    providerSort: 'throughput',
    reasoningEffort: 'low',
    streamingToolFollowup: 'passed',
    vision: 'passed',
    elapsedMs,
    reasoningTokens,
    toolCall: response.choices[0].message.tool_calls[0]?.function?.name || 'route_probe',
  }))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
