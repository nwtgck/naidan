export async function awaitWithAbort<T>({
  operation,
  signal,
}: {
  operation: Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  if (signal === undefined) return await operation;
  signal.throwIfAborted();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const resolveOperation: ReturnType<typeof Promise.withResolvers<T>>['resolve'] = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOperation: ReturnType<typeof Promise.withResolvers<T>>['reject'] = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    signal.addEventListener('abort', abort, { once: true });
    // The signal can abort after throwIfAborted() but before the listener above is
    // registered. Re-check after registration so that race cannot leave the caller
    // waiting forever for a Worker operation that will be disposed on close.
    if (signal.aborted) {
      abort();
    }

    void operation.then(resolveOperation, rejectOperation);
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
