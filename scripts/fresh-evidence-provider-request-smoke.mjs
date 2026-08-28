import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.fresh-evidence-provider-request-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const mockLlmPath = join(workDir, 'mock-llm.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(mockLlmPath, `
export const ASSISTANT_SUPPORTS_AUDIO_INPUT = true
export const ASSISTANT_SUPPORTS_FILE_INPUT = true
export const ASSISTANT_SUPPORTS_IMAGE_INPUT = true
export const ASSISTANT_SUPPORTS_VIDEO_INPUT = true
export const ASSISTANT_PROVIDER = 'openrouter'
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash'
export function resolveModel() { return DEFAULT_MODEL }
export async function createCompletion() { return { choices: [{ message: { content: '{}' } }] } }
export async function createStreamingCompletion(params: unknown) {
  const requests = ((globalThis as any).__providerRequests ||= [])
  requests.push(params)
  return (async function* () {})()
}
`)

  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { AgentLoop } from ${JSON.stringify(join(root, 'src/lib/agent/AgentLoop.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { computeTimeouts, resolveStrategy } from ${JSON.stringify(join(root, 'src/lib/agent/TaskStrategy.ts'))}
import { ToolRegistry } from ${JSON.stringify(join(root, 'src/lib/agent/ToolRegistry.ts'))}
import { toolDefinitions } from ${JSON.stringify(join(root, 'src/lib/tools.ts'))}

const request = 'Research the current product documentation and verify the visually displayed availability.'
const strategy = resolveStrategy([{ role: 'user', content: request }])

function makeState() {
  const state = createInitialState(false, computeTimeouts(strategy))
  state.originalUserRequest = request
  state.taskStrategy = 'research'
  state.strategyConfig = strategy
  state.taskComplexity = 2
  state.currentPhase = 'research'
  state.currentPlanItems = ['Research the product documentation', 'Deliver the sourced comparison']
  state.currentPlanScopes = ['Extract the documented capabilities and limits.', 'Compare the evidence and answer the user.']
  state.currentStepIdx = 0
  state.iterations = 1
  state.dynamicIterationLimit = 20
  state.perStepBudget = 8
  state.deliverableStepBudget = 8
  return state
}

const emitter = {
  textDelta() {}, progressUpdate() {}, reasoningDelta() {}, reasoningDone() {},
  toolStart() {}, toolResult() {}, terminalOutput() {}, fileContentStart() {},
  fileContentDelta() {}, browserFrame() {}, plan() {}, artifactCreated() {},
  creditEvent() {}, stepAdvance() {}, done() {}, error() {}, close() {}, heartbeat() {},
}
const loop = new AgentLoop(emitter as any, {
  messages: [{ role: 'user', content: request }],
  model: 'z-ai/glm-5.3-flash',
  conversationId: 'fresh-evidence-provider-request-smoke',
})
const registry = new ToolRegistry().registerFromDefinitions(toolDefinitions)

const sourceTail = 'FINAL_DEEP_SOURCE_TAIL_MARKER'
const sourceMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: request },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'source-call',
      type: 'function',
      function: { name: 'read_document', arguments: '{"url":"https://example.com/guide","action_label":"Read complete product guide","plan_step_index":1}' },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'source-call',
    content: JSON.stringify({
      title: 'Complete product guide',
      source: 'https://example.com/guide',
      content: 'HEAD_SOURCE_MARKER ' + 'substantive documentation. '.repeat(1_500) + sourceTail,
    }),
  },
] as any[]

await (loop as any).callLLMWithRetry(
  'z-ai/glm-5.3-flash',
  sourceMessages,
  makeState(),
  strategy,
  registry,
)

const visualMarker = 'BROWSER VISUAL SNAPSHOT after browser_screenshot.'
const visualMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: request },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'visual-call',
      type: 'function',
      function: { name: 'browser_screenshot', arguments: '{"action_label":"Verify displayed availability","plan_step_index":1}' },
    }],
  },
  { role: 'tool', tool_call_id: 'visual-call', content: '{"success":true,"screenshotPath":"_browser_screenshots/current.jpg"}' },
  {
    role: 'user',
    content: [
      { type: 'text', text: visualMarker },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==', detail: 'low' } },
    ],
  },
] as any[]

await (loop as any).callLLMWithRetry(
  'z-ai/glm-5.3-flash',
  visualMessages,
  makeState(),
  strategy,
  registry,
)

const exactMatchTail = 'FINAL_EXACT_MATCH_TAIL_MARKER'
const exactMatchMessages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: request },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'exact-match-call',
      type: 'function',
      function: { name: 'browser_find_text', arguments: '{"query":"available now","action_label":"Confirm the displayed availability","plan_step_index":1}' },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'exact-match-call',
    content: JSON.stringify({
      success: true,
      matches: 1,
      text: 'Found 1 match for available now. EXACT_MATCH_HEAD ' + 'rendered surrounding context. '.repeat(300) + exactMatchTail,
    }),
  },
] as any[]

await (loop as any).callLLMWithRetry(
  'z-ai/glm-5.3-flash',
  exactMatchMessages,
  makeState(),
  strategy,
  registry,
)

const requests = (globalThis as any).__providerRequests as Array<{ messages?: any[] }>
assert.equal(requests.length, 3, 'all fresh-evidence model turns must reach the mocked provider boundary')

const sourceProviderMessages = requests[0].messages || []
const providerSourceResult = sourceProviderMessages.find(message => message.role === 'tool' && message.tool_call_id === 'source-call')
assert.ok(providerSourceResult, 'the immediate provider request must retain the current source tool result')
assert.match(providerSourceResult.content, /HEAD_SOURCE_MARKER/, 'the provider request must retain the source beginning')
assert.match(providerSourceResult.content, /FINAL_DEEP_SOURCE_TAIL_MARKER/, 'the provider request must retain the deep source tail')
assert.ok(providerSourceResult.content.length > 30_000, 'the provider request must receive the full bounded source rather than compact research metadata')

const visualProviderMessages = requests[1].messages || []
const providerVisual = visualProviderMessages.find(message => Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'image_url'))
assert.ok(providerVisual, 'the immediate provider request must retain the current browser image content')
assert.match(providerVisual.content.find((part: any) => part?.type === 'text')?.text || '', /BROWSER VISUAL SNAPSHOT/, 'the visual context label must accompany the image')

const exactMatchProviderMessages = requests[2].messages || []
const providerExactMatch = exactMatchProviderMessages.find(message => message.role === 'tool' && message.tool_call_id === 'exact-match-call')
assert.ok(providerExactMatch, 'the immediate provider request must retain a successful browser_find_text result after the exact guard clears')
assert.match(providerExactMatch.content, /EXACT_MATCH_HEAD/, 'the provider request must retain the rendered match beginning')
assert.match(providerExactMatch.content, /FINAL_EXACT_MATCH_TAIL_MARKER/, 'the provider request must retain the rendered match tail')
assert.ok(providerExactMatch.content.length > 5_000, 'the provider request must receive the full browser_find_text evidence rather than compact research metadata')

console.log(JSON.stringify({
  ok: true,
  providerRequests: requests.length,
  sourceCharactersAtProvider: providerSourceResult.content.length,
  exactMatchCharactersAtProvider: providerExactMatch.content.length,
  deepSourceTailRetained: true,
  browserImageRetained: true,
  exactBrowserMatchRetained: true,
}))
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'silent',
    alias: { '@': join(root, 'src') },
    plugins: [{
      name: 'mock-agent-llm-provider',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\/lib\/llm$/ }, () => ({ path: mockLlmPath }))
      },
    }],
  })

  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
