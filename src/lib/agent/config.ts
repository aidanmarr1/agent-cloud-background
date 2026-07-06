/**
 * Centralized configuration for the agent system.
 * All magic numbers, thresholds, and tuning parameters live here.
 */

const IS_OLLAMA = false

// --- Iteration & timing ---
export const BASE_ITERATIONS = 44
export const MAX_ITERATIONS = 180  // Hard runtime cap; dynamic budgets may grow up to this, not past it
export const COMPLEXITY_ITERATION_BONUS = { 1: 0, 2: 32, 3: 84 } as const
export const MIN_ITERATION_DELAY_MS = 0
export const MAX_CONTEXT_MESSAGES = 8
export const MAX_TIMEOUT_NUDGES = 1
export const AGENT_RUN_MAX_DURATION_MS = 270_000
export const AGENT_DEADLINE_FINALIZATION_BUFFER_MS = 150_000
export const AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS = 20_000
export const AGENT_DEADLINE_HARD_STOP_BUFFER_MS = 18_000
export const AGENT_WORKER_RUN_MAX_DURATION_MS = 900_000
export const AGENT_WORKER_DEADLINE_FINALIZATION_BUFFER_MS = 120_000
export const AGENT_WORKER_DEADLINE_MODEL_TURN_TIMEOUT_MS = 28_000
export const AGENT_WORKER_DEADLINE_HARD_STOP_BUFFER_MS = 20_000

// --- Step budgets ---
export const RESEARCH_STEP_BUDGET_MULTIPLIER = 0.78  // Research phases need enough turns to gather real source evidence
export const DELIVERABLE_BUDGET_FRACTION = 1.0       // Use all available iterations
export const MIN_STEP_BUDGET = 6
export const MIN_DELIVERABLE_BUDGET = 10

// --- Research nudging ---
export const RESEARCH_NUDGE_ITERATION = IS_OLLAMA ? 6 : 4   // Start nudging non-final steps after N iterations
export const NO_TOOL_FORCE_ADVANCE = IS_OLLAMA ? 8 : 4      // Force advance after N consecutive no-tool iterations
export const MIN_TOOL_CALLS_PER_STEP = 2    // Default minimum — overridden by complexity-aware lookup
export const MIN_TOOL_CALLS_BY_COMPLEXITY = { 1: 1, 2: 4, 3: 6 } as const
export const MIN_RESEARCH_CALLS_BY_COMPLEXITY = { 1: 3, 2: 7, 3: 12 } as const
export const MIN_OPENED_SOURCE_BREADTH_BY_COMPLEXITY = { 1: 2, 2: 4, 3: 6 } as const

// --- Search & browse thresholds ---
export const CONSECUTIVE_SEARCH_FAILURES_WARN = 4
export const TOTAL_SEARCH_FAILURES_DISABLE = 6
export const CONSECUTIVE_BROWSE_FAILURES_WARN = 3

// --- Loop detection ---
export const RECENT_TOOL_CALL_WINDOW = 8
export const LOOP_CHECK_WINDOW = 8
export const LOOP_THRESHOLD = 3             // Same tool N times in window = loop

// --- Content & narration ---
export const NARRATION_THRESHOLD_DEFAULT = 3
export const NARRATION_THRESHOLD_BROWSER = 3
export const NARRATION_MAX_VISIBLE_ACTION_GAP = 4
export const POST_COMPLETION_MAX_ITERATIONS = IS_OLLAMA ? 3 : 1
export const NO_PLAN_RUNAWAY_LIMIT = 80

// --- Work log ---
export const WORK_LOG_MAX_ENTRIES = 18
export const WORK_SUMMARY_RECENT_SEARCHES = 6
export const WORK_SUMMARY_RECENT_URLS = 5
export const WORK_SUMMARY_RECENT_ACTIONS = 6

// --- Timeouts (ms) ---
export const TIER_TIMEOUTS = {
  iterationTimeoutMs: IS_OLLAMA ? 600_000 : 12_000,    // Keep API turns from looking frozen
  inactivityTimeoutMs: IS_OLLAMA ? 120_000 : 1_500,    // Fail forward quickly from invisible provider stalls without self-cancelling normal provider pauses
  checkIntervalMs: 150,
  build: {
    contentOnlyTimeoutMs: IS_OLLAMA ? 180_000 : 1_200,
    contentOnlyMinChars: IS_OLLAMA ? 5000 : 1200,
  },
  research: {
    contentOnlyTimeoutMs: IS_OLLAMA ? 90_000 : 900,
    contentOnlyMinChars: IS_OLLAMA ? 5_000 : 700,
  },
} as const

