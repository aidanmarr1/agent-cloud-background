import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'agent-web',
    commit:
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.AGENT_DEPLOYMENT_VERSION ||
      null,
    timestamp: Date.now(),
  })
}
