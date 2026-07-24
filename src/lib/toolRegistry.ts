/**
 * Declarative tool registry — replaces the giant switch statement in tools.ts.
 * Each tool declares its required args, optional args, whether it needs a conversation,
 * and its handler function.
 */

import { webSearch } from './search'
import { imageSearch, downloadImagesToSandbox } from './imageSearch'
import {
  createFileInSandbox,
  readFileInSandbox,
  deleteFileInSandbox,
  listFilesInSandbox,
  editFileInSandbox,
  appendFileInSandbox,
  executeInSandbox,
  isCloudSandboxProviderEnabled,
} from './sandbox'
import { readDocument } from './document'
import { makeHttpRequest } from './httpRequest'
import {
  browserNavigate, browserClick, browserType, browserScreenshot,
  browserGetContent, browserScroll, browserHover, browserSelect,
  browserPressKey, browserGoBack, browserClickAndHold, browserDrag,
  browserClickAt, browserActionSequence, browserFillForm, browserFindText,
  normalizeBrowserScrollArgs,
  type BrowserFormFillField,
  type BrowserSequenceAction,
} from './browser'
import type { ToolContext } from './tools'

interface ToolRegistration {
  /** Required string arguments */
  required?: string[]
  /** At least one non-empty string argument from this list is required. */
  requiredOneOf?: string[]
  /** Whether the tool needs conversationId */
  needsConversation?: boolean
  /** The handler */
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

const registry = new Map<string, ToolRegistration>()
const DISABLED_LOCAL_PROCESS_TOOLS = new Set(['execute_command', 'run_code'])

function register(name: string, reg: ToolRegistration) {
  registry.set(name, reg)
}

// --- Search & Browse ---

register('web_search', {
  required: ['query'],
  execute: async (args, ctx) => webSearch(args.query as string, ctx.signal),
})

register('image_search', {
  required: ['query'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const results = await imageSearch(args.query as string, 8, ctx.signal)
    if (results.length === 0) {
      return { downloaded: [], failed: [], message: 'No images found for this query.' }
    }
    const dl = await downloadImagesToSandbox(ctx.conversationId!, results, ctx.signal)
    return {
      downloaded: dl.downloaded,
      failed: dl.failed,
      images: results,
      conversationId: ctx.conversationId,
      message: `Downloaded ${dl.downloaded.length} image(s) to downloads/ directory.${dl.failed.length > 0 ? ` ${dl.failed.length} failed.` : ''}`,
    }
  },
})

// --- Sandbox / File ops ---

register('create_file', {
  required: ['path', 'content'],
  needsConversation: true,
  execute: async (args, ctx) => {
    // Normalize path: strip leading /, ./, and collapse ..
    let path = (args.path as string).replace(/^\.?\/+/, '').replace(/\/+/g, '/')
    if (!path) path = 'output.md'
    return createFileInSandbox(ctx.conversationId!, path, args.content as string)
  },
})

register('read_file', {
  required: ['path'],
  needsConversation: true,
  execute: async (args, ctx) => readFileInSandbox(ctx.conversationId!, args.path as string),
})

register('delete_file', {
  required: ['path'],
  needsConversation: true,
  execute: async (args, ctx) => deleteFileInSandbox(ctx.conversationId!, args.path as string),
})

register('list_files', {
  needsConversation: true,
  execute: async (args, ctx) => listFilesInSandbox(ctx.conversationId!, String(args.directory || '')),
})

register('edit_file', {
  required: ['path'],
  needsConversation: true,
  execute: async (args, ctx) => {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
      return { error: 'Missing required arguments: old_string and new_string' }
    }
    return editFileInSandbox(ctx.conversationId!, args.path as string, args.old_string, args.new_string)
  },
})

register('append_file', {
  required: ['path', 'content'],
  needsConversation: true,
  execute: async (args, ctx) => {
    let path = (args.path as string).replace(/^\.?\/+/, '').replace(/\/+/g, '/')
    if (!path) path = 'output.md'
    return appendFileInSandbox(ctx.conversationId!, path, args.content as string)
  },
})

