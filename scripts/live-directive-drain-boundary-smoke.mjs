import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../src/lib/agent/AgentLoop.ts', import.meta.url),
  'utf8',
)

function sectionBetween(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  assert.notEqual(start, -1, `missing section start: ${startNeedle}`)
  assert.notEqual(end, -1, `missing section end: ${endNeedle}`)
  return source.slice(start, end)
}

const streaming = sectionBetween("case 'STREAMING': {", "case 'EXECUTING_TOOLS': {")
const executing = sectionBetween("case 'EXECUTING_TOOLS': {", "case 'EVALUATING': {")
const completion = sectionBetween(
  '// Final directive acceptance and the empty-queue seal happen in one',
  '// ── Finalization',
)
const injectionWrapper = sectionBetween(
  'const injectRunLiveDirectives = async (',
  '/**\n     * Cadence narration',
)

assert.equal(
  (injectionWrapper.match(/this\.injectLiveDirectives\(contextManager, options\)/g) || []).length,
  1,
  'the run-scoped wrapper must delegate to the durable directive drain exactly once',
)
assert.match(
  injectionWrapper,
  /narrationIntentEpoch \+= 1[\s\S]*narrationSidecarAbortController\?\.abort/,
  'a newly injected directive must invalidate and cancel stale narration intent',
)

assert.equal(
  (streaming.match(/await injectRunLiveDirectives\(\)/g) || []).length,
  1,
  'STREAMING must drain live directives exactly once before the next model call',
)
assert.ok(
  streaming.indexOf('await injectRunLiveDirectives()') < streaming.indexOf('this.callLLMWithRetry('),
  'a newly accepted directive must be injected before the next model call',
)

const beforeExecution = executing.indexOf('await injectRunLiveDirectives()')
const executeAll = executing.indexOf('toolPipeline.executeAll(')
assert.ok(beforeExecution >= 0 && beforeExecution < executeAll, 'pending tools must retain their pre-execution directive supersession fence')

const resultBoundary = executing.slice(executeAll)
assert.doesNotMatch(
  resultBoundary,
  /injectRunLiveDirectives\(\)/,
  'the result-to-next-model transition must not perform a duplicate post-result drain before STREAMING drains again',
)
assert.match(
  executing.slice(beforeExecution, executeAll),
  /superseded:\s*true[\s\S]*Superseded by a newer live instruction before execution[\s\S]*phase = 'STREAMING'/,
  'a directive arriving after action selection must still supersede every pending visible tool before execution',
)
assert.match(
  resultBoundary,
  /Do not drain live directives again at the post-result boundary[\s\S]*phase = 'EVALUATING'/,
  'the intentional single-drain result boundary must remain documented next to its transition',
)

assert.match(
  completion,
  /injectRunLiveDirectives\(\{ sealWhenEmpty: true \}\)/,
  'completion must retain the atomic directive drain-and-seal boundary',
)
assert.match(
  completion,
  /NON_REOPENABLE_LIVE_DIRECTIVE_TERMINAL_REASONS[\s\S]*sealLiveDirectiveRun/,
  'non-reopenable terminal reasons must retain explicit run sealing',
)

const callSites = source.match(/await injectRunLiveDirectives\((?:\{ sealWhenEmpty: true \})?\)/g) || []
assert.equal(
  callSites.length,
  3,
  'live directive polling should have exactly one model boundary, one pending-tool supersession boundary, and one completion seal boundary',
)

console.log('live directive drain boundary smoke passed')
