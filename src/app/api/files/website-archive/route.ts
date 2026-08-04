import { auth } from '@/auth'
import { assertTaskAccess } from '@/lib/taskAccess'
import {
  getTaskFileForUser,
  normalizeTaskFilePath,
  readTaskFileBody,
  taskFileNameFromPath,
} from '@/lib/taskFiles'
import { createStoredZipArchive } from '@/lib/zipArchive'

const WEBSITE_SOURCE_PATHS = [
  'website-src/index.html',
  'website-src/styles.css',
  'website-src/script.js',
]

function safeDownloadName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'website'
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversationId') || ''
  const rawEntryPath = searchParams.get('file') || 'index.html'

  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }

  let entryPath: string
  try {
    entryPath = normalizeTaskFilePath(rawEntryPath)
  } catch {
    return Response.json({ error: 'Invalid website path' }, { status: 400 })
  }
  if (!/\.html?$/i.test(entryPath)) {
    return Response.json({ error: 'Website entry must be an HTML file' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) return Response.json({ error: 'Authentication required' }, { status: 401 })

  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  const paths = [...new Set([...WEBSITE_SOURCE_PATHS, entryPath])]
  const records = await Promise.all(paths.map(path =>
    getTaskFileForUser(userId, conversationId, path).catch(() => null)
  ))
  const entryRecord = records[paths.indexOf(entryPath)]
  if (!entryRecord) return Response.json({ error: 'Website file not found' }, { status: 404 })

  const available = records.flatMap((record, index) => record ? [{ record, path: paths[index] }] : [])
  const bodies = await Promise.all(available.map(({ record }) => readTaskFileBody(record)))
  const archive = createStoredZipArchive(available.map(({ path }, index) => ({
    path,
    body: new Uint8Array(bodies[index]),
  })))
  const baseName = safeDownloadName(taskFileNameFromPath(entryPath).replace(/\.html?$/i, ''))

  return new Response(Uint8Array.from(archive).buffer, {
    headers: {
      ...access.headers,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${baseName}-source.zip"`,
      'Content-Length': String(archive.byteLength),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
