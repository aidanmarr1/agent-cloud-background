import { chromium as playwrightChromium, Browser, BrowserContext, Page, CDPSession, type Download, type Locator } from 'playwright'
import serverlessChromium from '@sparticuz/chromium'
import { mkdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { getOrCreateSandboxDir, isCloudSandboxProviderEnabled, resolveAndVerify, writeSandboxFileBytes } from './sandbox'
import { ensureE2BRemoteBrowserDebuggerUrl } from './e2bSandbox'
import { checkHost, guardedFetch, validateHttpUrl } from './ssrf'
import { isManagedWebsiteServerUrl } from './localWebsiteServer'
import { isManagedWebsitePreviewUrl } from './tsxWebsitePreview'
import {
  computeBrowserPageSignature,
  type BrowserProgressOutcome,
  type BrowserTaskCompletionSignal,
  type BrowserTargetHint,
} from './browserIntelligence'
import type { ScreenshotQuality } from './visualQuality'

export interface BrowserActionResult {
  success: boolean
  url: string
  title: string
  recoverable?: boolean
  screenshotPath?: string
  screenshotUrl?: string
  screenshotBase64?: string
  content?: string
  error?: string
  visualQuality?: ScreenshotQuality
  browserProgress?: BrowserProgressOutcome
  targetHints?: BrowserTargetHint[]
  taskCompletion?: BrowserTaskCompletionSignal
  action: string
}

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  page: Page
  cdp: CDPSession | null
  remoteProvider?: 'e2b'
  lastUsed: number
  conversationId: string
  screencastActive: boolean
  frameListeners: Set<(base64: string) => void>
  latestFrame: string | null
  // Per-action page diff tracking — lets the agent see what changed and what's new
  lastElementSelectors: Set<string> | null
  lastElementFingerprints: Set<string> | null
  lastClickedSelector: string | null
  lastInteractiveElementsText: string | null
  // Manus-style indexed elements: agent calls browser_click({index: N}) instead
  // of copying @(x,y) coordinates. Populated by getInteractiveElements, consumed
  // by all click/type/hover handlers. Cleared at the start of every action so
  // stale indices can never refer to a previous page's elements.
  lastElementIndex: Map<number, IndexedElement> | null
  // URLs that have already returned an error (404, blocked, redirected to error page)
  // in this session. Used to short-circuit repeat navigations to known-broken URLs
  // so the agent stops looping back to the same dead page. Keys are normalized URLs.
  failedNavigations: Map<string, string>
  pageBlocker: string | null
  downloads: BrowserDownloadInfo[]
}

const SAFE_SANDBOX_CONVERSATION_ID = /^[a-zA-Z0-9_-]+$/
const DEBUG_BROWSER_STREAM = process.env.AGENT_DEBUG_BROWSER_STREAM === 'true'

function debugBrowserStream(...args: unknown[]): void {
  if (DEBUG_BROWSER_STREAM) console.log(...args)
}

function isSandboxPreviewUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!localHost) return false
  const match = url.pathname.match(/^\/api\/sandbox\/([^/]+)\/.+/)
  return !!match && SAFE_SANDBOX_CONVERSATION_ID.test(match[1])
}

export interface IndexedElement {
  x: number
  y: number
  primary: string
  tag: string
  label: string
  groupLabel?: string
  visualLabel?: string
  options?: string[]
  /** Semantic role token (text-input/textarea/radio/checkbox/button/link/...).
   * Used by browser_type to hard-reject typing into non-text elements like
   * radios and buttons — preventing the "Typing 'reassuring' into a radio button" failure mode. */
  role: string
  state?: {
    selected?: boolean
    checked?: boolean
    pressed?: boolean
    current?: boolean
    disabled?: boolean
    unavailable?: boolean
  }
  /** Clamped-to-viewport bounding box for set-of-marks overlay rendering. */
  rect: { left: number; top: number; width: number; height: number }
}

export interface BrowserDownloadInfo {
  path: string
  suggestedFilename: string
  url: string
  createdAt: number
  error?: string
}

export interface BrowserFormFillField {
  label?: string
  value?: string | number | boolean
  index?: number
}

export interface BrowserActionPreflightElement {
  index: number
  role: string
  label: string
  primary: string
  groupLabel?: string
  visualLabel?: string
  options?: string[]
  disabled?: boolean
  unavailable?: boolean
  selected?: boolean
  checked?: boolean
}

export interface BrowserFocusedElement {
  index?: number
  role: string
  label: string
  primary?: string
  tag: string
  typeable: boolean
  disabled?: boolean
  readOnly?: boolean
  value?: string
}

export interface BrowserActionPreflightSnapshot {
  hasSession: boolean
  url: string
  title: string
  pageBlocker?: string | null
  indexedCount: number
  maxIndex: number
  elements: BrowserActionPreflightElement[]
  focusedElement?: BrowserFocusedElement | null
  visibleValidationErrors?: string[]
  content?: string
  screenshotPath?: string
  screenshotUrl?: string
  screenshotBase64?: string
}

/** Resolve a Manus-style {index: N} to its IndexedElement entry on the session.
 * Returns null when the index is missing OR when the session has no current
 * index map (e.g. agent called a click before any navigate). The caller turns
 * null into a structured error so the LLM knows to re-read the elements list. */
function resolveIndexedElement(session: BrowserSession, index: number): IndexedElement | null {
  if (!session.lastElementIndex) return null
  return session.lastElementIndex.get(index) || null
}

async function refreshInteractiveElementsWithSettling(session: BrowserSession): Promise<string> {
  let interactiveElements = await getInteractiveElements(session)
  if ((session.lastElementIndex && session.lastElementIndex.size > 0) || session.page.url() === 'about:blank') {
    return interactiveElements
  }

  // JS-heavy pages commonly attach controls just after domcontentloaded. Treat
  // "no indexed controls" as a transient state for a short window, then return
  // the fresh no-controls snapshot instead of letting callers act on stale data.
  for (const delay of [120, 240, 480]) {
    await session.page.waitForTimeout(delay).catch(() => {})
    await session.page.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {})
    await autoDismissPopups(session.page).catch(() => [])
    interactiveElements = await getInteractiveElements(session)
    if (session.lastElementIndex && session.lastElementIndex.size > 0) break
  }

  return interactiveElements
}

const POST_BROWSER_ACTION_SETTLE_MS = 500
const POST_BROWSER_SCROLL_SETTLE_MS = 240
const POST_BROWSER_NAVIGATION_SETTLE_MIN_MS = 300
const POST_BROWSER_NAVIGATION_SETTLE_MAX_MS = 1000

const BASE_CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--window-size=1280,720',
  '--disable-features=AutomationControlled',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--enable-features=NetworkService,NetworkServiceInProcess',
]

function isServerlessChromiumRuntime(): boolean {
  return process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME
}

async function getChromiumLaunchOptions(): Promise<Parameters<typeof playwrightChromium.launch>[0]> {
  if (!isServerlessChromiumRuntime()) {
    return {
      headless: true,
      args: BASE_CHROMIUM_ARGS,
    }
  }

  serverlessChromium.setGraphicsMode = false
  return {
    headless: true,
    executablePath: await serverlessChromium.executablePath(),
    args: [...serverlessChromium.args, ...BASE_CHROMIUM_ARGS],
  }
}

async function waitForDomStability(
  page: Page,
  opts: { minMs: number; maxMs: number; pollMs?: number; stablePolls?: number },
): Promise<void> {
  const pollMs = opts.pollMs ?? 150
  const stablePolls = opts.stablePolls ?? 2
  const start = Date.now()
  let lastSignature = ''
  let stableCount = 0

  while (Date.now() - start < opts.maxMs) {
    const signature = await page.evaluate(() => {
      const body = document.body
      const doc = document.documentElement
      const interactiveCount = document.querySelectorAll(
        'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="textbox"],[onclick],[tabindex]:not([tabindex="-1"])',
      ).length
      return [
        document.readyState,
        body?.childElementCount || 0,
        body?.innerText?.length || 0,
        interactiveCount,
        doc?.scrollHeight || 0,
      ].join('|')
    }).catch(() => '')

    if (signature && signature === lastSignature) {
      stableCount++
    } else {
      stableCount = 0
      lastSignature = signature
    }

    if (Date.now() - start >= opts.minMs && stableCount >= stablePolls) return
    const remaining = opts.maxMs - (Date.now() - start)
    if (remaining <= 0) return
    await page.waitForTimeout(Math.min(pollMs, remaining)).catch(() => {})
  }
}

function navigationSettleWindow(rawUrl: string): { minMs: number; maxMs: number } {
  try {
    const parsed = new URL(rawUrl)
    if (isManagedWebsiteServerUrl(parsed) || isManagedWebsitePreviewUrl(parsed) || isSandboxPreviewUrl(parsed)) {
      return { minMs: 250, maxMs: 900 }
    }
  } catch {
    // Fall through to the external-page defaults.
  }
  return {
    minMs: POST_BROWSER_NAVIGATION_SETTLE_MIN_MS,
    maxMs: POST_BROWSER_NAVIGATION_SETTLE_MAX_MS,
  }
}

async function settlePageAfterBrowserAction(
  session: BrowserSession,
  delayMs: number = POST_BROWSER_ACTION_SETTLE_MS,
): Promise<void> {
  await session.page.waitForLoadState('domcontentloaded', { timeout: 800 }).catch(() => {})
  await waitForDomStability(session.page, {
    minMs: Math.min(180, delayMs),
    maxMs: delayMs,
    stablePolls: 2,
  }).catch(() => {})
  await session.page.waitForLoadState('networkidle', { timeout: 220 }).catch(() => {})
  await autoDismissPopups(session.page).catch(() => [])
}

async function settlePageAfterNavigation(session: BrowserSession, url: string): Promise<void> {
  const window = navigationSettleWindow(url)
  await session.page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {})
  await waitForDomStability(session.page, {
    minMs: window.minMs,
    maxMs: window.maxMs,
    pollMs: 175,
    stablePolls: 2,
  }).catch(() => {})
  await session.page.waitForLoadState('networkidle', { timeout: 280 }).catch(() => {})
}

async function getVisiblePageText(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800)
}

const BROWSER_TYPEABLE_ROLES = new Set([
  'text-input', 'textarea', 'search-input', 'email-input', 'password-input',
  'tel-input', 'url-input', 'number-input', 'date-input', 'time-input',
  'datetime-local-input', 'month-input', 'week-input', 'contenteditable',
  'textbox', 'searchbox', 'combobox', 'textbox-input', 'searchbox-input',
  'combobox-input',
])

function isBrowserTypeableRole(role: string | undefined): boolean {
  return !!role && BROWSER_TYPEABLE_ROLES.has(role)
}

async function getFocusedElementSnapshot(
  page: Page,
  entries: Array<[number, IndexedElement]> = [],
): Promise<BrowserFocusedElement | null> {
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null

    const htmlEl = el as HTMLElement
    const tag = el.tagName.toLowerCase()
    const roleAttr = (el.getAttribute('role') || '').toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const contentEditableAttr = el.getAttribute('contenteditable')
    const isEditable = htmlEl.isContentEditable ||
      contentEditableAttr === '' ||
      contentEditableAttr?.toLowerCase() === 'true' ||
      contentEditableAttr?.toLowerCase() === 'plaintext-only'

    const role = (() => {
      if (tag === 'textarea') return 'textarea'
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'file') return 'file-upload'
        if (['submit', 'button', 'reset'].includes(type)) return 'button'
        if (['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week', ''].includes(type)) return 'text-input'
        return type ? `${type}-input` : 'text-input'
      }
      if (isEditable) return 'contenteditable'
      if (roleAttr === 'textbox' || roleAttr === 'searchbox') return 'text-input'
      if (roleAttr === 'combobox') return 'combobox-input'
      return roleAttr || tag
    })()

    const labelFromIds = (ids: string | null): string => {
      if (!ids) return ''
      const parts: string[] = []
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(id)
        const text = target?.textContent?.replace(/\s+/g, ' ').trim()
        if (text) parts.push(text)
      }
      return parts.join(' ').trim()
    }

    const label = (
      el.getAttribute('aria-label') ||
      labelFromIds(el.getAttribute('aria-labelledby')) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.getAttribute('title') ||
      el.textContent ||
      ''
    ).replace(/\s+/g, ' ').trim().slice(0, 120)

    const escapeAttr = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const selectors: string[] = []
    const id = el.getAttribute('id')
    const ariaLabel = el.getAttribute('aria-label')
    const name = el.getAttribute('name')
    const placeholder = el.getAttribute('placeholder')
    const title = el.getAttribute('title')
    if (id) selectors.push(`#${CSS.escape(id)}`)
    if (ariaLabel) selectors.push(`[aria-label="${escapeAttr(ariaLabel)}"]`)
    if (name) selectors.push(`${tag}[name="${escapeAttr(name)}"]`)
    if (placeholder) selectors.push(`${tag}[placeholder="${escapeAttr(placeholder)}"]`)
    if (title) selectors.push(`[title="${escapeAttr(title)}"]`)
    if (roleAttr) selectors.push(`[role="${escapeAttr(roleAttr)}"]`)

    const rect = el.getBoundingClientRect()
    const disabled = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).disabled === true ||
      el.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true'
    const readOnly = (el as HTMLInputElement | HTMLTextAreaElement).readOnly === true ||
      el.getAttribute('aria-readonly') === 'true'
    const typeable = ['text-input', 'textarea', 'contenteditable', 'combobox-input'].includes(role) && !disabled && !readOnly
    const value = ((el as HTMLInputElement | HTMLTextAreaElement).value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)

    return {
      role,
      label,
      primary: selectors[0] || undefined,
      tag,
      typeable,
      disabled,
      readOnly,
      value,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    }
  }).catch(() => null)

  if (!focused) return null

  let index: number | undefined
  if (focused.primary) {
    const match = entries.find(([, element]) => element.primary === focused.primary)
    if (match) index = match[0]
  }

  if (index === undefined && focused.rect.width > 0 && focused.rect.height > 0) {
    const centerX = focused.rect.left + focused.rect.width / 2
    const centerY = focused.rect.top + focused.rect.height / 2
    let best: { index: number; distance: number } | null = null
    for (const [candidateIndex, element] of entries) {
      const rect = element.rect
      if (!rect || rect.width <= 0 || rect.height <= 0) continue
      const elementCenterX = rect.left + rect.width / 2
      const elementCenterY = rect.top + rect.height / 2
      const distance = Math.hypot(centerX - elementCenterX, centerY - elementCenterY)
      if (distance <= Math.max(24, Math.min(rect.width, rect.height) + 12) && (!best || distance < best.distance)) {
        best = { index: candidateIndex, distance }
      }
    }
    if (best) index = best.index
  }

  return {
    index,
    role: focused.role,
    label: focused.label,
    primary: focused.primary,
    tag: focused.tag,
    typeable: focused.typeable,
    disabled: focused.disabled,
    readOnly: focused.readOnly,
    value: focused.value,
  }
}

function combinePageTextAndInteractive(pageText: string, interactiveElements: string): string {
  const parts: string[] = []
  if (pageText) parts.push(`Page text: ${pageText}`)
  if (interactiveElements) parts.push(interactiveElements)
  return parts.join('\n\n')
}

const MAX_VISIBLE_VALIDATION_ERRORS = 6

async function getVisibleValidationErrors(page: Page): Promise<string[]> {
  return page.evaluate((maxErrors) => {
    const messages: string[] = []
    const seen = new Set<string>()

    function cleanText(value: string | null | undefined): string {
      return (value || '').replace(/\s+/g, ' ').trim()
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
    }

    function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
      const match = value.match(/rgba?\(([^)]+)\)/i)
      if (!match) return null
      const parts = match[1].split(',').map(part => part.trim())
      if (parts.length < 3) return null
      const read = (part: string) => part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part)
      const r = Math.round(read(parts[0]))
      const g = Math.round(read(parts[1]))
      const b = Math.round(read(parts[2]))
      const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3])
      if (![r, g, b, a].every(Number.isFinite)) return null
      return { r, g, b, a }
    }

    function isErrorColored(el: Element): boolean {
      const color = parseRgb(window.getComputedStyle(el).color)
      if (!color || color.a < 0.35) return false
      return color.r >= 140 && color.r - Math.max(color.g, color.b) >= 35 && color.g <= 145 && color.b <= 145
    }

    function looksLikeValidationText(text: string): boolean {
      return /\b(required|invalid|error|failed|missing|must|cannot|can't|can be|characters?|too short|too long|too weak|please (?:enter|select|choose|create)|not allowed|already taken|unavailable|set first|verify|captcha|try again)\b/i.test(text)
    }

    function compactMessage(text: string): string {
      return text.replace(/\s+([,.!?;:])/g, '$1').slice(0, 180)
    }

    function addMessage(text: string, label?: string): void {
      let cleaned = compactMessage(cleanText(text))
      if (cleaned.length < 3 || cleaned.length > 220) return
      if (!looksLikeValidationText(cleaned)) return
      const cleanLabel = compactMessage(cleanText(label))
      if (cleanLabel && cleanLabel.length <= 60 && !cleaned.toLowerCase().includes(cleanLabel.toLowerCase())) {
        cleaned = `${cleanLabel}: ${cleaned}`
      }
      const key = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (!key || seen.has(key)) return
      seen.add(key)
      messages.push(cleaned)
    }

    function textFromIds(ids: string | null): string {
      if (!ids) return ''
      return ids.split(/\s+/)
        .map(id => cleanText(document.getElementById(id)?.textContent || ''))
        .filter(Boolean)
        .join(' ')
    }

    function fieldLabel(el: Element): string {
      const html = el as HTMLElement
      const id = html.id
      const explicit = id ? cleanText(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent || '') : ''
      const wrapping = cleanText(el.closest('label')?.textContent || '')
      return cleanText(
        el.getAttribute('aria-label') ||
        textFromIds(el.getAttribute('aria-labelledby')) ||
        explicit ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        wrapping ||
        el.getAttribute('id') ||
        '',
      ).slice(0, 80)
    }

    function nearbyValidationText(el: Element): string[] {
      const candidates: Element[] = []
      for (const attr of ['aria-errormessage', 'aria-describedby']) {
        const ids = el.getAttribute(attr)
        if (ids) {
          for (const id of ids.split(/\s+/).filter(Boolean)) {
            const described = document.getElementById(id)
            if (described) candidates.push(described)
          }
        }
      }
      let next = el.nextElementSibling
      for (let i = 0; next && i < 3; i++) {
        candidates.push(next)
        next = next.nextElementSibling
      }
      const parent = el.parentElement
      if (parent) {
        candidates.push(...Array.from(parent.querySelectorAll('[role="alert"], [aria-live], .error, .invalid, .validation, .field-error, [class*="error"], [class*="invalid"]')).slice(0, 8))
      }
      return candidates
        .filter(candidate => isVisible(candidate))
        .map(candidate => cleanText(candidate.textContent || ''))
        .filter(Boolean)
    }

    const controls = Array.from(document.querySelectorAll('input, select, textarea, [contenteditable], [aria-invalid="true"]'))
    for (const el of controls) {
      if (messages.length >= maxErrors) break
      const label = fieldLabel(el)
      const invalid = el.getAttribute('aria-invalid') === 'true' ||
        (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
          ? !el.validity.valid
          : false)
      if (!invalid) continue
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        addMessage(el.validationMessage, label)
      }
      for (const text of nearbyValidationText(el)) addMessage(text, label)
    }

    const explicitSelectors = [
      '[role="alert"]',
      '[aria-live]:not([aria-live="off"])',
      '[aria-errormessage]',
      '.error',
      '.errors',
      '.invalid',
      '.validation',
      '.validation-error',
      '.field-error',
      '.form-error',
      '[class*="error"]',
      '[class*="invalid"]',
      '[class*="danger"]',
      '[id*="error"]',
      '[id*="invalid"]',
    ].join(',')
    for (const el of Array.from(document.querySelectorAll(explicitSelectors))) {
      if (messages.length >= maxErrors) break
      if (!isVisible(el)) continue
      addMessage(cleanText(el.textContent || ''))
    }

    for (const el of Array.from(document.body?.querySelectorAll('*') || [])) {
      if (messages.length >= maxErrors) break
      if (!isVisible(el) || !isErrorColored(el)) continue
      const text = cleanText(el.textContent || '')
      if (text.length < 3 || text.length > 180) continue
      const childText = Array.from(el.children).map(child => cleanText(child.textContent || '')).filter(Boolean).join(' ')
      if (childText && childText.length > 0 && text.length > childText.length + 12) continue
      addMessage(text)
    }

    return messages.slice(0, maxErrors)
  }, MAX_VISIBLE_VALIDATION_ERRORS).catch(() => [])
}

function visibleValidationNote(errors: string[]): string {
  if (errors.length === 0) return ''
  return [
    'VISIBLE VALIDATION ERRORS:',
    ...errors.slice(0, MAX_VISIBLE_VALIDATION_ERRORS).map(error => `- ${error}`),
    'Correct the named field(s) before clicking submit, advancing the plan, or reporting success.',
  ].join('\n')
}

function prependVisibleValidationErrors(content: string | undefined, errors: string[]): string | undefined {
  const note = visibleValidationNote(errors)
  if (note && /\bVISIBLE VALIDATION ERRORS\b/i.test(content || '')) return content
  const joined = [note, content || ''].filter(Boolean).join('\n\n').trim()
  return joined || undefined
}

function visibleValidationBlockError(errors: string[]): string {
  const first = errors[0] ? ` First visible error: ${errors[0]}` : ''
  return `BLOCKED: Visible form validation error(s) remain.${first} Read the VISIBLE VALIDATION ERRORS block and correct only those field(s) before continuing.`
}

function validationMentionsLabel(errors: string[], label: string): boolean {
  const labelTokens = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !['input', 'field', 'text', 'type', 'button', 'edit', 'form', 'select'].includes(token))
  if (labelTokens.length === 0) return false
  const haystack = errors.join('\n').toLowerCase()
  return labelTokens.some(token => haystack.includes(token))
}

function isValidationTriggerLabel(label: string): boolean {
  return /\b(submit|send|register|sign\s*up|signup|create account|continue|next|done|save|apply|book|reserve|checkout|pay|place order|log\s*in|login)\b/i.test(label)
}

