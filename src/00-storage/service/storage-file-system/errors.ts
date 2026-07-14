export function isStorageEntryNotFoundError({ error }: {
  error: unknown;
}): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (
        error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError')
      );
}

export function createStorageEntryNotFoundError({ message }: {
  message: string;
}): Error {
  const error = new Error(`NotFoundError: ${message}`);
  error.name = 'NotFoundError';
  return error;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
