import type { Middleware } from './compose'
import { formatErrorResponse } from '@/errors/handlers'

export const withErrorHandling: Middleware = async (_req, _ctx, next) => {
  try {
    return await next()
  } catch (error) {
    console.error('[API Error]', error)
    const { body, status } = formatErrorResponse(error)
    return Response.json(body, { status })
  }
}