async function detectHumanVerificationChallenge(page: Page, visibleText?: string): Promise<string | null> {
  let challengeElementSignal: 'none' | 'embedded' | 'blocking' = 'none'
  try {
    challengeElementSignal = await page.evaluate(() => {
      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect()
        if (rect.width < 8 || rect.height < 8) return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
      }

      const candidates = Array.from(document.querySelectorAll([
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        'iframe[title*="recaptcha" i]',
        'iframe[title*="captcha" i]',
        'iframe[title*="challenge" i]',
        '.g-recaptcha',
        '.h-captcha',
        '.cf-turnstile',
        '#challenge-form',
        'form[action*="captcha" i]',
      ].join(', '))).filter(isVisible)

      if (candidates.length === 0) return 'none'

      const hasBlockingWidget = candidates.some((el) => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        const area = rect.width * rect.height
        const fixedLike = style.position === 'fixed' || style.position === 'sticky'
        const centered = rect.left < window.innerWidth * 0.75 &&
          rect.right > window.innerWidth * 0.25 &&
          rect.top < window.innerHeight * 0.75 &&
          rect.bottom > window.innerHeight * 0.25
        return area >= 50_000 || (fixedLike && centered && area >= 8_000)
      })

      return hasBlockingWidget ? 'blocking' : 'embedded'
    })
  } catch {
    challengeElementSignal = 'none'
  }

  const text = (visibleText || await getVisiblePageText(page).catch(() => '')).toLowerCase()
  const hasNegatedChallengeText =
    /\b(?:not|isn['’]?t|is not|no)\s+(?:a\s+)?(?:captcha|human[- ]verification|verification|security)\s+challenge\b/i.test(text)
  const hasStrongChallengeText =
    /\b(checking your browser|verify you are human|verify that you are human|are you human|human verification|security check|attention required|complete the security check|complete the security challenge)\b/i.test(text) ||
    /\bselect all images with\b/i.test(text) ||
    /\bclick verify\b/i.test(text)
  const hasExplicitCaptchaChallengeText =
    !hasNegatedChallengeText && (
      /\b(?:captcha|recaptcha|hcaptcha|turnstile)\b.{0,90}\b(?:required|verify|verification|challenge|blocked|complete|solve|security)\b/i.test(text) ||
      /\b(?:required|verify|verification|challenge|blocked|complete|solve|security)\b.{0,90}\b(?:captcha|recaptcha|hcaptcha|turnstile)\b/i.test(text)
    )

  const challengeElementBlocksPage = challengeElementSignal === 'blocking'

  if (!challengeElementBlocksPage && !hasStrongChallengeText && !hasExplicitCaptchaChallengeText) return null
  return 'CAPTCHA / human-verification challenge'
}

async function resolveIndexedElementWithRefresh(session: BrowserSession, index: number): Promise<IndexedElement | null> {
  const existing = resolveIndexedElement(session, index)
  if (existing) return existing

  // Hot reloads, stream resumes, or first-use browser actions can leave the
  // page open while the in-memory [N] index map is empty. Rebuild it once from
  // the live page before returning a stale-index error so valid visible indices
  // don't waste an extra model turn.
  await refreshInteractiveElementsWithSettling(session).catch(() => '')
  return resolveIndexedElement(session, index)
}

function isSameIndexedElement(a: IndexedElement, b: IndexedElement): boolean {
  if (a.primary && b.primary && a.primary === b.primary) return true
  const aLabel = (a.label || '').trim().toLowerCase()
  const bLabel = (b.label || '').trim().toLowerCase()
  return !!aLabel && aLabel === bLabel && a.role === b.role
}

function findMatchingIndexedElement(session: BrowserSession, original: IndexedElement): IndexedElement | null {
  const map = session.lastElementIndex
  if (!map || map.size === 0) return null

  for (const candidate of map.values()) {
    if (candidate.primary && original.primary && candidate.primary === original.primary) {
      return candidate
    }
  }

  for (const candidate of map.values()) {
    if (isSameIndexedElement(candidate, original)) {
      return candidate
    }
  }

  return null
}

async function refreshIndexedClickPoint(
  session: BrowserSession,
  index: number,
  original: IndexedElement,
): Promise<IndexedElement | null> {
  await refreshInteractiveElementsWithSettling(session).catch(() => '')

  const sameIndex = resolveIndexedElement(session, index)
  if (sameIndex && isSameIndexedElement(sameIndex, original)) {
    return sameIndex
  }

  return findMatchingIndexedElement(session, original)
}

/** Build a context-rich error message for a stale or invalid index. Special-cases
 * index 0 (1-indexed reminder) and out-of-range indices (gives the max). */
function staleIndexMessage(index: number, session: BrowserSession): string {
  const map = session.lastElementIndex
  if (!map || map.size === 0) {
    const currentUrl = session.page.url()
    if (currentUrl && currentUrl !== 'about:blank') {
      return `Click blocked before execution: no live indexed controls are available after waiting for the page to settle. Do not click or guess coordinates. Use browser_screenshot to refresh the index, browser_scroll/browser_find_text to reveal the target, or browser_get_content to read the page.`
    }
    return `Click blocked before execution: no page controls have been indexed yet. Call browser_navigate first, then use the returned elements list before clicking.`
  }
  const maxIdx = Math.max(...map.keys())
  if (index === 0) {
    return `Indices start at [1], not [0]. The first interactive element is [1] and the last is [${maxIdx}]. Pick a valid [N] from the elements list below.`
  }
  if (index > maxIdx) {
    // Way-out-of-range (>2x max or >100): the model is almost certainly confusing
    // an on-page number (price, product ID, year, postcode, etc.) with an element
    // index. Give a much more specific warning so it doesn't repeat the mistake.
    if (index > 100 || index > maxIdx * 2) {
      return `Index [${index}] is WAY out of range — the highest valid index right now is [${maxIdx}]. Element indices are SMALL whole numbers from [1] to [${maxIdx}], shown next to each entry in the elements list. You are likely confusing a price ($${index / 100}), product ID, year, postcode, or other on-page number with an element index. Re-read the elements list below and pick a real [N] between 1 and ${maxIdx}.`
    }
    return `Index [${index}] is past the end of the list (max is [${maxIdx}]). Pick a valid [N] between 1 and ${maxIdx} from the elements list below.`
  }
  return `Index [${index}] is not in the current elements list — the page may have re-rendered. Pick a fresh [N] from the elements list below.`
}

/** Normalize a URL for the failed-navigation tracker. Strips trailing slashes,
 * fragments, and tracking query params so different URLs that point to the
 * same broken resource collapse into one entry. */
function normalizeNavUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    // Drop common tracking params so ?utm_source=foo doesn't bypass dedup
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'referrer']
    for (const k of drop) u.searchParams.delete(k)
    let s = u.toString()
    if (s.endsWith('/')) s = s.slice(0, -1)
    return s.toLowerCase()
  } catch {
    return url.toLowerCase().replace(/\/+$/, '')
  }
}

function normalizeBrowserInputUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return trimmed
}

async function validateBrowserNavigationUrl(rawUrl: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const parsed = validateHttpUrl(normalizeBrowserInputUrl(rawUrl))
    if (isSandboxPreviewUrl(parsed) || isManagedWebsiteServerUrl(parsed) || isManagedWebsitePreviewUrl(parsed)) {
      return { ok: true, url: parsed.toString() }
    }
    await checkHost(parsed.hostname)
    return { ok: true, url: parsed.toString() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function unsupportedBrowserFinalProtocol(rawUrl: string): string | null {
  try {
    const protocol = new URL(rawUrl).protocol
    return ['http:', 'https:'].includes(protocol) ? null : protocol.replace(/:$/, '') || 'unknown'
  } catch {
    return null
  }
}

function describeNetworkNavigationError(safeUrl: string, error: Error): { failureReason: string; userError: string; content: string } {
  const hostname = (() => {
    try { return new URL(safeUrl).hostname }
    catch { return safeUrl }
  })()
  const rawMessage = error.message.split('\n')[0] || 'network error'
  const isDnsMiss = /\bERR_NAME_NOT_RESOLVED\b|ENOTFOUND|getaddrinfo/i.test(rawMessage)
  const failureReason = isDnsMiss ? 'dns lookup failed' : 'network error'
  const userError = isDnsMiss
    ? `Navigation target does not resolve: ${hostname}. Verify the hostname or protocol, then try the requested site again from a fresh browser state.`
    : `Network error loading ${hostname}. The browser could not establish a page connection; keep the requested site as the target and retry from a fresh browser state if needed.`
  const content = `INTERNAL_RECOVERY: ${userError} The browser did not load a page-level blocker, so treat this as a recoverable navigation failure for ${safeUrl}.`
  return { failureReason, userError, content }
}

/** Detect whether a page (after navigation) is actually an error page —
 * 404, 500, soft-404, "page not found", or a known error-redirect URL pattern.
 * Returns a human-friendly reason if it's an error, or null if the page is fine.
 * Checks (in order): HTTP status code, URL path patterns, page title, h1 text. */
function detectErrorPage(opts: {
  status: number
  finalUrl: string
  title: string
  bodyText: string
}): string | null {
  // 1. Hard HTTP errors — these are unambiguous
  if (opts.status >= 400 && opts.status !== 401) {
    // 401 (unauthorized) is sometimes a real "log in to see this" page, not an error.
    // Everything else 4xx/5xx is broken.
    return `HTTP ${opts.status}`
  }
  // 2. URL patterns that scream "you got redirected to an error page"
  const urlPath = (() => { try { return new URL(opts.finalUrl).pathname.toLowerCase() } catch { return opts.finalUrl.toLowerCase() } })()
  if (urlPath === '/404' || urlPath === '/404/') {
    return `URL redirected to error page (${urlPath})`
  }
  const errorUrlPatterns = ['/resourcenotfound', '/not-found', '/notfound', '/page-not-found', '/error', '/page-error', '/oops', '/gone']
  for (const p of errorUrlPatterns) {
    if (urlPath === p || urlPath.endsWith(p)) {
      return `URL redirected to error page (${urlPath})`
    }
  }
  // 3. Title patterns
  const title = (opts.title || '').toLowerCase()
  const titlePatterns = [
    /^404\b/,
    /^error\s*404/,
    /\b(page|resource)\s+not\s+found\b/,
    /^not\s+found$/,
    /\bpage\s+can'?t\s+be\s+(reached|found)\b/,
    /^oops\b/,
    /\b500\s*(internal\s+)?(server\s+)?error\b/,
    /^503\b/,
    /\bservice\s+unavailable\b/,
  ]
  for (const re of titlePatterns) {
    if (re.test(title)) return `Page title is "${opts.title.slice(0, 60)}"`
  }
  // 4. Body text patterns — only if the body is short (real pages have lots of text)
  const body = opts.bodyText.replace(/\s+/g, ' ').trim().toLowerCase()
  const bodyHead = body.slice(0, 1000)
  const strongBodyStartPatterns = [
    /^(?:[\W_]{0,80})?(?:404|error\s*404|page not found|not found)\b/,
    /^(?:[\W_]{0,80})?sorry,?\s+(?:this|the)\s+page\s+(?:doesn'?t exist|isn'?t available|can'?t be found|is missing)\b/,
  ]
  for (const re of strongBodyStartPatterns) {
    if (re.test(bodyHead)) return `Page body starts with error message`
  }
  if (body.length < 600) {
    const bodyPatterns = [
      /\bthis page can'?t be reached\b/,
      /\bpage not found\b/,
      /\b404\s*(error|—|-)/,
      /\berror\s*404\b/,
      /\bwe can'?t find that page\b/,
      /\bthe page you (are looking for|requested) (cannot|can'?t|could not|couldn'?t) be (found|located)\b/,
      /\bsorry,?\s+(this|the)\s+page\s+(doesn'?t exist|isn'?t available|can'?t be found|is missing)\b/,
    ]
    for (const re of bodyPatterns) {
      if (re.test(body)) return `Page body contains error message`
    }
  }
  return null
}

function pageAppearsHealthyForActions(opts: {
  finalUrl: string
  title: string
  bodyText: string
  indexedCount: number
}): boolean {
  const body = opts.bodyText.replace(/\s+/g, ' ').trim()
  if (opts.indexedCount <= 0 || body.length < 80) return false
  if (detectErrorPage({ status: 0, finalUrl: opts.finalUrl, title: opts.title, bodyText: body })) return false
  return !/^(access denied|403 forbidden|blocked|you have been blocked|please verify you are|are you human|checking your browser|just a moment|attention required|cloudflare|security check)\b/i.test(body)
}

function searchPhraseFromUrl(url: string, title?: string): string {
  const fromTitle = (title || '')
    .replace(/\b(404|page not found|not found|error)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (fromTitle && fromTitle.length > 12) return fromTitle

  try {
    const u = new URL(url)
    const words = u.pathname
      .split(/[/?#/&._-]+/)
      .map(part => decodeURIComponent(part).replace(/[^a-z0-9 ]+/gi, ' ').trim())
      .filter(Boolean)
      .filter(part => !/^(www|html|htm|aspx|php|courses?|pages?|content|index)$/i.test(part))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return words || u.hostname.replace(/^www\./, '').replace(/[.-]+/g, ' ')
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/[/?#/&._-]+/g, ' ').trim()
  }
}

function navigationRecoveryHint(requestedUrl: string, finalUrl: string, title?: string): string {
  const phrase = searchPhraseFromUrl(requestedUrl, title || finalUrl)
  let host = ''
  try { host = new URL(requestedUrl).hostname.replace(/^www\./, '') } catch { /* ignore */ }
  const searchQueries = [
    host && phrase ? `site:${host} ${phrase}` : '',
    host && phrase ? `${host} ${phrase}` : '',
    phrase,
  ].filter(Boolean)

  const queryLines = searchQueries
    .slice(0, 3)
    .map(q => `- web_search({ query: "${q.replace(/"/g, '\\"')}" })`)
    .join('\n')

  let homepageLine = ''
  try {
    const u = new URL(finalUrl || requestedUrl)
    homepageLine = `\n- browser_navigate({ url: "${u.origin}" }) and use site search/navigation from there`
  } catch { /* ignore */ }

  return `Recovery options for this broken URL:\n${queryLines}${homepageLine}\nDo not retry the exact broken URL. Prefer same-site search first, then a broader web search if needed.`
}

function navigationRecoveryContent(reason: string, safeUrl: string, finalUrl: string, title: string, pageContent: string, interactiveElements: string): string {
  const recoveryHint = navigationRecoveryHint(safeUrl, finalUrl, title)
  return [
    `INTERNAL_RECOVERY: The requested URL opened a broken/error page (${reason}).`,
    'Treat this as a recoverable navigation miss, not as a browser failure.',
    'Do not click elements on this error page and do not retry the exact same URL.',
    'Next action must be one of: navigate to the site homepage and use site navigation/search, open a different unvisited result URL, or run a same-site/broader web search.',
    recoveryHint,
    '',
    pageContent + interactiveElements,
  ].join('\n').trim()
}

/** Build a stale-index failure response that ALSO includes a fresh frame
 * (screenshot + indexed elements list). This lets the agent recover in a
 * single turn instead of having to call another tool to see the new list. */
async function staleIndexFailure(
  session: BrowserSession,
  index: number,
  action: string,
): Promise<BrowserActionResult> {
  // Capture a fresh frame so the response carries the live element list and a
  // screenshot with the SoM overlay painted on it. The agent can pick a new
  // [N] immediately without spending an extra iteration on browser_screenshot.
  let screenshotPath: string | undefined
  let screenshotUrl: string | undefined
  let screenshotBase64: string | undefined
  let interactiveElements = ''
  try {
    const frame = await captureFrame(session)
    screenshotPath = frame.screenshotPath
    screenshotUrl = frame.screenshotUrl
    screenshotBase64 = frame.screenshotBase64
    interactiveElements = frame.interactiveElements
  } catch { /* best-effort frame capture — fall through with no screenshot */ }
  const baseMessage = staleIndexMessage(index, session)
  return {
    success: false,
    url: session.page.url(),
    title: await session.page.title().catch(() => ''),
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
    error: baseMessage,
    content: interactiveElements || undefined,
    action,
  }
}

function isPrimaryActionLabel(label: string): boolean {
  return /\b(add|bag|cart|checkout|continue|next|buy|submit|place order|save|apply|done|finish|pay)\b/i.test(label)
}

function isSelectionLikeElement(element: IndexedElement): boolean {
  const label = element.label || element.primary
  return ['radio', 'option', 'tab'].includes(element.role) ||
    (element.role === 'button' && !!element.state?.selected && !isPrimaryActionLabel(label))
}

async function disabledIndexedElementFailure(
  session: BrowserSession,
  index: number,
  element: IndexedElement,
): Promise<BrowserActionResult> {
  const label = element.label || element.primary
  const title = await session.page.title().catch(() => '')
  const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
  return {
    success: false,
    url: session.page.url(),
    title,
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
    error: `Element [${index}] "${label}" is ${element.state?.unavailable ? 'unavailable' : 'disabled'}. Do not keep clicking it; choose another option, scroll to the next required section, or search the page for the next actionable control.`,
    content: interactiveElements || undefined,
    action: `Failed click — element [${index}] disabled`,
  }
}

async function alreadySelectedIndexedElementResult(
  session: BrowserSession,
  index: number,
  element: IndexedElement,
): Promise<BrowserActionResult> {
  const label = element.label || element.primary
  const title = await session.page.title().catch(() => '')
  const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
  return {
    success: true,
    url: session.page.url(),
    title,
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
    content: `Element [${index}] "${label}" is already selected. Continue to the next required page section instead of re-clicking it.\n${interactiveElements || ''}`.trim(),
    action: `Skipped click — element [${index}] already selected`,
  }
}

function distanceToRect(x: number, y: number, rect: IndexedElement['rect']): number {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  const dx = x < rect.left ? rect.left - x : x > right ? x - right : 0
  const dy = y < rect.top ? rect.top - y : y > bottom ? y - bottom : 0
  return Math.round(Math.sqrt(dx * dx + dy * dy))
}

function indexedStateMarkers(element: IndexedElement): string {
  const markers: string[] = []
  if (element.state?.disabled) markers.push(element.state.unavailable ? '[UNAVAILABLE]' : '[DISABLED]')
  if (element.state?.selected) markers.push('[SELECTED]')
  if (element.state?.checked) markers.push('[CHECKED]')
  if (element.state?.pressed) markers.push('[PRESSED]')
  if (element.state?.current) markers.push('[CURRENT]')
  return markers.join(' ')
}

function nearestIndexedElements(
  session: BrowserSession,
  x: number,
  y: number,
  limit = 5,
): Array<{ index: number; element: IndexedElement; distance: number }> {
  const entries = Array.from(session.lastElementIndex?.entries() || [])
  return entries
    .map(([idx, element]) => ({ index: idx, element, distance: distanceToRect(x, y, element.rect) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}

async function probeClickPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{
  empty: boolean
  clickable: boolean
  tag: string
  text: string
  id: string
  primary: string
  clickablePrimary: string
}> {
  return page.evaluate(({ cx, cy }: { cx: number; cy: number }) => {
    function escapeAttr(value: string): string {
      return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }
    function selectorFor(el: Element): string {
      const tag = el.tagName.toLowerCase()
      const id = el.getAttribute('id') || ''
      const ariaLabel = el.getAttribute('aria-label') || ''
      const name = el.getAttribute('name') || ''
      const placeholder = el.getAttribute('placeholder') || ''
      const title = el.getAttribute('title') || ''
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-id') || el.getAttribute('data-action')
      if (id) return `#${CSS.escape(id)}`
      if (ariaLabel) return `[aria-label="${escapeAttr(ariaLabel)}"]`
      if (name) return `${tag}[name="${escapeAttr(name)}"]`
      if (placeholder) return `${tag}[placeholder="${escapeAttr(placeholder)}"]`
      if (title) return `[title="${escapeAttr(title)}"]`
      if (testId) return `${tag}[data-testid="${escapeAttr(testId)}"]`
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
      if (text && text.length <= 40) return `text=${text}`
      return ''
    }
    function visibleText(el: Element, tag: string): string {
      if (tag === 'html' || tag === 'body') return ''
      return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    }
    function hasClickSignal(el: Element): boolean {
      const htmlEl = el as HTMLElement
      if (htmlEl.onclick || el.getAttribute('onclick')) return true
      const tabIndex = el.getAttribute('tabindex')
      if (tabIndex !== null && tabIndex !== '-1') return true
      const style = window.getComputedStyle(el)
      if (style.cursor === 'pointer') return true
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-') && /click|action|toggle|select|btn|button|link|tab|trigger/i.test(attr.name)) return true
      }
      return false
    }

    const stack = document.elementsFromPoint(cx, cy)
    const top = stack[0]
    if (!top) return { empty: true, clickable: false, tag: '', text: '', id: '', primary: '', clickablePrimary: '' }

    const interactiveSelector = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
      '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="slider"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
      '[class*="btn"]', '[class*="button"]', '[class*="click"]', '[class*="toggle"]',
      '[class*="tab"]',
    ].join(',')

    let clickable: Element | null = null
    for (const candidate of stack) {
      const closest = candidate.closest(interactiveSelector)
      if (closest && closest !== document.body && closest !== document.documentElement) {
        clickable = closest
        break
      }
      if (candidate !== document.body && candidate !== document.documentElement && hasClickSignal(candidate)) {
        clickable = candidate
        break
      }
    }

    const tag = top.tagName.toLowerCase()
    const primary = selectorFor(top)
    const clickablePrimary = clickable ? selectorFor(clickable) : ''
    return {
      empty: tag === 'html' || tag === 'body',
      clickable: !!clickable,
      tag,
      text: visibleText(top, tag),
      id: (top as HTMLElement).id ? `#${CSS.escape((top as HTMLElement).id)}` : '',
      primary,
      clickablePrimary,
    }
  }, { cx: x, cy: y }).catch(() => ({
    empty: true,
    clickable: false,
    tag: '',
    text: '',
    id: '',
    primary: '',
    clickablePrimary: '',
  }))
}

async function coordinateMissFailure(
  session: BrowserSession,
  x: number,
  y: number,
  hitInfo: string,
): Promise<BrowserActionResult> {
  const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
  const nearest = nearestIndexedElements(session, x, y, 5)
  const nearestLines = nearest.length > 0
    ? '\nNearest indexed controls:\n' + nearest.map(({ index, element, distance }) => {
      const label = element.label || element.primary
      const markers = indexedStateMarkers(element)
      return `- [${index}] ${element.role} "${label.slice(0, 60)}"${markers ? ` ${markers}` : ''} (${distance}px away)`
    }).join('\n')
    : ''
  return {
    success: false,
    url: session.page.url(),
    title: await session.page.title().catch(() => ''),
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
    error: `Click blocked before execution at (${x}, ${y}): hit ${hitInfo}, not a live clickable control.`,
    content: `Use browser_click_at({index: N}) from the fresh list below. If the target is not listed, use browser_scroll or browser_find_text to reveal it before clicking.${nearestLines}\n\n${interactiveElements || ''}`.trim(),
    action: `Blocked click at (${x}, ${y}) — no live control`,
  }
}

async function browserActionFailureWithFreshFrame(
  session: BrowserSession | null,
  error: unknown,
  action: string,
): Promise<BrowserActionResult> {
  const message = sanitizeBrowserAutomationError(error)
  if (!session) {
    return {
      success: false,
      url: '',
      title: '',
      recoverable: true,
      error: message,
      action,
    }
  }

  let url = ''
  let title = ''
  try { url = session.page.url() } catch { /* best effort */ }
  try { title = await session.page.title() } catch { /* best effort */ }

  try {
    await settlePageAfterBrowserAction(session, 500).catch(() => {})
    try { url = session.page.url() } catch { /* best effort */ }
    try { title = await session.page.title() } catch { /* best effort */ }
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    return {
      success: false,
      url,
      title,
      recoverable: true,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      error: message,
      content: [
        'Browser action failed after execution. Use the fresh screenshot and interactive elements list below to choose a different visible [N], scroll/reveal the target, or use a field-specific action.',
        interactiveElements,
      ].filter(Boolean).join('\n\n') || undefined,
      action,
    }
  } catch {
    return {
      success: false,
      url,
      title,
      recoverable: true,
      error: message,
      action,
    }
  }
}

async function locatorClosestToPoint(
  page: Page,
  selector: string,
  x: number,
  y: number,
): Promise<{ locator: Locator; matchCount: number; distance: number | null }> {
  const base = page.locator(normalizeSelector(selector))
  const matchCount = await base.count().catch(() => 0)
  if (matchCount <= 1) return { locator: base.first(), matchCount, distance: null }

  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  const limit = Math.min(matchCount, 30)
  for (let i = 0; i < limit; i++) {
    const loc = base.nth(i)
    const box = await loc.boundingBox({ timeout: 300 }).catch(() => null)
    if (!box) continue
    const rect = {
      left: Math.round(box.x),
      top: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
    const distance = distanceToRect(x, y, rect)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }

  return {
    locator: base.nth(bestIndex),
    matchCount,
    distance: Number.isFinite(bestDistance) ? bestDistance : null,
  }
}

type BrowserFrameListener = (base64: string) => void

// Use globalThis to persist sessions across Next.js hot reloads and module re-evaluations
const globalKey = '__browserSessions' as const
const sessions: Map<string, BrowserSession> =
  (globalThis as unknown as Record<string, Map<string, BrowserSession>>)[globalKey] ??
  ((globalThis as unknown as Record<string, Map<string, BrowserSession>>)[globalKey] = new Map())

const frameListenersKey = '__browserPendingFrameListeners' as const
const pendingFrameListeners: Map<string, Set<BrowserFrameListener>> =
  (globalThis as unknown as Record<string, Map<string, Set<BrowserFrameListener>>>)[frameListenersKey] ??
  ((globalThis as unknown as Record<string, Map<string, Set<BrowserFrameListener>>>)[frameListenersKey] = new Map())

const IDLE_TIMEOUT_MS = 15 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60_000
const SCREENSHOT_DIR = '_browser_screenshots'
const BROWSER_PROXY_MAX_BYTES = 10 * 1024 * 1024
const BROWSER_PROXY_TIMEOUT_MS = 20_000
const MAX_CLICK_HOLD_MS = 5_000
const BROWSER_CONTEXT_OPTIONS: NonNullable<Parameters<Browser['newContext']>[0]> = {
  viewport: { width: 1280, height: 720 },
  acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/New_York',
  extraHTTPHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
  },
}

// Prevent duplicate session creation when concurrent requests arrive for the same conversationId
const pendingKey = '__browserPending' as const
const pendingSessions: Map<string, Promise<BrowserSession>> =
  (globalThis as unknown as Record<string, Map<string, Promise<BrowserSession>>>)[pendingKey] ??
  ((globalThis as unknown as Record<string, Map<string, Promise<BrowserSession>>>)[pendingKey] = new Map())

function attachPendingFrameListeners(session: BrowserSession): void {
  const pending = pendingFrameListeners.get(session.conversationId)
  if (!pending || pending.size === 0) return
  for (const listener of pending) {
    session.frameListeners.add(listener)
  }
  pendingFrameListeners.delete(session.conversationId)
}

async function createBrowserRuntime(conversationId: string): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page | null
  remoteProvider?: 'e2b'
}> {
  if (isCloudSandboxProviderEnabled()) {
    const debuggerUrl = await ensureE2BRemoteBrowserDebuggerUrl(conversationId)
    const browser = await playwrightChromium.connectOverCDP(debuggerUrl)
    let context = browser.contexts()[0]
    if (!context) {
      context = await browser.newContext(BROWSER_CONTEXT_OPTIONS)
    } else {
      await context.setExtraHTTPHeaders(BROWSER_CONTEXT_OPTIONS.extraHTTPHeaders || {}).catch(() => {})
    }

    const page = context.pages()[0] || null
    if (page) {
      await page.setViewportSize({ width: 1280, height: 720 }).catch(() => {})
    }

    return { browser, context, page, remoteProvider: 'e2b' }
  }

  const browser = await playwrightChromium.launch(await getChromiumLaunchOptions())
  const context = await browser.newContext(BROWSER_CONTEXT_OPTIONS)
  return { browser, context, page: null }
}

async function getOrCreateSession(conversationId: string): Promise<BrowserSession> {
  const existing = sessions.get(conversationId)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing
  }

  // If another caller is already creating this session, await the same promise
  const pending = pendingSessions.get(conversationId)
  if (pending) return pending

  const creation = createSessionImpl(conversationId)
  pendingSessions.set(conversationId, creation)
  try {
    return await creation
  } finally {
    pendingSessions.delete(conversationId)
  }
}

async function createSessionImpl(conversationId: string): Promise<BrowserSession> {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let initialPage: Page | null = null
  let remoteProvider: BrowserSession['remoteProvider']
  try {
    const runtime = await createBrowserRuntime(conversationId)
    browser = runtime.browser
    context = runtime.context
    initialPage = runtime.page
    remoteProvider = runtime.remoteProvider
  } catch (launchError) {
    console.error('[Browser] Failed to launch browser:', launchError)
    throw launchError
  }

  try {
    if (!browser || !context) throw new Error('Browser runtime was not initialized')
    await context.route('**/*', async (route) => {
    const request = route.request()
    const requestUrl = request.url()
    if (!/^https?:\/\//i.test(requestUrl)) {
      await route.continue()
      return
    }

    const validation = await validateBrowserNavigationUrl(requestUrl)
    if (!validation.ok) {
      await route.abort('blockedbyclient')
      return
    }

    const parsed = new URL(validation.url)
    if (isSandboxPreviewUrl(parsed) || isManagedWebsiteServerUrl(parsed) || isManagedWebsitePreviewUrl(parsed)) {
      await route.continue()
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), BROWSER_PROXY_TIMEOUT_MS)
    try {
      const headers = { ...request.headers() }
      delete headers.host
      delete headers.connection
      delete headers['content-length']
      headers['accept-encoding'] = 'identity'
      const method = request.method().toUpperCase()
      const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : request.postDataBuffer() ?? undefined
      const response = await guardedFetch(validation.url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
        maxBytes: BROWSER_PROXY_MAX_BYTES,
      })
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase()
        if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') {
          return
        }
        responseHeaders[key] = value
      })
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: Buffer.from(await response.arrayBuffer()),
      })
    } catch {
      await route.abort('blockedbyclient')
    } finally {
      clearTimeout(timeout)
    }
  })

  // Patch webdriver and other detection vectors before any page loads
  await context.addInitScript(() => {
    // Core webdriver detection
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    const navigatorPrototype = Object.getPrototypeOf(navigator) as { webdriver?: unknown }
    delete navigatorPrototype.webdriver

    // Realistic plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ]
        const arr = Object.create(PluginArray.prototype)
        for (let i = 0; i < plugins.length; i++) {
          const p = Object.create(Plugin.prototype)
          Object.defineProperties(p, {
            name: { value: plugins[i].name },
            filename: { value: plugins[i].filename },
            description: { value: plugins[i].description },
            length: { value: 0 },
          })
          Object.defineProperty(arr, i, { value: p })
        }
        Object.defineProperty(arr, 'length', { value: plugins.length })
        return arr
      },
    })
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })
    // Realistic hardware concurrency and device memory
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 })

    // Patch chrome object
    const w = window as unknown as Record<string, unknown>
    w.chrome = {
      runtime: {
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onConnect: { addListener: () => {}, removeListener: () => {} },
        id: undefined,
      },
      loadTimes: () => ({
        commitLoadTime: Date.now() / 1000 - 1.5,
        connectionInfo: 'http/1.1',
        finishDocumentLoadTime: Date.now() / 1000 - 0.5,
        finishLoadTime: Date.now() / 1000 - 0.3,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 - 0.8,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'unknown',
        requestTime: Date.now() / 1000 - 2.0,
        startLoadTime: Date.now() / 1000 - 1.8,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
      }),
      csi: () => ({
        onloadT: Date.now(),
        startE: Date.now() - 2000,
        pageT: 2000,
        tran: 15,
      }),
      app: {
        isInstalled: false,
        InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed', DISABLED: 'disabled' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
        runningState: () => 'cannot_run',
      },
    }

    // Patch permissions
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
    window.navigator.permissions.query = (params: PermissionDescriptor) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
      }
      return originalQuery(params)
    }

    // Canvas fingerprint — add subtle noise to prevent fingerprint detection
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function(type?: string) {
      if (this.width > 16 && this.height > 16) {
        const ctx = this.getContext('2d')
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, 2, 2)
          imageData.data[0] = imageData.data[0] ^ 1  // Flip one bit
          ctx.putImageData(imageData, 0, 0)
        }
      }
      return origToDataURL.apply(this, [type] as unknown as [])
    }

    // WebGL fingerprint
    const getParameter = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function(pname: number) {
      if (pname === 37445) return 'Intel Inc.'  // UNMASKED_VENDOR_WEBGL
      if (pname === 37446) return 'Intel Iris OpenGL Engine'  // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, pname)
    }

    // Auto-deny notification/push permission prompts
    if ('Notification' in window) {
      Object.defineProperty(window.Notification, 'permission', { get: () => 'denied' })
    }

    // Proactively dismiss popups that appear after page load
    const dismissPopups = () => {
      const selectors = [
        '[class*="cookie"] button[class*="accept"]',
        '[class*="cookie"] button[class*="close"]',
        '[class*="consent"] button[class*="accept"]',
        '[id*="cookie"] button[class*="accept"]',
        '[id*="consent"] button[class*="accept"]',
        '[class*="gdpr"] button[class*="accept"]',
        'button.ytp-ad-skip-button',
        'button.ytp-ad-skip-button-modern',
        '.ytp-ad-overlay-close-button',
        'tp-yt-paper-dialog #dismiss-button',
        '[aria-label="Close"]',
        '[aria-label="Dismiss"]',
      ]
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel)
        for (const el of els) {
          const r = el.getBoundingClientRect()
          const s = window.getComputedStyle(el)
          if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
            ;(el as HTMLElement).click()
          }
        }
      }
    }
    // Run after load and periodically for the first 10 seconds
    setTimeout(dismissPopups, 1000)
    setTimeout(dismissPopups, 3000)
    setTimeout(dismissPopups, 6000)
    setTimeout(dismissPopups, 10000)
  })

    const page = initialPage || await context.newPage()

    let cdp: CDPSession | null = null
    try {
      cdp = await context.newCDPSession(page)
    } catch {
      // CDP not available — will fall back to polling screenshots
    }

    const session: BrowserSession = {
      browser,
      context,
      page,
      cdp,
      remoteProvider,
      lastUsed: Date.now(),
      conversationId,
      screencastActive: false,
      frameListeners: new Set(),
      latestFrame: null,
      lastElementSelectors: null,
      lastElementFingerprints: null,
      lastClickedSelector: null,
      lastInteractiveElementsText: null,
      lastElementIndex: null,
      failedNavigations: new Map(),
      pageBlocker: null,
      downloads: [],
    }

    page.on('download', (download) => {
      void saveBrowserDownload(session, download)
    })

    sessions.set(conversationId, session)
    attachPendingFrameListeners(session)
    // Start screencast immediately so latestFrame is always available
    startScreencast(session)
    return session
  } catch (sessionError) {
    // Clean up partially created resources on failure
    console.error('[Browser] Failed to create session, cleaning up:', sessionError)
    try { await context?.close() } catch { /* ignore */ }
    try { await browser.close() } catch { /* ignore */ }
    throw sessionError
  }
}

