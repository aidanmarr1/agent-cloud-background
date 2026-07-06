import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

const [browse, documentReader, panelMapper, dispatcher] = await Promise.all([
  readFile(join(root, 'src/lib/browse.ts'), 'utf8'),
  readFile(join(root, 'src/lib/document.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/panelMapper.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
])

assert.match(
  browse,
  /export function parseReadableHtml/,
  'webpage readability extraction must be shareable by browser and document reads',
)

assert.match(
  documentReader,
  /parseReadableHtml\(buffer\.toString\('utf-8'\), resolvedSource\)/,
  'read_document must convert text/html pages into readable extracted source content',
)

assert.match(
  documentReader,
  /browsePage\(resolvedSource\)/,
  'blocked webpage extraction must try the stronger readable-page path before failing',
)

assert.match(
  documentReader,
  /error:\s*recoveryHint/,
  'blocked webpage extraction must return an internal error field so it is not counted as source evidence',
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
  /Source needs browser rendering/,
  'blocked extracted pages must use a neutral Computer panel title instead of a raw extraction error',
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

console.log('Extracted page panel smoke passed')
