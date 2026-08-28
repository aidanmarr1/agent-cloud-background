#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const root = fileURLToPath(new URL('..', import.meta.url))
const srcPath = fileURLToPath(new URL('../src', import.meta.url))
const jiti = createJiti(import.meta.url, {
  alias: { '@': srcPath },
})

const {
  exactExtractionGuardToolNames,
  updateExactExtractionGuardAfterTools,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/AgentLoop.ts', import.meta.url)))
const {
  advanceStep,
  createInitialState,
} = await jiti.import(fileURLToPath(new URL('../src/lib/agent/AgentState.ts', import.meta.url)))

function researchState(request, strategy = 'research') {
  const state = createInitialState(false, {
    iterationTimeoutMs: 30_000,
    inactivityTimeoutMs: 30_000,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 100,
  })
  state.originalUserRequest = request
  state.currentPlanItems = ['Verify the requested source detail', 'Answer with evidence']
  state.currentPlanScopes = ['Use the official source.', 'Give the answer.']
  state.currentStepIdx = 0
  state.currentPhase = 'research'
  state.taskStrategy = strategy
  return state
}

function toolResult(id, name, args, result, isError = false) {
  return {
    tc: { id, name, arguments: JSON.stringify(args) },
    result,
    isError,
  }
}

const exactUrl = 'https://official.example/release?region=au#date'
const exactRequest = 'Verify the exact launch date shown on the official release page.'
const exactMessages = [{ role: 'user', content: exactRequest }]
const exactState = researchState(exactRequest)

updateExactExtractionGuardAfterTools(exactState, [
  toolResult(
    'read-1',
    'read_document',
    {
      action_label: 'Extract official launch date evidence',
      plan_step_index: 1,
      url: exactUrl,
    },
    {
      type: 'text',
      title: 'Official release',
      content: 'The official release page shows the launch date as 18 September.',
      wordCount: 11,
      source: exactUrl,
    },
  ),
], exactMessages)

assert.equal(exactState.exactExtractionGuardPending, true, 'a successful exact-relevant webpage extraction should arm rendered confirmation')
assert.equal(exactState.exactExtractionGuardSourceUrl, exactUrl, 'the extracted exact URL must be retained for rendered confirmation')
assert.deepEqual(
  [...exactExtractionGuardToolNames(exactState)],
  ['browser_navigate'],
  'the first rendered-confirmation turn should expose only exact navigation',
)
assert.match(exactState.exactExtractionGuardPrompt || '', /same source[\s\S]*exact URL verbatim/i, 'confirmation must navigate the extracted source rather than discover a replacement')
assert.ok((exactState.exactExtractionGuardPrompt || '').includes(JSON.stringify(exactUrl)), 'the exact extracted URL, including query and fragment, must survive in the navigation prompt')

updateExactExtractionGuardAfterTools(exactState, [
  toolResult(
    'nav-1',
    'browser_navigate',
    {
      action_label: 'Open official launch date display',
      plan_step_index: 1,
      url: exactUrl,
    },
    {
      success: true,
      url: exactUrl,
      title: 'Official release',
      content: '[1] Release details',
    },
  ),
], exactMessages)

assert.equal(exactState.exactExtractionGuardPending, true, 'loading the exact page should transition to inspection rather than complete confirmation')
assert.equal(exactState.exactExtractionGuardSourceUrl, null, 'the exact navigation stage should clear after that URL loads')
assert.deepEqual(
  [...exactExtractionGuardToolNames(exactState)].sort(),
  ['browser_find_text', 'browser_get_content', 'browser_screenshot', 'browser_scroll'].sort(),
  'rendered inspection should offer targeted text, content, screenshot, and scroll tools',
)
assert.match(exactState.exactExtractionGuardPrompt || '', /browser_find_text[\s\S]*browser_screenshot/, 'the second stage must target rendered text or visual evidence')

updateExactExtractionGuardAfterTools(exactState, [
  toolResult(
    'find-1',
    'browser_find_text',
    {
      action_label: 'Confirm displayed launch date',
      plan_step_index: 1,
      query: 'launch',
    },
    {
      success: true,
      url: exactUrl,
      title: 'Official release',
      content: 'Found 1 match for launch. Snippet: Launch date: 18 September.',
    },
  ),
], exactMessages)

assert.equal(exactState.exactExtractionGuardPending, false, 'a usable rendered observation should complete exact confirmation')
assert.equal(exactState.exactExtractionGuardPrompt, null)
assert.equal(exactState.exactExtractionGuardSourceUrl, null)

const noMatchState = researchState(exactRequest)
updateExactExtractionGuardAfterTools(noMatchState, [
  toolResult('read-no-match', 'read_document', {
    action_label: 'Extract official launch date evidence',
    plan_step_index: 1,
    url: exactUrl,
  }, {
    type: 'text',
    title: 'Official release',
    content: 'The official release page shows the launch date as 18 September.',
    source: exactUrl,
  }),
], exactMessages)
updateExactExtractionGuardAfterTools(noMatchState, [
  toolResult('nav-no-match', 'browser_navigate', {
    action_label: 'Open official launch date display',
    plan_step_index: 1,
    url: exactUrl,
  }, {
    success: true,
    url: exactUrl,
    title: 'Official release',
    content: '[1] Release details',
  }),
], exactMessages)
updateExactExtractionGuardAfterTools(noMatchState, [
  toolResult('find-no-match', 'browser_find_text', {
    action_label: 'Find displayed launch date',
    plan_step_index: 1,
    query: 'launch date',
  }, {
    success: true,
    url: exactUrl,
    title: 'Official release',
    content: 'TEXT SEARCH RESULT: No visible text nodes matched "launch date".',
  }),
], exactMessages)
assert.equal(noMatchState.exactExtractionGuardPending, true, 'a zero-match text search must not be treated as exact confirmation')
updateExactExtractionGuardAfterTools(noMatchState, [
  toolResult('scroll-no-match', 'browser_scroll', {
    action_label: 'Reveal additional release details',
    plan_step_index: 1,
    direction: 'down',
  }, {
    success: true,
    url: exactUrl,
    title: 'Official release',
    content: '[1] More release details',
  }),
], exactMessages)
assert.equal(noMatchState.exactExtractionGuardPending, true, 'scrolling alone must not be treated as exact confirmation')
updateExactExtractionGuardAfterTools(noMatchState, [
  toolResult('content-label-only', 'browser_get_content', {
    action_label: 'Confirm displayed launch date on the official page',
    plan_step_index: 1,
  }, {
    success: true,
    url: exactUrl,
    title: 'Official release',
    content: 'The rendered page contains general release information but no targeted value.',
  }),
], exactMessages)
assert.equal(
  noMatchState.exactExtractionGuardPending,
  true,
  'a matching action label must not substitute for matching rendered evidence',
)

const genericRequest = 'Research current launch dates, pricing, and availability across these products.'
const genericState = researchState(genericRequest)
updateExactExtractionGuardAfterTools(genericState, [
  toolResult(
    'read-generic',
    'read_document',
    {
      action_label: 'Extract current launch and pricing details',
      plan_step_index: 1,
      url: 'https://official.example/products',
    },
    {
      type: 'text',
      title: 'Products',
      content: 'Launch, price, and availability details for the current products.',
      wordCount: 9,
      source: 'https://official.example/products',
    },
  ),
], [{ role: 'user', content: genericRequest }])
assert.equal(genericState.exactExtractionGuardPending, false, 'generic date/price research must not be hard-blocked into visual confirmation')

const exactTextOnlyRequest = 'Confirm the exact launch date from the official release text.'
const exactTextOnlyState = researchState(exactTextOnlyRequest)
updateExactExtractionGuardAfterTools(exactTextOnlyState, [
  toolResult(
    'read-exact-text',
    'read_document',
    {
      action_label: 'Extract exact official launch date',
      plan_step_index: 1,
      url: exactUrl,
    },
    {
      type: 'text',
      title: 'Official release',
      content: 'The launch date is 18 September.',
      wordCount: 6,
      source: exactUrl,
    },
  ),
], [{ role: 'user', content: exactTextOnlyRequest }])
assert.equal(exactTextOnlyState.exactExtractionGuardPending, false, 'exact text or data alone should remain extraction-first unless rendered confirmation is requested')

const failedConfirmationState = researchState(exactRequest)
updateExactExtractionGuardAfterTools(failedConfirmationState, [
  toolResult(
    'read-before-failed-nav',
    'read_document',
    {
      action_label: 'Extract official launch date evidence',
      plan_step_index: 1,
      url: exactUrl,
    },
    {
      type: 'text',
      title: 'Official release',
      content: 'The official release page shows the launch date as 18 September.',
      wordCount: 11,
      source: exactUrl,
    },
  ),
], exactMessages)
updateExactExtractionGuardAfterTools(failedConfirmationState, [
  toolResult(
    'failed-nav',
    'browser_navigate',
    {
      action_label: 'Open official launch date display',
      plan_step_index: 1,
      url: exactUrl,
    },
    {
      success: false,
      url: exactUrl,
      title: '',
      error: 'Rendered page failed to load',
    },
    true,
  ),
], exactMessages)
assert.equal(failedConfirmationState.exactExtractionGuardPending, false, 'failed rendered confirmation must release the guard instead of inventing a permanent blocker')
assert.equal(failedConfirmationState.exactExtractionGuardSourceUrl, null)

const httpState = researchState('Confirm the precise price displayed by the official endpoint.')
const httpUrl = 'https://official.example/api/price?region=au'
updateExactExtractionGuardAfterTools(httpState, [
  toolResult(
    'http-1',
    'http_request',
    {
      action_label: 'Extract precise official price',
      plan_step_index: 1,
      method: 'GET',
      url: httpUrl,
    },
    {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"price":"A$149"}',
      durationMs: 10,
    },
  ),
], [{ role: 'user', content: httpState.originalUserRequest }])
assert.equal(httpState.exactExtractionGuardSourceUrl, httpUrl, 'a successful GET extraction should retain its exact URL for optional rendered confirmation')
advanceStep(httpState, 'Confirmed price evidence')
assert.equal(httpState.exactExtractionGuardPending, false, 'exact-confirmation state must not leak into the next plan phase')
assert.equal(httpState.exactExtractionGuardSourceUrl, null)

