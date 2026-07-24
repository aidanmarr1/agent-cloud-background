import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.live-file-preview-recovery-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { EventDispatcher, type StoreActions } from ${JSON.stringify(join(root, 'src/stream/client/eventDispatcher.ts'))}
import { useChatStore } from ${JSON.stringify(join(root, 'src/store/chat/index.ts'))}
import { useUIStore } from ${JSON.stringify(join(root, 'src/store/ui.ts'))}
import type { ComputerPanelItem, Conversation, FileResult } from ${JSON.stringify(join(root, 'src/types/index.ts'))}

function actions(): StoreActions {
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

function reset(conversationId: string, panelItems: ComputerPanelItem[] = []): EventDispatcher {
  const now = Date.now()
  const conversation: Conversation = {
    id: conversationId,
    title: 'Live file preview smoke',
    starred: false,
    createdAt: now,
    updatedAt: now,
    messages: [{
      id: 'assistant',
      role: 'assistant',
      content: 'I will update the report.',
      timestamp: now,
      computerPanelData: panelItems,
    }],
  }
  useChatStore.setState({ conversations: [conversation], activeId: conversationId, folders: [] })
  useUIStore.setState({
    isStreaming: true,
    streamingStatus: 'thinking',
    webIdeMode: false,
    webIdeConversationId: null,
    webIdeEntryFile: null,
    webIdeStreamingFile: null,
    webIdeSelectedFile: null,
    computerPanelOpen: false,
  })
  const dispatcher = new EventDispatcher(conversationId, actions(), () => {})
  dispatcher.dispatch({ type: 'plan', items: ['Write the final report'] })
  return dispatcher
}

function panelItem(conversationId: string, eventId: string): ComputerPanelItem | undefined {
  const conversation = useChatStore.getState().conversations.find(item => item.id === conversationId)
  const assistant = [...(conversation?.messages || [])].reverse().find(message => message.role === 'assistant')
  return assistant?.computerPanelData?.find(item => item.id === eventId)
}

{
  const conversationId = 'discarded-preview'
  const dispatcher = reset(conversationId)
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'create-1',
    name: 'create_file',
    args: { path: 'report.md', action_label: 'Write final report', plan_step_index: 1 },
    provisional: true,
  })
  dispatcher.dispatch({ type: 'file_content_start', id: 'create-1', path: 'report.md', toolName: 'create_file' })
  dispatcher.dispatch({ type: 'file_content_delta', id: 'create-1', content: '# Partial report\\n\\nDraft text.' })
  dispatcher.flushPendingUpdates()

  assert.equal(useUIStore.getState().webIdeStreamingFile?.content, '# Partial report\\n\\nDraft text.')
  assert.equal((panelItem(conversationId, 'create-1')?.data as FileResult).content, '# Partial report\\n\\nDraft text.')

  dispatcher.dispatch({
    type: 'tool_result',
    id: 'create-1',
    name: 'create_file',
    result: {
      error: 'INTERNAL_RECOVERY: The streamed file action was discarded before execution.',
      discarded: true,
    },
  })
  dispatcher.flushPendingUpdates()

  assert.equal(useUIStore.getState().webIdeStreamingFile, null, 'discarded previews must clear LIVE editor state')
  assert.equal(panelItem(conversationId, 'create-1'), undefined, 'discarded previews must not leave a ghost file panel')
}

{
  const conversationId = 'superseded-preview'
  const dispatcher = reset(conversationId)
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'create-2',
    name: 'create_file',
    args: { path: 'superseded.md', action_label: 'Write superseded draft', plan_step_index: 1 },
    provisional: true,
  })
  dispatcher.dispatch({ type: 'file_content_start', id: 'create-2', path: 'superseded.md', toolName: 'create_file' })
  dispatcher.dispatch({ type: 'file_content_delta', id: 'create-2', content: 'Superseded draft.' })
  dispatcher.flushPendingUpdates()
  dispatcher.dispatch({
    type: 'tool_result',
    id: 'create-2',
    name: 'create_file',
    result: {
      error: 'Superseded by a newer live instruction before execution.',
      superseded: true,
    },
  })
  dispatcher.flushPendingUpdates()

  assert.equal(useUIStore.getState().webIdeStreamingFile, null, 'superseded previews must clear LIVE editor state')
  assert.equal(panelItem(conversationId, 'create-2'), undefined, 'superseded previews must not leave a ghost file panel')
}

{
  const conversationId = 'append-preview'
  const filePath = 'report.md'
  const existingContent = '# Report\\n\\nExisting section.\\n'
  const dispatcher = reset(conversationId, [{
    id: 'existing-report',
    type: 'file',
    title: 'Report',
    data: { action: 'created', path: filePath, content: existingContent },
    timestamp: Date.now() - 100,
    streaming: false,
  }])

  dispatcher.dispatch({
    type: 'tool_start',
    id: 'append-1',
    name: 'append_file',
    args: { path: filePath, action_label: 'Continue final report', plan_step_index: 1 },
    provisional: true,
  })
  dispatcher.dispatch({ type: 'file_content_start', id: 'append-1', path: filePath, toolName: 'append_file' })
  dispatcher.dispatch({ type: 'file_content_delta', id: 'append-1', content: '\\n## New section\\n\\nVerified conclusion.\\n' })
  dispatcher.flushPendingUpdates()

  const expected = existingContent + '\\n## New section\\n\\nVerified conclusion.\\n'
  assert.equal((panelItem(conversationId, 'append-1')?.data as FileResult).content, expected)

  // The execution checkpoint refines the same start. It may contain a full
  // content arg on direct streams, but WebIdeHandler remains the sole owner of
  // the accumulated preview and must not replace it with only the append chunk.
  dispatcher.dispatch({
    type: 'tool_start',
    id: 'append-1',
    name: 'append_file',
    args: {
      path: filePath,
      content: '\\n## New section\\n\\nVerified conclusion.\\n',
      action_label: 'Continue final report',
      plan_step_index: 1,
    },
  })
  assert.equal((panelItem(conversationId, 'append-1')?.data as FileResult).content, expected)

  dispatcher.dispatch({
    type: 'tool_result',
    id: 'append-1',
    name: 'append_file',
    result: { action: 'appended', path: filePath, size: expected.length },
  })
  dispatcher.flushPendingUpdates()

  const completed = panelItem(conversationId, 'append-1')
  assert.equal((completed?.data as FileResult).content, expected, 'final result must preserve all streamed append content')
  assert.notEqual(completed?.streaming, true)
  assert.equal(useUIStore.getState().webIdeStreamingFile, null)
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
    banner: {
      js: 'globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0); globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);',
    },
  })
  await import(pathToFileURL(bundlePath).href)
} finally {
  await rm(workDir, { recursive: true, force: true })
}

console.log('live file preview recovery smoke checks passed')