// --- Tool execution ---
export const TOOL_TIMEOUT_MS = IS_OLLAMA ? 180_000 : 2_000
export const WEB_SEARCH_TOOL_TIMEOUT_MS = IS_OLLAMA ? 120_000 : 3_500
export const BROWSER_TOOL_TIMEOUT_MS = IS_OLLAMA ? 120_000 : 1_800
export const DOCUMENT_TOOL_TIMEOUT_MS = IS_OLLAMA ? 120_000 : 4_000
export const FILE_WRITE_TOOL_TIMEOUT_MS = IS_OLLAMA ? 8 * 60 * 1000 : 8_000

// --- File & content limits ---
export const MAX_TOOL_RESULT_CHARS = 1800
export const MAX_BROWSE_RESULT_CHARS = 1800
export const MAX_ATTACHMENT_CHARS = 15_000
export const MAX_CONTEXT_ATTACHMENT_CHARS = 80_000
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

// --- Plan manager ---
export const PLAN_STARTUP_DELAY_MS = 0
export const PLAN_MAX_RETRIES = 1
export const PLAN_RETRY_BASE_MS = 350

// --- Stream retries ---
export const STREAM_MAX_RETRIES = 0
export const STREAM_RETRY_BASE_MS = 650
export const STREAM_RETRY_EXPONENT = 1.2
export const STREAM_REQUEST_TIMEOUT_MS = 2_400
export const STREAM_RETRY_MAX_DELAY_MS = 1_500

// --- Semantic loop detection ---
export const SEMANTIC_LOOP_WINDOW = 6         // Check last N search queries for overlap
export const SEMANTIC_OVERLAP_THRESHOLD = 2   // N queries sharing core tokens = semantic loop (was 3, too late)
export const SEMANTIC_CORE_TOKENS = 3         // First N significant words form the "core"

// --- Search/token normalization ---
export const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'and', 'but',
  'or', 'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
  'just', 'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
  'those', 'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their', 'me',
  'him', 'us', 'them', 'i', 'you', 'he', 'she', 'we', 'they', 'best',
  'most', 'more', 'some', 'any', 'all', 'each', 'every', 'both', 'few',
  'many', 'much', 'other', 'such', 'only', 'same', 'also', 'well',
])

// --- Cross-tool pattern detection ---
export const CROSS_TOOL_PATTERN_WINDOW = 10   // Check last N tool calls for repeating patterns
export const CROSS_TOOL_CYCLE_LENGTH = 4      // Pattern length to detect (e.g. search→browse→search→browse)
export const CROSS_TOOL_CYCLE_REPEATS = 2     // Must repeat N times to trigger

// --- Tool type rate limiting per step ---
export const TOOL_TYPE_RATE_LIMITS: Record<string, number> = {
  web_search: 28,             // High ceiling, but not a target
  read_document: 40,          // Extraction can be frequent in serious research, but still loop-guarded
  browser_navigate: 24,       // Enough for source discovery and browser tasks without drifting
  browser_screenshot: 3,      // Screenshots are diagnostic; repeating them is usually a loop
  image_search: 8,            // Image evidence can be broad when requested
  browser_get_content: 24,    // Enough for rendered pages without repeated dumps
  browser_find_text: 24,      // Allow targeted in-page evidence checks
  browser_scroll: 40,         // Long pages and mobile flows need repeated reveals
  create_file: 24,            // Enough for multi-part manuscripts/apps
  append_file: 100,           // Long writing tasks can still append chunks
  export_pdf: 16,             // Allow re-export after revisions
  edit_file: 60,              // Revisions across large manuscripts are expected
}

// --- Diminishing returns ---
export const DIMINISHING_RETURNS_WINDOW = 4          // Check last N iterations
export const DIMINISHING_RETURNS_NEW_FACT_MIN = 1    // Need at least 1 new fact per window
export const DIMINISHING_RETURNS_TRIGGER_ITERATION = 6  // Don't check until N iterations into a step

