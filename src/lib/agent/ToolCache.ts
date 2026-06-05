/**
 * Tool Result Cache — avoids redundant tool executions.
 *
 * Caches results from idempotent tools (searches, document reads, etc.)
 * with TTL-based expiration and LRU eviction. When the same tool is called
 * with the same arguments, the cached result is returned instantly.
 *
 * Only caches read-only tools — tools with side effects (create_file,
 * execute_command, etc.) are never cached.
 */

import type { Logger } from './Logger'

interface CacheEntry {
  result: unknown
  timestamp: number
  hitCount: number
  size: number  // approximate size in chars
}

const DISPLAY_ONLY_ARG_KEYS = new Set(['action_label', 'plan_step_index'])
const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
])

function normalizeCacheUrl(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    url.hash = ''
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase()
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase()
      if (lower.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(lower)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    return url.toString()
  } catch {
    return trimmed
  }
}

function normalizeSandboxCachePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/')
  const withoutLeadingSlash = trimmed.replace(/^\/+/, '')
  const parts: string[] = []

  for (const part of withoutLeadingSlash.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return trimmed
      parts.pop()
      continue
    }
    parts.push(part)
  }

  return parts.join('/')
}

function normalizedHttpMethod(args: Record<string, unknown>): string {
  return typeof args.method === 'string'
    ? args.method.trim().toUpperCase()
    : ''
}

function normalizedHttpHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null

  const normalized: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') return null
    const key = rawKey.trim().toLowerCase()
    if (!key) return null
    if (key === 'authorization' || key === 'cookie' || key === 'proxy-authorization') return null
    normalized[key] = rawValue.trim()
  }

  return Object.keys(normalized)
    .sort()
    .reduce((out, key) => {
      out[key] = normalized[key]
      return out
    }, {} as Record<string, string>)
}

function isCacheableHttpRequest(args: Record<string, unknown>): boolean {
  const method = normalizedHttpMethod(args)
  if (method !== 'GET' && method !== 'HEAD') return false
  if (args.body !== undefined && typeof args.body !== 'string') return false
  if (typeof args.body === 'string' && args.body.trim()) return false
  if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url.trim())) return false
  return normalizedHttpHeaders(args.headers) !== null
}

function isCacheableHttpResponse(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const response = result as Record<string, unknown>
  const status = Number(response.status)
  if (!Number.isInteger(status) || status < 200 || status >= 300) return false

  const headers = response.headers && typeof response.headers === 'object' && !Array.isArray(response.headers)
    ? response.headers as Record<string, unknown>
    : {}
  const cacheControl = typeof headers['cache-control'] === 'string'
    ? headers['cache-control'].toLowerCase()
    : ''
  const pragma = typeof headers.pragma === 'string' ? headers.pragma.toLowerCase() : ''

  return !/\b(?:no-store|no-cache|private)\b/.test(cacheControl) &&
    !/\bno-cache\b/.test(pragma)
}

// Tools that are safe to cache (idempotent, read-only)
const CACHEABLE_TOOLS = new Set([
  'web_search',
  'read_file',
  'list_files',
  'read_document',
  'youtube_transcript',
  'browser_get_content',
])

// Tools that are NEVER cached (have side effects)
const UNCACHEABLE_TOOLS = new Set([
  'create_file',
  'edit_file',
  'append_file',
  'export_pdf',
  'delete_file',
  'execute_command',
  'run_code',
  'browser_navigate',
  'browser_click',
  'browser_click_at',
  'browser_type',
  'browser_fill_form',
  'browser_scroll',
  'browser_find_text',
  'browser_hover',
  'browser_select',
  'browser_press_key',
  'browser_go_back',
  'browser_click_and_hold',
  'browser_drag',
  'browser_action_sequence',
  'image_search',
])

export class ToolCache {
  private cache: Map<string, CacheEntry> = new Map()
  private logger: Logger | null
  private maxEntries: number
  private ttlMs: number
  private maxTotalSize: number
  private currentSize = 0

  // Metrics
  private hits = 0
  private misses = 0

  constructor(opts?: {
    logger?: Logger
    maxEntries?: number
    ttlMs?: number
    maxTotalSizeChars?: number
  }) {
    this.logger = opts?.logger ?? null
    this.maxEntries = opts?.maxEntries ?? 100
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000  // 5 minutes default
    this.maxTotalSize = opts?.maxTotalSizeChars ?? 500_000  // ~500KB
  }

  /**
   * Check if a tool call can be served from cache.
   * Returns the cached result, or undefined if not cached.
   */
  get(toolName: string, args: Record<string, unknown>): unknown | undefined {
    if (!this.isCacheable(toolName, args)) return undefined

    const key = this.makeKey(toolName, args)
    const entry = this.cache.get(key)

    if (!entry) {
      this.misses++
      return undefined
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.evict(key)
      this.misses++
      return undefined
    }

    entry.hitCount++
    this.hits++
    this.logger?.debug(`Cache HIT: ${toolName}`, { key: key.slice(0, 60), hits: entry.hitCount })
    return entry.result
  }

