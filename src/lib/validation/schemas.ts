import { z } from 'zod'
import { resolveModel } from '@/lib/llm'
import { clampTaskInput } from '@/lib/inputLimits'

const MAX_CHAT_MESSAGES = 80
const MAX_TITLE_MESSAGES = 20
const MAX_MESSAGE_CONTENT_CHARS = 50_000
const MAX_TITLE_CONTENT_CHARS = 4_000
const MAX_CUSTOM_INSTRUCTIONS_CHARS = 20_000
const MAX_ATTACHMENTS_PER_MESSAGE = 8
const MAX_ATTACHMENT_NAME_CHARS = 240
const MAX_ATTACHMENT_TYPE_CHARS = 120
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_CONTENT_CHARS = 16 * 1024 * 1024

const ChatMessageSchema = z.object({
  id: z.string().uuid().optional(),
  timestamp: z.number().finite().nonnegative().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CONTENT_CHARS),
  attachments: z.array(z.object({
    id: z.string().uuid().optional(),
    name: z.string().max(MAX_ATTACHMENT_NAME_CHARS),
    type: z.string().max(MAX_ATTACHMENT_TYPE_CHARS),
    size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
    content: z.string().max(MAX_ATTACHMENT_CONTENT_CHARS).optional(),
    contentEncoding: z.enum(['text', 'data-url']).optional(),
    url: z.string().max(500).optional(),
    sandboxPath: z.string().max(500).optional(),
    persisted: z.boolean().optional(),
    preview: z.string().max(MAX_ATTACHMENT_CONTENT_CHARS).optional(),
  })).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
}).transform((message) => (
  message.role === 'user'
    ? { ...message, content: clampTaskInput(message.content) }
    : message
))

export const ChatRequestSchema = z.object({
  runId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
  messages: z.array(ChatMessageSchema).min(1).max(MAX_CHAT_MESSAGES),
  model: z.string().optional().default('').transform(v => resolveModel(v || '')),
  conversationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'task id must contain only alphanumeric, hyphens, underscores'),
  customInstructions: z.string().max(MAX_CUSTOM_INSTRUCTIONS_CHARS).optional(),
  startFreshSandbox: z.boolean().optional().default(false),
})

export const TitleRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_TITLE_CONTENT_CHARS),
  })).min(1).max(MAX_TITLE_MESSAGES),
  conversationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'task id must contain only alphanumeric, hyphens, underscores'),
})
