import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [agentMessage, taskGroupView, typingIndicator, dataTab] = await Promise.all([
  readFile(join(root, 'src/components/chat/AgentMessage.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/TypingIndicator.tsx'), 'utf8'),
  readFile(join(root, 'src/components/modals/settings/DataTab.tsx'), 'utf8'),
])

assert.match(
  agentMessage,
  /className="task-acknowledgment [^"]*"/,
  'the model acknowledgment must expose the canonical activity gutter',
)
assert.match(
  agentMessage,
  /className="task-activity-row mb-4 [^"]*gap-1[^"]*"/,
  'the Agent header must use the same outer row geometry as task activity',
)
assert.match(
  agentMessage,
  /className="task-activity-marker [^"]*h-5 w-5[^"]*justify-start[^"]*"/,
  'the Agent logo must begin on the acknowledgment and task-stream gutter',
)
assert.doesNotMatch(
  agentMessage,
  /className="[^"]*h-7 w-7[^"]*justify-center[^"]*"[^>]*>\s*<Bot/,
  'the Agent logo must not be centered inside a wider cell that shifts it off the content gutter',
)

assert.match(
  taskGroupView,
  /className="task-activity-row group\/header [^"]*gap-1[^"]*"/,
  'task-group headers must use the shared activity row geometry',
)
assert.match(
  taskGroupView,
  /className="task-inline-thinking-row pb-2\.5 pt-0\.5"/,
  'inline thinking must begin on the same outer gutter as its task header',
)
assert.doesNotMatch(
  taskGroupView,
  /task-inline-thinking-row[^"\n]*(?:pl-|ml-|px-)/,
  'inline thinking must not add horizontal nesting',
)

const taskMarkers = taskGroupView.match(/task-activity-marker[^"\n]*/g) ?? []
assert.ok(taskMarkers.length >= 6, 'every task status marker must use the shared marker cell')
for (const marker of taskMarkers) {
  assert.match(marker, /h-5 w-5/, 'task status marker cells must stay 20px square')
  assert.match(marker, /justify-start/, 'visible task status markers must begin on the acknowledgment gutter')
}

assert.match(
  typingIndicator,
  /className="task-activity-row [^"]*gap-1[^"]*"/,
  'startup and ungrouped thinking states must use the shared 4px label gap',
)
assert.match(
  typingIndicator,
  /className="task-activity-marker [^"]*h-5 w-5[^"]*justify-start[^"]*"/,
  'startup and ungrouped thinking markers must use the shared 20px cell',
)

const passwordLabelIndex = dataTab.indexOf("{passwordFormOpen ? 'Cancel' : 'Change'}")
const passwordTriggerStart = dataTab.lastIndexOf('<button', passwordLabelIndex)
const passwordTriggerEnd = dataTab.indexOf('</button>', passwordLabelIndex)
assert.ok(passwordLabelIndex >= 0 && passwordTriggerStart >= 0 && passwordTriggerEnd >= 0, 'the password Change trigger must remain present')
const passwordTrigger = dataTab.slice(passwordTriggerStart, passwordTriggerEnd)
assert.match(passwordTrigger, /className="[^"]*\brounded-lg\b[^"]*"/, 'the password Change trigger must use the settings action radius')
assert.doesNotMatch(passwordTrigger, /\brounded-xl\b/, 'the password Change trigger must not use the larger panel radius')

const passwordSubmitLabelIndex = dataTab.indexOf("{passwordLoading ? 'Updating...' : 'Update password'}")
const passwordSubmitStart = dataTab.lastIndexOf('<button', passwordSubmitLabelIndex)
const passwordSubmitEnd = dataTab.indexOf('</button>', passwordSubmitLabelIndex)
assert.ok(
  passwordSubmitLabelIndex >= 0 && passwordSubmitStart >= 0 && passwordSubmitEnd >= 0,
  'the Update password action must remain present',
)
const passwordSubmit = dataTab.slice(passwordSubmitStart, passwordSubmitEnd)
assert.match(passwordSubmit, /className="[^"]*\brounded-lg\b[^"]*"/, 'Update password must use the settings action radius')
assert.doesNotMatch(passwordSubmit, /\brounded-xl\b/, 'Update password must not use the larger panel radius')

console.log('activity alignment smoke checks passed')
