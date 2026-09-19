function hasErrorCode({
  error,
  code,
}: {
  error: unknown;
  code: string;
}): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

export function isPathNotFoundError({
  error,
}: {
  error: unknown;
}): boolean {
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return true;
  }
  if (hasErrorCode({ error, code: 'ENOENT' })) {
    return true;
  }
  return error instanceof Error && (
    error.name === 'NotFoundError'
    || error.message.includes('NotFoundError')
    || error.message.startsWith('Path not found:')
    || error.message.startsWith('No such file or directory:')
  );
}

export function isPathTypeMismatchError({
  error,
}: {
  error: unknown;
}): boolean {
  if (error instanceof DOMException && error.name === 'TypeMismatchError') {
    return true;
  }
  if (hasErrorCode({ error, code: 'ENOTDIR' })) {
    return true;
  }
  return error instanceof Error && (
    error.name === 'TypeMismatchError'
    || /not a directory/iu.test(error.message)
    || error.message.startsWith('Not a file:')
  );
}


export function getPathErrorReason({
  error,
}: {
  error: unknown;
}): 'No such file or directory' | 'Not a directory' | undefined {
  if (hasErrorCode({ error, code: 'ENOENT' })) {
    return 'No such file or directory';
  }
  if (hasErrorCode({ error, code: 'ENOTDIR' })) {
    return 'Not a directory';
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return 'No such file or directory';
    if (error.name === 'TypeMismatchError') return 'Not a directory';
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (error.name === 'NotFoundError') return 'No such file or directory';
  if (error.name === 'TypeMismatchError') return 'Not a directory';
  if (
    error.message === 'No such file or directory'
    || error.message.startsWith('No such file or directory:')
    || error.message.startsWith('Path not found:')
  ) {
    return 'No such file or directory';
  }
  if (
    error.message === 'Not a directory'
    || error.message.startsWith('Not a directory:')
    || error.message.startsWith('Not a file:')
  ) {
    return 'Not a directory';
  }
  return undefined;
}

export const TEST_ONLY = {
  getPathErrorReason,
  hasErrorCode,
  isPathNotFoundError,
  isPathTypeMismatchError,
};