// --- Truncation detection ---
export const TRUNCATION_MARKERS = ['...[truncated]', '... [truncated', '[Content truncated']

// --- Failure diagnosis ---
export const FAILURE_PATTERN_THRESHOLD = 3    // N related failures triggers diagnosis

// --- Last step budget enforcement ---
export const LAST_STEP_NUDGE_MULTIPLIER = 1.0    // Gentle nudge at 1x budget
export const LAST_STEP_HARD_NUDGE_MULTIPLIER = 1.5
export const LAST_STEP_TERMINATE_MULTIPLIER = 2.0

// --- Task complexity ---
export const COMPLEXITY_BUDGET_MULTIPLIERS = {
  1: 0.7,   // Simple tasks: tighter budgets, but not one-tool shallow by default
  2: 1.1,   // Moderate tasks: enough room for verification and polish
  3: 1.45,  // Complex tasks: expanded for depth, revision, and validation
} as const

// --- Circuit breaker ---
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3   // Consecutive failures to trip breaker
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000     // Time before re-enabling a tripped tool

// --- Tool health ---
export const TOOL_HEALTH_WINDOW = 15                  // Track last N calls per tool for health score

// --- Adaptive pacing ---
export const FAST_STEP_THRESHOLD = 2      // Completing in < N iterations = fast (can reduce budget for next steps)
export const SLOW_STEP_THRESHOLD = 8      // Not completing in > N iterations = slow (may need intervention)
export const PACING_BUDGET_ADJUST = 0.2   // Adjust remaining budgets by ±20% based on pacing

// --- Enhanced context trimming ---
export const CONTEXT_TRIM_PRESERVE_FINDINGS = true    // Always preserve step findings during trimming
export const CONTEXT_TRIM_SUMMARY_MAX_CHARS = 1200    // Max chars for compressed context summary

// --- Adaptive temperature ---
export const TEMPERATURE_CODE = 0.3          // Low temperature for code generation
export const TEMPERATURE_RESEARCH = 0.3      // Low for reliable instruction following in research
export const TEMPERATURE_DEFAULT = 0.7       // Default for general tasks
export const TEMPERATURE_CREATIVE = 0.8      // Higher for creative writing

// --- Progressive urgency thresholds (fraction of budget consumed) ---
export const URGENCY_GENTLE_FRACTION = 0.75
export const URGENCY_FIRM_FRACTION = 0.88
export const URGENCY_FINAL_FRACTION = 0.95

// --- Parallel tool calls ---
export const ALLOW_PARALLEL_TOOLS = false

// --- Mid-plan replanning ---
export const REPLAN_AFTER_FAILURES = 5            // Trigger replan after N failures in a single step
export const REPLAN_MAX_TIMES = 5                 // Max replans per task

// --- Step budget borrowing ---
export const STEP_BUDGET_BORROW_FRACTION = 0.3    // Can borrow up to 30% from next step
export const MIN_REMAINING_STEP_BUDGET = 3        // Never borrow below this threshold

// --- Adaptive iteration timeout ---
export const TIMEOUT_BUILD_MS = 40_000              // Build/write steps get room without multi-minute stalls
export const TIMEOUT_RESEARCH_MS = 25_000           // Research steps should recover quickly without aborting synthesis
export const TIMEOUT_BROWSER_MS = 18_000            // Browser actions recover before visible stalls feel broken

// --- Work summary ---
export const WORK_SUMMARY_MAX_CHARS = 4000         // Compact summary keeps each model turn quick

// --- URL normalization ---
export const URL_NORMALIZE_STRIP_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'fbclid', 'gclid']

// --- Search result scoring ---
export const SEARCH_RESULT_MIN_SNIPPET_LENGTH = 20     // Minimum snippet length to consider useful
export const SEARCH_MAX_RESULTS = 15                    // Max results to return per search

// --- Tool result cache ---
export const TOOL_CACHE_MAX_ENTRIES = 60
export const TOOL_CACHE_TTL_MS = 5 * 60 * 1000        // 5 minutes
export const TOOL_CACHE_MAX_SIZE_CHARS = 250_000        // ~250KB total

