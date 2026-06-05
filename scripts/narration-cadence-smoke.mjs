import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [dispatcher, prompts, taskGroupView, actionFeed, taskSlice, globals, computerPanel, uiStore, policyEngine, streamProcessor, config, toolPipeline, agentLoop] = await Promise.all([
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
  ])

  assert.match(dispatcher, /MIN_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*3/, 'narration must not flush before 3 visible actions')
  assert.match(dispatcher, /MAX_TOOLS_BETWEEN_NARRATION_FLUSHES\s*=\s*4/, 'narration must not wait past 4 visible actions')
  assert.doesNotMatch(dispatcher, /IMMEDIATE_SOURCE_NARRATION_TOOLS/, 'source-result narration must not bypass the 3-4 action cadence')
  assert.doesNotMatch(dispatcher, /shouldFlushModelNarrationImmediately/, 'web-search narration must not flush early')
  assert.doesNotMatch(dispatcher, /generateAutoNarration/, 'client must not invent narration from tool results')
  assert.match(dispatcher, /narration\.position === currentPosition/, 'client must reject multiple narration blocks in the same action gap')
  assert.match(dispatcher, /addGroupNarration\(this\.conversationId,\s*this\.currentGroupIdx,\s*narrationText,\s*currentPosition\)/, 'dispatcher must persist the exact current-frontier narration position')
  assert.match(taskSlice, /addGroupNarration: \(convId: string, groupIndex: number, text: string, position\?: number\)/, 'store action must accept the dispatcher-computed narration position')
  assert.match(taskSlice, /Math\.max\(0,\s*Math\.min\(g\.subtasks\.length,\s*position \?\? g\.subtasks\.length\)\)/, 'store must clamp narration positions to the current frontier')
  assert.match(taskGroupView, /\.sort\(\(a, b\) => a\.position - b\.position\)/, 'main task view must render narrations in position order')
  assert.match(actionFeed, /\.sort\(\(a, b\) => a\.position - b\.position\)/, 'action feed must render narrations in position order')
  assert.match(dispatcher, /if \(this\.toolsSinceLastNarration >= TOOLS_BETWEEN_NARRATION_FLUSHES\)/, 'narration flushing must follow the global visible-action count')
  assert.match(dispatcher, /narrationInsertionPosition/, 'client must calculate the exact 3-4 action narration insertion boundary')
  assert.match(dispatcher, /Never insert it between completed/, 'late narration recovery must attach at the current frontier, not inside old history')
  assert.match(dispatcher, /discardNarrationBuffer/, 'early narration buffers must be discarded instead of carried into later tool gaps')
  assert.doesNotMatch(dispatcher, /lastPosition \+ MAX_TOOLS_BETWEEN_NARRATION_FLUSHES/, 'late narration must never be backfilled at an old fourth-action boundary')
  assert.match(dispatcher, /if \(!this\.isNarrationCadenceReady\(\)\) return false[\s\S]*?const text = this\.narrationBuf\.flush\(\)/, 'client must keep buffered model narration until the 3-action cadence is ready')
  assert.doesNotMatch(dispatcher, /handleStepAdvance[\s\S]{0,180}this\.toolsSinceLastNarration = 0/, 'normal step transitions must not reset the global narration cadence')
  assert.match(dispatcher, /setComputerPanelActiveItemId\(panelFocusIdForTool\(event\.name,\s*event\.id\)\)/, 'new tool starts must focus their live computer panel item')
  assert.match(computerPanel, /computerPanelActiveItemId/, 'computer panel must follow the explicit active item pointer')
  assert.match(uiStore, /setComputerPanelActiveItemId/, 'UI store must expose the active computer item pointer')
  assert.match(policyEngine, /isValidProgressNarration/, 'backend must only clear forced narration after valid sanitized narration')
  assert.match(policyEngine, /isAcceptableForcedNarration/, 'forced narration repair must accept slightly relaxed but concrete progress updates')
  assert.match(policyEngine, /forcedNarrationRepairAttempts/, 'forced narration repair must have bounded attempts so it cannot deadlock the task')
  assert.match(policyEngine, /forcedNarrationRepairAttempts >= 2/, 'forced narration repair must fail open after repeated invalid text-only attempts')
  assert.match(policyEngine, /Math\.min\(2,\s*state\.visibleToolActionsSinceLastNarration\)/, 'forced narration repair must preserve cadence pressure after fail-open recovery')
  assert.match(policyEngine, /NARRATION CADENCE RECOVERY/, 'backend must emit a hard narration-cadence recovery after missed progress narration')
  assert.match(policyEngine, /state\.forceTextNextIteration = true/, 'backend must force the next model turn into narration-only mode after an overdue gap')
  assert.match(policyEngine, /four visible action pills have completed without a valid user-facing progress paragraph/, 'overdue narration recovery must be based on visible action pills')
  assert.match(policyEngine, /PHASE-END NARRATION REQUIRED/, 'backend must request phase-end narration before advancing a completed 3-4 action phase')
  assert.match(policyEngine, /if \(!stepAdvancedThisIteration\) return \[\]/, 'valid narration plus next_step must not be swallowed before step advancement')
  assert.match(policyEngine, /visibleActionsAfterAcceptedNarration/, 'backend must preserve overflow actions after a late forced narration')
  assert.match(agentLoop, /phase is complete[\s\S]{0,180}<next_step\/>/, 'same-turn cadence prompt must allow phase-end narration before next_step')
  assert.match(agentLoop, /phase-end narration is valid/, 'overdue cadence prompt must explicitly allow end-of-phase narration without another tool')
  assert.match(agentLoop, /This applies in every phase and task type/, 'same-turn cadence prompt must push narration across all phases and task types')
  assert.match(agentLoop, /Do not skip the paragraph just because another useful tool call is available/, 'same-turn cadence prompt must prefer real model narration once the window opens')
  assert.match(toolPipeline, /Keep cadence soft/, 'tool execution must not hard-block useful visible actions when narration is overdue')
  assert.doesNotMatch(toolPipeline, /4 visible actions have already occurred without user-facing progress narration/, 'tool execution must not expose an overdue-narration block')
  assert.match(config, /NARRATION_THRESHOLD_DEFAULT\s*=\s*3/, 'default narration threshold must open the 3-4 action narration window')
  assert.match(config, /NARRATION_THRESHOLD_BROWSER\s*=\s*3/, 'browser-heavy tasks must enter the 3-4 narration window after 3 visible actions')
  assert.match(streamProcessor, /recordVisibleToolStartForNarration/, 'provisional file/code tool starts must count toward the same visible narration cadence as executed tools')
  assert.match(streamProcessor, /strictActionLabelFromArgs\(args\)/, 'provisional visible starts must require the same strict model-authored label as the UI pill')
  assert.match(streamProcessor, /lastVisibleActivityTime/, 'stream processor must track user-visible activity separately from invisible reasoning chunks')
  assert.match(streamProcessor, /visibleInactivityExpired/, 'invisible-only reasoning stalls must trigger recovery instead of waiting for the full iteration timeout')
  assert.match(config, /inactivityTimeoutMs:\s*IS_OLLAMA \? 120_000 : 45_000/, 'API inactivity timeout must tolerate provider first-token latency without false task failures')
  assert.match(config, /checkIntervalMs:\s*150/, 'stream inactivity checks should run quickly enough to keep thinking state honest')
  assert.match(prompts, /Do not narrate with fewer than 3 new visible actions, and never go past 4 visible actions/, 'agent prompt must enforce the exact 3-4 action narration window')
  assert.match(prompts, /never fewer than 15 words/, 'agent prompt must forbid too-short progress narration')
  assert.match(prompts, /1-2 complete sentences/, 'agent prompt must define short paragraph cadence')
  assert.match(prompts, /result-first/, 'agent prompt must request result-first evidence narration')
  assert.match(prompts, /At exactly 3 visible actions, start the next response/, 'agent prompt must make narration happen in the normal next model turn')
  assert.match(prompts, /standing cadence for every phase/, 'agent prompt must frame narration as a per-phase cadence, not only research narration')
  assert.match(prompts, /narration is the default first visible text/, 'agent prompt must make narration the preferred first visible text at the 3-action window')
  assert.match(prompts, /before <next_step\/> if the current phase is complete/, 'agent prompt must allow narration at the end of a phase before next_step')
  assert.match(prompts, /Phase-end narration is allowed and expected/, 'agent prompt must not wait for an extra tool call at phase end')
  assert.match(prompts, /vary the opening verb and sentence shape/, 'agent prompt must require varied progress narration openings')
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
import { sanitizeNarrationText, stripToolActionNarration } from ${JSON.stringify(join(root, 'src/lib/stream/cleaners.ts'))}
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
  assert.equal(sanitizeNarrationText('Review the College Board I have identified significant institutional and educator concerns regarding AI in high schools.'), null)
  assert.equal(sanitizeNarrationText('Access the Frontiers systematic review to I have identified key socio-ethical risks associated with AI in education.'), null)
  assert.equal(sanitizeNarrationText('gather evidence on those issues.'), null)
  assert.equal(sanitizeNarrationText('Confirm café option selected and move to Location 3.', { requireSignal: true }), null)
  assert.equal(sanitizeNarrationText('Confirmed café option selected.', { requireSignal: true }), null)
  assert.equal(strictActionLabelFromArgs({ action_label: 'Researching AI tools for essay planning' }), null)
  assert.equal(strictActionLabelFromArgs({ action_label: 'Compare student AI writing tools' }), 'Compare student AI writing tools')
  assert.equal(
    stripToolActionNarration("Australia is handling AI copyright issues federally. 2. Navigate to official government publications or reputable legal analysis sites detailing these amendments. 3. Synthesize all gathered information to provide a comprehensive answer on Australia’s response to AI copyright issues, including national vs. state actions and the status of legal reviews. 4. Compile findings into a comprehensive report. The Australian federal government is actively addressing copyright issues related to generative AI."),
    "Australia is handling AI copyright issues federally. The Australian federal government is actively addressing copyright issues related to generative AI.",
  )
  assert.equal(
    sanitizeNarrationText("DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.", { requireSignal: true }),
    "DevRev's funding confirms a late-2025 $100M Series A and a $1.2B valuation. Next, I'll compare culture signals.",
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