const actionState = researchState('Open the page and select the exact displayed delivery date.', 'browse')
updateExactExtractionGuardAfterTools(actionState, [
  toolResult(
    'action-nav',
    'browser_navigate',
    {
      action_label: 'Open delivery date selector',
      plan_step_index: 1,
      url: 'https://shop.example/delivery',
    },
    {
      success: true,
      url: 'https://shop.example/delivery',
      title: 'Delivery',
      content: '[1] Select delivery date',
    },
  ),
], [{ role: 'user', content: actionState.originalUserRequest }])
assert.equal(actionState.exactExtractionGuardPending, false, 'browser action tasks should remain in their live interaction flow instead of entering a research detour')

const noBrowserRequest = 'Confirm the exact launch date shown on the page without using browser tools.'
const noBrowserState = researchState(noBrowserRequest)
updateExactExtractionGuardAfterTools(noBrowserState, [
  toolResult('read-no-browser', 'read_document', {
    action_label: 'Extract official launch date evidence',
    plan_step_index: 1,
    url: exactUrl,
  }, {
    type: 'text',
    title: 'Official release',
    content: 'The official release page shows the launch date as 18 September.',
    source: exactUrl,
  }),
], [{ role: 'user', content: noBrowserRequest }])
assert.equal(noBrowserState.exactExtractionGuardPending, false, 'an explicit browser prohibition must prevent the rendered-confirmation guard from arming')

