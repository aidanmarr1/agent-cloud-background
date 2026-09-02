#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'

// Pure recorded-evidence checks: no live browser, provider call, or user task.
delete process.env.TURSO_DATABASE_URL
delete process.env.TURSO_AUTH_TOKEN
const root = fileURLToPath(new URL('../', import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { '@': `${root}src` } })
const browser = await jiti.import(`${root}src/lib/browserIntelligence.ts`)
const cleaners = await jiti.import(`${root}src/lib/stream/cleaners.ts`)
const { createInitialState } = await jiti.import(`${root}src/lib/agent/AgentState.ts`)
const { PolicyEngine } = await jiti.import(`${root}src/lib/agent/PolicyEngine.ts`)

const page = {
  success: true,
  url: 'https://shop.example.test/products/widget-pro/silver-256gb',
  title: 'Widget Pro 256GB Silver',
  content: 'Widget Pro. Silver [SELECTED]. 256GB [SELECTED]. Listed price A$1,999.00 including GST. Add to bag.',
}
const history = []
function observe(toolName, args = {}, result = page) {
  const targetKey = browser.getBrowserActionTargetKey(toolName, args)
  const outcome = browser.classifyBrowserProgress(history, toolName, args, result, targetKey)
  history.push({
    toolName, targetKey, url: result.url, title: result.title,
    pageSignature: outcome.pageSignature, progressKind: outcome.kind,
    success: result.success !== false && !result.error,
    recoveryUsed: browser.isBrowserRecoveryTool(toolName, args), createdAt: Date.now(),
  })
  return outcome
}

assert.equal(observe('browser_navigate', { url: page.url }).kind, 'progress')
assert.equal(observe('browser_get_content').kind, 'progress', 'one full text read can add evidence beyond a navigation snapshot')
for (const [tool, args] of [
  ['browser_find_text', { query: 'Silver' }],
  ['browser_screenshot', {}],
  ['browser_find_text', { query: 'A$1,999.00' }],
  ['browser_get_content', {}],
]) {
  assert.match(observe(tool, args).kind, /^no_progress_/, 'switching tools or search terms must not reset unchanged-state detection')
}
const otherView = { ...page, content: `${page.content}\nDelivery estimates appear after entering a postcode.` }
assert.equal(observe('browser_scroll', { direction: 'down', amount: 400 }, otherView).kind, 'progress')
assert.match(observe('browser_scroll', { direction: 'up', amount: 400 }).kind, /^no_progress_/, 'returning to an already-read view must not count as new evidence')
assert.equal(observe('browser_click_at', { x: 120, y: 200 }, { ...page, content: 'Widget Pro. Blue [SELECTED]. 256GB [SELECTED]. Listed price A$1,999.00.' }).kind, 'progress')
assert.equal(observe('browser_click_at', { x: 200, y: 200 }).kind, 'progress', 'a genuine selection change is progress even when returning to a prior variant')
const prefix = 'Unchanged introduction. '.repeat(150)
assert.notEqual(
  browser.computeBrowserPageSignature({ ...page, content: `${prefix}\nPrice A$1,999.00` }),
  browser.computeBrowserPageSignature({ ...page, content: `${prefix}\nPrice A$1,899.00` }),
  'evidence changes beyond the old 2,000-character prefix must remain visible',
)
assert.notEqual(
  browser.computeBrowserPageSignature({ ...page, content: 'Address (value: "Sydney")' }),
  browser.computeBrowserPageSignature({ ...page, content: 'Address (value: "Melbourne")' }),
  'form values are real state, not disposable viewport noise',
)

const financeFinding = 'Confirmed Widget Pro 256GB Silver at A$1,999.00 total (A$83.29/mo. via Afterpay), with GST included in the listed price.'
assert.equal(cleaners.sanitizeNarrationText(financeFinding), financeFinding, 'a monthly-price abbreviation must not split or discard a valid finding')
assert.equal(cleaners.sanitizeNarrationText('via Afterpay), with GST approx A$182.00 included; the selected variant satisfies the requested Silver colour and 256GB storage.'), null, 'orphaned sentence tails must never become progress updates')
assert.equal(
  cleaners.sanitizeNarrationText('Dr. Ellis confirmed the three measured outcomes in the independent university study published this year.'),
  'Dr. Ellis confirmed the three measured outcomes in the independent university study published this year.',
  'titles and abbreviations must stay attached to their sentence',
)
assert.equal(cleaners.sanitizeNarrationText(financeFinding, { maxLength: 80 }), null, 'a length limit must not cut at the monthly-price abbreviation')

