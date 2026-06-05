import { Worker } from 'worker_threads'
import { getOrCreateSandboxDir } from './sandbox'

export interface CodeRunResult {
  language: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  generatedFiles: string[]
}

type OutputCallback = (stream: 'stdout' | 'stderr', data: string) => void

const JAVASCRIPT_TIMEOUT_MS = 5_000
const MAX_JS_OUTPUT_CHARS = 64_000

const JS_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const util = require('node:util')
const { webcrypto } = require('node:crypto')
const { performance } = require('node:perf_hooks')

const timeoutMs = workerData.timeoutMs
const blockedPattern = /(?:\\brequire\\b|\\bprocess\\b|\\beval\\b|\\bFunction\\b|\\bconstructor\\b|import\\s*\\(|\\bimport\\b|\\bmodule\\b|\\bfs\\b|\\bchild_process\\b|\\bworker_threads\\b|\\bnet\\b|\\bhttp\\b|\\bhttps\\b)/i

function format(value) {
  if (typeof value === 'string') return value
  return util.inspect(value, { depth: 4, breakLength: 120, maxArrayLength: 100 })
}

function emit(stream, values) {
  parentPort.postMessage({
    type: 'output',
    stream,
    data: values.map(format).join(' ') + '\\n',
  })
}

const timers = new Set()
function limitedSetTimeout(fn, ms, ...args) {
  const delay = Math.max(0, Math.min(Number(ms) || 0, timeoutMs))
  const timer = setTimeout(() => {
    timers.delete(timer)
    fn(...args)
  }, delay)
  timers.add(timer)
  return timer
}
function limitedClearTimeout(timer) {
  timers.delete(timer)
  clearTimeout(timer)
}
function limitedSetInterval(fn, ms, ...args) {
  const delay = Math.max(1, Math.min(Number(ms) || 1, timeoutMs))
  const timer = setInterval(fn, delay, ...args)
  timers.add(timer)
  return timer
}
function limitedClearInterval(timer) {
  timers.delete(timer)
  clearInterval(timer)
}

const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
})
Object.assign(context, {
  console: {
    log: (...args) => emit('stdout', args),
    info: (...args) => emit('stdout', args),
    debug: (...args) => emit('stdout', args),
    warn: (...args) => emit('stderr', args),
    error: (...args) => emit('stderr', args),
  },
  Math,
  Date,
  Number,
  String,
  Boolean,
  BigInt,
  Symbol,
  Object,
  Array,
  Map,
  Set,
  WeakMap,
  WeakSet,
  RegExp,
  Error,
  TypeError,
  SyntaxError,
  RangeError,
  JSON,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Promise,
  queueMicrotask,
  setTimeout: limitedSetTimeout,
  clearTimeout: limitedClearTimeout,
  setInterval: limitedSetInterval,
  clearInterval: limitedClearInterval,
  structuredClone,
  crypto: webcrypto,
  performance,
  atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
  btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
})
Object.defineProperty(context, 'globalThis', { value: context, enumerable: false })

async function evaluate(code) {
  if (blockedPattern.test(code)) {
    throw new Error('Blocked JavaScript: Node APIs, dynamic code evaluation, imports, and constructor escapes are not available in run_code.')
  }

  try {
    const script = new vm.Script('"use strict";\\n' + code, {
      filename: 'agent-snippet.js',
      displayErrors: true,
    })
    return await Promise.resolve(script.runInContext(context, { timeout: timeoutMs }))
  } catch (error) {
    if (!(error instanceof SyntaxError) || !/(await is only valid|Illegal return statement)/i.test(error.message)) {
      throw error
    }
    const wrapped = new vm.Script('"use strict";\\n(async () => {\\n' + code + '\\n})()', {
      filename: 'agent-snippet.js',
      displayErrors: true,
    })
    return await Promise.resolve(wrapped.runInContext(context, { timeout: timeoutMs }))
  }
}

evaluate(workerData.code)
  .then((result) => {
    for (const timer of timers) clearTimeout(timer)
    if (result !== undefined) emit('stdout', ['=>', result])
    parentPort.postMessage({ type: 'done', exitCode: 0 })
  })
  .catch((error) => {
    for (const timer of timers) clearTimeout(timer)
    emit('stderr', [error && error.stack ? error.stack : String(error)])
    parentPort.postMessage({ type: 'done', exitCode: 1 })
  })
