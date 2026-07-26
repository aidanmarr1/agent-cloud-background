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
import { useChatStore } from ${JSON.stringify(join(root, 'src/store/chat/index.ts'))}
import { useUIStore } from ${JSON.stringify(join(root, 'src/store/ui.ts'))}
import type { Conversation, Message, TaskGroup } from ${JSON.stringify(join(root, 'src/types/index.ts'))}

;(globalThis as any).requestAnimationFrame = (callback: (timestamp: number) => void) =>
  setTimeout(() => callback(Date.now()), 0)
;(globalThis as any).cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) =>
  clearTimeout(handle)

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

function storeBackedActions(): StoreActions {
  return {
    appendToLastMessage: (...args) => useChatStore.getState().appendToLastMessage(...args),
    appendReasoning: (...args) => useChatStore.getState().appendReasoning(...args),
    setSteps: (...args) => useChatStore.getState().setSteps(...args),
    setTaskGroups: (...args) => useChatStore.getState().setTaskGroups(...args),
    updateTaskGroupStatus: (...args) => useChatStore.getState().updateTaskGroupStatus(...args),
    addSubtaskToGroup: (...args) => useChatStore.getState().addSubtaskToGroup(...args),
    updateSubtaskInGroup: (...args) => useChatStore.getState().updateSubtaskInGroup(...args),
    addGroupNarration: (...args) => useChatStore.getState().addGroupNarration(...args),
    setLastMessageContent: (...args) => useChatStore.getState().setLastMessageContent(...args),
    setFollowUps: (...args) => useChatStore.getState().setFollowUps(...args),
    addArtifact: (...args) => useChatStore.getState().addArtifact(...args),
    addComputerPanelItem: (...args) => useChatStore.getState().addComputerPanelItem(...args),
    upsertComputerPanelItem: (...args) => useChatStore.getState().upsertComputerPanelItem(...args),
    removeComputerPanelItem: (...args) => useChatStore.getState().removeComputerPanelItem(...args),
    setComputerPanelOpen: (...args) => useUIStore.getState().setComputerPanelOpen(...args),
    addToast: () => {},
  }
}

{
  const conversationId = 'personalized-final-handoff'
  const initialMessage: Message = {
    id: 'assistant-handoff',
    role: 'assistant',
    content: 'I’ll examine the interface and prepare a practical report.',
    timestamp: now,
  }
  const conversation: Conversation = {
    id: conversationId,
    title: 'Personalized handoff',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [initialMessage],
  }
  useChatStore.setState({ conversations: [conversation], activeId: conversationId, folders: [] })
  useUIStore.setState({ isStreaming: true })
  const storeActions = storeBackedActions()
  const dispatcher = new EventDispatcher(conversationId, storeActions, () => {})
  dispatcher.dispatch({ type: 'plan', items: ['Write the Manus interface research report'] })
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'report-write',
    name: 'create_file',
    args: {
      path: 'manus-interface-research-report.md',
      action_label: 'Compile interface research findings',
      plan_step_index: 1,
    },
  })
  dispatcher.dispatch({
    type: 'tool_result',
    id: 'report-write',
    name: 'create_file',
    result: {
      action: 'created',
      path: 'manus-interface-research-report.md',
      content: '# Manus Interface Research Report\\n\\nVerified report content.',
    },
  })
  const personalized = [
    '## Key Findings',
    '',
    'The research report is complete, and its strongest finding is that the three-panel workspace keeps planning, execution, and live computer feedback visible at the same time.',
    '',
    '### Interface Architecture',
    '',
    'The report explains how the task stream and computer surface reinforce one another, with concrete notes on onboarding and task handoff.',
    '',
    '### Conclusion',
    '',
    'Use the findings matrix to compare the onboarding and live-feedback recommendations. Open the Markdown report below for the full evidence and recommendations.',
  ].join('\\n')
  dispatcher.dispatch({ type: 'text_delta', content: personalized })
  dispatcher.dispatch({ type: 'done' })
  dispatcher.flushPendingUpdates()

  const finalAssistant = useChatStore.getState().conversations[0]?.messages[0]
  const finalMessage = finalAssistant?.content || ''
  assert.match(finalMessage, /## Key Findings/, 'a heading-rich model handoff must remain visible')
  assert.match(finalMessage, /three-panel workspace/, 'the model’s task-specific finding must win over the client fallback')
  assert.match(finalMessage, /Use the findings matrix/, 'imperative usage detail in the final handoff must not be stripped as tool narration')
  assert.match(finalMessage, /Open the Markdown report below/, 'the final artifact reference must remain natural and task-specific')
  assert.doesNotMatch(finalMessage, /The completed file,.*is attached below/, 'the old canned attachment sentence must never replace the model handoff')
  assert.equal(
    finalAssistant?.taskGroups?.flatMap((group) => group.narrations || [])
      .some((narration) => narration.includes('three-panel workspace')),
    false,
    'the personalized handoff must render once, not repeat inside the final task group',
  )
}

