import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from '@tursodatabase/serverless/compat'

export type TursoSetupStatus = {
  configured: boolean
  missing: Array<'TURSO_DATABASE_URL' | 'TURSO_AUTH_TOKEN'>
}

let cachedClient: Client | null = null

function readEnvValue(name: 'TURSO_DATABASE_URL' | 'TURSO_AUTH_TOKEN'): string {
  return process.env[name]?.trim() || ''
}

function createTursoClient(): Client {
  const databaseUrl = readEnvValue('TURSO_DATABASE_URL')
  const authToken = readEnvValue('TURSO_AUTH_TOKEN')

  if (!databaseUrl || !authToken) {
    const missing = getTursoSetupStatus().missing.join(', ')
    throw new Error(`Turso is not configured. Missing: ${missing}`)
  }

  return createClient({
    url: databaseUrl,
    authToken,
  })
}

export function getTursoSetupStatus(): TursoSetupStatus {
  const missing: TursoSetupStatus['missing'] = []

  if (!readEnvValue('TURSO_DATABASE_URL')) missing.push('TURSO_DATABASE_URL')
  if (!readEnvValue('TURSO_AUTH_TOKEN')) missing.push('TURSO_AUTH_TOKEN')

  return {
    configured: missing.length === 0,
    missing,
  }
}

export function getTursoClient(): Client {
  if (!cachedClient) {
    cachedClient = createTursoClient()
  }

  return cachedClient
}

export async function tursoExecute(sql: string, args?: InArgs): Promise<ResultSet> {
  return getTursoClient().execute(sql, args)
}

/**
 * Execute one statement on its own connection.
 *
 * The serverless compatibility client's process-wide connection is
 * single-stream. Latency-sensitive writes such as task-event persistence must
 * not queue lease refreshes and cancellation reads behind an unrelated write.
 */
export async function tursoExecuteIsolated(statement: InStatement): Promise<ResultSet> {
  const client = createTursoClient()
  try {
    return await client.execute(statement)
  } finally {
    client.close()
  }
}

export async function tursoTransaction<T>(
  mode: TransactionMode,
  fn: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  // An interactive transaction holds a compatibility client's execution lock
  // until commit/rollback. Never open one on the cached read client: a delayed
  // BEGIN or long transaction would otherwise queue every unrelated read (and
  // worker lease renewal) behind it.
  const client = createTursoClient()
  let transaction: Transaction | null = null

  try {
    transaction = await client.transaction(mode)
    const result = await fn(transaction)
    await transaction.commit()
    return result
  } catch (error) {
    try {
      if (transaction && !transaction.closed) await transaction.rollback()
    } catch {
      // Preserve the original failure.
    }
    throw error
  } finally {
    if (transaction && !transaction.closed) {
      transaction.close()
    }
    client.close()
  }
}
