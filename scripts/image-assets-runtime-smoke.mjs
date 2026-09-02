import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createJiti } from 'jiti'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
const jiti = createJiti(import.meta.url, { alias: { '@': join(root, 'src') } })
const { normalizeStorageKey, putLocalObject, readLocalObject } = await jiti.import(join(root, 'src/lib/storage/local.ts'))
const { normalizeTursoStorageKey } = await jiti.import(join(root, 'src/lib/storage/turso.ts'))
const { validateDownloadedImage, persistImageSearchDownloads, imageSearchQuery, isImageSearchCandidate } = await jiti.import(join(root, 'src/lib/imageAssets.ts'))
const { mapToolResultToPanel } = await jiti.import(join(root, 'src/stream/client/panelMapper.ts'))

for (const normalize of [normalizeStorageKey, normalizeTursoStorageKey]) {
  for (const key of ['task-files/user/task/id/Birds...jpg', 'task-files/user/task/id/..Birds.png', 'task-files/user/task/id/bird.v2.jpg']) {
    assert.equal(normalize(key), key, 'ordinary filename dots must not be treated as traversal')
  }
  for (const key of ['../secret', 'a/../secret', 'a/./secret', 'a\\..\\secret', '..', '.', 'a/evil\0.jpg']) {
    assert.throws(() => normalize(key), /Invalid storage key/, `unsafe key must still be blocked: ${key}`)
  }
}

const storageDir = await mkdtemp(join(tmpdir(), 'agent-image-storage-'))
const previousStorage = process.env.AGENT_STORAGE_DIR
process.env.AGENT_STORAGE_DIR = storageDir
try {
  const key = 'task-files/user/task/id/6_Hummingbird...jpg'
  const body = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#53796f' } }).jpeg().toBuffer()
  await putLocalObject(key, body)
  assert.deepEqual(await readLocalObject(key), body, 'ellipsis filenames must round-trip through actual storage')
  assert.deepEqual(await validateDownloadedImage(body), { extension: 'jpg', width: 256, height: 256 })
  await assert.rejects(validateDownloadedImage(Buffer.from('<html>Access denied</html>')))
  const pixel = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer()
  await assert.rejects(validateDownloadedImage(pixel), /too small/)
  await assert.rejects(validateDownloadedImage(body.subarray(0, 100)))
} finally {
  if (previousStorage === undefined) delete process.env.AGENT_STORAGE_DIR
  else process.env.AGENT_STORAGE_DIR = previousStorage
  await rm(storageDir, { recursive: true, force: true })
}

assert.match(imageSearchQuery('hummingbird', 'photo'), /photograph.*-cartoon.*-illustration/)
assert.equal(imageSearchQuery('bird icons', 'any'), 'bird icons')
assert.equal(isImageSearchCandidate('Cartoon flat icons of owl and eagle', 'photo'), false)
assert.equal(isImageSearchCandidate('Vector Set Of Colorful Bird Icons', 'photo'), false)
assert.equal(isImageSearchCandidate('AI-generated bird portrait', 'photo'), false)
assert.equal(isImageSearchCandidate('Hummingbird photographed in the wild', 'photo'), true)
assert.equal(isImageSearchCandidate('Cartoon flat icons of owl and eagle', 'any'), true)

const images = [0, 1, 2].map(index => ({ title: `Bird ${index}`, imageUrl: `https://example.com/${index}.jpg`, sourceUrl: `https://example.com/bird-${index}`, thumbnailUrl: `https://example.com/thumb-${index}.jpg` }))
const downloaded = ['downloads/0_Bird.jpg', 'downloads/1_Bird...jpg', 'downloads/2_Bird.jpg']
const assets = images.map((image, index) => ({ ...image, path: downloaded[index], width: 256, height: 256 }))
const source = { images, downloaded, assets, conversationId: 'bird-task' }
const partial = await persistImageSearchDownloads(source, async path => {
  if (path === downloaded[1]) throw new Error('Storage temporarily unavailable')
  return { size: 1024 }
})
assert.deepEqual(partial.downloaded, [downloaded[0], downloaded[2]])
assert.deepEqual(partial.unsaved, [downloaded[1]])
assert.equal(partial.error, undefined, 'one optional asset must not abort the task')
assert.match(partial.warning, /2 of 3.*1 could not be saved/)
assert.equal(partial.assets[1].sourceUrl, images[2].sourceUrl)

const mapped = mapToolResultToPanel({ id: 'images', name: 'image_search', result: partial }, 'bird-task')
assert.equal(mapped.data.images.length, 2)
assert.equal(mapped.data.images[1].title, 'Bird 2', 'a failed middle download must not shift image captions')
assert.equal(mapped.data.images[1].sourceUrl, images[2].sourceUrl, 'a failed download must not shift source attribution')
assert.match(mapped.data.images[1].localUrl, /^\/api\/files\?conversationId=bird-task&file=/)
assert.match(mapped.data.warning, /2 of 3/)

const legacy = mapToolResultToPanel({ id: 'legacy', name: 'image_search', result: { images, downloaded: [downloaded[2]] } }, 'bird-task')
assert.equal(legacy.data.images[0].title, 'Bird 2', 'older runs retain correct index-based source mapping')
const failed = mapToolResultToPanel({ id: 'failed', name: 'image_search', result: { error: 'Image storage unavailable' } }, 'bird-task')
assert.equal(failed.data.error, 'Image storage unavailable', 'errors must survive the panel mapper')
const unavailable = await persistImageSearchDownloads(source, async () => null)
assert.equal(unavailable.downloaded.length, 0)
assert.equal(unavailable.unsaved.length, 3)
assert.equal(unavailable.error, undefined)
const preview = mapToolResultToPanel({ id: 'preview', name: 'image_search', result: unavailable }, 'bird-task')
assert.equal(preview.data.images.length, 3, 'source candidates survive a persistence failure')
assert.ok(preview.data.images.every(image => image.saved === false && image.localUrl === ''))
const aborted = new AbortController()
aborted.abort()
await assert.rejects(persistImageSearchDownloads(source, async () => ({}), aborted.signal), { name: 'AbortError' })

console.log('Image asset storage, decoding, photo mode, partial recovery, and panel mapping checks passed.')