// --- Tool retry ---
export const TOOL_RETRY_MAX = 0                         // Max retries for transient failures
export const TOOL_RETRY_BASE_MS = 120                   // Base delay between retries
export const TOOL_RETRY_MAX_DELAY_MS = 600              // Max delay cap

// --- Enhanced working memory ---
export const WORKING_MEMORY_CORROBORATION_THRESHOLD = 0.6  // Token overlap to count as corroboration
export const WORKING_MEMORY_CONTRADICTION_THRESHOLD = 0.5  // Token overlap + opposing signal = contradiction
export const WORKING_MEMORY_HIGH_CONFIDENCE_DOMAINS = ['.gov', '.edu', '.org', 'wikipedia.org', 'nature.com', 'sciencedirect.com']
export const WORKING_MEMORY_IMPORTANCE_CORROBORATION_BONUS = 1
export const WORKING_MEMORY_MAX_IMPORTANCE = 10

// --- Reflection engine ---
export const REFLECTION_LOW_PROGRESS_THRESHOLD = 0.2
export const REFLECTION_CONSECUTIVE_LOW_TRIGGER = 2
export const REFLECTION_PROGRESS_WEIGHTS = {
  successfulCalls: 0.3,
  newFacts: 0.3,
  newSources: 0.2,
  fileProgress: 0.2,
} as const

// --- Goal tracking ---
export const GOAL_MAX_EVIDENCE_PER_STEP = 5
export const GOAL_AUTO_ADVANCE_ON_MET = true

// --- Output verification ---
export const MAX_DELIVERABLE_REVISIONS = 6
export const RESEARCH_MIN_WORDS_BY_COMPLEXITY = { 1: 180, 2: 400, 3: 900, 4: 1300, 5: 1800 } as const
export const RESEARCH_MIN_CITATIONS = 4
export const RESEARCH_MIN_PARAGRAPHS = 4
export const CREATIVE_MIN_WORDS = 800
export const BUILD_MIN_CONTENT_CHARS = 300
export const PLACEHOLDER_PATTERNS = ['[TODO]', '[INSERT', '[YOUR', 'Lorem ipsum', '[PLACEHOLDER', '{{', 'TBD']
export const OUTLINE_ONLY_THRESHOLD = 0.5  // If >50% lines are headings/bullets, it's an outline

// --- Information-triggered replanning ---
export const INFO_REPLAN_MIN_ITERATIONS = 3
export const INFO_REPLAN_COOLDOWN_ITERATIONS = 5
export const INFO_REPLAN_MIN_LOW_PROGRESS = 2  // Need 2+ consecutive low-progress iterations

// --- Parallel tool execution ---
export const PARALLEL_TOOL_MAX_CONCURRENCY = 1          // The UI and agent state assume one visible tool at a time.
export const PARALLEL_TOOL_SAFE_TOOLS = new Set<string>()

// --- Progressive tool filtering ---
export const PHASE_TOOL_FILTER: Record<string, string[]> = {
  research: [
    'web_search', 'browser_navigate', 'browser_scroll', 'browser_find_text',
    'browser_get_content',
    'image_search',
    'read_document',
    'create_file', 'edit_file', 'append_file',  // .md notes allowed (ToolPipeline blocks non-.md)
  ],
  build: [
    'create_file', 'edit_file', 'append_file', 'export_pdf', 'read_file', 'delete_file', 'list_files',
    'run_code',
    'browser_screenshot', 'browser_scroll',
    'image_search',
  ],
  deliver: [
    'create_file', 'edit_file', 'append_file', 'export_pdf', 'read_file', 'list_files',
    'run_code',
    'browser_screenshot', 'browser_scroll',
    'image_search',
  ],
}

// --- Adaptive budget rebalancing ---
export const BUDGET_REBALANCE_THRESHOLD = 0.4           // Rebalance if step used < 40% of budget
export const BUDGET_REBALANCE_MAX_BONUS = 0.5           // Max 50% bonus to remaining steps
export const BUDGET_MIN_SAVED_TO_REDISTRIBUTE = 3       // Min iterations saved to trigger rebalance

// --- Working memory ---
export const WORKING_MEMORY_MAX_ENTRIES = 60
export const WORKING_MEMORY_SUMMARY_MAX_CHARS = 1500
