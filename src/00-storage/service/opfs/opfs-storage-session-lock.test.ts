import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
  OPFS_STORAGE_SESSION_LOCK_KEY,
  OpfsPlainNamespaceSessionLock,
  OpfsStorageSessionLock,
  TEST_ONLY,
  runWithExclusiveOpfsPlainNamespaceFence,
  runWithExclusiveOpfsStorageSessionFence,
  runWithOpportunisticExclusiveOpfsPlainNamespaceFence,
} from './opfs-storage-session-lock';

type QueuedLockRequest = {
  readonly mode: LockMode,
  readonly ifAvailable: boolean,
  readonly callback: (lock: Lock | null) => Promise<unknown> | unknown,
  readonly resolve: (value: unknown) => void,
  readonly reject: (reason?: unknown) => void,
};

function createQueuedLockManager(): LockManager {
  const queues = new Map<string, QueuedLockRequest[]>();
  const activeShared = new Map<string, number>();
  const activeExclusive = new Set<string>();

  const drain = ({ name }: { name: string }): void => {
    const queue = queues.get(name);
    if (activeExclusive.has(name)) {
      const first = queue?.[0];
      if (first?.ifAvailable === true) {
        queue?.shift();
        void Promise.resolve()
          .then(() => first.callback(null))
          .then(first.resolve, first.reject);
      }
      return;
    }
    if (queue === undefined || queue.length === 0) {
      return;
    }

    const first = queue[0]!;
    if (first.mode === 'exclusive') {
      if ((activeShared.get(name) ?? 0) > 0) {
        if (first.ifAvailable) {
          queue.shift();
          void Promise.resolve()
            .then(() => first.callback(null))
            .then(first.resolve, first.reject);
        }
        return;
      }
      queue.shift();
      activeExclusive.add(name);
      void Promise.resolve()
        .then(() => first.callback({ mode: first.mode, name } as Lock))
        .then(first.resolve, first.reject)
        .finally(() => {
          activeExclusive.delete(name);
          drain({ name });
        });
      return;
    }

    while (queue[0]?.mode === 'shared') {
      const request = queue.shift()!;
      activeShared.set(name, (activeShared.get(name) ?? 0) + 1);
      void Promise.resolve()
        .then(() => request.callback({ mode: request.mode, name } as Lock))
        .then(request.resolve, request.reject)
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

  const request = vi.fn((
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<unknown> | unknown,
  ) => new Promise((resolve, reject) => {
    const queue = queues.get(name) ?? [];
    queue.push({
      mode: options.mode ?? 'exclusive',
      ifAvailable: options.ifAvailable ?? false,
      callback,
      resolve,
      reject,
    });
    queues.set(name, queue);
    drain({ name });
  }));

  return { request } as unknown as LockManager;
}

const originalLocks = navigator.locks;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

function createPendingSignalAwareLockManager(): LockManager {
  const request = (
    _name: string,
    options: LockOptions,
    _callback: LockGrantedCallback<unknown>,
  ): Promise<unknown> => new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => {
      reject(signal.reason);
    }, { once: true });
  });
  return { request: request as LockManager['request'] } as LockManager;
}

describe('OpfsStorageSessionLock', () => {
  it('releases its shared lock before an exclusive transition lock runs', async () => {
    const lockManager = createQueuedLockManager();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: lockManager,
    });
    const sessionLock = new OpfsStorageSessionLock();
    await sessionLock.acquire();

    const exclusiveStarted = vi.fn();
    const exclusiveRelease = Promise.withResolvers<void>();
    const exclusiveRequest = navigator.locks.request(
      OPFS_STORAGE_SESSION_LOCK_KEY,
      { mode: 'exclusive' },
      async () => {
        exclusiveStarted();
        await exclusiveRelease.promise;
      },
    );
    await Promise.resolve();
    expect(exclusiveStarted).not.toHaveBeenCalled();

    const suspension = sessionLock.suspend();
    await vi.waitFor(() => {
      expect(exclusiveStarted).toHaveBeenCalledOnce();
    });
    await suspension;

    const reacquisition = sessionLock.acquire();
    let reacquired = false;
    void reacquisition.then(() => {
      reacquired = true;
    });
    await Promise.resolve();
    expect(reacquired).toBe(false);

    exclusiveRelease.resolve();
    await exclusiveRequest;
    await reacquisition;
    expect(reacquired).toBe(true);
    await sessionLock.suspend();
  });

  it('waits for active provider operations before releasing the shared lock', async () => {
    const lockManager = createQueuedLockManager();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: lockManager,
    });
    const sessionLock = new OpfsStorageSessionLock();
    await sessionLock.acquire();

    const operationRelease = Promise.withResolvers<void>();
    const operation = sessionLock.run({ run: async () => {
      await operationRelease.promise;
    } });
    const suspension = sessionLock.suspend();
    let suspended = false;
    void suspension.then(() => {
      suspended = true;
    });

    await Promise.resolve();
    expect(suspended).toBe(false);
    await expect(sessionLock.run({ run: async () => undefined })).rejects.toThrow(
      'OPFS storage is suspended for an encryption transition',
    );

    operationRelease.resolve();
    await operation;
    await suspension;
    expect(suspended).toBe(true);
  });
});


