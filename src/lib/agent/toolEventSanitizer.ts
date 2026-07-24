const REDACTED = '[REDACTED]'
const MAX_SANITIZE_DEPTH = 16
const MAX_SANITIZE_NODES = 20_000

const SENSITIVE_NAME = /(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|secret|password|passwd|passphrase|cookie|session|credential|private[-_]?key|client[-_]?secret|csrf|xsrf)/i
const SENSITIVE_QUERY_NAME = /(?:^|[-_.])(?:access[-_]?key|api[-_]?key|auth|authorization|code|credential|key|password|passwd|private[-_]?key|secret|session|sig|signature|token)(?:$|[-_.])/i
const FORM_CONTAINER_NAME = /(?:^|[-_.])(?:fields?|form|inputs?|formdata|form[-_]?data)(?:$|[-_.])/i
const FORM_VALUE_NAME = /^(?:value|text|content|input|defaultValue)$/i
const URL_FIELD_NAME = /(?:^|[-_.])(?:url|uri|href|src|source|location|redirect)(?:$|[-_.])/i
const BROWSER_TOOL_NAME = /^browser_/i

type SanitizeState = {
  seen: WeakSet<object>
  nodes: number
}

function stringLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  return 0
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function lineCount(value: string): number {
  return value.length > 0 ? value.split('\n').length : 0
}

function displayContract(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  if (typeof args.action_label === 'string') {
    output.action_label = sanitizeEventString(args.action_label).slice(0, 160)
  }
  if (typeof args.plan_step_index === 'number' && Number.isFinite(args.plan_step_index)) {
    output.plan_step_index = args.plan_step_index
  }
  return output
}

function redactUrl(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const url = new URL(raw)
    if (url.username) url.username = REDACTED
    if (url.password) url.password = REDACTED
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_NAME.test(key) || SENSITIVE_QUERY_NAME.test(key)) url.searchParams.set(key, REDACTED)
    }
    if (url.hash.length > 1 && url.hash.includes('=')) {
      const fragment = new URLSearchParams(url.hash.slice(1))
      for (const key of fragment.keys()) {
        if (SENSITIVE_NAME.test(key) || SENSITIVE_QUERY_NAME.test(key)) fragment.set(key, REDACTED)
      }
      url.hash = fragment.toString()
    }
    return url.toString()
  } catch {
    return raw.replace(
      /([?&#](?:access[-_]?key|api[-_]?key|auth|authorization|code|credential|key|password|passwd|private[-_]?key|secret|session|sig|signature|token)\s*=)[^&#\s"'<>]*/gi,
      `$1${REDACTED}`,
    )
  }
}

function redactUrlsInText(raw: string): string {
  return raw.replace(/https?:\/\/[^\s<>"'`]+/gi, (match) => {
    const trailing = match.match(/[),.;!?\]}]+$/)?.[0] || ''
    const candidate = trailing ? match.slice(0, -trailing.length) : match
    return `${String(redactUrl(candidate))}${trailing}`
  })
}

