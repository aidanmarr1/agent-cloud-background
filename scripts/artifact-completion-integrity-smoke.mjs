import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.artifact-completion-integrity-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  const [agentLoop, planManager, toolPipeline, dispatcher, pdfExport, browser, config, conversationContext, chatTaskRunner] = await Promise.all([
    readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/PlanManager.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/ToolPipeline.ts'), 'utf8'),
    readFile(join(root, 'src/stream/client/eventDispatcher.ts'), 'utf8'),
    readFile(join(root, 'src/lib/pdfExport.ts'), 'utf8'),
    readFile(join(root, 'src/lib/browser.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/config.ts'), 'utf8'),
    readFile(join(root, 'src/lib/conversationContext.ts'), 'utf8'),
    readFile(join(root, 'src/lib/agent/chatTaskRunner.ts'), 'utf8'),
  ])

  assert.match(agentLoop, /all\|done\|ready\|complete\|completed\|finished/, 'one-word handoff tails must be rejected')
  assert.match(agentLoop, /\[a-z\]\(\?:The\|This\|Your\|Here\|You\|It\)/, 'concatenated provider handoff fragments such as canThe must be rejected before user-visible release')
  assert.doesNotMatch(agentLoop, /attemptNumber\s*>=\s*2[\s\S]{0,180}!finalDeliverableHandoffHasInvalidForm/, 'a second handoff attempt must not bypass completeness checks')
  assert.match(agentLoop, /deliverable_handoff_failed[\s\S]{0,240}phase = 'ERROR'/, 'failed handoff prose must not produce a false done event')
  assert.match(toolPipeline, /BROWSER_TARGET_MISMATCH:[\s\S]*unrelated external webpage cannot verify a local generated artifact/, 'external pages must not verify local artifacts')
  assert.match(toolPipeline, /SOURCE_REQUIRED:[\s\S]*Do not invent a replacement source/, 'existing-file conversions must block fabricated source writes')
  assert.match(dispatcher, /toolResultFailureMessage[\s\S]*resultStatus[\s\S]*'error'\s*:\s*'done'/, 'failed tool results must remain failed in the task stream')
  assert.match(dispatcher, /The task ended before this action returned a result/, 'a terminal done event must expose unresolved actions')
  assert.match(browser, /renderDocumentPdf[\s\S]*format: 'A4'[\s\S]*preferCSSPageSize: true/, 'PDF export must render on the provider-backed task browser')
  assert.match(browser, /renderDocumentPdf[\s\S]*screenshot[\s\S]*analyzeScreenshotQuality[\s\S]*horizontalOverflow/, 'PDF export must visually inspect a rendered preview and reject blank or overflowing layouts')
  assert.match(pdfExport, /readSandboxFileBytes[\s\S]*renderDocumentPdf[\s\S]*%PDF-[\s\S]*writeSandboxFileBytes/, 'PDF export must read and write through the active sandbox provider and validate a real PDF payload')
  assert.match(pdfExport, /validated: true[\s\S]*PDF signature, non-empty rendered preview, readable text, white print background and overflow-free page layout validated/, 'successful PDF export results must report native visual and structural validation')
  assert.match(agentLoop, /DURABLE TASK FILE INVENTORY:[\s\S]*Plan only the work that remains:[\s\S]*choose freely among all available tools/, 'follow-ups must receive the existing task artifact inventory without removing tool autonomy')
  assert.match(agentLoop, /CURRENT FOLLOW-UP CONTRACT:[\s\S]*Do not recreate, rewrite, research, or ask the user to provide the source again/, 'existing-artifact follow-ups must receive an execution-level conversion contract in addition to planner context')
  assert.match(agentLoop, /durableTaskPlanningContextPromise[\s\S]*new PlanManager\([\s\S]*durableTaskPlanningContextPromise/, 'follow-up planning must receive durable task artifacts without delaying the acknowledgement call')
  assert.match(planManager, /scheduleAcknowledgementCall\(\)[\s\S]*await this\.planningContextPromise[\s\S]*attemptPlanCall/, 'acknowledgement must start before optional artifact context is awaited by the planner')
  assert.match(planManager, /getFastPlanningPrompt\(this\.customInstructions\)[\s\S]*CURRENT TASK CONTEXT \(factual; plan only remaining work\)/, 'artifact inventory must be merged into the primary planner instruction so providers cannot ignore a later system message')
  assert.match(planManager, /existingArtifactPlanQualityIssue[\s\S]*DURABLE TASK FILE INVENTORY:[\s\S]*taskRequiresExistingInputArtifact[\s\S]*Invalid source-recreation phase/, 'existing-artifact follow-up plans must repair source-recreation phases instead of executing them')
  assert.match(conversationContext, /Latest user direction \(authoritative\):[\s\S]*Previous task request \(context only\):/, 'follow-up planning and acknowledgement must lead with the latest direction instead of letting the earlier long request dominate')
  assert.match(chatTaskRunner, /beforeDone: async \(\) => \{[\s\S]*finalizeUsageBilling\(\)[\s\S]*cleanupCloudSandboxOnce\(false\)/, 'normal task completion must settle and pause the sandbox before exposing done so the next message cannot race its lifecycle')
  assert.match(toolPipeline, /tc\.name === 'export_pdf'[\s\S]*state\.deliverableVerified = pdfResult\?\.validated === true[\s\S]*previewNonBlank === true[\s\S]*horizontalOverflow === false[\s\S]*native-pdf-export/, 'native PDF export must satisfy deliverable verification only after its visual and structural checks pass')
  assert.match(toolPipeline, /tc\.name === 'export_pdf'[\s\S]*source_path[\s\S]*inputArtifactPathsRead\.add/, 'native PDF export must count its successful internal source read as completion evidence')
  assert.match(toolPipeline, /tc\.name === 'export_pdf' \|\| tc\.name === 'package_files'[\s\S]*emitFileArtifact\(tc\.id, \{ path: pdfResult\.path, content: '' \}, result, state, true\)/, 'native PDF and ZIP exports must surface as explicit deliverables even when a planner places them before the final phase')
  assert.match(agentLoop, /successfulPdfExport[\s\S]*taskRequiresExistingInputArtifact\(\{[\s\S]*latestUserText\(messages\)[\s\S]*remainingAdvances[\s\S]*handleStepAdvance\(state\)[\s\S]*finalDeliverableHandoffPending = \{[\s\S]*path: pdfPath[\s\S]*continueFinalPhaseAfterVerifiedArtifact\(state, pdfPath, contextManager\)/, 'successful existing-artifact PDF export must advance through redundant conversion phases directly into its bounded final handoff')
  assert.match(agentLoop, /case 'STREAMING':[\s\S]*verifiedConversionPath[\s\S]*latestSavedFinalDeliverablePath\(state\)[\s\S]*finalDeliverableHandoffPending = \{[\s\S]*continueFinalPhaseAfterVerifiedArtifact/, 'the streaming boundary must recover a verified conversion into final handoff even if an earlier generic policy branch preempted post-tool evaluation')
  assert.match(agentLoop, /stepResearchCallCount === 0\)[\s\S]*!lastToolResults\.some\(result => result\.tc\.name === 'export_pdf' && !result\.isError\)[\s\S]*shouldUseCompactResearchTurn/, 'generic compact-research recovery must never preempt the successful PDF completion transition')
  assert.match(agentLoop, /isSuccessfulCompactFilePhaseWrite[\s\S]*partialWriteIncomplete[\s\S]*research-notes[\s\S]*successfulCompactFileWrite[\s\S]*handleStepAdvance\(state\)/, 'a complete compact user file must advance its creation phase while partial writes and internal notes remain open')
  assert.match(config, /create_website: 4/, 'whole-site regeneration must have a bounded per-step circuit breaker')
  assert.match(config, /SANDBOX_IO_TOOL_TIMEOUT_MS[\s\S]*20_000/, 'remote sandbox reads and terminal actions must allow E2B wake time instead of false two-second failures')
  assert.match(toolPipeline, /existingInputReason[\s\S]*stepToolTypeCounts\.set\(tc\.name/, 'rejected source fabrication must count toward the per-phase circuit breaker')

  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { createInitialState, recordWorkLedgerDeliverable } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { auditAgentCompletion } from ${JSON.stringify(join(root, 'src/lib/agent/CompletionAudit.ts'))}
import { analyzeTaskIntent } from ${JSON.stringify(join(root, 'src/lib/agent/TaskIntent.ts'))}
import { requestedOutputFilePaths } from ${JSON.stringify(join(root, 'src/lib/agent/taskConstraints.ts'))}
import { compactFinalDeliverableMessages, shouldRejectBuildTextOnlyEmission } from ${JSON.stringify(join(root, 'src/lib/agent/AgentLoop.ts'))}
import {
  artifactPathSatisfiesFinalOutputContract,
  hasExistingInputArtifactEvidence,
  requestedFinalArtifactFormat,
  taskRequiresExistingInputArtifact,
  taskRequiresSavedFinalArtifact,
} from ${JSON.stringify(join(root, 'src/lib/agent/DeliverableContract.ts'))}

const timeouts = {
  iterationTimeoutMs: 30000,
  inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

const exactFileRequest = 'Create release-check.txt containing exactly: The sum of squares from 1 to 20 is 2870. Use create_file, read the file back once to verify it, then finish with a concise handoff. Do not use research, web, or browser tools.'
const exactFileIntent = analyzeTaskIntent([{ role: 'user', content: exactFileRequest }])
assert.equal(exactFileIntent.explicitSavedArtifact, true, 'an output filename must define a saved-file contract')
assert.equal(exactFileIntent.asksForResearch, false, 'negated research and local verification must not force external evidence calls')
const exactFileState = createInitialState(false, timeouts)
exactFileState.originalUserRequest = exactFileRequest
exactFileState.taskStrategy = 'browse'
exactFileState.currentPlanItems = ['Create release-check.txt', 'Verify and deliver file']
assert.equal(taskRequiresSavedFinalArtifact(exactFileState), true, 'a planner action/browse strategy must retain the named output')
assert.equal(requestedFinalArtifactFormat(exactFileState)?.label, 'text file')
assert.equal(artifactPathSatisfiesFinalOutputContract(exactFileState, 'release-check.zip'), false, 'an invented archive cannot replace the requested text file')
assert.deepEqual(requestedOutputFilePaths('Create app/page.tsx and write config.json.'), ['app/page.tsx', 'config.json'])
assert.equal(requestedFinalArtifactFormat({ originalUserRequest: 'Create app/page.tsx and write README.md.' }), null,
  'mixed named outputs must not all be forced into one filename-derived format')
assert.deepEqual(requestedOutputFilePaths('Read existing.txt and summarize it here.'), [], 'a source filename is not an output request')
assert.equal(analyzeTaskIntent([{ role: 'user', content: 'Verify the checksum of the local file and finish.' }]).asksForResearch, false)
assert.equal(analyzeTaskIntent([{ role: 'user', content: 'Do not use browser tools, but research official papers and cite sources.' }]).asksForResearch, true,
  'a negative tool preference must not erase a separate positive research request')

exactFileState.taskStrategy = 'build'
exactFileState.currentStepIdx = 1
exactFileState.currentPhase = 'deliver'
const fileHandoff = {
  assistantContent: 'I have created release-check.txt with the exact requested text and verified its contents. The file is ready to open.',
  toolCalls: new Map(),
  stepAdvancedThisIteration: false,
}
assert.equal(shouldRejectBuildTextOnlyEmission(exactFileState, fileHandoff), true, 'unsupported completion claims must still be rejected')
recordWorkLedgerDeliverable(exactFileState, { path: 'release-check.txt', purpose: 'deliverable' })
assert.equal(shouldRejectBuildTextOnlyEmission(exactFileState, fileHandoff), true, 'a saved file still needs verification before a final handoff')
exactFileState.deliverableVerificationDone = true
assert.equal(shouldRejectBuildTextOnlyEmission(exactFileState, fileHandoff), false, 'verified completion prose must be released rather than discarded and retried')
exactFileState.deadlineFinalizationStarted = true
const compactSavedHandoff = compactFinalDeliverableMessages(exactFileState, [])
assert.match(String(compactSavedHandoff[0].content), /SAVED DELIVERABLE VERIFICATION BOUNDARY/)
assert.doesNotMatch(String(compactSavedHandoff[0].content), /REVISION TOOL CALL ONLY|Make exactly one native append_file or edit_file/, 'deadline compaction must not invent a revision for an already complete file')
exactFileState.pendingDeliverableRevision = { path: 'hello.txt', failures: ['Missing requested content'], suggestions: [], createdAt: Date.now() }
assert.match(String(compactFinalDeliverableMessages(exactFileState, [])[0].content), /REVISION TOOL CALL ONLY/, 'a real verification failure must still require a targeted repair')

const conversion = createInitialState(true, timeouts)
conversion.originalUserRequest = 'Cover to PDF, return it here.'
conversion.currentPlanItems = ['Convert the existing cover and deliver the PDF']
conversion.currentPlanScopes = [null]
conversion.currentStepIdx = 1
conversion.taskStrategy = 'build'
conversion.deliverableVerificationDone = true

assert.equal(requestedFinalArtifactFormat(conversion)?.label, 'PDF')
assert.equal(taskRequiresExistingInputArtifact(conversion), true)
assert.equal(artifactPathSatisfiesFinalOutputContract(conversion, 'cover.html'), false)
assert.equal(artifactPathSatisfiesFinalOutputContract(conversion, 'deliverables/cover.pdf'), true)

const naturalPutConversion = createInitialState(true, timeouts)
naturalPutConversion.originalUserRequest = 'Put it in a PDF.'
assert.equal(requestedFinalArtifactFormat(naturalPutConversion)?.label, 'PDF')
assert.equal(taskRequiresExistingInputArtifact(naturalPutConversion), true)

const contextualPutConversion = createInitialState(true, timeouts)
contextualPutConversion.originalUserRequest = 'Latest user direction (authoritative; do this now): Put it in a PDF.\\n\\nPrevious task request (completed context only; do not repeat it): Create a Markdown report about AI.'
assert.equal(requestedFinalArtifactFormat(contextualPutConversion)?.label, 'PDF')
assert.equal(taskRequiresExistingInputArtifact(contextualPutConversion), true)

recordWorkLedgerDeliverable(conversion, { path: 'cover.html', purpose: 'deliverable' })
let audit = auditAgentCompletion(conversion, 'complete')
assert.equal(audit.complete, false)
assert.ok(audit.missing.some(item => /final PDF artifact/i.test(item)))
assert.ok(audit.missing.some(item => /source artifact was not found and read/i.test(item)))

conversion.inputArtifactPathsRead.add('cover.html')
recordWorkLedgerDeliverable(conversion, { path: 'deliverables/cover.pdf', purpose: 'deliverable' })
audit = auditAgentCompletion(conversion, 'complete')
assert.equal(audit.complete, true)

const createThenExport = createInitialState(true, timeouts)
createThenExport.originalUserRequest = 'Create a new cover and export it as a PDF.'
assert.equal(taskRequiresExistingInputArtifact(createThenExport), false)

const createAndExport = createInitialState(true, timeouts)
createAndExport.originalUserRequest = 'Create and export a new cover as PDF.'
assert.equal(taskRequiresExistingInputArtifact(createAndExport), false)

const readPdfWriteSummary = createInitialState(false, timeouts)
readPdfWriteSummary.originalUserRequest = 'Read the attached PDF and write a concise summary in chat.'
assert.equal(requestedFinalArtifactFormat(readPdfWriteSummary), null)

const readPdfFileWriteSummary = createInitialState(false, timeouts)
readPdfFileWriteSummary.originalUserRequest = 'Read this PDF file and summarize it in chat.'
assert.equal(requestedFinalArtifactFormat(readPdfFileWriteSummary), null)

const namedOnlyAttachment = createInitialState(true, timeouts)
namedOnlyAttachment.uploadedAttachmentContextAvailable = true
namedOnlyAttachment.uploadedAttachmentNames = ['cover.html']
assert.equal(hasExistingInputArtifactEvidence(namedOnlyAttachment), false)
namedOnlyAttachment.uploadedAttachmentContentAvailable = true
assert.equal(hasExistingInputArtifactEvidence(namedOnlyAttachment), true)

console.log('artifact completion integrity runtime checks passed')
`)

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  console.log('artifact completion integrity smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