describe('runWithExclusiveOpfsStorageSessionFence', () => {
  it('waits for every shared session before running the transition exclusively', async () => {
    const lockManager = createQueuedLockManager();
    const firstSharedRelease = Promise.withResolvers<void>();
    const secondSharedRelease = Promise.withResolvers<void>();
    const firstShared = lockManager.request(
      OPFS_STORAGE_SESSION_LOCK_KEY,
      { mode: 'shared' },
      async () => await firstSharedRelease.promise,
    );
    const secondShared = lockManager.request(
      OPFS_STORAGE_SESSION_LOCK_KEY,
      { mode: 'shared' },
      async () => await secondSharedRelease.promise,
    );
    const run = vi.fn(async () => 'transition-complete');

    const transition = runWithExclusiveOpfsStorageSessionFence({
      lockManager,
      run,
      signal: undefined,
    });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    firstSharedRelease.resolve();
    await firstShared;
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    secondSharedRelease.resolve();
    await secondShared;
    await expect(transition).resolves.toBe('transition-complete');
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects before mutation when Web Locks are unavailable', async () => {
    const run = vi.fn(async () => undefined);

    await expect(runWithExclusiveOpfsStorageSessionFence({
      lockManager: undefined,
      run,
      signal: undefined,
    })).rejects.toThrow('Web Locks are required for an OPFS persistence transition');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not queue a transition whose signal is already aborted', async () => {
    const lockManager = createQueuedLockManager();
    const controller = new AbortController();
    const reason = new Error('transition cancelled');
    controller.abort(reason);
    const run = vi.fn(async () => undefined);

    await expect(runWithExclusiveOpfsStorageSessionFence({
      lockManager,
      run,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });

  it('times out before mutation when a frozen follower keeps the shared lease', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const transition = runWithExclusiveOpfsStorageSessionFence({
      lockManager: createPendingSignalAwareLockManager(),
      run,
      signal: undefined,
    });
    const rejection = expect(transition).rejects.toMatchObject({
      message: 'Timed out waiting for the exclusive OPFS storage-session fence',
      name: 'TimeoutError',
    });

    await vi.advanceTimersByTimeAsync(TEST_ONLY.exclusiveFenceTimeoutMilliseconds);

    await rejection;
    expect(run).not.toHaveBeenCalled();
  });

  it('forwards caller abort while queued and never runs the transition', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => undefined);
    const reason = new Error('caller cancelled the transition');
    const transition = runWithExclusiveOpfsStorageSessionFence({
      lockManager: createPendingSignalAwareLockManager(),
      run,
      signal: controller.signal,
    });
    const rejection = expect(transition).rejects.toBe(reason);

    controller.abort(reason);

    await rejection;
    expect(run).not.toHaveBeenCalled();
  });

  it('rechecks abort before mutation if lock grant races with cancellation', async () => {
    const controller = new AbortController();
    const grant = Promise.withResolvers<void>();
    const lockManager = {
      request: async <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> => {
        await grant.promise;
        return await callback({ mode: 'exclusive', name } as Lock);
      },
    } as LockManager;
    const run = vi.fn(async () => undefined);
    const reason = new Error('cancelled while the lock was granted');
    const transition = runWithExclusiveOpfsStorageSessionFence({
      lockManager,
      run,
      signal: controller.signal,
    });
    const rejection = expect(transition).rejects.toBe(reason);

    controller.abort(reason);
    grant.resolve();

    await rejection;
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels the timeout once acquired and does not bound transition work', async () => {
    vi.useFakeTimers();
    let acquisitionSignal: AbortSignal | undefined;
    const lockManager = {
      request: async <T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> => {
        acquisitionSignal = options.signal;
        return await callback({ mode: 'exclusive', name } as Lock);
      },
    } as LockManager;
    const release = Promise.withResolvers<void>();
    const run = vi.fn(async () => {
      await release.promise;
      return 'completed';
    });
    const transition = runWithExclusiveOpfsStorageSessionFence({
      lockManager,
      run,
      signal: undefined,
    });
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });

    await vi.advanceTimersByTimeAsync(TEST_ONLY.exclusiveFenceTimeoutMilliseconds * 2);
    expect(acquisitionSignal?.aborted).toBe(false);
    release.resolve();
    await expect(transition).resolves.toBe('completed');
  });
});

