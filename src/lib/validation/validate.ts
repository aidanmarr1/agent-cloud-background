import { z } from 'zod'

export function validateRequest<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; response: Response } {
  const result = schema.safeParse(data)
  if (result.success) {
    return { success: true, data: result.data }
  }
  return {
    success: false,
    response: new Response(
      JSON.stringify({ error: 'Validation failed', details: result.error.flatten() }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
  }
}
