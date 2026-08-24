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
  );
}

export const TEST_ONLY = {
  hasErrorCode,
  isPathNotFoundError,
  isPathTypeMismatchError,
};
