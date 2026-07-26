import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const supervisorEntry = resolve(root, 'scripts/task-worker-supervisor.mjs')
const probeDir = await mkdtemp(join(tmpdir(), 'agent-worker-supervisor-'))
const probeEntry = join(probeDir, 'worker-probe.mjs')
const onceFile = join(probeDir, 'once-slot.txt')

await writeFile(
  probeEntry,
  `import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const slot = process.env.AGENT_TASK_WORKER_SUPERVISOR_SLOT
const countFile = join(process.env.PROBE_DIR, \`boots-\${slot}.txt\`)
const signalFile = join(process.env.PROBE_DIR, \`signal-\${slot}.txt\`)
if (process.argv.includes('--once')) {
  writeFileSync(process.env.PROBE_ONCE_FILE, slot)
  process.exit(7)
}

let bootCount = 0
try {
  bootCount = Number(readFileSync(countFile, 'utf8')) || 0
} catch {}
bootCount += 1
writeFileSync(countFile, String(bootCount))

if (bootCount === 1) {
  setTimeout(() => process.exit(0), Number(slot) * 50)
} else {
  process.once('SIGTERM', () => {
    writeFileSync(signalFile, 'SIGTERM')
    process.exit(0)
  })
  setInterval(() => {}, 1_000)
}
`,
  'utf8',
)

const countFile = (slot) => join(probeDir, `boots-${slot}.txt`)
const signalFile = (slot) => join(probeDir, `signal-${slot}.txt`)

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
      AGENT_TASK_WORKER_CONCURRENCY: '2',
      PROBE_DIR: probeDir,
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
    async () => (
      Number(await readText(countFile(1))) >= 2 &&
      Number(await readText(countFile(2))) >= 2
    ),
    10_000,
    `supervisor did not independently replace both cleanly exited workers\n${output}`,
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
  assert.equal(await readText(signalFile(1)), 'SIGTERM', 'supervisor must forward SIGTERM to worker slot 1')
  assert.equal(await readText(signalFile(2)), 'SIGTERM', 'supervisor must forward SIGTERM to worker slot 2')

  await wait(750)
  assert.equal(Number(await readText(countFile(1))), 2, 'worker slot 1 must not restart after supervisor shutdown')
  assert.equal(Number(await readText(countFile(2))), 2, 'worker slot 2 must not restart after supervisor shutdown')
  assert.match(output, /Starting 2 isolated worker processes/, 'supervisor should report its configured process-pool size')
  assert.match(output, /Worker exited unexpectedly; restarting[\s\S]*slot:\s*1/, 'supervisor should report slot 1 recovery')
  assert.match(output, /Worker exited unexpectedly; restarting[\s\S]*slot:\s*2/, 'supervisor should report slot 2 recovery')

  const oneShot = spawn(process.execPath, [supervisorEntry, '--once'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
      AGENT_TASK_WORKER_CONCURRENCY: '2',
      PROBE_DIR: probeDir,
      PROBE_ONCE_FILE: onceFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let oneShotOutput = ''
  oneShot.stdout.on('data', (chunk) => {
    oneShotOutput += chunk.toString()
  })
  oneShot.stderr.on('data', (chunk) => {
    oneShotOutput += chunk.toString()
  })
  const oneShotOutcome = await new Promise((resolveExit) => {
    oneShot.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(oneShotOutcome.code, 7, `one-shot supervisor must return its sole worker's exit code\n${oneShotOutput}`)
  assert.equal(oneShotOutcome.signal, null, `one-shot supervisor should exit normally\n${oneShotOutput}`)
  assert.equal(await readText(onceFile), '1', 'one-shot mode must launch exactly worker slot 1')
  assert.match(oneShotOutput, /Starting 1 isolated worker process\./, 'one-shot mode must ignore persistent pool concurrency')

  console.log('task worker supervisor smoke checks passed')
} finally {
  if (supervisor && !supervisorExited) supervisor.kill('SIGKILL')
  await rm(probeDir, { recursive: true, force: true })
}
