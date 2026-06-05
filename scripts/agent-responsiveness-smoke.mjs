import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

const [
  config,
  agentLoop,
  toolPipeline,
  llm,
  useAgentStream,
] = await Promise.all([
  readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
  readFile(join(root, 'src/lib/llm.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
])

assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 45_000/, 'agent inactivity timeout must tolerate normal provider first-token latency without false task timeouts')
assert.match(config, /iterationTimeoutMs:\s*IS_OLLAMA \? 600_000 : 120_000/, 'API stream iterations must stay bounded while allowing tool-heavy turns')
assert.match(config, /checkIntervalMs:\s*150/, 'timeout watchdog must check often enough for responsive recovery')
assert.match(config, /export const STREAM_REQUEST_TIMEOUT_MS = 150_000/, 'streaming model requests must tolerate normal provider latency without false task timeouts')
assert.match(config, /export const STREAM_RETRY_MAX_DELAY_MS = 4_000/, 'stream retries must not sleep for provider-scale retry windows')
assert.match(config, /export const STREAM_MAX_RETRIES = 2/, 'agent streaming retries must stay bounded')
assert.match(config, /export const WEB_SEARCH_TOOL_TIMEOUT_MS = .*12_000/, 'web search needs its own bounded timeout')
assert.match(config, /export const BROWSER_TOOL_TIMEOUT_MS = .*12_000/, 'browser actions need their own bounded timeout')
assert.match(config, /export const DOCUMENT_TOOL_TIMEOUT_MS = .*12_000/, 'document reads need their own bounded timeout')
assert.match(config, /export const FILE_WRITE_TOOL_TIMEOUT_MS = .*18_000/, 'file writes must not wait for multi-minute stalls')

assert.match(toolPipeline, /function timeoutMsForTool\(toolName: string\): number/, 'tool pipeline must route tool-specific timeouts')
assert.match(toolPipeline, /toolName === 'web_search' \|\| toolName === 'image_search'[\s\S]*WEB_SEARCH_TOOL_TIMEOUT_MS/, 'search tools must use the web-search timeout')
assert.match(toolPipeline, /toolName\.startsWith\('browser_'\) \|\| toolName === 'browse_page'[\s\S]*BROWSER_TOOL_TIMEOUT_MS/, 'browser tools must use the browser timeout')
assert.match(toolPipeline, /read_document[\s\S]*http_request[\s\S]*DOCUMENT_TOOL_TIMEOUT_MS/, 'document-like tools must use the document timeout')

assert.match(agentLoop, /requestTimeoutMs,/, 'agent loop must pass the computed streaming request timeout into the LLM client')
assert.match(agentLoop, /state\.deadlineFinalizationStarted[\s\S]*?agentRunRemainingMs\(state\) - 10_000/, 'deadline finalization must shorten model request timeout to fit remaining platform time')
assert.match(agentLoop, /retryMaxAttempts:\s*STREAM_MAX_RETRIES/, 'agent loop must pass bounded retry count into the LLM client')
assert.match(agentLoop, /retryMaxDelayMs:\s*STREAM_RETRY_MAX_DELAY_MS/, 'agent loop must pass retry delay cap into the LLM client')
assert.match(agentLoop, /Math\.min\(Math\.max\(retryAfterMs,\s*baseBackoff\),\s*STREAM_RETRY_MAX_DELAY_MS\)/, 'rate-limit retry-after values must be capped for responsiveness')

assert.match(llm, /retryMaxAttempts\?: number/, 'LLM client must expose per-call retry control')
assert.match(llm, /retryMaxDelayMs\?: number/, 'LLM client must expose per-call retry delay caps')
assert.match(llm, /const maxRetries = Math\.max\(0, Math\.min\(options\?\.maxAttempts \?\? MAX_RETRIES, MAX_RETRIES\)\)/, 'LLM client must bound configured retries')
assert.match(llm, /const delayMs = Math\.min\(rawDelay,\s*maxDelayMs\) \+ jitter/, 'LLM client must cap retry sleeps')

assert.match(useAgentStream, /if \(existingController && isAutoSend\) \{[\s\S]*?return[\s\S]*?\}/, 'duplicate auto-send must not abort an already-running task stream')
assert.doesNotMatch(useAgentStream, /Too many dispatch errors, aborting stream|controller\.abort\(\)[\s\S]*?Stream dispatcher failed repeatedly/, 'client-side stream dispatch errors must not abort the backend task')
assert.match(useAgentStream, /Repeated dispatch errors; keeping stream alive so the backend task can finish/, 'dispatch failures should be visible but non-fatal')

console.log('agent responsiveness smoke checks passed')
