import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [agentMessage, actionFeed, stepTracker, chatInput, chatPage, globals] = await Promise.all([
  readFile(join(root, 'src/components/chat/AgentMessage.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/ActionFeed.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/StepTrackerBar.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/ChatInput.tsx'), 'utf8'),
  readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
  readFile(join(root, 'src/app/globals.css'), 'utf8'),
])

assert.match(
  agentMessage,
  /const visibleTaskGroups = taskGroups\.filter\(\(group\) => group\.status !== 'pending'\)/,
  'inline assistant activity must hide future task groups until they start',
)
assert.match(
  agentMessage,
  /const visibleSteps = steps\.filter\(\(step\) => step\.status !== 'pending'\)/,
  'legacy inline activity must hide future steps until they start',
)
assert.match(
  agentMessage,
  /\{visibleTaskGroups\.map\(\(group\) => \(/,
  'inline assistant activity must render only progressively revealed task groups',
)
assert.match(
  agentMessage,
  /isStreaming && visibleTaskGroups\.length === 0 && visibleSteps\.length === 0/,
  'a planning indicator must remain visible before the first planned group starts',
)
assert.match(
  actionFeed,
  /\.filter\(\(group\) => group\.status !== 'pending'\)/,
  'secondary inline activity feeds must hide future task groups until they start',
)
assert.match(
  stepTracker,
  /\{taskGroups\.map\(\(group\) => \(/,
  'the expanded task progress tracker must keep showing the full plan',
)
assert.match(
  stepTracker,
  /taskGroups\.find\(\(group\) => group\.status === 'pending'\)/,
  'the collapsed task progress tracker may still identify the next future step',
)
assert.doesNotMatch(
  stepTracker,
  /(?:boxShadow|box-shadow|drop-shadow|filter\s*:|(?:^|[\s"'`])(?:focus:|focus-within:|active:|sm:|md:|lg:|xl:)*shadow(?:-|\[|\s|"|'|`))/m,
  'the docked task progress tracker must remain flat with the composer instead of casting a popup shadow',
)
assert.match(
  stepTracker,
  /\btask-progress-surface\b/,
  'the docked task progress tracker must opt into the flat task-surface contract',
)
assert.match(
  chatInput,
  /\btask-input-surface\b/,
  'the task composer must opt into the flat task-surface contract',
)
assert.match(
  chatPage,
  /\btask-composer-stack\b/,
  'the progress/composer wrapper must opt into the flat task-surface contract',
)
assert.match(
  globals,
  /\.task-input-surface,\s*\.task-progress-surface,\s*\.task-composer-stack\s*{[^}]*box-shadow:\s*none\s*!important;[^}]*filter:\s*none\s*!important;/s,
  'the entire docked task stack must explicitly suppress elevation across themes and responsive states',
)
assert.match(
  chatPage,
  /<StepTrackerBar taskGroups=\{trackerAssistantMsg\.taskGroups\} isStreaming=\{isStreaming\} \/>/,
  'the docked task progress tracker must receive the unfiltered task plan',
)

console.log('Progressive task visibility smoke test passed')
