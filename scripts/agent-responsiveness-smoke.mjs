import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

const [
  config,
  agentLoop,
  policyEngine,
  toolPipeline,
  streamProcessor,
  llm,
  useAgentStream,
  search,
  chatRoute,
] = await Promise.all([
  readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
  readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
  readFile(join(root, 'src/lib/llm.ts'), 'utf8'),
  readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
  readFile(join(root, 'src/lib/search.ts'), 'utf8'),
  readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
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
assert.match(agentLoop, /const FAST_ACTION_REQUEST_TIMEOUT_MS = 1_500/, 'fast action turns must stay inside the 1-2 second first-token window')
assert.match(agentLoop, /const FAST_ACTION_INACTIVITY_TIMEOUT_MS = 450/, 'fast action turns should recover quickly from invisible provider stalls')
assert.doesNotMatch(agentLoop, /FINAL_SAVED_DELIVERABLE_NONSTREAM_REQUEST_TIMEOUT_MS|Final saved deliverable stream start timed out; using compact final-write completion/, 'final saved writes must not wait on a second non-stream fallback request')
assert.match(agentLoop, /const FAST_SOURCE_ACTION_MAX_TOKENS = 260/, 'source/action selection turns must keep a small output budget')
assert.match(agentLoop, /HOT PATH SOURCE ACTION TURN:[\s\S]*up to 4 parallel source extraction calls/, 'source/action turns should allow bounded parallel source reads after search results are available')
assert.match(agentLoop, /parallel_tool_calls:\s*fastSourceActionTurn/, 'parallel model tool calls must be limited to source-action turns')
assert.match(toolPipeline, /MAX_PARALLEL_SOURCE_EXTRACTIONS = 4/, 'source extraction parallelism must be capped at four calls')
assert.match(toolPipeline, /PARALLEL_SOURCE_EXTRACTION_TOOLS[\s\S]*read_document[\s\S]*http_request[\s\S]*youtube_transcript/, 'parallel execution must stay limited to stateless source extraction tools')
assert.match(toolPipeline, /Promise\.all\(executionBatch\.map[\s\S]*executeSingle\(tc,\s*state,\s*assistantContent\)/, 'source extraction batches must execute concurrently')
assert.match(agentLoop, /workingMemory\?\.render\(\{ stepIdx: state\.currentStepIdx, maxFacts: 10, maxChars: 1000 \}\)/, 'compact research turns must keep memory payload lean')
assert.match(agentLoop, /researchActivity\.entries[\s\S]*?\.slice\(-5\)/, 'compact research turns must not replay too many recent source records')
assert.match(streamProcessor, /toolName === 'web_search' \|\| toolName === 'image_search'[\s\S]*typeof args\.query === 'string'/, 'search action pills must show from safe provisional tool-call args instead of waiting for the whole tool stream')
assert.doesNotMatch(streamProcessor, /if \(toolName === 'read_document'/, 'source-read pills must wait for committed execution so they cannot get stranded during source extraction retries')
assert.doesNotMatch(streamProcessor, /if \(toolName === 'browser_navigate' \|\| toolName === 'browse_page'\)/, 'browser navigation pills must wait for committed execution so preflight/reroute guards cannot leave ghost actions')
assert.match(toolPipeline, /closeVisibleProvisionalStart[\s\S]*visibleNarrationToolStartIds\.has\(tc\.id\)[\s\S]*toolResult\(tc\.id, toolName/, 'preflight blocks must close any provisional action pill before returning an internal recovery result')
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
assert.doesNotMatch(chatRoute, /Promise\.all\(\[\s*accessPromise,\s*workerAvailabilityPromise\s*\]\)/, 'external-worker chat route must not hold durable job enqueue behind worker readiness checks')
assert.doesNotMatch(chatRoute, /taskStartPromise = workerStartupPlanPromise\.then|workerStartupPlanPromise[\s\S]*enqueueTaskJob/, 'external-worker chat route must not wait for startup planning before enqueueing the durable job')
assert.match(chatRoute, /const startupPlan = createFastStartupPlan\(\{ messages \}\)/, 'external-worker chat route must create a startup plan without waiting on planner generation')
assert.match(chatRoute, /const initialEvents:[\s\S]*heartbeatEvent[\s\S]*type: 'plan', items: startupPlan\.items/, 'external-worker chat route must persist the visible startup plan in initial events')
assert.match(chatRoute, /taskStartPromise = Promise\.resolve\(\)\.then\(\(\) => \{[\s\S]*startupPlanExpected: false[\s\S]*payload: queuedTaskPayload[\s\S]*markRouteTiming\('taskQueuedMs'\)/, 'external-worker chat route must enqueue immediately with startup plan or an explicit no-plan release flag')
assert.match(chatRoute, /void accessPromise\.then[\s\S]*taskAccessDenied = true[\s\S]*cancelTaskJob\(userId, creditRunId\)/, 'task access must still cancel a prefaced task when ownership validation fails')

assert.match(search, /SERPER_API_KEY/, 'web search must use Serper API credentials')
assert.match(search, /\$\{SERPER_BASE_URL\}\/\$\{path\}/, 'web search must call the configured Serper endpoint')
assert.match(search, /WEB_SEARCH_RESULT_COUNT\s*=\s*15/, 'web search must return 15 results in the Computer panel')
assert.match(search, /num:\s*WEB_SEARCH_RESULT_COUNT/, 'web search must pass the 15-result count to Serper')
assert.match(search, /resultFromOrganic\(item,\s*'serper-organic'\)/, 'web search results must be labeled as Serper organic results')
assert.doesNotMatch(search, /SearXNG|DuckDuckGo|BRAVE_SEARCH|direct-search-page|Promise\.any\(attempts\)/, 'web search must not retain the old free-provider routing')

console.log('agent responsiveness smoke checks passed')