const locatedFinding = 'Located Widget Pro on the official product page, with Silver and 256GB selected at a listed A$1,999.00 including GST.'
assert.equal(browser.reviewBrowserPhaseCompletion('Locate Widget Pro on the store', locatedFinding, page).completed, true)
assert.equal(browser.reviewBrowserPhaseCompletion('Locate Widget Pro on the store', locatedFinding.replace('1,999.00', '1,999'), page).completed, true, 'equivalent numeric formatting must not force another verification call')
assert.equal(browser.reviewBrowserPhaseCompletion('Locate Widget Pro on the store', locatedFinding.replace('1,999', '999'), page).completed, false, 'an unsupported amount must not qualify as grounded evidence')
assert.equal(browser.reviewBrowserPhaseCompletion('Locate Widget Pro on the store', locatedFinding, null).completed, false)
assert.equal(browser.reviewBrowserPhaseCompletion('Locate Widget Pro on the store', locatedFinding, { ...page, success: false, error: 'Navigation failed' }).completed, false)
assert.equal(browser.reviewBrowserPhaseCompletion('Add Widget Pro to cart', 'Widget Pro was added to the cart at A$1,999.00.', page).completed, false, 'a visible Add to bag button does not prove an order/cart mutation')
assert.equal(browser.reviewBrowserPhaseCompletion('Submit the contact form', 'The contact form was submitted successfully.', {
  ...page, content: 'VISIBLE VALIDATION ERRORS:\n- Email is required.\n[3] Submit button',
}).completed, false, 'model prose cannot override visible validation errors')

const state = createInitialState(false, {
  iterationTimeoutMs: 30000, inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null, contentOnlyMinChars: 0, checkIntervalMs: 100,
})
state.taskStrategy = 'browse'
state.originalUserRequest = 'Choose a Widget Pro in Silver and 256GB on the store and tell me its price.'
state.currentPlanItems = ['Locate Widget Pro on the store', 'Configure Silver and 256GB and capture pricing', 'Deliver the price and source link']
state.currentPlanScopes = []
state.lastBrowserObservation = page
state.stepToolCallCount = 6
state.phaseNarrationEmittedThisStep = true
state.consecutiveNoProgressClicks = 5
const policy = new PolicyEngine()
const located = policy.evaluate(state, new Map(), locatedFinding, true, 30)
assert.equal(state.currentStepIdx, 1, 'an evidence-backed model advance must take precedence over the no-progress nudge')
assert.ok(located.some(action => action.type === 'step_advance'), 'manual browser advancement must drive context compaction and budget bookkeeping too')
assert.equal(state.lastBrowserObservation, page, 'phase advancement must retain page evidence')
assert.equal(state.stepToolCallCount, 0)
const configured = policy.evaluate(state, new Map(), locatedFinding, true, 30)
assert.equal(state.currentStepIdx, 2, 'a later phase already satisfied by the observed selection must not require a redundant tool call')
assert.ok(configured.some(action => action.type === 'step_advance'))
assert.match(configured.map(action => action.message?.content || '').join(' '), /unverified checkout total/, 'handoff must distinguish listed prices from checkout claims')
const final = policy.evaluate(state, new Map(), 'Widget Pro in Silver with 256GB is listed at **A$1,999 including GST**. Delivery charges are not confirmed. [Product page](https://shop.example.test/products/widget-pro/silver-256gb).', true, 30)
assert.equal(state.currentStepIdx, 3, 'the answer must finish the final phase without restarting verification')
assert.ok(final.some(action => action.type === 'terminate' && action.reason === 'inline_answer_complete'))
state.currentStepIdx = 2
state.finalInlineAnswerDelivered = false
const unmarkedFinal = policy.evaluate(state, new Map(), 'Widget Pro in Silver with 256GB is listed at A$1,999 including GST. Delivery charges are not confirmed.', false, 30)
assert.ok(unmarkedFinal.some(action => action.type === 'terminate' && action.reason === 'inline_answer_complete'), 'a normal final answer should not need an internal marker to finish')
state.currentStepIdx = 2
state.originalUserRequest = 'Submit the contact form.'
state.currentPlanItems[2] = 'Report the form submission result'
state.lastBrowserObservation = { ...page, content: 'VISIBLE VALIDATION ERRORS:\n- Email is required.\n[3] Submit button' }
const falseSuccess = policy.evaluate(state, new Map(), 'The contact form was submitted successfully and your registration is complete.', true, 30)
assert.equal(state.currentStepIdx, 2, 'the final-answer fix must not allow a success claim contradicted by visible validation errors')
assert.ok(!falseSuccess.some(action => action.type === 'terminate'))

console.log('Browser task regression smoke passed')
