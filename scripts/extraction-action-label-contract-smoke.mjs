import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const [prompts, tools, toolRegistry, toolPipeline, planManager, legacyActionPill] = await Promise.all([
  readFile(`${root}/src/lib/prompts.ts`, 'utf8'),
  readFile(`${root}/src/lib/tools.ts`, 'utf8'),
  readFile(`${root}/src/lib/toolRegistry.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/ToolPipeline.ts`, 'utf8'),
  readFile(`${root}/src/lib/agent/PlanManager.ts`, 'utf8'),
  readFile(`${root}/src/components/chat/ActionPill.tsx`, 'utf8'),
])

assert.match(
  prompts,
  /Use a clear active verb-led phrase[\s\S]*verb \+ concrete object or purpose[\s\S]*one shared house style[\s\S]*silently compare each new label with the recent visible labels[\s\S]*reuse the same lead verb, syntax, and level of specificity for actions that serve the same semantic purpose[\s\S]*Do not rotate among synonyms merely for variety[\s\S]*without reserving or forcing one keyword for a tool[\s\S]*The model authors every label from context; no tool-to-label mapping or deterministic fallback supplies its wording/,
  'the model prompt must preserve natural action-label wording within a coherent house style',
)
assert.match(
  tools,
  /Model-authored visible action pill text[\s\S]*match the wording pattern and specificity of recent labels that serve the same purpose[\s\S]*Do not use a fixed tool mapping/,
  'every model-visible tool schema must reinforce the shared model-authored label style',
)
assert.doesNotMatch(
  prompts,
  /label MUST begin with "Extract"|Do not label webpage extraction as/,
  'the model prompt must not force a deterministic extraction verb',
)
assert.match(
  tools,
  /name: 'read_document',[\s\S]*description: 'Extract PDF, DOCX, webpage, or text content from one concrete URL\/workspace path\.[\s\S]*required url field\.[\s\S]*required: \['url'\]/,
  'URL document extraction schema must carry the canonical URL contract',
)
assert.doesNotMatch(
  tools,
  /name: 'read_document',[\s\S]{0,800}required: \['source'\]/,
  'the model-visible document schema must not ask for a conflicting source key',
)
assert.match(
  prompts,
  /For read_document, copy the exact concrete search-result\/page address into its required url field/,
  'the research prompt must tell the model to preserve the concrete selected result URL',
)
assert.match(
  toolRegistry,
  /register\('read_document', \{[\s\S]*requiredOneOf: \['url', 'source'\],[\s\S]*typeof args\.url === 'string'/,
  'runtime execution must use canonical url while accepting only legacy in-flight source calls for compatibility',
)
assert.match(
  toolPipeline,
  /read_document: \{[\s\S]*allowedKeys: new Set\(\['action_label', 'plan_step_index', 'url'\]\),[\s\S]*requiredStringKey: 'url'/,
  'stream repair must use the same canonical read_document URL contract as the model schema',
)
assert.match(
  tools,
  /name: 'browser_get_content',[\s\S]*description: 'Extract rendered text from the current webpage\.'/,
  'current-page content extraction must remain clearly described without constraining the label wording',
)
assert.doesNotMatch(
  tools,
  /action_label must begin with "Extract"/,
  'tool descriptions must not force extraction-label wording',
)
assert.doesNotMatch(
  toolPipeline,
  /Rerouted web_search to direct navigation/,
  'the runtime must not silently change the tool while preserving a differently authored label',
)
assert.doesNotMatch(
  planManager,
  /action_label:\s*step\.visualInput\s*\?/,
  'preloaded system context must not invent a visible action label on the model’s behalf',
)
assert.match(
  legacyActionPill,
  /const label = action\.label[\s\S]*if \(!label\) return null/,
  'legacy task actions must render only a historically persisted model label',
)
assert.doesNotMatch(
  legacyActionPill,
  /Searching…|Browsing…|new URL\(action\.url\)|browseResult\?\.title/,
  'legacy task actions must not synthesize wording from queries, URLs, or result titles',
)

console.log('extraction action-label contract smoke: PASS')
