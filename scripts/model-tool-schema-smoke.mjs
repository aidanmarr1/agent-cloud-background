import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
process.env.AGENT_SANDBOX_PROVIDER = 'e2b'
process.env.E2B_API_KEY = 'schema-smoke-key'
const { toolDefinitions: original } = await import('../src/lib/tools.ts')
const { compactToolDefinitionsForModel } = await import('../src/lib/agent/ModelToolSchemas.ts')
const compact = compactToolDefinitionsForModel(original)

const stripDescriptions = (value) => {
  if (Array.isArray(value)) return value.map(stripDescriptions)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, nested]) => [key, stripDescriptions(nested)]),
  )
}

const names = (tools) => tools.map((tool) => tool.function?.name)
assert.equal(original.length, 29, 'the full cloud tool menu must remain available')
assert.deepEqual(names(compact), names(original), 'schema compaction must not add, remove, reorder, or rename tools')

for (let index = 0; index < original.length; index += 1) {
  assert.deepEqual(
    stripDescriptions(compact[index].function?.parameters),
    stripDescriptions(original[index].function?.parameters),
    `${names(original)[index]} argument shape and validation constraints must remain unchanged`,
  )
  assert.ok(
    (compact[index].function?.description || '').length <= 130,
    `${names(original)[index]} needs a concise model-facing description`,
  )
}

const originalBytes = Buffer.byteLength(JSON.stringify(original))
const compactBytes = Buffer.byteLength(JSON.stringify(compact))
assert.ok(compactBytes <= originalBytes * 0.65, 'base model-facing schemas should remove at least 35% of static bytes')

const modelToolSchemas = await readFile(join(root, 'src/lib/agent/ModelToolSchemas.ts'), 'utf8')
for (const name of names(original)) {
  assert.match(modelToolSchemas, new RegExp(`\\b${name}:`), `${name} needs an intentional compact model-facing description`)
}

const narrationMemory = await readFile(join(root, 'src/lib/agent/NarrationMemory.ts'), 'utf8')
const cadenceDescription = narrationMemory.match(/description:\s*'((?:\\.|[^'])*)',\s*\n\s*minLength:\s*1/)?.[1] || ''
assert.ok(cadenceDescription.length > 0 && cadenceDescription.length < 180, 'cadence schema guidance must stay concise because it is repeated across every tool')
const cadenceFieldBytes = Buffer.byteLength(JSON.stringify({
  progress_update: {
    type: 'string',
    description: cadenceDescription,
    minLength: 1,
    maxLength: 360,
  },
}))
assert.ok(cadenceFieldBytes * compact.length < 6_000, 'cadence schema overhead must remain bounded across the complete tool menu')

console.log(JSON.stringify({
  tools: original.length,
  originalBytes,
  compactBytes,
  reductionPercent: Math.round((1 - compactBytes / originalBytes) * 100),
  cadenceFieldBytesAcrossTools: cadenceFieldBytes * compact.length,
}, null, 2))
