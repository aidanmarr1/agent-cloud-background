import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const [imageSearch, tools, toolRegistry, taskGroupView, icons, agentMessage, appIcon, rootLayout] = await Promise.all([
  readFile(join(root, 'src/lib/imageSearch.ts'), 'utf8'),
  readFile(join(root, 'src/lib/tools.ts'), 'utf8'),
  readFile(join(root, 'src/lib/toolRegistry.ts'), 'utf8'),
  readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
  readFile(join(root, 'src/components/icons.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/AgentMessage.tsx'), 'utf8'),
  readFile(join(root, 'src/app/icon.svg'), 'utf8'),
  readFile(join(root, 'src/app/layout.tsx'), 'utf8'),
])

assert.match(
  imageSearch,
  /imageSearch\(query: unknown, count: number = 8[\s\S]*Math\.max\(1, Math\.min\(8, count\)\)/,
  'image search must default to and cap its result set at eight',
)
assert.match(
  toolRegistry,
  /imageSearch\(args\.query as string, 8, ctx\.signal\)/,
  'the model-facing image search tool must request the top eight results',
)
assert.doesNotMatch(
  tools.match(/name: 'image_search'[\s\S]*?\n  \},/)?.[0] || '',
  /\bcount\b/,
  'the model must not accidentally reduce the fixed top-eight image result set',
)
assert.match(icons, /export const ImageSearch = forwardRef[\s\S]*<circle cx="16\.3"[\s\S]*L21 21/, 'image search must have a dedicated image-with-magnifier icon')
assert.match(taskGroupView, /image_search:\s*<ImageSearch/, 'task activity must render the dedicated image-search icon')
assert.match(
  agentMessage,
  /currentRunningGroupId[\s\S]*isCurrentGroup=\{group\.id === currentRunningGroupId\}/,
  'only the latest running task group may display the inline Thinking indicator',
)
assert.match(appIcon, /viewBox="0 0 256 256"[\s\S]*v32H56a32 32/, 'the favicon must use the current robot mark')
assert.match(rootLayout, /\/icon\.svg\?v=robot-2/, 'favicon metadata must cache-bust the current robot mark')

console.log('Image search, favicon, and duplicate-thinking contracts passed.')
