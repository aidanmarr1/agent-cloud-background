export interface RouteContext {
  params?: Record<string, string | string[]>
  data?: unknown
  // Optional abort signal: middlewares like `withTimeout` populate this so
  // downstream handlers can abort in-flight work (LLM calls, DB queries) when
  // the request is cancelled. Handlers that don't read it continue to work
  // unchanged — this field is purely additive.
  signal?: AbortSignal
}

export type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response>
export type Middleware = (req: Request, ctx: RouteContext, next: () => Promise<Response>) => Promise<Response>

export function compose(...middlewares: Middleware[]) {
  return function wrap(handler: RouteHandler): RouteHandler {
    return function composed(req: Request, ctx: RouteContext = {}): Promise<Response> {
      let index = 0

      function next(): Promise<Response> {
        if (index < middlewares.length) {
          const mw = middlewares[index++]
          return mw(req, ctx, next)
        }
        return handler(req, ctx)
      }

      return next()
    }
  }
}
