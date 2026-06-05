import {
  createClient,
  type Client,
  type InArgs,
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
  const databaseUrl = readEnvValue('TURSO_DATABASE_URL')
  const authToken = readEnvValue('TURSO_AUTH_TOKEN')

  if (!databaseUrl || !authToken) {
    const missing = getTursoSetupStatus().missing.join(', ')
    throw new Error(`Turso is not configured. Missing: ${missing}`)
  }

  if (!cachedClient) {
    cachedClient = createClient({
      url: databaseUrl,
      authToken,
    })
  }

  return cachedClient
}

export async function tursoExecute(sql: string, args?: InArgs): Promise<ResultSet> {
  return getTursoClient().execute(sql, args)
}

export async function tursoTransaction<T>(
  mode: TransactionMode,
  fn: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  const transaction = await getTursoClient().transaction(mode)

  try {
    const result = await fn(transaction)
    await transaction.commit()
    return result
  } catch (error) {
    try {
      if (!transaction.closed) await transaction.rollback()
    } catch {
      // Preserve the original failure.
    }
    throw error
  } finally {
    if (!transaction.closed) {
      transaction.close()
    }
  }
}
