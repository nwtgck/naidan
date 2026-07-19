type LocalLockMode = 'shared' | 'exclusive';

type LocalLockRequest = {
  readonly mode: LocalLockMode;
  readonly acquired: PromiseWithResolvers<HizoFSMaintenanceLease>;
};

type LocalLockState = {
  activeSharedCount: number;
  exclusiveActive: boolean;
  readonly queue: LocalLockRequest[];
};

export interface HizoFSMaintenanceLease {
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
    throw new Error(`Unhandled HizoFS maintenance lock mode: ${String(_ex)}`);
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
}): Promise<HizoFSMaintenanceLease> {
  const state = getLocalState({ lockName });
  const acquired = Promise.withResolvers<HizoFSMaintenanceLease>();
  state.queue.push({ mode, acquired });
  drainLocalQueue({ lockName, state });
  return acquired.promise;
}

function tryAcquireLocalExclusiveLease({ lockName }: {
  lockName: string;
}): HizoFSMaintenanceLease | undefined {
  const state = getLocalState({ lockName });
  if (
    state.activeSharedCount !== 0
    || state.exclusiveActive
    || state.queue.length !== 0
  ) {
    maybeDeleteLocalState({ lockName, state });
    return undefined;
  }
  state.exclusiveActive = true;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      state.exclusiveActive = false;
      drainLocalQueue({ lockName, state });
    },
  };
}

async function acquireWebLease({ lockName, mode }: {
  lockName: string;
  mode: LocalLockMode;
}): Promise<HizoFSMaintenanceLease> {
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

async function tryAcquireWebExclusiveLease({ lockName }: {
  lockName: string;
}): Promise<HizoFSMaintenanceLease | undefined> {
  const acquired = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<void>();
  const completed = navigator.locks.request(
    lockName,
    { mode: 'exclusive', ifAvailable: true },
    async lock => {
      if (lock === null) {
        acquired.resolve(false);
        return;
      }
      acquired.resolve(true);
      await released.promise;
    },
  );
  void completed.catch(error => acquired.reject(error));
  if (!(await acquired.promise)) {
    await completed;
    return undefined;
  }
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
}): Promise<HizoFSMaintenanceLease> {
  return acquireNamedLease({
    lockName: `hizofs/${fileSystemId}/maintenance`,
    mode,
  });
}

async function acquireNamedLease({ lockName, mode }: {
  lockName: string;
  mode: LocalLockMode;
}): Promise<HizoFSMaintenanceLease> {
  if (
    typeof navigator !== 'undefined'
    && navigator.locks !== undefined
    && typeof navigator.locks.request === 'function'
  ) {
    return acquireWebLease({ lockName, mode });
  }
  return acquireLocalLease({ lockName, mode });
}

