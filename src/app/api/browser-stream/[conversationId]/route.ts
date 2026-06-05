import { NextRequest } from 'next/server'
import { hasBrowserSession, subscribeToBrowserFrames } from '@/lib/browser'
import { assertTaskAccess } from '@/lib/taskAccess'
import { auth } from '@/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await params

  // Validate the task id before using it as a session key. Sibling routes
  // (api/sandbox, api/files) all enforce this — keeping the format consistent
  // prevents accidental injection of shell metacharacters or path segments.
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return Response.json({ error: 'Invalid task id' }, { status: 400 })
  }

  const session = await auth().catch(() => null)
  const userId = session?.user?.id
  if (!userId) {
    return Response.json({ error: 'Authentication required' }, { status: 401 })
  }

  const access = await assertTaskAccess(request, conversationId, { userId })
  if (!access.ok) return access.response

  // Shared cleanup reference so both abort and cancel can trigger it
  let cleanupFn: (() => void) | null = null

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      // Wait for session to appear instead of returning 404
      // (the browser session may not exist yet due to race condition)
      let session = hasBrowserSession(conversationId)
      if (!session) {
        const maxWait = 30_000
        const pollInterval = 500
        let waited = 0
        while (!session && waited < maxWait) {
          // Check if client disconnected while waiting
          if (request.signal.aborted) {
            controller.close()
            return
          }
          await new Promise((r) => setTimeout(r, pollInterval))
          waited += pollInterval
          session = hasBrowserSession(conversationId)
        }
        if (!session) {
          controller.close()
          return
        }
      }

      const unsubscribe = subscribeToBrowserFrames(conversationId, (base64) => {
        try {
          const data = JSON.stringify({ frame: base64 })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch {
          // Controller closed — unsubscribe handles cleanup
        }
      })

      if (!unsubscribe) {
        controller.close()
        return
      }

      // Assign cleanup immediately to close the race window with cancel()
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let cleaned = false
      cleanupFn = () => {
        if (cleaned) return
        cleaned = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }

      // Heartbeat to detect disconnects
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          cleanupFn?.()
        }
      }, 15000)

      request.signal.addEventListener('abort', cleanupFn, { once: true })
    },
    cancel() {
      cleanupFn?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      ...access.headers,
    },
  })
}
