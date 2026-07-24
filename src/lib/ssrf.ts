import { lookup } from 'dns/promises'
import { lookup as callbackLookup } from 'dns'
import type { LookupOptions } from 'dns'
import http from 'http'
import https from 'https'
import type { LookupFunction } from 'net'
import { isIP } from 'net'

const DEFAULT_MAX_RESPONSE_BYTES = 15 * 1024 * 1024
const PUBLIC_HOST_PREFLIGHT_TTL_MS = 30_000
const PUBLIC_HOST_PREFLIGHT_MAX_ENTRIES = 512

interface PublicHostPreflight {
  validUntil: number
  pending?: Promise<void>
}

const publicHostPreflightKey = '__agentPublicHostPreflightCache' as const
const publicHostPreflightCache: Map<string, PublicHostPreflight> =
  (globalThis as unknown as Record<string, Map<string, PublicHostPreflight>>)[publicHostPreflightKey] ??
  ((globalThis as unknown as Record<string, Map<string, PublicHostPreflight>>)[publicHostPreflightKey] = new Map())

function prunePublicHostPreflights(now: number): void {
  if (publicHostPreflightCache.size < PUBLIC_HOST_PREFLIGHT_MAX_ENTRIES) return
  for (const [hostname, entry] of publicHostPreflightCache) {
    if (!entry.pending && entry.validUntil <= now) publicHostPreflightCache.delete(hostname)
  }
  while (publicHostPreflightCache.size >= PUBLIC_HOST_PREFLIGHT_MAX_ENTRIES) {
    const oldest = publicHostPreflightCache.keys().next().value
    if (!oldest) break
    publicHostPreflightCache.delete(oldest)
  }
}

export type GuardedFetchInit = Omit<RequestInit, 'body'> & {
  body?: string | Uint8Array | null
  maxBytes?: number
}

function stripIpDecorators(ip: string): string {
  return ip.trim().replace(/^\[|\]$/g, '').replace(/%.+$/, '')
}

