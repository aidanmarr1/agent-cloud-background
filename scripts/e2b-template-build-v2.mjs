#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Template, defaultBuildLogger } from 'e2b'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)

loadLocalEnvFiles(rootUrl)

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function env(name) {
  return process.env[name]?.trim() || ''
}

const name = readArg('--name') || env('E2B_TEMPLATE_ID') || 'agent-cloud-browser'
const dockerfile = readArg('--dockerfile') || 'e2b.Dockerfile'
const apiKey = env('E2B_API_KEY')

if (!apiKey) {
  throw new Error('E2B_API_KEY is required to build the E2B template.')
}

const dockerfileContent = await readFile(`${root}/${dockerfile}`, 'utf8')
const template = Template().fromDockerfile(dockerfileContent)

console.log(`Building E2B template ${name} from ${dockerfile}.`)
console.log('Secret values are not printed.')

const buildInfo = await Template.build(template, name, {
  cpuCount: Number.parseInt(readArg('--cpu') || env('E2B_TEMPLATE_BUILD_CPU') || '2', 10),
  memoryMB: Number.parseInt(readArg('--memory-mb') || env('E2B_TEMPLATE_BUILD_MEMORY_MB') || '2048', 10),
  apiKey,
  onBuildLogs: defaultBuildLogger(),
})

console.log(JSON.stringify({
  ok: true,
  name: buildInfo.name,
  templateId: buildInfo.templateId,
  buildId: buildInfo.buildId,
}, null, 2))
