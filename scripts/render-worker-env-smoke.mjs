#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OPTIONAL_TEMPLATE_ONLY_KEYS = new Set([
  'AGENT_DEPLOYMENT_VERSION',
  'AGENT_REQUIRE_WORKER_DEPLOYMENT_VERSION',
  'AGENT_E2B_BROWSER_BOOTSTRAP_COMMAND',
])

function parseValue(raw) {
  const trimmed = String(raw || '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  if (trimmed === 'false') return false
  if (trimmed === 'true') return true
  return trimmed
}

function parseRenderBlueprint(text) {
  const services = []
  let currentService = null
  let inEnvVars = false
  let currentEnvKey = null

  for (const line of text.split(/\r?\n/)) {
    const serviceMatch = line.match(/^  - type:\s*(.+)$/)
    if (serviceMatch) {
      currentService = {
        type: parseValue(serviceMatch[1]),
        env: new Map(),
      }
      services.push(currentService)
      inEnvVars = false
      currentEnvKey = null
      continue
    }

    if (!currentService) continue

    const servicePropMatch = line.match(/^    ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (servicePropMatch) {
      const [, key, value] = servicePropMatch
      if (key === 'envVars') {
        inEnvVars = true
        currentEnvKey = null
      } else {
        currentService[key] = parseValue(value)
        inEnvVars = false
        currentEnvKey = null
      }
      continue
    }

    if (!inEnvVars) continue

    const envKeyMatch = line.match(/^      - key:\s*(.+)$/)
    if (envKeyMatch) {
      currentEnvKey = parseValue(envKeyMatch[1])
      currentService.env.set(currentEnvKey, {})
      continue
    }

    const envPropMatch = line.match(/^        (value|sync):\s*(.+)$/)
    if (envPropMatch && currentEnvKey) {
      const [, key, value] = envPropMatch
      currentService.env.get(currentEnvKey)[key] = parseValue(value)
    }
  }

  return { services }
}

function parseEnvTemplate(text) {
  const env = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    assert.ok(match, `Invalid env template line: ${line}`)
    const [, key, rawValue] = match
    assert.ok(!env.has(key), `Duplicate env template key: ${key}`)
    env.set(key, parseValue(rawValue))
  }
  return env
}

const renderPath = resolve(process.cwd(), 'render.yaml')
const envPath = resolve(process.cwd(), 'render.worker.env.example')
const blueprint = parseRenderBlueprint(readFileSync(renderPath, 'utf8'))
const template = parseEnvTemplate(readFileSync(envPath, 'utf8'))

const worker = blueprint.services.find((service) => service.type === 'worker' && service.name === 'agent-worker')
assert.ok(worker, 'render.yaml must define an agent-worker worker service')
assert.equal(worker.startCommand, 'npm run worker:cloud', 'agent-worker must use the guarded cloud worker command')

for (const [key, renderEnv] of worker.env.entries()) {
  assert.ok(template.has(key), `render.worker.env.example must include ${key}`)
  const templateValue = template.get(key)
  if (renderEnv.sync === false) {
    assert.equal(templateValue, '', `${key} must be blank in render.worker.env.example because Render supplies it as a secret`)
  } else {
    assert.ok('value' in renderEnv, `${key} must define value or sync: false in render.yaml`)
    assert.equal(String(templateValue), String(renderEnv.value), `${key} must match render.yaml agent-worker value`)
  }
}

for (const key of template.keys()) {
  assert.ok(worker.env.has(key) || OPTIONAL_TEMPLATE_ONLY_KEYS.has(key), `${key} exists in render.worker.env.example but not render.yaml agent-worker`)
}

assert.equal(String(template.get('AGENT_TASK_WORKER_MODE')), 'external', 'worker template must force external task worker mode')
assert.equal(String(template.get('AGENT_TASK_QUEUE_NAME')), 'production', 'worker template must use the production queue')
assert.equal(String(template.get('AGENT_SANDBOX_PROVIDER')), 'e2b', 'worker template must enable E2B sandboxes')
assert.equal(String(template.get('E2B_TEMPLATE_ID')), 'agent-cloud-browser', 'worker template must use the included E2B browser template')
assert.equal(String(template.get('AGENT_E2B_PAUSE_ON_TASK_END')), 'true', 'worker template must pause idle E2B sandboxes')

console.log('Render worker env template smoke checks passed')
