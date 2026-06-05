import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function runSourceContracts() {
  const { readFile } = await import('node:fs/promises')
  const [
    researchLog,
    toolPipeline,
    agentLoop,
    agentState,
    chatRoute,
    prompts,
    planManager,
  ] = await Promise.all([
    readFile(join(root, 'src/lib/agent/ResearchActivityLog.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
  ])

  assert.match(researchLog, /create table if not exists task_research_activity/, 'hidden research activity must be DB-backed')
  assert.match(researchLog, /not agent memory and must not\s*\n\/\/ be used across fresh tasks/, 'research activity log must be documented as task-local runtime state only')
  assert.match(researchLog, /conversation_id text not null/, 'research log rows must attach to the task conversation')
  assert.match(researchLog, /searchLoopBlockReason/, 'research log must expose advisory search duplicate checks')
  assert.match(researchLog, /navigationLoopBlockReason/, 'research log must expose advisory navigation duplicate checks')
  assert.match(researchLog, /clearResearchActivityForTask/, 'fresh tasks must be able to clear hidden research logs')
  assert.match(toolPipeline, /recordResearchActivity/, 'ToolPipeline must record hidden research activity')
  assert.match(toolPipeline, /advisory memory, not a hard gate/, 'ToolPipeline must keep research activity advisory instead of hard-blocking tool calls')
  assert.match(toolPipeline, /appendResearchActivityEntry/, 'ToolPipeline must persist hidden research activity')
  const activityRepeatIndex = toolPipeline.indexOf('const activityRepeatReason')
  const cacheCheckIndex = toolPipeline.indexOf('// --- Check cache before execution ---')
  assert.ok(activityRepeatIndex >= 0 && cacheCheckIndex > activityRepeatIndex, 'ToolPipeline must compute research activity metadata before cache checks')
  assert.doesNotMatch(
    toolPipeline.slice(activityRepeatIndex, cacheCheckIndex),
    /await this\.recordResearchActivity/,
    'ToolPipeline must not persist successful research activity before cache lookup or actual tool execution',
  )
  assert.match(agentLoop, /loadResearchActivityEntries/, 'AgentLoop must hydrate hidden research activity')
  assert.match(agentLoop, /shouldInjectResearchActivityContext/, 'AgentLoop must gate hidden research context injection')
  assert.match(agentLoop, /state\.currentPhase === 'research'/, 'AgentLoop must keep hidden research context during research phases')
  assert.doesNotMatch(agentLoop, /hasActivePlanStep && !state\.forceTextNextIteration\s*\?\s*researchActivityContext/, 'AgentLoop must not inject hidden research context into every active plan step')
  assert.match(agentState, /researchActivity: createResearchActivityIndex/, 'AgentState must mirror the hidden research activity log')
  assert.doesNotMatch(agentState, /researchActivityContext/, 'work summaries must not duplicate the hidden research log injected by AgentLoop')
  assert.match(chatRoute, /clearResearchActivityForTask/, 'fresh isolated tasks must start with an empty hidden research log')
  assert.match(prompts, /hidden task research log is attached to this task in the database/i, 'system prompt must attach the hidden research log')
  assert.match(prompts, /Use the injected summary as compact memory/i, 'system prompt must treat the hidden research log as advisory compact memory')
  assert.match(planManager, /Use the hidden task research log as compact memory/i, 'per-step research rules must use the hidden log without hard preflight blocks')
}

async function runFunctionalChecks() {
  const workDir = await mkdtemp(join(tmpdir(), 'research-log-smoke-'))
  const runnerPath = join(workDir, 'runner.mjs')
  const bundlePath = join(workDir, 'bundle.mjs')
  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  addResearchActivityToIndex,
  createResearchActivityIndex,
  deliberateRepeatReason,
  makeResearchActivityEntry,
  navigationLoopBlockReason,
  searchLoopBlockReason,
} from ${JSON.stringify(join(root, 'src/lib/agent/ResearchActivityLog.ts'))}

export function runSmoke() {
  const taskA = createResearchActivityIndex()
  const taskB = createResearchActivityIndex()
  const base = {
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    stepTitle: 'Research risks',
    tool: 'web_search',
    kind: 'search',
    query: 'AI in education risks',
    normalizedQuery: 'ai in education risks',
    success: true,
  }
  addResearchActivityToIndex(taskA, makeResearchActivityEntry(base))

  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'AI in education risks' }), null, 'exact same-step search must remain advisory instead of hard-blocked')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'risks of AI in education' }), null, 'near-duplicate same-step search must remain advisory instead of hard-blocked')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 1, query: 'AI in education risks' }), null, 'new step may search the same topic again')
  assert.equal(searchLoopBlockReason({ index: taskA, stepIdx: 0, query: 'AI in education risks', allowRepeatReason: 'explicit revisit' }), null, 'explicit repeat intent must allow repeat search')
  assert.equal(searchLoopBlockReason({ index: taskB, stepIdx: 0, query: 'AI in education risks' }), null, 'separate task index must start empty')

  addResearchActivityToIndex(taskA, makeResearchActivityEntry({
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    stepTitle: 'Research risks',
    tool: 'browser_navigate',
    kind: 'visit',
    url: 'https://example.com/report?utm_source=x#section',
    normalizedUrl: 'https://example.com/report',
    domain: 'example.com',
    success: true,
  }))
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report#other', domain: 'example.com' }), null, 'same URL revisit must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report', domain: 'example.com', allowRepeatReason: 'current step explicitly names this domain' }), null, 'domain-specific repeats must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://example.com/report', domain: 'example.com', allowRepeatReason: 'explicit revisit' }), null, 'explicit revisit must allow same URL')

  addResearchActivityToIndex(taskA, makeResearchActivityEntry({
    userId: 'user-1',
    conversationId: 'task-a',
    runId: 'run-1',
    stepIdx: 0,
    tool: 'browser_navigate',
    kind: 'failure',
    url: 'https://blocked.example.com/page',
    normalizedUrl: 'https://blocked.example.com/page',
    domain: 'blocked.example.com',
    success: false,
    error: 'navigation failed',
  }))
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://blocked.example.com/page', domain: 'blocked.example.com' }), null, 'failed routes must remain advisory instead of hard-blocked')
  assert.equal(navigationLoopBlockReason({ index: taskA, stepIdx: 0, url: 'https://blocked.example.com/page', domain: 'blocked.example.com', allowRepeatReason: 'current step explicitly names this domain' }), null, 'domain-specific failed-route repeats must remain advisory instead of hard-blocked')

  assert.equal(deliberateRepeatReason({ objectiveText: 'Go back and revisit the same site', domain: 'example.com' }), 'explicit revisit/refresh instruction')
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

    const { runSmoke } = await import(pathToFileURL(bundlePath).href)
    runSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await runSourceContracts()
await runFunctionalChecks()
console.log('research activity log smoke checks passed')
