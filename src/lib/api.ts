import { isIP } from 'net'

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024

type JsonBodyResult =
  | { success: true; data: unknown }
  | { success: false; response: Response }

class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`)
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers })
}

async function readBodyText(request: Request, limitBytes: number): Promise<string> {
  if (!request.body) {
    return request.text()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) {
        await reader.cancel()
        throw new BodyTooLargeError(limitBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

export async function readJsonBody(
  request: Request,
  limitBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<JsonBodyResult> {
  const rawContentLength = request.headers.get('content-length')
  const contentLength = rawContentLength ? Number.parseInt(rawContentLength, 10) : NaN
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    return {
      success: false,
      response: jsonError(`Request body too large (max ${formatBytes(limitBytes)})`, 413),
    }
  }

  try {
    const body = await readBodyText(request, limitBytes)
    if (!body.trim()) {
      return { success: false, response: jsonError('Invalid JSON body', 400) }
    }
    return { success: true, data: JSON.parse(body) as unknown }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        success: false,
        response: jsonError(`Request body too large (max ${formatBytes(error.limitBytes)})`, 413),
      }
    }
    return { success: false, response: jsonError('Invalid JSON body', 400) }
  }
}

export function getClientIp(request: Request): string {
  const trustProxyHeaders = process.env.AGENT_TRUST_PROXY_HEADERS === 'true' || !!process.env.VERCEL
  const requestHost = (() => {
    try {
      return new URL(request.url).hostname
    } catch {
      return ''
    }
  })()

  const raw = trustProxyHeaders
    ? (
        request.headers.get('x-forwarded-for')?.split(',')[0] ||
        request.headers.get('x-real-ip') ||
        request.headers.get('cf-connecting-ip') ||
        ''
      ).trim()
    : ''

  const normalized = raw.replace(/^\[|\]$/g, '')
  if (isIP(normalized)) return normalized

  if (requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === '::1') {
    return 'local'
  }

  const fallback = normalized
    .toLowerCase()
    .replace(/[^a-z0-9:._-]/g, '')
    .slice(0, 128)

  return fallback || 'unknown'
}

export function rateLimitResponse(retryAfterMs?: number, message = 'Too many requests. Please try again later.'): Response {
  const retryAfterSeconds = Math.ceil((retryAfterMs || 60_000) / 1000)
  return jsonError(message, 429, { 'Retry-After': String(retryAfterSeconds) })
}

export function assertSameOriginRequest(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null

  const trustProxyHeaders = process.env.AGENT_TRUST_PROXY_HEADERS === 'true'
  const allowedOrigins = new Set<string>()
  const addConfiguredOrigin = (value: string | undefined, assumeHttps = false) => {
    const trimmed = value?.trim()
    if (!trimmed) return
    try {
      allowedOrigins.add(new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `${assumeHttps ? 'https' : 'http'}://${trimmed}`).origin)
    } catch {
      // Ignore malformed deployment metadata.
    }
  }

  try {
    const parsed = new URL(request.url)
    allowedOrigins.add(parsed.origin)
    addConfiguredOrigin(process.env.AUTH_URL)
    addConfiguredOrigin(process.env.NEXTAUTH_URL)
    addConfiguredOrigin(process.env.VERCEL_URL, true)

    const host = trustProxyHeaders ? request.headers.get('host') : null
    if (host) {
      const proto = request.headers.get('x-forwarded-proto') || parsed.protocol.replace(/:$/, '')
      allowedOrigins.add(`${proto}://${host}`)
    }
    if (process.env.NODE_ENV !== 'production') {
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      allowedOrigins.add(`${parsed.protocol}//localhost${port ? `:${port}` : ''}`)
      allowedOrigins.add(`${parsed.protocol}//127.0.0.1${port ? `:${port}` : ''}`)
    }
  } catch {
    return Response.json({ error: 'Invalid request URL' }, { status: 400 })
  }

  if (!allowedOrigins.has(origin)) {
    return Response.json({ error: 'Cross-origin request blocked' }, { status: 403 })
  }

  return null
}
