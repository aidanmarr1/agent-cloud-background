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
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_tokens: 64,
  })

  assert.match(String(response.model || ''), /^google\/gemini-3\.5-flash-lite(?:-\d+)?$/)
  assert.ok(['Google', 'Google AI Studio'].includes(String(response.provider || '')))
  assert.ok(response.choices?.[0]?.message?.tool_calls?.length, 'Gemini must return the required native tool call')

  const reasoningTokens = Number(response.usage?.completion_tokens_details?.reasoning_tokens || 0)
  assert.ok(reasoningTokens >= 0, 'reasoning usage must be a non-negative token count')

  console.log(JSON.stringify({
    model: response.model,
    provider: response.provider,
    reasoningTokens,
    toolCall: response.choices[0].message.tool_calls[0]?.function?.name || 'route_probe',
  }))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
