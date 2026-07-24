import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const INLINE_RESEARCH_FLAG = '--expect-inline-research'
const SAVED_REPORT_FLAG = '--expect-saved-report'
const SELF_TEST_FLAG = '--self-test'
const INLINE_RESEARCH_DISCOVERY_TOOLS = new Set(['web_search'])
const INLINE_RESEARCH_EVIDENCE_TOOLS = new Set([
  'read_document',
  'http_request',
  'browser_navigate',
  'browser_get_content',
  'browse_page',
])
const FILE_OUTPUT_TOOLS = new Set([
  'create_file',
  'append_file',
  'edit_file',
  'export_pdf',
])

function inlineResearchContractFailures(body) {
  const toolNames = Array.isArray(body?.toolStarts)
    ? body.toolStarts
      .map(entry => entry?.name)
      .filter(name => typeof name === 'string')
    : []
  const finalText = typeof body?.textPreview === 'string'
    ? body.textPreview.trim()
    : ''
  const failures = []

  if (body?.ok !== true || body?.terminalStatus !== 'done') {
    failures.push('agent run did not finish successfully')
  }
  if (!toolNames.some(name => INLINE_RESEARCH_DISCOVERY_TOOLS.has(name))) {
    failures.push('no web discovery action was recorded')
  }
  if (!toolNames.some(name => INLINE_RESEARCH_EVIDENCE_TOOLS.has(name))) {
    failures.push('no source page was opened or extracted')
  }
  const fileTools = toolNames.filter(name => FILE_OUTPUT_TOOLS.has(name))
  if (fileTools.length > 0) {
    failures.push(`unexpected saved-file tools were used: ${fileTools.join(', ')}`)
  }
  if (finalText.length < 20) {
    failures.push('no substantive inline answer text was returned')
  }

  return failures
}

function savedReportContractFailures(body) {
  const toolNames = Array.isArray(body?.toolStarts)
    ? body.toolStarts
      .map(entry => entry?.name)
      .filter(name => typeof name === 'string')
    : []
  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : []
  const failures = []

  if (body?.ok !== true || body?.terminalStatus !== 'done') {
    failures.push('agent run did not finish successfully')
  }
  if (!toolNames.some(name => FILE_OUTPUT_TOOLS.has(name))) {
    failures.push('no saved-file tool was recorded')
  }
  if (artifacts.length === 0) {
    failures.push('no successful deliverable artifact event was recorded')
  }
  const leakedFailure = [
    body?.error,
    ...(Array.isArray(body?.errors) ? body.errors : []),
  ].some(value => /final_inline_answer_complete|no successful final deliverable/i.test(String(value || '')))
  if (leakedFailure) {
    failures.push('the run fell back to an inline completion despite requiring a saved report')
  }

  return failures
}

function runSelfTest() {
  const passingFixture = {
    ok: true,
    terminalStatus: 'done',
    toolStarts: [
      { name: 'web_search' },
      { name: 'read_document' },
    ],
    textPreview: 'A current source explains that language models emit SVG as structured XML text.',
  }
  assert.deepEqual(inlineResearchContractFailures(passingFixture), [])

  const failingFixture = {
    ok: true,
    terminalStatus: 'done',
    toolStarts: [
      { name: 'create_file' },
      { name: 'append_file' },
    ],
    textPreview: '',
  }
  const failures = inlineResearchContractFailures(failingFixture)
  assert.ok(failures.some(message => message.includes('web discovery')))
  assert.ok(failures.some(message => message.includes('source page')))
  assert.ok(failures.some(message => message.includes('saved-file tools')))
  assert.ok(failures.some(message => message.includes('inline answer')))
  console.log('prod-agent-smoke contract self-test passed')
}

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), '.env.local')
  if (!existsSync(envPath)) return

  const text = readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals === -1) continue
    const key = trimmed.slice(0, equals).trim()
    let value = trimmed.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

loadLocalEnv()

const rawArgs = process.argv.slice(2)
const selfTest = rawArgs.includes(SELF_TEST_FLAG)
const expectInlineResearch = rawArgs.includes(INLINE_RESEARCH_FLAG)
const expectSavedReport = rawArgs.includes(SAVED_REPORT_FLAG)
const positionalArgs = rawArgs.filter(arg => (
  arg !== SELF_TEST_FLAG &&
  arg !== INLINE_RESEARCH_FLAG &&
  arg !== SAVED_REPORT_FLAG
))

if (selfTest) {
  runSelfTest()
  process.exit(0)
}

const baseUrl = (positionalArgs[0] || 'https://agent1-0.vercel.app').replace(/\/$/, '')
const prompt = positionalArgs.slice(1).join(' ').trim()
const path = '/api/internal/agent-smoke'
const secret = process.env.AGENT_INTERNAL_HEALTH_SECRET || process.env.AUTH_SECRET

if (!secret) {
  throw new Error('Missing AGENT_INTERNAL_HEALTH_SECRET or AUTH_SECRET for signed agent smoke request.')
}

const timestamp = Date.now().toString()
const signature = createHmac('sha256', secret)
  .update(`${timestamp}\n${path}`)
  .digest('hex')

const url = new URL(`${baseUrl}${path}`)
if (prompt) url.searchParams.set('prompt', prompt)

const response = await fetch(url, {
  headers: {
    'x-agent-health-ts': timestamp,
    'x-agent-health-signature': signature,
  },
})

const body = await response.text()
let parsedBody = null
try {
  parsedBody = body ? JSON.parse(body) : null
} catch {
  // The response dump below is still useful when a proxy or runtime returns
  // non-JSON, but it must never count as a passing production agent smoke.
}

console.log(JSON.stringify({
  status: response.status,
  body: parsedBody ?? body,
}, null, 2))

const contractFailures = expectInlineResearch
  ? inlineResearchContractFailures(parsedBody)
  : expectSavedReport
    ? savedReportContractFailures(parsedBody)
    : []

if (expectInlineResearch || expectSavedReport) {
  console.log(JSON.stringify({
    contract: expectInlineResearch ? 'inline-research' : 'saved-report',
    ok: contractFailures.length === 0,
    failures: contractFailures,
  }, null, 2))
}

if (!response.ok || parsedBody?.ok !== true || contractFailures.length > 0) {
  process.exitCode = 1
}
