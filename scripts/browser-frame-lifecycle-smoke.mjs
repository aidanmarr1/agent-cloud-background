import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const agentLoop = await readFile(
  new URL('../src/lib/agent/AgentLoop.ts', import.meta.url),
  'utf8',
)
const toolPipeline = await readFile(
  new URL('../src/lib/agent/ToolPipeline.ts', import.meta.url),
  'utf8',
)

assert.match(
  agentLoop,
  /const releaseBrowserFrameStream = \(\) => \{[\s\S]*browserFrameStream\.unsubscribe\?\.\(\)[\s\S]*browserFrameStream\.unsubscribe = null[\s\S]*browserFrameStream\.lastFrameAt = 0/,
  'AgentLoop must expose an idempotent browser-frame release callback',
)
assert.match(
  agentLoop,
  /ensureBrowserFrameStream,[\s\S]*registerInflightToolDrain:/,
  'AgentLoop must let ToolPipeline start the task-level browser-frame stream',
)
assert.doesNotMatch(
  toolPipeline,
  /releaseBrowserFrameStream/,
  'ToolPipeline must not tear down the live frame stream between browser tools',
)
assert.match(
  agentLoop,
  /finally \{[\s\S]*await settleNarrationSidecar\(\)[\s\S]*planManager\.dispose\(\)[\s\S]*releaseBrowserFrameStream\(\)/,
  'AgentLoop must release the live frame subscription once, when the task ends',
)

const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { '@': srcPath } })
const {
  conversationPersistenceVersionsMatch,
  mergeSyncAcknowledgement,
} = await jiti.import(fileURLToPath(new URL('../src/store/chat/serverSync.ts', import.meta.url)))
const {
  updateLastAssistantMessage,
} = await jiti.import(fileURLToPath(new URL('../src/store/chat/persistence.ts', import.meta.url)))
const {
  normalizeConversationForPersistence,
} = await jiti.import(fileURLToPath(new URL('../src/lib/conversationSerialization.ts', import.meta.url)))

const baseConversation = {
  id: 'browser-frame-sync',
  title: 'Browser frame sync',
  starred: false,
  createdAt: 1,
  updatedAt: 10,
  serverRevision: 1,
  messages: [
    { id: 'user-1', role: 'user', content: 'Browse', timestamp: 1 },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Working',
      timestamp: 2,
      computerPanelData: [{
        id: 'browser_live',
        type: 'browser',
        title: 'Browser',
        timestamp: 3,
        data: {
          success: true,
          url: 'https://example.com',
          title: 'Example',
          action: 'Browsing',
        },
      }],
    },
  ],
}
const submittedConversation = normalizeConversationForPersistence(baseConversation)
const localFrameConversation = {
  ...baseConversation,
  messages: baseConversation.messages.map((message) => (
    message.id !== 'assistant-1'
      ? message
      : {
          ...message,
          computerPanelData: message.computerPanelData.map((item) => ({
            ...item,
            streaming: true,
            data: {
              ...item.data,
              screenshotBase64: 'data:image/jpeg;base64,latest-frame',
              liveFrame: true,
              liveFrameUpdatedAt: 11,
            },
          })),
        }
  )),
}
const serverAcknowledgement = {
  ...submittedConversation,
  serverRevision: 2,
}
const acknowledgement = mergeSyncAcknowledgement(
  localFrameConversation,
  serverAcknowledgement,
  submittedConversation,
)
const acknowledgedBrowser = acknowledgement.conversation.messages
  .find((message) => message.id === 'assistant-1')
  ?.computerPanelData?.find((item) => item.id === 'browser_live')

assert.equal(
  acknowledgedBrowser?.data.screenshotBase64,
  'data:image/jpeg;base64,latest-frame',
  'a server acknowledgement must not erase the latest local browser pixels',
)
assert.equal(
  acknowledgedBrowser?.data.liveFrame,
  true,
  'a server acknowledgement must preserve the local live-frame marker',
)
assert.equal(
  acknowledgement.localAdvanced,
  false,
  'ephemeral browser pixels alone must not schedule a durable conflict retry',
)
assert.equal(
  conversationPersistenceVersionsMatch([localFrameConversation], [baseConversation]),
  true,
  'frame-only state changes must not be treated as persistent conversation changes',
)

const ephemeralUpdate = updateLastAssistantMessage(
  [baseConversation],
  baseConversation.id,
  (message) => ({ ...message, reasoning: 'ephemeral' }),
  { touchUpdatedAt: false },
)
assert.equal(
  ephemeralUpdate[0].updatedAt,
  baseConversation.updatedAt,
  'ephemeral assistant updates must leave the durable conversation version untouched',
)

console.log('browser frame lifecycle smoke: PASS')