function ipv4FromMappedIpv6(ip: string): string | null {
  const clean = stripIpDecorators(ip).toLowerCase()
  const mapped = clean.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/)
  if (!mapped) return null

  const tail = mapped[1]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail

  const groups = tail.split(':')
  if (groups.length !== 2) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  if (!Number.isFinite(high) || !Number.isFinite(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return null
  }
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`
}

export function isPrivateIp(ip: string): boolean {
  const clean = stripIpDecorators(ip).toLowerCase()
  const mappedV4 = ipv4FromMappedIpv6(clean)
  if (mappedV4) return isPrivateIp(mappedV4)

  // IPv4 private ranges
  if (/^127\./.test(clean)) return true
  if (/^10\./.test(clean)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true
  if (/^192\.168\./.test(clean)) return true
  if (clean === '0.0.0.0') return true
  // Link-local
  if (/^169\.254\./.test(clean)) return true
  // Carrier-grade NAT / shared address space (Tailscale, etc.)
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(clean)) return true
  // Multicast, reserved, benchmarking, and documentation ranges should never be
  // useful egress targets for the agent.
  if (/^(?:22[4-9]|23\d)\./.test(clean)) return true
  if (/^24[0-9]\./.test(clean) || /^25[0-5]\./.test(clean)) return true
  if (/^192\.0\.0\./.test(clean) || /^192\.0\.2\./.test(clean)) return true
  if (/^198\.(?:1[89])\./.test(clean) || /^198\.51\.100\./.test(clean)) return true
  if (/^203\.0\.113\./.test(clean)) return true

  // IPv6
  if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1') return true
  // IPv6 unique local (fc00::/7)
  if (/^f[cd]/i.test(clean)) return true
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab]/i.test(clean)) return true
  // IPv6 multicast.
  if (/^ff/i.test(clean)) return true

  return false
}

export async function checkHost(hostname: string): Promise<void> {
  const lower = stripIpDecorators(hostname).toLowerCase()
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') {
    throw new Error('Requests to localhost/private networks are blocked')
  }
  if (lower === '169.254.169.254') {
    throw new Error('Requests to cloud metadata endpoints are blocked')
  }
  if (isIP(lower) && isPrivateIp(lower)) {
    throw new Error('Requests to private/internal IP addresses are blocked')
  }
  if (isIP(lower)) return

  const now = Date.now()
  const cached = publicHostPreflightCache.get(lower)
  if (cached?.validUntil && cached.validUntil > now) return
  if (cached?.pending) return cached.pending
  prunePublicHostPreflights(now)

  const pending = (async () => {
    try {
      // lookup() returns a single address by default; a hostname with a mixed
      // record set (public + private) can pass the check on one resolution and
      // fetch the private one on the next. Validate ALL addresses.
      const addresses = await lookup(lower, { all: true })
      for (const { address } of addresses) {
        if (isPrivateIp(address)) {
          throw new Error('Requests to private/internal IP addresses are blocked')
        }
      }
      publicHostPreflightCache.set(lower, {
        validUntil: Date.now() + PUBLIC_HOST_PREFLIGHT_TTL_MS,
      })
    } catch (err) {
      publicHostPreflightCache.delete(lower)
      if ((err as Error).message.includes('blocked')) throw err
      // DNS failure — let the connection-time checked lookup handle it.
    }
  })()
  publicHostPreflightCache.set(lower, { validUntil: 0, pending })
  return pending
}

export function validateHttpUrl(url: string): URL {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported')
  }
  return parsed
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {}
  if (!headers) return output

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      output[key] = value
    })
    return output
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) output[key] = value
    return output
  }

  for (const [key, value] of Object.entries(headers)) {
    output[key] = String(value)
  }
  return output
}

const checkedLookup: LookupFunction = (hostname, options, callback) => {
  const lookupOptions: LookupOptions = options || {}

  if (lookupOptions.all) {
    callbackLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) {
        callback(err, [], undefined)
        return
      }

      for (const { address } of addresses) {
        if (isPrivateIp(address)) {
          callback(new Error('Requests to private/internal IP addresses are blocked'), [], undefined)
          return
        }
      }

      callback(null, addresses, undefined)
    })
    return
  }

  callbackLookup(hostname, { ...lookupOptions, all: false }, (err, address, family) => {
    if (err) {
      callback(err, '', family)
      return
    }

    if (isPrivateIp(address)) {
      callback(new Error('Requests to private/internal IP addresses are blocked'), '', family)
      return
    }

    callback(null, address, family)
  })
}

export async function guardedFetch(input: string | URL, init: GuardedFetchInit = {}): Promise<Response> {
  const url = validateHttpUrl(input.toString())
  await checkHost(url.hostname)

  if (init.redirect && init.redirect !== 'manual') {
    throw new Error('guardedFetch only supports manual redirect handling')
  }

  if (init.body && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) {
    throw new Error('guardedFetch only supports string or Uint8Array request bodies')
  }

  const maxBytes = Math.max(1, init.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES)

  return new Promise<Response>((resolve, reject) => {
    const requestImpl = url.protocol === 'https:' ? https.request : http.request
    const headers = headersFromInit(init.headers)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = requestImpl(url, {
      method: init.method || 'GET',
      headers,
      lookup: checkedLookup,
      signal: init.signal ?? undefined,
    }, (res) => {
      const declaredLength = Number.parseInt(String(res.headers['content-length'] || ''), 10)
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.destroy(new Error(`Response exceeded ${Math.round(maxBytes / (1024 * 1024))}MB limit`))
        return
      }

      const chunks: Buffer[] = []
      let total = 0

      res.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buffer.byteLength
        if (total > maxBytes) {
          request.destroy(new Error(`Response exceeded ${Math.round(maxBytes / (1024 * 1024))}MB limit`))
          return
        }
        chunks.push(buffer)
      })
      res.on('end', () => {
        if (settled) return
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item)
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value))
          }
        }

        const status = res.statusCode || 200
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks)
        settled = true
        resolve(new Response(body, {
          status,
          statusText: res.statusMessage || '',
          headers: responseHeaders,
        }))
      })
    })

    request.on('error', fail)

    if (init.body && !['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase())) {
      request.write(init.body)
    }

    request.end()
  })
}
