import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';

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

async function acquireLocalLease({ lockName, mode, signal }: {
  lockName: string;
  mode: LocalLockMode;
  signal: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  signal?.throwIfAborted();
  const state = getLocalState({ lockName });
  const acquired = Promise.withResolvers<HizoFSMaintenanceLease>();
  const request: LocalLockRequest = { mode, acquired };
  const onAbort = () => {
    const index = state.queue.indexOf(request);
    if (index < 0) return;
    state.queue.splice(index, 1);
    acquired.reject(signal?.reason);
    drainLocalQueue({ lockName, state });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  state.queue.push(request);
  drainLocalQueue({ lockName, state });
  try {
    return await acquired.promise;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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

async function acquireWebLease({ lockName, mode, signal }: {
  lockName: string;
  mode: LocalLockMode;
  signal: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  signal?.throwIfAborted();
  const acquired = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const completed = navigator.locks.request(lockName, {
    mode,
    ...(signal === undefined ? {} : { signal }),
  }, async () => {
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

async function acquireLease({ instanceId, mode, signal }: {
  instanceId: string;
  mode: LocalLockMode;
  signal: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS instanceId',
  });
  return acquireNamedLease({
    lockName: `hizofs/${instanceId}/maintenance`,
    mode,
    signal,
  });
}

async function acquireNamedLease({ lockName, mode, signal }: {
  lockName: string;
  mode: LocalLockMode;
  signal: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  if (
    typeof navigator !== 'undefined'
    && navigator.locks !== undefined
    && typeof navigator.locks.request === 'function'
  ) {
    return acquireWebLease({ lockName, mode, signal });
  }
  return acquireLocalLease({ lockName, mode, signal });
}

function getSubvolumeRuntimePinLockName({
  instanceId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  instanceId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): string {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS instanceId',
  });
  validateHizoFSStableId({
    value: subvolumeId,
    fieldName: 'HizoFS subvolumeId',
  });
  return `hizofs/${instanceId}/subvolume-runtime/${subvolumeId}/${
    encodeURIComponent(subvolumeDescriptorObjectId)
  }`;
}

export async function acquireHizoFSSubvolumeRuntimePin({
  instanceId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  instanceId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): Promise<HizoFSMaintenanceLease> {
  return await acquireNamedLease({
    lockName: getSubvolumeRuntimePinLockName({
      instanceId,
      subvolumeId,
      subvolumeDescriptorObjectId,
    }),
    mode: 'shared',
    signal: undefined,
  });
}

export function tryAcquireHizoFSSubvolumeRuntimePinExclusively({
  instanceId,
  subvolumeId,
  subvolumeDescriptorObjectId,
}: {
  instanceId: string;
  subvolumeId: string;
  subvolumeDescriptorObjectId: string;
}): Promise<HizoFSMaintenanceLease | undefined> {
  const lockName = getSubvolumeRuntimePinLockName({
    instanceId,
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
  instanceId,
  lockName,
}: {
  instanceId: string;
  lockName: string;
}): {
  readonly subvolumeId: string;
  readonly subvolumeDescriptorObjectId: string;
} | undefined {
  const prefix = `hizofs/${instanceId}/subvolume-runtime/`;
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
  instanceId,
}: {
  instanceId: string;
}): Promise<readonly {
  readonly subvolumeId: string;
  readonly subvolumeDescriptorObjectId: string;
}[]> {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS instanceId',
  });
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
    const pin = parseSubvolumeRuntimePinLockName({ instanceId, lockName });
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
export function acquireHizoFSResourceLease({ instanceId }: {
  instanceId: string;
}): Promise<HizoFSMaintenanceLease> {
  return acquireLease({ instanceId, mode: 'shared', signal: undefined });
}

export async function runWithHizoFSResourceLease<T>({ instanceId, operation }: {
  instanceId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireHizoFSResourceLease({ instanceId });
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
export function acquireHizoFSMaintenanceLease({ instanceId, signal }: {
  instanceId: string;
  signal?: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  return acquireLease({ instanceId, mode: 'exclusive', signal });
}

/**
 * Serializes garbage-collection jobs without blocking foreground resources for
 * the whole mark-and-sweep cycle. This separate job lease is held across the
 * lock-free mark and every bounded sweep slice so two tabs cannot collect from
 * different root snapshots at the same time.
 */
export function acquireHizoFSGarbageCollectionLease({ instanceId, signal }: {
  instanceId: string;
  signal?: AbortSignal | undefined;
}): Promise<HizoFSMaintenanceLease> {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS instanceId',
  });
  return acquireNamedLease({
    lockName: `hizofs/${instanceId}/garbage-collection`,
    mode: 'exclusive',
    signal,
  });
}

export async function runWithHizoFSMaintenanceLock<T>({ instanceId, operation }: {
  instanceId: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const lease = await acquireHizoFSMaintenanceLease({ instanceId });
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
