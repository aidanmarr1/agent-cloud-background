import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [filesRoute, sandboxPreviewRoute, sandboxSource] = await Promise.all([
  readFile(join(root, 'src/app/api/files/route.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/sandbox/[conversationId]/[...path]/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/sandbox.ts'), 'utf8'),
])

const filesLiveRead = filesRoute.indexOf('readSandboxFileBytes(conversationId, filePath)')
const filesActiveGuard = filesRoute.indexOf('const activeJob = await getActiveJob()')
assert.ok(filesActiveGuard >= 0 && filesActiveGuard < filesLiveRead,
  'project file reads must prove an owned active run before falling back to a live sandbox')
assert.match(filesRoute,
  /const activeJob = await getActiveJob\(\)[\s\S]*?if \(!activeJob\) \{[\s\S]*?File not found[\s\S]*?status: 404[\s\S]*?readSandboxFileBytes\(conversationId, filePath\)/,
  'idle project file reads must return 404 without touching the live sandbox')

const durableList = filesRoute.indexOf('const persistedFiles = await listTaskFilesForUser')
const liveList = filesRoute.indexOf('listSandboxFilesDetailed(conversationId)')
assert.ok(durableList >= 0 && durableList < liveList,
  'project file lists must load durable records before considering a live sandbox')
assert.match(filesRoute,
  /const activeJob = await getActiveJob\(\)[\s\S]*?if \(activeJob\) \{[\s\S]*?listSandboxFilesDetailed\(conversationId\)/,
  'project file lists may inspect a live sandbox only for an owned active run')

const previewDurableRead = sandboxPreviewRoute.indexOf('getTaskFileForUser(userId, conversationId, filePath)')
const previewActiveGuard = sandboxPreviewRoute.indexOf('findActiveTaskJobForConversation(userId, conversationId)')
const previewLiveRead = sandboxPreviewRoute.indexOf('readSandboxFileBytes(conversationId, filePath)')
assert.ok(previewDurableRead >= 0 && previewDurableRead < previewActiveGuard,
  'sandbox previews must prefer durable task files before considering live state')
assert.ok(previewActiveGuard >= 0 && previewActiveGuard < previewLiveRead,
  'sandbox previews must prove an owned active run before reading a live sandbox')
assert.match(sandboxPreviewRoute,
  /if \(!activeJob\) \{[\s\S]*?Not Found[\s\S]*?status: 404[\s\S]*?readSandboxFileBytes\(conversationId, filePath\)/,
  'terminal sandbox previews must return 404 when no durable file exists')

assert.doesNotMatch(filesRoute, /getOrCreateE2BSandbox/,
  'project files API must never create an E2B sandbox directly')
assert.doesNotMatch(sandboxPreviewRoute, /getOrCreateE2BSandbox/,
  'sandbox preview route must never create an E2B sandbox directly')
assert.match(
  sandboxSource,
  /export async function destroySandbox[\s\S]*sandboxDirs\.delete\(safeId\)[\s\S]*rm\(entry\?\.path \?\? getSandboxDirPath\(safeId\)/,
  'sandbox cleanup must remove the deterministic local directory even after a process restart loses its memory registry',
)

console.log('sandbox preview lifecycle smoke: ok')
