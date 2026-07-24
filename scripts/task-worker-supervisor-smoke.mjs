import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const supervisorEntry = resolve(root, 'scripts/task-worker-supervisor.mjs')
const probeDir = await mkdtemp(join(tmpdir(), 'agent-worker-supervisor-'))
const probeEntry = join(probeDir, 'worker-probe.mjs')
const countFile = join(probeDir, 'boots.txt')
const signalFile = join(probeDir, 'signal.txt')

await writeFile(
  probeEntry,
  `import { readFileSync, writeFileSync } from 'node:fs'

const countFile = process.env.PROBE_COUNT_FILE
const signalFile = process.env.PROBE_SIGNAL_FILE
let bootCount = 0
try {
  bootCount = Number(readFileSync(countFile, 'utf8')) || 0
} catch {}
bootCount += 1
writeFileSync(countFile, String(bootCount))

if (bootCount === 1) process.exit(0)

process.once('SIGTERM', () => {
  writeFileSync(signalFile, 'SIGTERM')
  process.exit(0)
})
setInterval(() => {}, 1_000)
`,
  'utf8',
)

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
const readText = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await wait(50)
  }
  throw new Error(message)
}

let output = ''
let supervisor = null
let supervisorExited = false

try {
  supervisor = spawn(process.execPath, [supervisorEntry], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
      PROBE_COUNT_FILE: countFile,
      PROBE_SIGNAL_FILE: signalFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  supervisor.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  supervisor.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })

  const exitPromise = new Promise((resolveExit) => {
    supervisor.once('exit', (code, signal) => {
      supervisorExited = true
      resolveExit({ code, signal })
    })
  })

  await waitFor(
    async () => Number(await readText(countFile)) >= 2,
    10_000,
    `supervisor did not replace a cleanly exited persistent worker\n${output}`,
  )

  supervisor.kill('SIGTERM')
  const outcome = await Promise.race([
    exitPromise,
    wait(5_000).then(() => {
      throw new Error(`supervisor did not stop after SIGTERM\n${output}`)
    }),
  ])

  assert.equal(outcome.code, 0, `supervisor should stop cleanly after forwarding SIGTERM\n${output}`)
  assert.equal(outcome.signal, null, `supervisor should handle SIGTERM instead of dying from it\n${output}`)
  assert.equal(await readText(signalFile), 'SIGTERM', 'supervisor must forward SIGTERM to its active worker')

  await wait(750)
  assert.equal(Number(await readText(countFile)), 2, 'supervisor must not restart after its own shutdown signal')
  assert.match(output, /Worker exited unexpectedly; restarting/, 'supervisor should report the recovered worker exit')

  console.log('task worker supervisor smoke checks passed')
} finally {
  if (supervisor && !supervisorExited) supervisor.kill('SIGKILL')
  await rm(probeDir, { recursive: true, force: true })
}
