export const OPFS_STORAGE_SESSION_LOCK_KEY = 'naidan:sync:lock:opfs_storage_session';
export const OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY = 'naidan:sync:lock:opfs_plain_namespace_session';
const OPFS_STORAGE_SESSION_EXCLUSIVE_FENCE_TIMEOUT_MILLISECONDS = 30_000;

type FenceAcquisitionSignal = Readonly<{
  dispose(): void;
  signal: AbortSignal;
}>;

function createFenceAcquisitionSignal({ signal, timeoutMilliseconds }: {
  signal: AbortSignal | undefined;
  timeoutMilliseconds: number;
}): FenceAcquisitionSignal {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError('OPFS storage-session fence timeout must be a positive safe integer');
  }
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    forwardAbort();
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    const timeoutError = new Error('Timed out waiting for the exclusive OPFS storage-session fence');
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
  }, timeoutMilliseconds);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    },
    signal: controller.signal,
  };
}


export async function runWithExclusiveOpfsStorageSessionFence<T>({
  lockManager,
  run,
  signal,
}: {
  lockManager: LockManager | undefined;
  run: () => Promise<T>;
  signal: AbortSignal | undefined;
}): Promise<T> {
  if (lockManager?.request === undefined) {
    throw new Error('Web Locks are required for an OPFS persistence transition');
  }
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  const acquisition = createFenceAcquisitionSignal({
    signal,
    timeoutMilliseconds: OPFS_STORAGE_SESSION_EXCLUSIVE_FENCE_TIMEOUT_MILLISECONDS,
  });
  try {
    return await lockManager.request(
      OPFS_STORAGE_SESSION_LOCK_KEY,
      { mode: 'exclusive', signal: acquisition.signal },
      async lock => {
        acquisition.dispose();
        if (lock === null) throw new Error('Exclusive OPFS storage-session fence was not acquired');
        acquisition.signal.throwIfAborted();
        return await run();
      },
    );
  } finally {
    acquisition.dispose();
  }
}

export type OpportunisticPlainNamespaceFenceResult<T> =
  | { readonly state: 'completed'; readonly value: T }
  | { readonly state: 'unavailable' };

/**
 * Attempts retired plain-source maintenance without waiting for stale tabs.
 *
 * Plain providers hold this key shared for their lifetime. HizoFS providers do
 * not hold it. `ifAvailable` therefore makes cleanup opportunistic: a sleeping
 * pre-transition plain tab causes a quick defer instead of delaying unlock,
 * while the next unlock retries after that tab has reloaded and released its
 * shared lease.
 */
export async function runWithOpportunisticExclusiveOpfsPlainNamespaceFence<T>({
  lockManager,
  run,
}: {
  lockManager: Pick<LockManager, 'request'> | undefined;
  run: () => Promise<T>;
}): Promise<OpportunisticPlainNamespaceFenceResult<T>> {
  if (lockManager?.request === undefined) return { state: 'unavailable' };
  return await lockManager.request(
    OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY,
    { ifAvailable: true, mode: 'exclusive' },
    async lock => lock === null
      ? { state: 'unavailable' }
      : { state: 'completed', value: await run() },
  );
}

type SessionState =
  | 'idle'
  | 'acquiring'
  | 'active'
  | 'suspending'
  | 'suspended';

/**
 * Holds a shared Web Lock for the lifetime of an initialized OPFS provider.
 *
 * Encryption transitions request the same lock exclusively. Suspending first
 * stops new provider operations, waits for in-flight operations to finish,
 * then releases the shared lock. This prevents another tab from writing
 * through a stale plain or encrypted backend while a transition is running.
 */
class OpfsNamedSessionLock {
  private readonly lockKey: string;
  private state: SessionState = 'idle';
  private activeOperationCount = 0;
  private activeOperationsDrained = Promise.withResolvers<void>();
  private acquisitionPromise: Promise<void> | undefined;
  private releaseSharedLock: (() => void) | undefined;
  private sharedLockRequest: Promise<void> | undefined;

