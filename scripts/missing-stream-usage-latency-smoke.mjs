import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.missing-stream-usage-latency-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { StreamProcessor } from ${JSON.stringify(join(root, 'src/lib/agent/StreamProcessor.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { estimateConservativeMissingStreamUsage } from ${JSON.stringify(join(root, 'src/lib/agent/StreamUsageEstimate.ts'))}

const timeouts = {
  iterationTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function makeEmitter() {
  return {
    textDelta() {}, progressUpdate() {}, reasoningDelta() {}, reasoningDone() {}, toolStart() {}, toolResult() {},
    terminalOutput() {}, fileContentStart() {}, fileContentDelta() {}, plan() {}, artifactCreated() {},
    stepAdvance() {}, done() {}, error() {}, close() {}, get isClosed() { return false },
  }
}

async function* chunksWithoutUsage() {
  yield {
    id: 'generation-with-delayed-metadata',
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: 'call_search',
      function: {
        name: 'web_search',
        arguments: '{"action_label":"Verify agent latency evidence","plan_step_index":1,"query":"agent latency evidence"}',
      },
    }] } }],
  }
}

async function* chunksWithInlineUsage() {
  yield { choices: [{ delta: { content: 'Inline usage wins.' } }] }
  yield {
    choices: [],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      cost: 0.000123,
    },
  }
}

export async function runSmoke() {
  let metadataFetches = 0
  globalThis.fetch = async () => {
    metadataFetches += 1
    return new Response('{"error":"not ready"}', { status: 404 })
  }

  const state = createInitialState(false, timeouts)
  state.currentPlanItems = ['Verify latency evidence']
  state.currentStepIdx = 0
  const processor = new StreamProcessor(makeEmitter() as any, timeouts)
  const requestMessages = [{ role: 'user', content: 'Verify current agent latency evidence.' }]
  const requestTools = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }]
  const startedAt = performance.now()
  const result = await processor.processStream(
    chunksWithoutUsage() as any,
    state,
    false,
    output => estimateConservativeMissingStreamUsage({
      model: 'google/gemini-3.6-flash:nitro',
      requestMessages,
      requestTools,
      assistantContent: output.assistantContent,
      reasoningContent: output.reasoningContent,
      toolCalls: [...output.toolCalls.values()],
    }),
  )
  const elapsedMs = performance.now() - startedAt

  assert.equal(metadataFetches, 0, 'missing streamed usage must not make a generation-metadata request')
  assert.ok(elapsedMs < 150, 'processStream must not sleep or poll before returning missing-usage estimate (elapsed=' + elapsedMs.toFixed(1) + 'ms)')
  assert.equal(result.usageEstimated, true)
  assert.ok((result.usage?.promptTokens || 0) > 0, 'estimated prompt usage must be nonzero')
  assert.ok((result.usage?.completionTokens || 0) > 0, 'estimated completion usage must be nonzero')
  assert.ok((result.usage?.totalTokens || 0) > 0, 'estimated total usage must be nonzero')
  assert.ok((result.usage?.cost || 0) > 0, 'estimated cost must be nonzero for synchronous debit')
  assert.equal(result.toolCalls.size, 1, 'usage fallback must not alter the streamed action')

  let fallbackCalls = 0
  const inlineResult = await new StreamProcessor(makeEmitter() as any, timeouts).processStream(
    chunksWithInlineUsage() as any,
    createInitialState(false, timeouts),
    false,
    () => {
      fallbackCalls += 1
      throw new Error('inline provider usage must bypass estimation')
    },
  )
  assert.equal(fallbackCalls, 0, 'inline provider usage must never be estimated or double-counted')
  assert.equal(inlineResult.usageEstimated, false)
  assert.deepEqual(inlineResult.usage, {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
    cost: 0.000123,
  })
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
  })

  process.env.LLM_PROVIDER = 'openrouter'
  process.env.OPENROUTER_API_KEY = 'smoke-test-key'
  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  await runSmoke()
  console.log('missing streamed usage latency smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
