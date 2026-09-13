export class TaskDispatchProviderError extends Error {
  constructor(
    readonly code:
      | 'CONFIGURATION_MISSING'
      | 'CONFIGURATION_INVALID'
      | 'REQUEST_TIMEOUT'
      | 'NETWORK_ERROR'
      | 'RATE_LIMITED'
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_REJECTED'
      | 'INVALID_PROVIDER_RESPONSE',
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly launchDisposition: 'known_rejection' | 'ambiguous' | null = null,
  ) {
    super(message)
    this.name = 'TaskDispatchProviderError'
  }
}

