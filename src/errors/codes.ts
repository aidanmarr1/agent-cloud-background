export enum ErrorCode {
  // Validation
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_JSON = 'INVALID_JSON',

  // Tool errors
  TOOL_TIMEOUT = 'TOOL_TIMEOUT',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',

  // Stream errors
  STREAM_INTERRUPTED = 'STREAM_INTERRUPTED',
  STREAM_PARSE_ERROR = 'STREAM_PARSE_ERROR',

  // API errors
  RATE_LIMITED = 'RATE_LIMITED',
  API_ERROR = 'API_ERROR',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',

  // Security
  INJECTION_DETECTED = 'INJECTION_DETECTED',
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',

  // Resource errors
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

  // General
  UNKNOWN = 'UNKNOWN',
}

export const errorMessages: Record<ErrorCode, string> = {
  [ErrorCode.VALIDATION_FAILED]: 'The request could not be read',
  [ErrorCode.INVALID_JSON]: 'The request could not be read',
  [ErrorCode.TOOL_TIMEOUT]: 'An action took too long',
  [ErrorCode.TOOL_EXECUTION_FAILED]: 'An action could not finish',
  [ErrorCode.TOOL_NOT_FOUND]: 'That action is not available',
  [ErrorCode.STREAM_INTERRUPTED]: 'The task stopped before it finished',
  [ErrorCode.STREAM_PARSE_ERROR]: 'A live update could not be read',
  [ErrorCode.RATE_LIMITED]: 'Too many requests. Please try again shortly.',
  [ErrorCode.API_ERROR]: 'The request could not be completed',
  [ErrorCode.REQUEST_TIMEOUT]: 'The task took too long to respond',
  [ErrorCode.INJECTION_DETECTED]: 'Potentially harmful input detected',
  [ErrorCode.PATH_TRAVERSAL]: 'Invalid file path',
  [ErrorCode.FILE_NOT_FOUND]: 'File not found',
  [ErrorCode.FILE_TOO_LARGE]: 'File exceeds size limit',
  [ErrorCode.SESSION_NOT_FOUND]: 'This task is no longer available',
  [ErrorCode.UNKNOWN]: 'An unknown error occurred',
}
