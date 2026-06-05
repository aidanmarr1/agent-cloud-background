interface AnsiSegment {
  text: string
  className: string
}

const ANSI_COLORS: Record<number, string> = {
  30: 'text-text-primary',    // black
  31: 'text-accent-red',       // red
  32: 'text-text-secondary',     // green
  33: 'text-text-secondary',    // yellow
  34: 'text-accent-blue',      // blue
  35: 'text-text-secondary',    // magenta
  36: 'text-accent-blue',      // cyan (using blue)
  37: 'text-text-secondary',   // white
  90: 'text-text-muted',       // bright black
  91: 'text-accent-red',       // bright red
  92: 'text-text-secondary',     // bright green
  93: 'text-text-secondary',    // bright yellow
  94: 'text-accent-blue',      // bright blue
  95: 'text-text-secondary',    // bright magenta
  96: 'text-accent-blue',      // bright cyan
  97: 'text-text-primary',     // bright white
}

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const regex = /\x1b\[([0-9;]*)m/g
  let lastIndex = 0
  let currentClasses: string[] = []
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Push text before this escape
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), className: currentClasses.join(' ') })
    }

    // Parse codes
    const codes = match[1].split(';').map(Number)
    for (const code of codes) {
      if (code === 0) {
        currentClasses = []
      } else if (code === 1) {
        currentClasses.push('font-bold')
      } else if (code === 3) {
        // Ignore ANSI italic styling so terminal output stays visually consistent.
      } else if (code === 4) {
        currentClasses.push('underline')
      } else if (ANSI_COLORS[code]) {
        // Remove any existing color class
        currentClasses = currentClasses.filter(c => !c.startsWith('text-'))
        currentClasses.push(ANSI_COLORS[code])
      }
    }

    lastIndex = match.index + match[0].length
  }

  // Push remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), className: currentClasses.join(' ') })
  }

  return segments.length > 0 ? segments : [{ text, className: '' }]
}
