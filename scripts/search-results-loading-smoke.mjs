import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createJiti } from 'jiti'

const root = resolve(import.meta.dirname, '..')
const jiti = createJiti(import.meta.url)
const { isSearchResultPending } = await jiti.import(
  resolve(root, 'src/components/computer/searchLoadingState.ts'),
)

assert.equal(
  isSearchResultPending({
    itemStreaming: true,
    itemEmpty: true,
    taskStreaming: false,
    activeItemId: 'search-1',
    latestItemId: 'search-1',
  }),
  true,
  'an explicitly streaming search must render its loading skeleton',
)

assert.equal(
  isSearchResultPending({
    itemStreaming: false,
    itemEmpty: true,
    taskStreaming: true,
    activeItemId: 'search-1',
    latestItemId: 'search-1',
  }),
  true,
  'the newest empty search must remain loading during live task reconciliation',
)

assert.equal(
  isSearchResultPending({
    itemStreaming: false,
    itemEmpty: true,
    taskStreaming: true,
    activeItemId: 'search-1',
    latestItemId: 'browse-2',
  }),
  false,
  'a historical empty search must not impersonate a loading search',
)

assert.equal(
  isSearchResultPending({
    itemStreaming: false,
    itemEmpty: true,
    taskStreaming: false,
    activeItemId: 'search-1',
    latestItemId: 'search-1',
  }),
  false,
  'a terminal empty search must render the real empty state',
)

assert.equal(
  isSearchResultPending({
    itemStreaming: false,
    itemEmpty: false,
    taskStreaming: true,
    activeItemId: 'search-1',
    latestItemId: 'search-1',
  }),
  false,
  'completed non-empty results must not keep a running header for the rest of the task',
)

console.log('Search results loading lifecycle smoke passed.')
