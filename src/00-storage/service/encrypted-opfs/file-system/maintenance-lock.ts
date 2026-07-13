type LocalLockMode = 'shared' | 'exclusive';

type LocalLockRequest = {
  readonly mode: LocalLockMode;
  readonly acquired: PromiseWithResolvers<EncryptedOpfsMaintenanceLease>;
};

type LocalLockState = {
  activeSharedCount: number;
  exclusiveActive: boolean;
  readonly queue: LocalLockRequest[];
};

export interface EncryptedOpfsMaintenanceLease {
  release(): Promise<void>;
}

const localStates = new Map<string, LocalLockState>();

function getLocalState({ lockName }: {
  lockName: string;
}): LocalLockState {
  let state = localStates.get(lockName);
  if (state === undefined) {
    state = {
      activeSharedCount: 0,
      exclusiveActive: false,
      queue: [],
    };
    localStates.set(lockName, state);
  }
  return state;
}

function maybeDeleteLocalState({ lockName, state }: {
  lockName: string;
  state: LocalLockState;
}): void {
  if (
    state.activeSharedCount === 0
    && !state.exclusiveActive
    && state.queue.length === 0
    && localStates.get(lockName) === state
  ) {
    localStates.delete(lockName);
  }
}

function drainLocalQueue({ lockName, state }: {
  lockName: string;
  state: LocalLockState;
}): void {
  if (state.exclusiveActive || state.queue.length === 0) {
    maybeDeleteLocalState({ lockName, state });
    return;
  }

  const first = state.queue[0];
  if (first === undefined) {
    return;
  }
  switch (first.mode) {
  case 'exclusive':
    if (state.activeSharedCount !== 0) {
      return;
    }
    state.queue.shift();
    state.exclusiveActive = true;
    {
      let released = false;
      first.acquired.resolve({
        async release() {
          if (released) return;
          released = true;
          state.exclusiveActive = false;
          drainLocalQueue({ lockName, state });
        },
      });
    }
    return;
  case 'shared':
    break;
  default: {
    const _ex: never = first.mode;
    throw new Error(`Unhandled EncryptedOpfs maintenance lock mode: ${String(_ex)}`);
  }
  }

  while (state.queue[0]?.mode === 'shared' && !state.exclusiveActive) {
    const request = state.queue.shift();
    if (request === undefined) break;
    state.activeSharedCount += 1;
    let released = false;
    request.acquired.resolve({
      async release() {
        if (released) return;
        released = true;
        state.activeSharedCount -= 1;
        drainLocalQueue({ lockName, state });
      },
    });
  }
}

async function acquireLocalLease({ lockName, mode }: {
  lockName: string;
  mode: LocalLockMode;
}): Promise<EncryptedOpfsMaintenanceLease> {
  const state = getLocalState({ lockName });
  const acquired = Promise.withResolvers<EncryptedOpfsMaintenanceLease>();
  state.queue.push({ mode, acquired });
  drainLocalQueue({ lockName, state });
  return acquired.promise;
}

async function acquireWebLease({ lockName, mode }: {
  lockName: string;
  mode: LocalLockMode;
}): Promise<EncryptedOpfsMaintenanceLease> {
  const acquired = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const completed = navigator.locks.request(lockName, { mode }, async () => {
    acquired.resolve();
    await released.promise;
  });
  void completed.catch(error => {
    acquired.reject(error);
  });
  await acquired.promise;
  let didRelease = false;
  return {
    async release() {
      if (didRelease) return;
      didRelease = true;
      released.resolve();
      await completed;
    },
  };
}

async function acquireLease({ fileSystemId, mode }: {
  fileSystemId: string;
  mode: LocalLockMode;
}): Promise<EncryptedOpfsMaintenanceLease> {
  const lockName = `encrypted-opfs/${fileSystemId}/maintenance`;
  if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
    return acquireWebLease({ lockName, mode });
  }
  return acquireLocalLease({ lockName, mode });
}

export function acquireEncryptedOpfsSessionLease({ fileSystemId }: {
  fileSystemId: string;
}): Promise<EncryptedOpfsMaintenanceLease> {
  return acquireLease({ fileSystemId, mode: 'shared' });
}

export async function runWithEncryptedOpfsMaintenanceLock<T>({ fileSystemId, operation }: {
  fileSystemId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireLease({ fileSystemId, mode: 'exclusive' });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  localStates,
};