async function takeScreenshot(
  session: BrowserSession,
  fullPage = false
): Promise<{ screenshotPath: string; screenshotUrl: string; screenshotBase64: string }> {
  const filename = `screenshot_${Date.now()}.jpg`
  const screenshotPath = `${SCREENSHOT_DIR}/${filename}`

  const jpegBuffer = await session.page.screenshot({ type: 'jpeg', quality: 70, fullPage })
  await writeSandboxFileBytes(session.conversationId, screenshotPath, new Uint8Array(jpegBuffer))
  const screenshotBase64 = jpegBuffer.toString('base64')

  const screenshotUrl = `/api/sandbox/${session.conversationId}/${screenshotPath}`

  return { screenshotPath, screenshotUrl, screenshotBase64 }
}

function safeDownloadFilename(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140)
  return cleaned || `download-${Date.now()}`
}

async function saveBrowserDownload(session: BrowserSession, download: Download): Promise<void> {
  const suggestedFilename = safeDownloadFilename(download.suggestedFilename())
  const createdAt = Date.now()
  const path = `downloads/${createdAt}-${suggestedFilename}`
  try {
    const sandboxDir = await getOrCreateSandboxDir(session.conversationId)
    const downloadsDir = join(sandboxDir, 'downloads')
    await mkdir(downloadsDir, { recursive: true })
    if (!await resolveAndVerify(sandboxDir, downloadsDir)) {
      throw new Error('Sandbox download path is not safe')
    }
    const targetPath = join(sandboxDir, path)
    if (!await resolveAndVerify(sandboxDir, targetPath)) {
      throw new Error('Sandbox download path is not safe')
    }
    await download.saveAs(targetPath)
    if (!await resolveAndVerify(sandboxDir, targetPath)) {
      try { await unlink(targetPath) } catch { /* best effort */ }
      throw new Error('Sandbox download path escaped sandbox')
    }
    if (isCloudSandboxProviderEnabled()) {
      const body = await readFile(targetPath)
      await writeSandboxFileBytes(session.conversationId, path, new Uint8Array(body))
    }
    session.downloads.push({
      path,
      suggestedFilename,
      url: download.url(),
      createdAt,
    })
  } catch (error) {
    session.downloads.push({
      path,
      suggestedFilename,
      url: download.url(),
      createdAt,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function formatDownloadNote(session: BrowserSession, fromIndex: number): string {
  const downloads = session.downloads.slice(fromIndex)
  if (downloads.length === 0) return ''

  const lines = downloads.map((download) => {
    if (download.error) {
      return `- failed ${download.suggestedFilename}: ${download.error}`
    }
    return `- ${download.path} (${download.suggestedFilename})`
  })
  return `[Downloads]\n${lines.join('\n')}\n\n`
}

/** Set-of-marks: inject numbered colored bounding boxes onto the page so the
 * visual agent context includes [N] painted next to each interactive element.
 * Reads from session.lastElementIndex (populated by getInteractiveElements).
 * The overlay container is tagged with id="__agent_som_overlay__" so the
 * elements scan filters it out on its next call. */
async function injectSomOverlay(session: BrowserSession): Promise<void> {
  if (!session.lastElementIndex || session.lastElementIndex.size === 0) return
  const items = Array.from(session.lastElementIndex.entries())
    .map(([idx, el]) => ({ idx, x: el.x, y: el.y, rect: el.rect }))
    .filter(it => it.rect.width > 0 && it.rect.height > 0)
  if (items.length === 0) return

  await session.page.evaluate((items) => {
    // Remove any prior overlay (defensive — captureFrame removes it after each shot)
    document.getElementById('__agent_som_overlay__')?.remove()

    // 8-color palette so adjacent boxes are visually distinct. Reds and greens
    // first because they're the most legible at small sizes against most pages.
    const colors = [
      '#FF3B30', '#34C759', '#007AFF', '#FF9500',
      '#AF52DE', '#00C7BE', '#FF2D55', '#5856D6',
    ]

    const container = document.createElement('div')
    container.id = '__agent_som_overlay__'
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:100vw',
      'height:100vh',
      'pointer-events:none',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
    ].join(';')

    for (const item of items) {
      const color = colors[(item.idx - 1) % colors.length]
      const box = document.createElement('div')
      box.style.cssText = [
        'position:absolute',
        `left:${item.rect.left}px`,
        `top:${item.rect.top}px`,
        `width:${item.rect.width}px`,
        `height:${item.rect.height}px`,
        `border:2px solid ${color}`,
        'box-sizing:border-box',
        'border-radius:2px',
      ].join(';')

      const label = document.createElement('div')
      label.textContent = String(item.idx)
      label.style.cssText = [
        'position:absolute',
        'top:-1px',
        'left:-1px',
        `background:${color}`,
        'color:#fff',
        'font-size:11px',
        'font-weight:700',
        'padding:1px 5px',
        'line-height:1.2',
        'border-radius:0 0 4px 0',
        'min-width:14px',
        'text-align:center',
        'white-space:nowrap',
      ].join(';')
      box.appendChild(label)
      container.appendChild(box)

      const dot = document.createElement('div')
      dot.style.cssText = [
        'position:absolute',
        `left:${Math.max(0, item.x - 4)}px`,
        `top:${Math.max(0, item.y - 4)}px`,
        'width:8px',
        'height:8px',
        `background:${color}`,
        'border:2px solid #fff',
        'box-sizing:border-box',
        'border-radius:50%',
        'box-shadow:0 0 0 1px rgba(0,0,0,.55)',
      ].join(';')
      container.appendChild(dot)
    }

    document.documentElement.appendChild(container)
  }, items)
}

async function removeSomOverlay(session: BrowserSession): Promise<void> {
  await session.page
    .evaluate(() => {
      document.getElementById('__agent_som_overlay__')?.remove()
    })
    .catch(() => {})
}

/** One-shot frame capture: rebuilds the indexed elements list, paints the
 * set-of-marks overlay onto the page, takes the screenshot, then clears the
 * overlay. The returned `interactiveElements` text is the same indexed list
 * the agent uses for {index: N} arguments — and the screenshot it gets back
 * has matching [N] labels painted on the actual element rectangles. */
async function captureFrame(
  session: BrowserSession,
  opts?: { fullPage?: boolean }
): Promise<{
  screenshotPath: string
  screenshotUrl: string
  screenshotBase64: string
  interactiveElements: string
  visibleValidationErrors: string[]
}> {
  // 1. Build the elements list — populates session.lastElementIndex with rects.
  let interactiveElements = await refreshInteractiveElementsWithSettling(session)
  const visibleValidationErrors = await getVisibleValidationErrors(session.page)
  interactiveElements = prependVisibleValidationErrors(interactiveElements, visibleValidationErrors) || interactiveElements
  // 2. Paint the [N] overlay onto the page using the freshly populated index
  await injectSomOverlay(session)
  // 3. Capture the screenshot — vision LLM sees [N] labels painted on elements
  const shot = await takeScreenshot(session, opts?.fullPage ?? false)
  // 4. Remove the overlay so subsequent actions don't see it as page content
  await removeSomOverlay(session)
  return { ...shot, interactiveElements, visibleValidationErrors }
}

export async function browserNavigate(
  conversationId: string,
  url: string
): Promise<BrowserActionResult> {
  try {
    const validation = await validateBrowserNavigationUrl(url)
    if (!validation.ok) {
      return {
        success: false,
        url,
        title: '',
        error: `Blocked unsafe navigation target: ${validation.error}`,
        action: `Blocked navigation: ${url}`,
      }
    }
    const safeUrl = validation.url
    const session = await getOrCreateSession(conversationId)

    // Short-circuit: if this URL has already failed in this session, don't waste
    // another iteration loading it. The agent should try a different source.
    const normUrl = normalizeNavUrl(safeUrl)
    const previousFailure = session.failedNavigations.get(normUrl)
    if (previousFailure) {
      return {
        success: false,
        url: safeUrl,
        title: '',
        error: `You already tried this URL earlier and it failed (${previousFailure}). DO NOT retry the same URL — try a DIFFERENT source: a different domain, a search engine result, or use web_search to find an alternative.`,
        action: `Skipped — known broken: ${safeUrl}`,
      }
    }

    // Navigation creates a brand-new context — clear stale click history so the
    // first elements list on the new page doesn't show false [JUST CLICKED]
    // markers and doesn't compute a misleading diff against the old page.
    // Also clear the index map so old [N] indices can never resolve to a new
    // page's coordinates (would silently click the wrong element).
    session.lastElementSelectors = null
    session.lastElementFingerprints = null
    session.lastClickedSelector = null
    session.lastInteractiveElementsText = null
    session.lastElementIndex = null
    session.pageBlocker = null

    let response
    try {
      response = await session.page.goto(safeUrl, { timeout: 10000, waitUntil: 'domcontentloaded' })
    } catch (navErr) {
      // Navigation timeout or error — try to work with whatever loaded
      if (navErr instanceof Error && (navErr.message.includes('Timeout') || navErr.message.includes('timeout'))) {
        // Page partially loaded — continue with what we have
      } else if (navErr instanceof Error && navErr.message.includes('net::')) {
        // Network error (DNS failure, connection refused, etc.)
        const networkError = describeNetworkNavigationError(safeUrl, navErr)
        await session.page.goto('about:blank', { timeout: 3000, waitUntil: 'domcontentloaded' })
          .catch(() => session.page.evaluate(() => window.stop()).catch(() => {}))
        return {
          success: false,
          recoverable: true,
          url: safeUrl,
          title: '',
          error: networkError.userError,
          content: networkError.content,
          action: `Failed to load: ${safeUrl}`,
        }
      } else {
        throw navErr
      }
    }

    const finalNavigation = await validateBrowserNavigationUrl(session.page.url())
    if (!finalNavigation.ok) {
      const finalUrl = session.page.url()
      const unsupportedProtocol = unsupportedBrowserFinalProtocol(finalUrl)
      if (unsupportedProtocol) {
        const title = await session.page.title().catch(() => '')
        let frame: Awaited<ReturnType<typeof captureFrame>> | null = null
        try {
          frame = await captureFrame(session)
        } catch {
          frame = null
        }
        return {
          success: false,
          recoverable: true,
          url: finalUrl,
          title,
          screenshotPath: frame?.screenshotPath,
          screenshotUrl: frame?.screenshotUrl,
          screenshotBase64: frame?.screenshotBase64,
          error: `Navigation redirected outside a normal web page to a ${unsupportedProtocol} target. The browser cannot render that app/deep-link target; recover with the site homepage, same-site search, web_search, or a different HTTP/HTTPS result URL.`,
          content: [
            `Original URL: ${safeUrl}`,
            `Redirect target: ${finalUrl}`,
            frame?.interactiveElements,
          ].filter(Boolean).join('\n\n') || undefined,
          action: `Redirected outside browser from ${safeUrl}`,
        }
      }

      session.failedNavigations.set(normUrl, 'unsafe redirect')
      session.pageBlocker = 'Unsafe redirect blocked'
      await session.page.goto('about:blank').catch(() => {})
      return {
        success: false,
        url: finalUrl,
        title: '',
        error: `Blocked unsafe redirect target: ${finalNavigation.error}`,
        action: `Blocked redirect from ${safeUrl}`,
      }
    }

    // Check HTTP status
    const status = response?.status() || 0
    const blocked = status === 403 || status === 429 || status === 503

    // Let client-side rendering settle without paying a fixed multi-second tax
    // on every navigation. Slow pages still get a bounded stability window.
    await settlePageAfterNavigation(session, safeUrl)

    // Auto-dismiss popups (with timeout guard)
    let dismissed: string[] = []
    {
      let dismissTimeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        dismissed = await Promise.race([
          autoDismissPopups(session.page),
          new Promise<string[]>(r => { dismissTimeoutId = setTimeout(() => r([]), 1200) }),
        ])
      } catch { /* ignore */ } finally {
        if (dismissTimeoutId !== undefined) clearTimeout(dismissTimeoutId)
      }
    }

    const title = await session.page.title().catch(() => '')

    let content = ''
    if (dismissed.length > 0) content += `[Auto-dismissed: ${dismissed.join(', ')}]\n`
    {
      let bodyTextTimeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const bodyText = await Promise.race([
          session.page.innerText('body'),
          new Promise<string>(r => { bodyTextTimeoutId = setTimeout(() => r(''), 1600) }),
        ])
        content += bodyText
        if (content.length > 8000) content = content.slice(0, 8000) + '\n...[truncated]'
      } catch {
        // Some pages may not have a body
      } finally {
        if (bodyTextTimeoutId !== undefined) clearTimeout(bodyTextTimeoutId)
      }
    }

    // Detect if page is truly blocked (not just sparse content)
    const trimmedContent = content.replace(/\[Auto-dismissed:.*?\]\n?/g, '').trim()
    const contentLength = trimmedContent.length
    const challengeReason = await detectHumanVerificationChallenge(session.page, trimmedContent)

    // Detect error pages: 404, soft-404, "page not found", error-redirect URLs.
    // The previous code only caught 403/429/503 — actual 404s and the common
    // "redirected to /resourcenotfound" pattern slipped through with success: true,
    // and the agent would keep clicking dead elements on the broken page.
    const finalUrl = session.page.url()
    const errorReason = detectErrorPage({ status, finalUrl, title, bodyText: trimmedContent })

    // captureFrame: builds elements list, paints set-of-marks overlay, then screenshots
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const elementIndex = session.lastElementIndex as Map<number, IndexedElement> | null
    const indexedCount = elementIndex ? elementIndex.size : 0
    const healthyDespiteChallenge = !!challengeReason && !blocked && pageAppearsHealthyForActions({
      finalUrl,
      title,
      bodyText: trimmedContent,
      indexedCount,
    })
    const effectiveChallengeReason = healthyDespiteChallenge ? null : challengeReason

    // Only flag as blocked on HTTP error codes or clear block messages.
    // Do NOT flag pages with low content — many SPAs and JS-heavy sites have sparse initial text.
    // Content-rich pages with normal controls can contain embedded anti-spam widgets
    // or modal text without being a full-page human-verification challenge.
    const blockPattern = /^(access denied|403 forbidden|blocked|you have been blocked|please verify you are|are you human|checking your browser|just a moment|attention required|cloudflare|security check)/i
    const isBlocked = blocked || !!effectiveChallengeReason || (contentLength < 30 && contentLength > 0 && blockPattern.test(trimmedContent))

    if (isBlocked) {
      const reason = blocked
        ? `HTTP ${status} — page blocked access`
        : effectiveChallengeReason
        ? effectiveChallengeReason
        : contentLength < 100
        ? 'Page loaded with too little visible content to verify'
        : 'Page appears to be blocked or showing a challenge screen'

      // Remember this URL is broken so future browser_navigate calls short-circuit
      session.failedNavigations.set(normUrl, reason)
      session.pageBlocker = reason
      // Also record the FINAL URL (post-redirect) so a redirected-to-error-page also counts
      const normFinal = normalizeNavUrl(finalUrl)
      if (normFinal !== normUrl) session.failedNavigations.set(normFinal, reason)

      return {
        success: false,
        recoverable: true,
        url: finalUrl,
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: `Navigation failed: ${reason}.`,
        content: `INTERNAL_RECOVERY: The page is blocked (${reason}). Do not attempt to solve CAPTCHA, click image tiles, or interact with human-verification controls. Do not retry this URL; recover with a different source, same-site search, or broader web search. If the user explicitly requires this exact site, report that manual verification is required.\n\n${content}${interactiveElements}`.trim() || undefined,
        action: `Page blocked: ${title || safeUrl}`,
      }
    }

    if (errorReason) {
      // Remember both the requested AND final URL so redirects to error pages
      // can never be re-attempted by mistake.
      session.failedNavigations.set(normUrl, errorReason)
      session.pageBlocker = errorReason
      const normFinal = normalizeNavUrl(finalUrl)
      if (normFinal !== normUrl) session.failedNavigations.set(normFinal, errorReason)
      return {
        success: false,
        recoverable: true,
        url: finalUrl,
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: `Navigation failed: ${errorReason}.`,
        content: navigationRecoveryContent(errorReason, safeUrl, finalUrl, title, content, interactiveElements) || undefined,
        action: `Error page: ${title || safeUrl}`,
      }
    }

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: content + interactiveElements,
      action: `Navigated to ${title || safeUrl}`,
    }
  } catch (err) {
    return {
      success: false,
      url,
      title: '',
      error: `${err instanceof Error ? err.message : String(err)}. Do NOT retry this same URL — try a different source or approach.`,
      action: `Failed to navigate to ${url}`,
    }
  }
}