register('export_pdf', {
  required: ['source_path'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const sourcePath = String(args.source_path || '')
    const outputPath = typeof args.output_path === 'string' ? args.output_path : undefined
    const title = typeof args.title === 'string' ? args.title : undefined
    const { exportPdfFromSandbox } = await import('./pdfExport')
    return exportPdfFromSandbox(ctx.conversationId!, sourcePath, outputPath, title)
  },
})

register('execute_command', {
  required: ['command'],
  needsConversation: true,
  execute: async (args, ctx) =>
    executeInSandbox(ctx.conversationId!, args.command as string, ctx.onTerminalOutput, ctx.signal),
})

// --- Media & Docs ---

register('read_document', {
  // `url` is the model-visible canonical argument. `source` remains accepted
  // for already-running tasks whose earlier context contains the old schema.
  requiredOneOf: ['url', 'source'],
  execute: async (args, ctx) => {
    const target = typeof args.url === 'string' && args.url.trim()
      ? args.url
      : args.source as string
    return readDocument(target, ctx.conversationId, ctx.signal)
  },
})

register('http_request', {
  required: ['method', 'url'],
  execute: async (args, ctx) =>
    makeHttpRequest(
      args.method as string,
      args.url as string,
      args.headers as Record<string, string> | undefined,
      args.body as string | undefined,
      ctx.signal,
    ),
})

// --- Browser ---

// Backward-compatible hidden alias. Older prompts/state may still mention
// browse_page; keep it executable so stale context does not waste a turn on
// "Unknown tool", while new tool definitions steer the model to browser_navigate.
register('browse_page', {
  required: ['url'],
  needsConversation: true,
  execute: async (args, ctx) => browserNavigate(ctx.conversationId!, args.url as string),
})

register('browser_navigate', {
  required: ['url'],
  needsConversation: true,
  execute: async (args, ctx) => browserNavigate(ctx.conversationId!, args.url as string),
})

register('browser_click', {
  needsConversation: true,
  execute: async (args, ctx) => {
    const idx = typeof args.index === 'number' && Number.isInteger(args.index) ? args.index : undefined
    const sel = typeof args.selector === 'string' ? args.selector : undefined
    if (idx !== undefined) {
      return browserClickAt(ctx.conversationId!, undefined, undefined, idx)
    }
    if (sel) {
      return browserClick(ctx.conversationId!, sel)
    }
    return { error: 'Missing required argument: pass either {index: N} from the latest elements list or {selector: "..."}' }
  },
})

register('browser_click_at', {
  needsConversation: true,
  execute: async (args, ctx) => {
    const idx = typeof args.index === 'number' ? args.index : undefined
    if (idx === undefined) {
      return { error: 'browser_click_at requires {index: N} from the latest interactive elements list. Raw coordinates are disabled for autonomous clicks; refresh/reveal the target with browser_screenshot, browser_scroll, browser_find_text, or browser_get_content.' }
    }
    return browserClickAt(ctx.conversationId!, undefined, undefined, idx)
  },
})

register('browser_type', {
  required: ['text'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const idx = typeof args.index === 'number' ? args.index : undefined
    const sel = typeof args.selector === 'string' ? args.selector : undefined
    if (idx === undefined && !sel) {
      return { error: 'Missing required argument: pass either {index: N} from the latest elements list or {selector: "..."}' }
    }
    return browserType(ctx.conversationId!, sel, args.text as string, !!args.submit, idx)
  },
})

register('browser_fill_form', {
  required: ['fields'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const rawFields = args.fields
    if (!Array.isArray(rawFields)) {
      return { error: 'browser_fill_form requires a fields array' }
    }
    const fields = rawFields
      .filter((field): field is Record<string, unknown> => !!field && typeof field === 'object')
      .map((field): BrowserFormFillField => ({
        label: typeof field.label === 'string' ? field.label : undefined,
        index: typeof field.index === 'number' ? field.index : undefined,
        value: typeof field.value === 'string' || typeof field.value === 'number' || typeof field.value === 'boolean'
          ? field.value
          : '',
      }))

    return browserFillForm(
      ctx.conversationId!,
      fields,
      !!args.submit,
      typeof args.submitLabel === 'string' ? args.submitLabel : undefined,
    )
  },
})

