import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.client-progress-narration-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { EventDispatcher, type StoreActions } from ${JSON.stringify(join(root, 'src/stream/client/eventDispatcher.ts'))}
import type { Message, Subtask } from ${JSON.stringify(join(root, 'src/types/index.ts'))}

type CapturedNarration = { group: number; text: string; position?: number }

function makeActions(narrations: CapturedNarration[], latestGroups: unknown[]): StoreActions {
  const noop = () => {}
  return {
    appendToLastMessage: noop,
    appendReasoning: noop,
    setSteps: noop,
    setTaskGroups(_conversationId, groups) {
      latestGroups.splice(0, latestGroups.length, ...groups)
    },
    updateTaskGroupStatus: noop,
    addSubtaskToGroup: noop,
    updateSubtaskInGroup: noop,
    addGroupNarration(_conversationId, group, text, position) {
      narrations.push({ group, text, position })
    },
    setLastMessageContent: noop,
    setFollowUps: noop,
    addArtifact: noop,
    addComputerPanelItem: noop,
    upsertComputerPanelItem: noop,
    removeComputerPanelItem: noop,
    setComputerPanelOpen: noop,
    addToast: noop,
  }
}

function completeSearch(dispatcher: EventDispatcher, id: string, label: string, step: number): void {
  dispatcher.dispatch({
    type: 'tool_start',
    id,
    name: 'web_search',
    args: { action_label: label, plan_step_index: step, query: label },
  })
  dispatcher.dispatch({
    type: 'tool_result',
    id,
    name: 'web_search',
    result: [{ title: label, url: 'https://' + id + '.example.test', snippet: 'Verified result' }],
  })
}

const progressText = 'The three verified benchmarks now agree that short action loops reduce visible latency.'

{
  const narrations: CapturedNarration[] = []
  const groups: unknown[] = []
  const dispatcher = new EventDispatcher(
    'cross-step-progress-update',
    makeActions(narrations, groups),
    () => {},
  )

  dispatcher.dispatch({ type: 'plan', items: ['Gather initial evidence', 'Compare the evidence'] })
  completeSearch(dispatcher, 'a1', 'Search first benchmark', 1)
  completeSearch(dispatcher, 'a2', 'Search second benchmark', 1)
  completeSearch(dispatcher, 'a3', 'Search third benchmark', 1)
  dispatcher.dispatch({ type: 'step_advance', status: 'done' })
  completeSearch(dispatcher, 'b1', 'Compare the verified benchmarks', 2)
  dispatcher.dispatch({
    type: 'progress_update',
    content: progressText,
    stepIndex: 0,
    afterToolId: 'a3',
    remainingVisibleActions: 1,
  })
  dispatcher.flushPendingUpdates()

  assert.deepEqual(narrations, [{
    group: 0,
    text: progressText,
    position: 3,
  }], 'a late cross-step progress narration must remain at its captured group and tool frontier')
  assert.equal((dispatcher as any).toolsSinceLastNarration, 1, 'the action completed after the captured frontier must remain in cadence')
  assert.equal((dispatcher as any).pendingNarrationTools.length, 1, 'the pending cadence window must retain the newest action')
}

const doneSubtask = (id: string, label: string): Subtask => ({
  id,
  toolName: 'web_search',
  type: 'search',
  label,
  labelSource: 'model',
  status: 'done',
})

{
  const narrations: CapturedNarration[] = []
  const groups: unknown[] = []
  const initialMessage: Message = {
    id: 'assistant-running',
    role: 'assistant',
    content: 'I’ll compare the current evidence.',
    timestamp: Date.now(),
    steps: [
      { index: 0, title: 'Gather initial evidence', status: 'done', items: [] },
      { index: 1, title: 'Compare the evidence', status: 'running', items: [] },
    ],
    taskGroups: [
      {
        id: 'g0',
        index: 0,
        title: 'Gather initial evidence',
        status: 'done',
        subtasks: [
          doneSubtask('a1', 'Search first benchmark'),
          doneSubtask('a2', 'Search second benchmark'),
          doneSubtask('a3', 'Search third benchmark'),
        ],
        narrations: [],
        synthesis: '',
      },
      {
        id: 'g1',
        index: 1,
        title: 'Compare the evidence',
        status: 'running',
        subtasks: [doneSubtask('b1', 'Compare the verified benchmarks')],
        narrations: [],
        synthesis: '',
      },
    ],
  }
  const dispatcher = new EventDispatcher(
    'hydrated-cross-step-progress-update',
    makeActions(narrations, groups),
    () => {},
    initialMessage,
  )

  dispatcher.dispatch({
    type: 'progress_update',
    content: progressText,
    stepIndex: 0,
    afterToolId: 'a3',
    remainingVisibleActions: 1,
  })
  dispatcher.flushPendingUpdates()

  assert.deepEqual(narrations, [{
    group: 0,
    text: progressText,
    position: 3,
  }], 'hydrated late narration must use persisted placement metadata instead of the active group')
  assert.equal((dispatcher as any).toolsSinceLastNarration, 1, 'hydrated placement must preserve the server-reported cadence remainder')
}

{
  const narrations: CapturedNarration[] = []
  const groups: unknown[] = []
  const dispatcher = new EventDispatcher(
    'same-step-frontier-progress-update',
    makeActions(narrations, groups),
    () => {},
  )

  dispatcher.dispatch({ type: 'plan', items: ['Gather current evidence'] })
  completeSearch(dispatcher, 'a1', 'Search first benchmark', 1)
  completeSearch(dispatcher, 'a2', 'Search second benchmark', 1)
  completeSearch(dispatcher, 'a3', 'Search third benchmark', 1)
  completeSearch(dispatcher, 'a4', 'Search fourth benchmark', 1)
  dispatcher.dispatch({
    type: 'progress_update',
    content: progressText,
    stepIndex: 0,
    afterToolId: 'a3',
    remainingVisibleActions: 1,
  })
  dispatcher.flushPendingUpdates()

  assert.deepEqual(narrations, [{
    group: 0,
    text: progressText,
    position: 3,
  }], 'an asynchronous progress narration must not jump past a later action in the same group')
  assert.equal((dispatcher as any).toolsSinceLastNarration, 1, 'same-step placement must keep the later action in cadence')
  assert.equal((dispatcher as any).pendingNarrationTools.length, 1, 'same-step placement must retain only the post-frontier action')
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
    alias: { '@': join(root, 'src') },
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('client progress narration smoke checks passed')
