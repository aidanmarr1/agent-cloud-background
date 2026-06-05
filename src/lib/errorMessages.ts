const OBJECT_STRING = '[object Object]'

const ERROR_MESSAGE_KEYS = [
  'error',
  'message',
  'detail',
  'details',
  'reason',
  'description',
  'error_description',
  'title',
]

function cleanErrorString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === OBJECT_STRING) return null
  return trimmed
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function extractErrorMessage(value: unknown, seen: Set<object>): string | null {
  if (typeof value === 'string') return cleanErrorString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return cleanErrorString(String(value))

  if (value instanceof Error) {
    const message = cleanErrorString(value.message)
    if (message) return message
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractErrorMessage(item, seen)
      if (message) return message
    }
    return null
  }

  if (!isPlainRecord(value)) return null
  if (seen.has(value)) return null
  seen.add(value)

  for (const key of ERROR_MESSAGE_KEYS) {
    if (!(key in value)) continue
    const message = extractErrorMessage(value[key], seen)
    if (message) return message
  }

  return null
}

export function userErrorMessage(
  value: unknown,
  fallback = 'The task could not finish. Please try again.',
): string {
  return extractErrorMessage(value, new Set()) || fallback
}
