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
    .replace(/\.+$/g, '')
    .trim()
  if (!cleaned) return ''

  return cleaned.replace(/^([^A-Za-z]*)([a-z])/, (_match, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`
  )
}

export function strictActionLabelFromArgs(args: Record<string, unknown>): string | null {
  const raw = asString(args.action_label)
  if (!raw) return null

  const cleaned = raw
    .replace(/["'“”‘’]/g, '')
    .replace(/[{}()[\]]/g, ' ')
    .replace(/\b(?:browser_|web_search|image_search|create_file|edit_file|append_file|read_file|read_document|http_request|execute_command|run_code)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return null
  if (/\b(i(?:'|’)?ll|i will|i(?:'|’)?m|i am|let me|we(?:'|’)?ll|we will)\b/i.test(cleaned)) return null
  if (/\b(?:use the tool|call the tool|run tool|current step|next step|do task|continue task|handle request)\b/i.test(cleaned)) return null
  if (/^(?:reviewed|completed|found|gathered|confirmed|created|built|generated|wrote|saved|opened|loaded|searched|verified|tracked|extracted|analy[sz]ed|checked|compared|mapped|inspected|collected)\b/i.test(cleaned)) return null
  if (/^(?:searching|researching|reviewing|reading|navigating|scrolling|clicking|visiting|accessing|opening|checking|examining|investigating|analyzing|analysing|creating|editing|writing|appending|running|executing)\b/i.test(cleaned)) return null
  if (/^[a-z_]+(?:\.[a-z_]+)?$/i.test(cleaned)) return null

  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  return formatVisibleActionLabel(ellipsize(cleaned, 88))
}

function compactTargetWords(value: string, fallback: string, maxWords = 6): string {
  const cleaned = value
    .replace(/^https?:\/\//i, ' ')
    .replace(/\bwww\./gi, ' ')
    .replace(/[_/?#=&.:+-]+/g, ' ')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  return (words.slice(0, maxWords).join(' ') || fallback).trim()
}

function targetFromUrl(value: string): string {
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`)
    const host = url.hostname.replace(/^www\./i, '')
    const domain = host.split('.').slice(0, -1).join(' ') || host
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join(' ')
    return compactTargetWords(`${domain} ${path}`, 'source', 5)
  } catch {
    return compactTargetWords(value, 'source', 5)
  }
}

function targetFromPath(value: string): string {
  const fileName = value.split(/[\\/]/).pop() || value
  return compactTargetWords(fileName.replace(/\.[^.]+$/, ''), 'file', 5)
}

function firstStringArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function runtimeVisibleActionLabel(
  toolName: string,
  args: Record<string, unknown>,
  fallback = 'Continue active step',
): string {
  const query = firstStringArg(args, ['query', 'text'])
  const url = firstStringArg(args, ['url', 'source'])
  const path = firstStringArg(args, ['path', 'source_path', 'output_path'])
  const command = firstStringArg(args, ['command', 'language'])
  const queryTarget = compactTargetWords(query, fallback, 7)
  const sourceTarget = url ? targetFromUrl(url) : compactTargetWords(firstStringArg(args, ['source']), fallback, 5)
  const fileTarget = path ? targetFromPath(path) : compactTargetWords(firstStringArg(args, ['title']), fallback, 5)
  const commandTarget = compactTargetWords(command, 'verification command', 5)

  const candidate = (() => {
    switch (toolName) {
      case 'web_search':
        return `Search ${queryTarget}`
      case 'image_search':
        return `Find images for ${queryTarget}`
      case 'read_document':
      case 'http_request':
      case 'youtube_transcript':
        return `Read ${sourceTarget} evidence`
      case 'browser_navigate':
      case 'browse_page':
        return `Open ${sourceTarget} page`
      case 'browser_get_content':
        return 'Inspect current page'
      case 'browser_find_text':
        return `Find ${queryTarget} on page`
      case 'browser_scroll':
        return 'Scroll current page'
      case 'browser_screenshot':
        return 'Capture page view'
      case 'browser_click':
      case 'browser_click_at':
      case 'browser_hover':
      case 'browser_press_key':
      case 'browser_select':
      case 'browser_type':
      case 'browser_fill_form':
      case 'browser_action_sequence':
        return 'Use page control'
      case 'create_file':
        return `Write ${fileTarget}`
      case 'append_file':
        return `Continue ${fileTarget}`
      case 'edit_file':
        return `Edit ${fileTarget}`
      case 'read_file':
        return `Inspect ${fileTarget}`
      case 'list_files':
        return 'List project files'
      case 'export_pdf':
        return `Export ${fileTarget} PDF`
      case 'execute_command':
        return `Run ${commandTarget}`
      case 'run_code':
        return 'Run code check'
      default:
        return fallback
    }
  })()

  return strictActionLabelFromArgs({ action_label: candidate }) || formatVisibleActionLabel(candidate)
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
