import { z } from 'zod'
import type { RouteContext, Middleware } from './compose'

export function withValidation<T>(schema: z.ZodSchema<T>): Middleware {
  return async (req: Request, ctx: RouteContext, next: () => Promise<Response>) => {
    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const result = schema.safeParse(rawBody)
    if (!result.success) {
      return Response.json(
        { error: 'Validation failed', details: result.error.flatten() },
        { status: 400 },
      )
    }

    ctx.data = result.data
    return next()
  }
}
