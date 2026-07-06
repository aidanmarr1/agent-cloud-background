import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

const [
  config,
  agentLoop,
  policyEngine,
  toolPipeline,
  llm,
  useAgentStream,
  search,
] = await Promise.all([
  readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
  readFile(join(root, 'src/lib/llm.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
  readFile(join(root, 'src/lib/search.ts'), 'utf8'),
])

assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 1_500/, 'agent inactivity timeout must recover quickly from invisible provider stalls')
assert.match(config, /iterationTimeoutMs:\s*IS_OLLAMA \? 600_000 : 12_000/, 'API stream iterations must stay bounded without minute-scale frozen turns')
assert.match(config, /checkIntervalMs:\s*150/, 'timeout watchdog must check often enough for responsive recovery')
assert.match(config, /export const STREAM_REQUEST_TIMEOUT_MS = 2_400/, 'streaming model requests must stay short while allowing the configured provider to start')
assert.match(config, /export const STREAM_RETRY_MAX_DELAY_MS = 1_500/, 'stream retries must not sleep for provider-scale retry windows')
assert.match(config, /export const STREAM_MAX_RETRIES = 0/, 'agent streaming retries must not hide slow starts behind invisible retry waits')
assert.match(config, /export const WEB_SEARCH_TOOL_TIMEOUT_MS = .*3_500/, 'web search needs a bounded timeout that covers Serper-backed search calls')
assert.match(config, /export const BROWSER_TOOL_TIMEOUT_MS = .*1_800/, 'browser actions need their own fast bounded timeout')
assert.match(config, /export const DOCUMENT_TOOL_TIMEOUT_MS = .*4_000/, 'document reads need enough time to return extracted content or an internal recovery result')
assert.match(config, /export const FILE_WRITE_TOOL_TIMEOUT_MS = .*8_000/, 'file writes must not wait for multi-minute stalls')

assert.match(toolPipeline, /function timeoutMsForTool\(toolName: string\): number/, 'tool pipeline must route tool-specific timeouts')
assert.match(toolPipeline, /toolName === 'web_search' \|\| toolName === 'image_search'[\s\S]*WEB_SEARCH_TOOL_TIMEOUT_MS/, 'search tools must use the web-search timeout')
assert.match(toolPipeline, /toolName\.startsWith\('browser_'\) \|\| toolName === 'browse_page'[\s\S]*BROWSER_TOOL_TIMEOUT_MS/, 'browser tools must use the browser timeout')
assert.match(toolPipeline, /read_document[\s\S]*http_request[\s\S]*DOCUMENT_TOOL_TIMEOUT_MS/, 'document-like tools must use the document timeout')
assert.match(toolPipeline, /function documentTimeoutRecoveryResult[\s\S]*INTERNAL_RECOVERY:[\s\S]*timed out while extracting/, 'document extraction timeouts must become internal recovery results instead of visible tool failures')
assert.match(toolPipeline, /function searchExecutionRecoveryResult[\s\S]*INTERNAL_RECOVERY:[\s\S]*search provider call failed or timed out/, 'search provider failures must become internal recovery results instead of visible search-unavailable panels')

assert.match(agentLoop, /requestTimeoutMs,/, 'agent loop must pass the computed streaming request timeout into the LLM client')
assert.match(agentLoop, /const FAST_ACTION_REQUEST_TIMEOUT_MS = 2_000/, 'fast action turns should give the provider enough first-token room to avoid retry loops')
assert.match(agentLoop, /const FAST_ACTION_INACTIVITY_TIMEOUT_MS = 600/, 'fast action turns should recover quickly from invisible provider stalls')
assert.doesNotMatch(agentLoop, /FINAL_SAVED_DELIVERABLE_NONSTREAM_REQUEST_TIMEOUT_MS|Final saved deliverable stream start timed out; using compact final-write completion/, 'final saved writes must not wait on a second non-stream fallback request')
assert.match(agentLoop, /const FAST_SOURCE_ACTION_MAX_TOKENS = 320/, 'source/action selection turns must keep a small output budget')
assert.match(agentLoop, /workingMemory\?\.render\(\{ stepIdx: state\.currentStepIdx, maxFacts: 10, maxChars: 1000 \}\)/, 'compact research turns must keep memory payload lean')
assert.match(agentLoop, /researchActivity\.entries[\s\S]*?\.slice\(-5\)/, 'compact research turns must not replay too many recent source records')
assert.match(agentLoop, /state\.deadlineFinalizationStarted[\s\S]*?agentRunRemainingMs\(state\) - \(state\.deadlineHardStopBufferMs \|\| AGENT_DEADLINE_HARD_STOP_BUFFER_MS\)/, 'deadline finalization must shorten model request timeout to fit remaining platform time')
assert.match(agentLoop, /retryMaxAttempts:\s*STREAM_MAX_RETRIES/, 'agent loop must pass bounded retry count into the LLM client')
assert.match(agentLoop, /retryMaxDelayMs:\s*STREAM_RETRY_MAX_DELAY_MS/, 'agent loop must pass retry delay cap into the LLM client')
assert.match(agentLoop, /Math\.min\(Math\.max\(retryAfterMs,\s*baseBackoff\),\s*STREAM_RETRY_MAX_DELAY_MS\)/, 'rate-limit retry-after values must be capped for responsiveness')
assert.match(agentLoop, /function shouldKeepAssistantInjection[\s\S]*looksLikeFutureOnlyAssistantInjection[\s\S]*function looksLikeFutureOnlyAssistantInjection[\s\S]*futureAction/, 'future-only progress narration must not be kept in context and reinforce text loops')
assert.match(policyEngine, /checkFutureTenseAfterProgress[\s\S]*state\.consecutiveNoToolCalls\+\+[\s\S]*state\.visibleToolActionsSinceLastNarration = 0/, 'future-only narration must release narration-only mode and force a real tool turn')
assert.doesNotMatch(policyEngine, /checkFutureTenseAfterProgress[\s\S]{0,900}role: 'assistant', content: assistantContent/, 'future-only narration must not be replayed into model context')

assert.match(llm, /retryMaxAttempts\?: number/, 'LLM client must expose per-call retry control')
assert.match(llm, /retryMaxDelayMs\?: number/, 'LLM client must expose per-call retry delay caps')
assert.match(llm, /const maxRetries = Math\.max\(0, Math\.min\(options\?\.maxAttempts \?\? MAX_RETRIES, MAX_RETRIES\)\)/, 'LLM client must bound configured retries')
assert.match(llm, /const delayMs = Math\.min\(rawDelay,\s*maxDelayMs\) \+ jitter/, 'LLM client must cap retry sleeps')

assert.match(useAgentStream, /if \(existingController && isAutoSend\) \{[\s\S]*?return[\s\S]*?\}/, 'duplicate auto-send must not abort an already-running task stream')
assert.doesNotMatch(useAgentStream, /Too many dispatch errors, aborting stream|controller\.abort\(\)[\s\S]*?Stream dispatcher failed repeatedly/, 'client-side stream dispatch errors must not abort the backend task')
assert.match(useAgentStream, /Repeated dispatch errors; keeping stream alive so the backend task can finish/, 'dispatch failures should be visible but non-fatal')

assert.match(search, /SERPER_API_KEY/, 'web search must use Serper API credentials')
assert.match(search, /\$\{SERPER_BASE_URL\}\/\$\{path\}/, 'web search must call the configured Serper endpoint')
assert.match(search, /WEB_SEARCH_RESULT_COUNT\s*=\s*15/, 'web search must return 15 results in the Computer panel')
assert.match(search, /num:\s*WEB_SEARCH_RESULT_COUNT/, 'web search must pass the 15-result count to Serper')
assert.match(search, /resultFromOrganic\(item,\s*'serper-organic'\)/, 'web search results must be labeled as Serper organic results')
assert.doesNotMatch(search, /SearXNG|DuckDuckGo|BRAVE_SEARCH|direct-search-page|Promise\.any\(attempts\)/, 'web search must not retain the old free-provider routing')

console.log('agent responsiveness smoke checks passed')
