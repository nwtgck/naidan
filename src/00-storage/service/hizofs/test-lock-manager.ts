type TestLockCallback = () => Promise<unknown> | unknown;

type QueuedLockRequest = {
  readonly mode: LockMode;
  readonly callback: TestLockCallback;
  readonly acquired: ReturnType<typeof Promise.withResolvers<unknown>>;
};

export function createQueuedTestLockManager({
  onRequest,
}: {
  onRequest: (({ name, mode }: { name: string; mode: LockMode }) => void) | undefined;
}): LockManager {
  const queues = new Map<string, QueuedLockRequest[]>();
  const activeShared = new Map<string, number>();
  const activeExclusive = new Set<string>();

  const drain = ({ name }: { name: string }): void => {
    if (activeExclusive.has(name)) {
      return;
    }
    const queue = queues.get(name);
    if (queue === undefined || queue.length === 0) {
      return;
    }
    const first = queue[0];
    if (first === undefined) {
      return;
    }
    switch (first.mode) {
    case 'exclusive':
      if ((activeShared.get(name) ?? 0) > 0) {
        return;
      }
      queue.shift();
      activeExclusive.add(name);
      void Promise.resolve()
        .then(first.callback)
        .then(first.acquired.resolve, first.acquired.reject)
        .finally(() => {
          activeExclusive.delete(name);
          drain({ name });
        });
      return;
    case 'shared':
      break;
    default: {
      const _ex: never = first.mode;
      throw new Error(`Unhandled test lock mode: ${String(_ex)}`);
    }
    }

    while (queue[0]?.mode === 'shared') {
      const request = queue.shift();
      if (request === undefined) {
        break;
      }
      activeShared.set(name, (activeShared.get(name) ?? 0) + 1);
      void Promise.resolve()
        .then(request.callback)
        .then(request.acquired.resolve, request.acquired.reject)
        .finally(() => {
          const remaining = (activeShared.get(name) ?? 1) - 1;
          if (remaining === 0) {
            activeShared.delete(name);
          } else {
            activeShared.set(name, remaining);
          }
          drain({ name });
        });
    }
  };

  /* eslint-disable local-rules-named-args/require-named-args -- Implements the browser LockManager.request positional contract for cross-realm tests. */
  const request = (
    name: string,
    options: LockOptions,
    callback: TestLockCallback,
  ): Promise<unknown> => {
    const acquired = Promise.withResolvers<unknown>();
    const mode = options.mode ?? 'exclusive';
    onRequest?.({ name, mode });
    const queue = queues.get(name) ?? [];
    queue.push({
      mode,
      callback,
      acquired,
    });
    queues.set(name, queue);
    drain({ name });
    return acquired.promise;
  };

  /* eslint-enable local-rules-named-args/require-named-args */

  return { request } as unknown as LockManager;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