register('browser_screenshot', {
  needsConversation: true,
  execute: async (args, ctx) => browserScreenshot(ctx.conversationId!, !!args.fullPage),
})

register('browser_get_content', {
  needsConversation: true,
  execute: async (_args, ctx) => browserGetContent(ctx.conversationId!),
})

register('browser_scroll', {
  needsConversation: true,
  execute: async (args, ctx) => {
    const { direction, amount } = normalizeBrowserScrollArgs(args)
    return browserScroll(ctx.conversationId!, direction, amount)
  },
})

register('browser_find_text', {
  required: ['query'],
  needsConversation: true,
  execute: async (args, ctx) => browserFindText(ctx.conversationId!, args.query as string),
})

register('browser_hover', {
  needsConversation: true,
  execute: async (args, ctx) => {
    const idx = typeof args.index === 'number' ? args.index : undefined
    const sel = typeof args.selector === 'string' ? args.selector : undefined
    if (idx === undefined && !sel) {
      return { error: 'Missing required argument: pass either {index: N} from the latest elements list or {selector: "..."}' }
    }
    return browserHover(ctx.conversationId!, sel, idx)
  },
})

register('browser_select', {
  required: ['value'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const idx = typeof args.index === 'number' ? args.index : undefined
    const sel = typeof args.selector === 'string' ? args.selector : undefined
    if (idx === undefined && !sel) {
      return { error: 'Missing required argument: pass either {index: N} from the latest elements list or {selector: "..."}' }
    }
    return browserSelect(ctx.conversationId!, sel, args.value as string, idx)
  },
})

register('browser_press_key', {
  required: ['key'],
  needsConversation: true,
  execute: async (args, ctx) => browserPressKey(ctx.conversationId!, args.key as string),
})

register('browser_go_back', {
  needsConversation: true,
  execute: async (_args, ctx) => browserGoBack(ctx.conversationId!),
})

register('browser_click_and_hold', {
  required: ['selector'],
  needsConversation: true,
  execute: async (args, ctx) => browserClickAndHold(ctx.conversationId!, args.selector as string, args.duration as number | undefined),
})

register('browser_drag', {
  required: ['from_selector', 'to_selector'],
  needsConversation: true,
  execute: async (args, ctx) => browserDrag(ctx.conversationId!, args.from_selector as string, args.to_selector as string),
})

register('browser_action_sequence', {
  required: ['actions'],
  needsConversation: true,
  execute: async (args, ctx) => {
    const raw = args.actions
    if (!Array.isArray(raw)) {
      return { error: 'browser_action_sequence requires an actions array' }
    }
    // Coerce to BrowserSequenceAction shape — handler validates per-action
    const actions = raw as BrowserSequenceAction[]
    return browserActionSequence(ctx.conversationId!, actions)
  },
})

// --- Execution engine ---

export async function executeToolFromRegistry(
  name: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<unknown> {
  if (DISABLED_LOCAL_PROCESS_TOOLS.has(name) && !isCloudSandboxProviderEnabled()) {
    return {
      error: `Tool "${name}" is disabled because this app does not provide an OS-level execution sandbox.`,
    }
  }

  const reg = registry.get(name)
  if (!reg) return { error: `Unknown tool: ${name}` }

  // Validate required string args
  if (reg.required) {
    for (const field of reg.required) {
      const val = args[field]
      if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
        return { error: `Missing required argument: ${field}` }
      }
    }
  }
  if (reg.requiredOneOf) {
    const hasValue = reg.requiredOneOf.some(field => {
      const value = args[field]
      return typeof value === 'string' && value.trim().length > 0
    })
    if (!hasValue) {
      return { error: `Missing required argument: ${reg.requiredOneOf[0]}` }
    }
  }

  // Validate task context
  if (reg.needsConversation && !context?.conversationId) {
    return { error: 'Missing task context' }
  }

  try {
    if (context?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const result = await reg.execute(args, context || {})
    if (context?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    return result
  } catch (err) {
    if (context?.signal?.aborted || (err as { name?: string })?.name === 'AbortError') throw err
    console.error(`[ToolRegistry] Unhandled error in tool "${name}":`, err)
    return { error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
