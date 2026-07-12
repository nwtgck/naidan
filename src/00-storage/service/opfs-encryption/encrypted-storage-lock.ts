type StorageLockMode = 'shared' | 'exclusive';

export interface EncryptedStorageLockLease {
  readonly completion: Promise<void>,
  release(): void,
}

interface LocalLockRequest {
  readonly mode: StorageLockMode,
  readonly onAcquired: () => void,
  readonly onReleased: () => void,
}

interface LocalLockState {
  activeReaders: number,
  activeWriter: boolean,
  readonly queue: LocalLockRequest[],
}

const localLockStates = new Map<string, LocalLockState>();

function getLocalLockState({ lockName }: { lockName: string }): LocalLockState {
  let state = localLockStates.get(lockName);
  if (state === undefined) {
    state = {
      activeReaders: 0,
      activeWriter: false,
      queue: [],
    };
    localLockStates.set(lockName, state);
  }
  return state;
}

function removeIdleLocalLockState({
  lockName,
  state,
}: {
  lockName: string,
  state: LocalLockState,
}): void {
  if (
    state.activeReaders === 0
    && !state.activeWriter
    && state.queue.length === 0
    && localLockStates.get(lockName) === state
  ) {
    localLockStates.delete(lockName);
  }
}

function markLocalLockAcquired({
  state,
  mode,
}: {
  state: LocalLockState,
  mode: StorageLockMode,
}): void {
  switch (mode) {
  case 'shared':
    state.activeReaders += 1;
    break;
  case 'exclusive':
    state.activeWriter = true;
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled storage lock mode: ${String(_ex)}`);
  }
  }
}

function markLocalLockReleased({
  state,
  mode,
}: {
  state: LocalLockState,
  mode: StorageLockMode,
}): void {
  switch (mode) {
  case 'shared':
    state.activeReaders -= 1;
    break;
  case 'exclusive':
    state.activeWriter = false;
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled storage lock mode: ${String(_ex)}`);
  }
  }
}

function dispatchLocalLockQueue({
  lockName,
  state,
}: {
  lockName: string,
  state: LocalLockState,
}): void {
  if (state.activeWriter) {
    return;
  }
  const first = state.queue[0];
  if (first === undefined) {
    removeIdleLocalLockState({ lockName, state });
    return;
  }
  switch (first.mode) {
  case 'exclusive':
    if (state.activeReaders !== 0) {
      return;
    }
    state.queue.shift();
    markLocalLockAcquired({ state, mode: first.mode });
    first.onAcquired();
    return;
  case 'shared':
    break;
  default: {
    const _ex: never = first.mode;
    throw new Error(`Unhandled storage lock mode: ${String(_ex)}`);
  }
  }
  while (!state.activeWriter) {
    const request = state.queue[0];
    if (request === undefined) {
      break;
    }
    switch (request.mode) {
    case 'exclusive':
      return;
    case 'shared':
      state.queue.shift();
      markLocalLockAcquired({ state, mode: request.mode });
      request.onAcquired();
      break;
    default: {
      const _ex: never = request.mode;
      throw new Error(`Unhandled storage lock mode: ${String(_ex)}`);
    }
    }
  }
}

async function acquireLocalLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease> {
  const state = getLocalLockState({ lockName });
  let released = false;
  const acquired = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const request: LocalLockRequest = {
    mode,
    onAcquired: acquired.resolve,
    onReleased: completion.resolve,
  };
  state.queue.push(request);
  dispatchLocalLockQueue({ lockName, state });
  await acquired.promise;
  return {
    completion: completion.promise,
    release() {
      if (released) {
        return;
      }
      released = true;
      markLocalLockReleased({ state, mode });
      request.onReleased();
      dispatchLocalLockQueue({ lockName, state });
      removeIdleLocalLockState({ lockName, state });
    },
  };
}

async function acquireWebLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease> {
  let released = false;
  const releaseSignal = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const completion = navigator.locks.request(
    lockName,
    { mode },
    async () => {
      acquired.resolve();
      await releaseSignal.promise;
    },
  );
  void completion.catch(acquired.reject);
  await acquired.promise;
  return {
    completion,
    release() {
      if (released) {
        return;
      }
      released = true;
      releaseSignal.resolve();
    },
  };
}

function canAcquireLocalLockImmediately({
  state,
  mode,
}: {
  state: LocalLockState,
  mode: StorageLockMode,
}): boolean {
  if (state.queue.length > 0 || state.activeWriter) {
    return false;
  }
  switch (mode) {
  case 'shared':
    return true;
  case 'exclusive':
    return state.activeReaders === 0;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled storage lock mode: ${String(_ex)}`);
  }
  }
}

async function tryAcquireLocalLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease | undefined> {
  const state = getLocalLockState({ lockName });
  if (!canAcquireLocalLockImmediately({ state, mode })) {
    removeIdleLocalLockState({ lockName, state });
    return undefined;
  }
  let released = false;
  const completion = Promise.withResolvers<void>();
  markLocalLockAcquired({ state, mode });
  return {
    completion: completion.promise,
    release() {
      if (released) {
        return;
      }
      released = true;
      markLocalLockReleased({ state, mode });
      completion.resolve();
      dispatchLocalLockQueue({ lockName, state });
      removeIdleLocalLockState({ lockName, state });
    },
  };
}

async function tryAcquireWebLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease | undefined> {
  let released = false;
  const releaseSignal = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<EncryptedStorageLockLease | undefined>();
  const request = navigator.locks.request(
    lockName,
    { mode, ifAvailable: true },
    async lock => {
      if (lock === null) {
        acquired.resolve(undefined);
        return;
      }
      acquired.resolve({
        completion: completion.promise,
        release() {
          if (released) {
            return;
          }
          released = true;
          releaseSignal.resolve();
        },
      });
      await releaseSignal.promise;
    },
  );
  void request.then(completion.resolve, (error) => {
    acquired.reject(error);
    completion.resolve();
  });
  return await acquired.promise;
}

export async function acquireEncryptedStorageLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request !== undefined) {
    return await acquireWebLock({ lockName, mode });
  }
  return await acquireLocalLock({ lockName, mode });
}

export async function tryAcquireEncryptedStorageLock({
  lockName,
  mode,
}: {
  lockName: string,
  mode: StorageLockMode,
}): Promise<EncryptedStorageLockLease | undefined> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request !== undefined) {
    return await tryAcquireWebLock({ lockName, mode });
  }
  return await tryAcquireLocalLock({ lockName, mode });
}

export async function runWithEncryptedStorageLock<T>({
  lockName,
  mode,
  run,
}: {
  lockName: string,
  mode: StorageLockMode,
  run: () => Promise<T>,
}): Promise<T> {
  const lease = await acquireEncryptedStorageLock({ lockName, mode });
  try {
    return await run();
  } finally {
    lease.release();
    await lease.completion;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  acquireLocalLock,
  localLockStates,
  tryAcquireLocalLock,
};
