import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.terminal-stream-presentation-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { EventDispatcher, type StoreActions } from ${JSON.stringify(join(root, 'src/stream/client/eventDispatcher.ts'))}
import {
  mergeSameCursorAssistantPresentation,
  normalizeConversationForPersistence,
} from ${JSON.stringify(join(root, 'src/lib/conversationSerialization.ts'))}
import { mergeConversationWithMonotonicAssistantState } from ${JSON.stringify(join(root, 'src/lib/conversations.ts'))}
import type { Conversation, Message, TaskGroup } from ${JSON.stringify(join(root, 'src/types/index.ts'))}

const now = Date.now()
const groups: TaskGroup[] = [
  { id: 'g0', index: 0, title: 'Research', status: 'done', subtasks: [], narrations: [], synthesis: '' },
  { id: 'g1', index: 1, title: 'Compare', status: 'done', subtasks: [], narrations: [], synthesis: '' },
  { id: 'g2', index: 2, title: 'Verify', status: 'done', subtasks: [], narrations: [], synthesis: '' },
  { id: 'g3', index: 3, title: 'Write report', status: 'pending', subtasks: [], narrations: [], synthesis: '' },
]

function message(contentLength: number, finalGroupStatus: TaskGroup['status']): Message {
  return {
    id: 'assistant',
    role: 'assistant',
    content: 'Completed research',
    timestamp: now,
    streamRunId: 'run',
    streamSeq: 213,
    streamTerminalStatus: 'done',
    taskGroups: groups.map((group, index) => ({
      ...group,
      status: index === 3 ? finalGroupStatus : group.status,
    })),
    artifacts: [{
      id: 'report',
      fileName: 'report.md',
      filePath: '/home/oai/share/report.md',
      content: 'x'.repeat(contentLength),
      type: 'document',
      createdAt: now,
    }],
  }
}

{
  const normalized = normalizeConversationForPersistence({
    id: 'task',
    title: 'Task',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [message(12_943, 'pending')],
  })
  assert.ok(
    normalized.messages[0].taskGroups?.every((group) => group.status === 'done'),
    'a terminal done message must never persist pending task groups',
  )
}

{
  const merged = mergeSameCursorAssistantPresentation(
    message(12_943, 'pending'),
    message(16_632, 'done'),
  )
  assert.equal(merged.artifacts?.[0].content.length, 16_632, 'same-cursor merge must retain the richest artifact')
  assert.ok(merged.taskGroups?.every((group) => group.status === 'done'))
}

{
  const stored: Conversation = {
    id: 'task',
    title: 'Task',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [message(12_943, 'pending')],
  }
  const incoming: Conversation = {
    ...stored,
    updatedAt: now + 1,
    messages: [message(16_632, 'done')],
  }
  const merged = mergeConversationWithMonotonicAssistantState(stored, incoming)
  assert.equal(
    merged.messages[0].artifacts?.[0].content.length,
    16_632,
    'server monotonic merge must accept richer presentation at the same terminal cursor',
  )
}

{
  let latestGroups: TaskGroup[] = []
  let latestSteps: Message['steps'] = []
  const noop = () => {}
  const actions: StoreActions = {
    appendToLastMessage: noop,
    appendReasoning: noop,
    setSteps(_conversationId, steps) { latestSteps = steps },
    setTaskGroups(_conversationId, nextGroups) { latestGroups = nextGroups },
    updateTaskGroupStatus: noop,
    addSubtaskToGroup: noop,
    updateSubtaskInGroup: noop,
    addGroupNarration: noop,
    setLastMessageContent: noop,
    setFollowUps: noop,
    addArtifact: noop,
    addComputerPanelItem: noop,
    upsertComputerPanelItem: noop,
    removeComputerPanelItem: noop,
    setComputerPanelOpen: noop,
    addToast: noop,
  }
  const initial = message(12_943, 'pending')
  initial.streamTerminalStatus = undefined
  initial.steps = groups.map((group) => ({
    index: group.index,
    title: group.title,
    status: group.status,
    items: [],
  }))
  const dispatcher = new EventDispatcher('task', actions, noop, initial)
  dispatcher.dispatch({ type: 'done' })
  dispatcher.flushPendingUpdates()
  assert.ok(latestGroups.every((group) => group.status === 'done'), 'done event must close every plan group')
  assert.ok(latestSteps?.every((step) => step.status === 'done'), 'done event must close every legacy step')
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

console.log('terminal stream presentation smoke checks passed')
