#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from './load-local-env.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const args = process.argv.slice(2)
const scriptFiles = {
  'cloud:smoke': 'scripts/cloud-background-contract-smoke.mjs',
  'cloud:reconnect-smoke': 'scripts/cloud-background-reconnect-smoke.mjs',
  'cloud:render-smoke': 'scripts/render-blueprint-smoke.mjs',
  'cloud:worker-template-smoke': 'scripts/render-worker-env-smoke.mjs',
  'cloud:check': 'scripts/cloud-readiness.mjs',
  'cloud:event-smoke': 'scripts/cloud-event-replay-smoke.mjs',
  'cloud:task-start-smoke': 'scripts/cloud-task-start-persistence-smoke.mjs',
  'cloud:worker-lease-smoke': 'scripts/cloud-worker-lease-smoke.mjs',
  'cloud:worker-cancel-smoke': 'scripts/cloud-worker-cancel-smoke.mjs',
  'cloud:worker-shutdown-smoke': 'scripts/cloud-worker-shutdown-smoke.mjs',
  'cloud:worker-supervisor-smoke': 'scripts/task-worker-supervisor-smoke.mjs',
  'cloud:worker-ready': 'scripts/prod-background-worker-ready.mjs',
  'cloud:worker-smoke': 'scripts/prod-background-worker-smoke.mjs',
}

loadLocalEnvFiles(rootUrl)

function readArg(name) {
  const equalPrefix = `${name}=`
  const equalValue = args.find((arg) => arg.startsWith(equalPrefix))
  if (equalValue) return equalValue.slice(equalPrefix.length)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : ''
}

function formatCommand(scriptName, scriptArgs = []) {
  const parts = ['node', scriptFiles[scriptName] || scriptName, ...scriptArgs]
  return parts.map((part) => (/[\s"'$]/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function runNpmScript(label, scriptName, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const scriptFile = scriptFiles[scriptName]
    if (!scriptFile) {
      reject(new Error(`No direct script mapping exists for ${scriptName}`))
      return
    }

    console.log(`\n==> ${label}`)
    console.log(`$ ${formatCommand(scriptName, scriptArgs)}`)

    // Execute with the same Node runtime as the preflight itself. This keeps
    // verification portable in hosts that provide Node without an npm binary.
    const child = spawn(process.execPath, [scriptFile, ...scriptArgs], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${formatCommand(scriptName, scriptArgs)} failed with ${signal || `code ${code}`}`))
      }
    })
  })
}

const sourceOnly = args.includes('--source-only')
const deployedOnly = args.includes('--deployed-only')
const deployedUrl = readArg('--url') || readArg('--deployed-url')
const timeoutMs = readArg('--timeout-ms')

const deployedArgs = deployedUrl ? [deployedUrl] : []
if (timeoutMs) deployedArgs.push('--timeout-ms', timeoutMs)

try {
  if (deployedOnly) {
    if (!deployedUrl) {
      throw new Error('Pass --url https://your-deployed-app.example with --deployed-only.')
    }
    await runNpmScript('Deployed worker readiness', 'cloud:worker-ready', deployedArgs)
    await runNpmScript('Deployed closed-tab worker smoke', 'cloud:worker-smoke', deployedArgs)
    console.log('\nDeployed-only cloud preflight passed. Closed-tab worker execution is live on the deployed app.')
    process.exit(0)
  }

  await runNpmScript('Source contract smoke', 'cloud:smoke')
  await runNpmScript('Closed-tab reconnect smoke', 'cloud:reconnect-smoke')
  await runNpmScript('Render blueprint consistency smoke', 'cloud:render-smoke')
  await runNpmScript('Render worker env template consistency smoke', 'cloud:worker-template-smoke')

  if (sourceOnly) {
    console.log('\nSource-only preflight passed. Runtime checks were skipped by --source-only.')
    process.exit(0)
  }

  await runNpmScript('Cloud env and artifact readiness', 'cloud:check')
  await runNpmScript('Oversized event replay persistence smoke', 'cloud:event-smoke')
  await runNpmScript('Immediate-close task history persistence smoke', 'cloud:task-start-smoke')
  await runNpmScript('Worker stale-lease recovery smoke', 'cloud:worker-lease-smoke')
  await runNpmScript('Worker cancellation terminal-state smoke', 'cloud:worker-cancel-smoke')
  await runNpmScript('Worker graceful-shutdown handoff smoke', 'cloud:worker-shutdown-smoke')
  await runNpmScript('Worker supervisor recovery smoke', 'cloud:worker-supervisor-smoke')

  if (deployedUrl) {
    await runNpmScript('Deployed worker readiness', 'cloud:worker-ready', deployedArgs)
    await runNpmScript('Deployed closed-tab worker smoke', 'cloud:worker-smoke', deployedArgs)
    console.log('\nCloud preflight passed, including deployed closed-tab worker execution.')
  } else {
    console.log('\nPre-deploy cloud preflight passed.')
    console.log('After deployment, rerun with: npm run cloud:preflight -- --deployed-only --url https://your-deployed-app.example')
  }
} catch (error) {
  console.error(`\nCloud preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error('Fix the failing step above, then rerun npm run cloud:preflight.')
  process.exitCode = 1
}
