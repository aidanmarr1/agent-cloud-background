interface ActivityContext {
  label?: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function ellipsize(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '') + '...'
}

export function formatVisibleActionLabel(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,.…]+$/g, '')
    .trim()
  if (!cleaned) return ''

  return cleaned.replace(/^([^A-Za-z]*)([a-z])/, (_match, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`
  )
}

export function strictActionLabelFromArgs(args: Record<string, unknown>): string | null {
  const raw = asString(args.action_label)
  if (!raw) return null

  const cleaned = formatVisibleActionLabel(raw
    .replace(/["'“”‘’]/g, '')
    .replace(/[{}()[\]]/g, ' ')
    .replace(/\b(?:browser_|web_search|image_search|create_file|create_website|package_files|edit_file|append_file|read_file|read_document|http_request|execute_command|run_code)\b/gi, ' ')
    .replace(/^\s*(?:\d+\s*[.)]\s*)?[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .trim())

  if (!cleaned) return null
  if (!/^[A-Z]/.test(cleaned)) return null
  if (/\b(i(?:'|’)?ll|i will|i(?:'|’)?m|i am|let me|we(?:'|’)?ll|we will)\b/i.test(cleaned)) return null
  if (/\b(?:use the tool|call the tool|run tool|current step|next step|do task|continue task|handle request)\b/i.test(cleaned)) return null
  if (/^(?:reviewed|completed|found|gathered|confirmed|created|built|generated|wrote|saved|opened|loaded|searched|verified|tracked|extracted|analy[sz]ed|checked|compared|mapped|inspected|collected)\b/i.test(cleaned)) return null
  if (/^(?:searching|researching|reviewing|reading|navigating|scrolling|clicking|visiting|accessing|opening|checking|examining|investigating|analyzing|analysing|creating|editing|writing|appending|running|executing)\b/i.test(cleaned)) return null
  if (/^(?:find|read|open|review|inspect|check|extract|locate|search)\s+(?:the\s+)?(?:page|article|source|site|website|details?|information|content|data|results?)$/i.test(cleaned)) return null
  const words = cleaned.split(/\s+/).filter(Boolean)
  const bareSourceSurface = /^(?:open|read|review|inspect)\b.+\b(?:page|article|source|site|website)$/i.test(cleaned) &&
    words.length <= 7 &&
    !/\b(?:and|against|confirming|covering|detailing|documented|explaining|for|from|on|showing|to|verifying)\b/i.test(cleaned)
  if (bareSourceSurface) return null
  if (/\b(?:details?|information|content)\s+(?:on|from|in)\s+(?:the\s+)?(?:page|article|site|source|website)$/i.test(cleaned)) return null
  if (/^[a-z_]+(?:\.[a-z_]+)?$/i.test(cleaned)) return null

  if (words.length < 2) return null
  return formatVisibleActionLabel(ellipsize(cleaned, 160))
}

export function describeActivity(toolName: string, args: Record<string, unknown>): string {
  void toolName
  return strictActionLabelFromArgs(args) || ''
}

export function describeCompletedActivity(
  toolName: string,
  result: unknown,
  context: ActivityContext = {},
): string | null {
  void toolName
  void result
  return context.label || null
}
