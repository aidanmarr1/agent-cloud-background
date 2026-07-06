const QUERY_TEXT_KEYS = [
  'query',
  'q',
  'text',
  'topic',
  'search',
  'prompt',
  'term',
  'terms',
  'value',
]

function queryCandidate(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 3) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map(item => queryCandidate(item, depth + 1))
      .filter(Boolean)
      .join(' ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of QUERY_TEXT_KEYS) {
      const candidate = queryCandidate(record[key], depth + 1)
      if (candidate.trim()) return candidate
    }
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

export function normalizeSearchQuery(value: unknown, maxLength = 500): string {
  return queryCandidate(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[{}[\]"`<>|\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function simplifiedSearchQuery(value: unknown): string {
  return normalizeSearchQuery(value, 260)
    .replace(/[^a-zA-Z0-9 .,:;'"!?()[\]/&+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
