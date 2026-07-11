import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPFS_STORAGE_SESSION_LOCK_KEY,
  OpfsStorageSessionLock,
} from './opfs-storage-session-lock';

type QueuedLockRequest = {
  readonly mode: LockMode,
  readonly callback: () => Promise<unknown> | unknown,
  readonly resolve: (value: unknown) => void,
  readonly reject: (reason?: unknown) => void,
};

function createQueuedLockManager(): LockManager {
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

    const first = queue[0]!;
    if (first.mode === 'exclusive') {
      if ((activeShared.get(name) ?? 0) > 0) {
        return;
      }
      queue.shift();
      activeExclusive.add(name);
      void Promise.resolve()
        .then(first.callback)
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
        .then(request.callback)
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
    callback: () => Promise<unknown> | unknown,
  ) => new Promise((resolve, reject) => {
    const queue = queues.get(name) ?? [];
    queue.push({
      mode: options.mode ?? 'exclusive',
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
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: originalLocks,
  });
});

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
