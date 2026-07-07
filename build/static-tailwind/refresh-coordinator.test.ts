import { describe, expect, it, vi } from 'vitest';
import { createRefreshCoordinator } from './refresh-coordinator';

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === undefined) throw new Error('Deferred resolve was not initialized.');
      resolvePromise();
    },
    reject(error) {
      if (rejectPromise === undefined) throw new Error('Deferred reject was not initialized.');
      rejectPromise(error);
    },
  };
}

async function waitForCallCount({ callback, count }: {
  callback: ReturnType<typeof vi.fn>,
  count: number,
}): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (callback.mock.calls.length === count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected callback to be called ${count} times, but saw ${callback.mock.calls.length}.`);
}

describe('static Tailwind refresh coordinator', () => {
  it('coalesces synchronous requests into one refresh using the latest context', async () => {
    const refresh = vi.fn(async () => {});
    const coordinator = createRefreshCoordinator({ refresh });

    await Promise.all(Array.from({ length: 10 }, (_, index) => coordinator.request({ context: index })));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ context: 9 });
  });

  it('reports scheduled and active refresh work until the covered generation settles', async () => {
    const deferred = createDeferred();
    const refresh = vi.fn(async () => deferred.promise);
    const coordinator = createRefreshCoordinator({ refresh });

    expect(coordinator.hasPendingRefresh()).toBe(false);
    const request = coordinator.request({ context: 'active' });
    expect(coordinator.hasPendingRefresh()).toBe(true);
    await waitForCallCount({ callback: refresh, count: 1 });
    expect(coordinator.hasPendingRefresh()).toBe(true);

    deferred.resolve();
    await request;
    await Promise.resolve();
    expect(coordinator.hasPendingRefresh()).toBe(false);
  });

  it('runs at most one trailing refresh for requests received during an active refresh', async () => {
    const firstRefresh = createDeferred();
    const secondRefresh = createDeferred();
    let concurrentRefreshes = 0;
    let maximumConcurrentRefreshes = 0;
    const refresh = vi.fn(async () => {
      concurrentRefreshes += 1;
      maximumConcurrentRefreshes = Math.max(maximumConcurrentRefreshes, concurrentRefreshes);
      const callIndex = refresh.mock.calls.length;
      try {
        await (callIndex === 1 ? firstRefresh.promise : secondRefresh.promise);
      } finally {
        concurrentRefreshes -= 1;
      }
    });
    const coordinator = createRefreshCoordinator({ refresh });

    const firstRequest = coordinator.request({ context: 'first' });
    await waitForCallCount({ callback: refresh, count: 1 });
    const laterRequests = Array.from({ length: 20 }, (_, index) => coordinator.request({ context: `later-${index}` }));
    firstRefresh.resolve();
    await waitForCallCount({ callback: refresh, count: 2 });
    expect(refresh).toHaveBeenLastCalledWith({ context: 'later-19' });
    secondRefresh.resolve();
    await Promise.all([firstRequest, ...laterRequests]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maximumConcurrentRefreshes).toBe(1);
  });

  it('rejects every coalesced request when their shared refresh fails', async () => {
    const expectedError = new Error('shared refresh failed');
    const refresh = vi.fn().mockRejectedValue(expectedError);
    const coordinator = createRefreshCoordinator({ refresh });

    const requests = Array.from({ length: 5 }, (_, index) => coordinator.request({ context: index }));

    await Promise.all(requests.map(async (request) => expect(request).rejects.toBe(expectedError)));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ context: 4 });
  });

  it('rejects the covered generation and recovers on the next request after a failure', async () => {
    const expectedError = new Error('refresh failed');
    const refresh = vi.fn()
      .mockRejectedValueOnce(expectedError)
      .mockResolvedValueOnce(undefined);
    const coordinator = createRefreshCoordinator({ refresh });

    await expect(coordinator.request({ context: 'broken' })).rejects.toBe(expectedError);
    await expect(coordinator.request({ context: 'recovered' })).resolves.toBeUndefined();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ context: 'recovered' });
  });

  it('continues with a newer generation when it arrives before a failed refresh settles', async () => {
    const firstRefresh = createDeferred();
    const expectedError = new Error('first refresh failed');
    const refresh = vi.fn(async ({ context }: { context: string }) => {
      if (context === 'first') await firstRefresh.promise;
    });
    const coordinator = createRefreshCoordinator({ refresh });

    const firstRequest = coordinator.request({ context: 'first' });
    await waitForCallCount({ callback: refresh, count: 1 });
    const secondRequest = coordinator.request({ context: 'second' });
    firstRefresh.reject(expectedError);

    await expect(firstRequest).rejects.toBe(expectedError);
    await expect(secondRequest).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ context: 'second' });
  });
});