  /**
   * Store a tool result in cache.
   */
  set(toolName: string, args: Record<string, unknown>, result: unknown): void {
    if (!this.isCacheable(toolName, args)) return

    // Don't cache errors
    if (result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
      return
    }
    if (toolName === 'http_request' && !isCacheableHttpResponse(result)) {
      return
    }

    const key = this.makeKey(toolName, args)
    const size = this.estimateSize(result)

    // If overwriting, subtract the old entry's size first so currentSize doesn't drift
    const existing = this.cache.get(key)
    if (existing) {
      this.currentSize = Math.max(0, this.currentSize - existing.size)
    }

    // Evict if needed
    while (this.cache.size >= this.maxEntries || this.currentSize + size > this.maxTotalSize) {
      if (!this.evictLRU()) break
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hitCount: 0,
      size,
    })
    this.currentSize += size

    this.logger?.debug(`Cache SET: ${toolName}`, { key: key.slice(0, 60), size })
  }

  /**
   * Invalidate cache entries for a tool.
   * Useful when a side-effect tool changes state that cached tools depend on.
   */
  invalidateForTool(toolName: string): void {
    const prefix = `${toolName}:`
    const keysToEvict: string[] = []
    for (const [key] of this.cache) {
      if (key.startsWith(prefix)) keysToEvict.push(key)
    }
    for (const key of keysToEvict) this.evict(key)
  }

  /**
   * Invalidate entries that might be affected by a file operation.
   */
  invalidateForFile(filePath: string): void {
    const normalizedFilePath = normalizeSandboxCachePath(filePath)
    const keysToEvict: string[] = []
    for (const [key] of this.cache) {
      if (key.includes(filePath) || (normalizedFilePath && key.includes(normalizedFilePath))) {
        keysToEvict.push(key)
      }
    }
    for (const key of keysToEvict) this.evict(key)
    // Also invalidate list_files since directory contents changed
    this.invalidateForTool('list_files')
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear()
    this.currentSize = 0
  }

  /**
   * Get cache statistics.
   */
  getStats(): { entries: number; hits: number; misses: number; hitRate: number; sizeChars: number } {
    const total = this.hits + this.misses
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      sizeChars: this.currentSize,
    }
  }

  /**
   * Check if a tool's results are safe to cache.
   */
  private isCacheable(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName === 'http_request') return isCacheableHttpRequest(args)
    if (UNCACHEABLE_TOOLS.has(toolName)) return false
    return CACHEABLE_TOOLS.has(toolName)
  }

  /**
   * Create a cache key from tool name + normalized args.
   */
  private makeKey(toolName: string, args: Record<string, unknown>): string {
    // Sort keys for consistent hashing
    const sortedArgs = Object.keys(args).sort().reduce((obj, key) => {
      if (DISPLAY_ONLY_ARG_KEYS.has(key)) return obj
      obj[key] = args[key]
      return obj
    }, {} as Record<string, unknown>)

    // Normalize search queries (lowercase, trim)
    if (toolName === 'web_search' && typeof sortedArgs.query === 'string') {
      sortedArgs.query = sortedArgs.query.toLowerCase().trim()
    }
    if (toolName === 'read_document' && typeof sortedArgs.source === 'string') {
      sortedArgs.source = normalizeCacheUrl(sortedArgs.source)
    }
    if (toolName === 'youtube_transcript' && typeof sortedArgs.url === 'string') {
      sortedArgs.url = normalizeCacheUrl(sortedArgs.url)
    }
    if (toolName === 'read_file' && typeof sortedArgs.path === 'string') {
      sortedArgs.path = normalizeSandboxCachePath(sortedArgs.path)
    }
    if (toolName === 'list_files' && typeof sortedArgs.directory === 'string') {
      sortedArgs.directory = normalizeSandboxCachePath(sortedArgs.directory)
    }
    if (toolName === 'http_request') {
      sortedArgs.method = normalizedHttpMethod(sortedArgs)
      if (typeof sortedArgs.url === 'string') {
        sortedArgs.url = normalizeCacheUrl(sortedArgs.url)
      }
      const headers = normalizedHttpHeaders(sortedArgs.headers)
      if (headers && Object.keys(headers).length > 0) {
        sortedArgs.headers = headers
      } else {
        delete sortedArgs.headers
      }
      delete sortedArgs.body
    }

    return `${toolName}:${JSON.stringify(sortedArgs)}`
  }

  /**
   * Evict a specific entry.
   */
  private evict(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      this.currentSize = Math.max(0, this.currentSize - entry.size)
      this.cache.delete(key)
    }
  }

  /**
   * Evict the least recently used entry (oldest with fewest hits).
   */
  private evictLRU(): boolean {
    if (this.cache.size === 0) return false

    let oldestKey: string | null = null
    let oldestScore = Infinity

    for (const [key, entry] of this.cache) {
      // Score = timestamp + (hitCount * ttlMs/10) — more hits = longer retention
      const score = entry.timestamp + (entry.hitCount * this.ttlMs / 10)
      if (score < oldestScore) {
        oldestScore = score
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.evict(oldestKey)
      return true
    }
    return false
  }

  /**
   * Estimate the memory size of a result in characters.
   */
  private estimateSize(result: unknown): number {
    try {
      return JSON.stringify(result).length
    } catch {
      return 1000  // default estimate
    }
  }
}
