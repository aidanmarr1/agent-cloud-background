#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(projectRoot, '.next', 'dev', 'lock')
const nextBin = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next')

const rawArgs = process.argv.slice(2)
const mode = rawArgs.includes('--stop')
  ? 'stop'
  : rawArgs.includes('--restart')
    ? 'restart'
    : 'start'

const parsed = parseArgs(rawArgs.filter((arg) => !['--stop', '--restart'].includes(arg)))
const hostname = parsed.hostname || '127.0.0.1'
const port = parsed.port || '3000'

function parseArgs(args) {
  const result = { hostname: '', port: '', passthrough: [] }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const readValue = () => {
      const value = args[i + 1]
      i += 1
      return value
    }

    if (arg === '--') continue
    if (arg === '--hostname' || arg === '--host' || arg === '-H') {
      result.hostname = readValue()
      continue
    }
    if (arg.startsWith('--hostname=')) {
      result.hostname = arg.slice('--hostname='.length)
      continue
    }
    if (arg.startsWith('--host=')) {
      result.hostname = arg.slice('--host='.length)
      continue
    }
    if (arg === '--port' || arg === '-p') {
      result.port = readValue()
      continue
    }
    if (arg.startsWith('--port=')) {
      result.port = arg.slice('--port='.length)
      continue
    }

    result.passthrough.push(arg)
  }

  return result
}

function readLock() {
  if (!existsSync(lockPath)) return null
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return { pid: null, unreadable: true }
  }
}

function removeLock(reason) {
  if (!existsSync(lockPath)) return
  rmSync(lockPath, { force: true })
  console.log(`Removed stale Next dev lock (${reason}).`)
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function pidsListeningOnPort(targetPort) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0 || !result.stdout.trim()) return []

  const pids = new Set()
  for (const line of result.stdout.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    const pid = Number(fields[1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

function stopPid(pid, label) {
  if (!pidIsAlive(pid)) return

  console.log(`Stopping ${label} (pid ${pid})...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code === 'EPERM') {
      console.error(`Unable to stop ${label} (pid ${pid}): permission denied by this environment.`)
      console.error('Run this command from a normal terminal, or stop the process manually and retry.')
      process.exit(1)
    }
    if (error?.code !== 'ESRCH') throw error
  }

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }

  if (pidIsAlive(pid)) {
    console.log(`Force stopping ${label} (pid ${pid})...`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error?.code === 'EPERM') {
        console.error(`Unable to stop ${label} (pid ${pid}): permission denied by this environment.`)
        console.error('Run this command from a normal terminal, or stop the process manually and retry.')
        process.exit(1)
      }
      throw error
    }
  }
}

function stopExistingServer(lock) {
  const lockPid = Number(lock?.pid)
  if (pidIsAlive(lockPid)) {
    stopPid(lockPid, 'project dev server')
  }

  for (const pid of pidsListeningOnPort(port)) {
    if (pid !== lockPid) stopPid(pid, `process on port ${port}`)
  }

  removeLock('server stopped')
}

function prepareStart() {
  const lock = readLock()
  const lockPid = Number(lock?.pid)
  const listeners = pidsListeningOnPort(port)
  const lockOwnsPort = listeners.includes(lockPid)

  if (mode === 'stop') {
    stopExistingServer(lock)
    console.log(`Dev server stopped for port ${port}.`)
    process.exit(0)
  }

  if (mode === 'restart') {
    stopExistingServer(lock)
    return
  }

  if (lock && lockOwnsPort) {
    console.log(`Dev server already running at http://${hostname}:${port} (pid ${lockPid}).`)
    console.log('Use `npm run dev:restart` to force a restart.')
    process.exit(0)
  }

  if (lock && (!pidIsAlive(lockPid) || listeners.length === 0)) {
    removeLock('recorded process is not serving this port')
    return
  }

  if (lock && !lockOwnsPort) {
    removeLock('recorded process does not own the configured port')
  }

  const remainingListeners = pidsListeningOnPort(port)
  if (remainingListeners.length > 0) {
    console.error(`Port ${port} is already in use by pid(s): ${remainingListeners.join(', ')}.`)
    console.error('Use `npm run dev:restart` if this is the project dev server.')
    process.exit(1)
  }
}

prepareStart()

if (!existsSync(nextBin)) {
  console.error('Next.js binary was not found. Run `npm install` first.')
  process.exit(1)
}

const nextArgs = [
  nextBin,
  'dev',
  '--webpack',
  '--disable-source-maps',
  '--hostname',
  hostname,
  '--port',
  port,
  ...parsed.passthrough,
]

const child = spawn(process.execPath, nextArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
})

function forwardSignal(signal) {
  if (!child.killed) child.kill(signal)
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