describe('runWithOpportunisticExclusiveOpfsPlainNamespaceFence', () => {
  it('defers cleanup while a plain provider still holds the shared namespace lease', async () => {
    const lockManager = createQueuedLockManager();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: lockManager,
    });
    const plainSessionLock = new OpfsPlainNamespaceSessionLock();
    await plainSessionLock.acquire();
    const run = vi.fn(async () => 'removed');

    await expect(runWithOpportunisticExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run,
    })).resolves.toEqual({ state: 'unavailable' });
    expect(run).not.toHaveBeenCalled();

    await plainSessionLock.suspend();
    await expect(runWithOpportunisticExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run,
    })).resolves.toEqual({ state: 'completed', value: 'removed' });
    expect(run).toHaveBeenCalledOnce();
    expect(lockManager.request).toHaveBeenCalledWith(
      OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
      { ifAvailable: true, mode: 'exclusive' },
      expect.any(Function),
    );
  });
});

describe('runWithExclusiveOpfsPlainNamespaceFence', () => {
  it('waits for every shared plain session before mutating the namespace', async () => {
    const lockManager = createQueuedLockManager();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: lockManager,
    });
    const plainSessionLock = new OpfsPlainNamespaceSessionLock();
    await plainSessionLock.acquire();
    const run = vi.fn(async () => 'mutated');

    const mutation = runWithExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run,
      signal: undefined,
    });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    await plainSessionLock.suspend();
    await expect(mutation).resolves.toBe('mutated');
    expect(run).toHaveBeenCalledOnce();
    expect(lockManager.request).toHaveBeenCalledWith(
      OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
      { mode: 'exclusive', signal: expect.any(AbortSignal) },
      expect.any(Function),
    );
  });

  it('times out before mutation when a stale plain session keeps its lease', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const mutation = runWithExclusiveOpfsPlainNamespaceFence({
      lockManager: createPendingSignalAwareLockManager(),
      run,
      signal: undefined,
    });
    const rejection = expect(mutation).rejects.toMatchObject({
      message: 'Timed out waiting for the exclusive OPFS plain-namespace fence',
      name: 'TimeoutError',
    });

    await vi.advanceTimersByTimeAsync(TEST_ONLY.exclusiveFenceTimeoutMilliseconds);

    await rejection;
    expect(run).not.toHaveBeenCalled();
  });

  it('never overlaps two required plain namespace mutations', async () => {
    const lockManager = createQueuedLockManager();
    const firstRelease = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = runWithExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run: async () => {
        events.push('first-started');
        await firstRelease.promise;
        events.push('first-finished');
      },
      signal: undefined,
    });
    await vi.waitFor(() => {
      expect(events).toEqual(['first-started']);
    });

    const second = runWithExclusiveOpfsPlainNamespaceFence({
      lockManager,
      run: async () => {
        events.push('second-started');
      },
      signal: undefined,
    });
    await Promise.resolve();
    expect(events).toEqual(['first-started']);

    firstRelease.resolve();
    await first;
    await second;
    expect(events).toEqual(['first-started', 'first-finished', 'second-started']);
  });
});
