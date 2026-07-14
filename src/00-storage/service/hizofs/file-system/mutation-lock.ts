const localMutationTails = new Map<string, Promise<void>>();

async function runWithLocalLock<T>({ lockName, operation }: {
  lockName: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const previous = localMutationTails.get(lockName) ?? Promise.resolve();
  const completion = Promise.withResolvers<void>();
  const tail = previous.then(() => completion.promise);
  localMutationTails.set(lockName, tail);
  await previous;
  try {
    return await operation();
  } finally {
    completion.resolve();
    if (localMutationTails.get(lockName) === tail) {
      localMutationTails.delete(lockName);
    }
  }
}

export async function runWithHizoFSMutationLock<T>({ fileSystemId, operation }: {
  fileSystemId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lockName = `hizofs/${fileSystemId}/commit`;
  if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, operation);
  }
  return runWithLocalLock({ lockName, operation });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  localMutationTails,
};
