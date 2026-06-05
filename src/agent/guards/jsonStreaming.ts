export function unescapeJsonChunk(
  raw: string,
  prevEscaped: boolean,
  partialEscape?: string,
): { text: string; finished: boolean; pendingEscape: boolean; partialEscape?: string } {
  let result = ''
  let i = 0
  let escaped = prevEscaped

  // If we have a buffered partial escape sequence (e.g., 'u00' from a split \u0041),
  // reconstruct it by prepending the backslash + partial to the raw input
  if (partialEscape && partialEscape.length > 0) {
    raw = partialEscape + raw
    escaped = true
  }

  if (escaped && raw.length > 0) {
    switch (raw[0]) {
      case 'n': result += '\n'; break
      case 't': result += '\t'; break
      case 'r': result += '\r'; break
      case '"': result += '"'; break
      case '\\': result += '\\'; break
      case '/': result += '/'; break
      case 'u':
        if (raw.length >= 5) {
          const code = parseInt(raw.slice(1, 5), 16)
          if (!isNaN(code)) result += String.fromCharCode(code)
          i = 5
        } else {
          // Not enough chars for \uXXXX — buffer the partial sequence for next chunk
          return { text: result, finished: false, pendingEscape: false, partialEscape: raw.slice(0) }
        }
        break
      default: result += raw[0]
    }
    if (i === 0) i = 1
    escaped = false
  }

  for (; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) {
      switch (ch) {
        case 'n': result += '\n'; break
        case 't': result += '\t'; break
        case 'r': result += '\r'; break
        case '"': result += '"'; break
        case '\\': result += '\\'; break
        case '/': result += '/'; break
        case 'u':
          if (i + 4 < raw.length) {
            const code = parseInt(raw.slice(i + 1, i + 5), 16)
            if (!isNaN(code)) result += String.fromCharCode(code)
            i += 4
          } else {
            // Partial \uXXXX at end of chunk — buffer for next call
            escaped = false
            return { text: result, finished: false, pendingEscape: false, partialEscape: raw.slice(i) }
          }
          break
        default: result += ch
      }
      escaped = false
      continue
    }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { return { text: result, finished: true, pendingEscape: false } }
    result += ch
  }
  return { text: result, finished: false, pendingEscape: escaped }
}
