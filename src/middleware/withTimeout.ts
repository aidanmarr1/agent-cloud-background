import type { Middleware } from './compose'

export function withTimeout(ms: number): Middleware {
  return async (_req, ctx, next) => {
    // Plumb an AbortSignal through ctx so handlers can cancel in-flight work
    // when the timeout fires. Without this, the underlying handler keeps
    // burning CPU/memory after we've already returned 504 to the client.
    const controller = new AbortController()
    ctx.signal = controller.signal

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        next(),
        new Promise<Response>((resolve) => {
          timeoutId = setTimeout(() => {
            controller.abort()
            resolve(Response.json({ error: 'Request timed out' }, { status: 504 }))
          }, ms)
        }),
      ])
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }
}
