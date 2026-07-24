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

assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 3_000/, 'agent inactivity timeout must tolerate ordinary provider jitter while iteration deadlines bound frozen turns')
assert.match(config, /iterationTimeoutMs:\s*IS_OLLAMA \? 600_000 : 12_000/, 'API stream iterations must stay bounded without minute-scale frozen turns')
assert.match(config, /checkIntervalMs:\s*150/, 'timeout watchdog must check often enough for responsive recovery')
assert.match(config, /export const STREAM_REQUEST_TIMEOUT_MS = 12_000/, 'streaming model requests must stay bounded while allowing Gemini 3.6 Nitro to start reliably')
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
assert.match(agentLoop, /const FAST_SOURCE_ACTION_REQUEST_TIMEOUT_MS = 10_000/, 'source action turns must use a realistic Gemini 3.6 provider-start window without stacked retries')
assert.match(agentLoop, /const FAST_ACTION_REQUEST_TIMEOUT_MS = 10_000/, 'non-source action turns must use a realistic Gemini 3.6 provider-start window without stacked retries')
assert.match(agentLoop, /const FAST_SOURCE_ACTION_INACTIVITY_TIMEOUT_MS = 2_500/, 'source action turns must tolerate ordinary provider jitter instead of buying a slower repair turn')
assert.match(agentLoop, /const FAST_ACTION_INACTIVITY_TIMEOUT_MS = 2_500/, 'non-source action turns must tolerate ordinary provider jitter instead of buying a slower repair turn')
assert.match(agentLoop, /if \(!lastStreamResult\.timedOut\) state\.timeoutNudgeCount = 0[\s\S]*finishNarrationCadenceAttempt/, 'only a normally completed stream may reset the consecutive timeout budget')
assert.match(agentLoop, /effectiveCadenceNarrationInMainTurn =[\s\S]*activeTools\.length > 0[\s\S]*cadenceProgressUpdateEnabled: effectiveCadenceNarrationInMainTurn/, 'cadence narration must never require a native tool field on a text-only turn')
assert.doesNotMatch(agentLoop, /FINAL_SAVED_DELIVERABLE_NONSTREAM_REQUEST_TIMEOUT_MS|Final saved deliverable stream start timed out; using compact final-write completion/, 'final saved writes must not wait on a second non-stream fallback request')
assert.match(agentLoop, /const FAST_SOURCE_ACTION_MAX_TOKENS = 384/, 'source/action selection turns must keep a small but non-truncating output budget')
assert.match(agentLoop, /HOT PATH SOURCE ACTION TURN:[\s\S]*parallel batch of up to 3 source extraction calls/, 'source/action turns should allow one model-selected batch of three independent source reads after search results are available')
assert.match(agentLoop, /allowParallelSourceToolCalls[\s\S]*!sourceExtractionBatchConsumedForLatestSearch\(state\)[\s\S]*visibleNarrationActionHeadroom\(state\) >= 3[\s\S]*parallel_tool_calls:\s*allowParallelSourceToolCalls/, 'parallel model tool calls must be limited to one model-selected source batch with enough narration headroom')
assert.match(agentLoop, /streamToolCallPolicy[\s\S]*processStream\([\s\S]*streamToolCallPolicy/, 'the exact request-time parallel source policy must be forwarded to stream processing')
assert.match(agentLoop, /const streamPolicy = \{[\s\S]*allowParallelSourceExtractionCalls:[\s\S]*maxParallelSourceExtractionCalls[\s\S]*captureStreamToolCallPolicy\?\.\(streamPolicy\)[\s\S]*createStreamingCompletion/, 'the exact stream policy must be captured before awaiting provider response headers')
assert.match(toolPipeline, /MAX_PARALLEL_SOURCE_EXTRACTIONS = 3/, 'one model-selected source batch must stay within three visible actions')
assert.match(toolPipeline, /PARALLEL_SOURCE_EXTRACTION_TOOLS[\s\S]*read_document[\s\S]*http_request/, 'parallel execution must stay limited to stateless source extraction tools')
assert.doesNotMatch(toolPipeline, /youtube_transcript/, 'removed YouTube tooling must not remain eligible for execution')
assert.match(toolPipeline, /Promise\.all\(executionBatch\.map[\s\S]*executeSingle\(tc,\s*state,\s*assistantContent\)/, 'source extraction batches must execute concurrently')
assert.doesNotMatch(toolPipeline, /autoSourceExtractionBatchFromSearch|executeAutoSourceExtractionBatch/, 'the runtime must not auto-select or repeatedly mine search results')
assert.match(toolPipeline, /Selecting a source batch is the decision boundary[\s\S]*stepLastSourceExtractionSearchCount = state\.stepSearchQueries\.size[\s\S]*Promise\.all\(executionBatch\.map/, 'the selected source set must be consumed before reads execute so failures cannot reopen it')
assert.match(agentLoop, /workingMemory\?\.render\(\{ stepIdx: state\.currentStepIdx, maxFacts: 10, maxChars: 1000 \}\)/, 'compact research turns must keep memory payload lean')
assert.match(agentLoop, /researchActivity\.entries[\s\S]*?\.slice\(-5\)/, 'compact research turns must not replay too many recent source records')
assert.match(streamProcessor, /toolName === 'web_search' \|\| toolName === 'image_search'[\s\S]*typeof args\.query === 'string'/, 'search action pills must show from safe provisional tool-call args instead of waiting for the whole tool stream')
assert.match(streamProcessor, /PARALLEL_STREAM_SOURCE_EXTRACTION_TOOLS[\s\S]*read_document[\s\S]*http_request/, 'streamed parallel calls must be restricted to the same source-only tool family as execution')
assert.doesNotMatch(streamProcessor, /youtube_transcript/, 'removed YouTube tooling must not remain eligible for streamed execution')
assert.match(streamProcessor, /maxStreamedToolCalls[\s\S]*sourceOnlyBatch[\s\S]*toolCalls\.clear\(\)[\s\S]*primaryToolCall/, 'mixed or unsafe streamed batches must keep only their first call')
assert.match(streamProcessor, /orderedEntries\.slice\(0, maxStreamedToolCalls\)/, 'safe streamed source batches must preserve provider index order and enforce their request-time cap')
assert.match(streamProcessor, /Tool-call chunks reset provider inactivity through lastChunkTime[\s\S]*Only reset visible inactivity once an action pill or file preview/, 'hidden tool arguments must not keep an apparently frozen UI alive forever')
assert.match(streamProcessor, /Timeout with tool calls in progress:[\s\S]*route malformed\/incomplete JSON through internal recovery[\s\S]*Non-fatal timeout during tool streaming/, 'timed-out partial tool calls must be returned for tool-pipeline recovery instead of terminal task errors')
assert.doesNotMatch(streamProcessor, /if \(toolName === 'read_document'/, 'source-read pills must wait for committed execution so they cannot get stranded during source extraction retries')
assert.doesNotMatch(streamProcessor, /if \(toolName === 'browser_navigate' \|\| toolName === 'browse_page'\)/, 'browser navigation pills must wait for committed execution so preflight/reroute guards cannot leave ghost actions')
assert.match(toolPipeline, /closeVisibleProvisionalStart[\s\S]*visibleNarrationToolStartIds\.has\(tc\.id\)[\s\S]*toolResult\(tc\.id, toolName/, 'preflight blocks must close any provisional action pill before returning an internal recovery result')
assert.match(toolPipeline, /closeVisibleProvisionalStart[\s\S]*isInternalRecoveryResult\(result\)[\s\S]*visibleToolActionsSinceLastNarration - 1/, 'preflight-rejected provisional actions must retract their optimistic narration cadence count')
assert.match(agentLoop, /state\.deadlineFinalizationStarted[\s\S]*?agentRunRemainingMs\(state\) - \(state\.deadlineHardStopBufferMs \|\| AGENT_DEADLINE_HARD_STOP_BUFFER_MS\)/, 'deadline finalization must shorten model request timeout to fit remaining platform time')
assert.match(agentLoop, /retryMaxAttempts:\s*STREAM_MAX_RETRIES/, 'agent loop must pass bounded retry count into the LLM client')
assert.match(agentLoop, /retryMaxDelayMs:\s*STREAM_RETRY_MAX_DELAY_MS/, 'agent loop must pass retry delay cap into the LLM client')
assert.match(agentLoop, /Math\.min\(Math\.max\(retryAfterMs,\s*baseBackoff\),\s*STREAM_RETRY_MAX_DELAY_MS\)/, 'rate-limit retry-after values must be capped for responsiveness')
assert.match(agentLoop, /function shouldKeepAssistantInjection[\s\S]*looksLikeFutureOnlyAssistantInjection[\s\S]*function looksLikeFutureOnlyAssistantInjection[\s\S]*futureAction/, 'future-only progress narration must not be kept in context and reinforce text loops')
assert.match(policyEngine, /checkFutureTenseAfterProgress[\s\S]*state\.consecutiveNoToolCalls\+\+[\s\S]*deferNarrationCadenceAttempt\(state\)/, 'future-only narration must release optional narration cadence and force a real tool turn')
assert.doesNotMatch(policyEngine, /checkFutureTenseAfterProgress[\s\S]{0,900}role: 'assistant', content: assistantContent/, 'future-only narration must not be replayed into model context')

assert.match(llm, /retryMaxAttempts\?: number/, 'LLM client must expose per-call retry control')
assert.match(llm, /retryMaxDelayMs\?: number/, 'LLM client must expose per-call retry delay caps')
assert.match(llm, /const maxRetries = Math\.max\(0, Math\.min\(options\?\.maxAttempts \?\? MAX_RETRIES, MAX_RETRIES\)\)/, 'LLM client must bound configured retries')
assert.match(llm, /const delayMs = Math\.min\(rawDelay,\s*maxDelayMs\) \+ jitter/, 'LLM client must cap retry sleeps')

assert.match(useAgentStream, /if \(existingController && isAutoSend\) \{[\s\S]*?return[\s\S]*?\}/, 'duplicate auto-send must not abort an already-running task stream')
assert.doesNotMatch(useAgentStream, /Too many dispatch errors, aborting stream|controller\.abort\(\)[\s\S]*?Stream dispatcher failed repeatedly/, 'client-side stream dispatch errors must not abort the backend task')
assert.match(useAgentStream, /Repeated dispatch errors; leaving the durable cursor at the last complete event/, 'dispatch failures should be visible but non-fatal')
assert.match(chatRoute, /Promise\.all\(\[[\s\S]*creditsPromise,[\s\S]*messagesPromise,[\s\S]*workerAvailabilityPromise,[\s\S]*attachmentAccessPromise,/, 'task acceptance must await credit, message, worker, and attachment checks running in parallel')
assert.ok(chatRoute.indexOf("await timedRoutePromise('taskAccessReadyMs'") < chatRoute.indexOf('const creditsPromise'), 'task access must be approved before the remaining acceptance gates begin')
assert.doesNotMatch(chatRoute, /taskStartPromise = workerStartupPlanPromise\.then|workerStartupPlanPromise[\s\S]*enqueueTaskJob/, 'external-worker chat route must not wait for startup planning before enqueueing the durable job')
assert.doesNotMatch(chatRoute, /createFastStartupPlan|chooseFastStartupPlan|fastStartupPlanSubject/, 'external-worker chat route must not fabricate deterministic visible plans')
assert.match(chatRoute, /const initialEvents:\s*SSEEvent\[\]\s*=\s*\[heartbeatEvent\]/, 'external-worker chat route should persist only heartbeat before the worker-owned plan')
assert.match(chatRoute, /startupPlanExpected: false[\s\S]*await enqueueTaskJob\(\{[\s\S]*payload: queuedTaskPayload[\s\S]*markRouteTiming\('taskQueuedMs'\)/, 'external-worker chat route must durably enqueue before returning an accepted stream')
assert.match(chatRoute, /catch \(error\) \{[\s\S]*error instanceof TaskConversationConflictError[\s\S]*status: 409/, 'atomic enqueue conflicts must remain truthful HTTP 409 responses')
assert.ok(chatRoute.indexOf('if (access && !access.ok)') < chatRoute.indexOf('enqueueTaskJob({'), 'task access must be approved before enqueue')
assert.ok(chatRoute.indexOf('if (unavailableWorker)') < chatRoute.indexOf('enqueueTaskJob({'), 'worker readiness failure must be returned before enqueue')
assert.ok(chatRoute.indexOf('findActiveTaskJobForConversation(userId, conversationId)') < chatRoute.indexOf('enqueueTaskJob({'), 'same-conversation active work must be rejected before enqueue')

assert.match(search, /SERPER_API_KEY/, 'web search must use Serper API credentials')
assert.match(search, /\$\{SERPER_BASE_URL\}\/\$\{path\}/, 'web search must call the configured Serper endpoint')
assert.match(search, /WEB_SEARCH_RESULT_COUNT\s*=\s*15/, 'web search must return at most 15 results in the Computer panel')
assert.match(search, /num:\s*WEB_SEARCH_RESULT_COUNT/, 'web search must pass the 15-result count to Serper')
assert.match(search, /resultFromOrganic\(item,\s*'serper-organic'\)/, 'web search results must be labeled as Serper organic results')
assert.doesNotMatch(search, /SearXNG|DuckDuckGo|BRAVE_SEARCH|direct-search-page|Promise\.any\(attempts\)/, 'web search must not retain the old free-provider routing')

console.log('agent responsiveness smoke checks passed')
