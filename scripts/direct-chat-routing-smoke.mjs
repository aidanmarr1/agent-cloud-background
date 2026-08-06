import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const [chatRoute, prompts] = await Promise.all([
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
  readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
])

assert.doesNotMatch(
  chatRoute,
  /shouldUseDirectChat/,
  'new messages must not be diverted into a separate reduced chat mode',
)
assert.match(
  chatRoute,
  /const directChat = false/,
  'the durable compatibility field must keep every new request on AgentLoop',
)
assert.match(
  prompts,
  /Ordinary answerable questions are NOT research tasks[\s\S]*complexity 1 and steps \[\]/,
  'the unified Agent path must still answer ordinary conversational turns directly',
)
assert.match(
  prompts,
  /ordinary questions or follow-ups, answer directly in chat[\s\S]*Do not create a plan, run web_search, or browse unless/,
  'conversational Agent turns must stay quick without losing access to tools when the request needs them',
)

console.log('unified Agent routing smoke checks passed')
