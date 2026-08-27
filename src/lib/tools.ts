import type { ChatCompletionTool } from './llm'

export interface ToolContext {
  conversationId?: string
  onTerminalOutput?: (stream: 'stdout' | 'stderr', data: string) => void
  signal?: AbortSignal
}

const baseToolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Discover candidate webpages from a topical text query. Returns titles, snippets, and URLs. Never put a known or user-supplied URL/domain in query; open that exact target with browser_navigate or extract it with read_document instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topical search terms only, never a URL or a URL rewritten as spaced words' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description: 'Search real images/assets and download them to downloads/.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Image search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a workspace file. Emit action_label, plan_step_index, and path before beginning content so the task stream and live file viewer open before writing starts. Write the largest complete useful version that fits. Use append_file only for genuine continuation chunks.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (e.g. "report.md")' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Subdirectory (optional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by find-and-replace. Emit action_label, plan_step_index, and path before old_string/new_string so the task stream and live file viewer open before editing starts. old_string must match exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Exact string to find' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append a complete continuation section to an existing workspace file. The target must already exist: use create_file for the first report/file write, and use append_file only when additional content is genuinely needed. Emit action_label, plan_step_index, and path before beginning content so the task stream and live file viewer open before writing starts. Do not repeat already-written content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_pdf',
      description: 'Export an existing Markdown or HTML workspace file to PDF.',
      parameters: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'Markdown/HTML source path' },
          output_path: { type: 'string', description: 'Output PDF path' },
          title: { type: 'string', description: 'PDF title' },
        },
        required: ['source_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'package_files',
      description: 'Create a downloadable ZIP archive from existing workspace files. Use this when the user requests a ZIP or packaged source files.',
      parameters: {
        type: 'object',
        properties: {
          output_path: { type: 'string', description: 'Safe output path ending in .zip' },
          source_paths: {
            type: 'array',
            description: 'Existing workspace file paths to include in the archive',
            items: { type: 'string' },
          },
        },
        required: ['output_path', 'source_paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_website',
      description: 'Create a complete website in one reliable action. Saves editable website-src/index.html, styles.css, and script.js, then bundles them into one self-contained previewable index.html deliverable.',
      parameters: {
        type: 'object',
        properties: {
          output_path: { type: 'string', description: 'Bundled HTML deliverable path; use index.html by default' },
          html: { type: 'string', description: 'Complete semantic HTML document without inline CSS or JavaScript' },
          css: { type: 'string', description: 'Complete responsive stylesheet' },
          javascript: { type: 'string', description: 'Complete client-side JavaScript, or an empty string when no interaction is needed' },
        },
        required: ['html', 'css', 'javascript'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: 'Extract PDF, DOCX, webpage, or text content from one concrete URL/workspace path. Pass the exact selected webpage or document address in the required url field.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Exact full webpage/document URL from the selected search result, or a workspace file path',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Call an API or structured data endpoint. For ordinary readable webpages use read_document; use browser_navigate only when rendered state, scripts, screenshots, or interaction are actually needed.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, etc.)' },
          url: { type: 'string', description: 'Request URL' },
          headers: {
            type: 'object',
            description: 'Request headers',
            additionalProperties: { type: 'string' },
          },
          body: { type: 'string', description: 'Request body' },
        },
        required: ['method', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Open an exact, complete webpage URL and return live rendered page state/elements. Use this when rendered state, scripts, screenshots, or interaction are needed; use read_document for ordinary readable pages. Copy surfaced URLs verbatim; never abbreviate, shorten, or replace any part with "..." or an ellipsis.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Complete URL copied exactly from the user or tool result; never a visually truncated URL containing "..." or an ellipsis' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_at',
      description: 'Click latest indexed control.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '[N] from latest elements' },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type into indexed input; submit=true presses Enter.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '[N] input index' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Press Enter after (default false)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill_form',
      description: 'Fill visible form fields by label/index.',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            description: 'Fields by label/index plus value.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Visible label/name/placeholder' },
                index: { type: 'number', description: '[N] index' },
                value: { description: 'Text/select value or boolean toggle', type: ['string', 'number', 'boolean'] },
              },
            },
          },
          submit: { type: 'boolean', description: 'Submit after fill' },
          submitLabel: { type: 'string', description: 'Visible submit label' },
        },
        required: ['fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Refresh screenshot/elements without acting.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture full page (default false)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_content',
      description: 'Extract rendered text from the current webpage.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll page; default direction down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: 'Direction' },
          amount: { type: 'number', description: 'Pixels; default 500' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_find_text',
      description: 'Find visible text and refresh page state.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: 'Hover indexed element.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '[N] element index' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select',
      description: 'Select dropdown option by index/value.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '[N] dropdown index' },
          value: { type: 'string', description: 'Option value/label' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Press keyboard key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_go_back',
      description: 'Go back in browser history.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_and_hold',
      description: 'Hold element for drag interactions.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Element selector' },
          duration: { type: 'number', description: 'Hold ms; default 2000' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description: 'Drag an element to another position.',
      parameters: {
        type: 'object',
        properties: {
          from_selector: { type: 'string', description: 'Element to drag' },
          to_selector: { type: 'string', description: 'Target element' },
        },
        required: ['from_selector', 'to_selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_action_sequence',
      description: 'Batch 2-8 stable same-screen actions when no intermediate observation is needed; stop before submit/navigation/modal changes.',
      parameters: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            description: 'Ordered same-screen actions; prefer this over separate turns for stable fields/controls.',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['click_at', 'type', 'select', 'press_key', 'hover', 'scroll'],
                  description: 'Action type',
                },
                args: {
                  type: 'object',
                  description: 'Args for action; use indexes for controls.',
                },
              },
              required: ['action', 'args'],
            },
          },
        },
        required: ['actions'],
      },
    },
  },
]

