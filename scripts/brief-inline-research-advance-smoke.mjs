import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const agentLoop = await readFile(join(root, 'src/lib/agent/AgentLoop.ts'), 'utf8')
const briefClassifier = agentLoop.slice(
  agentLoop.indexOf('function isBriefInlineDirectAnswerTask('),
  agentLoop.indexOf('function briefInlineResearchEvidenceAfterTools('),
)
assert.match(briefClassifier, /brief[\s\S]*concise/, 'concise inline requests must enter the existing brief-research fast path')

const finalEvidenceGate = agentLoop.slice(
  agentLoop.indexOf('function finalBriefInlineResearchNeedsEvidenceAction('),
  agentLoop.indexOf('function shouldCompleteFinalInlineAnswerTurn('),
)
assert.match(
  finalEvidenceGate,
  /assessBriefInlineRunResearchEvidence\(\{[\s\S]*successfulToolTypeCounts: state\.taskSuccessfulToolTypeCounts[\s\S]*openedSourceUrls: state\.visitedUrls[\s\S]*state\.workLedger\.sources[\s\S]*if \(runEvidence\.ready\) return false/,
  'final synthesis must reassess fresh run-wide research evidence instead of trusting reset step counters or hydrated activity',
)

const autoAdvanceCall = agentLoop.lastIndexOf('const briefEvidenceAssessment =')
const autoAdvanceBranch = agentLoop.slice(autoAdvanceCall, autoAdvanceCall + 3_600)
assert.match(
  autoAdvanceBranch,
  /briefInlineResearchEvidenceAfterTools[\s\S]*briefEvidenceAssessment\?\.ready[\s\S]*briefInlineFinalDeliveryStepIndex[\s\S]*do \{[\s\S]*planManager\.handleStepAdvance\(state\)[\s\S]*while \(state\.currentStepIdx < targetStepIdx\)/,
  'satisfied brief research evidence must advance through the normal plan transition before another model turn',
)
assert.match(
  autoAdvanceBranch,
  /reason === 'explicit-source-quality'[\s\S]*!state\.briefInlineSourceQualityNudged[\s\S]*state\.briefInlineSourceQualityNudged = true[\s\S]*recoveryInstruction/,
  'failed explicit source quality must inject at most one bounded recovery instruction while retaining the research step',
)
assert.match(
  autoAdvanceBranch,
  /for \(let i = stepIdxBeforeExec; i < state\.currentStepIdx; i\+\+\) \{[\s\S]*this\.emitter\.stepAdvance\(stepAdvanceStatusFor\(state, i\)\)/,
  'fast-forwarded intermediate phases must retain one visible step_advance event per plan index',
)

const workDir = await mkdtemp(join(root, 'scripts/.brief-inline-research-advance-smoke-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import {
  assessBriefInlineRunResearchEvidence,
  assessBriefInlineResearchEvidence,
  briefInlineFinalDeliveryStepIndex,
  briefInlineResearchEvidenceReady,
  requestedBriefInlineSourceCount,
} from ${JSON.stringify(join(root, 'src/lib/agent/BriefInlineResearch.ts'))}
import { OutputVerifier } from ${JSON.stringify(join(root, 'src/lib/agent/OutputVerifier.ts'))}

const priorStepRunEvidence = assessBriefInlineRunResearchEvidence({
  request: 'Research two credible sources on how modern AI agents use browser tools, then summarize the key distinction concisely.',
  successfulToolTypeCounts: new Map([
    ['web_search', 1],
    ['read_document', 2],
  ]),
  openedSourceUrls: [
    'https://openai.com/research/browser-agents',
    'https://www.anthropic.com/research/computer-use',
  ],
  sourceEvidence: [
    { url: 'https://openai.com/research/browser-agents', title: 'Browser agents | OpenAI' },
    { url: 'https://www.anthropic.com/research/computer-use', title: 'Computer use | Anthropic' },
  ],
})
assert.equal(
  priorStepRunEvidence.ready,
  true,
  'two sources opened in a completed research step must remain sufficient after final-step counters reset',
)

assert.equal(
  assessBriefInlineRunResearchEvidence({
    request: 'Research two credible sources on browser agents and compare them concisely.',
    successfulToolTypeCounts: new Map([['web_search', 2]]),
    openedSourceUrls: [],
    sourceEvidence: [
      { url: 'https://example.com/search-result-one', title: 'Search result one' },
      { url: 'https://example.org/search-result-two', title: 'Search result two' },
    ],
  }).ready,
  false,
  'search-result metadata alone must not count as opened source evidence',
)

assert.equal(
  assessBriefInlineRunResearchEvidence({
    request: 'Compare two credible sources on browser agents concisely.',
    successfulToolTypeCounts: new Map([
      ['web_search', 1],
      ['read_document', 1],
    ]),
    openedSourceUrls: ['https://example.com/only-opened-source'],
    sourceEvidence: [
      { url: 'https://example.com/only-opened-source', title: 'Only opened source' },
      { url: 'https://example.org/unopened-search-result', title: 'Unopened result' },
    ],
  }).ready,
  false,
  'a two-source comparison must not pass with only one opened source',
)

assert.equal(
  assessBriefInlineRunResearchEvidence({
    request: 'Research a credible source on browser agents and answer concisely.',
    successfulToolTypeCounts: new Map(),
    openedSourceUrls: ['https://example.com/hydrated-old-source'],
    sourceEvidence: [{ url: 'https://example.com/hydrated-old-source', title: 'Old source' }],
  }).ready,
  false,
  'hydrated source/activity state without a fresh-run successful research tool must not satisfy the gate',
)

const verifier = new OutputVerifier()
const paragraph = 'This paragraph explains the selected source with concrete context, evidence, limitations, and implications for the requested topic while keeping every factual claim tied to the cited page. It is intentionally substantive enough to exercise the research verifier without relying on filler or unsupported claims.'
const oneSourceReport = [
  '# One-source research report',
  '## Executive Summary',
  paragraph,
  '## 1. Finding',
  paragraph,
  '## 2. Evidence',
  paragraph,
  '## 3. Limitations',
  paragraph,
  '## Conclusion',
  paragraph,
  '## References',
  '[1] https://example.com/credible-source',
].join('\\n\\n')
const oneSourceVerification = verifier.verify(
  oneSourceReport,
  'deliverables/one-source-report.md',
  'Research one credible source and write a saved Markdown report with that source.',
  'research',
  null,
  1,
)
assert.equal(
  oneSourceVerification.failures.some(failure => /citation/i.test(failure)),
  false,
  'an explicit saved one-source report must not be forced to invent five citations',
)

const compactChecklistDetail = 'This implementation note explains the concrete action, why it matters, the evidence supporting it, the practical trade-off, and the verification signal the reader should check before proceeding.'
const conciseStructuredGuide = [
  '# Concise implementation guide',
  '## Executive Summary',
  compactChecklistDetail + ' The guide intentionally uses a checklist structure so the requested brief deliverable remains actionable rather than becoming an unnecessarily long essay.',
  '## Preparation',
  '- [ ] Confirm the current configuration and record the expected behavior. ' + compactChecklistDetail,
  '- [ ] Capture one representative baseline before changing the system. ' + compactChecklistDetail,
  '## Implementation',
  '- [ ] Apply the smallest scoped configuration change first. ' + compactChecklistDetail,
  '- [ ] Exercise the primary workflow with realistic input. ' + compactChecklistDetail,
  '- [ ] Verify the visible result and the underlying persisted state. ' + compactChecklistDetail,
  '## Validation',
  '- [ ] Test the normal path, one boundary case, and one recovery path. ' + compactChecklistDetail,
  '- [ ] Record the outcome and any remaining limitation for handoff. ' + compactChecklistDetail,
  '## Conclusion',
  compactChecklistDetail + ' The sequence is deliberately compact, but every section contains enough context to be executed and independently checked.',
  '## References',
  '[1] https://example.com/implementation-source',
].join('\\n\\n')
const conciseGuideVerification = verifier.verify(
  conciseStructuredGuide,
  'deliverables/concise-guide.md',
  'Research one credible source and create a concise Markdown implementation guide with a short executive summary.',
  'research',
  null,
  3,
)
assert.equal(
  conciseGuideVerification.failures.some(failure =>
    /outline|substantive paragraph/i.test(failure)
  ),
  false,
  'a substantial concise checklist guide must not be rejected merely for using the requested compact structure',
)

const deepConciseVerification = verifier.verify(
  conciseStructuredGuide,
  'deliverables/deep-report.md',
  'Write a comprehensive in-depth research report that ends with a concise executive summary.',
  'research',
  null,
  5,
)
assert.equal(
  deepConciseVerification.failures.some(failure => /word count/i.test(failure)),
  true,
  'the word concise in a deep-report request must not lower the comprehensive research floor',
)

const request = 'Research three current facts about AI agent execution speed from three official primary sources, compare them, and answer in four concise bullets with direct links.'
assert.equal(requestedBriefInlineSourceCount(request), 3, 'the exact request must retain its explicit three-source floor')

const successfulSearchAndThreeReads = {
  request,
  researchCalls: 4,
  openedSourceUrls: [
    'https://openai.com/research/agents?utm_source=search',
    'https://www.anthropic.com/research/agents',
    'https://developers.googleblog.com/agents#latency',
  ],
  sourceEvidence: [
    { url: 'https://openai.com/research/agents?utm_source=search', title: 'Agent research | OpenAI' },
    { url: 'https://www.anthropic.com/research/agents', title: 'Agent research | Anthropic' },
    { url: 'https://developers.googleblog.com/agents#latency', title: 'Agent performance | Google for Developers' },
  ],
  toolResults: [
    { toolName: 'web_search', isError: false, acceptedForExecution: true },
    { toolName: 'read_document', isError: false, acceptedForExecution: true },
    { toolName: 'read_document', isError: false, acceptedForExecution: true },
    { toolName: 'read_document', isError: false, acceptedForExecution: true },
  ],
}

assert.equal(
  briefInlineResearchEvidenceReady(successfulSearchAndThreeReads),
  true,
  'one successful search plus three opened official sources must be ready to advance to concise synthesis',
)

const aggregatorReplay = {
  ...successfulSearchAndThreeReads,
  openedSourceUrls: [
    'https://aiagentsquare.com/agent-speed-guide',
    'https://aimultiple.com/ai-agent-benchmark',
    'https://example-aggregator.com/best-agent-latency',
  ],
  sourceEvidence: [
    { url: 'https://aiagentsquare.com/agent-speed-guide', title: 'AI Agent Speed Guide | AI Agent Square' },
    { url: 'https://aimultiple.com/ai-agent-benchmark', title: 'AI Agent Benchmarks Compared | AIMultiple' },
    { url: 'https://example-aggregator.com/best-agent-latency', title: 'Best AI Agent Latency Results' },
  ],
}
const aggregatorAssessment = assessBriefInlineResearchEvidence(aggregatorReplay)
assert.equal(
  aggregatorAssessment.ready,
  false,
  'the exact paid-replay request must remain on research when three opened URLs are aggregator articles',
)
assert.equal(aggregatorAssessment.reason, 'explicit-source-quality')
assert.deepEqual(
  aggregatorAssessment.rejectedDomains,
  ['aiagentsquare.com', 'aimultiple.com', 'example-aggregator.com'],
  'the recovery must identify the actual non-primary domains dynamically',
)
assert.match(aggregatorAssessment.recoveryInstruction || '', /Replace the non-primary domains/)
assert.match(aggregatorAssessment.recoveryInstruction || '', /Make one targeted web_search now/)
assert.match(aggregatorAssessment.recoveryInstruction || '', /Do not finalize yet/)

const ordinaryBrief = {
  ...aggregatorReplay,
  request: 'Research three credible authoritative sources about AI agent execution speed and answer in four concise bullets with direct links.',
}
assert.equal(
  assessBriefInlineResearchEvidence(ordinaryBrief).ready,
  true,
  'ordinary brief multi-source research must retain the fast URL-count path when no first-party constraint was requested',
)
assert.equal(
  briefInlineResearchEvidenceReady({
    ...successfulSearchAndThreeReads,
    openedSourceUrls: successfulSearchAndThreeReads.openedSourceUrls.slice(0, 2),
  }),
  false,
  'an explicit three-source request must not advance after only two opened sources',
)
assert.equal(
  briefInlineResearchEvidenceReady({
    ...successfulSearchAndThreeReads,
    openedSourceUrls: [
      'https://openai.com/research/agents?utm_source=search',
      'https://www.openai.com/research/agents',
      'https://developers.googleblog.com/agents',
    ],
  }),
  false,
  'tracking and www variants of the same page must not inflate the source count',
)
assert.equal(
  briefInlineResearchEvidenceReady({
    ...successfulSearchAndThreeReads,
    toolResults: successfulSearchAndThreeReads.toolResults.map(result => ({ ...result, isError: true })),
  }),
  false,
  'failed source actions must not trigger deterministic advancement',
)

const comparisonRequest = 'Give me a concise comparison of the two approaches.'
assert.equal(
  briefInlineResearchEvidenceReady({
    request: comparisonRequest,
    researchCalls: 1,
    openedSourceUrls: ['https://example.com/one'],
    toolResults: [{ toolName: 'read_document', isError: false, acceptedForExecution: true }],
  }),
  false,
  'a comparison must retain a two-source floor when no explicit count is present',
)

const livePlan = [
  'Find and extract three official primary sources on AI agent execution speed',
  'Compare and synthesize the three gathered facts',
  'Write four concise bullets with direct links',
]
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: livePlan,
    currentStepIdx: 0,
  }),
  2,
  'the exact live plan must fold its evidence-local comparison into the final inline answer turn',
)

assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Compare the gathered facts and verify them against another official source',
      livePlan[2],
    ],
    currentStepIdx: 0,
  }),
  null,
  'a verification phase must never be skipped',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Analyze the gathered facts alongside another independent source',
      livePlan[2],
    ],
    currentStepIdx: 0,
  }),
  null,
  'a phase asking for a new source must never be skipped even without an explicit browse verb',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Analyze the gathered facts',
      'Browse for missing current evidence',
      livePlan[2],
    ],
    currentStepIdx: 0,
  }),
  null,
  'a remaining browsing or source-gathering phase must never be skipped',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Analyze the gathered facts and create a comparison file',
      livePlan[2],
    ],
    currentStepIdx: 0,
  }),
  null,
  'file or artifact work must never be folded into an inline answer turn',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Analyze the gathered facts using supporting images',
      livePlan[2],
    ],
    currentStepIdx: 0,
  }),
  null,
  'image work must never be folded into an inline answer turn',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request: request + ' Use exactly three separate phases and do not combine them.',
    planItems: livePlan,
    currentStepIdx: 0,
  }),
  null,
  'an explicit separate-phase request must preserve every phase',
)
assert.equal(
  briefInlineFinalDeliveryStepIndex({
    request,
    planItems: [
      livePlan[0],
      'Analyze the gathered facts',
      'Create a four-bullet Markdown file with direct links',
    ],
    currentStepIdx: 0,
  }),
  null,
  'a saved-artifact final step must not be treated as an inline delivery step',
)
`, 'utf8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  console.log('brief inline research advance smoke passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
