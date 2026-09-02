import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const [imageSearch, tools, toolRegistry, taskGroupView, icons, agentMessage, appIcon, rootLayout, searchResults, imageSearchResults, computerPanel, searchLoadingState] = await Promise.all([
  readFile(join(root, 'src/lib/imageSearch.ts'), 'utf8'),
  readFile(join(root, 'src/lib/tools.ts'), 'utf8'),
  readFile(join(root, 'src/lib/toolRegistry.ts'), 'utf8'),
  readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
  readFile(join(root, 'src/components/icons.tsx'), 'utf8'),
  readFile(join(root, 'src/components/chat/AgentMessage.tsx'), 'utf8'),
  readFile(join(root, 'src/app/icon.svg'), 'utf8'),
  readFile(join(root, 'src/app/layout.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/SearchResults.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/ImageSearchResults.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/searchLoadingState.ts'), 'utf8'),
])

assert.match(
  imageSearch,
  /imageSearch\(query: unknown, count: number = 8[\s\S]*Math\.max\(1, Math\.min\(8, count\)\)/,
  'image search must default to and cap its result set at eight',
)
assert.match(
  toolRegistry,
  /imageSearch\(args\.query as string, 8, ctx\.signal, imageSearchType\(args\.image_type\)\)/,
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
assert.match(searchResults, /useDeferredEmptyState\(items\.length === 0, streaming\)/, 'web search must keep its loading skeleton through transient empty result hand-offs')
assert.match(imageSearchResults, /useDeferredEmptyState\(items\.length === 0, streaming\)/, 'image search must keep its loading skeleton through transient empty result hand-offs')
assert.match(searchResults, /if \(resolvingEmptyResult\)[\s\S]*if \(hasErrorResult\)/, 'web search must render the loading skeleton before any transient empty/error state')
assert.match(searchLoadingState, /taskStreaming && !!activeItemId && activeItemId === latestItemId/, 'the newest empty search must stay pending while its task is still live')
assert.match(searchLoadingState, /itemEmpty && taskStreaming/, 'task-level reconciliation must not mark a completed non-empty result set as running')
assert.match(computerPanel, /isSearchResultPending\(\{[\s\S]*taskStreaming,[\s\S]*activeItemId:[\s\S]*latestItemId:/, 'the Computer panel must derive search loading from item and task lifecycle state')
assert.match(computerPanel, /<SearchResults key=\{activeItem\.id\}/, 'web search hook state must reset when navigating between activity items')
assert.match(computerPanel, /<ImageSearchResults key=\{activeItem\.id\}/, 'image search hook state must reset when navigating between activity items')
assert.match(computerPanel, /<SearchResults[^>]*streaming=\{activeSearchPending\}/, 'web search must receive the task-aware pending state')
assert.match(computerPanel, /<ImageSearchResults[^>]*streaming=\{activeSearchPending\}/, 'image search must receive the task-aware pending state')
assert.match(searchResults, /aria-busy="true"[\s\S]*aria-label="Searching for results"/, 'web search skeleton must expose an accessible loading state')
assert.match(imageSearchResults, /aria-busy="true"[\s\S]*aria-label="Searching for images"/, 'image search skeleton must expose an accessible loading state')
assert.match(imageSearchResults, /items\.length === 0 && error/, 'failed searches must not render a successful empty result')
assert.match(imageSearchResults, /Image search unavailable/, 'image search errors must remain visible')
assert.match(imageSearchResults, /Source preview · not saved/, 'remote candidates must not be presented as saved assets')
assert.doesNotMatch(imageSearch, /resolve\(\[\]\)/, 'an image-search timeout must not be reported as zero matches')

console.log('Image search, favicon, and duplicate-thinking contracts passed.')
