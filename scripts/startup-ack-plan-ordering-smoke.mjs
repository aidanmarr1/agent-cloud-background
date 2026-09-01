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
    'the client must hold a plan event until its model-authored opening has painted',
  )

  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { PlanManager } from ${JSON.stringify(join(root, 'src/lib/agent/PlanManager.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { computeTimeouts } from ${JSON.stringify(join(root, 'src/lib/agent/TaskStrategy.ts'))}

type VisibleEvent = { type: 'text'; content: string } | { type: 'plan'; items: string[] }

let providerCallKinds: string[] = []
let completionResponder: (params: any) => Promise<any> = async () => { throw new Error('Unexpected completion call') }
let streamingResponder: (params: any) => Promise<any> = async () => { throw new Error('Unexpected stream call') }
;(globalThis as any).__startupAckCompletion = async (params: any) => {
  providerCallKinds.push(params.response_format ? 'plan-json' : 'completion')
  return completionResponder(params)
}
;(globalThis as any).__startupAckStream = async (params: any) => {
  providerCallKinds.push(params.response_format ? 'plan-stream' : 'ack-stream')
  return streamingResponder(params)
}
;(globalThis as any).__startupAckGenerationUsage = async () => null

function streamText(id: string, content: string, usage = { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, cost: 0.0001 }) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { id, choices: [{ delta: { content } }] }
      yield { id, choices: [{ delta: {}, finish_reason: 'stop' }], usage }
    },
  }
}

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

function state() { return createInitialState(false, computeTimeouts(2)) }
const request = 'Research Warmwind OS AI and deliver a sourced report.'
const validAck = 'I’ll research Warmwind OS AI across primary and independent sources, then deliver a sourced report on its capabilities and limitations.'
const plan = {
  ack: validAck,
  taskType: 'research',
  complexity: 2,
  steps: [
    { title: 'Research Warmwind OS AI evidence', scope: 'Gather concrete primary and independent evidence.' },
    { title: 'Assess Warmwind OS AI capabilities and limitations', scope: 'Reconcile the strongest findings and caveats.' },
    { title: 'Deliver the sourced Warmwind OS AI report', scope: 'Synthesize the evidence into the requested report.' },
  ],
}

export async function run() {
  const directEvents: VisibleEvent[] = []
  const directManager = new PlanManager(emitterFor(directEvents) as any, [{ role: 'user', content: request }], 2)
  assert.equal(await (directManager as any).emitParsedPlan(state(), plan), true)
  assert.deepEqual(directEvents.map(event => event.type), ['text', 'plan'])

  // The acknowledgement call starts first. Planning starts immediately too,
  // but an early plan cannot become visible until the opening is complete.
  const orderedEvents: VisibleEvent[] = []
  const orderedManager = new PlanManager(emitterFor(orderedEvents) as any, [{ role: 'user', content: request }], 2)
  const orderedState = state()
  let releaseAck!: () => void
  let ackRequestStarted!: () => void
  const ackGate = new Promise<void>(resolve => { releaseAck = resolve })
  const ackStarted = new Promise<void>(resolve => { ackRequestStarted = resolve })
  providerCallKinds = []
  streamingResponder = async (params: any) => {
    if (params.response_format) return streamText('gen-plan', JSON.stringify(plan), { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180, cost: 0.0002 })
    ackRequestStarted()
    await ackGate
    return streamText('gen-ack', validAck)
  }
  ;(orderedManager as any).setStateRef(orderedState)
  orderedManager.startPlanCall()
  const orderedAwait = orderedManager.awaitPlan(orderedState)
  await ackStarted
  await Promise.resolve()
  assert.deepEqual(orderedEvents, [], 'a plan that finishes early must not appear ahead of the acknowledgement')
  releaseAck()
  await orderedAwait
  assert.deepEqual(providerCallKinds, ['ack-stream', 'plan-stream'])
  assert.equal(orderedEvents.at(-1)?.type, 'plan')
  assert.ok(orderedEvents.slice(0, -1).every(event => event.type === 'text'))
  assert.equal(
    orderedEvents.filter(event => event.type === 'text').map(event => event.content).join(''),
    validAck + '\\n\\n',
    'only the dedicated acknowledgement may own visible startup text',
  )

  // Long requests must not be cut at the former 1,000-character boundary.
  // End-of-prompt requirements are part of the acknowledgement input and its
  // quality contract, so they cannot spuriously force repair.
  const longRequest = 'Investigate workplace productivity evidence across sectors. ' +
    'Compare controlled trials with real outcomes and implementation costs. '.repeat(24) +
    'Final named requirement: include Warmwind in the delivered report.'
  assert.ok(longRequest.length > 1_000)
  const longAck = 'I’ll investigate workplace productivity evidence, include Warmwind and deliver the requested cross-sector report with controlled and real-world findings.'
  let observedLongAckPrompt = ''
  streamingResponder = async (params: any) => {
    const userContent = params.messages.at(-1)?.content
    observedLongAckPrompt = typeof userContent === 'string'
      ? userContent
      : (userContent || []).find((part: any) => part?.type === 'text')?.text || ''
    return streamText('gen-long-ack', longAck)
  }
  const longManager = new PlanManager(emitterFor([]) as any, [{ role: 'user', content: longRequest }], 3)
  assert.equal(await (longManager as any).emitModelGeneratedAcknowledgement('research'), true)
  assert.match(observedLongAckPrompt, /Final named requirement: include Warmwind/)

  // Recovery must be model-authored and visible. It may not silently install
  // a local plan before allowing tool execution.
  const recoveryEvents: VisibleEvent[] = []
  const recoveryManager = new PlanManager(emitterFor(recoveryEvents) as any, [{ role: 'user', content: request }], 2)
  const recoveryState = state()
  ;(recoveryManager as any).acknowledgementEmitted = true
  ;(recoveryManager as any).repairPlannerResponse = async () => plan
  assert.equal(await recoveryManager.recoverFromPlannerFailure(recoveryState), true)
  assert.deepEqual(recoveryEvents.map(event => event.type), ['plan'])
  assert.equal(recoveryState.planEmitted, true)

  const failedRecoveryEvents: VisibleEvent[] = []
  const failedRecoveryManager = new PlanManager(emitterFor(failedRecoveryEvents) as any, [{ role: 'user', content: request }], 2)
  const failedRecoveryState = state()
  ;(failedRecoveryManager as any).acknowledgementEmitted = true
  ;(failedRecoveryManager as any).repairPlannerResponse = async () => null
  assert.equal(await failedRecoveryManager.recoverFromPlannerFailure(failedRecoveryState), false)
  assert.equal(failedRecoveryState.planEmitted, false)
  assert.deepEqual(failedRecoveryEvents, [])

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
            export async function createCompletion(params) { return globalThis.__startupAckCompletion(params) }
            export async function createStreamingCompletion(params) { return globalThis.__startupAckStream(params) }
            export async function fetchGenerationUsage(id, signal) { return globalThis.__startupAckGenerationUsage(id, signal) }
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
