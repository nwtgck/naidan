export type PrivacyFetchRuntimeErrorCode =
  | 'aborted'
  | 'broker_disposed'
  | 'broker_not_ready'
  | 'broker_unavailable'
  | 'duplicate_request_id'
  | 'fetch_failed'
  | 'rejected'
  | 'unknown'

export class PrivacyFetchError extends Error {
  code: PrivacyFetchRuntimeErrorCode

  constructor({
    code,
    message,
  }: {
    code: PrivacyFetchRuntimeErrorCode;
    message: string;
  }) {
    super(message)
    this.code = code
    this.name = (() => {
      switch (code) {
      case 'aborted':
        return 'AbortError'
      case 'broker_disposed':
      case 'broker_not_ready':
      case 'broker_unavailable':
      case 'duplicate_request_id':
      case 'fetch_failed':
      case 'rejected':
      case 'unknown':
        return 'PrivacyFetchError'
      default: {
        const neverCode: never = code
        throw new Error(`Unhandled privacy fetch runtime error code: ${String(neverCode)}`)
      }
      }
    })()
  }
}

export function createPrivacyFetchError({
  code,
  message,
}: {
  code: PrivacyFetchRuntimeErrorCode;
  message: string;
}): PrivacyFetchError {
  return new PrivacyFetchError({
    code,
    message,
  })
}

export function isPrivacyFetchError(error: unknown): error is PrivacyFetchError {
  return error instanceof PrivacyFetchError
}
