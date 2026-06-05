import { ErrorCode, errorMessages } from './codes'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly isRetryable: boolean

  constructor(code: ErrorCode, opts?: { statusCode?: number; isRetryable?: boolean; cause?: unknown }) {
    super(errorMessages[code])
    this.name = 'AppError'
    this.code = code
    this.statusCode = opts?.statusCode ?? 500
    this.isRetryable = opts?.isRetryable ?? false
    if (opts?.cause) this.cause = opts.cause
  }
}

export class ToolError extends AppError {
  readonly toolName: string

  constructor(toolName: string, code: ErrorCode, opts?: { statusCode?: number; isRetryable?: boolean; cause?: unknown }) {
    super(code, opts)
    this.name = 'ToolError'
    this.toolName = toolName
  }
}

export class StreamError extends AppError {
  readonly partialContent?: string

  constructor(code: ErrorCode, partialContent?: string, opts?: { statusCode?: number; isRetryable?: boolean; cause?: unknown }) {
    super(code, { isRetryable: true, ...opts })
    this.name = 'StreamError'
    this.partialContent = partialContent
  }
}

export class ValidationError extends AppError {
  readonly details: Record<string, string[]>

  constructor(details: Record<string, string[]>) {
    super(ErrorCode.VALIDATION_FAILED, { statusCode: 400 })
    this.name = 'ValidationError'
    this.details = details
  }
}
