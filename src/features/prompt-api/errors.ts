export type PromptApiErrorCode =
  | 'api_unavailable'
  | 'model_unavailable'
  | 'preparation_required'
  | 'unsupported_input'
  | 'aborted'
  | 'operation_failed';

export class PromptApiError extends Error {
  readonly code: PromptApiErrorCode;

  constructor({ code, message, cause }: {
    code: PromptApiErrorCode,
    message: string,
    cause?: unknown,
  }) {
    super(message, { cause });
    this.name = 'PromptApiError';
    this.code = code;
  }
}

export function normalizePromptApiError({ error }: { error: unknown }): PromptApiError {
  if (error instanceof PromptApiError) return error;

  if (error instanceof DOMException) {
    switch (error.name) {
    case 'AbortError':
      return new PromptApiError({
        code: 'aborted',
        message: 'Prompt API operation was aborted.',
        cause: error,
      });
    case 'NotAllowedError':
      return new PromptApiError({
        code: 'preparation_required',
        message: 'Prompt API model preparation requires a user action.',
        cause: error,
      });
    case 'NotSupportedError':
      return new PromptApiError({
        code: 'unsupported_input',
        message: 'Prompt API does not support this request.',
        cause: error,
      });
    default:
      break;
    }
  }

  return new PromptApiError({
    code: 'operation_failed',
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export const TEST_ONLY = {
};