`

function isJavaScriptLanguage(language: string): boolean {
  const lang = language.toLowerCase()
  return lang === 'javascript' || lang === 'js' || lang === 'node'
}

function appendCapped(current: string, data: string, truncated: boolean): { value: string; truncated: boolean; emitted: string } {
  if (current.length >= MAX_JS_OUTPUT_CHARS) return { value: current, truncated, emitted: '' }
  const remaining = MAX_JS_OUTPUT_CHARS - current.length
  if (data.length <= remaining) {
    return { value: current + data, truncated, emitted: data }
  }
  const suffix = truncated ? '' : '\n[output truncated]\n'
  const emitted = data.slice(0, Math.max(0, remaining - suffix.length)) + suffix
  return { value: current + emitted, truncated: true, emitted }
}

async function runJavaScript(
  language: string,
  code: string,
  onOutput?: OutputCallback,
): Promise<CodeRunResult> {
  const startTime = Date.now()
  let stdout = ''
  let stderr = ''
  let stdoutTruncated = false
  let stderrTruncated = false
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  return new Promise<CodeRunResult>((resolve) => {
    const finish = (exitCode: number, timedOut: boolean) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve({
        language: language.toLowerCase(),
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
        timedOut,
        generatedFiles: [],
      })
    }

    const worker = new Worker(JS_WORKER_SOURCE, {
      eval: true,
      workerData: { code, timeoutMs: JAVASCRIPT_TIMEOUT_MS },
    })

    timeout = setTimeout(() => {
      const message = `Error: JavaScript execution timed out after ${JAVASCRIPT_TIMEOUT_MS / 1000}s.\\n`
      const next = appendCapped(stderr, message, stderrTruncated)
      stderr = next.value
      stderrTruncated = next.truncated
      if (next.emitted) onOutput?.('stderr', next.emitted)
      void worker.terminate().finally(() => finish(1, true))
    }, JAVASCRIPT_TIMEOUT_MS + 250)

    worker.on('message', (message: { type?: string; stream?: 'stdout' | 'stderr'; data?: string; exitCode?: number }) => {
      if (message.type === 'output' && message.stream && typeof message.data === 'string') {
        if (message.stream === 'stdout') {
          const next = appendCapped(stdout, message.data, stdoutTruncated)
          stdout = next.value
          stdoutTruncated = next.truncated
          if (next.emitted) onOutput?.('stdout', next.emitted)
        } else {
          const next = appendCapped(stderr, message.data, stderrTruncated)
          stderr = next.value
          stderrTruncated = next.truncated
          if (next.emitted) onOutput?.('stderr', next.emitted)
        }
      } else if (message.type === 'done') {
        finish(message.exitCode || 0, false)
        void worker.terminate()
      }
    })

    worker.on('error', (error) => {
      const next = appendCapped(stderr, `${error.stack || error.message}\\n`, stderrTruncated)
      stderr = next.value
      stderrTruncated = next.truncated
      if (next.emitted) onOutput?.('stderr', next.emitted)
      finish(1, false)
    })

    worker.on('exit', (codeValue) => {
      if (!settled && codeValue !== 0) {
        finish(codeValue || 1, false)
      }
    })
  })
}

export async function runCode(
  language: string,
  code: string,
  conversationId: string,
  onOutput?: OutputCallback
): Promise<CodeRunResult> {
  await getOrCreateSandboxDir(conversationId)
  const lang = language.toLowerCase()

  if (isJavaScriptLanguage(lang)) {
    return runJavaScript(lang, code, onOutput)
  }

  if (lang !== 'python' && lang !== 'py') {
    return {
      language: lang,
      stdout: '',
      stderr: `Error: unsupported language "${language}". Supported: javascript`,
      exitCode: 1,
      durationMs: 0,
      timedOut: false,
      generatedFiles: [],
    }
  }

  return {
    language: lang,
    stdout: '',
    stderr: 'Error: Python execution is disabled until an OS-level sandbox is available. Use javascript for small calculations and pure logic checks.',
    exitCode: 1,
    durationMs: 0,
    timedOut: false,
    generatedFiles: [],
  }
}
