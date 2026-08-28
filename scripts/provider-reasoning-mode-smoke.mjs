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
  /PINNED_OPENROUTER_PROVIDER\s*=\s*'google-vertex\/global'[\s\S]*exactOpenRouterProviderRoute/,
  'Gemini must be pinned to the exact Google Vertex global provider endpoint',
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
const common = { retryMaxAttempts: 0, includeTemporalContext: false, temperature: 0.3 }
await llm.createCompletion({
  ...common,
  model: 'stale/client-selected-model',
  models: ['stale/fallback-model'],
  messages: [{ role: 'user', content: 'Acknowledge.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'probe',
      description: 'Probe tool compatibility.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }],
  tool_choice: 'required',
  max_tokens: 512,
  reasoning: { max_tokens: 192, exclude: true },
})
const multimodalParts = [
  { type: 'text', text: 'Review every natively supported attached modality.' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
]
await llm.createCompletion({
  ...common,
  messages: [{ role: 'user', content: multimodalParts }],
  max_tokens: 256,
})
await llm.createCompletion({
  ...common,
  messages: [{ role: 'user', content: 'Choose the probe when useful.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'probe',
      description: 'Probe automatic tool compatibility.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }],
  tool_choice: 'auto',
  max_tokens: 512,
  reasoning: { max_tokens: 192, exclude: true },
})
const stream = await llm.createStreamingCompletion({
  ...common,
  model: 'another/stale-model',
  messages: [{ role: 'user', content: 'Take the next action.' }],
  max_tokens: 384,
  reasoning: { max_tokens: 2_048, exclude: false },
})
for await (const _chunk of stream) {}
await llm.createCompletion({
  ...common,
  messages: [
    { role: 'user', content: 'Begin the task.' },
    { role: 'assistant', content: 'I have gathered the first result.' },
    { role: 'system', content: 'Continue with the next concrete action.' },
  ],
  max_tokens: 256,
})
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
      OPENROUTER_REASONING_EFFORT: 'xhigh',
      OPENROUTER_REASONING_EXCLUDE: 'false',
    },
    maxBuffer: 4 * 1024 * 1024,
  })

  const marker = '__CAPTURED_REQUESTS__'
  const jsonStart = stdout.lastIndexOf(marker)
  assert.ok(jsonStart >= 0, 'probe must emit captured request JSON')
  const requests = JSON.parse(stdout.slice(jsonStart + marker.length))
  assert.equal(requests.length, 5)

  for (const request of requests) {
    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(request.body.model, 'google/gemini-3.7-flash')
    assert.equal('models' in request.body, false)
    assert.deepEqual(request.body.provider, {
      order: ['google-vertex/global'],
      only: ['google-vertex/global'],
      allow_fallbacks: false,
      require_parameters: true,
    })
    assert.deepEqual(request.body.usage, { include: true })
    assert.equal('thinking' in request.body, false)
    assert.equal('reasoning_effort' in request.body, false)
    assert.equal('parallel_tool_calls' in request.body, false)
    assert.equal('temperature' in request.body, false)
  }
  assert.deepEqual(requests[0].body.reasoning, { effort: 'minimal', exclude: true })
  assert.equal(requests[0].body.tool_choice, 'auto')
  assert.equal(requests[0].body.tools[0].function.name, 'probe')
  assert.deepEqual(requests[1].body.messages[0].content, [
    { type: 'text', text: 'Review every natively supported attached modality.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=' } },
  ])
  assert.deepEqual(requests[1].body.reasoning, { effort: 'minimal', exclude: true })
  assert.deepEqual(requests[2].body.reasoning, { effort: 'minimal', exclude: true })
  assert.equal(requests[2].body.tool_choice, 'auto')
  assert.deepEqual(requests[3].body.reasoning, { effort: 'minimal', exclude: true })
  assert.deepEqual(requests[4].body.reasoning, { effort: 'minimal', exclude: true })
  assert.deepEqual(
    requests[4].body.messages.slice(-3),
    [
      { role: 'assistant', content: 'I have gathered the first result.' },
      { role: 'system', content: 'Continue with the next concrete action.' },
      {
        role: 'user',
        content: 'Continue the active task from the latest completed work. Follow the current instructions and return the next LLM-authored action or progress update.',
      },
    ],
    'Gemini histories must preserve the exact task context and end with a valid input turn',
  )
  assert.equal(
    requests[4].body.messages.some(message =>
      message.role === 'assistant' && message.content === 'I have gathered the first result.'
    ),
    true,
    'provider compatibility must retain the original assistant history',
  )

  console.log('Gemini 3.7 Flash exact Google Vertex global provider and minimal reasoning smoke test passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