const [prompts, tools, taskStrategy, policyEngine, toolPipeline, agentLoop] = await Promise.all([
  readFile(`${root}/src/lib/prompts.ts`, 'utf8'),
  readFile(`${root}/src/lib/tools.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/TaskStrategy.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/PolicyEngine.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/ToolPipeline.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/AgentLoop.ts`, 'utf8'),
])

assert.match(prompts, /web_search for discovery[\s\S]*default to read_document or HTTP\/text extraction[\s\S]*exact details? that need visibly rendered confirmation/i, 'research prompts should encode extract-first discovery follow-up and targeted browser use')
assert.match(tools, /name: 'read_document'[\s\S]*default way to read an ordinary webpage selected from search results/, 'the document tool schema should make ordinary result extraction the default')
assert.match(tools, /name: 'browser_navigate'[\s\S]*interaction\/action tasks[\s\S]*exact details that must be confirmed as visibly rendered/, 'browser navigation should be reserved primarily for dynamic, visual, or action needs')
assert.match(taskStrategy, /toolPriority: \['web_search', 'read_document', 'browser_navigate', 'create_file'\]/, 'research tool ordering must continue to prefer extraction before browser navigation')
assert.match(taskStrategy, /browse:[\s\S]*toolPriority: \['browser_navigate'/, 'interaction/action strategy must keep browser navigation primary')
assert.doesNotMatch(policyEngine, /ALL providers are down/, 'repeated search failures must not invent a global provider outage')
assert.match(policyEngine, /This does not establish that all search providers or web access are unavailable[\s\S]*read_document or HTTP\/text extraction[\s\S]*exact visibly rendered confirmation/, 'search recovery should prefer direct extraction without asserting false global blocking')
assert.match(toolPipeline, /web_search was skipped because the user supplied the exact target[\s\S]*Act on that exact URL now:[\s\S]*read_document or HTTP\/text extraction/, 'known user URLs must retain direct exact-target routing')
assert.match(agentLoop, /hasDirectSourceTool[\s\S]*activeTools = activeTools\.filter\(tool => tool\.function\?\.name !== 'web_search'\)/, 'an exact user URL must still remove premature discovery search when a direct route exists')
assert.match(agentLoop, /explicitToolConstraint[\s\S]*toolAllowedByExplicitTaskConstraint\(explicitToolConstraint, 'browser_navigate'\)/, 'rendered confirmation must respect explicit browser prohibitions')
assert.match(agentLoop, /if \(activeTools\.length === 0\)[\s\S]*clearExactExtractionGuard\(state\)[\s\S]*RENDERED CONFIRMATION UNAVAILABLE/, 'missing browser capability must release the guard with an honest unverified-confirmation instruction')

console.log('research tool routing smoke: PASS')