/** One-line raw observation of the page's interactive structure. Reports
 * role counts and the most-repeated short action label (if any) — no
 * patronizing recipes. The model interprets the structural facts. */
type ClassifyItem = { role: string; label?: string }
type ClassifyData = {
  forms: Array<[string, ClassifyItem[]]>
  primaries: ClassifyItem[]
  navs: ClassifyItem[]
  others: ClassifyItem[]
  totalCount: number
  modalOpen: boolean
}
function classifyPageType(data: ClassifyData): string {
  if (data.modalOpen) return 'modal open — interact with the modal contents first'

  let radios = 0, checkboxes = 0, textInputs = 0, dropdowns = 0, buttons = 0, links = 0
  const allItems: ClassifyItem[] = [
    ...data.forms.flatMap(([, items]) => items),
    ...data.primaries,
    ...data.navs,
    ...data.others,
  ]
  for (const item of allItems) {
    const r = item.role
    if (r === 'radio') radios++
    else if (r === 'checkbox') checkboxes++
    else if (r === 'text-input' || r === 'textarea' || r.endsWith('-input')) textInputs++
    else if (r === 'dropdown') dropdowns++
    else if (r === 'button') buttons++
    else if (r === 'link') links++
  }

  // Most-repeated short action label — signals a list of items
  // ("Add to cart" x5, "Read more" x8, etc). The agent infers what to do.
  const labelCounts = new Map<string, number>()
  let topLabel = '', topCount = 0
  for (const item of allItems) {
    if (item.role !== 'button' && item.role !== 'link') continue
    const lbl = (item.label || '').trim().toLowerCase()
    if (!lbl || lbl.length > 30) continue
    const c = (labelCounts.get(lbl) || 0) + 1
    labelCounts.set(lbl, c)
    if (c > topCount) { topLabel = lbl; topCount = c }
  }

  const parts: string[] = []
  if (textInputs) parts.push(`${textInputs} input${textInputs === 1 ? '' : 's'}`)
  if (radios) parts.push(`${radios} radio${radios === 1 ? '' : 's'}`)
  if (checkboxes) parts.push(`${checkboxes} checkbox${checkboxes === 1 ? '' : 'es'}`)
  if (dropdowns) parts.push(`${dropdowns} dropdown${dropdowns === 1 ? '' : 's'}`)
  if (buttons) parts.push(`${buttons} button${buttons === 1 ? '' : 's'}`)
  if (links) parts.push(`${links} link${links === 1 ? '' : 's'}`)

  let line = parts.length ? parts.join(', ') : `${data.totalCount} elements`
  if (topCount >= 3) line += ` (${topCount}x "${topLabel}")`
  return line
}

/** Extract a compact summary of interactive elements for the AI agent.
 * When called with a session, diffs against the previous snapshot, marks new
 * elements with [NEW], marks the just-clicked element with [JUST CLICKED], and
 * prepends a "page changed/unchanged" line so the agent has an objective signal
 * about whether its last action accomplished anything. */
