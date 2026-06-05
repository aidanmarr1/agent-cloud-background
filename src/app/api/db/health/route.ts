import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { ensureAuthSchema } from '@/lib/auth/users'
import { getTursoClient, getTursoSetupStatus } from '@/lib/db/turso'

export async function GET() {
  const session = await auth().catch(() => null)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const status = getTursoSetupStatus()

  if (!status.configured) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        missing: status.missing,
      },
      { status: 503 },
    )
  }

  try {
    const result = await getTursoClient().execute('select 1 as ok')
    await ensureAuthSchema()
    return NextResponse.json({
      ok: true,
      configured: true,
      authSchema: true,
      rows: result.rows.length,
    })
  } catch {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        error: 'Database connection failed.',
      },
      { status: 502 },
    )
  }
}