function shouldExposeExecutionTools(): boolean {
  return process.env.AGENT_SANDBOX_PROVIDER?.trim().toLowerCase() === 'e2b' &&
    Boolean(process.env.E2B_API_KEY?.trim())
}

const executionToolDefinitions: ChatCompletionTool[] = shouldExposeExecutionTools()
  ? [
      {
        type: 'function',
        function: {
          name: 'execute_command',
          description: 'Run a shell command inside the task cloud sandbox.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to run from the sandbox workspace.' },
            },
            required: ['command'],
          },
        },
      },
    ]
  : []

const TOOL_ACTION_LABEL_PARAMETER = {
  type: 'string',
  description: 'Model-authored visible action pill text, usually 3-24 words. Start with a capital letter and do not end with a period. Name the concrete subject plus the evidence, state, artifact, or verification sought; for a known source, include the fact being extracted rather than merely saying to open/read a page. Match the wording pattern and specificity of recent labels serving the same purpose. Do not use a fixed tool mapping, local template, tool name, raw query/source/path, or generic wording such as Open article or Find details on page.',
}

const TOOL_PLAN_STEP_INDEX_PARAMETER = {
  type: 'number',
  minimum: 1,
  description: 'Active plan step, 1-based.',
}

function withRuntimeDisplayContract(tool: ChatCompletionTool): ChatCompletionTool {
  const parameters = tool.function.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return tool

  const schema = parameters as {
    properties?: Record<string, unknown>
    required?: unknown
    [key: string]: unknown
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...schema,
        properties: {
          action_label: TOOL_ACTION_LABEL_PARAMETER,
          plan_step_index: TOOL_PLAN_STEP_INDEX_PARAMETER,
          ...(schema.properties || {}),
        },
        required: [...new Set(['action_label', 'plan_step_index', ...required])],
      },
    },
  }
}

export const toolDefinitions: ChatCompletionTool[] = [
  ...baseToolDefinitions,
  ...executionToolDefinitions,
].map(withRuntimeDisplayContract)

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<unknown> {
  // Use the declarative registry for all tool execution
  const { executeToolFromRegistry } = await import('./toolRegistry')
  return executeToolFromRegistry(name, args, context)
}