async function getInteractiveElements(sessionOrPage: BrowserSession | Page): Promise<string> {
  // Detect whether we got a session or a raw page (backwards compat)
  const isSession = (sessionOrPage as BrowserSession).page !== undefined
  const session = isSession ? (sessionOrPage as BrowserSession) : null
  const page = isSession ? (sessionOrPage as BrowserSession).page : (sessionOrPage as Page)
  const commitOutput = (output: string): string => {
    if (session) session.lastInteractiveElementsText = output
    return output
  }

  const prevSelectors: string[] = session?.lastElementSelectors ? [...session.lastElementSelectors] : []
  const prevFingerprints: string[] = session?.lastElementFingerprints ? [...session.lastElementFingerprints] : []
  const justClicked = session?.lastClickedSelector || ''

  try {
    const data = await page.evaluate(({ prev, prevFingerprints: prevFps, clicked }: { prev: string[]; prevFingerprints: string[]; clicked: string }) => {
      const prevSet = new Set(prev)
      const prevFingerprintSet = new Set(prevFps)
      const hadPrevious = prevSet.size > 0 || prevFingerprintSet.size > 0
      const vw = window.innerWidth
      const vh = window.innerHeight
      const scrollY = Math.round(window.scrollY)
      const scrollMax = Math.round(document.documentElement.scrollHeight - vh)

      function isVisible(el: Element): boolean {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        // Must be at least partially in viewport
        return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw
      }

      function hasClickHandler(el: Element): boolean {
        const htmlEl = el as HTMLElement
        if (htmlEl.onclick || el.getAttribute('onclick') || el.getAttribute('tabindex') || el.getAttribute('aria-haspopup')) return true
        const style = window.getComputedStyle(el)
        if (style.cursor === 'pointer') return true
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') && /click|action|toggle|select|btn|button|link|tab|trigger|testid|test-id|cy|qa/i.test(`${attr.name} ${attr.value}`)) return true
        }
        return false
      }

      function escapeAttr(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      }

      function readableDataLabel(el: Element): string {
        for (const attrName of ['data-label', 'data-title', 'data-name', 'data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'data-action']) {
          const value = el.getAttribute(attrName)
          if (value && /[a-zA-Z0-9]/.test(value)) {
            return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
          }
        }
        return ''
      }

      function mediaLabel(el: Element): string {
        const ownAlt = el.getAttribute('alt')
        if (ownAlt && ownAlt.trim()) return ownAlt.trim().slice(0, 60)
        const img = el.querySelector('img[alt]')
        const imgAlt = img?.getAttribute('alt')
        if (imgAlt && imgAlt.trim()) return imgAlt.trim().slice(0, 60)
        const svgTitle = el.querySelector('svg title, title')
        const titleText = svgTitle?.textContent?.trim()
        return titleText ? titleText.slice(0, 60) : ''
      }

      function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null {
        const raw = value.trim()
        if (!raw || raw === 'transparent') return null
        const rgb = raw.match(/rgba?\(([^)]+)\)/i)
        if (!rgb) return null
        const parts = rgb[1].split(',').map(p => p.trim())
        if (parts.length < 3) return null
        const read = (part: string) => {
          if (part.endsWith('%')) return Math.round(parseFloat(part) * 2.55)
          return Math.round(parseFloat(part))
        }
        const r = read(parts[0])
        const g = read(parts[1])
        const b = read(parts[2])
        const a = parts[3] === undefined ? 1 : parseFloat(parts[3])
        if (![r, g, b].every(n => Number.isFinite(n)) || !Number.isFinite(a) || a < 0.2) return null
        return { r, g, b, a }
      }

      function colorToHex(color: { r: number; g: number; b: number }): string {
        const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
        return `#${h(color.r)}${h(color.g)}${h(color.b)}`
      }

      function approximateColorName(color: { r: number; g: number; b: number }): string {
        const { r, g, b } = color
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const delta = max - min
        const lightness = (max + min) / 2
        if (delta < 18) {
          if (lightness >= 238) return 'white'
          if (lightness >= 165) return 'silver light gray'
          if (lightness >= 72) return 'gray graphite'
          return 'black'
        }

        const hue = (() => {
          if (max === r) return ((g - b) / delta + (g < b ? 6 : 0)) * 60
          if (max === g) return ((b - r) / delta + 2) * 60
          return ((r - g) / delta + 4) * 60
        })()
        if (lightness < 45) return 'black'
        if (hue < 18 || hue >= 342) return lightness > 180 ? 'pink rose' : 'red'
        if (hue < 48) return 'orange'
        if (hue < 75) return 'gold yellow'
        if (hue < 165) return 'green sage'
        if (hue < 205) return 'teal'
        if (hue < 255) return lightness > 170 ? 'mist blue' : 'blue'
        if (hue < 295) return 'purple lavender'
        return 'pink rose'
      }

      function visualOptionLabel(el: Element): string {
        const candidates: Element[] = [el, ...Array.from(el.querySelectorAll('*')).slice(0, 30)]
        let best: { color: { r: number; g: number; b: number; a: number }; area: number } | null = null
        for (const candidate of candidates) {
          const r = candidate.getBoundingClientRect()
          if (r.width < 6 || r.height < 6 || r.width > 220 || r.height > 220) continue
          const style = window.getComputedStyle(candidate)
          const colors = [style.backgroundColor, style.borderTopColor, style.outlineColor]
          for (const value of colors) {
            const parsed = parseCssColor(value)
            if (!parsed) continue
            const area = r.width * r.height
            const isNeutralWhitePage = parsed.r > 248 && parsed.g > 248 && parsed.b > 248 && area > 4000
            if (isNeutralWhitePage) continue
            if (!best || area > best.area) best = { color: parsed, area }
          }
        }
        if (!best) return ''
        const name = approximateColorName(best.color)
        return `visual color ${name} ${colorToHex(best.color)}`
      }

      const interactiveHitSelector = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
        '[role="option"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[role="slider"]', '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
        '[onclick]', '[tabindex]:not([tabindex="-1"])',
        '[class*="btn"]', '[class*="button"]', '[class*="click"]', '[class*="toggle"]',
        '[class*="tab"]',
      ].join(',')

      function isDocumentShell(el: Element): boolean {
        return el === document.documentElement || el === document.body
      }

      function isInteractiveHit(el: Element): boolean {
        return !isDocumentShell(el) && (el.matches(interactiveHitSelector) || hasClickHandler(el))
      }

      // Find a point inside the element's visible portion that actually hits
      // the target (or one of its descendants). Returns null if every candidate
      // point is occluded by another element — meaning a click here would miss.
      function safeClickPoint(el: Element, rect: DOMRect): { x: number; y: number } | null {
        // Clamp the rect to the viewport so we never produce a center outside
        // what the user can actually click.
        const left = Math.max(0, rect.left)
        const top = Math.max(0, rect.top)
        const right = Math.min(vw, rect.right)
        const bottom = Math.min(vh, rect.bottom)
        if (right - left < 2 || bottom - top < 2) return null

        const cx = Math.round((left + right) / 2)
        const cy = Math.round((top + bottom) / 2)

        // Probe the center first, then a compact grid. We accept hits that are
        // the target or its descendants. Ancestor hits are accepted only when
        // the ancestor is itself interactive; html/body technically contain
        // every element and must never count as a valid click hit.
        const dx = Math.max(2, Math.round((right - left) / 4))
        const dy = Math.max(2, Math.round((bottom - top) / 4))
        const candidates: Array<[number, number]> = [
          [cx, cy],
          [Math.round(left + dx), Math.round(top + dy)],
          [Math.round(right - dx), Math.round(top + dy)],
          [Math.round(left + dx), Math.round(bottom - dy)],
          [Math.round(right - dx), Math.round(bottom - dy)],
          [Math.round(left + dx), cy],
          [Math.round(right - dx), cy],
          [cx, Math.round(top + dy)],
          [cx, Math.round(bottom - dy)],
        ]

        for (const [x, y] of candidates) {
          const hit = document.elementFromPoint(x, y)
          if (!hit) continue
          if (isDocumentShell(hit)) continue
          if (hit === el || el.contains(hit) || (hit.contains(el) && isInteractiveHit(hit))) {
            return { x, y }
          }
        }
        return null
      }

      // Resolve a human-readable label for an input/select/textarea so the agent
      // sees "Email Address" instead of just "input[name=email]". Order:
      //   1. <label for="id">  2. wrapping <label>  3. aria-labelledby
      //   4. aria-label  5. nearest preceding sibling text  6. parent's own text
      //   7. placeholder  8. name
      function resolveLabel(el: Element): string {
        const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)
        const id = el.getAttribute('id') || ''
        if (id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`)
            const txt = lbl?.textContent
            if (txt && txt.trim()) return clean(txt)
          } catch { /* invalid id */ }
        }
        const wrap = el.closest('label')
        if (wrap) {
          const clone = wrap.cloneNode(true) as HTMLElement
          clone.querySelectorAll('input, select, textarea, button').forEach(n => n.remove())
          const txt = clone.textContent
          if (txt && txt.trim()) return clean(txt)
        }
        const labelledBy = el.getAttribute('aria-labelledby')
        if (labelledBy) {
          const parts: string[] = []
          for (const lid of labelledBy.split(/\s+/).filter(Boolean)) {
            const target = document.getElementById(lid)
            const t = target?.textContent?.trim()
            if (t) parts.push(t)
          }
          if (parts.length) return clean(parts.join(' '))
        }
        const aria = el.getAttribute('aria-label')
        if (aria && aria.trim()) return clean(aria)

        // Walk preceding siblings looking for label-like text
        let prevSib: Element | null = el.previousElementSibling
        let hops = 0
        while (prevSib && hops < 3) {
          const txt = prevSib.textContent?.trim() || ''
          if (txt && txt.length < 80 && /[a-zA-Z]/.test(txt)) return clean(txt)
          prevSib = prevSib.previousElementSibling
          hops++
        }
        // Parent's text minus this element's own text (e.g. <div>Email<input/></div>)
        const parent = el.parentElement
        if (parent) {
          const parentText = parent.textContent || ''
          const elText = el.textContent || ''
          const labelOnly = parentText.replace(elText, '').trim()
          if (labelOnly && labelOnly.length < 80 && /[a-zA-Z]/.test(labelOnly)) return clean(labelOnly)
        }
        const ph = el.getAttribute('placeholder')
        if (ph && ph.trim()) return clean(ph)
        const nm = el.getAttribute('name')
        if (nm) return nm
        return ''
      }

      function resolveChoiceGroupLabel(el: Element): string {
        const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80)
        const labelledText = (node: Element | null): string => {
          if (!node) return ''
          const labelledBy = node.getAttribute('aria-labelledby')
          if (labelledBy) {
            const parts: string[] = []
            for (const lid of labelledBy.split(/\s+/).filter(Boolean)) {
              const target = document.getElementById(lid)
              const t = target?.textContent?.trim()
              if (t) parts.push(t)
            }
            if (parts.length) return clean(parts.join(' '))
          }
          const aria = node.getAttribute('aria-label')
          if (aria && aria.trim()) return clean(aria)
          return ''
        }

        const group = el.closest('fieldset, [role="radiogroup"], [role="group"], [aria-labelledby], [aria-label]')
        const fromLabel = labelledText(group)
        if (fromLabel) return fromLabel
        const legend = group?.querySelector('legend')
        const legendText = legend?.textContent?.trim()
        if (legendText) return clean(legendText)

        const section = el.closest('section, article, form, [class*="section"], [class*="Section"], [class*="group"], [class*="Group"]')
        const heading = section?.querySelector('h1, h2, h3, h4, [role="heading"], [class*="title"], [class*="Title"], [class*="headline"], [class*="Headline"]')
        const headingText = heading?.textContent?.trim()
        if (headingText && headingText.length < 140) return clean(headingText)

        let prev = el.parentElement?.previousElementSibling || null
        let hops = 0
        while (prev && hops < 4) {
          const text = prev.textContent?.trim() || ''
          if (text && text.length < 140 && /(?:color|colour|finish|storage|capacity|size|model|choose|select|pick)/i.test(text)) {
            return clean(text)
          }
          prev = prev.previousElementSibling
          hops++
        }
        return ''
      }

      // Detect an open modal/dialog. When found, we restrict the elements scan
      // to its descendants so the agent isn't distracted by background page
      // controls it can't reach until the modal is dismissed.
      function findOpenModal(): Element | null {
        const candidates = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')
        for (const d of candidates) {
          if (!isVisible(d)) continue
          const r = d.getBoundingClientRect()
          if (r.width > 200 && r.height > 100) return d
        }
        // Heuristic fallback: large fixed/absolute element with high z-index, centered
        const all = document.querySelectorAll('div, section, aside')
        for (const el of all) {
          const style = window.getComputedStyle(el)
          if (style.position !== 'fixed' && style.position !== 'absolute') continue
          const z = parseInt(style.zIndex || '0', 10)
          if (z < 1000) continue
          const r = el.getBoundingClientRect()
          if (r.width < vw * 0.25 || r.height < vh * 0.25) continue
          if (r.width > vw * 0.97 && r.height > vh * 0.97) continue  // full-screen overlay, not a modal
          const cx = r.left + r.width / 2
          if (cx > vw * 0.15 && cx < vw * 0.85 && r.top >= 0 && r.bottom <= vh + 20) {
            return el
          }
        }
        return null
      }

      const modal = findOpenModal()
      const scope: ParentNode = modal || document
      let modalLabel = ''
      if (modal) {
        const ariaL = modal.getAttribute('aria-label')
        if (ariaL) modalLabel = ariaL.trim().slice(0, 60)
        else {
          const heading = modal.querySelector('h1, h2, h3, header, [class*="title"], [class*="Title"]')
          if (heading?.textContent) modalLabel = heading.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)
        }
      }

      const els = scope.querySelectorAll(
        'a[href], button, input, select, textarea, ' +
        '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], ' +
        '[role="textbox"], [role="searchbox"], [role="combobox"], [onclick], [tabindex], [contenteditable], ' +
        '[class*="btn"], [class*="button"], [class*="click"], [class*="toggle"], [class*="tab"], ' +
        'summary, details > summary, label[for], video, audio'
      )

      const cursorPointerEls: Element[] = []
      const misc = scope.querySelectorAll('div, span, li, td, th, img, svg')
      for (const el of misc) {
        if (cursorPointerEls.length > 30) break
        if (hasClickHandler(el) && isVisible(el)) cursorPointerEls.push(el)
      }

      // Build label↔input maps upfront so the scan can dedupe label/input
      // pairs that would otherwise show up TWICE in the indexed list (once
      // as the input, once as the label that targets it via for=). The
      // input is canonical: its #id selector works for both clicks and
      // browser_type, and resolveLabel() already folds in the label's text.
      const inputToLabel = new Map<Element, Element>()
      const labelToInput = new Map<Element, Element>()
      // Pattern 1: <label for="X"> ... <input id="X">
      for (const lbl of scope.querySelectorAll('label[for]')) {
        const targetId = lbl.getAttribute('for')
        if (!targetId) continue
        let target: Element | null = null
        try { target = scope.querySelector(`#${CSS.escape(targetId)}`) } catch { /* invalid id */ }
        if (target && !inputToLabel.has(target)) {
          inputToLabel.set(target, lbl)
          labelToInput.set(lbl, target)
        }
      }
      // Pattern 2: <label><input>...</label> wrapping pattern (no for= needed)
      for (const lbl of scope.querySelectorAll('label')) {
        if (labelToInput.has(lbl)) continue
        const child = lbl.querySelector('input, select, textarea')
        if (child && !inputToLabel.has(child)) {
          inputToLabel.set(child, lbl)
          labelToInput.set(lbl, child)
        }
      }

      const combined = new Set<Element>([...els, ...cursorPointerEls])

      // Sort priority buttons (Next / Continue / Submit / etc.) to the FRONT of
      // the iteration order so they're guaranteed to survive the element cap on
      // long pages. Without this, a 200-element quiz page can push the "Next"
      // button past the cap and the agent never sees it. Within each priority
      // class, DOM order is preserved (stable sort).
      const isPriorityButton = (el: Element): boolean => {
        const isBtn = el.tagName === 'BUTTON' ||
          (el.tagName === 'INPUT' && (el.getAttribute('type') === 'submit' || el.getAttribute('type') === 'button'))
        if (!isBtn) return false
        const text = (el.textContent || (el as HTMLInputElement).value || '').trim().toLowerCase()
        return /^(next|continue|submit|finish|done|proceed|start|answer|go)\b/.test(text)
      }
      const combinedArr = Array.from(combined).sort((a, b) => {
        const aP = isPriorityButton(a) ? 0 : 1
        const bP = isPriorityButton(b) ? 0 : 1
        return aP - bP
      })

      type Bucket = 'form' | 'primary' | 'nav' | 'other'
      type Item = {
        desc: string
        primary: string
        bucket: Bucket
        formKey: string
        x: number
        y: number
        tag: string
        label: string
        groupLabel: string
        visualLabel: string
        options: string[]
        role: string
        state?: IndexedElement['state']
        fingerprint: string
        rect: { left: number; top: number; width: number; height: number }
      }
      const collected: Item[] = []
      const allPrimarySelectors: string[] = []
      const allFingerprints: string[] = []
      const seen = new Set<string>()
      let offscreenCount = 0
      let occludedCount = 0
      let newCount = 0
      let stateChangedCount = 0

      for (const el of combinedArr) {
        if (collected.length >= 120) break
        // Skip our own set-of-marks overlay so it can never appear in the elements list
        if (el.closest('#__agent_som_overlay__')) continue
        // Skip labels that have a paired input — the input will represent both.
        // This prevents the same logical control from getting two indices (e.g.
        // a radio button shown once as the label and once as the bare input).
        // If the paired input is visually hidden, keep the label: many product
        // configurators render visible option cards as labels around hidden radios.
        const pairedLabelInput = el.tagName === 'LABEL' ? labelToInput.get(el) : null
        if (pairedLabelInput && isVisible(pairedLabelInput)) continue
        if (!isVisible(el)) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0 && (r.bottom <= 0 || r.top >= vh)) {
            offscreenCount++
          }
          continue
        }

        const rect = el.getBoundingClientRect()

        // Find a click point that ACTUALLY hits this element. If every candidate
        // is occluded by an overlay/header/modal, skip it — emitting @(x,y) would
        // just cause the agent to click the overlay and waste an iteration.
        const point = safeClickPoint(el, rect)
        if (!point) {
          occludedCount++
          continue
        }

        // Clamp the rect to the visible viewport for set-of-marks overlay rendering.
        // We need this so the [N] label box draws inside the screenshot, not off-screen.
        const clampedLeft = Math.max(0, rect.left)
        const clampedTop = Math.max(0, rect.top)
        const clampedRight = Math.min(vw, rect.right)
        const clampedBottom = Math.min(vh, rect.bottom)
        const clampedRect = {
          left: Math.round(clampedLeft),
          top: Math.round(clampedTop),
          width: Math.round(clampedRight - clampedLeft),
          height: Math.round(clampedBottom - clampedTop),
        }

        const tag = el.tagName.toLowerCase()
        const pairedType = pairedLabelInput?.getAttribute('type') || ''
        const type = el.getAttribute('type') || pairedType
        const id = el.getAttribute('id') || ''
        const name = el.getAttribute('name') || ''
        const placeholder = el.getAttribute('placeholder') || ''
        const ariaLabel = el.getAttribute('aria-label') || ''
        const title = el.getAttribute('title') || ''
        const role = el.getAttribute('role') || ''
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)
        const href = tag === 'a' ? (el as HTMLAnchorElement).href : ''
        const hrefAttr = tag === 'a' ? (el.getAttribute('href') || '') : ''
        const value = (el as HTMLInputElement).value || ''
        const dropdownOptions = tag === 'select'
          ? Array.from((el as HTMLSelectElement).options)
            .map(option => {
              const optionText = (option.label || option.textContent || option.value || '').trim().replace(/\s+/g, ' ')
              const optionValue = option.value || ''
              const disabled = option.disabled || ((option.parentElement instanceof HTMLOptGroupElement) && option.parentElement.disabled)
              const label = optionText || optionValue
              if (!label) return ''
              return `${label}${optionValue && optionValue !== label ? `=${optionValue}` : ''}${disabled ? ' [disabled]' : ''}`
            })
            .filter(Boolean)
            .slice(0, 12)
          : []
        const mediaText = mediaLabel(el)
        const dataText = readableDataLabel(el)
        const className = typeof (el as HTMLElement).className === 'string'
          ? (el as HTMLElement).className
          : ''

        const selectors: string[] = []
        if (id) selectors.push(`#${CSS.escape(id)}`)
        if (ariaLabel) selectors.push(`[aria-label="${escapeAttr(ariaLabel)}"]`)
        if (name) selectors.push(`${tag}[name="${escapeAttr(name)}"]`)
        if (placeholder) selectors.push(`${tag}[placeholder="${escapeAttr(placeholder)}"]`)
        if (title) selectors.push(`[title="${escapeAttr(title)}"]`)
        if (value && tag === 'input') selectors.push(`${tag}[value="${escapeAttr(value)}"]`)
        for (const attrName of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'data-action']) {
          const attrValue = el.getAttribute(attrName)
          if (attrValue) selectors.push(`${tag}[${attrName}="${escapeAttr(attrValue)}"]`)
        }
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') && attr.value && selectors.length < 4) {
            const ds = `${tag}[${attr.name}="${escapeAttr(attr.value)}"]`
            if (!selectors.includes(ds)) selectors.push(ds)
          }
        }
        if (tag === 'a' && href) {
          if (hrefAttr) selectors.push(`a[href="${escapeAttr(hrefAttr)}"]`)
          try {
            const pathOnly = new URL(href).pathname
            const pathSelector = `a[href="${escapeAttr(pathOnly)}"]`
            if (!selectors.includes(pathSelector)) selectors.push(pathSelector)
          } catch { /* */ }
        }
        if (text && text.length <= 40) selectors.push(`text=${text}`)

        if (selectors.length === 0) continue
        const primary = selectors[0]
        // Dedupe by selector + 100px position bucket — same selector at very
        // different positions (e.g. duplicated logo link) gets distinct entries,
        // but near-identical neighbors collapse to one.
        const dedupeKey = `${primary}@${Math.round(point.x / 100)},${Math.round(point.y / 100)}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        allPrimarySelectors.push(primary)

        const isNew = hadPrevious && !prevSet.has(primary)
        if (isNew) newCount++
        const isJustClicked = !!clicked && primary === clicked

        // Categorize: anything inside <form> is a form item, links inside nav/header
        // are nav, buttons/role=button outside forms are primaries, rest is "other".
        const formAncestor = el.closest('form')
        const navAncestor = el.closest('nav, header, [role="navigation"]')
        let bucket: Bucket
        let formKey = ''
        if (formAncestor) {
          bucket = 'form'
          const fid = formAncestor.getAttribute('id') || ''
          const fname = formAncestor.getAttribute('name') || ''
          const faction = formAncestor.getAttribute('action') || ''
          const faria = formAncestor.getAttribute('aria-label') || ''
          formKey = faria || fid || fname || faction || 'form'
        } else if (navAncestor && (tag === 'a' || tag === 'button')) {
          bucket = 'nav'
        } else if (tag === 'button' || role === 'button' || (tag === 'input' && (type === 'submit' || type === 'button'))) {
          bucket = 'primary'
        } else {
          bucket = 'other'
        }

        // For inputs, prefer the resolved label over (often empty) text content.
        const isInputLike = ['input', 'select', 'textarea'].includes(tag)
        const labelText = pairedLabelInput
          ? (text || resolveLabel(pairedLabelInput) || ariaLabel || title || mediaText || dataText || value)
          : isInputLike
          ? (resolveLabel(el) || ariaLabel || title || placeholder || dataText || ((type === 'submit' || type === 'button' || type === 'reset') ? value : ''))
          : (ariaLabel || text || title || mediaText || dataText || value)

        // Derive a single semantic role token (radio/checkbox/text-input/button/...)
        // so the agent sees what each element IS without parsing tag+type+role.
        // The role is what the system prompt uses for its action-matching table.
        const semanticRole = (() => {
          if (pairedLabelInput && pairedType === 'checkbox') return 'checkbox'
          if (pairedLabelInput && pairedType === 'radio') return 'radio'
          if (tag === 'a') return 'link'
          if (tag === 'button' || role === 'button') return 'button'
          if (tag === 'select') return 'dropdown'
          if (tag === 'textarea') return 'textarea'
          if (tag === 'input') {
            if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
            if (type === 'checkbox') return 'checkbox'
            if (type === 'radio') return 'radio'
            if (type === 'file') return 'file-upload'
            if (['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week', ''].includes(type)) return 'text-input'
            return type ? `${type}-input` : 'input'
          }
          if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only' || el.getAttribute('contenteditable') === '') return 'contenteditable'
          if (tag === 'label') return 'label'
          if (role === 'textbox' || role === 'searchbox') return 'text-input'
          if (role === 'combobox') return 'combobox-input'
          if (role === 'checkbox') return 'checkbox'
          if (role === 'radio') return 'radio'
          if (role === 'tab') return 'tab'
          if (role === 'menuitem') return 'menuitem'
          if (role === 'switch') return 'switch'
          if (role === 'option') return 'option'
          if (role === 'slider') return 'slider'
          if (role === 'link') return 'link'
          return tag
        })()

        const groupLabel = resolveChoiceGroupLabel(el)
        const optionContext = /\b(color|colour|finish|swatch|storage|capacity|size|model|variant|option|choice|choose|select|pick)\b/i.test(`${className} ${ariaLabel} ${title} ${groupLabel}`)
        const looksLikeVisualOption =
          ['radio', 'checkbox', 'option', 'label'].includes(semanticRole) ||
          (semanticRole === 'button' && optionContext)
        const visualLabel = looksLikeVisualOption ? visualOptionLabel(el) : ''
        const fullLabelText = [groupLabel, labelText, visualLabel]
          .filter(Boolean)
          .reduce((parts: string[], part) => {
            const normalizedPart = part.toLowerCase()
            if (!parts.some(existing => existing.toLowerCase().includes(normalizedPart) || normalizedPart.includes(existing.toLowerCase()))) {
              parts.push(part)
            }
            return parts
          }, [])
          .join(' — ')
          .slice(0, 160)

        // Detect current control state. Product configurators often expose
        // option cards as role=button/divs with aria/class state instead of
        // native radio inputs, so include common ARIA and class signals.
        const nativeChecked = ((el instanceof HTMLInputElement) && el.checked === true) ||
          ((pairedLabelInput instanceof HTMLInputElement) && pairedLabelInput.checked === true)
        const nativeSelected = (el instanceof HTMLOptionElement) && el.selected === true
        const ariaChecked = el.getAttribute('aria-checked') === 'true' ||
          pairedLabelInput?.getAttribute('aria-checked') === 'true'
        const ariaSelected = el.getAttribute('aria-selected') === 'true'
        const ariaPressed = el.getAttribute('aria-pressed') === 'true'
        const ariaCurrent = !!el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false'
        const selectedByClass = /\b(is-)?(selected|active|checked|current)\b/i.test(className) &&
          !/\b(unselected|not-selected|inactive)\b/i.test(className)
        const nestedSelected = !!el.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [aria-pressed="true"]')
        const nativeDisabled =
          ((el instanceof HTMLButtonElement ||
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLOptionElement ||
            el instanceof HTMLOptGroupElement) && el.disabled === true) ||
          el.hasAttribute('disabled') ||
          ((pairedLabelInput instanceof HTMLInputElement) && pairedLabelInput.disabled === true) ||
          !!pairedLabelInput?.hasAttribute('disabled')
        const ariaDisabled = el.getAttribute('aria-disabled') === 'true' ||
          pairedLabelInput?.getAttribute('aria-disabled') === 'true'
        const unavailableByText = /\b(sold out|out of stock|unavailable|currently unavailable)\b/i.test(`${text} ${ariaLabel} ${title}`)
        const disabledByClass = /\b(disabled|unavailable|sold-out|soldout|is-disabled)\b/i.test(className) &&
          !/\bnot-disabled\b/i.test(className)
        const controlState: IndexedElement['state'] = {
          checked: nativeChecked || ariaChecked,
          selected: nativeSelected || ariaSelected || selectedByClass || nestedSelected,
          pressed: ariaPressed,
          current: ariaCurrent,
          disabled: nativeDisabled || ariaDisabled || disabledByClass,
          unavailable: unavailableByText || (ariaDisabled && unavailableByText),
        }

        const markers: string[] = []
        if (controlState.disabled) markers.push(controlState.unavailable ? '[UNAVAILABLE]' : '[DISABLED]')
        if (semanticRole === 'radio' && controlState.checked) markers.push('[SELECTED]')
        else if (semanticRole === 'checkbox' && controlState.checked) markers.push('[CHECKED]')
        else if (semanticRole === 'switch' && controlState.checked) markers.push('[ON]')
        else if ((semanticRole === 'option' || semanticRole === 'tab') && controlState.selected) markers.push('[SELECTED]')
        else if (controlState.pressed) markers.push('[PRESSED]')
        else if (controlState.selected) markers.push('[SELECTED]')
        if (controlState.current) markers.push('[CURRENT]')
        const stateMarker = markers.length > 0 ? ` ${markers.join(' ')}` : ''
        const fingerprint = `${primary}|${semanticRole}|${fullLabelText}|${stateMarker}|${controlState.disabled ? 'disabled' : ''}|${controlState.unavailable ? 'unavailable' : ''}`
        allFingerprints.push(fingerprint)
        if (prevFingerprintSet.size > 0 && prevSet.has(primary) && !prevFingerprintSet.has(fingerprint)) stateChangedCount++

        const pos = `@(${point.x},${point.y})`
        let desc = `${pos} ${semanticRole}`
        desc += ` → ${selectors.slice(0, 2).join(' | ')}`
        if (fullLabelText && !primary.startsWith(`text=${fullLabelText}`)) {
          desc += ` "${fullLabelText.slice(0, 80)}"`
        }
        if (stateMarker) desc += stateMarker
        if (value && (semanticRole === 'text-input' || semanticRole === 'textarea')) {
          desc += ` (value: "${value.slice(0, 20)}")`
        }
        if (semanticRole === 'dropdown' && dropdownOptions.length > 0) {
          desc += ` (options: ${dropdownOptions.slice(0, 8).join(', ')}${dropdownOptions.length > 8 ? ', …' : ''})`
        }
        if (isNew) desc += ' [NEW]'
        if (isJustClicked) desc += ' [JUST CLICKED]'

        collected.push({ desc, primary, bucket, formKey, x: point.x, y: point.y, tag, label: fullLabelText || labelText, groupLabel, visualLabel, options: dropdownOptions, role: semanticRole, state: controlState, fingerprint, rect: clampedRect })
      }

      // Bucket items into their categories. Within each bucket, DOM order is
      // preserved because we iterate `combined` in DOM order.
      const formGroups = new Map<string, Item[]>()
      const primaries: Item[] = []
      const navs: Item[] = []
      const others: Item[] = []
      for (const item of collected) {
        if (item.bucket === 'form') {
          const arr = formGroups.get(item.formKey) || []
          arr.push(item)
          formGroups.set(item.formKey, arr)
        } else if (item.bucket === 'primary') {
          primaries.push(item)
        } else if (item.bucket === 'nav') {
          navs.push(item)
        } else {
          others.push(item)
        }
      }

      // Count removed elements: in previous snapshot but not in current list
      let removedCount = 0
      if (hadPrevious) {
        const currentSet = new Set(allPrimarySelectors)
        for (const p of prevSet) if (!currentSet.has(p)) removedCount++
      }

      return {
        viewport: `${vw}x${vh}`,
        scroll: `${scrollY}/${scrollMax}px`,
        forms: Array.from(formGroups.entries()),
        primaries,
        navs,
        others,
        totalCount: collected.length,
        offscreen: offscreenCount,
        occluded: occludedCount,
        allSelectors: allPrimarySelectors,
        allFingerprints,
        newCount,
        stateChangedCount,
        removedCount,
        hadPrevious,
        modalOpen: !!modal,
        modalLabel,
      }
    }, { prev: prevSelectors, prevFingerprints, clicked: justClicked })

    // Update the session snapshot for next-call diffing
    if (session) {
      session.lastElementSelectors = new Set(data.allSelectors)
      session.lastElementFingerprints = new Set(data.allFingerprints)
    }

    // Walk items in OUTPUT order (forms first, then primaries, navs, others)
    // assigning sequential [N] indices. This gives the agent a Manus-style
    // indexed list — instead of copying @(x,y) coordinates, the agent calls
    // browser_click({ index: N }) and we look up the position from this map.
    const indexMap = new Map<number, IndexedElement>()
    let nextIdx = 0
    const indexItem = (item: {
      desc: string
      x: number
      y: number
      primary: string
      tag: string
      label: string
      groupLabel: string
      visualLabel: string
      options?: string[]
      role: string
      state?: IndexedElement['state']
      rect: { left: number; top: number; width: number; height: number }
    }): string => {
      nextIdx++
      indexMap.set(nextIdx, {
        x: item.x,
        y: item.y,
        primary: item.primary,
        tag: item.tag,
        label: item.label,
        groupLabel: item.groupLabel,
        visualLabel: item.visualLabel,
        options: item.options,
        role: item.role,
        state: item.state,
        rect: item.rect,
      })
      return `[${nextIdx}] ${item.desc}`
    }

    const formSections: Array<[string, string[]]> = data.forms.map(([key, items]) => [
      key,
      items.map(indexItem),
    ])
    const primaryLines = data.primaries.map(indexItem)
    const navLines = data.navs.map(indexItem)
    const otherLines = data.others.map(indexItem)

    // Stash the index map on the session so click/type/hover handlers can
    // resolve { index: N } → { x, y } without a second round-trip to the page.
    if (session) {
      session.lastElementIndex = indexMap
    }

    const focusedElement = await getFocusedElementSnapshot(page, Array.from(indexMap.entries())).catch(() => null)

    // Build the page-state line — gives the agent a HARD signal whether its
    // last action accomplished anything. "UNCHANGED" is the strongest "your
    // last click was a no-op, try something different" signal we can produce.
    let stateLine = ''
    if (data.hadPrevious) {
      if (data.newCount === 0 && data.removedCount === 0 && data.stateChangedCount === 0) {
        stateLine = '\n⚠ Page UNCHANGED since last action — your last action did NOTHING. Try a different element, scroll, or navigate.'
      } else {
        const parts: string[] = []
        if (data.newCount > 0) parts.push(`${data.newCount} NEW`)
        if (data.stateChangedCount > 0) parts.push(`${data.stateChangedCount} state change${data.stateChangedCount === 1 ? '' : 's'}`)
        if (data.removedCount > 0) parts.push(`${data.removedCount} removed`)
        stateLine = `\n✓ Page changed: ${parts.join(', ')} elements`
      }
    }

    const pageSummary = classifyPageType(data)
    let output = `${stateLine}\nPage: ${pageSummary} | viewport ${data.viewport}, scroll ${data.scroll}`

    if (focusedElement) {
      const target = focusedElement.index ? `[${focusedElement.index}] ` : ''
      const label = focusedElement.label ? ` "${focusedElement.label.slice(0, 80)}"` : ''
      const readiness = focusedElement.typeable
        ? ' — focused and ready for browser_type({ text: "..." })'
        : ' — focused but not typeable; click a text input before typing'
      output += `\nFocused element: ${target}${focusedElement.role}${label}${readiness}`
    }

    if (data.modalOpen) {
      output += `\n\n⚠ MODAL OPEN${data.modalLabel ? `: "${data.modalLabel}"` : ''} — only modal elements shown below. Interact with the modal (or dismiss it) before doing anything else.`
    }

    if (data.totalCount === 0) {
      output += '\nNo interactive elements visible in viewport. Try browser_scroll("down") to reveal more.'
      if (data.offscreen > 0) output += ` (${data.offscreen} elements exist off-screen)`
      if (data.occluded > 0) output += ` (${data.occluded} elements occluded by overlays — dismiss any modals first)`
      return commitOutput(output)
    }

    output += `\nInteractive elements (${data.totalCount} visible${data.newCount > 0 ? `, ${data.newCount} new` : ''}):`
    output += `\n(format: [N] @(x,y) role → selector "label"  — ALWAYS call browser_click_at({index: N}) / browser_type({index: N, text: "..."}) / browser_select({index: N, value: "..."}) when [N] exists. Coordinates are diagnostic only. [NEW]=appeared since last action, [JUST CLICKED]=your previous target)`

    if (formSections.length > 0) {
      output += '\n\nFORMS:'
      for (const [formKey, lines] of formSections) {
        const label = formKey === 'form' ? 'form' : `form "${formKey}"`
        output += `\n  ${label}:`
        for (const line of lines) output += `\n    ${line}`
      }
    }

    if (primaryLines.length > 0) {
      output += '\n\nPRIMARY ACTIONS (buttons):'
      for (const line of primaryLines) output += `\n  ${line}`
    }

    if (navLines.length > 0) {
      output += '\n\nNAVIGATION:'
      for (const line of navLines) output += `\n  ${line}`
    }

    if (otherLines.length > 0) {
      output += '\n\nLINKS & OTHER:'
      for (const line of otherLines) output += `\n  ${line}`
    }

    if (data.offscreen > 0) {
      output += `\n\n(+${data.offscreen} more elements off-screen — browser_scroll("down") to reveal)`
    }
    if (data.occluded > 0) {
      output += `\n(${data.occluded} elements hidden behind overlays/headers — try dismissing modals or scrolling)`
    }
    return commitOutput(output)
  } catch {
    return ''
  }
}

/** Auto-dismiss popups, cookie banners, overlays, and ad modals */
async function autoDismissPopups(page: Page): Promise<string[]> {
  const dismissed: string[] = []
  try {
    const results = await page.evaluate(() => {
      const found: string[] = []

      // Common dismiss button selectors
      const dismissSelectors = [
        // Cookie consent
        '[class*="cookie"] button[class*="accept"]',
        '[class*="cookie"] button[class*="agree"]',
        '[class*="cookie"] button[class*="close"]',
        '[class*="cookie"] button[class*="dismiss"]',
        '[class*="consent"] button[class*="accept"]',
        '[class*="consent"] button[class*="agree"]',
        '[id*="cookie"] button',
        '[id*="consent"] button',
        'button[id*="accept-cookie"]',
        'button[id*="acceptCookie"]',
        // GDPR
        '[class*="gdpr"] button[class*="accept"]',
        '[class*="gdpr"] button[class*="close"]',
        // Generic modals/overlays
        '[class*="modal"] [class*="close"]',
        '[class*="overlay"] [class*="close"]',
        '[class*="popup"] [class*="close"]',
        '[class*="dialog"] [class*="close"]',
        '[class*="banner"] [class*="close"]',
        '[class*="Banner"] [class*="close"]',
        // Close buttons (X icons)
        '[aria-label="Close"]',
        '[aria-label="close"]',
        '[aria-label="Dismiss"]',
        '[aria-label="dismiss"]',
        '[aria-label="Close dialog"]',
        'button[class*="close-button"]',
        'button[class*="closeButton"]',
        'button[class*="CloseButton"]',
        // Notification prompts
        '[class*="notification"] [class*="close"]',
        '[class*="notification"] [class*="dismiss"]',
        // Newsletter popups
        '[class*="newsletter"] [class*="close"]',
        '[class*="subscribe"] [class*="close"]',
        // YouTube specific
        'button.ytp-ad-skip-button',
        'button.ytp-ad-skip-button-modern',
        '[class*="ad-skip"]',
        '.ytp-ad-overlay-close-button',
        'tp-yt-paper-dialog #dismiss-button',
        'ytd-enforcement-message-view-model #dismiss-button',
      ]

      for (const sel of dismissSelectors) {
        const els = document.querySelectorAll(sel)
        for (const el of els) {
          const htmlEl = el as HTMLElement
          // Only click if visible
          const rect = htmlEl.getBoundingClientRect()
          const style = window.getComputedStyle(htmlEl)
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          ) {
            htmlEl.click()
            const label = htmlEl.textContent?.trim().slice(0, 30) || sel
            found.push(label)
          }
        }
      }

      // Remove fixed/sticky overlays that block interaction
      const allEls = document.querySelectorAll('*')
      for (const el of allEls) {
        const style = window.getComputedStyle(el)
        if (
          (style.position === 'fixed' || style.position === 'sticky') &&
          style.zIndex !== 'auto' &&
          parseInt(style.zIndex) > 999
        ) {
          const rect = el.getBoundingClientRect()
          // Large overlays covering most of the viewport
          if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5) {
            // Check if it's a cookie/consent/popup overlay
            const cls = (el.className || '').toString().toLowerCase()
            const id = (el.id || '').toLowerCase()
            const isPopup = /cookie|consent|gdpr|modal|overlay|popup|banner|dialog|subscribe|newsletter|notification|ad-|interstitial/.test(cls + ' ' + id)
            if (isPopup) {
              ;(el as HTMLElement).style.display = 'none'
              found.push(`hidden overlay: ${cls.slice(0, 30) || id.slice(0, 30)}`)
            }
          }
        }
      }

      return found
    })
    dismissed.push(...results)
  } catch {
    // Page might be navigating — ignore
  }
  return dismissed
}

/** Auto-prefix plain text selectors so Playwright doesn't parse them as CSS */
function normalizeSelector(selector: string): string {
  const s = selector.trim()
  // Already a Playwright selector engine prefix
  if (/^(text=|role=|css=|xpath=|id=|data-testid=|>>|\/\/)/.test(s)) return s
  // CSS selectors: #id, .class, tag[attr], tag.class, tag#id, *, :pseudo, [attr]
  // They never contain spaces without a combinator, and don't look like natural language
  if (/^[#.*:[]/.test(s)) return s
  // Single word (tag name like "button", "input", "div") or tag with qualifier (button.class, input[name])
  if (/^[a-z][a-z0-9]*([.#:[\s>+~]|$)/.test(s) && !/\s[a-z]/i.test(s.slice(1))) return s
  // Contains spaces + normal words = natural language text → wrap with text=
  return `text=${s}`
}

/** Try clicking with a specific locator using multiple strategies */
async function tryClickLocator(page: Page, locator: ReturnType<Page['locator']>): Promise<boolean> {
  // First check if element exists
  const count = await locator.count().catch(() => 0)
  if (count === 0) return false

  // Scroll into view
  try { await locator.first().scrollIntoViewIfNeeded({ timeout: 2000 }) } catch { /* ok */ }

  const strategies: Array<() => Promise<void>> = [
    () => locator.first().click({ timeout: 3000 }),
    () => locator.first().click({ force: true, timeout: 3000 }),
    async () => {
      const el = await locator.first().elementHandle({ timeout: 2000 })
      if (el) {
        await el.evaluate((e: HTMLElement) => {
          e.scrollIntoView({ block: 'center' })
          e.click()
        })
      } else throw new Error('no handle')
    },
    // Coordinate-based click on the element's center
    async () => {
      const box = await locator.first().boundingBox({ timeout: 2000 })
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      } else throw new Error('no bounding box')
    },
  ]

  for (const strategy of strategies) {
    try {
      await strategy()
      return true
    } catch { continue }
  }
  return false
}

export async function browserClick(
  conversationId: string,
  selector: string
): Promise<BrowserActionResult> {
  let session: BrowserSession | null = null
  try {
    session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length
    const norm = normalizeSelector(selector)

    // Wait briefly for dynamic content to load
    try {
      await session.page.locator(norm).first().waitFor({ state: 'attached', timeout: 5000 })
    } catch {
      // Element not found yet — scroll down and try again
      await session.page.evaluate(() => window.scrollBy(0, 500))
      await session.page.waitForTimeout(500)
    }

    // Build a list of alternative selectors to try, ordered by likelihood
    const alternativeSelectors: string[] = [norm]

    // If it's a CSS selector, also try partial text match from the element's text
    if (!norm.startsWith('text=') && !norm.startsWith('role=')) {
      // Try the original as-is, then try text= variations
      const textContent = await session.page.locator(norm).first().textContent({ timeout: 1000 }).catch(() => null)
      if (textContent) {
        const clean = textContent.trim().replace(/\s+/g, ' ').slice(0, 50)
        if (clean) alternativeSelectors.push(`text=${clean}`)
      }
    }

    // If selector contains data-*, try broader matches
    const dataAttrMatch = selector.match(/\[data-([^\]]+)\]/)
    if (dataAttrMatch) {
      // Try the data attribute on any element type
      alternativeSelectors.push(`[data-${dataAttrMatch[1]}]`)
    }

    // If it's a text= selector, also try case-insensitive and partial
    if (norm.startsWith('text=')) {
      const textVal = norm.slice(5).replace(/["\\]/g, '')  // Sanitize to prevent selector injection
      alternativeSelectors.push(`role=button[name="${textVal}"]`)
      alternativeSelectors.push(`role=link[name="${textVal}"]`)
      // Escape single quotes for XPath string literals
      const xpathSafe = textVal.slice(0, 30).replace(/'/g, "\\'")
      alternativeSelectors.push(`xpath=//*[contains(text(), '${xpathSafe}')]`)
    }

    // If it's an #id selector, try the id as data-id or aria attribute too
    if (norm.startsWith('#')) {
      const idVal = norm.slice(1).replace(/["\\]/g, '')  // Sanitize to prevent selector injection
      alternativeSelectors.push(`[data-id="${idVal}"]`)
      alternativeSelectors.push(`[aria-label="${idVal}"]`)
    }

    // Try each alternative selector
    let clicked = false
    let usedSelector = norm
    let clickedLocator: ReturnType<typeof session.page.locator> | null = null
    for (const sel of alternativeSelectors) {
      try {
        const locator = session.page.locator(sel)
        if (await tryClickLocator(session.page, locator)) {
          clicked = true
          usedSelector = sel
          clickedLocator = locator
          break
        }
      } catch { continue }
    }

    // No silent text-walker fallback — it matched hidden/nested text and clicked the
    // wrong element while reporting success. Real recovery happens in the LLM with the
    // fresh elements list returned in the error below.

    if (!clicked) {
      // Return helpful error with what IS on the page
      const interactiveElements = await getInteractiveElements(session)
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: `Could not find element matching "${selector}". Do NOT guess selectors or raw coordinates — use browser_click_at({index: N}) from the fresh interactive elements list below.`,
        content: interactiveElements || undefined,
        action: `Failed to click: ${selector}`,
      }
    }

    // Wait for navigation or rendering to settle before capturing the visual frame.
    await settlePageAfterBrowserAction(session)

    // Record what was clicked so the next elements list marks it [JUST CLICKED]
    session.lastClickedSelector = usedSelector

    // Capture hit info — what element actually received the click. The bounding box
    // is from BEFORE the page settled, so we use it as a probe into the new page state.
    let hitInfo = ''
    if (clickedLocator) {
      try {
        const box = await clickedLocator.first().boundingBox({ timeout: 500 }).catch(() => null)
        if (box) {
          const cx = Math.round(box.x + box.width / 2)
          const cy = Math.round(box.y + box.height / 2)
          const hit = await session.page.evaluate(({ x, y }: { x: number; y: number }) => {
            const el = document.elementFromPoint(x, y)
            if (!el) return 'nothing (empty space)'
            const tag = el.tagName.toLowerCase()
            const text = (el.textContent || '').trim().slice(0, 50)
            const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : ''
            return `${tag}${id}${text ? ` "${text}"` : ''}`
          }, { x: cx, y: cy }).catch(() => '')
          if (hit) hitInfo = `Hit @(${cx},${cy}): ${hit}\n`
        }
      } catch { /* hit-info is best-effort */ }
    }

    // Auto-dismiss any popups that appeared after clicking
    const dismissed = await autoDismissPopups(session.page)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements, visibleValidationErrors } = await captureFrame(session)
    const dismissedNote = dismissed.length > 0 ? `[Auto-dismissed: ${dismissed.join(', ')}]\n\n` : ''
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)
    const content = (hitInfo + dismissedNote + downloadNote + (interactiveElements || '')).trim() || undefined

    if (visibleValidationErrors.length > 0 && isValidationTriggerLabel(`${selector} ${hitInfo}`)) {
      return {
        success: false,
        recoverable: true,
        url: session.page.url(),
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: visibleValidationBlockError(visibleValidationErrors),
        content: prependVisibleValidationErrors(content, visibleValidationErrors),
        action: `Click exposed visible validation errors: ${selector}`,
      }
    }

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content,
      action: `Clicked: ${selector}${usedSelector !== norm ? ` (via ${usedSelector})` : ''}`,
    }
  } catch (err) {
    return browserActionFailureWithFreshFrame(session, err, `Failed to click: ${selector}`)
  }
}

