import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const tursoSourcePath = fileURLToPath(new URL('../src/lib/db/turso.ts', import.meta.url))
const tursoSource = await readFile(tursoSourcePath, 'utf8')

function deferred() {
  let resolve
  const promise = new Promise((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function settlesBefore(promise, timeoutMs = 100) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const transactionEntered = deferred()
const releaseTransactionBody = deferred()
const isolatedExecuteEntered = deferred()
const releaseIsolatedExecute = deferred()
const state = {
  clients: [],
  transactionEntered,
  isolatedExecuteEntered,
  releaseIsolatedExecute,
}

globalThis.__TURSO_CONNECTION_ISOLATION_SMOKE__ = state

const virtualCompatModule = `
const state = globalThis.__TURSO_CONNECTION_ISOLATION_SMOKE__

function resultSet() {
  return {
    columns: [],
    columnTypes: [],
    rows: [],
    rowsAffected: 0,
    lastInsertRowid: undefined,
    toJSON() { return {} },
  }
}

export function createClient() {
  const record = {
    id: state.clients.length + 1,
    closed: false,
    locked: false,
    waiters: [],
  }
  state.clients.push(record)

  function unlock() {
    record.locked = false
    for (const resolve of record.waiters.splice(0)) resolve()
  }

  async function waitForUnlock() {
    if (!record.locked) return
    await new Promise((resolve) => record.waiters.push(resolve))
  }

  return {
    async execute() {
      if (record.id === 3) {
        record.locked = true
        state.isolatedExecuteEntered.resolve()
        await state.releaseIsolatedExecute.promise
        unlock()
      }
      await waitForUnlock()
      return resultSet()
    },
    async batch() { return [resultSet()] },
    async transaction() {
      record.locked = true
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        unlock()
      }
      return {
        async execute() { return resultSet() },
        async batch() { return [resultSet()] },
        async executeMultiple() {},
        async commit() { close() },
        async rollback() { close() },
        close,
        get closed() { return closed },
      }
    },
    close() {
      record.closed = true
    },
    get closed() {
      return record.closed
    },
  }
}
`

const bundle = await build({
  stdin: {
    contents: tursoSource,
    loader: 'ts',
    resolveDir: fileURLToPath(new URL('../src/lib/db/', import.meta.url)),
    sourcefile: tursoSourcePath,
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [{
    name: 'mock-turso-compat',
    setup(buildApi) {
      buildApi.onResolve(
        { filter: /^@tursodatabase\/serverless\/compat$/ },
        () => ({ path: 'mock-turso-compat', namespace: 'turso-smoke' }),
      )
      buildApi.onLoad(
        { filter: /.*/, namespace: 'turso-smoke' },
        () => ({ contents: virtualCompatModule, loader: 'js' }),
      )
    },
  }],
})

process.env.TURSO_DATABASE_URL = 'libsql://connection-isolation-smoke.invalid'
process.env.TURSO_AUTH_TOKEN = 'smoke-token'

const bundledSource = bundle.outputFiles[0].text
const turso = await import(`data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`)

// Prime the process-wide client used for ordinary reads.
const cachedClient = turso.getTursoClient()
assert.equal(state.clients.length, 1)

const transactionPromise = turso.tursoTransaction('write', async () => {
  transactionEntered.resolve()
  await releaseTransactionBody.promise
})
await transactionEntered.promise

const readDuringTransaction = turso.tursoExecute('select 1')
const transactionDidNotBlockRead = await settlesBefore(readDuringTransaction)
releaseTransactionBody.resolve()
await Promise.all([transactionPromise, readDuringTransaction])

assert.equal(
  transactionDidNotBlockRead,
  true,
  'an open interactive transaction must not block the cached read client',
)
assert.equal(state.clients.length, 2, 'interactive transactions must use a dedicated client')
assert.equal(state.clients[1].closed, true, 'the dedicated transaction client must be closed')

const isolatedExecutePromise = turso.tursoExecuteIsolated({ sql: 'select ?', args: [1] })
await isolatedExecuteEntered.promise

const readDuringIsolatedExecute = turso.tursoExecute('select 1')
const isolatedExecuteDidNotBlockRead = await settlesBefore(readDuringIsolatedExecute)
releaseIsolatedExecute.resolve()
await Promise.all([isolatedExecutePromise, readDuringIsolatedExecute])

assert.equal(
  isolatedExecuteDidNotBlockRead,
  true,
  'a long isolated write must not block the cached read client',
)
assert.equal(state.clients.length, 3, 'latency-sensitive writes must use a dedicated client')
assert.equal(state.clients[2].closed, true, 'the dedicated write client must be closed')
assert.equal(cachedClient.closed, false, 'ordinary reads must retain the process-wide client')

delete globalThis.__TURSO_CONNECTION_ISOLATION_SMOKE__
console.log('Turso connection isolation smoke passed.')
