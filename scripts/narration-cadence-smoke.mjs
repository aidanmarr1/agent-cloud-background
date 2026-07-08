import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [dispatcher, prompts, taskGroupView, actionFeed, taskSlice, globals, computerPanel, uiStore, policyEngine, streamProcessor, config, toolPipeline, agentLoop, cleaners, agentState] = await Promise.all([
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/lib/prompts.ts'), 'utf8'),
    readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/ActionFeed.tsx'), 'utf8'),
    readFile(join(root, 'src/store/chat/taskSlice.ts'), 'utf8'),
    readFile(join(root, 'src/app/globals.css'), 'utf8'),
    readFile(join(root, 'src/components/computer/ComputerPanel.tsx'), 'utf8'),
    readFile(join(root, 'src/store/ui.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/StreamProcessor.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/stream/cleaners.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/AgentState.ts'), 'utf8'),
  ])

  assert.match(dispatcher, /MIN_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*3/, 'narration must not flush before 3 visible actions')
  assert.match(dispatcher, /MAX_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*4/, 'narration must not wait past 4 visible actions')
  assert.doesNotMatch(dispatcher, /IMMEDIATE_SOURCE_NARRATION_TOOLS/, 'source-result narration must not bypass the 3-4 action cadence')
  assert.doesNotMatch(dispatcher, /shouldFlushModelNarrationImmediately/, 'web-search narration must not flush early')
  assert.doesNotMatch(dispatcher, /generateAutoNarration/, 'client must not invent narration from tool results')
  assert.match(dispatcher, /narration\.position === currentPosition/, 'client must reject multiple narration blocks in the same action gap')
  assert.match(dispatcher, /addGroupNarration\(this\.conversationId,\s*this\.currentGroupIdx,\s*narrationText,\s*currentPosition\)/, 'dispatcher must persist the exact current-frontier narration position')
  assert.match(taskSlice, /addGroupNarration: \(convId: string, groupIndex: number, text: string, position\?: number\)/, 'store action must accept the dispatcher-computed narration position')
  assert.match(taskSlice, /const subtasks = taskSubtasks\(g\)[\s\S]*Math\.max\(0,\s*Math\.min\(subtasks\.length,\s*position \?\? subtasks\.length\)\)/, 'store must clamp narration positions to the current frontier')
  assert.match(taskGroupView, /\.sort\(\(a, b\) => a\.position - b\.position\)/, 'main task view must render narrations in position order')
  assert.match(actionFeed, /\.sort\(\(a, b\) => a\.position - b\.position\)/, 'action feed must render narrations in position order')
  assert.match(dispatcher, /if \(this\.toolsSinceLastNarration >= TOOLS_BETWEEN_NARRATION_FLUSHES\)/, 'narration flushing must follow the global visible-action count')
  assert.match(dispatcher, /narrationInsertionPosition/, 'client must calculate the exact 3-4 action narration insertion boundary')
  assert.match(dispatcher, /Never insert it between completed/, 'late narration recovery must attach at the current frontier, not inside old history')
  assert.match(dispatcher, /discardNarrationBuffer/, 'early narration buffers must be discarded instead of carried into later tool gaps')
  assert.doesNotMatch(dispatcher, /lastPosition \+ MAX_TOOLS_BETWEEN_NARRATION_FLUSHES/, 'late narration must never be backfilled at an old fourth-action boundary')
  assert.match(dispatcher, /if \(!force && !this\.isNarrationCadenceReady\(\)\) return false[\s\S]*?const text = this\.narrationBuf\.flush\(\)/, 'client must keep buffered model narration until the 3-action cadence is ready')
  assert.match(dispatcher, /handleStepAdvance[\s\S]{0,180}this\.flushNarration\(true\)/, 'step transitions must flush required phase-end model narration even before the normal 3-action cadence')
  assert.doesNotMatch(dispatcher, /handleStepAdvance[\s\S]{0,180}this\.toolsSinceLastNarration = 0/, 'normal step transitions must not reset the global narration cadence')
  assert.match(dispatcher, /setComputerPanelActiveItemId\(panelFocusIdForTool\(event\.name,\s*event\.id\)\)/, 'new tool starts must focus their live computer panel item')
  assert.match(computerPanel, /computerPanelActiveItemId/, 'computer panel must follow the explicit active item pointer')
  assert.match(uiStore, /setComputerPanelActiveItemId/, 'UI store must expose the active computer item pointer')
  assert.match(policyEngine, /isValidProgressNarration/, 'backend must only clear forced narration after valid sanitized narration')
  assert.match(policyEngine, /isAcceptableForcedNarration/, 'forced narration repair must accept slightly relaxed but concrete progress updates')
  assert.match(policyEngine, /forcedNarrationRepairAttempts/, 'forced narration repair must have bounded attempts so it cannot deadlock the task')
  assert.match(policyEngine, /forcedNarrationRepairAttempts >= 2/, 'forced narration repair must fail open after repeated invalid text-only attempts')
  assert.match(policyEngine, /Math\.min\(NARRATION_THRESHOLD_DEFAULT - 1,\s*state\.visibleToolActionsSinceLastNarration\)/, 'forced narration repair must preserve cadence pressure after fail-open recovery')
  assert.match(policyEngine, /NARRATION CADENCE RECOVERY/, 'backend must emit a hard narration-cadence recovery after missed progress narration')
  assert.doesNotMatch(policyEngine, /state\.forceTextNextIteration = true[\s\S]{0,240}NARRATION CADENCE RECOVERY/, 'overdue narration cadence must be handled by the compact runtime path, not the repair flag')
  assert.match(policyEngine, /NARRATION CADENCE MISSED:[\s\S]*the compact progress paragraph attempt was not usable/, 'overdue narration recovery must open at the 3-action point')
  assert.match(policyEngine, /PHASE-END NARRATION REQUIRED/, 'backend must request phase-end narration only when the 3-action cadence window is open')
  assert.match(policyEngine, /visibleToolActionsSinceLastNarration >= NARRATION_THRESHOLD_DEFAULT/, 'backend must use cadence pressure, not a mandatory per-phase narration gate')
  assert.match(policyEngine, /markPhaseNarrationEmitted\(state\)/, 'backend must record accepted LLM narration on the active phase')
  assert.match(agentLoop, /phaseEndNarrationPending/, 'agent loop must track phase-end narration separately from ordinary progress narration')
  assert.match(agentLoop, /goalCheck\.allMet[\s\S]*?pauseForPhaseEndNarrationBeforeAutoAdvance[\s\S]*?planManager\.handleStepAdvance\(state\)/, 'goal-complete auto-advance must offer phase-end narration without letting it deadlock advancement')
  assert.match(agentLoop, /put <next_step\/> on its own final line/, 'compact phase-end narration must include the next_step marker instruction')
  assert.match(agentState, /phaseNarrationEmittedThisStep: boolean/, 'agent state must track whether the active phase has an accepted LLM narration')
  assert.match(agentState, /needsPhaseNarrationBeforeAdvance/, 'agent state must expose the per-phase narration invariant')
  assert.match(policyEngine, /state\.phaseEndNarrationPending[\s\S]*?!stepAdvancedThisIteration[\s\S]*?advanceStep\(state,\s*narrationFinding\)/, 'valid phase-end narration must advance even when the transition marker is missing')
  assert.match(policyEngine, /function hasStalledResearchEvidence/, 'research narration cadence must not turn same-source loops into endless status turns')
  assert.match(policyEngine, /advanceStalledResearchWithGap/, 'stalled research with real evidence must move on with a recorded gap')
  assert.doesNotMatch(agentState, /tool === 'browser_screenshot' \|\| tool === 'browser_get_content'/, 'browser_get_content must not be exempt from loop detection')
  assert.match(policyEngine, /if \(!stepAdvancedThisIteration\) return \[\]/, 'valid narration plus next_step must not be swallowed before step advancement')
  assert.match(policyEngine, /visibleActionsAfterAcceptedNarration/, 'backend must preserve overflow actions after a late forced narration')
  assert.match(agentLoop, /function shouldUseNaturalCadenceNarration[\s\S]*visibleToolActionsSinceLastNarration < NARRATION_THRESHOLD_DEFAULT[\s\S]*return true/, 'runtime must open the 3-action cadence window')
  assert.match(agentLoop, /const useCompactCadenceNarration = !useCompactForcedNarration[\s\S]*shouldUseNaturalCadenceNarration/, 'cadence narration must use the compact fast lane')
  assert.match(agentLoop, /const useCompactNarration = useCompactForcedNarration \|\| useCompactCadenceNarration/, 'ordinary cadence narration must share the compact narration-only model call')
  assert.match(agentLoop, /tierTimeoutsForIteration\([\s\S]*compactNarration = false[\s\S]*compactNarration \|\| state\.forceTextNextIteration/, 'ordinary cadence narration must use the same compact stream timeouts as forced narration')
  assert.match(agentLoop, /processedCompactNarrationTurn =[\s\S]*shouldUseNaturalCadenceNarration\(state,\s*this\.options\.messages\)[\s\S]*streamProcessor\.setTierTimeouts\(tierTimeoutsForIteration\(state,\s*this\.options\.messages,\s*processedCompactNarrationTurn\)\)/, 'stream processor must receive compact narration timeouts for cadence narration')
  assert.match(agentLoop, /lastStreamWasCompactNarration[\s\S]*!lastStreamWasCompactNarration[\s\S]*shouldUseCompactResearchTurn/, 'compact narration turns must not be intercepted by compact research no-tool recovery')
  assert.match(agentLoop, /FAST PROGRESS NARRATION ONLY[\s\S]*Do not solve, plan, browse, search, write files, or call tools/, 'cadence narration must not wait on same-turn tool selection')
  assert.match(toolPipeline, /The 3-action window is a hard gate/, 'tool execution must hard-gate the fourth visible action until narration is accepted')
  assert.match(toolPipeline, /this visible tool call was skipped because 3 visible actions/, 'tool execution must block the fourth visible action when narration is overdue')
  assert.match(toolPipeline, /visibleToolActionsSinceLastNarration\+\+[\s\S]*state\.forceTextNextIteration = true/, 'executed visible actions must arm narration immediately at the 3-action boundary')
  assert.match(config, /NARRATION_THRESHOLD_DEFAULT\s*=\s*3/, 'default narration threshold must open the 3-4 action narration window')
  assert.match(config, /NARRATION_THRESHOLD_BROWSER\s*=\s*3/, 'browser-heavy tasks must enter the 3-4 narration window after 3 visible actions')
  assert.match(streamProcessor, /recordVisibleToolStartForNarration/, 'provisional file/code tool starts must count toward the same visible narration cadence as executed tools')
  assert.match(streamProcessor, /visibleToolActionsSinceLastNarration\+\+[\s\S]*state\.forceTextNextIteration = true/, 'provisional visible actions must arm narration immediately at the 3-action boundary')
  assert.match(streamProcessor, /function addProvisionalFileActionLabel[\s\S]*args\.action_label/, 'file writes must be able to show a provisional pill before long content finishes streaming')
  assert.match(streamProcessor, /addProvisionalRuntimeDisplayContract\(earlyArgs,\s*toolCall\.name,\s*state\)/, 'missing display-only metadata must not delay visible tool starts')
  assert.match(streamProcessor, /lastVisibleActivityTime/, 'stream processor must track user-visible activity separately from invisible reasoning chunks')
  assert.match(streamProcessor, /visibleInactivityExpired/, 'invisible-only reasoning stalls must trigger recovery instead of waiting for the full iteration timeout')
  assert.match(streamProcessor, /PROGRESS_NARRATION_TEXT_STREAM_CAP\s*=\s*420/, 'progress narration should still have a short visible text cap')
  assert.doesNotMatch(streamProcessor, /progressNarrationTextCap !== null[\s\S]{0,240}abortStreamingResponse\(\)/, 'clipped progress narration must keep draining so usage and same-turn tool calls can arrive')
  assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 1_500/, 'API inactivity timeout must recover quickly instead of leaving the UI in invisible thinking')
  assert.match(config, /checkIntervalMs:\s*150/, 'stream inactivity checks should run quickly enough to keep thinking state honest')
  assert.match(prompts, /Do not narrate with fewer than 3 new visible actions, and never go past 4 visible actions/, 'agent prompt must enforce the exact 3-4 action narration window')
  assert.match(prompts, /never fewer than 15 words/, 'agent prompt must forbid too-short progress narration')
  assert.match(prompts, /1-2 complete sentences/, 'agent prompt must define short paragraph cadence')
  assert.match(prompts, /default shape is one strong past-tense result sentence/i, 'agent prompt must not force every progress paragraph to include a Next sentence')
  assert.match(prompts, /Do not force a Next sentence just to sound busy/, 'agent prompt must make Next/future-focus narration optional')
  assert.match(prompts, /result-first/, 'agent prompt must request result-first evidence narration')
  assert.match(prompts, /At exactly 3 visible actions, start the next response/, 'agent prompt must make narration happen before the next action')
  assert.match(prompts, /standing cadence for every phase/, 'agent prompt must frame narration as a per-phase cadence, not only research narration')
  assert.match(prompts, /narration is the default first visible text/, 'agent prompt must make narration the preferred first visible text at the 3-action window')
  assert.match(prompts, /before <next_step\/> if the current phase is complete/, 'agent prompt must allow narration at the end of a phase before next_step')
  assert.match(prompts, /Phase-end narration is allowed and expected/, 'agent prompt must not wait for an extra tool call at phase end')
  assert.match(prompts, /vary the opening verb and sentence shape/, 'agent prompt must require varied progress narration openings')
  assert.match(prompts, /Never ask permission to continue an active task/, 'agent prompt must ban lazy opt-in handoffs during active tasks')
  assert.match(agentLoop, /Never ask permission to continue or write opt-in handoffs/, 'runtime narration nudges must ban permission-to-continue progress text')
  assert.match(agentLoop, /Default to one strong past-tense result sentence; add a short Next\/Will sentence only when it is specific and useful/, 'compact narration runtime must mirror Manus-style optional Next sentences')
  assert.match(cleaners, /PERMISSION_TO_CONTINUE_PATTERN/, 'narration cleaners must reject permission-to-continue handoff text')
  assert.match(taskGroupView, /task-thread-body/, 'task group view must render a subtle timeline body')
  assert.match(taskGroupView, /InlineThinkingIndicator/, 'task group view must show inline thinking while the model is deciding after visible actions')
  assert.match(taskGroupView, /streamingStatus === 'thinking'/, 'inline thinking must be tied to the real streaming thinking state')
  assert.match(taskGroupView, /!hasRunningVisibleSubtask/, 'inline thinking must not show while a tool/action pill is actively running')
  assert.match(taskGroupView, /task-inline-thinking-row/, 'inline thinking must render outside the timeline body so it does not extend the phase rail')
  assert.match(taskGroupView, /className="task-thread-body[\s\S]*?\n\s*<\/div>\n\n\s*\{showInlineThinking/, 'inline thinking must be placed after task-thread-body, not inside the timeline rail')
  assert.match(globals, /\.task-thread-body::before/, 'timeline body styling must be present')
}

