import { AppError, ValidationError } from './types'
import { ErrorCode } from './codes'

export interface ErrorResponse {
  error: string
  code: ErrorCode
  details?: Record<string, unknown>
}

export function formatErrorResponse(error: unknown): { body: ErrorResponse; status: number } {
  if (error instanceof ValidationError) {
    return {
      body: { error: error.message, code: error.code, details: error.details },
      status: error.statusCode,
    }
  }

  if (error instanceof AppError) {
    return {
      body: { error: error.message, code: error.code },
      status: error.statusCode,
    }
  }

  const message = error instanceof Error ? error.message : 'An unknown error occurred'
  return {
    body: { error: message, code: ErrorCode.UNKNOWN },
    status: 500,
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  return new AppError(ErrorCode.UNKNOWN, { cause: error })
}
