import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()

async function assertSourceContracts() {
  const [
    agentLoop,
    toolPipeline,
    policyEngine,
    dispatcher,
    useAgentStream,
    creditPolicy,
    chatRoute,
    chatTaskRunner,
    events,
    emitter,
    tasks,
    taskGroupView,
    stepTrackerBar,
    completionAudit,
    projectFiles,
    taskFiles,
    filesRoute,
    attachmentsRoute,
    homePage,
    chatPage,
    serverSync,
    agentConfig,
    taskConstraints,
  ] = await Promise.all([
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PolicyEngine.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/useAgentStream.ts'), 'utf8'),
    readFile(join(root, 'src/lib/creditPolicy.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/chat/route.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8'),
    readFile(join(root, 'src/types/events.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/SSEEmitter.ts'), 'utf8'),
    readFile(join(root, 'src/types/tasks.ts'), 'utf8'),
    readFile(join(root, 'src/components/chat/TaskGroupView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/chat/StepTrackerBar.tsx'), 'utf8'),
    readFile(join(root, 'src/lib/agent/CompletionAudit.ts'), 'utf8'),
    readFile(join(root, 'src/components/ui/ProjectFiles.tsx'), 'utf8'),
    readFile(join(root, 'src/lib/taskFiles.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/files/route.ts'), 'utf8'),
    readFile(join(root, 'src/app/api/attachments/route.ts'), 'utf8'),
    readFile(join(root, 'src/app/page.tsx'), 'utf8'),
    readFile(join(root, 'src/app/chat/[id]/page.tsx'), 'utf8'),
    readFile(join(root, 'src/store/chat/serverSync.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/taskConstraints.ts'), 'utf8'),
  ])

  const readNumberConst = (source, name) => {
    const match = source.match(new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`))
    assert.ok(match, `${name} must be declared as a numeric constant`)
    return Number(match[1].replace(/_/g, ''))
  }
  const chatRouteMaxDuration = (() => {
    const match = chatRoute.match(/export const maxDuration\s*=\s*([0-9_]+)/)
    assert.ok(match, 'chat route maxDuration must be a numeric literal')
    return Number(match[1].replace(/_/g, ''))
  })()
  const agentMaxDuration = readNumberConst(agentConfig, 'AGENT_RUN_MAX_DURATION_MS')
  const finalizationBuffer = readNumberConst(agentConfig, 'AGENT_DEADLINE_FINALIZATION_BUFFER_MS')
  const finalTurnTimeout = readNumberConst(agentConfig, 'AGENT_DEADLINE_MODEL_TURN_TIMEOUT_MS')
  const hardStopBuffer = readNumberConst(agentConfig, 'AGENT_DEADLINE_HARD_STOP_BUFFER_MS')

  assert.match(agentLoop, /auditAgentCompletion\(state,\s*terminalReason\)/, 'AgentLoop must audit before emitting final done')
  assert.match(agentLoop, /scheduleFinalInlineAnswerRecovery/, 'AgentLoop must reopen a missing final inline answer instead of reporting false completion')
  assert.match(agentLoop, /isSynthesisFinalizationRecoveryResult/, 'blocked synthesis research must redirect immediately into finalization')
  assert.match(agentLoop, /FINAL_DELIVERABLE_WRITE_TOOLS = new Set\(\['create_file', 'append_file', 'edit_file', 'export_pdf'\]\)/, 'final deliverable completion must recognize edit_file and export_pdf updates')
  assert.match(agentLoop, /deliverableContentForVerification/, 'deliverable verification must read the full current file, not only the latest append chunk')
  assert.match(agentLoop, /pendingDeliverableRevision/, 'failed deliverable verification must leave a concrete pending revision target')
  assert.match(agentLoop, /recoverTextOnlyDraft[\s\S]*shouldContinueSavedFinalDeliverableChunk[\s\S]*const verification = outputVerifier\.verify\(\s*content,\s*path/, 'text-only saved reports must continue and verify before completing')
  assert.doesNotMatch(agentLoop, /skipReportVerifier/, 'saved report deliverables must not bypass output verification')
  assert.match(agentLoop, /partialWriteIncomplete/, 'recovered partial file writes must keep the loop alive for append/edit completion')
  assert.match(agentLoop, /isLeanFinalSynthesisStep\(state\) && isFixedWebSearchInlineAnswerState\(state\)[\s\S]*?activeTools = \[\]/, 'fixed-search answer tasks must not be forced into file-tool finalization')
  assert.match(agentLoop, /Do not create, mention, attach, or claim any file, report, artifact, or deliverable/, 'fixed-search inline answer turns must not claim nonexistent files')
  assert.match(policyEngine, /isFixedWebSearchInlineAnswerState\(state\) && shouldAcceptFinalInlineText/, 'fixed-search answer tasks must be allowed to terminate from a complete inline answer')
  assert.match(policyEngine, /finalStepStartGuidance/, 'final-step transition guidance must distinguish inline answers from saved deliverables')
  assert.match(policyEngine, /isCurrentLastStep && finalDeliverableRequired\(state\)[\s\S]*latestFinalDeliverableCandidate\(state\)[\s\S]*no successful deliverable file exists/, 'manual final-step advancement must stay blocked until a saved deliverable exists')
  assert.match(policyEngine, /isCurrentLastStep && finalDeliverableRequired\(state\)[\s\S]*!state\.deliverableVerificationDone[\s\S]*pendingDeliverableRevisionGuidance/, 'manual final-step advancement must stay blocked until the saved deliverable is verified')
  assert.match(policyEngine, /intent\.requiresSavedArtifact[\s\S]*intent\.wantsCitations[\s\S]*depthProfile\.label === 'deep'/, 'saved, cited, and deep research requests must not use shallow research recovery thresholds')
  assert.match(agentLoop, /stepAdvanceStatusFor\(state,\s*i\)/, 'AgentLoop must propagate incomplete step status to the UI')
  assert.match(agentLoop, /Completion audit failed/, 'failed completion audits must be logged')
  assert.match(agentLoop, /this\.emitter\.error\(completionAudit\.message\)/, 'incomplete runs must emit error, not done')
  assert.match(agentLoop, /Goals met for step .*advancing/, 'goal completion must actually advance the plan')
  assert.match(toolPipeline, /if \(fileResult\.size !== undefined\) \{[\s\S]*?recordWorkLedgerDeliverable/, 'only successful file writes may satisfy deliverable ledger state')
  assert.doesNotMatch(toolPipeline, /recordWorkLedgerDeliverable\(state, \{ path: pathStr, purpose \}\)\s*\n\s*if \(hasPlan && !isDeliverableStep\) return\s*\n\s*if \(fileResult\.size !== undefined\)/, 'failed file writes must not be recorded before success is known')
  assert.match(toolPipeline, /userRequestedMarkdownDeliverable/, 'requested markdown files must be recognized as final deliverables even if written before the last planner phase')
  assert.match(toolPipeline, /purpose !== 'deliverable'/, 'non-final support files should still be hidden from final artifacts')
  assert.match(toolPipeline, /persistGeneratedTaskFile/, 'successful file tool results must be mirrored into durable task-file storage')
  assert.match(toolPipeline, /persistSandboxTaskFile/, 'created sandbox files must be persisted beyond the serverless tmp lifetime')
  assert.match(toolPipeline, /markTaskFileDeleted/, 'durable task-file records must track deletes')
  assert.doesNotMatch(completionAudit, /hasSavedRequestedMarkdownDeliverable/, 'completion audit must not let a markdown file bypass unfinished plan steps or report verification')
  assert.match(completionAudit, /plannedIntent\.explicitSavedArtifact[\s\S]*taskDefaultsToMarkdownDeliverable\(taskText\)/, 'completion audit must infer the requested artifact from the full task and final plan even if the original request field is incomplete')
  assert.match(taskConstraints, /isFixedWebSearchInlineAnswerState/, 'task constraints must distinguish fixed-search inline answers from fixed-search markdown deliverables')
  assert.match(taskFiles, /create table if not exists task_files/, 'task file schema must create durable task-file records')
  assert.match(taskFiles, /primary key \(user_id, conversation_id, path\)/, 'task file records must be scoped per user and task path')
  assert.match(taskFiles, /putObject/, 'task files must persist bytes through the shared object storage driver')
  assert.match(taskFiles, /getObject/, 'task files must read bytes through the shared object storage driver')
  assert.match(taskFiles, /O_NOFOLLOW/, 'task file persistence must avoid following sandbox symlinks')
  assert.match(filesRoute, /listTaskFilesForUser/, 'project files API must list durable files after task completion')
  assert.match(filesRoute, /readTaskFileBody/, 'project files API must read durable file bytes')
  assert.match(filesRoute, /download/, 'project files API must support direct downloads')
  assert.match(filesRoute, /raw/, 'project files API must support raw previews for images and PDFs')
  assert.match(projectFiles, /hasInlineFileContent/, 'project files preview must distinguish real inline content from empty metadata placeholders')
  assert.match(projectFiles, /setFileContent\(typeof data\.content === 'string' \? data\.content : ''\)/, 'project files preview must use the file API read result, including true empty files')
  assert.doesNotMatch(projectFiles, /liveFile\.content \|\| 'Empty file'/, 'project files preview must not treat empty metadata as a real empty file')
  assert.doesNotMatch(projectFiles, /data\.content \|\| liveFile\?\.content \|\| 'Empty file'/, 'project files preview must not bypass API content with stale empty metadata')
  assert.doesNotMatch(projectFiles, /absolute top-full|w-\[360px\]|useClickOutside/, 'project files must open as a modal, not a small anchored dropdown')
  assert.doesNotMatch(projectFiles, /api\/sandbox/, 'project files must not download from temporary sandbox URLs')
  assert.match(projectFiles, /taskFileUrl/, 'project files must preview and download through the authenticated files API')
  assert.match(projectFiles, /\/api\/files\?/, 'project files must use the task files API')
  assert.match(projectFiles, /download: true/, 'project files rows must generate explicit download URLs')
  assert.match(projectFiles, /All files in this task/, 'project files modal must use the task-file list title')
  assert.match(projectFiles, /Documents[\s\S]*Images[\s\S]*Code files/, 'project files modal must separate files with visible type filters')
  assert.match(projectFiles, /dateGroups/, 'project files modal must group listed files by date')
  assert.match(projectFiles, /MarkdownLite/, 'project files preview must render markdown documents rather than only raw text')
  assert.match(projectFiles, /downloadFile\(file,\s*file\.content\)/, 'project files rows must expose direct download actions')
  assert.match(dispatcher, /withPreservedFilePanelContent/, 'file result upserts must preserve streamed file content for the Files drawer')
  assert.match(dispatcher, /findKnownFileContent/, 'file preview fallback must recover content from the existing task stream')
  assert.doesNotMatch(attachmentsRoute, /Upload size must be declared/, 'attachment uploads must not fail only because content-length is absent')
  assert.match(attachmentsRoute, /totalSize > MAX_ATTACHMENT_UPLOAD_BYTES/, 'attachment uploads must still enforce parsed total size')
  assert.match(useAgentStream, /await bindAttachmentsToTask/, 'chat attachment binding must finish before the task request starts')
  assert.match(homePage, /await bindAttachmentsToTask/, 'home attachment binding must finish before first task navigation')
  assert.match(homePage, /await flushChatServerSync\(\)/, 'home first-task creation must be saved immediately for cross-browser visibility')
  assert.match(homePage, /setStreamingStatus\('startup'\)/, 'home first-task UI must enter startup state immediately')
  assert.match(chatPage, /setStreamingStatus\('startup'\)/, 'chat auto-send UI must enter startup state immediately')
  assert.match(serverSync, /waitForStoreHydration/, 'forced chat sync must wait for account history hydration')
  assert.match(serverSync, /await waitForStoreHydration\(\)/, 'flush sync must not no-op before hydration is ready')
  assert.ok(chatRouteMaxDuration === 300, 'chat route maxDuration must stay within the deployed Hobby plan cap')
  assert.ok(agentMaxDuration <= (chatRouteMaxDuration * 1000) - 30_000, 'agent runtime must finish before platform route maxDuration')
  assert.ok(finalizationBuffer >= 120_000, 'agent finalization must start with enough time to write the deliverable')
  assert.ok(finalTurnTimeout <= 45_000, 'deadline model turns must be capped so one call cannot consume the whole finalization window')
  assert.ok(hardStopBuffer >= 18_000, 'agent must leave a hard-stop buffer before route termination')
  assert.match(policyEngine, /Progress guard: do not write another text-only status reply/, 'ordinary no-tool loops must recover without hard-stopping the task')
  assert.match(policyEngine, /FINAL DELIVERABLE REVISION REQUIRED/, 'final deliverable revision stalls must force append/edit guidance instead of generic no-tool blocking')
  assert.doesNotMatch(policyEngine, /deliverable_saved_after_revision_stall/, 'saved final deliverables must not be marked verified after repeated revision stalls')
  assert.match(policyEngine, /NO-TOOL BROWSER RECOVERY/, 'browser action no-tool loops must recover into a concrete browser action')
  assert.doesNotMatch(policyEngine, /browser step produced \$\{threshold\} repeated text-only replies/, 'browser action no-tool loops must not hard-block while the page remains actionable')
  assert.doesNotMatch(policyEngine, /Text-only response blocked:[\s\S]{0,120}state\.consecutiveNoToolCalls = 0/, 'browser text-only recovery must preserve no-tool counter')
  assert.match(dispatcher, /'stopped'/, 'stream dispatcher must distinguish user stop from done')
  assert.match(dispatcher, /event\.status === 'incomplete'/, 'dispatcher must render incomplete advances distinctly from done')
  assert.match(useAgentStream, /markActiveAssistantInterrupted[\s\S]*group\.status === 'running' \? 'incomplete'[\s\S]*step\.status === 'running' \? \{ \.\.\.step, status: 'incomplete' \}/, 'manual abort must mark running work incomplete rather than done')
  assert.match(useAgentStream, /replayCompletedRunAfterStop[\s\S]*completedBeforeStop[\s\S]*await replayCompletedRunAfterStop/, 'a stop racing successful completion must replay final durable events before clearing the run cursor')
  assert.match(creditPolicy, /ACTIVE_CREDITS_PER_MINUTE\s*=\s*0/, 'wall-clock idle time must not be billable')
  assert.match(chatTaskRunner, /ACTIVE_CREDITS_PER_MINUTE > 0/, 'the shared task runner must not run passive active-time billing when disabled')
  assert.match(events, /StepAdvanceStatus = 'done' \| 'incomplete'/, 'stream contract must carry incomplete step advancement')
  assert.match(emitter, /stepAdvance\(status: StepAdvanceStatus = 'done'/, 'SSE emitter must accept step advancement status')
  assert.match(tasks, /status: 'pending' \| 'running' \| 'done' \| 'incomplete' \| 'error'/, 'task groups must support incomplete status')
  assert.match(taskGroupView, /group\.status === 'incomplete'/, 'task group view must render incomplete steps')
  assert.match(stepTrackerBar, /Incomplete/, 'step tracker must label incomplete steps instead of counting them as done')
}

async function assertCompletionRuntime() {
  const workDir = await mkdtemp(join(root, 'scripts/.agent-completion-audit-smoke-'))
  const runnerPath = join(workDir, 'runner.ts')
  const bundlePath = join(workDir, 'runner.mjs')

  try {
    await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { createInitialState, recordWorkLedgerDeliverable } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { auditAgentCompletion, MISSING_FINAL_INLINE_ANSWER } from ${JSON.stringify(join(root, 'src/lib/agent/CompletionAudit.ts'))}
import { PolicyEngine } from ${JSON.stringify(join(root, 'src/lib/agent/PolicyEngine.ts'))}

const timeouts = {
  iterationTimeoutMs: 30000,
  inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

export function runCompletionAuditSmoke() {
  const incompletePlan = createInitialState(false, timeouts)
  incompletePlan.currentPlanItems = ['Research', 'Write final report']
  incompletePlan.currentPlanScopes = [null, null]
  incompletePlan.currentStepIdx = 1
  incompletePlan.taskStrategy = 'research'
  incompletePlan.originalUserRequest = 'Create a markdown report about battery recycling.'
  let audit = auditAgentCompletion(incompletePlan, 'loop_detected_on_last_step')
  assert.equal(audit.complete, false)
  assert.match(audit.message, /only 1 of 2 plan steps/)
  assert.match(audit.message, /no successful final deliverable/)

  const missingDeliverable = createInitialState(true, timeouts)
  missingDeliverable.currentPlanItems = ['Build files', 'Deliver website']
  missingDeliverable.currentPlanScopes = [null, null]
  missingDeliverable.currentStepIdx = 2
  missingDeliverable.taskStrategy = 'build'
  missingDeliverable.originalUserRequest = 'Build a website.'
  audit = auditAgentCompletion(missingDeliverable, 'post_completion_max')
  assert.equal(audit.complete, false)
  assert.match(audit.message, /no successful final deliverable/)

  const complete = createInitialState(true, timeouts)
  complete.currentPlanItems = ['Build files', 'Deliver website']
  complete.currentPlanScopes = [null, null]
  complete.currentStepIdx = 2
  complete.taskStrategy = 'build'
  complete.originalUserRequest = 'Build a website.'
  complete.websiteBrowserCheckDone = true
  complete.websiteResponsiveCheckDone = true
  complete.deliverableVerificationDone = true
  complete.createdFiles.add('app/page.tsx')
  recordWorkLedgerDeliverable(complete, { path: 'app/page.tsx', purpose: 'deliverable' })
  audit = auditAgentCompletion(complete, 'deliverable_created')
  assert.equal(audit.complete, true)

  const earlyMarkdownDeliverable = createInitialState(false, timeouts)
  earlyMarkdownDeliverable.currentPlanItems = ['Run one web search for yoghurt toppings', 'Write the markdown report file', 'Report completion']
  earlyMarkdownDeliverable.currentPlanScopes = [null, null, null]
  earlyMarkdownDeliverable.currentStepIdx = 1
  earlyMarkdownDeliverable.taskStrategy = 'research'
  earlyMarkdownDeliverable.originalUserRequest = 'do 1 web search on best yoghurt toppings and get back to me in an md report file'
  earlyMarkdownDeliverable.createdFiles.add('yoghurt_toppings.md')
  earlyMarkdownDeliverable.searchQueries.add('best yoghurt toppings')
  recordWorkLedgerDeliverable(earlyMarkdownDeliverable, { path: 'yoghurt_toppings.md', purpose: 'deliverable' })
  audit = auditAgentCompletion(earlyMarkdownDeliverable, 'no_tool_progress_on_step')
  assert.equal(audit.complete, false)
  assert.match(audit.message, /only 1 of 3 plan steps/)
  assert.match(audit.message, /did not pass completion verification/)

  earlyMarkdownDeliverable.currentStepIdx = 3
  earlyMarkdownDeliverable.deliverableVerificationDone = true
  audit = auditAgentCompletion(earlyMarkdownDeliverable, 'deliverable_created')
  assert.equal(audit.complete, true)

  const inlineCodeExplanation = createInitialState(false, timeouts)
  inlineCodeExplanation.currentPlanItems = ['Find one credible source', 'Give the concise summary']
  inlineCodeExplanation.currentPlanScopes = [
    'Find current evidence about SVG generation',
    'Summarize how AI models generate SVG code in two sentences',
  ]
  inlineCodeExplanation.currentStepIdx = 1
  inlineCodeExplanation.taskStrategy = 'research'
  inlineCodeExplanation.originalUserRequest =
    'Find one current credible source explaining how AI models generate SVG code, then give a concise two-sentence summary.'
  inlineCodeExplanation.currentStepIdx = 2
  inlineCodeExplanation.finalInlineAnswerDelivered = true
  audit = auditAgentCompletion(inlineCodeExplanation, 'inline_answer_complete')
  assert.equal(audit.complete, true, 'a code-related research question must remain an inline answer')

  inlineCodeExplanation.currentStepIdx = 1
  inlineCodeExplanation.finalInlineAnswerDelivered = false
  const policyActions = new PolicyEngine().evaluate(
    inlineCodeExplanation,
    new Map(),
    'A current source explains that language models can emit SVG as structured XML text by learning syntax and visual patterns from training data. The output still benefits from validation because malformed paths, coordinates or accessibility metadata can make the image unusable.',
    false,
    40,
  )
  assert.equal(
    policyActions.some(action => action.type === 'terminate' && action.reason === 'inline_answer_complete'),
    true,
    'final-step policy must accept the inline SVG explanation instead of forcing a file',
  )
  assert.equal(inlineCodeExplanation.finalInlineAnswerDelivered, true)

  const missingInlineAnswer = createInitialState(false, timeouts)
  missingInlineAnswer.currentPlanItems = ['Research current evidence', 'Answer the user']
  missingInlineAnswer.currentPlanScopes = [null, null]
  missingInlineAnswer.currentStepIdx = 2
  missingInlineAnswer.taskStrategy = 'research'
  missingInlineAnswer.originalUserRequest = 'Research the newest iPhone and tell me the highest storage option in chat.'
  audit = auditAgentCompletion(missingInlineAnswer, 'plan_complete')
  assert.equal(audit.complete, false, 'plan completion alone must not substitute for a visible final answer')
  assert.ok(audit.missing.includes(MISSING_FINAL_INLINE_ANSWER))

  const statusOnly = createInitialState(false, timeouts)
  statusOnly.currentPlanItems = ['Research current evidence', 'Answer the user']
  statusOnly.currentPlanScopes = [null, null]
  statusOnly.currentStepIdx = 1
  statusOnly.taskStrategy = 'research'
  statusOnly.originalUserRequest = 'Research the newest iPhone and tell me the highest storage option in chat.'
  const statusActions = new PolicyEngine().evaluate(
    statusOnly,
    new Map(),
    "I'll analyze the current Apple lineup and compare every storage and color configuration, then present the closest silver option once that research is complete.",
    false,
    40,
  )
  assert.equal(
    statusActions.some(action => action.type === 'terminate'),
    false,
    'a future-tense acknowledgement must never be accepted as the final answer',
  )

  const prematureReportAdvance = createInitialState(false, timeouts)
  prematureReportAdvance.currentPlanItems = ['Gather cited evidence', 'Write comprehensive Markdown report']
  prematureReportAdvance.currentPlanScopes = [
    'Compare recent trials across several countries and distinguish evidence quality',
    'Create the cited report with an executive summary and source links',
  ]
  prematureReportAdvance.currentStepIdx = 1
  prematureReportAdvance.taskStrategy = 'research'
  prematureReportAdvance.originalUserRequest =
    'Research whether a four-day work week improves productivity and wellbeing, then present a cited report with an executive summary.'
  const prematureReportActions = new PolicyEngine().evaluate(
    prematureReportAdvance,
    new Map(),
    '',
    true,
    80,
  )
  assert.equal(prematureReportAdvance.currentStepIdx, 1, 'an empty final turn must not check off the report step')
  assert.equal(
    prematureReportActions.some(action => action.type === 'step_advance' || action.type === 'terminate'),
    false,
    'a model-authored next-step marker must not bypass the missing-report gate',
  )
  assert.equal(
    prematureReportActions.some(action => action.type === 'inject_message' && String(action.message?.content || '').includes('no successful deliverable file exists')),
    true,
    'the model must be sent back into the pending deliverable action',
  )

  const inferredReport = createInitialState(false, timeouts)
  inferredReport.currentPlanItems = ['Gather evidence', 'Write cited Markdown report']
  inferredReport.currentPlanScopes = [null, 'Create the final report file']
  inferredReport.currentStepIdx = 2
  inferredReport.taskStrategy = 'research'
  inferredReport.originalUserRequest = ''
  audit = auditAgentCompletion(inferredReport, 'plan_complete')
  assert.equal(audit.complete, false, 'the completion audit must infer a planned report even if original request text is unavailable')
  assert.match(audit.message, /no successful final deliverable/)
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

    const { runCompletionAuditSmoke } = await import(pathToFileURL(bundlePath).href)
    runCompletionAuditSmoke()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await assertSourceContracts()
await assertCompletionRuntime()
console.log('agent completion audit smoke checks passed')
