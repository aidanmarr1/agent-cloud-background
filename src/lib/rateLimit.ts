/**
 * In-memory sliding-window rate limiter.
 * Good enough for a single Next.js server process; production deployments with
 * multiple instances should back this with Redis or another shared store.
 */

interface RateLimitEntry {
  timestamps: number[]
  lastSeen: number
  windowMs: number
}

export interface RateLimitOptions {
  windowMs?: number
  maxRequests?: number
}

const requests = new Map<string, RateLimitEntry>()

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS = 20
const CLEANUP_INTERVAL_MS = 5 * 60_000
const MAX_TRACKED_KEYS = 5000
const MAX_KEY_LENGTH = 160

let lastCleanup = Date.now()

function normalizeKey(key: string): string {
  const normalized = key.trim().replace(/\s+/g, ' ').slice(0, MAX_KEY_LENGTH)
  return normalized || 'unknown'
}

function cleanup(now = Date.now()) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now

  for (const [key, entry] of requests) {
    const cutoff = now - entry.windowMs
    const valid = entry.timestamps.filter(t => t > cutoff)
    if (valid.length === 0) {
      requests.delete(key)
    } else {
      requests.set(key, { ...entry, timestamps: valid })
    }
  }
}

function evictOverflow() {
  if (requests.size <= MAX_TRACKED_KEYS) return

  let oldestKey: string | null = null
  let oldestSeen = Infinity
  for (const [key, entry] of requests) {
    if (entry.lastSeen < oldestSeen) {
      oldestSeen = entry.lastSeen
      oldestKey = key
    }
  }
  if (oldestKey) requests.delete(oldestKey)
}

export function checkRateLimit(
  key: string,
  options: RateLimitOptions = {},
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now()
  cleanup(now)

  const safeKey = normalizeKey(key)
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
  const cutoff = now - windowMs
  const existing = requests.get(safeKey)
  const timestamps = (existing?.timestamps || []).filter(t => t > cutoff)

  if (timestamps.length >= maxRequests) {
    requests.set(safeKey, { timestamps, lastSeen: now, windowMs })
    const oldestInWindow = timestamps[0]
    const retryAfterMs = Math.max(1000, oldestInWindow + windowMs - now)
    return { allowed: false, retryAfterMs }
  }

  timestamps.push(now)
  requests.set(safeKey, { timestamps, lastSeen: now, windowMs })
  evictOverflow()
  return { allowed: true }
}
