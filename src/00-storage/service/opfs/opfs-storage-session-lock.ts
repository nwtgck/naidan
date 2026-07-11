export const OPFS_STORAGE_SESSION_LOCK_KEY = 'naidan:sync:lock:opfs_storage_session';

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
export class OpfsStorageSessionLock {
  private state: SessionState = 'idle';
  private activeOperationCount = 0;
  private activeOperationsDrained = Promise.withResolvers<void>();
  private acquisitionPromise: Promise<void> | undefined;
  private releaseSharedLock: (() => void) | undefined;
  private sharedLockRequest: Promise<void> | undefined;

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
      OPFS_STORAGE_SESSION_LOCK_KEY,
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
