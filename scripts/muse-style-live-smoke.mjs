#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = process.cwd()
loadLocalEnvFiles(rootUrl)

assert.ok(process.env.OPENROUTER_API_KEY?.trim(), 'OPENROUTER_API_KEY is required')

const request = 'Research Warmwind OS AI launch, architecture and current capabilities using authoritative evidence, then deliver a concise sourced assessment.'
const workDir = await mkdtemp('/tmp/muse-style-live-smoke-')
const bundlePath = join(workDir, 'probe.mjs')

function parseJsonObject(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    return start >= 0 && end > start ? JSON.parse(cleaned.slice(start, end + 1)) : null
  }
}

function toolArgs(response) {
  const raw = response?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  return raw ? JSON.parse(raw) : null
}

try {
  await build({
    stdin: {
      contents: `
        import { createCompletion } from ${JSON.stringify(join(root, 'src/lib/llm.ts'))}
        import { getFastPlanningPrompt, getSystemPrompt } from ${JSON.stringify(join(root, 'src/lib/prompts.ts'))}

        const reasoning = { effort: 'minimal', exclude: true }
        const systemPrompt = getSystemPrompt()
        const actionLabel = {
          type: 'string',
          description: 'Model-authored visible action pill text, usually 3-24 words. Start with a capital letter and do not end with a period. Name the concrete subject plus the evidence, state, artifact, or verification sought; for a known source, include the fact being extracted rather than merely saying to open/read a page. Match the wording pattern and specificity of recent labels serving the same purpose. Do not use a fixed tool mapping, local template, tool name, raw query/source/path, or generic wording such as Open article or Find details on page.',
        }
        const webSearch = {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Discover candidate webpages from a topical text query. Returns titles, snippets, and URLs.',
            parameters: {
              type: 'object',
              properties: {
                action_label: actionLabel,
                plan_step_index: { type: 'number', minimum: 1, description: 'Active plan step, 1-based.' },
                query: { type: 'string', description: 'Topical search terms only, never a URL' },
              },
              required: ['action_label', 'plan_step_index', 'query'],
            },
          },
        }

        export async function runStyleProbe(request) {
          const planner = await createCompletion({
            messages: [
              { role: 'system', content: getFastPlanningPrompt() },
              { role: 'user', content: request },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.25,
            max_tokens: 760,
            includeTemporalContext: false,
            requestTimeoutMs: 60_000,
            retryMaxAttempts: 0,
            reasoning,
          })

          const action = await createCompletion({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: request },
              {
                role: 'system',
                content: 'PLAN PROGRESS:\\n\u2192 [NOW] 1. Establish Warmwind OS AI launch, architecture and capabilities\\n  [    ] 2. Synthesize the sourced assessment\\n\\nCurrent phase scope: Locate authoritative evidence that establishes the product scope, launch details and architecture. Start with the actual evidence gathering and make one concrete native action now.',
              },
            ],
            tools: [webSearch],
            tool_choice: { type: 'function', function: { name: 'web_search' } },
            parallel_tool_calls: false,
            temperature: 0.25,
            max_tokens: 640,
            includeTemporalContext: false,
            requestTimeoutMs: 60_000,
            retryMaxAttempts: 0,
            reasoning,
          })

          const cadenceTools = [{
            ...webSearch,
            function: {
              ...webSearch.function,
              parameters: {
                ...webSearch.function.parameters,
                properties: {
                  progress_update: {
                    type: 'string',
                    description: 'Required cadence field. Lead with a fact-dense outcome from already-completed work and continue naturally from what the user has seen. Preserve material uncertainty. An immediate direction may follow when it helps orient continuing work, but do not force a second sentence, stock opening, or transition. Direct factual subjects, first-person confirmations, concise review/finding leads, and concrete source-action leads are all valid when they carry the result. The current action has not returned and is not evidence.',
                    minLength: 1,
                    maxLength: 360,
                  },
                  ...webSearch.function.parameters.properties,
                },
                required: ['action_label', 'plan_step_index', 'query', 'progress_update'],
              },
            },
          }]
          const narration = await createCompletion({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: request },
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ action_label: 'Locate primary sources defining Warmwind OS AI and its launch', plan_step_index: 1, query: 'Warmwind OS AI official launch architecture' }) } }],
              },
              { role: 'tool', tool_call_id: 'call_1', content: 'The official product announcement describes an AI-native operating system that can control applications directly and was introduced as a new computing interface.' },
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ action_label: 'Extract Warmwind OS launch timing and stated availability', plan_step_index: 1, query: 'Warmwind OS launch availability official announcement' }) } }],
              },
              { role: 'tool', tool_call_id: 'call_2', content: 'The launch materials establish the initial announcement and limited early-access positioning, but do not substantiate broad public availability.' },
              {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ action_label: 'Compare documented Warmwind OS architecture and control model', plan_step_index: 1, query: 'Warmwind OS AI architecture application control model' }) } }],
              },
              { role: 'tool', tool_call_id: 'call_3', content: 'Across the available documentation, the core claim is direct application control through an agent-oriented interface; detailed independent architectural validation remains limited.' },
              {
                role: 'system',
                content: 'CADENCE ACTION TURN: make one concrete native tool call. In required progress_update, lead with the concrete newest outcome from preceding evidence, preserve the limited independent validation, and continue naturally. Add an immediate direction only if useful. Vary the syntax; do not copy a fixed opening, transition, or sentence count. The update appears before the pending action, so do not claim its result.',
              },
            ],
            tools: cadenceTools,
            tool_choice: { type: 'function', function: { name: 'web_search' } },
            parallel_tool_calls: false,
            temperature: 0.25,
            max_tokens: 760,
            includeTemporalContext: false,
            requestTimeoutMs: 60_000,
            retryMaxAttempts: 0,
            reasoning,
          })

          return { planner, action, narration }
        }
      `,
      resolveDir: root,
      sourcefile: 'muse-style-probe.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const probe = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  const result = await probe.runStyleProbe(request)
  const plan = parseJsonObject(result.planner?.choices?.[0]?.message?.content)
  const action = toolArgs(result.action)
  const narration = toolArgs(result.narration)
  const ack = String(plan?.ack || '').trim()
  const planSteps = Array.isArray(plan?.steps) ? plan.steps : []
  const planTitles = planSteps.map((step) => String(step?.title || step || '').trim()).filter(Boolean)
  const firstTitle = planTitles[0] || ''
  const finalTitle = planTitles.at(-1) || ''
  const actionLabel = String(action?.action_label || '').trim()
  const progressUpdate = String(narration?.progress_update || '').trim()
  const nextActionLabel = String(narration?.action_label || '').trim()

  assert.match(String(result.planner?.model || ''), /^google\/gemini-3\.7-flash(?:-\d+)?$/)
  assert.match(String(result.planner?.provider || ''), /^Google$/i)
  assert.match(ack, /^(?:I(?:'|’)?ll|I will)\b/, 'planner acknowledgement must begin with a first-person commitment')
  assert.ok(planTitles.length >= 2, 'non-trivial research should expose more than one meaningful visible module')
  assert.doesNotMatch(firstTitle, /^(?:Clarify|Define|Scope|Map|Frame)\b/i, 'first plan phase must begin actual task work')
  assert.notEqual(finalTitle.toLowerCase(), firstTitle.toLowerCase(), 'the final planner module must represent a distinct completion outcome')
  assert.doesNotMatch(finalTitle, /^(?:Finish|Complete|Deliver|Finalize|Wrap up)(?: the)?(?: task|results?)?$/i, 'the final planner module must not be a context-free handoff label')
  assert.ok(planTitles.every(title => !/^(?:Open|Read|Search|Browse|Visit|Click)\b/i.test(title)), 'visible planner modules must group source/tool micro-actions beneath meaningful workstreams')
  assert.ok(actionLabel.split(/\s+/).length >= 3, 'action label must be a specific mini-objective')
  assert.doesNotMatch(actionLabel, /^(?:Open article|Find details on page|Read page)$/i)
  assert.ok(actionLabel.length > 32, 'action label must retain useful target and evidence detail')
  assert.match(progressUpdate, /\b(?:AI-native|application control|agent-oriented|availability|architecture|validation|Warmwind OS)\b/i, 'progress narration must carry a concrete result from completed evidence')
  assert.doesNotMatch(progressUpdate, /\b(?:prior|previous|earlier) sources?\b|\b(?:sources|research) (?:reviewed )?so far\b/i, 'progress narration must not substitute vague deictic source framing for the result')
  assert.doesNotMatch(progressUpdate, /^(?:Searched|Opened|Read|Reviewed|Visited|Checked)\b[^.;!?]*[.!]?$/i, 'progress narration must not be only a tool-operation status')
  assert.ok(nextActionLabel.split(/\s+/).length >= 3, 'the cadence action must retain its own specific mini-objective')

  console.log(JSON.stringify({
    ok: true,
    model: result.planner?.model,
    provider: result.planner?.provider,
    ack,
    planTitles,
    actionLabel,
    progressUpdate,
    nextActionLabel,
  }, null, 2))
} finally {
  await rm(workDir, { recursive: true, force: true })
}
