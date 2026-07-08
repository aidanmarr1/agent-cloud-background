import type { ChatCompletionTool } from './llm'

export interface ToolContext {
  conversationId?: string
  onTerminalOutput?: (stream: 'stdout' | 'stderr', data: string) => void
}

const baseToolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, snippets, and URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
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
          count: { type: 'number', description: 'Number of images (1-5, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description: 'Create a workspace file. Put path before content; write the largest complete useful version that fits. Use append_file only for genuine continuation chunks.',
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
      description: 'Edit a file by find-and-replace. old_string must match exactly.',
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
      description: 'Append a complete continuation section to an existing workspace file. Put path before content; do not repeat already-written content.',
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
      name: 'youtube_transcript',
      description: 'Extract transcript from a YouTube video.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'YouTube URL or video ID' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: 'Read PDF, DOCX, or text from URL/workspace.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'URL or file path' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'Call API/data endpoint; use browser_navigate for webpages.',
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
      description: 'Open URL and return page state/elements.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
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
      description: 'Get rendered page text.',
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
  description: 'Model-authored visible action pill text, 2-12 words. Start with a capital letter and do not end with a period. Describe the action purpose from task context; do not use a local template, tool name, raw query/source/path, or generic verb plus literal target.',
}

const TOOL_PLAN_STEP_INDEX_PARAMETER = {
  type: 'number',
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
