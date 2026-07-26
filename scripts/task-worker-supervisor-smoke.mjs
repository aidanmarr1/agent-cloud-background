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
const drainBootsFile = join(probeDir, 'drain-boots.txt')
const drainArgsFile = join(probeDir, 'drain-args.txt')
const boundedDrainBootsFile = join(probeDir, 'bounded-drain-boots.txt')
const timedOutDrainBootsFile = join(probeDir, 'timed-out-drain-boots.txt')
const timedOutDrainSignalFile = join(probeDir, 'timed-out-drain-signal.txt')

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
if (process.argv.includes('--drain')) {
  let drainBoots = 0
  try {
    drainBoots = Number(readFileSync(process.env.PROBE_DRAIN_BOOTS_FILE, 'utf8')) || 0
  } catch {}
  drainBoots += 1
  writeFileSync(process.env.PROBE_DRAIN_BOOTS_FILE, String(drainBoots))
  writeFileSync(process.env.PROBE_DRAIN_ARGS_FILE, JSON.stringify({ slot, args: process.argv.slice(2) }))
  if (process.env.PROBE_DRAIN_HANG === 'true') {
    process.once('SIGTERM', () => {
      writeFileSync(process.env.PROBE_DRAIN_SIGNAL_FILE, 'SIGTERM')
    })
    setInterval(() => {}, 1_000)
  } else {
    if (drainBoots <= Number(process.env.PROBE_DRAIN_FAILURES || 0)) process.exit(9)
    process.exit(0)
  }
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
      AGENT_TASK_WORKER_DRAIN_MAX_RUNTIME_MS: 'invalid-but-unused-outside-drain',
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

  const drain = spawn(process.execPath, [supervisorEntry, '--drain', '--run-id', 'target-run-123'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
      AGENT_TASK_WORKER_CONCURRENCY: '2',
      AGENT_TASK_WORKER_DRAIN_MAX_RESTARTS: '2',
      PROBE_DIR: probeDir,
      PROBE_DRAIN_BOOTS_FILE: drainBootsFile,
      PROBE_DRAIN_ARGS_FILE: drainArgsFile,
      PROBE_DRAIN_FAILURES: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let drainOutput = ''
  drain.stdout.on('data', (chunk) => {
    drainOutput += chunk.toString()
  })
  drain.stderr.on('data', (chunk) => {
    drainOutput += chunk.toString()
  })
  const drainOutcome = await new Promise((resolveExit) => {
    drain.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(drainOutcome.code, 0, `targeted drain must recover from bounded child crashes\n${drainOutput}`)
  assert.equal(drainOutcome.signal, null, `targeted drain should exit normally after recovery\n${drainOutput}`)
  assert.equal(Number(await readText(drainBootsFile)), 3, 'targeted drain must launch once plus its two allowed restarts')
  assert.deepEqual(
    JSON.parse(await readText(drainArgsFile)),
    { slot: '1', args: ['--drain', '--run-id', 'target-run-123'] },
    'targeted drain must use one slot and forward its exact run id',
  )
  assert.match(drainOutput, /Targeted drain crashed; restarting/, 'targeted drain must report crash recovery')

  const boundedDrain = spawn(process.execPath, [supervisorEntry, '--drain', '--run-id=bounded-run'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
      AGENT_TASK_WORKER_CONCURRENCY: '2',
      AGENT_TASK_WORKER_DRAIN_MAX_RESTARTS: '1',
      PROBE_DIR: probeDir,
      PROBE_DRAIN_BOOTS_FILE: boundedDrainBootsFile,
      PROBE_DRAIN_ARGS_FILE: drainArgsFile,
      PROBE_DRAIN_FAILURES: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let boundedDrainOutput = ''
  boundedDrain.stdout.on('data', (chunk) => {
    boundedDrainOutput += chunk.toString()
  })
  boundedDrain.stderr.on('data', (chunk) => {
    boundedDrainOutput += chunk.toString()
  })
  const boundedDrainOutcome = await new Promise((resolveExit) => {
    boundedDrain.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(boundedDrainOutcome.code, 9, `targeted drain must return the child failure after exhausting restarts\n${boundedDrainOutput}`)
  assert.equal(boundedDrainOutcome.signal, null, `exhausted targeted drain should exit normally\n${boundedDrainOutput}`)
  assert.equal(Number(await readText(boundedDrainBootsFile)), 2, 'one allowed restart must cap targeted drain at two launches')
  assert.match(
    boundedDrainOutput,
    /Targeted drain exhausted its crash restart budget/,
    'targeted drain must report bounded restart exhaustion',
  )

  const timedOutDrain = spawn(process.execPath, [supervisorEntry, '--drain', '--run-id', 'hung-run'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
      AGENT_TASK_WORKER_DRAIN_MAX_RESTARTS: '8',
      AGENT_TASK_WORKER_DRAIN_MAX_RUNTIME_MS: '250',
      PROBE_DIR: probeDir,
      PROBE_DRAIN_BOOTS_FILE: timedOutDrainBootsFile,
      PROBE_DRAIN_ARGS_FILE: drainArgsFile,
      PROBE_DRAIN_HANG: 'true',
      PROBE_DRAIN_SIGNAL_FILE: timedOutDrainSignalFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let timedOutDrainOutput = ''
  timedOutDrain.stdout.on('data', (chunk) => {
    timedOutDrainOutput += chunk.toString()
  })
  timedOutDrain.stderr.on('data', (chunk) => {
    timedOutDrainOutput += chunk.toString()
  })
  const timedOutDrainOutcome = await new Promise((resolveExit) => {
    timedOutDrain.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.equal(timedOutDrainOutcome.code, 124, `timed-out drain must exit nonzero for durable recovery\n${timedOutDrainOutput}`)
  assert.equal(timedOutDrainOutcome.signal, null, `timed-out drain supervisor should exit normally\n${timedOutDrainOutput}`)
  assert.equal(Number(await readText(timedOutDrainBootsFile)), 1, 'the wall-clock backstop must stop the drain before any restart')
  assert.equal(await readText(timedOutDrainSignalFile), 'SIGTERM', 'the wall-clock backstop must terminate its active child')
  assert.match(
    timedOutDrainOutput,
    /Targeted drain exceeded its hard wall-clock runtime limit; terminating its worker/,
    'timed-out drain must report the cost backstop',
  )

  for (const invalidRuntimeMs of ['0', '21600001']) {
    const invalidDrainLimit = spawn(process.execPath, [supervisorEntry, '--drain', '--run-id', 'invalid-limit-run'], {
      cwd: root,
      env: {
        ...process.env,
        AGENT_TASK_WORKER_SUPERVISOR_ENTRY: probeEntry,
        AGENT_TASK_WORKER_DRAIN_MAX_RUNTIME_MS: invalidRuntimeMs,
        PROBE_DIR: probeDir,
        PROBE_DRAIN_BOOTS_FILE: timedOutDrainBootsFile,
        PROBE_DRAIN_ARGS_FILE: drainArgsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let invalidDrainLimitOutput = ''
    invalidDrainLimit.stdout.on('data', (chunk) => {
      invalidDrainLimitOutput += chunk.toString()
    })
    invalidDrainLimit.stderr.on('data', (chunk) => {
      invalidDrainLimitOutput += chunk.toString()
    })
    const invalidDrainLimitOutcome = await new Promise((resolveExit) => {
      invalidDrainLimit.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    assert.notEqual(
      invalidDrainLimitOutcome.code,
      0,
      `targeted drain must reject out-of-range wall-clock limit ${invalidRuntimeMs}`,
    )
    assert.match(
      invalidDrainLimitOutput,
      /AGENT_TASK_WORKER_DRAIN_MAX_RUNTIME_MS must be between 1 and 21600000/,
      'targeted drain must explain the bounded positive wall-clock contract',
    )
  }

  console.log('task worker supervisor smoke checks passed')
} finally {
  if (supervisor && !supervisorExited) supervisor.kill('SIGKILL')
  await rm(probeDir, { recursive: true, force: true })
}
