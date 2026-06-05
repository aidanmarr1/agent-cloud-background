import type { BrowserResult, BrowseResult, FileResult, SearchResult, TerminalResult } from '@/types'

interface ActivityContext {
  label?: string
  query?: string
  url?: string
  command?: string
  filePath?: string
}

const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/^(?:.+\.)?wikipedia\.org$/i, 'Wikipedia article'],
  [/^pmc\.ncbi\.nlm\.nih\.gov$/i, 'PMC article'],
  [/^(?:.+\.)?ncbi\.nlm\.nih\.gov$/i, 'NCBI source'],
  [/^(?:.+\.)?nature\.com$/i, 'Nature article'],
  [/^(?:.+\.)?reddit\.com$/i, 'Reddit discussion'],
  [/^(?:.+\.)?youtube\.com$/i, 'YouTube page'],
  [/^(?:.+\.)?github\.com$/i, 'GitHub source'],
  [/^(?:.+\.)?openrouter\.ai$/i, 'OpenRouter model page'],
  [/^(?:.+\.)?zoom\.earth$/i, 'ZoomEarth weather map'],
  [/^(?:localhost|127\.0\.0\.1)$/i, 'local app'],
]

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function ellipsize(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '') + '...'
}

function cleanQuotedText(text: string, max = 76): string {
  return ellipsize(
    text
      .replace(/["'“”‘’]/g, '')
      .replace(/[{}()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
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
  if (/^(?:searching|researching|reviewing|reading|navigating|scrolling|clicking|visiting|accessing|opening|checking|examining|investigating|analyzing|analysing|creating|editing|writing|appending|running|executing)\b/i.test(cleaned)) return null
  if (/^(?:search|research|review|read|navigate|scroll|click|visit|access|open|check|examine|investigate|analy[sz]e)\s+(?:for|to|the|more|article|page|source|result|content)\b/i.test(cleaned)) return null
  if (/^[a-z_]+(?:\.[a-z_]+)?$/i.test(cleaned)) return null

  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length < 4) return null
  return ellipsize(cleaned, 88)
}

function cleanSearchTopic(query: string): string {
  const decoded = decodeMaybe(query)
  const cleaned = decoded
    .replace(/\b(?:site|filetype|intitle|inurl):\S+/gi, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/[|+~]/g, ' ')
    .replace(/["'“”‘’]/g, '')
    .replace(/[{}()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return ellipsize(cleaned || decoded || query, 76)
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value).replace(/\+/g, ' ')
  } catch {
    return value.replace(/\+/g, ' ')
  }
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function searchTopicFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const query = u.searchParams.get('q') ||
      u.searchParams.get('query') ||
      u.searchParams.get('search') ||
      u.searchParams.get('searchTerm') ||
      u.searchParams.get('term')
    return query ? cleanSearchTopic(query) : null
  } catch {
    return null
  }
}

function sourceLabelFromHost(host: string | null): string {
  if (!host) return 'source page'
  const mapped = SOURCE_LABELS.find(([pattern]) => pattern.test(host))
  if (mapped) return mapped[1]

  const parts = host.split('.').filter(Boolean)
  const brand = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || host
  const readableBrand = brand
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
  return `${readableBrand || host} source`
}

function sourceLabel(url?: string): string {
  return sourceLabelFromHost(url ? hostFromUrl(url) : null)
}

function cleanPageTitle(title?: string): string {
  if (!title) return ''
  const cleaned = title
    .replace(/\s*[-|]\s*(?:Wikipedia|Reddit|YouTube|GitHub|OpenRouter|Zoom Earth|ZoomEarth).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleanQuotedText(cleaned, 82)
}

function pathTopicFromUrl(url?: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    const segments = u.pathname.split('/').filter(Boolean)
    const lastMeaningful = [...segments].reverse().find((segment) =>
      segment.length > 2 &&
      !/^(?:search|results?|page|app|api|\d+)$/.test(segment)
    )
    if (!lastMeaningful) return ''
    return cleanQuotedText(decodeMaybe(lastMeaningful).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '), 64)
  } catch {
    return ''
  }
}

function articleForSource(label: string): string {
  return label === 'local app' ? 'the local app' : `the ${label}`
}

function describeSourceReview(url?: string, title?: string, verb = 'Review'): string {
  const source = sourceLabel(url)
  const pageTitle = cleanPageTitle(title)
  const pathTopic = pathTopicFromUrl(url)
  const topic = pageTitle || pathTopic

  if (topic && !topic.toLowerCase().includes(source.replace(/\s+source$/i, '').toLowerCase())) {
    return `${verb} ${articleForSource(source)} on ${topic}`
  }
  return `${verb} ${articleForSource(source)} for source context`
}

function describeClickTarget(args: Record<string, unknown>): string {
  const selector = asString(args.selector)
  const label = asString(args.label) || asString(args.text) || asString(args.name)
  if (label) return `Select ${cleanQuotedText(label, 58)}`
  if (selector.startsWith('text=')) return `Select ${cleanQuotedText(selector.slice(5), 58)}`
  if (/button|role=button|\[type=["']?submit/i.test(selector)) return 'Select the relevant page action'
  if (/a\[|role=link|href=/i.test(selector)) return 'Open the relevant page link'
  if (typeof args.index === 'number') return 'Use the selected page control'
  return 'Use the relevant page control'
}

function describeFields(args: Record<string, unknown>): string {
  const fields = Array.isArray(args.fields) ? args.fields as Array<Record<string, unknown>> : []
  const labels = fields
    .map((field) => asString(field.label) || asString(field.name))
    .filter(Boolean)
    .slice(0, 3)
  if (labels.length > 0) return `Fill ${labels.map((label) => cleanQuotedText(label, 24)).join(', ')}`
  return 'Fill the visible form fields'
}

function fileName(path?: string): string {
  return path?.split('/').pop() || 'file'
}

export function describeActivity(toolName: string, args: Record<string, unknown>): string {
  const modelLabel = strictActionLabelFromArgs(args)
  if (modelLabel) return modelLabel

  switch (toolName) {
    case 'web_search': {
      const query = cleanSearchTopic(asString(args.query))
      return query ? `Search for information on ${query}` : 'Search the web for relevant sources'
    }
    case 'image_search': {
      const query = cleanSearchTopic(asString(args.query))
      return query ? `Find image sources for ${query}` : 'Find relevant image sources'
    }
    case 'browse_page': {
      return describeSourceReview(asString(args.url), undefined, 'Review')
    }
    case 'browser_navigate': {
      const url = asString(args.url)
      const topic = searchTopicFromUrl(url)
      if (topic) return `Open search results for ${topic}`
      return describeSourceReview(url, undefined, 'Access')
    }
    case 'browser_resize':
      return 'Skipping viewport resize'
    case 'browser_click':
    case 'browser_click_at': {
      return describeClickTarget(args)
    }
    case 'browser_type': {
      const text = cleanQuotedText(asString(args.text), 44)
      const selector = asString(args.selector)
      const field = asString(args.label) || asString(args.name) || (selector.startsWith('text=') ? selector.slice(5) : '')
      if (text && args.submit) return `Enter ${text} and submit`
      if (text && field) return `Enter ${text} in ${cleanQuotedText(field, 28)}`
      if (text) return `Enter ${text} into the active field`
      return 'Enter text into the active field'
    }
    case 'browser_fill_form':
      return describeFields(args)
    case 'browser_scroll':
      return args.direction === 'up' ? 'Review earlier page content' : 'Review more page content'
    case 'browser_screenshot':
      return args.fullPage ? 'Inspecting full page' : 'Inspecting page'
    case 'browser_get_content':
      return 'Read the current page content'
    case 'browser_find_text': {
      const query = cleanQuotedText(asString(args.query), 58)
      return query ? `Find ${query} on the page` : 'Find matching text on the page'
    }
    case 'browser_hover':
      return 'Reveal additional page details'
    case 'browser_select': {
      const value = cleanQuotedText(asString(args.value), 44)
      return value ? `Choose ${value}` : 'Choose the relevant option'
    }
    case 'browser_press_key':
      return args.key ? `Use the ${String(args.key)} key` : 'Use a keyboard action'
    case 'browser_go_back':
      return 'Return to the previous page'
    case 'browser_click_and_hold': {
      const duration = (args.duration as number) || 2000
      return `Hold the selected control for ${(duration / 1000).toFixed(1)}s`
    }
    case 'browser_drag':
      return 'Move the selected page control'
    case 'browser_action_sequence':
      return 'Complete the next page interaction sequence'
    case 'execute_command': {
      const cmd = asString(args.command)
      // Show the actual command but sanitize long ones
      if (cmd.startsWith('pip install') || cmd.startsWith('npm install')) {
        return `Install project dependencies`
      }
      if (cmd.startsWith('cd ')) {
        return `Change workspace directory`
      }
      return cmd ? `Run ${ellipsize(cmd, 64)}` : 'Run a shell command'
    }
    case 'create_file': {
      const path = asString(args.path)
      const name = fileName(path)
      const content = asString(args.content)
      const streamedLines = typeof args.contentLineCount === 'number' ? args.contentLineCount : 0
      if (!content && streamedLines <= 0) return `Create ${name}`
      const lines = streamedLines || content.split('\n').length
      return `Create ${name} (${lines} lines)`
    }
    case 'edit_file': {
      const path = asString(args.path)
      return `Update ${fileName(path)}`
    }
    case 'append_file': {
      const path = asString(args.path)
      const name = fileName(path)
      const content = asString(args.content)
      const streamedLines = typeof args.contentLineCount === 'number' ? args.contentLineCount : 0
      if (!content && streamedLines <= 0) return `Append to ${name}`
      const lines = streamedLines || content.split('\n').length
      return `Append to ${name} (${lines} lines)`
    }
    case 'export_pdf': {
      const path = asString(args.output_path) || asString(args.source_path)
      const name = path ? fileName(path).replace(/\.[^.]+$/, '.pdf') : 'document.pdf'
      return `Export ${name}`
    }
    case 'read_file': {
      const path = asString(args.path)
      return `Read ${fileName(path)}`
    }
    case 'read_skill': {
      const path = asString(args.path)
      const name = asString(args.name) || (path ? fileName(path) : 'selected skill')
      const skillName = /\bskill\b/i.test(name) ? name : `${name} skill`
      return `Read the ${skillName} guidance`
    }
    case 'delete_file': {
      const path = asString(args.path)
      return `Delete ${fileName(path)}`
    }
    case 'list_files': {
      const dir = asString(args.directory) || asString(args.path)
      return dir ? `List files in ${ellipsize(dir, 54)}` : 'List workspace files'
    }
    case 'run_code': {
      const lang = asString(args.language) || 'code'
      const code = asString(args.code)
      const streamedLines = typeof args.codeLineCount === 'number' ? args.codeLineCount : 0
      if (!code && streamedLines <= 0) return `Run the ${lang} snippet`
      const lines = streamedLines || code.split('\n').length
      return `Run the ${lang} snippet (${lines} lines)`
    }
    case 'youtube_transcript': {
      const url = asString(args.url)
      return url ? describeSourceReview(url, undefined, 'Extract transcript from') : 'Extract the YouTube transcript'
    }
    case 'read_document': {
      const source = asString(args.source) || asString(args.url)
      return source ? describeSourceReview(source, undefined, 'Read document from') : 'Read the document content'
    }
    case 'http_request': {
      const method = (asString(args.method) || 'GET').toUpperCase()
      const url = asString(args.url)
      if (method === 'GET' || method === 'HEAD') return describeSourceReview(url, undefined, 'Fetch')
      return describeSourceReview(url, undefined, 'Contact')
    }
    default:
      return `Use ${toolName.replace(/^browser_/, 'browser ').replace(/_/g, ' ')}`
  }
}

export function describeCompletedActivity(
  toolName: string,
  result: unknown,
  context: ActivityContext = {},
): string | null {
  if (toolName === 'web_search') {
    const query = cleanSearchTopic(context.query || '')
    const results = Array.isArray(result) ? result as SearchResult[] : []
    if (query) return `Review search results for ${query}`
    if (results.length > 0) return `Review ${results.length} search result${results.length === 1 ? '' : 's'}`
    return null
  }

  if (toolName === 'image_search') {
    const query = cleanSearchTopic(context.query || '')
    return query ? `Review image results for ${query}` : 'Review image search results'
  }

  if (toolName === 'browse_page' || toolName === 'browser_navigate' || toolName === 'browser_get_content') {
    const br = result as Partial<BrowseResult & BrowserResult> | undefined
    if (!br || br.error || br.success === false) return null
    return describeSourceReview(br.url || context.url, br.title, toolName === 'browser_navigate' ? 'Access' : 'Review')
  }

  if (toolName === 'read_document' || toolName === 'http_request' || toolName === 'youtube_transcript') {
    const br = result as Partial<BrowseResult> | undefined
    return describeSourceReview(br?.url || context.url, br?.title, toolName === 'http_request' ? 'Fetch' : 'Review')
  }

  if (toolName === 'execute_command') {
    const tr = result as TerminalResult | undefined
    if (tr?.exitCode === 0) return context.command ? `Finish ${ellipsize(context.command, 64)}` : 'Finish the shell command'
    return null
  }

  if (['create_file', 'edit_file', 'append_file', 'export_pdf', 'read_file', 'delete_file', 'list_files'].includes(toolName)) {
    const fr = result as Partial<FileResult> | undefined
    if (!fr?.path && !context.filePath) return null
    const path = fr?.path || context.filePath
    return toolName === 'export_pdf'
      ? describeActivity(toolName, { output_path: path })
      : describeActivity(toolName, { path })
  }

  return null
}
