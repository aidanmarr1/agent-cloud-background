/**
 * JSON-safe serialization for messages with role="tool".
 *
 * Some providers validate tool message content as a JSON value before they
 * start a completion. Raw string slicing is therefore unsafe: it can cut an
 * escape (for example `\u1234`) or a surrogate pair and make the whole next
 * request fail with a deterministic HTTP 400.
 */

export interface ToolMessageSerializationOptions {
  maxChars: number
  truncated?: boolean
  note?: string
}

const DEFAULT_NOTE_MAX_CHARS = 240

/** Slice by UTF-16 code units without leaving an unpaired high surrogate. */
export function unicodeSafeSlice(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value

  let end = Math.min(value.length, Math.floor(maxChars))
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, Math.max(0, end))
}

/** Replace pre-existing lone surrogate code units with the Unicode replacement character. */
function sanitizeUnicodeScalars(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1]
        index++
      } else {
        output += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\ufffd'
    } else {
      output += value[index]
    }
  }
  return output
}

/**
 * Avoid ending a diagnostic JSON preview inside an escape sequence. The
 * preview is serialized again as a JSON string, but keeping it lexically
 * complete also makes logs and provider diagnostics unambiguous.
 */
function removePartialJsonEscapeSuffix(value: string): string {
  const unicodeTail = /u[0-9a-fA-F]{0,3}$/.exec(value)
  if (unicodeTail?.index !== undefined) {
    let slashStart = unicodeTail.index - 1
    while (slashStart >= 0 && value[slashStart] === '\\') slashStart--
    const slashCount = unicodeTail.index - 1 - slashStart
    if (slashCount % 2 === 1) return value.slice(0, slashStart + 1)
  }

  let trailingSlashes = 0
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index--) {
    trailingSlashes++
  }
  return trailingSlashes % 2 === 1 ? value.slice(0, -1) : value
}

function jsonStringifySafe(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return candidate.toString()
      if (typeof candidate === 'string') return sanitizeUnicodeScalars(candidate)
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]'
        seen.add(candidate)
      }
      return candidate
    })
    return serialized ?? 'null'
  } catch {
    return JSON.stringify({ error: 'Result could not be serialized' })
  }
}

function parseJsonOrPreview(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { result_preview: raw }
  }
}

function normalizedNote(note: string | undefined): string | undefined {
  const clean = note?.replace(/\s+/g, ' ').trim()
  return clean ? unicodeSafeSlice(clean, DEFAULT_NOTE_MAX_CHARS) : undefined
}

/**
 * Serialize a tool result as valid JSON within the requested character cap.
 * Oversized values become a JSON envelope containing a safe preview and
 * explicit truncation metadata; serialized JSON is never sliced directly.
 */
export function serializeToolMessageContent(
  value: unknown,
  options: ToolMessageSerializationOptions,
): string {
  const maxChars = Math.max(96, Math.floor(options.maxChars))
  const note = normalizedNote(options.note)
  const raw = jsonStringifySafe(value)
  const needsEnvelope = Boolean(options.truncated || note)
  const directValue = needsEnvelope
    ? {
        result: parseJsonOrPreview(raw),
        _meta: {
          truncated: Boolean(options.truncated),
          ...(note ? { note } : {}),
        },
      }
    : parseJsonOrPreview(raw)
  const direct = jsonStringifySafe(directValue)
  if (direct.length <= maxChars) return direct

  const meta = {
    truncated: true,
    original_characters: raw.length,
    ...(note ? { note } : {}),
  }

  let low = 0
  let high = Math.min(raw.length, maxChars)
  let best = jsonStringifySafe({ result_preview: '', _meta: meta })

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2)
    const preview = removePartialJsonEscapeSuffix(unicodeSafeSlice(raw, midpoint))
    const candidate = jsonStringifySafe({ result_preview: preview, _meta: meta })
    if (candidate.length <= maxChars) {
      best = candidate
      low = midpoint + 1
    } else {
      high = midpoint - 1
    }
  }

  // The production limits are comfortably above this envelope. Keep a valid
  // JSON fallback for defensive callers that provide an unusually tiny cap.
  if (best.length > maxChars) return JSON.stringify({ truncated: true })
  return best
}

/** Re-compact an existing role="tool" content string without breaking JSON. */
export function compactToolMessageContent(
  content: string,
  maxChars: number,
  note = 'Older tool result compacted.',
): string {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    value = { legacy_content: content }
  }
  return serializeToolMessageContent(value, {
    maxChars,
    truncated: content.length > maxChars,
    note,
  })
}

/**
 * Provider-boundary defense for historical rows created before JSON-safe tool
 * serialization. Already-valid JSON is returned byte-for-byte unchanged.
 */
export function ensureJsonToolMessageContent(content: string, maxChars = 1800): string {
  try {
    JSON.parse(content)
    return content
  } catch {
    return serializeToolMessageContent({ legacy_content: content }, {
      maxChars,
      truncated: content.length > maxChars,
      note: 'Recovered malformed historical tool result.',
    })
  }
}