export async function browserClickAt(
  conversationId: string,
  x?: number,
  y?: number,
  index?: number
): Promise<BrowserActionResult> {
  let session: BrowserSession | null = null
  try {
    session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length
    if (index === undefined) {
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: 'browser_click_at requires {index: N} from the latest interactive elements list. Raw coordinate clicks are disabled; refresh/reveal controls before clicking.',
        action: 'Failed click — missing index',
      }
    }

    // Resolve {index: N} → coordinates from the most recent elements list.
    // Indices are the Manus-style preferred form: agent doesn't have to copy
    // coordinates, the runtime translates from the index map populated by
    // the last getInteractiveElements call.
    let elementPrimary = ''
    let elementLabel = ''
    let clickNote = ''
    const el = await resolveIndexedElementWithRefresh(session, index)
    if (!el) {
      return staleIndexFailure(session, index, `Failed click — stale index ${index}`)
    }
    if (el.state?.disabled || el.state?.unavailable) {
      return disabledIndexedElementFailure(session, index, el)
    }
    if (el.state?.selected && isSelectionLikeElement(el)) {
      return alreadySelectedIndexedElementResult(session, index, el)
    }
    x = el.x
    y = el.y
    elementPrimary = el.primary
    elementLabel = el.label || el.primary

    if (typeof x !== 'number' || typeof y !== 'number') {
      return {
        success: false,
        url: session.page.url(),
        title: '',
        error: `browser_click_at could not resolve a live click point for index [${index}]. Refresh the elements list and choose a visible [N].`,
        action: 'Failed click — missing args',
      }
    }

    const viewport = await session.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    })).catch(() => ({ width: 0, height: 0 }))
    if (viewport.width > 0 && viewport.height > 0 && (x < 0 || y < 0 || x > viewport.width || y > viewport.height)) {
      return coordinateMissFailure(
        session,
        x,
        y,
        `outside the viewport (${viewport.width}x${viewport.height})`,
      )
    }

    // Click strategy: when we have a real selector from {index: N}, use
    // Playwright's locator.click() which auto-waits, scrolls into view, and
    // fires proper click events through the framework's event system. Raw
    // mouse.click(x, y) misses JS click handlers on many SPAs (Woolworths,
    // Shopify, etc.) because the click coords land on the right pixel but
    // the framework's synthetic event system never sees the gesture.
    //
    // If locator.click throws, preflight the indexed point before falling back
    // to mouse.click so stale coordinates are blocked before execution.
    let clickPath: 'locator' | 'mouse' = 'mouse'
    let locatorErr: string | null = null
    if (elementPrimary) {
      try {
        const resolved = await locatorClosestToPoint(session.page, elementPrimary, x, y)
        const loc = resolved.locator
        if (resolved.matchCount > 1 && resolved.distance !== null) {
          clickNote += `Selector matched ${resolved.matchCount} elements; chose the match nearest the indexed click point (${resolved.distance}px away).\n`
        }
        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
        await loc.click({ timeout: 3000 })
        clickPath = 'locator'
      } catch (e) {
        locatorErr = e instanceof Error ? e.message.split('\n')[0] : String(e)
        // Fall through to mouse click
      }
    }
    if (clickPath === 'mouse') {
      // locator.click() may have scrolled the page before failing. The indexed
      // coordinates are viewport-relative, so refresh them before probing or
      // falling back to a raw mouse click. Otherwise we can falsely block a valid
      // target because the old point now hits <html>/<body>.
      const refreshed = await refreshIndexedClickPoint(session, index, el)
      if (refreshed) {
        if (refreshed.x !== x || refreshed.y !== y) {
          clickNote += `Refreshed click point for [${index}] after page movement: (${x}, ${y}) → (${refreshed.x}, ${refreshed.y}).\n`
        }
        x = refreshed.x
        y = refreshed.y
        elementPrimary = refreshed.primary
      }

      const preMouseProbe = await probeClickPoint(session.page, x, y)
      const preMouseHitInfo = preMouseProbe.empty
        ? (preMouseProbe.tag ? preMouseProbe.tag : 'nothing (empty space)')
        : `${preMouseProbe.tag}${preMouseProbe.id}${preMouseProbe.text ? ` "${preMouseProbe.text}"` : ''}`
      if (preMouseProbe.empty || preMouseProbe.tag === 'html' || preMouseProbe.tag === 'body' || !preMouseProbe.clickable) {
        return coordinateMissFailure(session, x, y, preMouseHitInfo)
      }
      // Human-like mouse movement to coordinates
      await humanMouseMove(session.page, x, y)
      await session.page.waitForTimeout(30 + Math.random() * 70)
      await session.page.mouse.click(x, y)
    }

    // Wait for any navigation or rendering before capturing the visual frame.
    await settlePageAfterBrowserAction(session)

    const dismissed = await autoDismissPopups(session.page)

    const title = await session.page.title()

    // Probe the click coordinates before captureFrame so we can stash the
    // just-clicked selector for the [JUST CLICKED] marker.
    const hitProbe = await probeClickPoint(session.page, x, y)

    const hitInfo = hitProbe.empty
      ? 'nothing (empty space)'
      : `${hitProbe.tag}${hitProbe.id}${hitProbe.text ? ` "${hitProbe.text}"` : ''}`

    // Set the just-clicked selector BEFORE captureFrame so the [JUST CLICKED]
    // marker fires when the page didn't change (most common signal that the
    // click was a no-op the agent should not repeat).
    if (hitProbe.primary) session.lastClickedSelector = hitProbe.primary

    // Now capture: getInteractiveElements (inside captureFrame) sees the fresh
    // lastClickedSelector, marks [JUST CLICKED], paints the SoM overlay, then
    // takes the screenshot.
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements, visibleValidationErrors } = await captureFrame(session)
    const dismissedNote = dismissed.length > 0 ? `[Auto-dismissed: ${dismissed.join(', ')}]\n` : ''
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)

    // If the click landed on the page background (no element, html, or body),
    // it was a no-op. Treat as failure so the LLM gets a real error and can
    // refresh/reveal a live indexed control instead of repeating the same click.
    const isEmptyHit = clickPath === 'mouse' && (hitProbe.empty || hitProbe.tag === 'html' || hitProbe.tag === 'body')
    if (isEmptyHit) {
      return coordinateMissFailure(session, x, y, hitInfo)
    }

    const pathNote = clickPath === 'locator'
      ? `${clickNote}Clicked via Playwright locator on ${elementPrimary} — hit: ${hitInfo}`
      : locatorErr
      ? `${clickNote}Clicked at (${x}, ${y}) via mouse fallback (locator failed: ${locatorErr}) — hit: ${hitInfo}`
      : `${clickNote}Clicked at (${x}, ${y}) — hit: ${hitInfo}`

    if (visibleValidationErrors.length > 0 && isValidationTriggerLabel(`${elementLabel} ${hitInfo}`)) {
      return {
        success: false,
        recoverable: true,
        url: session.page.url(),
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: visibleValidationBlockError(visibleValidationErrors),
        content: prependVisibleValidationErrors(`${dismissedNote}${downloadNote}${pathNote}\n${interactiveElements}`.trim(), visibleValidationErrors),
        action: `Click exposed visible validation errors at [${index}]`,
      }
    }

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `${dismissedNote}${downloadNote}${pathNote}\n${interactiveElements}`.trim(),
      action: clickPath === 'locator' ? `Clicked element [${index}]` : `Clicked at (${x}, ${y})`,
    }
  } catch (err) {
    const where = index !== undefined ? `index ${index}` : `(${x ?? '?'}, ${y ?? '?'})`
    return browserActionFailureWithFreshFrame(session, err, `Failed to click at ${where}`)
  }
}

export async function browserScroll(
  conversationId: string,
  direction: 'up' | 'down',
  amount?: number
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const pixels = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 500
    const delta = direction === 'down' ? pixels : -pixels

    await session.page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), delta)
    await settlePageAfterBrowserAction(session, POST_BROWSER_SCROLL_SETTLE_MS)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const scrollPos = await session.page.evaluate(() => ({
      y: Math.round(window.scrollY),
      max: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    }))

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `Scroll position: ${scrollPos.y}px / ${scrollPos.max}px\n\n${interactiveElements || ''}`.trim(),
      action: `Scrolled ${direction} ${pixels}px`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: `Failed to scroll ${direction}`,
    }
  }
}

export function normalizeBrowserScrollArgs(args: Record<string, unknown>): { direction: 'up' | 'down'; amount?: number } {
  const rawDirection = args.direction ?? args.dir ?? args.scrollDirection ?? args.scroll ?? args.where
  const rawAmount = args.amount ?? args.pixels ?? args.distance ?? args.deltaY ?? args.delta
  let amount = typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount : undefined
  let direction: 'up' | 'down' | null = null

  if (typeof rawDirection === 'string') {
    const normalized = rawDirection.toLowerCase().trim().replace(/[_-]+/g, ' ')
    if (/\b(up|top|previous|prev|back|backward|higher)\b/.test(normalized)) direction = 'up'
    else if (/\b(down|bottom|next|forward|lower|page down|pagedown)\b/.test(normalized)) direction = 'down'
  } else if (typeof rawDirection === 'number' && Number.isFinite(rawDirection)) {
    amount = Math.abs(rawDirection)
    direction = rawDirection < 0 ? 'up' : 'down'
  }

  if (!direction && typeof amount === 'number' && amount < 0) direction = 'up'
  if (typeof amount === 'number') amount = Math.abs(amount)

  return {
    direction: direction || 'down',
    amount,
  }
}