function getSubvolumeRuntimePinLockName({
  fileSystemId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  fileSystemId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): string {
  return `hizofs/${fileSystemId}/subvolume-runtime/${subvolumeId}/${
    encodeURIComponent(subvolumeDescriptorObjectId)
  }`;
}

export function acquireHizoFSSubvolumeRuntimePin({
  fileSystemId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  fileSystemId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): Promise<HizoFSMaintenanceLease> {
  return acquireNamedLease({
    lockName: getSubvolumeRuntimePinLockName({
      fileSystemId,
      subvolumeId,
      subvolumeDescriptorObjectId,
    }),
    mode: 'shared',
  });
}

export function tryAcquireHizoFSSubvolumeRuntimePinExclusively({
  fileSystemId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  fileSystemId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): Promise<HizoFSMaintenanceLease | undefined> {
  const lockName = getSubvolumeRuntimePinLockName({
    fileSystemId,
    subvolumeId,
    subvolumeDescriptorObjectId,
  });
  if (
    typeof navigator !== 'undefined'
    && navigator.locks !== undefined
    && typeof navigator.locks.request === 'function'
  ) {
    return tryAcquireWebExclusiveLease({ lockName });
  }
  return Promise.resolve(tryAcquireLocalExclusiveLease({ lockName }));
}

function parseSubvolumeRuntimePinLockName({
  fileSystemId,
  lockName,
}: {
  fileSystemId: string;
  lockName: string;
}): {
  readonly subvolumeId: string;
  readonly subvolumeDescriptorObjectId: string;
} | undefined {
  const prefix = `hizofs/${fileSystemId}/subvolume-runtime/`;
  if (!lockName.startsWith(prefix)) return undefined;
  const suffix = lockName.slice(prefix.length);
  const separatorIndex = suffix.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === suffix.length - 1) {
    return undefined;
  }
  try {
    return {
      subvolumeId: suffix.slice(0, separatorIndex),
      subvolumeDescriptorObjectId: decodeURIComponent(
        suffix.slice(separatorIndex + 1),
      ),
    };
  } catch {
    return undefined;
  }
}

export async function listHizoFSActiveSubvolumeRuntimePins({
  fileSystemId,
}: {
  fileSystemId: string;
}): Promise<readonly {
  readonly subvolumeId: string;
  readonly subvolumeDescriptorObjectId: string;
}[]> {
  const lockNames = new Set<string>();
  if (
    typeof navigator !== 'undefined'
    && navigator.locks !== undefined
    && typeof navigator.locks.query === 'function'
  ) {
    const snapshot = await navigator.locks.query();
    for (const lock of snapshot.held ?? []) {
      if (typeof lock.name === 'string') lockNames.add(lock.name);
    }
  } else {
    for (const [lockName, state] of localStates) {
      if (state.activeSharedCount > 0) lockNames.add(lockName);
    }
  }
  const pins = new Map<string, {
    readonly subvolumeId: string;
    readonly subvolumeDescriptorObjectId: string;
  }>();
  for (const lockName of lockNames) {
    const pin = parseSubvolumeRuntimePinLockName({ fileSystemId, lockName });
    if (pin === undefined) continue;
    pins.set(pin.subvolumeDescriptorObjectId, pin);
  }
  return [...pins.values()];
}

/**
 * Protects one active reader, writer, or mutation from a concurrent GC sweep.
 * Idle sessions intentionally do not hold this lease so maintenance remains
 * runnable during normal application uptime.
 */
export function acquireHizoFSResourceLease({ fileSystemId }: {
  fileSystemId: string;
}): Promise<HizoFSMaintenanceLease> {
  return acquireLease({ fileSystemId, mode: 'shared' });
}

export async function runWithHizoFSResourceLease<T>({ fileSystemId, operation }: {
  fileSystemId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireHizoFSResourceLease({ fileSystemId });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

/**
 * Acquires the exclusive maintenance lease directly. Long-running maintenance
 * must release this lease between bounded slices so foreground resources can
 * make progress, while every started maintenance operation settles before the
 * lease is released.
 */
export function acquireHizoFSMaintenanceLease({ fileSystemId }: {
  fileSystemId: string;
}): Promise<HizoFSMaintenanceLease> {
  return acquireLease({ fileSystemId, mode: 'exclusive' });
}

/**
 * Serializes garbage-collection jobs without blocking foreground resources for
 * the whole mark-and-sweep cycle. This separate job lease is held across the
 * lock-free mark and every bounded sweep slice so two tabs cannot collect from
 * different root snapshots at the same time.
 */
export function acquireHizoFSGarbageCollectionLease({ fileSystemId }: {
  fileSystemId: string;
}): Promise<HizoFSMaintenanceLease> {
  return acquireNamedLease({
    lockName: `hizofs/${fileSystemId}/garbage-collection`,
    mode: 'exclusive',
  });
}

export async function runWithHizoFSMaintenanceLock<T>({ fileSystemId, operation }: {
  fileSystemId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireHizoFSMaintenanceLease({ fileSystemId });
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
