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
  /DeepSeek maps "minimal", "low", and "medium" effort upward to "high"[\s\S]*return \{\s*thinking:\s*\{\s*type:\s*'disabled'\s*\}\s*\}/,
  'direct DeepSeek requests must use its true non-thinking mode instead of a mapped-up effort',
)
assert.doesNotMatch(
  llmSource,
  /DEFAULT_DEEPSEEK_THINKING_ENABLED/,
  'no environment flag may silently re-enable direct DeepSeek thinking',
)
assert.match(
  llmSource,
  /withoutDeepSeekReasoningHistory\([\s\S]*reasoning_content:\s*_reasoningContent[\s\S]*providerMessages = withoutDeepSeekReasoningHistory/,
  'stale DeepSeek reasoning traces must be removed before non-thinking requests',
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
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body || '{}'))
  captured.push(body)
  if (body.stream) {
    return new Response(
      'data: {"id":"reasoning-mode-smoke-stream","choices":[{"delta":{"content":"ok"},"index":0}]}\\n\\n' +
      'data: [DONE]\\n\\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    )
  }
  return new Response(JSON.stringify({
    id: 'reasoning-mode-smoke',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00001 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const llm = await import(${JSON.stringify(pathToFileURL(bundlePath).href)})
const provider = process.env.LLM_PROVIDER
const common = {
  retryMaxAttempts: 0,
  includeTemporalContext: false,
}

if (provider === 'deepseek') {
  await llm.createCompletion({
    ...common,
    messages: [{ role: 'system', content: 'Plan accurately.' }, { role: 'user', content: 'Plan this task.' }],
    max_tokens: 1400,
    reasoning: { effort: 'xhigh', enabled: true, exclude: false },
  })
  const actionStream = await llm.createStreamingCompletion({
    ...common,
    messages: [{ role: 'user', content: 'Take the next action.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'web_search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    }],
    tool_choice: 'required',
    max_tokens: 384,
    reasoning: { effort: 'minimal', exclude: true },
  })
  for await (const _chunk of actionStream) {}
  await llm.createCompletion({
    ...common,
    messages: [
      { role: 'assistant', content: null, reasoning_content: 'stale hidden trace', tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"query":"official source"}' },
      }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
      { role: 'system', content: 'Recover with valid JSON.' },
    ],
    max_tokens: 512,
    reasoning: { enabled: false, exclude: true },
  })
  await llm.createCompletion({
    ...common,
    messages: [{ role: 'system', content: 'Synthesize a complete answer.' }, { role: 'user', content: 'Write it.' }],
    max_tokens: 6000,
  })
} else {
  await llm.createCompletion({
    ...common,
    messages: [{ role: 'user', content: 'Acknowledge.' }],
    max_tokens: 256,
    reasoning: { enabled: false, exclude: true },
  })
  const actionStream = await llm.createStreamingCompletion({
    ...common,
    messages: [{ role: 'user', content: 'Take the next action.' }],
    max_tokens: 384,
    reasoning: { effort: 'xhigh', exclude: false },
  })
  for await (const _chunk of actionStream) {}
  await llm.createCompletion({
    ...common,
    messages: [{ role: 'user', content: 'Synthesize.' }],
    max_tokens: 6000,
  })
}

process.stdout.write('__CAPTURED_REQUESTS__' + JSON.stringify(captured))
`

  const runProbe = async (provider, extraEnv) => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      probeSource,
    ], {
      cwd: root,
      env: {
        ...process.env,
        LLM_PROVIDER: provider,
        ASSISTANT_PROVIDER: provider,
        DEEPSEEK_API_KEY: 'smoke-deepseek-key',
        OPENROUTER_API_KEY: 'smoke-openrouter-key',
        ...extraEnv,
      },
      maxBuffer: 4 * 1024 * 1024,
    })
    const marker = '__CAPTURED_REQUESTS__'
    const jsonStart = stdout.lastIndexOf(marker)
    assert.ok(jsonStart >= 0, `${provider} probe must emit captured request JSON`)
    return JSON.parse(stdout.slice(jsonStart + marker.length))
  }

  const deepSeekBodies = await runProbe('deepseek', {
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_THINKING_ENABLED: 'true',
    DEEPSEEK_REASONING_EFFORT: 'xhigh',
  })
  assert.equal(deepSeekBodies.length, 4)
  assert.deepEqual(
    deepSeekBodies.map(body => body.max_tokens),
    [1400, 384, 512, 6000],
    'non-thinking mode must not shrink planning, action, recovery, or synthesis output budgets',
  )
  for (const body of deepSeekBodies) {
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal('reasoning_effort' in body, false)
    assert.equal('reasoning' in body, false)
  }
  assert.equal(
    'reasoning_content' in deepSeekBodies[2].messages[0],
    false,
    'non-thinking recovery history must not resend a stale hidden trace',
  )
  assert.equal(deepSeekBodies[1].tool_choice, 'required')
  assert.equal(deepSeekBodies[1].tools[0].function.name, 'web_search')

  const openRouterBodies = await runProbe('openrouter', {
    OPENROUTER_MODEL: 'google/gemini-3.1-flash-lite',
    OPENROUTER_REASONING_EFFORT: 'minimal',
    OPENROUTER_REASONING_EXCLUDE: 'true',
  })
  assert.equal(openRouterBodies.length, 3)
  assert.deepEqual(
    openRouterBodies.map(body => body.max_tokens),
    [256, 384, 6000],
    'the DeepSeek-only pin must preserve every OpenRouter output budget',
  )
  assert.deepEqual(
    openRouterBodies.map(body => body.reasoning),
    [
      { enabled: false, exclude: true },
      { effort: 'xhigh', exclude: false },
      { effort: 'minimal', exclude: true },
    ],
    'hard-pinning DeepSeek non-thinking mode must not alter OpenRouter caller/default reasoning behavior',
  )

  console.log('Provider reasoning mode smoke test passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
