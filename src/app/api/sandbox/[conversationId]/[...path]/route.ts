import { readSandboxFileBytes } from '@/lib/sandbox'
import { findActiveTaskJobForConversation } from '@/lib/agent/taskJobs'
import { assertTaskAccess } from '@/lib/taskAccess'
import { getTaskFileForUser, readTaskFileBody } from '@/lib/taskFiles'
import { auth } from '@/auth'

const MIME_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  txt: 'text/plain', xml: 'application/xml', pdf: 'application/pdf',
}

const SANDBOX_DOCUMENT_CSP = [
  'sandbox allow-scripts allow-forms',
  "default-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function sandboxHeaders(contentType: string): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }

  if (contentType.startsWith('text/html') || contentType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = SANDBOX_DOCUMENT_CSP
  }

  return headers
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string; path: string[] }> }
) {
  const { conversationId, path: pathSegments } = await params

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

  const filePath = pathSegments.join('/')
  const persistedFile = await getTaskFileForUser(userId, conversationId, filePath).catch(() => null)
  if (persistedFile) {
    try {
      const body = await readTaskFileBody(persistedFile)
      return new Response(new Uint8Array(body), {
        headers: {
          ...sandboxHeaders(persistedFile.mimeType),
          ...access.headers,
          'Content-Length': String(body.byteLength),
        },
      })
    } catch {
      return Response.json({ error: 'Failed to read file' }, { status: 500 })
    }
  }

  // Preview requests must not recreate an E2B sandbox after a task has
  // finished (or while it is idle). Only an authenticated, conversation-owned
  // run that is still queued/running may fall back to the live sandbox.
  const activeJob = await findActiveTaskJobForConversation(userId, conversationId)
  if (!activeJob) {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }

  const read = await readSandboxFileBytes(conversationId, filePath)
  if (!read.ok) {
    if (read.status === 403) return Response.json({ error: 'Forbidden' }, { status: 403 })
    if (read.status === 413) return Response.json({ error: 'Payload Too Large' }, { status: 413 })
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  return new Response(Uint8Array.from(read.body), { headers: { ...sandboxHeaders(contentType), ...access.headers } })
}