  constructor({ lockKey }: { lockKey: string }) {
    this.lockKey = lockKey;
  }

  async acquire(): Promise<void> {
    const state = this.state;
    switch (state) {
    case 'active':
      return;
    case 'acquiring':
      await this.acquisitionPromise;
      return;
    case 'suspending':
      await this.sharedLockRequest;
      return await this.acquire();
    case 'idle':
    case 'suspended':
      break;
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled OPFS storage session state: ${String(_ex)}`);
    }
    }

    if (typeof navigator === 'undefined' || navigator.locks?.request === undefined) {
      this.state = 'active';
      return;
    }

    this.state = 'acquiring';
    const acquired = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    this.acquisitionPromise = acquired.promise;
    this.releaseSharedLock = released.resolve;

    const sharedLockRequest = navigator.locks.request(
      this.lockKey,
      { mode: 'shared' },
      async () => {
        acquired.resolve();
        await released.promise;
      },
    );
    this.sharedLockRequest = sharedLockRequest;
    void sharedLockRequest.catch(error => {
      acquired.reject(error);
    });

    try {
      await acquired.promise;
      this.state = 'active';
    } catch (error) {
      this.releaseSharedLock = undefined;
      this.sharedLockRequest = undefined;
      this.state = 'idle';
      throw error;
    } finally {
      this.acquisitionPromise = undefined;
    }
  }

  async suspend(): Promise<void> {
    const state = this.state;
    switch (state) {
    case 'idle':
    case 'suspended':
      this.state = 'suspended';
      return;
    case 'acquiring':
      await this.acquisitionPromise;
      break;
    case 'active':
      break;
    case 'suspending':
      await this.sharedLockRequest;
      return;
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled OPFS storage session state: ${String(_ex)}`);
    }
    }

    this.state = 'suspending';
    if (this.activeOperationCount > 0) {
      await this.activeOperationsDrained.promise;
    }

    this.releaseSharedLock?.();
    try {
      await this.sharedLockRequest;
    } finally {
      this.releaseSharedLock = undefined;
      this.sharedLockRequest = undefined;
      this.state = 'suspended';
    }
  }

  acquireOperation(): () => void {
    this.assertActive();
    this.activeOperationCount += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.finishOperation();
    };
  }

  async run<T>({ run }: { run: () => Promise<T> }): Promise<T> {
    const release = this.acquireOperation();
    try {
      return await run();
    } finally {
      release();
    }
  }

  async *iterate<T>({
    createSource,
  }: {
    createSource: () => AsyncIterable<T>,
  }): AsyncGenerator<T> {
    const release = this.acquireOperation();
    try {
      yield* createSource();
    } finally {
      release();
    }
  }

  private assertActive(): void {
    const state = this.state;
    switch (state) {
    case 'active':
      return;
    case 'idle':
    case 'acquiring':
    case 'suspending':
    case 'suspended':
      throw new Error('OPFS storage is suspended for an encryption transition');
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled OPFS storage session state: ${String(_ex)}`);
    }
    }
  }

  private finishOperation(): void {
    this.activeOperationCount -= 1;
    if (this.activeOperationCount < 0) {
      this.activeOperationCount = 0;
      throw new Error('OPFS storage session operation count became negative');
    }
    if (this.activeOperationCount === 0) {
      this.activeOperationsDrained.resolve();
      this.activeOperationsDrained = Promise.withResolvers<void>();
    }
  }
}

export class OpfsStorageSessionLock extends OpfsNamedSessionLock {
  constructor() {
    super({ lockKey: OPFS_STORAGE_SESSION_LOCK_KEY });
  }
}

export class OpfsPlainNamespaceSessionLock extends OpfsNamedSessionLock {
  constructor() {
    super({ lockKey: OPFS_PLAIN_NAMESPACE_SESSION_LOCK_KEY });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createFenceAcquisitionSignal,
  exclusiveFenceTimeoutMilliseconds: OPFS_STORAGE_SESSION_EXCLUSIVE_FENCE_TIMEOUT_MILLISECONDS,
};