async function assertNarrationRuntime() {
  const workDir = await mkdtemp(join(root, 'scripts/.narration-cadence-smoke-runner-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { cleanThinkingTags, sanitizeNarrationText, stripNarrationArtifacts, stripToolActionNarration } from ${JSON.stringify(join(root, 'src/lib/stream/cleaners.ts'))}
import { strictActionLabelFromArgs } from ${JSON.stringify(join(root, 'src/lib/stream/ActivityDescriber.ts'))}

export function runNarrationSmoke() {
  assert.equal(sanitizeNarrationText('Click the "Update" button to confirm the prompt.'), null)
  assert.equal(sanitizeNarrationText('This indicates that the action was ineffective.'), null)
  assert.equal(sanitizeNarrationText('Synthesize these findings to explain why Manus AI is distinct from standard LLM assistants.'), null)
  assert.equal(sanitizeNarrationText("I will now synthesize these findings into a comparative report on Manus AI's differentiation."), null)
  assert.equal(sanitizeNarrationText('Navigate to any official government publications or reputable legal analysis sites detailing these amendments.'), null)
  assert.equal(sanitizeNarrationText('state/territory). This decision suggests a stance of not weakening existing copyright protections for creators.'), null)
  assert.equal(sanitizeNarrationText('or reputable legal analysis sites detailing these amendments. state actions and the status of legal reviews.'), null)
  assert.equal(sanitizeNarrationText('Compile findings into a comprehensive report.'), null)
  assert.equal(sanitizeNarrationText('artificialanalysis.ai shows for more details including relating to our methodology, see our FAQs.'), null)
  assert.equal(sanitizeNarrationText('I have sufficient evidence for Step 1.'), null)
  assert.equal(sanitizeNarrationText('I have examined the Australian Framework for Generative AI in Schools, which establishes a national approach to the ethical and responsible The framework emphasises that AI should be used to benefit students.'), null)
  assert.equal(sanitizeNarrationText('If you want, I can continue with the next layer on capabilities and pricing.', { requireSignal: true }), null)
  assert.equal(stripToolActionNarration('Manus AI is positioned as a hands-on agent for business deliverables. If you want, I can continue with capabilities and pricing.'), 'Manus AI is positioned as a hands-on agent for business deliverables.')
  assert.equal(sanitizeNarrationText('Review the College Board I have identified significant institutional and educator concerns regarding AI in high schools.'), null)
  assert.equal(sanitizeNarrationText('Access the Frontiers systematic review to I have identified key socio-ethical risks associated with AI in education.'), null)
  assert.equal(sanitizeNarrationText('gather evidence on those issues.'), null)
  assert.equal(sanitizeNarrationText("gather more details from the page to confirm the movie she plays in.The YouTube video at the link appears to be a short clip featuring a woman, but I couldn't extract the video content, title, or description from the page.", { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText("review what we've gathered so far and identify the key evidence gaps for this phase on limitations, risks, and ethical concerns.", { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText('Confirm café option selected and move to Location 3.', { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText('Confirmed café option selected.', { requireSignal: true }), null)
  assert.equal(
    stripNarrationArtifacts('Found the YouTube page did not expose a title, description, or transcript from that URL.The source still confirms it was a video page.'),
    'Found the YouTube page did not expose a title, description, or transcript from that URL. The source still confirms it was a video page.',
  )
  assert.equal(
    stripToolActionNarration('I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries. now read the most promising source on expert AGI timeline'),
    'I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries.',
  )
  assert.equal(
    sanitizeNarrationText('I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries. now read the most promising source on expert AGI timeline', { requireSignal: true }),
    'I found two relevant AGI timeline sources from the latest search results, including expert survey pages and forecast summaries.',
  )
  assert.equal(
    sanitizeNarrationText("The The analysis of Apple's ecosystem lock-in shows that 90% of iPhone users remain loyal because iCloud and App Store integration reduce switching.", { requireSignal: true }),
    "The analysis of Apple's ecosystem lock-in shows that 90% of iPhone users remain loyal because iCloud and App Store integration reduce switching.",
  )
  const dsmlToolText = '<｜｜DSML｜｜tool_calls>\\n<｜｜DSML｜｜invoke name="web_search">\\n<｜｜DSML｜｜parameter name="query" string="true">DevRev AI funding</｜｜DSML｜｜parameter>\\n</｜｜DSML｜｜invoke>\\n</｜｜DSML｜｜tool_calls>'
  assert.equal(cleanThinkingTags(dsmlToolText).trim(), '')
  assert.equal(stripToolActionNarration(dsmlToolText).trim(), '')
  assert.equal(cleanThinkingTags('**FINAL ANSWER REQUIRED:** Do not write another progress update.\\n\\n# DevRev AI Report').trim(), '# DevRev AI Report')
  assert.equal(stripToolActionNarration('Deliverable step: write the report in chat\\n\\nDevRev unifies product and support data.').trim(), 'DevRev unifies product and support data.')
  assert.equal(strictActionLabelFromArgs({ action_label: 'Researching AI tools for essay planning' }), null)
  assert.equal(strictActionLabelFromArgs({ action_label: 'search expert predictions 2025 agentic ai shift.' }), 'Search expert predictions 2025 agentic ai shift')
  assert.equal(strictActionLabelFromArgs({ action_label: 'Compare student AI writing tools' }), 'Compare student AI writing tools')
  assert.equal(
    strictActionLabelFromArgs({
      action_label: 'Track latest technical breakthroughs in AI',
      query: 'latest technical breakthroughs in AI',
    }),
    'Track latest technical breakthroughs in AI',
  )
  assert.equal(
    stripToolActionNarration("Australia is handling AI copyright issues federally. 2. Navigate to official government publications or reputable legal analysis sites detailing these amendments. 3. Synthesize all gathered information to provide a comprehensive answer on Australia’s response to AI copyright issues, including national vs. state actions and the status of legal reviews. 4. Compile findings into a comprehensive report. The Australian federal government is actively addressing copyright issues related to generative AI."),
    "Australia is handling AI copyright issues federally. The Australian federal government is actively addressing copyright issues related to generative AI.",
  )
  assert.equal(
    sanitizeNarrationText("DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.", { requireSignal: true }),
    "DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.",
  )
  assert.equal(
    sanitizeNarrationText('Generated and verified eight visualizations for the report, including market growth and adoption gap charts.', { requireSignal: true }),
    'Generated and verified eight visualizations for the report, including market growth and adoption gap charts.',
  )
  assert.equal(
    sanitizeNarrationText('Gathered12 deduped rumor candidates from4 source angles, including the latest MacRumors roundup on iPhone17 expected features and release timeline.', { requireSignal: true }),
    'Gathered 12 deduped rumor candidates from 4 source angles, including the latest MacRumors roundup on iPhone 17 expected features and release timeline.',
  )
  assert.equal(
    sanitizeNarrationText("I've gathered initial I have several promising leads including a deep learning chapter, a step-by-step transformer explanation, and a Medium article on multi-head attention.", { requireSignal: true }),
    "I've found several promising leads including a deep learning chapter, a step-by-step transformer explanation, and a Medium article on multi-head attention.",
  )
  assert.equal(
    sanitizeNarrationText('Since the last narration, I completed 4 targeted searches covering AI alignment challenges, hallucination mitigation I now have a solid evidence base across all sub-topics in this phase.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Since the last progress paragraph, I've completed searches on AI model benchmarks, major company funding rounds, and AI market size forecasts.", { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Completed 5 web searches covering AI's GDP contribution, productivity gains, industry transformation, and economic impact statistics.", { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Completed 4 web searches covering bird migration and feeding ecology, and read the Wikipedia Bird page.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('All five searches for bird conservation statistics failed with unknown errors, so the phase moved on to preserve the remaining plan budget.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText('Synthesized key 2026 breakthroughs in agentic reasoning and multimodal memory architectures from recent technical reports and industry analysis.', { requireSignal: true }),
    null,
  )
  assert.equal(
    sanitizeNarrationText("Confirmed light to moderate rain around 5:30-6:15 PM in Ryde, NSW via Zoom Earth. Will verify other sources like BOM and Weatherzone for consolidated forecast.", { requireSignal: true }),
    "Confirmed light to moderate rain around 5:30-6:15 PM in Ryde, NSW via Zoom Earth. Will verify other sources like BOM and Weatherzone for consolidated forecast.",
  )
  assert.equal(
    sanitizeNarrationText("Discovered parrotlets are highly intelligent, feisty, and affectionate, with unique color variations, long lifespan up to 30 years, and quiet, playful personalities suitable for small spaces. Next, I'll gather visual assets.", { requireSignal: true }),
    "Discovered parrotlets are highly intelligent, feisty, and affectionate, with unique color variations, long lifespan up to 30 years, and quiet, playful personalities suitable for small spaces. Next, I'll gather visual assets.",
  )
  assert.equal(
    sanitizeNarrationText("Found that crossing 1.5°C warming triggers irreversible climate tipping points, like ice sheet collapse and coral reef dieback, significantly increasing global risks. Will synthesize detailed projections next.", { requireSignal: true }),
    "Found that crossing 1.5°C warming triggers irreversible climate tipping points, like ice sheet collapse and coral reef dieback, significantly increasing global risks. Will synthesize detailed projections next.",
  )
  assert.equal(
    sanitizeNarrationText("Successfully selected \\"Cafe operation\\" via custom autocomplete. Will proceed with entering details on the website to access licensing info for NSW cafes.", { requireSignal: true }),
    "Successfully selected \\"Cafe operation\\" via custom autocomplete. Will proceed with entering details on the website to access licensing info for NSW cafes.",
  )
  assert.equal(
    sanitizeNarrationText("Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.", { requireSignal: true }),
    "Confirmed the café option is selected and the workflow is ready for the location step. Next, I'll enter the Location 3 details and verify the form accepts them.",
  )
  assert.equal(
    sanitizeNarrationText("I've gathered and saved high-quality images of colorful parrotlets, including adults and babies, to enhance the visual appeal of the presentation on their traits and diversity. Next, I'll outline the slide content.", { requireSignal: true }),
    "I've gathered and saved high-quality images of colorful parrotlets, including adults and babies, to enhance the visual appeal of the presentation on their traits and diversity. Next, I'll outline the slide content.",
  )
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

    const { runNarrationSmoke } = await import(pathToFileURL(bundlePath).href)
    runNarrationSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await assertSourceContracts()
await assertNarrationRuntime()
console.log('narration cadence smoke checks passed')
