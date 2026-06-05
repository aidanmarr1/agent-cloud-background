import {
  listSandboxFilesDetailed,
  MAX_SANDBOX_FILE_SIZE,
  readSandboxFileBytes,
} from '@/lib/sandbox'
import { assertTaskAccess } from '@/lib/taskAccess'
import { auth } from '@/auth'
import {
  getTaskFileForUser,
  inferTaskFileMimeType,
  listTaskFilesForUser,
  readTaskFileBody,
  taskFileNameFromPath,
  toPublicTaskFile,
} from '@/lib/taskFiles'

export interface SandboxFile {
  name: string
  path: string
  size: number
  modifiedAt: number
  mimeType?: string
}

function safeDownloadName(name: string): string {
  return name.replace(/[\r\n"]/g, '_')
}

function wantsRawFile(searchParams: URLSearchParams): boolean {
  return searchParams.get('raw') === '1' || searchParams.get('download') === '1'
}

function shouldInlineFile(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf'
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversationId')

  if (!conversationId) {
    return Response.json({ error: 'Missing task id' }, { status: 400 })
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  // Check if reading a specific file
  const filePath = searchParams.get('file')
  if (filePath) {
    const persistedFile = await getTaskFileForUser(userId, conversationId, filePath).catch(() => null)
    if (persistedFile) {
      try {
        const body = await readTaskFileBody(persistedFile)
        if (wantsRawFile(searchParams)) {
          const download = searchParams.get('download') === '1'
          const inline = !download && shouldInlineFile(persistedFile.mimeType)
          return new Response(new Uint8Array(body), {
            headers: {
              ...access.headers,
              'Content-Type': inline ? persistedFile.mimeType : 'application/octet-stream',
              'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeDownloadName(persistedFile.fileName)}"`,
              'Content-Length': String(body.byteLength),
              'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
              'X-Content-Type-Options': 'nosniff',
            },
          })
        }
        return Response.json({
          content: body.toString('utf8'),
          path: persistedFile.path,
          mimeType: persistedFile.mimeType,
          size: persistedFile.size,
        }, { headers: access.headers })
      } catch {
        return Response.json({ error: 'Failed to read file' }, { status: 500 })
      }
    }

    const read = await readSandboxFileBytes(conversationId, filePath)
    if (!read.ok) {
      if (read.status === 413) {
        const maxMb = Math.round(MAX_SANDBOX_FILE_SIZE / (1024 * 1024))
        return Response.json({ error: `File too large (max ${maxMb}MB)` }, { status: 413 })
      }
      return Response.json({ error: read.error }, { status: read.status })
    }

    if (wantsRawFile(searchParams)) {
      const mimeType = inferTaskFileMimeType(filePath)
      const download = searchParams.get('download') === '1'
      const inline = !download && shouldInlineFile(mimeType)
      const body = Uint8Array.from(read.body)
      return new Response(body, {
        headers: {
          ...access.headers,
          'Content-Type': inline ? mimeType : 'application/octet-stream',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeDownloadName(taskFileNameFromPath(filePath))}"`,
          'Content-Length': String(read.size),
          'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    return Response.json({ content: Buffer.from(read.body).toString('utf8'), path: filePath }, { headers: access.headers })
  }

  // List all files
  const { files, truncated } = await listSandboxFilesDetailed(conversationId)
  const persistedFiles = await listTaskFilesForUser(userId, conversationId).catch(() => [])
  const byPath = new Map<string, SandboxFile>()
  for (const file of files) {
    byPath.set(file.path, file)
  }
  for (const file of persistedFiles) {
    byPath.set(file.path, toPublicTaskFile(file))
  }
  const mergedFiles = Array.from(byPath.values()).sort((a, b) => b.modifiedAt - a.modifiedAt)
  return Response.json({ files: mergedFiles, truncated }, { headers: access.headers })
}
