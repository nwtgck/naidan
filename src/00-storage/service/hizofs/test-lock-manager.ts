type TestLockCallback = () => Promise<unknown> | unknown;

type QueuedLockRequest = {
  readonly mode: LockMode;
  readonly callback: TestLockCallback;
  readonly acquired: ReturnType<typeof Promise.withResolvers<unknown>>;
  readonly signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  state: 'queued' | 'active' | 'settled';
};

function createAbortError(): DOMException {
  return new DOMException('The lock request was aborted', 'AbortError');
}

export function createQueuedTestLockManager({
  onRequest,
}: {
  onRequest: (({ name, mode }: { name: string; mode: LockMode }) => void) | undefined;
}): LockManager {
  const queues = new Map<string, QueuedLockRequest[]>();
  const activeShared = new Map<string, number>();
  const activeExclusive = new Set<string>();

  const detachAbortListener = ({ request }: {
    request: QueuedLockRequest;
  }): void => {
    if (request.abortListener === undefined) return;
    request.signal?.removeEventListener('abort', request.abortListener);
    request.abortListener = undefined;
  };

  const activate = ({ request }: { request: QueuedLockRequest }): void => {
    request.state = 'active';
    detachAbortListener({ request });
  };

  const settle = ({ request }: { request: QueuedLockRequest }): void => {
    request.state = 'settled';
    detachAbortListener({ request });
  };

  const drain = ({ name }: { name: string }): void => {
    if (activeExclusive.has(name)) {
      return;
    }
    const queue = queues.get(name);
    if (queue === undefined || queue.length === 0) {
      queues.delete(name);
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
      activate({ request: first });
      activeExclusive.add(name);
      void Promise.resolve()
        .then(first.callback)
        .then(first.acquired.resolve, first.acquired.reject)
        .finally(() => {
          settle({ request: first });
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
      activate({ request });
      activeShared.set(name, (activeShared.get(name) ?? 0) + 1);
      void Promise.resolve()
        .then(request.callback)
        .then(request.acquired.resolve, request.acquired.reject)
        .finally(() => {
          settle({ request });
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
    if (options.signal?.aborted === true) {
      acquired.reject(createAbortError());
      return acquired.promise;
    }
    const queue = queues.get(name) ?? [];
    const queuedRequest: QueuedLockRequest = {
      mode,
      callback,
      acquired,
      signal: options.signal,
      abortListener: undefined,
      state: 'queued',
    };
    if (options.signal !== undefined) {
      queuedRequest.abortListener = () => {
        switch (queuedRequest.state) {
        case 'queued':
          break;
        case 'active':
        case 'settled':
          return;
        default: {
          const _ex: never = queuedRequest.state;
          throw new Error(`Unhandled queued lock request state: ${_ex}`);
        }
        }
        const currentQueue = queues.get(name);
        const index = currentQueue?.indexOf(queuedRequest) ?? -1;
        if (index >= 0) currentQueue?.splice(index, 1);
        settle({ request: queuedRequest });
        queuedRequest.acquired.reject(createAbortError());
        drain({ name });
      };
      options.signal.addEventListener('abort', queuedRequest.abortListener, {
        once: true,
      });
    }
    queue.push(queuedRequest);
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
