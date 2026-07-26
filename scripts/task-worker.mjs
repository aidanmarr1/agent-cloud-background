#!/usr/bin/env node

import { createJiti } from 'jiti'
import { fileURLToPath } from 'url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const srcPath = fileURLToPath(new URL('../src', import.meta.url))

loadLocalEnvFiles(rootUrl)

const jiti = createJiti(import.meta.url, {
  alias: {
    '@': srcPath,
  },
})

const { runTaskWorker } = await jiti.import(fileURLToPath(new URL('src/worker/taskWorker.ts', rootUrl)))

function parseRunId(args) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--run-id') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--run-id requires a value.')
      values.push(value)
      index += 1
      continue
    }
    if (argument.startsWith('--run-id=')) {
      values.push(argument.slice('--run-id='.length))
    }
  }
  if (values.length > 1) throw new Error('--run-id may only be provided once.')
  const runId = values[0]?.trim() || ''
  if (runId && !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) {
    throw new Error('--run-id must contain 1-128 letters, numbers, underscores, or hyphens.')
  }
  return runId || undefined
}

const args = process.argv.slice(2)
const options = {
  once: args.includes('--once'),
  drain: args.includes('--drain'),
  runId: parseRunId(args),
}

await runTaskWorker(options).catch((error) => {
  console.error('[TaskWorker] Fatal error:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