export function redactTerminalOutputSecrets(raw: string): string {
  return redactUrlsInText(raw)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, REDACTED)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{12,})\b/g, REDACTED)
    .replace(/\b((?:DATABASE|REDIS|MONGODB|MONGO|POSTGRES|POSTGRESQL|MYSQL|AMQP|BROKER|CONNECTION)[A-Za-z0-9_]*(?:URL|URI|STRING))\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1=${REDACTED}`)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_KEY|COOKIE|CREDENTIAL|PRIVATE_KEY)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1=${REDACTED}`)
    .replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/((?:Authorization|Proxy-Authorization|X-API-Key|Cookie|Set-Cookie|X-CSRF-Token|X-XSRF-Token)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(
      /((?:["']?)(?:access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|api[-_]?key|client[-_]?secret|password|passwd|passphrase|secret|session|cookie|credential)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,}\]&\s]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([?&#](?:access[-_]?key|api[-_]?key|auth|authorization|code|credential|key|password|passwd|private[-_]?key|secret|session|sig|signature|token)\s*=)[^&#\s"'<>]*/gi,
      `$1${REDACTED}`,
    )
}

function sanitizeEventString(raw: string): string {
  return redactTerminalOutputSecrets(raw)
}

export function redactCommandSecrets(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return redactTerminalOutputSecrets(raw)
    .replace(/((?:-H|--header)\s+["']?(?:Authorization|Proxy-Authorization|X-API-Key|Cookie|Set-Cookie)\s*:\s*)[^"'\s]+/gi, `$1${REDACTED}`)
    .replace(/(--?(?:api[-_]?key|token|secret|password|passwd|passphrase|cookie|credential))(?:=|\s+)\S+/gi, `$1=${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .slice(0, 800)
}

function hasSensitiveFieldDescriptor(value: Record<string, unknown>): boolean {
  return ['name', 'label', 'type', 'autocomplete', 'id', 'key'].some((key) => (
    typeof value[key] === 'string' && SENSITIVE_NAME.test(value[key] as string)
  ))
}

function sanitizeDeep(
  value: unknown,
  state: SanitizeState,
  depth: number,
  context: { parentKey?: string; formContext?: boolean } = {},
): unknown {
  state.nodes += 1
  if (state.nodes > MAX_SANITIZE_NODES) return '[TRUNCATED]'
  if (depth > MAX_SANITIZE_DEPTH) return '[TRUNCATED]'

  if (typeof value === 'string') return sanitizeEventString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined) return undefined
  if (typeof value !== 'object') return String(value)
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (state.seen.has(value)) return '[CIRCULAR]'
  state.seen.add(value)

  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeDeep(item, state, depth + 1, context))
    state.seen.delete(value)
    return output
  }

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  const formContext = context.formContext === true ||
    !!context.parentKey && FORM_CONTAINER_NAME.test(context.parentKey) ||
    hasSensitiveFieldDescriptor(input)

  for (const [key, item] of Object.entries(input)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue
    if (SENSITIVE_NAME.test(key)) {
      output[key] = REDACTED
      continue
    }
    if (formContext && FORM_VALUE_NAME.test(key)) {
      output[key] = REDACTED
      continue
    }

    const next = sanitizeDeep(item, state, depth + 1, {
      parentKey: key,
      formContext: formContext || FORM_CONTAINER_NAME.test(key),
    })
    output[key] = typeof next === 'string' && URL_FIELD_NAME.test(key)
      ? redactUrl(next)
      : next
  }

  state.seen.delete(value)
  return output
}

/**
 * Recursively removes secrets from values that may be written to durable task
 * events. It is deliberately idempotent because provisional tool starts are
 * re-emitted with the same ID once their final side-effect metadata is known.
 */
export function sanitizeToolEventValue(value: unknown): unknown {
  return sanitizeDeep(value, { seen: new WeakSet(), nodes: 0 }, 0)
}

function summarizeFormField(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valueType: typeof raw }
  const field = raw as Record<string, unknown>
  const summary: Record<string, unknown> = {}
  if (typeof field.index === 'number' && Number.isFinite(field.index)) summary.index = field.index
  if (typeof field.label === 'string') summary.label = sanitizeEventString(field.label).slice(0, 160)
  if (typeof field.valueType === 'string') summary.valueType = field.valueType.slice(0, 32)
  if (typeof field.valueCharCount === 'number' && Number.isFinite(field.valueCharCount)) {
    summary.valueCharCount = field.valueCharCount
  } else if ('value' in field) {
    summary.valueType = typeof field.value
    summary.valueCharCount = stringLength(field.value)
  }
  return summary
}

function summarizeBrowserAction(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { action: 'unknown' }
  const item = raw as Record<string, unknown>
  const action = typeof item.action === 'string' ? item.action.slice(0, 40) : 'unknown'
  const actionArgs = item.args && typeof item.args === 'object' && !Array.isArray(item.args)
    ? item.args as Record<string, unknown>
    : item
  const summary: Record<string, unknown> = { action }
  for (const key of ['index', 'fromIndex', 'toIndex', 'amount', 'duration']) {
    const value = finiteNumber(actionArgs[key])
    if (value !== undefined) summary[key] = value
  }
  if (typeof actionArgs.direction === 'string') summary.direction = actionArgs.direction.slice(0, 24)
  if (typeof actionArgs.key === 'string') summary.key = actionArgs.key.slice(0, 40)
  if (typeof actionArgs.selector === 'string' || actionArgs.selectorPresent === true) summary.selectorPresent = true
  if (typeof actionArgs.textCharCount === 'number') summary.textCharCount = actionArgs.textCharCount
  else if ('text' in actionArgs) summary.textCharCount = stringLength(actionArgs.text)
  if (typeof actionArgs.valueCharCount === 'number') summary.valueCharCount = actionArgs.valueCharCount
  else if ('value' in actionArgs) summary.valueCharCount = stringLength(actionArgs.value)
  return summary
}

function sanitizeBrowserStartArgs(
  toolName: string,
  args: Record<string, unknown>,
  display: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...display }
  for (const key of ['index', 'fromIndex', 'toIndex', 'x', 'y', 'amount', 'duration']) {
    const value = finiteNumber(args[key])
    if (value !== undefined) output[key] = value
  }
  for (const key of ['submit', 'fullPage', 'previewBuild']) {
    if (typeof args[key] === 'boolean') output[key] = args[key]
  }
  if (typeof args.direction === 'string') output.direction = args.direction.slice(0, 24)
  if (typeof args.key === 'string') output.key = args.key.slice(0, 40)
  if (typeof args.url === 'string') output.url = redactUrl(args.url)
  if (typeof args.path === 'string') output.path = sanitizeEventString(args.path).slice(0, 500)
  if (typeof args.selector === 'string' || args.selectorPresent === true) output.selectorPresent = true

  if (toolName === 'browser_type') {
    output.textCharCount = typeof args.textCharCount === 'number' ? args.textCharCount : stringLength(args.text)
  } else if (toolName === 'browser_select') {
    output.valueCharCount = typeof args.valueCharCount === 'number' ? args.valueCharCount : stringLength(args.value)
  } else if (toolName === 'browser_fill_form') {
    output.fields = Array.isArray(args.fields) ? args.fields.slice(0, 20).map(summarizeFormField) : []
    if (typeof args.submitLabel === 'string') output.submitLabelCharCount = args.submitLabel.length
    else if (typeof args.submitLabelCharCount === 'number') output.submitLabelCharCount = args.submitLabelCharCount
  } else if (toolName === 'browser_action_sequence') {
    output.actions = Array.isArray(args.actions) ? args.actions.slice(0, 8).map(summarizeBrowserAction) : []
  } else if (toolName === 'browser_find_text') {
    output.queryCharCount = typeof args.queryCharCount === 'number' ? args.queryCharCount : stringLength(args.query ?? args.text)
  }

  return output
}

export function sanitizeToolStartArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const display = displayContract(args)

  if (toolName === 'create_file' || toolName === 'append_file') {
    const content = typeof args.content === 'string' ? args.content : ''
    return {
      ...display,
      path: sanitizeToolEventValue(args.path),
      contentCharCount: typeof args.contentCharCount === 'number' ? args.contentCharCount : content.length,
      contentLineCount: typeof args.contentLineCount === 'number' ? args.contentLineCount : lineCount(content),
    }
  }
  if (toolName === 'edit_file') return { ...display, path: sanitizeToolEventValue(args.path) }
  if (toolName === 'run_code') {
    const code = typeof args.code === 'string' ? args.code : ''
    return {
      ...display,
      language: sanitizeToolEventValue(args.language),
      codeCharCount: typeof args.codeCharCount === 'number' ? args.codeCharCount : code.length,
      codeLineCount: typeof args.codeLineCount === 'number' ? args.codeLineCount : lineCount(code),
    }
  }
  if (toolName === 'execute_command') {
    const command = typeof args.command === 'string' ? args.command : ''
    return {
      ...display,
      commandPreview: command ? redactCommandSecrets(command) : redactCommandSecrets(args.commandPreview),
      commandCharCount: typeof args.commandCharCount === 'number' ? args.commandCharCount : command.length,
    }
  }
  if (toolName === 'http_request') {
    const headers = args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)
      ? Object.keys(args.headers as Record<string, unknown>).slice(0, 50)
      : Array.isArray(args.headerNames)
        ? args.headerNames.filter((item): item is string => typeof item === 'string').slice(0, 50)
        : []
    return {
      ...display,
      method: typeof args.method === 'string' ? args.method.toUpperCase() : 'GET',
      url: redactUrl(args.url),
      headerNames: headers.map((name) => sanitizeEventString(name).slice(0, 120)),
      bodyCharCount: typeof args.bodyCharCount === 'number' ? args.bodyCharCount : stringLength(args.body),
    }
  }
  if (BROWSER_TOOL_NAME.test(toolName)) {
    return sanitizeBrowserStartArgs(toolName, args, display)
  }

  const sanitized = sanitizeToolEventValue(args)
  const output = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
  return { ...output, ...display }
}

function sanitizeBrowserResult(result: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const key of ['success', 'recoverable', 'superseded']) {
    if (typeof result[key] === 'boolean') safe[key] = result[key]
  }
  for (const key of ['url', 'screenshotUrl']) {
    if (typeof result[key] === 'string') safe[key] = redactUrl(result[key])
  }
  for (const [key, maxLength] of [['title', 500], ['action', 1_000], ['error', 2_000], ['screenshotPath', 500]] as const) {
    if (typeof result[key] === 'string') safe[key] = sanitizeEventString(result[key] as string).slice(0, maxLength)
  }
  if (typeof result.content === 'string') safe.contentCharCount = result.content.length
  else if (typeof result.contentCharCount === 'number') safe.contentCharCount = result.contentCharCount
  if (Array.isArray(result.targetHints)) safe.targetHintCount = result.targetHints.length
  else if (typeof result.targetHintCount === 'number') safe.targetHintCount = result.targetHintCount

  if (result.visualQuality && typeof result.visualQuality === 'object' && !Array.isArray(result.visualQuality)) {
    safe.visualQuality = sanitizeToolEventValue(result.visualQuality)
  }
  if (result.browserProgress && typeof result.browserProgress === 'object' && !Array.isArray(result.browserProgress)) {
    const progress = result.browserProgress as Record<string, unknown>
    safe.browserProgress = {
      ...(typeof progress.kind === 'string' ? { kind: progress.kind.slice(0, 80) } : {}),
      ...(typeof progress.reason === 'string' ? { reason: sanitizeEventString(progress.reason).slice(0, 1_000) } : {}),
      ...(typeof progress.pageSignature === 'string' ? { pageSignature: progress.pageSignature.slice(0, 200) } : {}),
      ...(typeof progress.recoveryUsed === 'boolean' ? { recoveryUsed: progress.recoveryUsed } : {}),
    }
  }
  return safe
}

function sanitizeHttpResult(result: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  if (typeof result.superseded === 'boolean') safe.superseded = result.superseded
  for (const key of ['status', 'durationMs']) {
    const value = finiteNumber(result[key])
    if (value !== undefined) safe[key] = value
  }
  if (typeof result.statusText === 'string') safe.statusText = sanitizeEventString(result.statusText).slice(0, 500)
  if (typeof result.url === 'string') safe.url = redactUrl(result.url)
  const headerNames = result.headers && typeof result.headers === 'object' && !Array.isArray(result.headers)
    ? Object.keys(result.headers as Record<string, unknown>)
    : Array.isArray(result.headerNames)
      ? result.headerNames.filter((item): item is string => typeof item === 'string')
      : []
  safe.headerNames = headerNames.slice(0, 100).map((name) => sanitizeEventString(name).slice(0, 120))
  safe.bodyCharCount = typeof result.bodyCharCount === 'number' ? result.bodyCharCount : stringLength(result.body)
  return safe
}

export function sanitizeToolResultForEvent(toolName: string, result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return typeof result === 'string' ? sanitizeEventString(result) : result
  }
  if (BROWSER_TOOL_NAME.test(toolName) && !Array.isArray(result)) {
    return sanitizeBrowserResult(result as Record<string, unknown>)
  }
  if (toolName === 'http_request' && !Array.isArray(result)) {
    return sanitizeHttpResult(result as Record<string, unknown>)
  }

  const sanitized = sanitizeToolEventValue(result)
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized
  const safe = sanitized as Record<string, unknown>
  delete safe.screenshotBase64
  delete safe.imageDataUrl
  if (toolName === 'execute_command' || toolName === 'run_code') {
    if (typeof safe.command === 'string') safe.command = redactCommandSecrets(safe.command)
    for (const key of ['stdout', 'stderr', 'error']) {
      if (typeof safe[key] === 'string') safe[key] = redactTerminalOutputSecrets(safe[key] as string)
    }
  }
  return safe
}
