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

await runTaskWorker({
  once: process.argv.includes('--once'),
}).catch((error) => {
  console.error('[TaskWorker] Fatal error:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
