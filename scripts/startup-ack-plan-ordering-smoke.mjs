#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts', '.startup-ack-plan-ordering-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  const eventDispatcher = await readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8')
  assert.match(
    eventDispatcher,
    /if \(!this\.startupAcknowledgment\) \{[\s\S]*this\.pendingStartupPlanItems = \[\.\.\.items\][\s\S]*return/,
    'the client must hold a plan event when its model-authored opening has not painted',
  )
  assert.match(
    eventDispatcher,
    /if \(this\.pendingStartupPlanItems\) \{[\s\S]*this\.captureStartupAcknowledgment\(\)[\s\S]*this\.activatePlan\(pendingPlan\)/,
    'the held plan must activate only after acknowledgement text reaches the message store',
  )

  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { PlanManager } from ${JSON.stringify(join(root, 'src/lib/agent/PlanManager.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { computeTimeouts } from ${JSON.stringify(join(root, 'src/lib/agent/TaskStrategy.ts'))}

type VisibleEvent = { type: 'text'; content: string } | { type: 'plan'; items: string[] }

let providerCallCount = 0
let completionResponder: (params: unknown) => Promise<unknown> = async () => {
  throw new Error('Unexpected provider call')
}
;(globalThis as any).__startupAckCompletion = async (params: unknown) => {
  providerCallCount += 1
  return completionResponder(params)
}

function streamFromResponse(response: any) {
  return {
    async *[Symbol.asyncIterator]() {
      const content = response?.choices?.[0]?.message?.content || ''
      const splitAt = Math.max(1, Math.min(content.length, Math.ceil(content.length / 2)))
      if (content) {
        yield { id: response.id, choices: [{ delta: { content: content.slice(0, splitAt) } }] }
        if (splitAt < content.length) {
          yield { id: response.id, choices: [{ delta: { content: content.slice(splitAt) } }] }
        }
      }
      yield {
        id: response.id,
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: response.usage,
      }
    },
  }
}

const defaultStreamingResponder = async (params: unknown) => streamFromResponse(await completionResponder(params))
let streamingResponder: (params: unknown) => Promise<any> = defaultStreamingResponder
;(globalThis as any).__startupAckStream = async (params: unknown) => {
  providerCallCount += 1
  return streamingResponder(params)
}
;(globalThis as any).__startupAckGenerationUsage = async () => null

function emitterFor(events: VisibleEvent[]) {
  return {
    get isClosed() { return false },
    get terminalStatus() { return null },
    textDelta(content: string) { events.push({ type: 'text', content }) },
    plan(items: string[]) { events.push({ type: 'plan', items }) },
    heartbeat() {}, progressUpdate() {}, reasoningDelta() {}, reasoningDone() {},
    toolStart() {}, toolResult() {}, browserFrame() {}, terminalOutput() {},
    fileContentStart() {}, fileContentDelta() {}, artifactCreated() {},
    creditEvent() {}, stepAdvance() {}, done() {}, error() {}, close() {},
  }
}

function state() {
  return createInitialState(false, computeTimeouts(2))
}

export async function run() {
  const request = 'Research Warmwind OS AI and deliver a sourced report.'
  const validAck = 'I’ll research Warmwind OS AI across primary and independent sources, then deliver a sourced report on its capabilities and limitations.'
  const plan = {
    ack: validAck,
    taskType: 'research',
    complexity: 2,
    steps: [
      { title: 'Research Warmwind OS AI evidence', scope: 'Gather concrete primary and independent evidence.' },
      { title: 'Deliver the sourced Warmwind OS AI report', scope: 'Synthesize the findings and limitations.' },
    ],
  }

  // Normal planner path: a valid model acknowledgement must be visible first.
  const normalEvents: VisibleEvent[] = []
  const normalManager = new PlanManager(emitterFor(normalEvents) as any, [{ role: 'user', content: request }], 2)
  const normalState = state()
  ;(normalManager as any).setStateRef(normalState)
  assert.equal(await (normalManager as any).emitParsedPlan(normalState, plan), true)
  assert.deepEqual(normalEvents.map(event => event.type), ['text', 'plan'])
  assert.match((normalEvents[0] as { type: 'text'; content: string }).content, /^I’ll research Warmwind OS AI/)

  // A valid acknowledgement carried by the planner must win immediately.
  const fastPlannerEvents: VisibleEvent[] = []
  const fastPlannerManager = new PlanManager(emitterFor(fastPlannerEvents) as any, [{ role: 'user', content: request }], 2)
  await Promise.race([
    (fastPlannerManager as any).emitParsedPlan(state(), plan),
    new Promise((_, reject) => setTimeout(() => reject(new Error('valid planner acknowledgement was delayed')), 75)),
  ])
  assert.deepEqual(fastPlannerEvents.map(event => event.type), ['text', 'plan'])

  // Normal startup runs a streaming acknowledgement beside the planner. An
  // incomplete fragment remains hidden; the first complete task-specific
  // sentence paints before the completed plan.
  const parallelStartupEvents: VisibleEvent[] = []
  const parallelStartupManager = new PlanManager(emitterFor(parallelStartupEvents) as any, [{ role: 'user', content: request }], 2)
  const parallelStartupState = state()
  providerCallCount = 0
  completionResponder = async (params: any) => params.response_format
    ? {
        id: 'gen-normal-plan',
        choices: [{ message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, cost: 0.0002 },
      }
    : {
        id: 'gen-normal-ack',
        choices: [{ message: { content: validAck } }],
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 },
      }
  let releaseAckRemainder!: () => void
  let firstAckChunkProcessed!: () => void
  const ackRemainderGate = new Promise<void>(resolve => { releaseAckRemainder = resolve })
  const firstAckChunkProcessedPromise = new Promise<void>(resolve => { firstAckChunkProcessed = resolve })
  streamingResponder = async () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        id: 'gen-normal-ack',
        choices: [{ delta: { content: 'I’ll research Warmwind OS AI' } }],
      }
      firstAckChunkProcessed()
      await ackRemainderGate
      yield {
        id: 'gen-normal-ack',
        choices: [{ delta: { content: ' across primary and independent sources, then deliver a sourced report on its capabilities and limitations.' } }],
      }
      yield {
        id: 'gen-normal-ack',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 },
      }
    },
  })
  ;(parallelStartupManager as any).setStateRef(parallelStartupState)
  parallelStartupManager.startPlanCall()
  const parallelAwait = parallelStartupManager.awaitPlan(parallelStartupState)
  await firstAckChunkProcessedPromise
  assert.deepEqual(parallelStartupEvents, [], 'an acknowledgement fragment must never paint before it is complete')
  releaseAckRemainder()
  await parallelAwait
  assert.equal(providerCallCount, 2)
  assert.equal(parallelStartupEvents.at(-1)?.type, 'plan')
  assert.ok(parallelStartupEvents.slice(0, -1).every(event => event.type === 'text'))
  assert.ok(parallelStartupEvents.filter(event => event.type === 'text').length >= 2)
  streamingResponder = defaultStreamingResponder

  // Regression: Muse can spend its entire output budget on hidden reasoning
  // and end with only a short visible fragment. That fragment must not block a
  // valid acknowledgement and plan already returned by the parallel planner.
  const truncatedAckEvents: VisibleEvent[] = []
  const truncatedAckManager = new PlanManager(emitterFor(truncatedAckEvents) as any, [{ role: 'user', content: request }], 2)
  const truncatedAckState = state()
  providerCallCount = 0
  completionResponder = async (params: any) => {
    assert.ok(params.response_format, 'the valid planner should satisfy startup without an acknowledgement repair call')
    return {
      id: 'gen-truncated-ack-plan',
      choices: [{ message: { content: JSON.stringify(plan) } }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, cost: 0.0002 },
    }
  }
  streamingResponder = async () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        id: 'gen-truncated-ack',
        choices: [{ delta: { content: 'I’ll research Warmwind OS AI with' } }],
      }
      yield {
        id: 'gen-truncated-ack',
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 50, completion_tokens: 320, total_tokens: 370, cost: 0.0003 },
      }
    },
  })
  ;(truncatedAckManager as any).setStateRef(truncatedAckState)
  truncatedAckManager.startPlanCall()
  await truncatedAckManager.awaitPlan(truncatedAckState)
  assert.equal(providerCallCount, 2)
  assert.deepEqual(truncatedAckEvents.map(event => event.type), ['text', 'plan'])
  assert.equal(
    (truncatedAckEvents[0] as { type: 'text'; content: string }).content,
    validAck + '\\n\\n',
    'the planner-authored complete acknowledgement must replace the hidden truncated draft',
  )
  assert.equal(
    truncatedAckEvents.some(event => event.type === 'text' && event.content.includes('with\\n\\n')),
    false,
    'the incomplete provider fragment must never become visible',
  )
  streamingResponder = defaultStreamingResponder

  // Short subjects can be expanded semantically by the model. "AI" becoming
  // "artificial intelligence" must not trigger acknowledgement or plan repair.
  const shortTopicRequest = 'research about ai'
  const expandedShortTopicAck = 'I’ll research artificial intelligence, examine its current applications and deliver a concise overview of the field.'
  const shortTopicPlan = {
    ack: expandedShortTopicAck,
    taskType: 'research',
    complexity: 2,
    steps: [
      { title: 'Research artificial intelligence foundations', scope: 'Gather reliable evidence on the field and its core branches.' },
      { title: 'Assess current artificial intelligence applications', scope: 'Compare representative uses, capabilities and limitations.' },
      { title: 'Deliver the artificial intelligence overview', scope: 'Synthesize the findings into a concise, sourced report.' },
    ],
  }
  const shortTopicEvents: VisibleEvent[] = []
  const shortTopicManager = new PlanManager(emitterFor(shortTopicEvents) as any, [{ role: 'user', content: shortTopicRequest }], 2)
  const shortTopicState = state()
  providerCallCount = 0
  completionResponder = async (params: any) => params.response_format
    ? {
        id: 'gen-short-topic-plan',
        choices: [{ message: { content: JSON.stringify(shortTopicPlan) } }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, cost: 0.0002 },
      }
    : {
        id: 'gen-short-topic-ack',
        choices: [{ message: { content: expandedShortTopicAck } }],
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 },
      }
  ;(shortTopicManager as any).setStateRef(shortTopicState)
  shortTopicManager.startPlanCall()
  await shortTopicManager.awaitPlan(shortTopicState)
  assert.equal(providerCallCount, 2, 'semantic expansion must complete without paid repair calls')
  assert.equal(shortTopicEvents.at(-1)?.type, 'plan')
  assert.ok(shortTopicEvents.slice(0, -1).every(event => event.type === 'text'))

  // If both planner drafts are malformed, the successful fast acknowledgement
  // must survive so AgentLoop can recover into a task-specific execution plan
  // instead of showing the planner-repair error to the user.
  const recoveryEvents: VisibleEvent[] = []
  const recoveryManager = new PlanManager(emitterFor(recoveryEvents) as any, [{ role: 'user', content: request }], 2)
  const recoveryState = state()
  providerCallCount = 0
  completionResponder = async (params: any) => params.response_format
    ? {
        id: 'gen-invalid-plan',
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, cost: 0.0001 },
      }
    : {
        id: 'gen-recovery-ack',
        choices: [{ message: { content: validAck } }],
        usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 },
      }
  ;(recoveryManager as any).setStateRef(recoveryState)
  recoveryManager.startPlanCall()
  await assert.rejects(recoveryManager.awaitPlan(recoveryState), /usable task-specific plan after repair/)
  assert.equal(recoveryManager.recoverFromPlannerFailure(recoveryState), true)
  assert.equal(providerCallCount, 4)
  assert.equal(recoveryEvents.at(-1)?.type, 'plan')
  assert.ok(recoveryEvents.slice(0, -1).every(event => event.type === 'text'))

  // The one acknowledgement request used with a precomputed plan should paint
  // before its exact usage debit settles, while first-step work remains fenced.
  const usageFencedEvents: VisibleEvent[] = []
  let releaseUsage!: () => void
  let usageStarted!: () => void
  const usageStartedPromise = new Promise<void>(resolve => { usageStarted = resolve })
  const usageGate = new Promise<void>(resolve => { releaseUsage = resolve })
  const usageFencedManager = new PlanManager(
    emitterFor(usageFencedEvents) as any,
    [{ role: 'user', content: request }],
    2,
    [],
    undefined,
    async (usage, chargeId) => {
      assert.equal(chargeId, 'plan:ack:1')
      assert.equal(usage.cost, 0.0001)
      usageStarted()
      await usageGate
    },
  )
  const usageFencedState = state()
  assert.equal(usageFencedManager.usePrecomputedPlan(usageFencedState, {
    items: plan.steps.map(step => step.title),
  }, { emitPlan: false }), true)
  providerCallCount = 0
  completionResponder = async () => ({
    id: 'gen-precomputed-ack',
    choices: [{ message: { content: validAck } }],
    usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 },
  })
  usageFencedManager.startAcknowledgementCall()
  const fencedAwait = usageFencedManager.awaitPlan(usageFencedState)
  await usageStartedPromise
  assert.equal(providerCallCount, 1)
  assert.ok(usageFencedEvents.length >= 1)
  assert.ok(usageFencedEvents.every(event => event.type === 'text'))
  let fencedSettled = false
  void fencedAwait.then(() => { fencedSettled = true })
  await Promise.resolve()
  assert.equal(fencedSettled, false)
  releaseUsage()
  await fencedAwait
  assert.ok(usageFencedEvents.every(event => event.type === 'text'))

  // If every model acknowledgement candidate is unusable, no plan can leak.
  const rejectedEvents: VisibleEvent[] = []
  const rejectedManager = new PlanManager(emitterFor(rejectedEvents) as any, [{ role: 'user', content: request }], 2)
  ;(rejectedManager as any).repairAcknowledgementCandidate = async () => ''
  await assert.rejects(
    (rejectedManager as any).emitParsedPlan(state(), { ...plan, ack: 'Researching...' }),
    /task-specific plan or acknowledgement/,
  )
  assert.equal(rejectedEvents.some(event => event.type === 'plan'), false)

  // Precomputed plans start only the worker-owned acknowledgement request and
  // await it before first-step work, without emitting a duplicate plan event.
  const precomputedEvents: VisibleEvent[] = []
  const precomputedManager = new PlanManager(emitterFor(precomputedEvents) as any, [{ role: 'user', content: request }], 2)
  const precomputedState = state()
  assert.equal(precomputedManager.usePrecomputedPlan(precomputedState, {
    items: plan.steps.map(step => step.title),
    scopes: plan.steps.map(step => step.scope),
  }, { emitPlan: false }), true)
  ;(precomputedManager as any).emitModelGeneratedAcknowledgement = async () => {
    ;(precomputedManager as any).emitter.textDelta(validAck + '\\n\\n')
    ;(precomputedManager as any).acknowledgementEmitted = true
    return true
  }
  precomputedManager.startAcknowledgementCall()
  await precomputedManager.awaitPlan(precomputedState)
  assert.deepEqual(precomputedEvents.map(event => event.type), ['text'])

  // A caller cannot accidentally emit a precomputed plan before the opening.
  const guardedEvents: VisibleEvent[] = []
  const guardedManager = new PlanManager(emitterFor(guardedEvents) as any, [{ role: 'user', content: request }], 2)
  assert.equal(guardedManager.usePrecomputedPlan(state(), {
    items: plan.steps.map(step => step.title),
  }), false)
  assert.deepEqual(guardedEvents, [])

  // Failed precomputed acknowledgement generation stops before work and never
  // substitutes a deterministic placeholder.
  const failedPrecomputedEvents: VisibleEvent[] = []
  const failedPrecomputedManager = new PlanManager(emitterFor(failedPrecomputedEvents) as any, [{ role: 'user', content: request }], 2)
  const failedPrecomputedState = state()
  assert.equal(failedPrecomputedManager.usePrecomputedPlan(failedPrecomputedState, {
    items: plan.steps.map(step => step.title),
  }, { emitPlan: false }), true)
  ;(failedPrecomputedManager as any).emitModelGeneratedAcknowledgement = async () => false
  ;(failedPrecomputedManager as any).repairAcknowledgementCandidate = async () => ''
  failedPrecomputedManager.startAcknowledgementCall()
  await assert.rejects(
    failedPrecomputedManager.awaitPlan(failedPrecomputedState),
    /task-specific plan or acknowledgement/,
  )
  assert.deepEqual(failedPrecomputedEvents, [])
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
    packages: 'external',
    plugins: [{
      name: 'mock-startup-ack-llm',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\/lib\/llm$/ }, () => ({
          path: 'startup-ack-llm',
          namespace: 'startup-ack-test',
        }))
        buildApi.onLoad({ filter: /.*/, namespace: 'startup-ack-test' }, () => ({
          loader: 'js',
          contents: `
            export const DEFAULT_MODEL = 'test/startup-model'
            export async function createCompletion(params) {
              return globalThis.__startupAckCompletion(params)
            }
            export async function createStreamingCompletion(params) {
              return globalThis.__startupAckStream(params)
            }
            export async function fetchGenerationUsage(id, signal) {
              return globalThis.__startupAckGenerationUsage(id, signal)
            }
          `,
        }))
      },
    }],
  })

  const { run } = await import(pathToFileURL(bundlePath).href)
  await run()
  console.log('startup acknowledgement/plan ordering smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
