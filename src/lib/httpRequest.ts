import { guardedFetch, validateHttpUrl, type GuardedFetchInit } from './ssrf'

export interface HttpRequestResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  durationMs: number
}

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']
const MAX_RESPONSE_CHARS = 20_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

export async function makeHttpRequest(
  method: string,
  url: string,
  headers?: Record<string, string>,
  body?: string
): Promise<HttpRequestResult> {
  const startTime = Date.now()

  const upperMethod = method.toUpperCase()
  if (!ALLOWED_METHODS.includes(upperMethod)) {
    return {
      status: 0,
      statusText: `Error: invalid method "${method}". Allowed: ${ALLOWED_METHODS.join(', ')}`,
      headers: {},
      body: '',
      durationMs: Date.now() - startTime,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    let currentUrl = url
    let currentMethod = upperMethod
    let currentBody = body
    let res: Response | null = null

    // Manual redirect loop: re-validate each hop against SSRF rules.
    // Default fetch redirect handling does NOT re-check the host, so an
    // attacker-controlled HTTPS endpoint can 302 to http://169.254.169.254/
    // (cloud metadata) or any private IP and bypass checkHost on the original.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        validateHttpUrl(currentUrl)
      } catch {
        return {
          status: 0,
          statusText: 'Error: only HTTP and HTTPS URLs are supported',
          headers: {},
          body: '',
          durationMs: Date.now() - startTime,
        }
      }

      const fetchOptions: GuardedFetchInit = {
        method: currentMethod,
        headers: headers || {},
        signal: controller.signal,
        redirect: 'manual',
        maxBytes: MAX_RESPONSE_BYTES,
      }
      if (currentBody && !['GET', 'HEAD'].includes(currentMethod)) {
        fetchOptions.body = currentBody
      }

      res = await guardedFetch(currentUrl, fetchOptions)

      // Status 0 means an opaque-redirect response under 'manual'. Some runtimes
      // surface real 3xx codes; handle both shapes.
      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location')
      if (!isRedirect) break

      if (hop === MAX_REDIRECTS) {
        return {
          status: res.status,
          statusText: `Error: too many redirects (max ${MAX_REDIRECTS})`,
          headers: {},
          body: '',
          durationMs: Date.now() - startTime,
        }
      }

      const location = res.headers.get('location')!
      currentUrl = new URL(location, currentUrl).toString()
      // Per RFC 7231: 303 always becomes GET; 301/302 historically downgrade
      // POST→GET, but we keep the verb for 307/308 which preserve method+body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
        currentMethod = 'GET'
        currentBody = undefined
      }
    }

    if (!res) {
      return {
        status: 0,
        statusText: 'Error: no response received',
        headers: {},
        body: '',
        durationMs: Date.now() - startTime,
      }
    }

    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    let responseBody = await res.text()
    if (responseBody.length > MAX_RESPONSE_CHARS) {
      responseBody = responseBody.slice(0, MAX_RESPONSE_CHARS) + '\n... [truncated]'
    }

    return {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: responseBody,
      durationMs: Date.now() - startTime,
    }
  } catch (err) {
    return {
      status: 0,
      statusText: `Error: ${(err as Error).message}`,
      headers: {},
      body: '',
      durationMs: Date.now() - startTime,
    }
  } finally {
    clearTimeout(timeout)
  }
}
