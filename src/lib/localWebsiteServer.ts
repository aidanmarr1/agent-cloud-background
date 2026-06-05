import { constants } from 'fs'
import { createServer, type Server } from 'http'
import { extname, isAbsolute, join, resolve } from 'path'
import { open, stat } from 'fs/promises'
import { getOrCreateSandboxDir, isInsideSandbox, resolveAndVerify } from './sandbox'

interface LocalWebsiteServer {
  conversationId: string
  rootDir: string
  server: Server
  port: number
  origin: string
  lastUsed: number
}

export interface LocalWebsiteLaunch {
  url: string
  origin: string
  port: number
  rootDir: string
}

const servers = new Map<string, LocalWebsiteServer>()
const managedPorts = new Set<number>()
const SAFE_SEGMENT = /%2f|%5c/i
const LOCAL_PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "navigate-to 'self'",
].join('; ')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function isWebsiteEntryPath(filePath: string): boolean {
  const clean = filePath.trim().toLowerCase().split('?')[0].split('#')[0]
  return clean.endsWith('.html') || clean.endsWith('.htm')
}

export function isManagedWebsiteServerUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return isLocal && managedPorts.has(Number(url.port))
}

function normalizeSandboxPath(filePath: string): string {
  const normalized = filePath.replace(/^\.?\/+/, '').replace(/\/+/g, '/')
  return normalized || 'index.html'
}

function encodePath(filePath: string): string {
  return normalizeSandboxPath(filePath).split('/').map(encodeURIComponent).join('/')
}

function decodeRequestPath(urlPath: string): string | null {
  const raw = urlPath.replace(/^\/+/, '') || 'index.html'
  if (SAFE_SEGMENT.test(raw)) return null
  try {
    return normalizeSandboxPath(decodeURIComponent(raw))
  } catch {
    return null
  }
}

async function resolveSafeFile(rootDir: string, requestPath: string): Promise<string | null> {
  const resolved = resolve(rootDir, requestPath)
  if (isAbsolute(requestPath) || !isInsideSandbox(rootDir, resolved)) return null

  try {
    const info = await stat(/* turbopackIgnore: true */ resolved)
    if (info.isDirectory()) {
      const indexPath = join(resolved, 'index.html')
      try {
        const indexInfo = await stat(/* turbopackIgnore: true */ indexPath)
        return indexInfo.isFile() && await resolveAndVerify(rootDir, indexPath) ? indexPath : null
      } catch {
        return null
      }
    }
    if (!info.isFile()) return null
    return await resolveAndVerify(rootDir, resolved) ? resolved : null
  } catch {
    const ext = extname(requestPath)
    if (!ext) {
      const fallback = join(rootDir, 'index.html')
      try {
        const fallbackInfo = await stat(/* turbopackIgnore: true */ fallback)
        if (fallbackInfo.isFile() && await resolveAndVerify(rootDir, fallback)) return fallback
      } catch {
        return null
      }
    }
    return null
  }
}

async function createStaticServer(conversationId: string, rootDir: string): Promise<LocalWebsiteServer> {
  const server = createServer(async (req, res) => {
    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end('Method not allowed')
      return
    }

    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    const requestPath = decodeRequestPath(requestUrl.pathname)
    if (!requestPath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad request')
      return
    }

    const filePath = await resolveSafeFile(rootDir, requestPath)
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    let file: Awaited<ReturnType<typeof open>> | null = null
    try {
      file = await open(/* turbopackIgnore: true */ filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const fileInfo = await file.stat()
      const ext = extname(filePath).toLowerCase()
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
        'Content-Length': fileInfo.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Content-Security-Policy': LOCAL_PREVIEW_CSP,
      })
      if (method === 'HEAD') {
        await file.close()
        return res.end()
      }
      file.createReadStream().pipe(res)
    } catch {
      await file?.close().catch(() => {})
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end('Not found')
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      rejectListen(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', onListening)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Failed to start local website server')
  }

  const port = address.port
  const origin = `http://127.0.0.1:${port}`
  managedPorts.add(port)

  server.on('close', () => {
    managedPorts.delete(port)
    const current = servers.get(conversationId)
    if (current?.port === port) servers.delete(conversationId)
  })

  return {
    conversationId,
    rootDir,
    server,
    port,
    origin,
    lastUsed: Date.now(),
  }
}

export async function getOrStartLocalWebsiteServer(conversationId: string): Promise<LocalWebsiteServer> {
  const rootDir = await getOrCreateSandboxDir(conversationId)
  const existing = servers.get(conversationId)
  if (existing && existing.rootDir === rootDir) {
    existing.lastUsed = Date.now()
    return existing
  }

  if (existing) {
    await new Promise<void>((resolveClose) => existing.server.close(() => resolveClose()))
  }

  const created = await createStaticServer(conversationId, rootDir)
  servers.set(conversationId, created)
  return created
}

export async function buildLocalWebsiteLaunch(
  conversationId: string,
  filePath = 'index.html',
): Promise<LocalWebsiteLaunch> {
  const server = await getOrStartLocalWebsiteServer(conversationId)
  const path = encodePath(filePath)
  const cacheBuster = `v=${Date.now()}`
  return {
    url: `${server.origin}/${path}?${cacheBuster}`,
    origin: server.origin,
    port: server.port,
    rootDir: server.rootDir,
  }
}

export async function stopLocalWebsiteServer(conversationId: string): Promise<void> {
  const existing = servers.get(conversationId)
  if (!existing) return
  await new Promise<void>((resolveClose) => existing.server.close(() => resolveClose()))
}