{
  const conversationId = 'neutral-final-handoff-fallback'
  const initialMessage: Message = {
    id: 'assistant-handoff-fallback',
    role: 'assistant',
    content: 'I’ll synthesize the research into a structured report.',
    timestamp: now,
  }
  const conversation: Conversation = {
    id: conversationId,
    title: 'Neutral handoff fallback',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [initialMessage],
  }
  useChatStore.setState({ conversations: [conversation], activeId: conversationId, folders: [] })
  useUIStore.setState({ isStreaming: true })
  const dispatcher = new EventDispatcher(conversationId, storeBackedActions(), () => {})
  dispatcher.dispatch({ type: 'plan', items: ['Synthesize findings into a structured report'] })
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'global-warming-report',
    name: 'create_file',
    args: {
      path: 'global_warming_report.md',
      action_label: 'Create global warming report',
      plan_step_index: 1,
    },
  })
  dispatcher.dispatch({
    type: 'tool_result',
    id: 'global-warming-report',
    name: 'create_file',
    result: {
      action: 'created',
      path: 'global_warming_report.md',
      content: '# Global Warming Report\\n\\nVerified content.',
    },
  })
  dispatcher.dispatch({ type: 'done' })
  dispatcher.flushPendingUpdates()

  const finalMessage = useChatStore.getState().conversations[0]?.messages[0]?.content || ''
  assert.doesNotMatch(
    finalMessage,
    /I finished synthesize/i,
    'an emergency final fallback must never splice an imperative plan label into broken completion grammar',
  )
  assert.match(
    finalMessage,
    /requested deliverable is ready to open as .*global_warming_report\.md.* below/i,
    'when the model handoff is unavailable, the UI should use a neutral artifact fallback without pretending it is model-authored task synthesis',
  )
}

{
  const conversationId = 'suppress-duplicated-saved-report'
  const initialMessage: Message = {
    id: 'assistant-duplicate-report',
    role: 'assistant',
    content: 'I’ll compile the findings into a report.',
    timestamp: now,
  }
  const conversation: Conversation = {
    id: conversationId,
    title: 'Duplicate report suppression',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [initialMessage],
  }
  useChatStore.setState({ conversations: [conversation], activeId: conversationId, folders: [] })
  useUIStore.setState({ isStreaming: true })
  const dispatcher = new EventDispatcher(conversationId, storeBackedActions(), () => {})
  dispatcher.dispatch({ type: 'plan', items: ['Write the final research report'] })
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'duplicate-report-write',
    name: 'create_file',
    args: {
      path: 'final-research-report.md',
      action_label: 'Compile final research findings',
      plan_step_index: 1,
    },
  })
  dispatcher.dispatch({
    type: 'tool_result',
    id: 'duplicate-report-write',
    name: 'create_file',
    result: {
      action: 'created',
      path: 'final-research-report.md',
      content: '# Final Research Report\\n\\nSaved report.',
    },
  })
  const longSection = 'Evidence, interpretation, and implementation detail. '.repeat(32)
  const duplicatedReport = [
    '# Final Research Report',
    '',
    '## 1. Executive Summary',
    '',
    longSection,
    '',
    '## 2. Architecture',
    '',
    longSection,
    '',
    '## 3. Recommendations',
    '',
    longSection,
  ].join('\\n')
  assert.ok(duplicatedReport.length > 4_000 && duplicatedReport.length < 6_000)
  dispatcher.dispatch({ type: 'text_delta', content: duplicatedReport })
  dispatcher.dispatch({ type: 'done' })
  dispatcher.flushPendingUpdates()

  const finalMessage = useChatStore.getState().conversations[0]?.messages[0]?.content || ''
  assert.doesNotMatch(finalMessage, /## 2\. Architecture/, 'a structurally duplicated saved report must not be republished in chat')
  assert.match(finalMessage, /final-research-report\.md/, 'duplicate report suppression must retain the concise artifact fallback')
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
