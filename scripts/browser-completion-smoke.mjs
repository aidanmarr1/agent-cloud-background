import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = await mkdtemp(join(root, 'scripts/.browser-completion-smoke-runner-'))
const runnerPath = join(workDir, 'runner.ts')
const bundlePath = join(workDir, 'runner.mjs')

try {
  await writeFile(runnerPath, `
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createFileInSandbox, getSandboxDirPath } from ${JSON.stringify(join(root, 'src/lib/sandbox.ts'))}
import { buildLocalWebsiteLaunch, stopLocalWebsiteServer } from ${JSON.stringify(join(root, 'src/lib/localWebsiteServer.ts'))}
import { browserActionPreflight, destroyBrowserSession, normalizeBrowserScrollArgs } from ${JSON.stringify(join(root, 'src/lib/browser.ts'))}
import { createInitialState } from ${JSON.stringify(join(root, 'src/lib/agent/AgentState.ts'))}
import { ToolPipeline } from ${JSON.stringify(join(root, 'src/lib/agent/ToolPipeline.ts'))}
import { PolicyEngine } from ${JSON.stringify(join(root, 'src/lib/agent/PolicyEngine.ts'))}
import { detectBrowserTaskCompletion } from ${JSON.stringify(join(root, 'src/lib/browserIntelligence.ts'))}

const timeouts = {
  iterationTimeoutMs: 30000,
  inactivityTimeoutMs: 30000,
  contentOnlyTimeoutMs: null,
  contentOnlyMinChars: 0,
  checkIntervalMs: 100,
}

function makeEmitter() {
  const results: Array<{ id: string; name: string; result: unknown }> = []
  return {
    results,
    toolStart() {},
    toolResult(id: string, name: string, result: unknown) { results.push({ id, name, result }) },
    terminalOutput() {},
    artifactCreated() {},
    fileContentStart() {},
    fileContentDelta() {},
  }
}

async function call(pipeline: ToolPipeline, state: ReturnType<typeof createInitialState>, id: string, name: string, args: Record<string, unknown>) {
  const defaultLabels: Record<string, string> = {
    browser_navigate: 'Load local smoke test page',
    browser_click_at: 'Activate smoke product bag control',
    browser_fill_form: 'Submit smoke signup form inputs',
  }
  const decoratedArgs = {
    action_label: defaultLabels[name] || 'Use smoke test control now',
    plan_step_index: state.currentStepIdx + 1,
    ...args,
  }
  const calls = new Map([[0, { id, name, arguments: JSON.stringify(decoratedArgs) }]])
  const results = await pipeline.executeAll(calls, state)
  assert.equal(results.length, 1)
  return results[0]
}

async function writePage(conversationId: string, path: string, body: string) {
  const html = \`<!doctype html>
<html>
  <head><title>Browser Completion Smoke</title></head>
  <body><main>\${body}</main></body>
</html>\`
  await createFileInSandbox(conversationId, path, html)
  return buildLocalWebsiteLaunch(conversationId, path)
}

function assertPureCompletionFixtures() {
  const cart = detectBrowserTaskCompletion('Add the silver 256GB phone to cart', {
    success: true,
    url: 'https://example.test/shop/cart',
    title: 'Your Bag',
    content: 'Silver 256GB phone. Added to Bag. Bag subtotal $999. Continue to Checkout.',
    action: 'Clicked Add to Bag',
  })
  assert.equal(cart.completed, true)
  assert.ok(cart.confidence >= 0.9)

  const wrongCartItem = detectBrowserTaskCompletion('Add pancake mix to cart', {
    success: true,
    url: 'https://example.test/shop/cart',
    title: 'Your Cart',
    content: 'Milk 2L. Added to Cart. Cart subtotal $4. Continue to Checkout.',
    action: 'Clicked Add to Cart',
  })
  assert.equal(wrongCartItem.completed, false, 'cart confirmation for a different item must not complete the requested item')
  assert.match(wrongCartItem.reason, /requested item/i)

  const rightCartItem = detectBrowserTaskCompletion('Add pancake mix to cart', {
    success: true,
    url: 'https://example.test/shop/cart',
    title: 'Your Cart',
    content: 'Pancake Mix. Added to Cart. Cart subtotal $3. Continue to Checkout.',
    action: 'Clicked Add to Cart',
  })
  assert.equal(rightCartItem.completed, true, 'cart confirmation with the requested item should complete')
  assert.ok(rightCartItem.evidence.some(line => /requested item visible/i.test(line)))

  const form = detectBrowserTaskCompletion('Submit the contact form', {
    success: true,
    url: 'https://example.test/contact',
    title: 'Thank you',
    content: 'Thank you. Your message was sent successfully. Confirmation #1234.',
  })
  assert.equal(form.completed, true)

  const invalidSignup = detectBrowserTaskCompletion('Report final state of the sign-up attempt', {
    success: true,
    url: 'https://example.test/signup',
    title: 'Sign up',
    action: 'Clicked Sign Up',
    content: 'VISIBLE VALIDATION ERRORS:\\n- Username: Username can be 3 to 20 characters long.\\nCorrect the named field(s) before clicking submit, advancing the plan, or reporting success.\\n[3] button "Sign Up"',
  })
  assert.equal(invalidSignup.completed, false, 'visible validation text must prevent sign-up/report completion')
  assert.match(invalidSignup.reason, /validation/i)

  const configured = detectBrowserTaskCompletion('Choose 256GB silver', {
    success: true,
    url: 'https://example.test/configure',
    title: 'Configure',
    content: '[SELECTED] 256GB\\n[CHECKED] Silver\\n[button] Add to Bag',
  })
  assert.equal(configured.completed, true)

  const partialCart = detectBrowserTaskCompletion('Choose 256GB silver and add it to cart', {
    success: true,
    url: 'https://example.test/configure',
    title: 'Configure',
    content: '[SELECTED] 256GB\\n[CHECKED] Silver\\n[button] Add to Bag',
  })
  assert.equal(partialCart.completed, false, 'selected options alone must not complete add-to-cart tasks')

  const groceryHomeWithCartLink = detectBrowserTaskCompletion('Navigate to Woolworths, search for pancake mix, and add to cart', {
    success: true,
    url: 'https://www.woolworths.com.au/',
    title: 'Woolworths Supermarket - Buy Groceries Online',
    action: 'Navigated to Woolworths Supermarket - Buy Groceries Online',
    content: 'Search apples in stock\\n[12] link -> a[href="/shop/cart"] "Cart $0.00"\\nWelcome to Woolworths\\nBrowse products',
  })
  assert.equal(groceryHomeWithCartLink.completed, false, 'homepage cart link and $0 cart must not complete add-to-cart tasks')

  const woolworthsSetup = detectBrowserTaskCompletion('Navigate to Woolworths and accept cookies/location\\nOpen the user requested URL/domain directly when present. Handle popups only if they block the task.', {
    success: true,
    url: 'https://www.woolworths.com.au/shop/search/products?searchTerm=flour',
    title: 'flour - Woolworths Online',
    action: 'Typed "flour" (submitting)',
    content: 'Showing results for "flour". 62 Products. Browse products. Add to cart. Cart $0.00.',
  })
  assert.equal(woolworthsSetup.completed, true, 'setup/navigation phase should complete once requested site is loaded and usable')
  assert.match(woolworthsSetup.reason, /loaded and usable/i)

  const woolworthsSearchAndCart = detectBrowserTaskCompletion('Navigate to Woolworths and search for flour\\nSearch for flour and add it to cart.', {
    success: true,
    url: 'https://www.woolworths.com.au/shop/search/products?searchTerm=flour',
    title: 'flour - Woolworths Online',
    action: 'Typed "flour" (submitting)',
    content: 'Showing results for "flour". 62 Products. Add to cart. Cart $0.00.',
  })
  assert.equal(woolworthsSearchAndCart.completed, false, 'navigation completion must not mask a step that still asks for search/add-to-cart work')

  const woolworthsVisibleResults = detectBrowserTaskCompletion('Select and add flour, milk, and eggs to the cart', {
    success: true,
    url: 'https://www.woolworths.com.au/shop/search/products?searchTerm=plain%20flour',
    title: 'plain flour - Woolworths Online',
    action: 'Scrolled down 600px',
    content: 'Essentials Plain Flour 1kg. $1.30. Add to cart. White Wings Plain Flour 1kg. $3.40. Add to cart. Cart $0.00.',
  })
  assert.equal(woolworthsVisibleResults.completed, false, 'visible Woolworths results with Add to cart controls must stay actionable, not count as completed')

  const emptyCartPage = detectBrowserTaskCompletion('Add pancake mix to cart', {
    success: true,
    url: 'https://www.woolworths.com.au/shop/cart',
    title: 'Cart',
    action: 'Clicked Cart',
    content: 'Your cart is empty. Cart $0.00. Continue shopping. Checkout',
  })
  assert.equal(emptyCartPage.completed, false, 'empty cart page must not complete add-to-cart tasks')

  const amazonHome = detectBrowserTaskCompletion('Navigate to Amazon Australia and search for led lights\\nGo to amazon.com.au, locate the search bar, type led lights, and submit the search.', {
    success: true,
    url: 'https://www.amazon.com.au/',
    title: 'Amazon.com.au: Shop online',
    action: 'Navigated to Amazon',
    content: 'We are showing items that deliver to Sydney. Top Deals. Select Kitchen items under $25.',
  })
  assert.equal(amazonHome.completed, false, 'homepage navigation alone must not complete a search step')

  const amazonSearchByUrl = detectBrowserTaskCompletion('Navigate to Amazon Australia and search for led lights\\nGo to amazon.com.au, locate the search bar, type led lights, and submit the search.', {
    success: true,
    url: 'https://www.amazon.com.au/s?k=led+lights',
    title: 'Amazon.com.au: led lights',
    action: 'Pressed key: Enter',
    content: 'LED strip lights, fairy lights, and outdoor lighting products.',
  })
  assert.equal(amazonSearchByUrl.completed, true, 'search result URL plus requested terms should complete the search step')

  const amazonSearchListing = detectBrowserTaskCompletion('Click on the third search result\\nIdentify the third product listing in the search results and click its title or image to open the product page.', {
    success: true,
    url: 'https://www.amazon.com.au/s?k=led+lights',
    title: 'Amazon.com.au: led lights',
    action: 'Clicked element [12]',
    content: 'Search results for led lights. Showing results.',
  })
  assert.equal(amazonSearchListing.completed, false, 'search listing must not complete a click-third-result step')

  const amazonProduct = detectBrowserTaskCompletion('Click on the third search result\\nIdentify the third product listing in the search results and click its title or image to open the product page.', {
    success: true,
    url: 'https://www.amazon.com.au/Smart-LED-Light-Strip/dp/B123456789',
    title: 'Smart LED Light Strip',
    action: 'Clicked element [12]',
    content: 'Smart LED Light Strip. About this item. Add to Cart. Customer reviews. Price $19.99.',
  })
  assert.equal(amazonProduct.completed, true, 'clicked product detail page should complete the click-result step')

  const ablisBusinessType = detectBrowserTaskCompletion('Navigate to ABLIS and initiate the business registration search', {
    success: true,
    url: 'https://ablis.business.gov.au/search/activity',
    title: 'Business type - Australian Business Licence and Information Service',
    action: 'Clicked element [3]',
    content: 'Step 1 of 5\\nBusiness type\\nTo help find what licences and permits you may need, tell us what types of activities your business will do.\\nFor example: Café\\nPrevious\\nNext\\nYour business details',
  })
  assert.equal(ablisBusinessType.completed, true, 'ready ABLIS business-type form should complete the search-initiation phase')
  assert.match(ablisBusinessType.reason, /ready for the next form input/i)
}

function assertBrowserStepPolicyFixtures() {
  const timeouts = {
    iterationTimeoutMs: 30000,
    inactivityTimeoutMs: 30000,
    contentOnlyTimeoutMs: null,
    contentOnlyMinChars: 0,
    checkIntervalMs: 100,
  }
  const policy = new PolicyEngine()
  const state = createInitialState(false, timeouts)
  state.taskStrategy = 'browse'
  state.currentPlanItems = [
    'Navigate to Amazon Australia and search for led lights',
    'Click on the third search result',
    'Report final state and confirm action',
  ]
  state.currentPlanScopes = [
    'Go to amazon.com.au, locate the search bar, type led lights, and submit the search.',
    'Identify the third product listing in the search results and click its title or image to open the product page.',
    'Verify the page loaded is the 3rd result and report the product title and URL.',
  ]
  state.currentStepIdx = 0
  state.stepToolCallCount = 1
  state.browserTaskCompleted = false
  const blocked = policy.evaluate(state, new Map(), '<next_step/>', true, 20)
  assert.equal(state.currentStepIdx, 0, 'browser <next_step/> without completion evidence must not advance state')
  assert.ok(blocked.some(action => action.type === 'inject_message'), 'browser <next_step/> without evidence should inject corrective guidance')
  assert.ok(!blocked.some(action => action.type === 'step_advance'), 'browser <next_step/> without evidence must not emit step advance')

  state.browserTaskCompleted = true
  state.browserTaskCompletionEvidence = ['Search results/listing page is visible.', 'Search terms visible: led lights.']
  const advanced = policy.evaluate(state, new Map([[0, { id: 'tool1', name: 'browser_type', arguments: '{"index":1,"text":"led lights"}' }]]), '', false, 20)
  assert.equal(state.currentStepIdx, 1, 'browser completion evidence should advance exactly one step')
  assert.ok(advanced.some(action => action.type === 'step_advance'), 'verified browser completion should emit step advance')

  const noToolState = createInitialState(false, timeouts)
  noToolState.taskStrategy = 'browse'
  noToolState.currentPlanItems = [
    'Navigate to ABLIS and initiate the business registration search',
    'Select cafe and set NSW location',
    'Review licence results',
  ]
  noToolState.currentPlanScopes = [
    'Open the ABLIS search flow until the Business type form is ready for the cafe activity input.',
    'Use the live form fields to choose cafe and NSW.',
    'Summarize required licences and regulations.',
  ]
  noToolState.currentStepIdx = 0
  noToolState.stepToolCallCount = 3
  noToolState.consecutiveNoToolCalls = 2
  noToolState.browserTaskCompleted = true
  noToolState.browserTaskCompletionEvidence = ['Current URL host is ablis.business.gov.au.', 'Step 1 of 5 Business type form is visible.']
  const noToolAdvanced = policy.evaluate(noToolState, new Map(), '', false, 20)
  assert.equal(noToolState.currentStepIdx, 1, 'browser completion evidence must advance before no-tool browser blocking')
  assert.ok(noToolAdvanced.some(action => action.type === 'step_advance'), 'no-tool browser completion should emit step advance')

  const actionableNoToolState = createInitialState(false, timeouts)
  actionableNoToolState.taskStrategy = 'browse'
  actionableNoToolState.currentPlanItems = [
    'Navigate to Woolworths and search for pancake ingredients',
    'Select and add flour, milk, and eggs to the cart',
    'Review cart',
  ]
  actionableNoToolState.currentPlanScopes = [
    'Open Woolworths and reach product search.',
    'Use visible product controls to add each required ingredient.',
    'Confirm cart contents.',
  ]
  actionableNoToolState.currentStepIdx = 1
  actionableNoToolState.stepToolCallCount = 2
  actionableNoToolState.consecutiveNoToolCalls = 4
  const recovered = policy.evaluate(actionableNoToolState, new Map(), '', false, 20)
  assert.equal(actionableNoToolState.currentStepIdx, 1, 'actionable browser no-tool recovery must not advance or block the active step')
  assert.equal(actionableNoToolState.browserNoToolRecoveryAttempts, 1, 'browser no-tool recovery attempts should be counted')
  assert.ok(recovered.some(action => action.type === 'inject_message'), 'actionable browser no-tool recovery should inject concrete browser guidance')
  assert.ok(!recovered.some(action => action.type === 'terminate'), 'first browser no-tool recovery must not terminate while page remains actionable')

  actionableNoToolState.browserNoToolRecoveryAttempts = 3
  actionableNoToolState.consecutiveNoToolCalls = 5
  const exhausted = policy.evaluate(actionableNoToolState, new Map(), '', false, 20)
  assert.ok(exhausted.some(action => action.type === 'terminate' && action.reason === 'browser_no_tool_recovery_exhausted'), 'repeated ignored browser recovery must stop instead of burning unlimited model turns')
}

export async function runSmoke() {
  assertPureCompletionFixtures()
  assertBrowserStepPolicyFixtures()
  assert.deepEqual(normalizeBrowserScrollArgs({}), { direction: 'down', amount: undefined })
  assert.deepEqual(normalizeBrowserScrollArgs({ amount: -700 }), { direction: 'up', amount: 700 })
  assert.deepEqual(normalizeBrowserScrollArgs({ dir: 'up', pixels: 300 }), { direction: 'up', amount: 300 })
  assert.deepEqual(normalizeBrowserScrollArgs({ scrollDirection: 'page_down' }), { direction: 'down', amount: undefined })

  const conversationId = \`browser-completion-smoke-\${Date.now()}\`
  const emitter = makeEmitter()
  const state = createInitialState(false, timeouts)
  state.taskStrategy = 'browse'
  state.originalUserRequest = 'Add the smoke test product to bag'
  state.currentPlanItems = ['Add the smoke test product to bag', 'Report result']
  state.currentPlanScopes = ['Use the live add-to-bag control', 'Summarize']

  const pipeline = new ToolPipeline(emitter as any, conversationId)

  try {
    const launch = await writePage(conversationId, 'index.html', \`
      <button id="add" type="button" onclick="document.querySelector('main').innerHTML = '<h1>Smoke test product added to Bag</h1><p>Bag subtotal $42</p><button type=&quot;button&quot;>Checkout</button>'">Add smoke test product to Bag</button>
    \`)

    const nav = await call(pipeline, state, 'nav1', 'browser_navigate', { url: launch.url })
    assert.equal(nav.isError, false, 'navigation failed: ' + JSON.stringify(nav.result))
    const snapshot = await browserActionPreflight(conversationId)
    const add = snapshot.elements.find(element => /add.*bag/i.test(element.label || element.primary))
    assert.ok(add, 'expected add-to-bag button, saw ' + JSON.stringify(snapshot.elements))

    const addResult = await call(pipeline, state, 'add1', 'browser_click_at', { index: add.index })
    assert.equal(addResult.isError, false, 'add click failed: ' + JSON.stringify(addResult.result))
    assert.equal((addResult.result as any).taskCompletion?.completed, true)
    assert.equal(state.browserTaskCompleted, true)
    assert.match(String((addResult.result as any).content), /TASK COMPLETION DETECTED/)

    state.currentPlanItems = ['Fill and submit the sign-up form', 'Report result']
    state.currentPlanScopes = ['Use the live form controls and correct visible validation errors.', 'Summarize']
    state.currentStepIdx = 0
    state.browserTaskCompleted = false
    state.forceTextNextIteration = false
    state.visibleToolActionsSinceLastNarration = 0
    const signup = await writePage(conversationId, 'signup.html', \`
      <form id="signup" onsubmit="event.preventDefault(); const username = document.querySelector('#username').value; const error = document.querySelector('#username-error'); if (username.length < 3 || username.length > 20) { error.textContent = 'Username can be 3 to 20 characters long.'; return; } document.querySelector('main').innerHTML = '<h1>Account created successfully</h1><p>Registration complete.</p>';">
        <label>Username <input id="username" name="username" aria-describedby="username-error" /></label>
        <div id="username-error" role="alert" style="color: rgb(220, 38, 38); font-size: 12px;"></div>
        <label>Password <input id="password" name="password" type="password" /></label>
        <button type="submit">Sign Up</button>
      </form>
    \`)
    const signupNav = await call(pipeline, state, 'nav2', 'browser_navigate', { url: signup.url })
    assert.equal(signupNav.isError, false, 'signup navigation failed: ' + JSON.stringify(signupNav.result))
    const badForm = await call(pipeline, state, 'form1', 'browser_fill_form', {
      fields: [
        { label: 'Username', value: 'AgentBot2026_Test_Unique' },
        { label: 'Password', value: 'SecurePass123!' },
      ],
      submitLabel: 'Sign Up',
    })
    assert.equal(badForm.isError, true, 'invalid form submission must be returned as a tool error')
    assert.match(String((badForm.result as any).error), /Visible form validation/i)
    assert.match(String((badForm.result as any).content), /VISIBLE VALIDATION ERRORS/)
    assert.match(String((badForm.result as any).content), /Username can be 3 to 20 characters long/)
    assert.equal((badForm.result as any).taskCompletion?.completed, false)
  } finally {
    await destroyBrowserSession(conversationId)
    await stopLocalWebsiteServer(conversationId)
    await rm(getSandboxDirPath(conversationId), { recursive: true, force: true })
  }
}
`, 'utf-8')

  await build({
    entryPoints: [runnerPath],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    external: ['@sparticuz/chromium', 'playwright'],
    logLevel: 'silent',
  })

  const { runSmoke } = await import(pathToFileURL(bundlePath).href)
  await runSmoke()
  console.log('browser completion smoke checks passed')
} finally {
  await rm(workDir, { recursive: true, force: true })
}
