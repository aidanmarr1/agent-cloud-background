import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [creditStore, creditPolicy, modelPricing, serverCredits, usageTab, globalsCss, dispatcher, chatRoute, agentLoop, planManager, llm, toolPipeline, emitter, events, useAgentStream, streamProcessor] = await Promise.all([
    readFile(join(root, 'src/store/credits.ts'), 'utf8'),
    readFile(join(root, 'src/lib/creditPolicy.ts'), 'utf8'),
    readFile(join(root, 'src/lib/modelPricing.ts'), 'utf8'),
    readFile(join(root, 'src/lib/serverCredits.ts'), 'utf8'),
    readFile(join(root, 'src/components/modals/settings/UsageTab.tsx'), 'utf8'),
    readFile(join(root, 'src/app/globals.css'), 'utf8'),
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
    readFile(join(root, 'src/lib/llm.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/SSEEmitter.ts'), 'utf8'),
    readFile(join(root, 'src/types/events.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
  ])

  assert.match(creditPolicy, /CREDITS_PER_USD\s*=\s*1000/, 'credit policy must define a stable credit-to-USD conversion')
  assert.match(modelPricing, /DEFAULT_OPENROUTER_MODEL = 'google\/gemini-2\.5-flash-lite'/, 'default model must be Gemini 2.5 Flash Lite')
  assert.match(modelPricing, /inputUsdPer1M:\s*0\.10/, 'Gemini 2.5 Flash Lite input pricing must match OpenRouter')
  assert.match(modelPricing, /outputUsdPer1M:\s*0\.40/, 'Gemini 2.5 Flash Lite output pricing must match OpenRouter')
  assert.match(modelPricing, /contextTokens:\s*1_000_000/, 'Gemini 2.5 Flash Lite context window must match OpenRouter')
  assert.match(modelPricing, /maxCompletionTokens:\s*65_535/, 'Gemini 2.5 Flash Lite max output token cap must match provider docs')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.inputUsdPer1M/, 'model input pricing must come from the active model pricing table')
  assert.match(creditPolicy, /DEFAULT_MODEL_PRICING\.outputUsdPer1M/, 'model output pricing must come from the active model pricing table')
  assert.match(creditPolicy, /BRAVE_SEARCH_USD_PER_1K_REQUESTS\s*=\s*5/, 'web search pricing must be anchored to Brave Search API request pricing')
  assert.match(creditPolicy, /IMAGE_SEARCH_USD_PER_1K_REQUESTS\s*=\s*0/, 'image search must not be charged as Brave Search traffic')
  assert.match(creditPolicy, /TASK_START_CREDITS\s*=\s*0/, 'task starts must not create a fixed upfront debit')
  assert.match(creditPolicy, /LOCAL_BROWSER_USD_PER_STEP\s*=\s*0/, 'local browser actions must not use Browser Use Cloud pricing')
  assert.match(creditPolicy, /ACTIVE_CREDITS_PER_MINUTE\s*=\s*0/, 'passive wall-clock runtime must not be billable')
  assert.match(creditStore, /toolCreditCharge\(toolName\)/, 'credit store must use centralized tool pricing')
  assert.match(creditStore, /tokenUsageCreditCharge\(usage\)/, 'credit store must use prompt/completion token pricing')
  assert.match(creditStore, /creditSyncInFlight/, 'client credit sync must dedupe concurrent refreshes')
  assert.match(creditStore, /CREDIT_SYNC_TIMEOUT_MS\s*=\s*4_000/, 'client credit sync must be bounded so sends cannot hang indefinitely')
  assert.match(creditStore, /controller\.abort\(\)/, 'client credit sync must abort slow credit reads')
  assert.match(serverCredits, /recordServerCreditEvent/, 'server must persist authoritative credit ledger entries')
  assert.match(serverCredits, /tursoTransaction\('write'/, 'server ledger must write balance and usage entries transactionally')
  assert.match(serverCredits, /where user_id = \? and id = \?/, 'server ledger must dedupe charges by idempotency key')
  assert.match(serverCredits, /SERVER_LEDGER_MAX_ENTRIES\s*=\s*200/, 'server credit snapshot should only read the ledger entries the client displays')
  assert.match(serverCredits, /TASK_START_CREDITS <= 0\) return null/, 'task start credit function must be a no-op when no real cost exists')
  assert.match(serverCredits, /chargeServerActiveTime/, 'active runtime credits must be server-recorded')
  assert.match(serverCredits, /chargeServerTool/, 'tool credits must be server-recorded at execution time')
  assert.match(serverCredits, /chargeServerTokenUsage/, 'token credits must be server-recorded from provider usage')
  assert.match(serverCredits, /OutOfCreditsError/, 'server credit ledger must expose a typed out-of-credits cutoff')
  assert.match(serverCredits, /requiredCredits = safeRequired/, 'server credit errors must expose the attempted required balance')
  assert.match(serverCredits, /MINIMUM_PROVIDER_CALL_CREDITS\s*=\s*0/, 'positive balances must be allowed to continue until a billable call drains them')
  assert.match(serverCredits, /minimumCredits = MINIMUM_PROVIDER_CALL_CREDITS/, 'server credit availability checks must default to the provider-call runway')
  assert.match(serverCredits, /Math\.min\(requestedAmount,\s*currentBalance\)/, 'over-budget billable calls must debit the remaining balance instead of rejecting a positive balance')
  assert.match(serverCredits, /set monthly_balance = 0/, 'over-budget billable calls must clamp the server balance to exactly zero')
  assert.doesNotMatch(serverCredits, /currentBalance - amount/, 'server credit charges must not compute or persist a negative balance')
  assert.match(serverCredits, /requestedAmount > currentBalance/, 'server credit charges must detect over-budget calls and drain the remaining balance')
  assert.match(serverCredits, /where user_id = \? and monthly_balance >= \?/, 'server credit debits must be guarded by an atomic non-negative DB update')
  assert.match(serverCredits, /credit_accounts_nonnegative_insert/, 'credit account inserts must be protected by a non-negative DB trigger')
  assert.match(serverCredits, /credit_accounts_nonnegative_update/, 'credit account updates must be protected by a non-negative DB trigger')
  assert.match(serverCredits, /credit_ledger_balance_after_nonnegative_insert/, 'credit ledger inserts must not record negative post-charge balances')
  assert.match(serverCredits, /throw new OutOfCreditsError\(result\.record,\s*result\.balanceAfter,\s*result\.requestedAmount\)/, 'server must stop immediately when a charge reaches zero credits')
  assert.match(serverCredits, /topUpServerCredits/, 'server must expose an explicit credit top-up helper')
  assert.match(usageTab, /\.filter\(\(entry\) => entry\.amount < 0\)/, 'Usage tab must include credit additions from negative adjustment ledger entries')
  assert.match(usageTab, /Agent Admin credited account/, 'Usage tab must plainly state when Agent Admin credited the account')
  assert.match(usageTab, /Ledger trace: \{row\.id\}/, 'Usage tab must show the credit ledger id for admin traces')
  assert.match(globalsCss, /--success-solid:\s*#[0-9a-f]{6};/i, 'global CSS must expose an official dark-green success solid token')
  assert.match(globalsCss, /--color-success-solid:\s*var\(--success-solid\)/, 'Tailwind theme must expose the official success token family')
  assert.match(usageTab, /bg-\[var\(--success-bg\)\][\s\S]*text-\[var\(--success-text\)\][\s\S]*\+\{formatSpend\(row\.amount\)\}/, 'Usage tab must render added credits as a positive amount with official dark-green success tokens')
  assert.match(emitter, /creditEvent\(entry: CreditLedgerEvent\)/, 'SSE must expose server credit ledger events')
  assert.match(events, /type: 'credit_event'/, 'credit events must be part of the stream contract')
  assert.match(dispatcher, /SERVER_CREDIT_ACCOUNTING\s*=\s*true/, 'client stream must use server-authoritative accounting')
  assert.match(dispatcher, /applyServerCreditEvent\(entry\)/, 'client credit store must mirror server ledger events')
  assert.match(dispatcher, /if \(SERVER_CREDIT_ACCOUNTING\) return/, 'client must not double-charge tool starts/results under server accounting')
  assert.match(dispatcher, /usage && !SERVER_CREDIT_ACCOUNTING/, 'client must not double-charge token usage under server accounting')
  assert.match(useAgentStream, /chargeStart:\s*false/, 'stream start must not locally charge task start under server accounting')
  assert.doesNotMatch(useAgentStream, /setInterval\(\(\) => \{\s*useCreditStore\.getState\(\)\.heartbeat/, 'client heartbeat must not be the authority for active processing credits')
  assert.match(toolPipeline, /emitServerToolCharge\(tc\.id,\s*tc\.name\)/, 'actual tool execution must emit a server charge after preflight/cache checks')
  assert.match(toolPipeline, /chargeServerTool\(this\.userId,\s*this\.conversationId,\s*toolName,\s*toolCallId,\s*this\.creditRunId\)/, 'tool pipeline must call the server credit ledger')
  assert.match(chatRoute, /chargeServerTaskStart/, 'chat route must charge task start on the server')
  assert.match(chatRoute, /ACTIVE_CREDITS_PER_MINUTE > 0/, 'chat route must guard passive active-time billing behind the disabled rate')
  assert.match(chatRoute, /assertServerCreditsAvailable\(userId\)/, 'chat route must reject new tasks before streaming when credits are already exhausted')
  assert.match(chatRoute, /for \(let attempt = 0; attempt <= DIRECT_CHAT_MAX_CONTINUATIONS; attempt\+\+\) \{[\s\S]*await assertServerCreditsAvailable\(userId\)[\s\S]*createCompletion/, 'direct chat continuations must preflight credit runway before each provider call')
  assert.match(chatRoute, /status:\s*402/, 'chat route must return payment-required status for exhausted credits')
  assert.match(chatRoute, /emitOutOfCreditsStop/, 'chat route must emit a visible stream stop when credits run out mid-task')
  assert.match(chatRoute, /chargeServerTokenUsage/, 'direct chat must charge token usage on the server')
  assert.match(chatRoute, /normalizeProviderUsage\(response\.usage\)/, 'direct chat must normalize provider usage before charging')
  assert.match(chatRoute, /assistant provider did not return billable usage/, 'direct chat must fail closed when provider cost is missing')
  assert.match(llm, /usage:\s*\{\s*include:\s*true\s*\}/, 'OpenRouter requests must explicitly request usage data for compatibility')
  assert.match(llm, /GENERATION_URL = `\$\{OPENROUTER_BASE_URL\}\/generation`/, 'OpenRouter generation metadata endpoint must be available for exact usage recovery')
  assert.match(llm, /fetchGenerationUsage/, 'missing inline usage must be resolved through exact OpenRouter generation metadata')
  assert.match(streamProcessor, /fetchGenerationUsage\(generationId \|\| undefined\)/, 'streamed agent calls must resolve exact usage from generation metadata when final usage chunks are missing')
  assert.match(planManager, /recordCompletionUsage\(res\.usage/, 'planning LLM calls must emit live billable usage')
  assert.match(planManager, /preflightCredit/, 'planner LLM calls must support a server credit runway preflight')
  assert.match(planManager, /await this\.assertCreditRunway\('ack'\)[\s\S]*createCompletion/, 'planner acknowledgement calls must preflight credits before provider work')
  assert.match(planManager, /await this\.assertCreditRunway\('initial'\)[\s\S]*createCompletion/, 'initial planner calls must preflight credits before provider work')
  assert.match(planManager, /await this\.assertCreditRunway\('replan'\)[\s\S]*createCompletion/, 'planner replans must preflight credits before provider work')
  assert.match(planManager, /BILLABLE_USAGE_ERROR/, 'planning must fail closed when provider cost is missing')
  assert.match(agentLoop, /`tokens:\$\{state\.iterations\}`/, 'agent-loop tasks must charge model token usage each iteration so zero-credit cutoff is immediate')
  assert.match(agentLoop, /recordPlannerUsage/, 'planner and acknowledgement LLM calls must be charged through the server ledger')
  assert.match(agentLoop, /assertPlannerCreditRunway[\s\S]*new PlanManager\(this\.emitter,\s*planningMessages,\s*complexity,\s*requiredFirstSteps,\s*customInstructions,\s*recordPlannerUsage,\s*assertPlannerCreditRunway\)/, 'AgentLoop must wire planner provider calls through credit runway preflight')
  assert.match(agentLoop, /await assertServerCreditsAvailable\(this\.options\.userId\)[\s\S]*createStreamingCompletion/, 'streaming agent model calls must preflight credit runway before provider work')
  assert.doesNotMatch(agentLoop, /chargeServerTokenUsage\(this\.options\.userId,\s*this\.options\.conversationId,\s*this\.options\.creditRunId,\s*totalUsage\)/, 'agent-loop tasks must not double-charge final cumulative token usage')
  assert.match(agentLoop, /this\.emitter\.done\(totalUsage\)/, 'agent-loop tasks must still report final cumulative token usage to the client')
  assert.match(useAgentStream, /OUT_OF_CREDITS_MESSAGE/, 'client stream must show exhausted-credit messaging')
  assert.match(useAgentStream, /response\.status === 402/, 'client stream must recognize server credit cutoff responses')
  assert.match(useAgentStream, /syncFromServer\(\{ force: true \}\)/, 'credit cutoff handling must force a fresh server balance refresh instead of using the throttled cache')
}

async function assertPricingRuntime() {
  const workDir = await mkdtemp(join(root, 'scripts/.credit-accounting-smoke-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  CREDIT_RATES,
  roundCreditAmount,
  tokenUsageCreditCharge,
  toolCreditCharge,
} from ${JSON.stringify(join(root, 'src/lib/creditPolicy.ts'))}
import {
  chargeServerActiveTime,
  chargeServerTaskStart,
  chargeServerTokenUsage,
  chargeServerTool,
  getServerCreditSnapshot,
  initializeAccountCredits,
  isOutOfCreditsError,
  readServerCreditLedger,
} from ${JSON.stringify(join(root, 'src/lib/serverCredits.ts'))}
import { getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { rm } from 'node:fs/promises'

export async function runCreditPricingSmoke() {
  assert.equal(CREDIT_RATES.creditsPerUsd, 1000)
  assert.equal(CREDIT_RATES.webSearchCredits, 5)
  assert.equal(CREDIT_RATES.imageSearchCredits, 0)
  assert.equal(CREDIT_RATES.browserStepCredits, 0)
  assert.equal(CREDIT_RATES.inputTokenCreditsPer1K, roundCreditAmount(CREDIT_RATES.modelInputUsdPer1M))
  assert.equal(CREDIT_RATES.outputTokenCreditsPer1K, roundCreditAmount(CREDIT_RATES.modelOutputUsdPer1M))
  assert.equal(toolCreditCharge('web_search'), 5)
  assert.equal(toolCreditCharge('image_search'), 0)
  assert.equal(toolCreditCharge('browser_navigate'), 0)
  assert.equal(toolCreditCharge('browser_click_at'), 0)
  assert.equal(toolCreditCharge('browser_screenshot'), 0)
  assert.equal(toolCreditCharge('create_file'), 0)
  assert.equal(toolCreditCharge('read_file'), 0)
  assert.equal(toolCreditCharge('unknown_local_tool'), 0)
  const expectedTokenCharge = roundCreditAmount(0.00123 * CREDIT_RATES.creditsPerUsd)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000 }), 0)
  assert.equal(tokenUsageCreditCharge({ promptTokens: 1000, completionTokens: 1000, cost: 0.00123 }), expectedTokenCharge)

  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    return
  }

  const conversationId = 'credit-smoke-' + Date.now()
  const userId = conversationId
  const runId = 'run-smoke'
  try {
    const firstStart = await chargeServerTaskStart(userId, conversationId, runId)
    const duplicateStart = await chargeServerTaskStart(userId, conversationId, runId)
    assert.equal(firstStart, null)
    assert.equal(duplicateStart, null)
    const activeCharge = await chargeServerActiveTime(userId, conversationId, runId, 1, 6000)
    assert.equal(activeCharge, null)
    await chargeServerTool(userId, conversationId, 'web_search', 'tool-1', runId)
    await chargeServerTool(userId, conversationId, 'browser_navigate', 'tool-browser', runId)
    await chargeServerTool(userId, conversationId, 'browser_screenshot', 'tool-2', runId)
    await chargeServerTokenUsage(userId, conversationId, runId, { promptTokens: 1000, completionTokens: 1000, cost: 0.00123 })
    const ledger = await readServerCreditLedger(userId)
    assert.equal(ledger.entries.filter((entry) => entry.id === \`credit:\${runId}:task-start\`).length, 0)
    assert.ok(!ledger.entries.some((entry) => entry.category === 'time'))
    assert.ok(ledger.entries.some((entry) => entry.toolName === 'web_search' && entry.amount === 5))
    assert.ok(!ledger.entries.some((entry) => entry.toolName === 'browser_navigate'))
    assert.ok(!ledger.entries.some((entry) => entry.toolName === 'browser_screenshot'))
    assert.ok(ledger.entries.some((entry) => entry.category === 'tokens' && entry.amount === expectedTokenCharge))

    const overdrawUserId = \`\${conversationId}-overdraw\`
    const overdrawConversationId = \`\${conversationId}-overdraw-task\`
    await initializeAccountCredits(overdrawUserId, { monthlyAllowance: 2, monthlyBalance: 2 })
    await assert.rejects(
      () => chargeServerTool(overdrawUserId, overdrawConversationId, 'web_search', 'tool-overdraw', 'run-overdraw'),
      (error) => isOutOfCreditsError(error) && error.code === 'OUT_OF_CREDITS' && error.balanceAfter === 0,
    )
    const overdrawSnapshot = await getServerCreditSnapshot(overdrawUserId)
    assert.equal(overdrawSnapshot.balance.monthly, 0)
    assert.ok(overdrawSnapshot.balance.monthly >= 0)
    assert.ok(overdrawSnapshot.ledger.some((entry) => entry.id === 'credit:tool-overdraw:tool:web_search' && entry.amount === 2))
  } finally {
    await rm(getSandboxDirPath(conversationId), { recursive: true, force: true })
  }
}
`, 'utf8')

    await build({
      entryPoints: [runnerPath],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      logLevel: 'silent',
    })

    const { runCreditPricingSmoke } = await import(pathToFileURL(bundlePath).href)
    await runCreditPricingSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await assertSourceContracts()
await assertPricingRuntime()
console.log('credit accounting smoke checks passed')
