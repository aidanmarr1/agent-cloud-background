import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJiti } from 'jiti'

const root = process.cwd()
const jiti = createJiti(import.meta.url)
const { isBrowseResultPending } = await jiti.import(
  join(root, 'src/components/computer/browseLoadingState.ts'),
)

const [browse, readablePageLimits, documentReader, browserRuntime, panelMapper, dispatcher, browseView, deferredEmptyState, conversationSerialization, computerPanel, browseLoadingState] = await Promise.all([
  readFile(join(root, 'src/lib/browse.ts'), 'utf8'),
  readFile(join(root, 'src/lib/readablePageLimits.ts'), 'utf8'),
  readFile(join(root, 'src/lib/document.ts'), 'utf8'),
  readFile(join(root, 'src/lib/browser.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/panelMapper.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
  readFile(join(root, 'src/components/computer/BrowseView.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/useDeferredEmptyState.ts'), 'utf8'),
  readFile(join(root, 'src/lib/conversationSerialization.ts'), 'utf8'),
  readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
  readFile(join(root, 'src/components/computer/browseLoadingState.ts'), 'utf8'),
])

assert.match(
  browse,
  /Readability[\s\S]*JSDOM[\s\S]*export function parseReadableHtml/,
  'webpage extraction must use readability scoring',
)

assert.match(
  readablePageLimits,
  /MAX_READABLE_PAGE_CHARS = 40_000[\s\S]*truncateReadablePageContent/,
  'webpage extraction must retain a bounded full-page payload',
)

assert.match(
  browse,
  /largestReadableContainerHtml[\s\S]*fallbackLength[\s\S]*readableLength[\s\S]*fallbackLength \* 0\.65/,
  'a tiny leading article or teaser must not displace the substantive main page',
)

assert.match(
  browse,
  /<h\(\[1-6\]\)[\s\S]*'#'\.repeat[\s\S]*<li/,
  'readability conversion must preserve heading and list structure',
)

assert.match(
  documentReader,
  /parseReadableHtml\(buffer\.toString\('utf-8'\), resolvedSource\)/,
  'read_document must convert text/html pages into readable extracted source content',
)

assert.match(
  conversationSerialization,
  /MAX_BROWSE_CONTENT = 40_000/,
  'persisted extracted pages must retain the same bounded full-page payload after reload',
)

assert.match(
  browserRuntime,
  /browserGetContent[\s\S]*content = truncateReadablePageContent\(content\)/,
  'explicit browser content reads must use the shared bounded full-page payload',
)

assert.doesNotMatch(
  documentReader,
  /browsePage\(resolvedSource\)/,
  'blocked webpage extraction must return structured evidence to the model instead of forcing a hidden browser route',
)

assert.match(
  documentReader,
  /URL_FETCH_TIMEOUT_MS = 10_000/,
  'ordinary webpage extraction must have enough time to return readable text',
)

assert.match(
  documentReader,
  /error:\s*recoveryHint/,
  'blocked webpage extraction must return an internal error field so it is not counted as source evidence',
)

assert.match(
  documentReader,
  /PUBLIC_READER_BASE_URL[\s\S]*readThroughPublicReader[\s\S]*parsePublicReaderDocument/,
  'blocked direct page reads must get one reader-assisted extraction attempt inside the same read_document action',
)

assert.match(
  documentReader,
  /recoverable:\s*true[\s\S]*unavailable:\s*true/,
  'an ultimately inaccessible source must be identified as a recoverable availability outcome',
)

assert.match(
  documentReader,
  /publicReaderEligibleSource[\s\S]*access\[_-\]\?token[\s\S]*if \(!publicReaderEligibleSource\(source\)\) return null/,
  'signed or credential-bearing URLs must never be relayed through the public reader route',
)

assert.match(
  documentReader,
  /source:\s*resolvedSource/,
  'read_document results must keep the resolved source URL for Computer panel display',
)

assert.match(
  panelMapper,
  /\['content', 'text', 'markdown', 'body', 'error', 'statusText'\]/,
  'Computer panel mapping must accept all common extracted-content result fields',
)

assert.match(
  panelMapper,
  /normalizeBrowseLikeResult\(result, 'Extracted page'\)/,
  'read_document panel items must render as extracted source pages, not generic documents',
)

assert.match(
  panelMapper,
  /Source extraction unavailable/,
  'blocked extracted pages must use a neutral Computer panel title instead of a raw extraction error or forced browser claim',
)

assert.doesNotMatch(
  panelMapper,
  /Source needs browser rendering/,
  'the Computer panel must not claim that browser rendering is the only recovery route',
)

assert.doesNotMatch(
  panelMapper,
  /This source needs to be opened as a rendered page before it can be read/,
  'blocked extracted pages must not surface the old rendered-page recovery sentence as panel content',
)

assert.doesNotMatch(
  panelMapper,
  /Source unavailable|Extraction failed/,
  'blocked extracted pages must not use old vague failure titles',
)

assert.match(
  dispatcher,
  /previousBrowse\?\.url && !nextBrowse\.url/,
  'final cheap-extraction results must preserve the live placeholder URL when needed',
)

assert.match(
  dispatcher,
  /isRecoverableSourceAvailabilityResult[\s\S]*status:\s*'done'[\s\S]*errorMessage:\s*undefined[\s\S]*preserveVisibleSourceRecoveryPanel/,
  'an inaccessible third-party page must settle as a neutral completed source attempt instead of a red failed action',
)

assert.match(
  dispatcher,
  /recoverableSourceAvailability[\s\S]*settleHiddenComputerPanelItem\(event\)[\s\S]*removeHiddenTool\(event\.id\)/,
  'non-source internal repair calls must disappear from the visible task list instead of turning red',
)

assert.match(
  browseView,
  /useDeferredEmptyState\(!safeResult\.content\.trim\(\), streaming\)/,
  'extracted-page view must defer its empty state while the final result event is reconciling',
)

assert.match(
  deferredEmptyState,
  /delayMs = 2500[\s\S]*wasStreaming\.current = true[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*setWaitingForResult\(false\)/,
  'transient empty Computer panel states must retain the loading skeleton for a short reconciliation window',
)

assert.match(
  panelMapper,
  /content: internalRecovery \? '' : content,/,
  'empty extracted-page results must remain empty until BrowseView finishes its loading hand-off',
)

assert.match(
  browseLoadingState,
  /isInFlightBrowsePlaceholder[\s\S]*Reading document[\s\S]*Fetching/,
  'task-level reconciliation must recognize only explicit in-flight extraction placeholders',
)

assert.match(
  computerPanel,
  /isBrowseResultPending\(\{[\s\S]*taskStreaming,[\s\S]*activeItemId:[\s\S]*latestItemId:/,
  'the Computer panel must derive extraction loading from both item and task lifecycle state',
)

assert.match(
  computerPanel,
  /<BrowseView key=\{activeItem\.id\}[^>]*streaming=\{activeBrowsePending\}/,
  'each extracted page must receive the task-aware pending state with isolated hook state',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: true,
    itemEmpty: true,
    itemTitle: 'Reading document...',
    taskStreaming: false,
    activeItemId: 'read-1',
    latestItemId: 'read-1',
  }),
  true,
  'an explicitly streaming extraction must render its loading skeleton',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: false,
    itemEmpty: true,
    itemTitle: 'Reading document...',
    taskStreaming: true,
    activeItemId: 'read-1',
    latestItemId: 'read-1',
  }),
  true,
  'the newest extraction placeholder must remain loading after persistence strips its transient flag',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: false,
    itemEmpty: true,
    itemTitle: 'Fetching example.com...',
    taskStreaming: true,
    activeItemId: 'http-1',
    latestItemId: 'http-1',
  }),
  true,
  'HTTP extraction placeholders must use the same reconciliation-safe loading lifecycle',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: false,
    itemEmpty: true,
    itemTitle: 'Document Content',
    taskStreaming: true,
    activeItemId: 'read-1',
    latestItemId: 'read-1',
  }),
  false,
  'a completed empty extraction must render its truthful final state instead of loading forever',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: false,
    itemEmpty: true,
    itemTitle: 'Reading document...',
    taskStreaming: true,
    activeItemId: 'read-1',
    latestItemId: 'read-2',
  }),
  false,
  'a historical extraction placeholder must not impersonate the newest live action',
)

assert.equal(
  isBrowseResultPending({
    itemStreaming: false,
    itemEmpty: true,
    itemTitle: 'Reading document...',
    taskStreaming: false,
    activeItemId: 'read-1',
    latestItemId: 'read-1',
  }),
  false,
  'a terminal extraction placeholder must not remain stuck in loading state',
)

console.log('Extracted page panel smoke passed')