export async function browserHover(
  conversationId: string,
  selector: string | undefined,
  index?: number
): Promise<BrowserActionResult> {
  let session: BrowserSession | null = null
  try {
    session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length

    if (index !== undefined) {
      const el = await resolveIndexedElementWithRefresh(session, index)
      if (!el) {
        return staleIndexFailure(session, index, `Failed hover — stale index ${index}`)
      }
      selector = el.primary
    }

    if (!selector) {
      return {
        success: false,
        url: session.page.url(),
        title: '',
        error: 'browser_hover requires either {index: N} or {selector: "..."}',
        action: 'Failed hover — missing args',
      }
    }

    const locator = session.page.locator(normalizeSelector(selector))
    await locator.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await locator.first().hover({ timeout: 8000 })
    await settlePageAfterBrowserAction(session, 700)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `${downloadNote}${interactiveElements || ''}`.trim() || undefined,
      action: `Hovered: ${selector}`,
    }
  } catch (err) {
    return browserActionFailureWithFreshFrame(session, err, `Failed to hover: ${selector}`)
  }
}

export async function browserSelect(
  conversationId: string,
  selector: string | undefined,
  value: string,
  index?: number
): Promise<BrowserActionResult> {
  let session: BrowserSession | null = null
  try {
    session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length

    if (index !== undefined) {
      const el = await resolveIndexedElementWithRefresh(session, index)
      if (!el) {
        return staleIndexFailure(session, index, `Failed select — stale index ${index}`)
      }
      // Hard-reject browser_select against non-dropdown elements. Some models
      // confuse "select" with "click an option" — radios, buttons, links and
      // text inputs are NOT <select> elements and selectOption() will throw
      // a noisy Playwright error if we try.
      if (el.role && el.role !== 'dropdown') {
        const stale = await staleIndexFailure(session, index, `Failed select — wrong element type`)
        return {
          ...stale,
          error: `Element [${index}] is a ${el.role} ("${el.label || ''}"), NOT a dropdown. ${el.role === 'radio' || el.role === 'checkbox' || el.role === 'button' || el.role === 'link' ? `Use browser_click_at({index: ${index}}) — this is a ${el.role}, click it directly.` : el.role === 'text-input' || el.role === 'textarea' ? `Use browser_type({index: ${index}, text: "${value}"}) — this is a ${el.role}, type into it.` : `Find a dropdown (<select>) in the elements list below.`}`,
          action: `Rejected select — [${index}] is a ${el.role}`,
        }
      }
      selector = el.primary
    }

    if (!selector) {
      return {
        success: false,
        url: session.page.url(),
        title: '',
        error: 'browser_select requires either {index: N} or {selector: "..."}',
        action: 'Failed select — missing args',
      }
    }

    const locator = session.page.locator(normalizeSelector(selector)).first()
    const selected = await selectDropdownOption(locator, value)
    if (!selected.ok) {
      await settlePageAfterBrowserAction(session)
      const title = await session.page.title().catch(() => '')
      const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
      return {
        success: false,
        url: session.page.url(),
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: selected.error,
        content: interactiveElements || undefined,
        action: `Failed to select: ${value}`,
      }
    }
    await settlePageAfterBrowserAction(session)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `${downloadNote}${interactiveElements || ''}`.trim() || undefined,
      action: `Selected: ${selected.selected}`,
    }
  } catch (err) {
    return browserActionFailureWithFreshFrame(session, err, `Failed to select: ${value}`)
  }
}

export async function browserPressKey(
  conversationId: string,
  key: string
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length
    await session.page.keyboard.press(key)
    await settlePageAfterBrowserAction(session, 700)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `${downloadNote}${interactiveElements || ''}`.trim() || undefined,
      action: `Pressed key: ${key}`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: `Failed to press key: ${key}`,
    }
  }
}

export async function browserGoBack(
  conversationId: string
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    await session.page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' })

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: interactiveElements || undefined,
      action: `Went back to ${title}`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: 'Failed to go back',
    }
  }
}

/** Human-like mouse movement to a target coordinate */
async function humanMouseMove(page: Page, toX: number, toY: number) {
  const startX = toX - 40 - Math.random() * 80
  const startY = toY - 20 - Math.random() * 40
  await page.mouse.move(startX, startY)
  const steps = 10 + Math.floor(Math.random() * 8)
  for (let i = 1; i <= steps; i++) {
    const p = i / steps
    const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
    await page.mouse.move(
      startX + (toX - startX) * ease + (Math.random() * 2 - 1),
      startY + (toY - startY) * ease + (Math.random() * 1.5 - 0.75),
      { steps: 1 }
    )
    await page.waitForTimeout(8 + Math.random() * 12)
  }
}

export async function browserClickAndHold(
  conversationId: string,
  selector: string,
  duration: number = 3000
): Promise<BrowserActionResult> {
  try {
    const holdDuration = Math.max(100, Math.min(Number.isFinite(duration) ? duration : 3000, MAX_CLICK_HOLD_MS))
    const session = await getOrCreateSession(conversationId)
    const norm = normalizeSelector(selector)
    const locator = session.page.locator(norm)

    // Try to find the element with multiple approaches
    let box = await locator.first().boundingBox({ timeout: 5000 }).catch(() => null)

    if (!box) {
      // Scroll down and retry
      await session.page.evaluate(() => window.scrollBy(0, 300))
      await session.page.waitForTimeout(500)
      box = await locator.first().boundingBox({ timeout: 3000 }).catch(() => null)
    }

    if (!box) {
      // Try finding by text content via coordinate lookup
      const searchText = norm.startsWith('text=') ? norm.slice(5) : selector
      const coords = await session.page.evaluate((text: string) => {
        const allEls = document.querySelectorAll('button, [role="button"], [class*="hold"], [class*="verify"], [class*="captcha"]')
        for (const el of allEls) {
          const t = (el.textContent || '').trim().toLowerCase()
          if (t.includes(text.toLowerCase())) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
            }
          }
        }
        return null
      }, searchText)
      if (coords) box = { x: coords.x, y: coords.y, width: coords.w, height: coords.h }
    }

    if (!box) {
      const interactiveElements = await getInteractiveElements(session)
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: `Could not find element "${selector}" to click and hold. Try a different selector from the interactive elements list.`,
        content: interactiveElements || undefined,
        action: `Failed to click and hold: ${selector}`,
      }
    }

    const targetX = box.x + box.width / 2 + (Math.random() * 4 - 2)
    const targetY = box.y + box.height / 2 + (Math.random() * 4 - 2)

    // Human-like mouse movement to target
    await humanMouseMove(session.page, targetX, targetY)
    await session.page.waitForTimeout(50 + Math.random() * 100)

    // Press and hold with slight mouse micro-movements during hold (more human-like)
    await session.page.mouse.down()
    try {
      const holdEnd = Date.now() + holdDuration
      while (Date.now() < holdEnd) {
        // Tiny micro-movements while holding (humans can't hold perfectly still)
        await session.page.mouse.move(
          targetX + (Math.random() * 2 - 1),
          targetY + (Math.random() * 2 - 1),
          { steps: 1 }
        )
        await session.page.waitForTimeout(80 + Math.random() * 60)
      }
    } finally {
      await session.page.mouse.up().catch(() => {})
    }

    await settlePageAfterBrowserAction(session)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: interactiveElements || undefined,
      action: `Clicked and held: ${selector} for ${holdDuration}ms`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: `Failed to click and hold: ${selector}`,
    }
  }
}

export async function browserDrag(
  conversationId: string,
  fromSelector: string,
  toSelector: string
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const fromLoc = session.page.locator(normalizeSelector(fromSelector))
    const toLoc = session.page.locator(normalizeSelector(toSelector))

    await fromLoc.first().waitFor({ state: 'attached', timeout: 5000 })
    await toLoc.first().waitFor({ state: 'attached', timeout: 5000 })

    const fromBox = await fromLoc.first().boundingBox({ timeout: 3000 })
    const toBox = await toLoc.first().boundingBox({ timeout: 3000 })
    if (!fromBox || !toBox) throw new Error('Could not get bounding boxes for drag')

    const fromX = fromBox.x + fromBox.width / 2
    const fromY = fromBox.y + fromBox.height / 2
    const toX = toBox.x + toBox.width / 2
    const toY = toBox.y + toBox.height / 2

    // Human-like drag with intermediate points
    await session.page.mouse.move(fromX, fromY, { steps: 5 })
    await session.page.waitForTimeout(100)
    await session.page.mouse.down()
    await session.page.waitForTimeout(150)

    const dragSteps = 15 + Math.floor(Math.random() * 10)
    for (let i = 1; i <= dragSteps; i++) {
      const progress = i / dragSteps
      const ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
      const x = fromX + (toX - fromX) * ease + (Math.random() * 3 - 1.5)
      const y = fromY + (toY - fromY) * ease + (Math.random() * 3 - 1.5)
      await session.page.mouse.move(x, y, { steps: 1 })
      await session.page.waitForTimeout(15 + Math.random() * 15)
    }

    await session.page.mouse.move(toX, toY, { steps: 2 })
    await session.page.waitForTimeout(100)
    await session.page.mouse.up()
    await settlePageAfterBrowserAction(session)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: interactiveElements || undefined,
      action: `Dragged from "${fromSelector}" to "${toSelector}"`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: `Failed to drag: ${fromSelector} → ${toSelector}`,
    }
  }
}

export async function browserType(
  conversationId: string,
  selector: string | undefined,
  text: string,
  submit = false,
  index?: number
): Promise<BrowserActionResult> {
  let session: BrowserSession | null = null
  try {
    session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length

    // Resolve {index: N} → primary selector from the most recent elements list.
    // Hard-reject typing into non-typeable elements (radios, buttons, links, etc.)
    // — this prevents the "Typing 'reassuring' into a radio button" failure mode
    // where the model confuses an answer choice for a text input.
    let targetLabel = selector || ''
    if (index !== undefined) {
      const el = await resolveIndexedElementWithRefresh(session, index)
      if (!el) {
        return staleIndexFailure(session, index, `Failed type — stale index ${index}`)
      }
      if (el.role && !isBrowserTypeableRole(el.role)) {
        // Best-effort: include the live elements list so the model can immediately
        // re-pick a real text input on its next turn.
        const stale = await staleIndexFailure(session, index, `Failed type — wrong element type`)
        return {
          ...stale,
          error: `Element [${index}] is a ${el.role} ("${el.label || ''}"), NOT a text input. ${el.role === 'radio' || el.role === 'checkbox' ? `Use browser_click_at({index: ${index}}) to select it — radios and checkboxes are clicked, never typed into.` : el.role === 'button' || el.role === 'link' ? `Use browser_click_at({index: ${index}}) to click it.` : el.role === 'dropdown' ? `Use browser_select({index: ${index}, value: "..."}) to choose an option.` : `Find a text-input or textarea in the elements list below and try its [N] instead.`}`,
          action: `Rejected type — [${index}] is a ${el.role}`,
        }
      }
      selector = el.primary
      targetLabel = el.label || el.primary
    }

    let typeIntoFocusedElement = false
    if (!selector) {
      const focused = await getFocusedElementSnapshot(session.page, Array.from(session.lastElementIndex?.entries() || []))
      if (!focused?.typeable) {
        return {
          success: false,
          url: session.page.url(),
          title: '',
          error: focused
            ? `browser_type has no target and the focused element is a ${focused.role}${focused.label ? ` ("${focused.label}")` : ''}, not a ready text field. Click a live text-input/textarea/contenteditable [N] first, or pass browser_type({index:N,text:"..."}).`
            : 'browser_type has no target and no focused text field. Click a live text-input/textarea/contenteditable [N] first, or pass browser_type({index:N,text:"..."}).',
          action: 'Failed type — no focused text field',
        }
      }
      typeIntoFocusedElement = true
    }

    let typed = false

    if (typeIntoFocusedElement) {
      try {
        await session.page.keyboard.press('ControlOrMeta+A')
        await session.page.keyboard.type(text)
        typed = true
      } catch {
        typed = false
      }
    } else {
      const selectorForLocator = selector
      if (!selectorForLocator) throw new Error('No selector available for browser_type')
      const loc = session.page.locator(normalizeSelector(selectorForLocator))

      // Wait for element and scroll into view
      await loc.first().waitFor({ state: 'attached', timeout: 8000 })
      await loc.first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})

      // Try fill first, then multiple fallbacks
      try {
        await loc.first().click({ timeout: 3000 })
        await loc.fill(text, { timeout: 5000 })
        typed = true
      } catch {
        try {
          // Fallback: click + select all + type
          await loc.first().click({ timeout: 3000 })
          await session.page.keyboard.press('ControlOrMeta+A')
          await session.page.keyboard.type(text)
          typed = true
        } catch {
          // Last resort: force click + type
          await loc.first().click({ force: true, timeout: 3000 })
          await session.page.keyboard.press('ControlOrMeta+A')
          await session.page.keyboard.type(text)
          typed = true
        }
      }
    }

    if (!typed) throw new Error(`Could not type into element matching "${selector}"`)

    if (submit) {
      await session.page.keyboard.press('Enter')
    }
    await settlePageAfterBrowserAction(session)

    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements, visibleValidationErrors } = await captureFrame(session)
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)
    const targetValidationErrors = targetLabel
      ? visibleValidationErrors.filter(error => validationMentionsLabel([error], targetLabel))
      : []
    const content = `${downloadNote}${interactiveElements || ''}`.trim() || undefined

    if (targetValidationErrors.length > 0) {
      return {
        success: false,
        recoverable: true,
        url: session.page.url(),
        title,
        screenshotPath,
        screenshotUrl,
        screenshotBase64,
        error: visibleValidationBlockError(targetValidationErrors),
        content: prependVisibleValidationErrors(content, visibleValidationErrors),
        action: `Typed value rejected by visible validation`,
      }
    }

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content,
      action: `Typed: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`,
    }
  } catch (err) {
    return browserActionFailureWithFreshFrame(session, err, `Failed to type into: ${selector}`)
  }
}

const TYPEABLE_ROLES = new Set([
  'text-input', 'textarea', 'search-input', 'email-input', 'password-input',
  'tel-input', 'url-input', 'number-input', 'date-input', 'time-input',
  'datetime-local-input', 'month-input', 'week-input',
])

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function sanitizeBrowserAutomationError(error: unknown): string {
  const raw = stripAnsi(error instanceof Error ? error.message : String(error || 'Browser action failed'))
    .replace(/\r/g, '')
    .trim()
  if (!raw) return 'Browser action failed.'

  if (/locator\.selectOption|selectOption:/i.test(raw)) {
    return 'Could not select that dropdown option. Use an enabled option shown in the fresh elements list.'
  }
  if (/Timeout\s+\d+ms exceeded/i.test(raw)) {
    return 'Timed out waiting for the target control to become ready. Use a fresh visible control or a different field-specific action.'
  }

  const line = raw
    .split('\n')
    .map(part => part.trim())
    .find(Boolean) || raw
  return line.length > 220 ? `${line.slice(0, 217)}...` : line
}

interface DropdownOptionCandidate {
  value: string
  label: string
  text: string
  disabled: boolean
}

function dropdownOptionName(option: DropdownOptionCandidate): string {
  return option.label || option.text || option.value || '(blank)'
}

function formatDropdownOptions(options: DropdownOptionCandidate[]): string {
  const enabled = options.filter(option => !option.disabled)
  const sample = enabled.length > 0 ? enabled : options
  return sample
    .slice(0, 12)
    .map(option => `${dropdownOptionName(option)}${option.value && option.value !== dropdownOptionName(option) ? `=${option.value}` : ''}${option.disabled ? ' [disabled]' : ''}`)
    .join(', ') || 'no enabled options'
}

function matchDropdownOption(options: DropdownOptionCandidate[], requestedValue: string): DropdownOptionCandidate | null {
  const target = normalizeMatchText(requestedValue)
  if (!target) return null
  const enabled = options.filter(option => !option.disabled)

  const numericTarget = /^\d+$/.test(target) ? Number.parseInt(target, 10) : null
  for (const option of enabled) {
    const values = [option.value, option.label, option.text].filter(Boolean)
    if (values.some(value => value === requestedValue)) return option
    if (values.some(value => normalizeMatchText(value) === target)) return option
    if (numericTarget !== null && values.some(value => {
      const normalized = normalizeMatchText(value)
      return /^\d+$/.test(normalized) && Number.parseInt(normalized, 10) === numericTarget
    })) return option
  }

  return null
}

async function readDropdownOptions(locator: Locator): Promise<DropdownOptionCandidate[]> {
  return locator.evaluate((node) => {
    if (!(node instanceof HTMLSelectElement)) return []
    return Array.from(node.options).map(option => {
      const parentDisabled = option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled
      const text = (option.textContent || '').trim().replace(/\s+/g, ' ')
      return {
        value: option.value || '',
        label: option.label || text || option.value || '',
        text,
        disabled: option.disabled || parentDisabled,
      }
    })
  })
}

async function selectDropdownOption(locator: Locator, value: string): Promise<{ ok: true; selected: string } | { ok: false; error: string }> {
  const options = await readDropdownOptions(locator).catch(() => [])
  const matched = options.length > 0 ? matchDropdownOption(options, value) : null
  if (options.length > 0 && !matched) {
    return {
      ok: false,
      error: `Option "${value}" is not an enabled choice in this dropdown. Choose one of: ${formatDropdownOptions(options)}.`,
    }
  }

  try {
    if (matched) {
      await locator.selectOption({ value: matched.value }, { timeout: 5000 })
      return { ok: true, selected: dropdownOptionName(matched) }
    }
    await locator.selectOption({ value }, { timeout: 5000 })
    return { ok: true, selected: value }
  } catch (firstError) {
    try {
      await locator.selectOption({ label: value }, { timeout: 5000 })
      return { ok: true, selected: value }
    } catch {
      return {
        ok: false,
        error: options.length > 0
          ? `Could not select "${value}". Choose one of: ${formatDropdownOptions(options)}.`
          : sanitizeBrowserAutomationError(firstError),
      }
    }
  }
}

function scoreElementMatch(query: string, element: IndexedElement): number {
  const q = normalizeMatchText(query)
  if (!q) return 0

  const haystacks = [
    element.label,
    element.groupLabel,
    element.visualLabel,
    ...(element.options || []),
    element.primary,
    element.tag,
    element.role,
  ].filter((value): value is string => !!value).map(normalizeMatchText).filter(Boolean)

  let best = 0
  for (const h of haystacks) {
    if (h === q) best = Math.max(best, 100)
    else if (h.startsWith(q)) best = Math.max(best, 85)
    else if (h.includes(q)) best = Math.max(best, 70)
    else {
      const qWords = q.split(/\s+/).filter(Boolean)
      const hWords = new Set(h.split(/\s+/).filter(Boolean))
      const overlap = qWords.filter(w => hWords.has(w)).length
      if (overlap > 0) best = Math.max(best, Math.round((overlap / qWords.length) * 60))
    }
  }
  return best
}

async function ensureElementIndex(session: BrowserSession): Promise<Array<[number, IndexedElement]>> {
  if (!session.lastElementIndex || session.lastElementIndex.size === 0) {
    await refreshInteractiveElementsWithSettling(session)
  }
  return Array.from(session.lastElementIndex?.entries() || [])
}

function findFormFieldTarget(
  entries: Array<[number, IndexedElement]>,
  field: BrowserFormFillField,
): [number, IndexedElement] | null {
  if (typeof field.index === 'number') {
    return entries.find(([idx]) => idx === field.index) || null
  }

  const label = field.label?.trim()
  if (!label) return null

  let best: [number, IndexedElement] | null = null
  let bestScore = 0
  for (const entry of entries) {
    const [, element] = entry
    const score = scoreElementMatch(label, element)
    if (score > bestScore) {
      best = entry
      bestScore = score
    }
  }
  return bestScore >= 45 ? best : null
}

function isTruthyControlValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return true
  return !/^(false|no|off|unchecked|unselected|0)$/i.test(value.trim())
}

async function fillIndexedElement(
  session: BrowserSession,
  index: number,
  element: IndexedElement,
  field: BrowserFormFillField,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const value = field.value === undefined ? '' : String(field.value)
  const label = field.label || element.label || element.primary
  const locator: Locator = session.page.locator(normalizeSelector(element.primary)).first()

  try {
    if (element.state?.disabled || element.state?.unavailable) {
      return {
        ok: false,
        error: `[${index}] ${label}: ${element.state.unavailable ? 'unavailable' : 'disabled'}; choose another option or scroll to the next required section`,
      }
    }

    await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {})

    if (TYPEABLE_ROLES.has(element.role)) {
      await locator.click({ timeout: 2500 }).catch(() => {})
      await locator.fill(value, { timeout: 5000 })
      return { ok: true, summary: `[${index}] ${label}: typed "${value.slice(0, 40)}"` }
    }

    if (element.role === 'dropdown') {
      const selected = await selectDropdownOption(locator, value)
      if (!selected.ok) {
        return { ok: false, error: `[${index}] ${label}: ${selected.error}` }
      }
      return { ok: true, summary: `[${index}] ${label}: selected "${selected.selected.slice(0, 40)}"` }
    }

    if (['radio', 'checkbox', 'switch', 'option', 'button', 'tab'].includes(element.role)) {
      if (!isTruthyControlValue(field.value)) {
        return { ok: true, summary: `[${index}] ${label}: left unchanged` }
      }
      if (element.state?.selected || element.state?.checked || element.state?.pressed) {
        return { ok: true, summary: `[${index}] ${label}: already selected` }
      }
      await locator.click({ timeout: 5000 })
      return { ok: true, summary: `[${index}] ${label}: clicked` }
    }

    return { ok: false, error: `[${index}] ${label}: unsupported role "${element.role}"` }
  } catch (error) {
    return {
      ok: false,
      error: `[${index}] ${label}: ${sanitizeBrowserAutomationError(error)}`,
    }
  }
}

async function clickSubmitControl(session: BrowserSession, submitLabel?: string): Promise<string> {
  const labels = submitLabel?.trim()
    ? [submitLabel.trim()]
    : ['Submit', 'Search', 'Continue', 'Next', 'Done', 'Save', 'Apply', 'Go']

  for (const label of labels) {
    const re = new RegExp(escapeRegExp(label), 'i')
    const candidates: Locator[] = [
      session.page.getByRole('button', { name: re }).first(),
      session.page.getByRole('link', { name: re }).first(),
      session.page.locator(`input[type="submit"][value*="${label.replace(/"/g, '\\"')}"]`).first(),
    ]

    for (const locator of candidates) {
      try {
        if (await locator.count() === 0) continue
        await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
        await locator.click({ timeout: 3000 })
        await settlePageAfterBrowserAction(session)
        return `Submitted via "${label}"`
      } catch {
        // Try the next candidate.
      }
    }
  }

  await session.page.keyboard.press('Enter')
  await settlePageAfterBrowserAction(session)
  return 'Submitted via Enter'
}

