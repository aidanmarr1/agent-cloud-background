type ModelToolDefinition = {
  function?: {
    name?: string
    description?: string
    parameters?: unknown
    [key: string]: unknown
  }
  [key: string]: unknown
}

// The full operating policy already lives once in the agent system/turn
// guidance. Keep native schemas focused on selection and argument shape so
// every tool remains available without paying for the same prose 29 times.
const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  web_search: 'Discover candidate webpage URLs from a topical query; results are source previews, not extracted page evidence.',
  image_search: 'Find and download real image assets.',
  create_file: 'Create a new workspace file with complete content.',
  read_file: 'Read a workspace file.',
  delete_file: 'Delete a workspace file.',
  list_files: 'List workspace files.',
  edit_file: 'Replace one exact string in an existing workspace file.',
  append_file: 'Append a genuine continuation to an existing workspace file.',
  export_pdf: 'Export an existing Markdown or HTML file to PDF.',
  package_files: 'Package existing workspace files into a ZIP archive.',
  create_website: 'Create editable HTML, CSS and JavaScript plus one bundled website preview.',
  read_document: 'Extract readable content from one exact webpage, document URL or workspace path.',
  http_request: 'Call an exact API or structured-data endpoint.',
  browser_navigate: 'Open an exact URL in the live rendered browser.',
  browser_click_at: 'Click an indexed control in the current browser state.',
  browser_type: 'Type into an indexed input, optionally submitting it.',
  browser_fill_form: 'Fill visible form fields by label or index.',
  browser_screenshot: 'Refresh the current browser screenshot and indexed elements.',
  browser_get_content: 'Read rendered text from the current dynamic webpage.',
  browser_scroll: 'Scroll the current webpage.',
  browser_find_text: 'Find visible text in the current webpage.',
  browser_hover: 'Hover an indexed webpage element.',
  browser_select: 'Select a dropdown option by index or value.',
  browser_press_key: 'Press a keyboard key in the current webpage.',
  browser_go_back: 'Go back in browser history.',
  browser_click_and_hold: 'Hold a webpage element for a drag interaction.',
  browser_drag: 'Drag one webpage element to another position.',
  browser_action_sequence: 'Run 2–8 stable same-screen actions that need no intermediate observation.',
  execute_command: 'Run a shell command in the task cloud sandbox.',
}

function stripSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'description')
      .map(([key, nested]) => [key, stripSchemaDescriptions(nested)]),
  )
}

/**
 * Return a model-facing copy with the same tools, fields, required arguments,
 * enums and validation constraints. Only duplicated explanatory prose is
 * compacted; registry definitions and runtime execution remain unchanged.
 */
export function compactToolDefinitionsForModel<T extends ModelToolDefinition>(tools: T[]): T[] {
  return tools.map((tool) => {
    if (!tool.function) return tool
    const compactDescription = COMPACT_TOOL_DESCRIPTIONS[tool.function.name || '']
    // Preserve the full contract for any future/extension tool until it has an
    // intentional compact description and corresponding coverage.
    if (!compactDescription) return tool

    const parameters = stripSchemaDescriptions(tool.function.parameters)
    const schema = (
      parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? parameters
        : undefined
    ) as { properties?: Record<string, unknown>; [key: string]: unknown } | undefined

    if (schema?.properties?.action_label) {
      schema.properties.action_label = {
        ...(schema.properties.action_label as Record<string, unknown>),
        description: 'Visible action title: verb + concrete subject + intended result (3–24 words).',
      }
    }

    return {
      ...tool,
      function: {
        ...tool.function,
        description: compactDescription,
        ...(schema ? { parameters: schema } : {}),
      },
    } as T
  })
}
