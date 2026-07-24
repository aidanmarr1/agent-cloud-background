import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const execFileAsync = promisify(execFile)
const root = process.cwd()
const llmPath = join(root, 'src/lib/llm.ts')
const llmSource = await readFile(llmPath, 'utf8')

assert.match(
  llmSource,
  /ASSISTANT_PROVIDER\s*=\s*'openrouter'\s+as const/,
  'the assistant provider must be statically pinned to OpenRouter',
)
assert.match(
  llmSource,
  /provider:\s*\{\s*sort:\s*'throughput'\s*\}/,
  'every request must prefer the fastest OpenRouter provider',
)
assert.doesNotMatch(
  llmSource,
  /process\.env\.DEEPSEEK_API_KEY|api\.deepseek\.com/,
  'the active provider module must not contain a DeepSeek credential or endpoint',
)

const workDir = await mkdtemp('/tmp/provider-reasoning-mode-smoke-')
const bundlePath = join(workDir, 'llm.mjs')

try {
  await build({
    entryPoints: [llmPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const probeSource = `
const captured = []
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body || '{}'))
  captured.push({ url: String(url), body })
  if (body.stream) {
    return new Response(
      'data: {"id":"provider-smoke-stream","choices":[{"delta":{"content":"ok"},"index":0}]}\\n\\n' +
      'data: [DONE]\\n\\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  return new Response(JSON.stringify({
    id: 'provider-smoke',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const llm = await import(${JSON.stringify(pathToFileURL(bundlePath).href)})
const common = { retryMaxAttempts: 0, includeTemporalContext: false }
await llm.createCompletion({
  ...common,
  model: 'stale/client-selected-model',
  messages: [{ role: 'user', content: 'Acknowledge.' }],
  max_tokens: 256,
})
const multimodalParts = [
  { type: 'text', text: 'Review every attached modality.' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  {
    type: 'file',
    file: {
      filename: 'brief.pdf',
      file_data: 'data:application/pdf;base64,cGRm',
    },
  },
  { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'mp3' } },
  { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
]
await llm.createCompletion({
  ...common,
  messages: [{ role: 'user', content: multimodalParts }],
  max_tokens: 256,
})
const stream = await llm.createStreamingCompletion({
  ...common,
  model: 'another/stale-model',
  messages: [{ role: 'user', content: 'Take the next action.' }],
  max_tokens: 384,
  reasoning: { effort: 'minimal', exclude: true },
})
for await (const _chunk of stream) {}
process.stdout.write('__CAPTURED_REQUESTS__' + JSON.stringify(captured))
`

  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    probeSource,
  ], {
    cwd: root,
    env: {
      ...process.env,
      LLM_PROVIDER: 'deepseek',
      ASSISTANT_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'ignored-stale-key',
      OPENROUTER_API_KEY: 'smoke-openrouter-key',
      OPENROUTER_MODEL: 'ignored/stale-model',
      OPENROUTER_REASONING_EFFORT: 'minimal',
      OPENROUTER_REASONING_EXCLUDE: 'true',
    },
    maxBuffer: 4 * 1024 * 1024,
  })

  const marker = '__CAPTURED_REQUESTS__'
  const jsonStart = stdout.lastIndexOf(marker)
  assert.ok(jsonStart >= 0, 'probe must emit captured request JSON')
  const requests = JSON.parse(stdout.slice(jsonStart + marker.length))
  assert.equal(requests.length, 3)

  for (const request of requests) {
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(request.body.model, 'google/gemini-3.5-flash-lite:nitro')
    assert.deepEqual(request.body.provider, { sort: 'throughput' })
    assert.deepEqual(request.body.usage, { include: true })
    assert.equal('thinking' in request.body, false)
    assert.equal('reasoning_effort' in request.body, false)
  }
  assert.deepEqual(requests[0].body.reasoning, { effort: 'minimal', exclude: true })
  assert.deepEqual(requests[1].body.messages[0].content, [
    { type: 'text', text: 'Review every attached modality.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    {
      type: 'file',
      file: {
        filename: 'brief.pdf',
        file_data: 'data:application/pdf;base64,cGRm',
      },
    },
    { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'mp3' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
  ])
  assert.deepEqual(requests[2].body.reasoning, { effort: 'minimal', exclude: true })

  console.log('OpenRouter Nitro provider mode smoke test passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
