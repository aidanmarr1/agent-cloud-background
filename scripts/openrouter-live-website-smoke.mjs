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

const workDir = await mkdtemp('/tmp/openrouter-live-website-smoke-')
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
    requestTimeoutMs: 120_000,
    messages: [{
      role: 'user',
      content: 'Call create_website exactly once to build a polished, responsive cafe landing page. HTML must stay between 4,000 and 7,000 characters, CSS between 4,000 and 7,000 characters, JavaScript at or below 1,500 characters, and all tool arguments at or below about 16,000 characters. No data URIs, embedded base64, long SVG paths, or repeated code.',
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'create_website',
        description: 'Create a complete website in one action.',
        parameters: {
          type: 'object',
          properties: {
            action_label: { type: 'string' },
            plan_step_index: { type: 'number' },
            output_path: { type: 'string' },
            html: { type: 'string' },
            css: { type: 'string' },
            javascript: { type: 'string' },
          },
          required: ['action_label', 'plan_step_index', 'html', 'css', 'javascript'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'create_website' } },
    parallel_tool_calls: false,
    max_tokens: 12_288,
    reasoning: { effort: 'minimal', exclude: true },
  })

  const call = response.choices?.[0]?.message?.tool_calls?.[0]
  if (!call) {
    console.log(JSON.stringify({
      model: response.model,
      provider: response.provider,
      elapsedMs: Date.now() - startedAt,
      finishReason: response.choices?.[0]?.finish_reason || null,
      contentPreview: String(response.choices?.[0]?.message?.content || '').slice(0, 1000),
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
    }))
  }
  assert.equal(call?.function?.name, 'create_website')
  const args = JSON.parse(call.function.arguments)
  assert.ok(String(args.html || '').length >= 500, 'website HTML must be substantive')
  assert.ok(String(args.css || '').length >= 500, 'website CSS must be substantive')
  assert.equal(typeof args.javascript, 'string')

  console.log(JSON.stringify({
    model: response.model,
    provider: response.provider,
    elapsedMs: Date.now() - startedAt,
    promptTokens: response.usage?.prompt_tokens || 0,
    completionTokens: response.usage?.completion_tokens || 0,
    htmlChars: args.html.length,
    cssChars: args.css.length,
    javascriptChars: args.javascript.length,
  }))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
