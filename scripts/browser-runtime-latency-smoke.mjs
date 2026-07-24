import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const browser = await readFile(
  new URL('../src/lib/browser.ts', import.meta.url),
  'utf8',
)
const dispatcher = await readFile(
  new URL('../src/stream/client/eventDispatcher.ts', import.meta.url),
  'utf8',
)
const ssrf = await readFile(
  new URL('../src/lib/ssrf.ts', import.meta.url),
  'utf8',
)
const e2bTemplateSmoke = await readFile(
  new URL('./e2b-template-smoke.mjs', import.meta.url),
  'utf8',
)

const routeStart = browser.indexOf("await context.route('**/*'")
const routeEnd = browser.indexOf('// Patch webdriver', routeStart)
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'browser request interception block must exist')
const requestRoute = browser.slice(routeStart, routeEnd)
assert.doesNotMatch(
  requestRoute,
  /validateBrowserNavigationUrl/,
  'subresources must not pay a duplicate DNS preflight before guardedFetch',
)
assert.match(
  requestRoute,
  /const response = await guardedFetch\(parsed,/,
  'external subresources must still use the SSRF-guarded fetch path',
)
assert.match(
  ssrf,
  /PUBLIC_HOST_PREFLIGHT_TTL_MS[\s\S]*publicHostPreflightCache/,
  'repeated public-host preflights should reuse a short-lived validation result',
)
assert.match(
  ssrf,
  /lookup:\s*checkedLookup/,
  'every real connection must retain its private-IP checked lookup even when the public-host preflight is cached',
)

const actionSettle = browser.slice(
  browser.indexOf('async function settlePageAfterBrowserAction'),
  browser.indexOf('async function getVisiblePageText'),
)
assert.doesNotMatch(
  actionSettle,
  /waitForLoadState\('networkidle'/,
  'bounded DOM stability must not be followed by an unfulfillable sub-500ms networkidle wait',
)

assert.match(
  browser,
  /if \(session\.frameListeners\.size > 0\) startScreencast\(session\)/,
  'new sessions must only start frame capture for a live subscriber',
)
assert.match(
  browser,
  /function stopScreencast[\s\S]*session\.latestFrame = null[\s\S]*session\.screencastControl = session\.screencastControl[\s\S]*Page\.stopScreencast/,
  'stopping a frame stream must serialize CDP capture shutdown and clear stale server frames',
)
assert.match(
  browser,
  /session\.frameListeners\.delete\(listener\)[\s\S]*session\.frameListeners\.size === 0\) stopScreencast\(session\)/,
  'the last unsubscribe must stop browser frame capture',
)
assert.match(
  browser,
  /session\.screencastGeneration !== generation[\s\S]*session\.frameListeners\.size === 0/,
  'polling capture must fence old loops and stop when listeners disappear',
)
assert.match(
  browser,
  /session\.remoteProvider !== 'e2b'[\s\S]*scheduleE2BScreencastRetry[\s\S]*E2B intentionally never[\s\S]*page\.screenshot polling/,
  'E2B live viewing must retry its CDP push stream instead of polling screenshots',
)
assert.match(
  browser,
  /Page\.screencastFrame[\s\S]*Page\.screencastFrameAck[\s\S]*Page\.startScreencast/,
  'the live E2B viewport must use acknowledged push-based CDP screencast frames',
)
assert.match(
  e2bTemplateSmoke,
  /subscribeToBrowserFrames[\s\S]*browserNavigate[\s\S]*browserResize[\s\S]*liveFrameCount < 3[\s\S]*liveFrameFingerprints\.size < 2/,
  'the E2B runtime smoke must prove several distinct pushed frames through the real browser subscriber',
)
assert.doesNotMatch(
  e2bTemplateSmoke,
  /browserPage\.screenshot/,
  'the E2B live-view smoke must not validate snapshot polling',
)

assert.match(
  dispatcher,
  /settleHiddenComputerPanelItem[\s\S]*error: undefined[\s\S]*liveFrame: undefined/,
  'hidden browser results must preserve pixels without stale error/live state',
)
assert.match(
  dispatcher,
  /settleLiveBrowserPanel[\s\S]*liveFrame: undefined[\s\S]*streaming: false/,
  'terminal task states must preserve the final browser pixels while clearing live status',
)
assert.match(
  dispatcher,
  /function latestBrowserPanelItem\(conversationId: string\)[\s\S]*messages \|\| \[\]\)[\s\S]*\.reverse\(\)[\s\S]*message\.role === 'assistant'[\s\S]*item\.id === 'browser_live'/,
  'browser panel state must be recoverable from a previous assistant message',
)
const latestBrowserPanelLookupUses =
  dispatcher.match(/latestBrowserPanelItem\(this\.conversationId\)/g)?.length || 0
assert.ok(
  latestBrowserPanelLookupUses >= 4,
  'browser frame, hidden-result, tool-start, and tool-result paths must share the cross-message browser lookup',
)
const browserToolStart = dispatcher.slice(
  dispatcher.indexOf('if (BROWSER_TOOLS.includes(event.name))'),
  dispatcher.indexOf('private handleToolResult', dispatcher.indexOf('if (BROWSER_TOOLS.includes(event.name))')),
)
assert.match(
  browserToolStart,
  /const previousBrowserItem = latestBrowserPanelItem\(this\.conversationId\)[\s\S]*screenshotBase64: prev\?\.screenshotBase64/,
  'a browser tool starting in a new assistant message must keep the prior message frame mounted',
)
const hiddenResultStart = dispatcher.indexOf('if (isSupersededToolResult')
const hiddenResultEnd = dispatcher.indexOf('this.chargeToolEvent', hiddenResultStart)
assert.ok(hiddenResultStart >= 0 && hiddenResultEnd > hiddenResultStart, 'hidden result handling block must exist')
const hiddenResultSection = dispatcher.slice(hiddenResultStart, hiddenResultEnd)
assert.doesNotMatch(
  hiddenResultSection,
  /removeComputerPanelItem/,
  'superseded/internal browser results must not remove the live browser panel',
)
assert.match(
  hiddenResultSection,
  /settleHiddenComputerPanelItem\(event\)/,
  'hidden result paths must settle the browser panel in place',
)

console.log('browser runtime latency smoke: PASS')