export async function browserFillForm(
  conversationId: string,
  fields: BrowserFormFillField[],
  submit = false,
  submitLabel?: string,
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const beforeDownloadCount = session.downloads.length

    if (!Array.isArray(fields) || fields.length === 0) {
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: 'browser_fill_form requires a non-empty fields array',
        action: 'Failed form fill',
      }
    }
    if (fields.length > 20) {
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: 'browser_fill_form supports at most 20 fields at once',
        action: 'Failed form fill',
      }
    }

    const entries = await ensureElementIndex(session)
    const completed: string[] = []
    const failures: string[] = []

    for (const field of fields) {
      const target = findFormFieldTarget(entries, field)
      const fieldName = field.label || (typeof field.index === 'number' ? `[${field.index}]` : 'unnamed field')
      if (!target) {
        failures.push(`${fieldName}: no matching visible form control`)
        continue
      }

      const [index, element] = target
      const result = await fillIndexedElement(session, index, element, field)
      if (result.ok) completed.push(result.summary)
      else failures.push(result.error)
      await session.page.waitForTimeout(100)
    }

    let submitSummary = ''
    if (submit || submitLabel) {
      try {
        submitSummary = await clickSubmitControl(session, submitLabel)
      } catch (error) {
        failures.push(`submit: ${sanitizeBrowserAutomationError(error)}`)
      }
    }

    await settlePageAfterBrowserAction(session)
    const title = await session.page.title().catch(() => '')
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements, visibleValidationErrors } = await captureFrame(session)
    const downloadNote = formatDownloadNote(session, beforeDownloadCount)
    const validationFailures = visibleValidationErrors.filter(error => {
      if (completed.length === 0 && failures.length === 0) return true
      return completed.some(summary => validationMentionsLabel([error], summary)) ||
        failures.some(summary => validationMentionsLabel([error], summary)) ||
        /required|invalid|must|cannot|can be|characters?|too short|too long|too weak|please/i.test(error)
    })
    const summary = [
      completed.length > 0 ? `Filled fields:\n- ${completed.join('\n- ')}` : '',
      submitSummary,
      failures.length > 0 ? `Failures:\n- ${failures.join('\n- ')}` : '',
      downloadNote.trim(),
      interactiveElements || '',
    ].filter(Boolean).join('\n\n')
    const visibleValidationBlocksSubmission = validationFailures.length > 0

    return {
      success: failures.length === 0 && !visibleValidationBlocksSubmission,
      ...(visibleValidationBlocksSubmission ? { recoverable: true } : {}),
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      ...(visibleValidationBlocksSubmission
        ? { error: visibleValidationBlockError(validationFailures) }
        : failures.length > 0
        ? { error: `${failures.length} field(s) failed. Use the fresh elements list below to retry only those fields.` }
        : {}),
      content: prependVisibleValidationErrors(summary || undefined, visibleValidationErrors),
      action: failures.length === 0 && !visibleValidationBlocksSubmission
        ? `Filled form (${completed.length} fields${submit || submitLabel ? ', submitted' : ''})`
        : visibleValidationBlocksSubmission
        ? `Form fill blocked by visible validation (${validationFailures.length} error${validationFailures.length === 1 ? '' : 's'})`
        : `Form fill partially failed (${completed.length}/${fields.length} fields)`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: sanitizeBrowserAutomationError(err),
      action: 'Failed form fill',
    }
  }
}

export async function browserFindText(
  conversationId: string,
  query: string,
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const needle = query.trim()
    if (!needle) {
      return {
        success: false,
        url: session.page.url(),
        title: await session.page.title().catch(() => ''),
        error: 'browser_find_text requires a non-empty query',
        action: 'Failed find text',
      }
    }

    const result = await session.page.evaluate((q) => {
      document.querySelectorAll('[data-agent-find-highlight="true"]').forEach((el) => {
        const html = el as HTMLElement
        html.style.outline = ''
        html.style.backgroundColor = ''
        html.removeAttribute('data-agent-find-highlight')
      })

      const lower = q.toLowerCase()
      const body = document.body
      if (!body) return { found: false, count: 0, snippet: '' }

      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
      }

      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let count = 0
      let target: HTMLElement | null = null
      let snippet = ''

      while (walker.nextNode()) {
        const node = walker.currentNode
        const text = node.textContent || ''
        if (!text.toLowerCase().includes(lower)) continue
        const parent = node.parentElement
        if (!parent || !isVisible(parent)) continue
        count++
        if (!target) {
          target = parent
          const normalized = text.replace(/\s+/g, ' ').trim()
          const idx = normalized.toLowerCase().indexOf(lower)
          const start = Math.max(0, idx - 80)
          const end = Math.min(normalized.length, idx + q.length + 120)
          snippet = normalized.slice(start, end)
        }
      }

      if (!target) return { found: false, count, snippet: '' }

      target.scrollIntoView({ block: 'center', inline: 'nearest' })
      target.style.outline = '3px solid #ff9500'
      target.style.backgroundColor = 'rgba(255, 149, 0, 0.14)'
      target.setAttribute('data-agent-find-highlight', 'true')

      return { found: true, count, snippet }
    }, needle)

    await session.page.waitForTimeout(250)
    const title = await session.page.title().catch(() => '')
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)
    const foundContent = `Found ${result.count} match(es) for "${needle}".\nSnippet: ${result.snippet}`
    const notFoundContent = [
      `TEXT SEARCH RESULT: No visible text nodes matched "${needle}".`,
      'This is not proof the target is absent. Visual options, swatches, icons, map controls, cards, and image-based controls may be visible in the screenshot or exposed only as interactive element labels.',
      'Use the screenshot and fresh [N] list below as the next source of truth. If the target is visual, choose the nearest matching visible control with browser_click_at({index: N}); if it is off-screen, use browser_scroll or browser_screenshot to inspect more of the page.',
    ].join('\n')

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: `${result.found ? foundContent : notFoundContent}\n\n${interactiveElements || ''}`.trim(),
      action: result.found ? `Found text: ${needle}` : `Text not found; returned visual frame: ${needle}`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: `Failed to find text: ${query}`,
    }
  }
}

/** Compound action for browser_action_sequence: one entry in the sequence array. */
export interface BrowserSequenceAction {
  action: 'click_at' | 'type' | 'select' | 'press_key' | 'hover' | 'scroll'
  args: Record<string, unknown>
}

/**
 * Execute multiple browser actions sequentially against ONE session, returning
 * a single final frame after the entire sequence completes. Each action delegates
 * to its existing single-action handler so stale-index errors, hit detection,
 * and SoM updates all behave consistently.
 *
 * If any action fails (returns success: false or throws), the sequence STOPS
 * and returns a structured error naming the failing step and listing the
 * actions that completed successfully. The page is left in a partially-modified
 * state, which the next iteration's elements list will reflect.
 *
 * Maximum 8 actions per sequence — anything longer should be split because the
 * indices are resolved against the LAST elements list the agent saw, and the
 * further into a sequence we go the more likely the page has reflowed.
 */
export async function browserActionSequence(
  conversationId: string,
  actions: BrowserSequenceAction[],
): Promise<BrowserActionResult> {
  const session = await getOrCreateSession(conversationId)
  const beforeDownloadCount = session.downloads.length
  const completed: string[] = []
  let previousUrl = session.page.url()
  let previousSignature = computeBrowserPageSignature({
    url: previousUrl,
    title: await session.page.title().catch(() => ''),
    content: await getInteractiveElements(session).catch(() => ''),
  })

  if (!Array.isArray(actions) || actions.length === 0) {
    return seqError(session, 0, 0, 'sequence', 'empty actions array', completed)
  }
  if (actions.length > 8) {
    return seqError(session, 0, actions.length, 'sequence', `too many actions (${actions.length}), max 8`, completed)
  }

  for (let i = 0; i < actions.length; i++) {
    const { action, args } = actions[i]
    let result: BrowserActionResult

    try {
      switch (action) {
        case 'click_at': {
          const idx = typeof args.index === 'number' ? args.index : undefined
          if (idx === undefined) {
            return seqError(session, i + 1, actions.length, action, 'missing index; raw coordinates are disabled for action_sequence clicks', completed)
          }
          result = await browserClickAt(conversationId, undefined, undefined, idx)
          break
        }
        case 'type': {
          const idx = typeof args.index === 'number' ? args.index : undefined
          const sel = typeof args.selector === 'string' ? args.selector : undefined
          const text = typeof args.text === 'string' ? args.text : undefined
          if (text === undefined) {
            return seqError(session, i + 1, actions.length, action, 'missing text', completed)
          }
          if (idx === undefined && !sel) {
            return seqError(session, i + 1, actions.length, action, 'missing index or selector', completed)
          }
          result = await browserType(conversationId, sel, text, !!args.submit, idx)
          break
        }
        case 'select': {
          const idx = typeof args.index === 'number' ? args.index : undefined
          const sel = typeof args.selector === 'string' ? args.selector : undefined
          const value = typeof args.value === 'string' ? args.value : undefined
          if (value === undefined) {
            return seqError(session, i + 1, actions.length, action, 'missing value', completed)
          }
          if (idx === undefined && !sel) {
            return seqError(session, i + 1, actions.length, action, 'missing index or selector', completed)
          }
          result = await browserSelect(conversationId, sel, value, idx)
          break
        }
        case 'press_key': {
          const key = typeof args.key === 'string' ? args.key : undefined
          if (!key) {
            return seqError(session, i + 1, actions.length, action, 'missing key', completed)
          }
          result = await browserPressKey(conversationId, key)
          break
        }
        case 'hover': {
          const idx = typeof args.index === 'number' ? args.index : undefined
          const sel = typeof args.selector === 'string' ? args.selector : undefined
          if (idx === undefined && !sel) {
            return seqError(session, i + 1, actions.length, action, 'missing index or selector', completed)
          }
          result = await browserHover(conversationId, sel, idx)
          break
        }
        case 'scroll': {
          const { direction, amount } = normalizeBrowserScrollArgs(args)
          result = await browserScroll(conversationId, direction, amount)
          break
        }
        default:
          return seqError(session, i + 1, actions.length, action, `unknown action "${action}"`, completed)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return seqError(session, i + 1, actions.length, action, reason, completed)
    }

    if (!result.success) {
      return seqError(session, i + 1, actions.length, action, result.error || 'unknown failure', completed, result)
    }

    const argSummary = JSON.stringify(args).slice(0, 60)
    completed.push(`${action}(${argSummary})`)

    const nextUrl = result.url || session.page.url()
    const nextSignature = computeBrowserPageSignature(result)
    const pageChanged = nextUrl !== previousUrl || nextSignature !== previousSignature
    if (pageChanged && i < actions.length - 1) {
      return {
        success: true,
        url: result.url,
        title: result.title,
        screenshotPath: result.screenshotPath,
        screenshotUrl: result.screenshotUrl,
        screenshotBase64: result.screenshotBase64,
        content: `Sequence stopped early after ${i + 1}/${actions.length} actions because the page changed and later indices may now be stale. Re-read the fresh elements list below before continuing.\n\n${result.content || ''}`.trim(),
        action: `Sequence paused after page change (${i + 1}/${actions.length})`,
      }
    }

    previousUrl = nextUrl
    previousSignature = nextSignature
  }

  // Sequence succeeded — return one final fresh frame so the agent sees the
  // post-sequence state in a single response.
  const title = await session.page.title().catch(() => '')
  const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements, visibleValidationErrors } = await captureFrame(session)
  const downloadNote = formatDownloadNote(session, beforeDownloadCount)
  const sequenceSummary = `${downloadNote}Sequence completed: ${completed.length}/${actions.length} actions\n  ${completed.join('\n  → ')}\n\n${interactiveElements || ''}`.trim()
  if (visibleValidationErrors.length > 0) {
    return {
      success: false,
      recoverable: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      error: visibleValidationBlockError(visibleValidationErrors),
      content: prependVisibleValidationErrors(sequenceSummary, visibleValidationErrors),
      action: `Sequence stopped on visible validation (${visibleValidationErrors.length} error${visibleValidationErrors.length === 1 ? '' : 's'})`,
    }
  }
  return {
    success: true,
    url: session.page.url(),
    title,
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
    content: sequenceSummary,
    action: `Sequence completed (${completed.length} actions)`,
  }
}

/** Helper for browserActionSequence: build a structured failure result with
 * sequence context preserved (which step failed, what completed before it). */
function seqError(
  session: BrowserSession,
  step: number,
  total: number,
  action: string,
  reason: string,
  completed: string[],
  failureResult?: BrowserActionResult,
): BrowserActionResult {
  const completedSummary = completed.length > 0
    ? `Successful actions before failure: [${completed.join(', ')}]`
    : 'No actions completed successfully.'
  return {
    success: false,
    url: session.page.url(),
    title: failureResult?.title || '',
    screenshotPath: failureResult?.screenshotPath,
    screenshotUrl: failureResult?.screenshotUrl,
    screenshotBase64: failureResult?.screenshotBase64,
    error: `Action ${step}/${total} (${action}) failed: ${reason}. ${completedSummary} The page is in a partially-modified state — re-read the elements list before retrying.`,
    content: failureResult?.content,
    action: `Sequence failed at step ${step}/${total}`,
  }
}

export async function browserScreenshot(
  conversationId: string,
  fullPage = false
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session, { fullPage })

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: interactiveElements || undefined,
      action: 'Took screenshot',
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: 'Failed to take screenshot',
    }
  }
}

export async function browserResize(
  conversationId: string,
  width: number,
  height: number,
): Promise<BrowserActionResult> {
  try {
    const safeWidth = Math.max(320, Math.min(2560, Math.round(width)))
    const safeHeight = Math.max(480, Math.min(1600, Math.round(height)))
    const session = await getOrCreateSession(conversationId)
    await session.page.setViewportSize({ width: safeWidth, height: safeHeight })
    await settlePageAfterBrowserAction(session, 700)
    const title = await session.page.title()
    const { screenshotPath, screenshotUrl, screenshotBase64, interactiveElements } = await captureFrame(session)

    return {
      success: true,
      url: session.page.url(),
      title,
      screenshotPath,
      screenshotUrl,
      screenshotBase64,
      content: interactiveElements || undefined,
      action: `Resized browser to ${safeWidth}x${safeHeight}`,
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: 'Failed to resize browser',
    }
  }
}

export async function browserGetContent(
  conversationId: string
): Promise<BrowserActionResult> {
  try {
    const session = await getOrCreateSession(conversationId)
    const title = await session.page.title()

    let content = await session.page.innerText('body')
    const finalUrl = session.page.url()
    const errorReason = detectErrorPage({ status: 0, finalUrl, title, bodyText: content })
    if (content.length > 8000) content = content.slice(0, 8000) + '\n...[truncated]'

    if (errorReason) {
      const normFinal = normalizeNavUrl(finalUrl)
      session.failedNavigations.set(normFinal, errorReason)
      session.pageBlocker = errorReason
      return {
        success: false,
        recoverable: true,
        url: finalUrl,
        title,
        error: `Current page is an error page: ${errorReason}.`,
        content: navigationRecoveryContent(errorReason, finalUrl, finalUrl, title, content, '') || undefined,
        action: `Error page content: ${title || finalUrl}`,
      }
    }

    return {
      success: true,
      url: finalUrl,
      title,
      content,
      action: 'Got page content',
    }
  } catch (err) {
    return {
      success: false,
      url: '',
      title: '',
      error: err instanceof Error ? err.message : String(err),
      action: 'Failed to get page content',
    }
  }
}

function startScreencast(session: BrowserSession) {
  if (session.screencastActive) return
  session.screencastActive = true
  debugBrowserStream(`[screencast] starting for ${session.conversationId}, cdp=${!!session.cdp}`)

  if (session.cdp) {
    // Use CDP Page.screencastFrame for high-FPS push-based streaming
    let frameNum = 0
    session.cdp.on('Page.screencastFrame', async (params: { data: string; sessionId: number }) => {
      if (!session.screencastActive) return
      session.latestFrame = params.data
      frameNum++
      if (frameNum <= 3) debugBrowserStream(`[screencast-cdp] ${session.conversationId}: frame #${frameNum}, listeners=${session.frameListeners.size}`)
      for (const fn of session.frameListeners) {
        fn(params.data)
      }
      // Acknowledge frame so Chrome sends the next one
      try {
        await session.cdp!.send('Page.screencastFrameAck', { sessionId: params.sessionId })
      } catch { /* session may be closed */ }
    })

    session.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    }).catch((e: unknown) => {
      debugBrowserStream('[screencast-cdp] failed to start, falling back to polling', e)
      session.cdp = null
      session.screencastActive = false
      startScreencast(session) // retry with polling fallback
    })
  } else {
    // Fallback: poll screenshots
    let frameNum = 0
    const captureFrame = async () => {
      if (!session.screencastActive) return
      try {
        const buffer = await session.page.screenshot({ type: 'jpeg', quality: 80 })
        const base64 = buffer.toString('base64')
        session.latestFrame = base64
        frameNum++
        if (frameNum <= 3) debugBrowserStream(`[screencast-poll] ${session.conversationId}: frame #${frameNum}, listeners=${session.frameListeners.size}`)
        for (const fn of session.frameListeners) {
          fn(base64)
        }
      } catch {
        // page might be mid-navigation — skip this frame
      }
      if (session.screencastActive) {
        setTimeout(captureFrame, 100)
      }
    }
    captureFrame()
  }
}

export function hasBrowserSession(conversationId: string): boolean {
  return sessions.has(conversationId)
}

export async function browserActionPreflight(
  conversationId: string,
  opts?: { includeFrame?: boolean; preferCached?: boolean },
): Promise<BrowserActionPreflightSnapshot> {
  const session = sessions.get(conversationId)
  if (!session) {
    return {
      hasSession: false,
      url: '',
      title: '',
      indexedCount: 0,
      maxIndex: 0,
      elements: [],
    }
  }

  session.lastUsed = Date.now()

  let content = ''
  let screenshotPath: string | undefined
  let screenshotUrl: string | undefined
  let screenshotBase64: string | undefined

  if (opts?.includeFrame) {
    const frame = await captureFrame(session)
    content = frame.interactiveElements
    screenshotPath = frame.screenshotPath
    screenshotUrl = frame.screenshotUrl
    screenshotBase64 = frame.screenshotBase64
  } else if (opts?.preferCached && session.lastElementIndex && session.lastInteractiveElementsText) {
    content = session.lastInteractiveElementsText
  } else {
    content = await refreshInteractiveElementsWithSettling(session)
  }
  const pageText = await getVisiblePageText(session.page)
  content = combinePageTextAndInteractive(pageText, content)
  const visibleValidationErrors = await getVisibleValidationErrors(session.page)
  content = prependVisibleValidationErrors(content, visibleValidationErrors) || content

  const challengeReason = await detectHumanVerificationChallenge(session.page, pageText)
  const entries = Array.from(session.lastElementIndex?.entries() || [])
  const title = await session.page.title().catch(() => '')
  const currentUrl = session.page.url()

  if (challengeReason) {
    session.pageBlocker = challengeReason
  } else if (session.pageBlocker && pageAppearsHealthyForActions({
    finalUrl: currentUrl,
    title,
    bodyText: pageText,
    indexedCount: entries.length,
  })) {
    // A previous navigation can mark the session as blocked, then a later
    // same-site route/search can successfully render controls. Do not let that
    // stale blocker prevent the agent from acting on the healthy live page.
    session.failedNavigations.delete(normalizeNavUrl(currentUrl))
    session.pageBlocker = null
  }

  const elements = entries.map(([index, element]): BrowserActionPreflightElement => ({
    index,
    role: element.role,
    label: element.label,
    primary: element.primary,
    groupLabel: element.groupLabel,
    visualLabel: element.visualLabel,
    options: element.options,
    disabled: !!element.state?.disabled,
    unavailable: !!element.state?.unavailable,
    selected: !!element.state?.selected,
    checked: !!element.state?.checked,
  }))
  const focusedElement = await getFocusedElementSnapshot(session.page, entries).catch(() => null)

  return {
    hasSession: true,
    url: currentUrl,
    title,
    pageBlocker: session.pageBlocker,
    indexedCount: entries.length,
    maxIndex: entries.length > 0 ? Math.max(...entries.map(([index]) => index)) : 0,
    elements,
    focusedElement,
    visibleValidationErrors,
    content: content || undefined,
    screenshotPath,
    screenshotUrl,
    screenshotBase64,
  }
}

export function subscribeToBrowserFrames(
  conversationId: string,
  listener: BrowserFrameListener
): (() => void) | null {
  const session = sessions.get(conversationId)
  if (!session) {
    let listeners = pendingFrameListeners.get(conversationId)
    if (!listeners) {
      listeners = new Set()
      pendingFrameListeners.set(conversationId, listeners)
    }
    listeners.add(listener)
    return () => {
      const pending = pendingFrameListeners.get(conversationId)
      pending?.delete(listener)
      if (pending && pending.size === 0) pendingFrameListeners.delete(conversationId)
      sessions.get(conversationId)?.frameListeners.delete(listener)
    }
  }

  session.frameListeners.add(listener)

  // Send the latest frame immediately so the client doesn't see a blank
  if (session.latestFrame) {
    listener(session.latestFrame)
  }

  // Start polling screenshots if not already active
  startScreencast(session)

  return () => {
    session.frameListeners.delete(listener)
    const pending = pendingFrameListeners.get(conversationId)
    pending?.delete(listener)
    if (pending && pending.size === 0) pendingFrameListeners.delete(conversationId)
    // Polling stops on its own when frameListeners is empty
  }
}

export async function destroyBrowserSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId)
  if (!session) return
  sessions.delete(conversationId)
  session.screencastActive = false
  try {
    if (session.cdp) {
      await session.cdp.send('Page.stopScreencast').catch(() => {})
      await session.cdp.detach().catch(() => {})
    }
    await session.context.close()
    await session.browser.close()
  } catch {
    // Best effort cleanup
  }
}

// Idle cleanup
const cleanupInterval = setInterval(async () => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
      await destroyBrowserSession(id)
    }
  }
}, CLEANUP_INTERVAL_MS)

if (cleanupInterval.unref) {
  cleanupInterval.unref()
}
