import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageService } from '@/00-storage/service';
import { registerOpfsStorageTransitionPreparation } from '@/00-storage/service/opfs/opfs-storage-transition-preparation';
import { createOpfsTransitionReloadGuard } from '@/logic/opfs-transition-reload-guard';
import { interruptOrdinaryOpfsEncryptionTransition } from './developer-opfs-encryption-transition-interruption';

const mocks = vi.hoisted(() => ({
  enableEncryption: vi.fn(),
  notify: vi.fn(),
  subscribe: vi.fn(),
  withLock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => await fn()),
}));

vi.mock('@/00-storage/service/synchronizer', () => ({
  StorageSynchronizer: class {
    notify = mocks.notify;
    subscribe = mocks.subscribe;
    withLock = mocks.withLock;
  },
}));

vi.mock('@/00-storage/service/opfs-storage', () => ({
  OPFSStorageProvider: class {
    readonly canPersistBinary = true;

    async enableEncryption(request: unknown): Promise<void> {
      await mocks.enableEncryption(request);
    }

    async init(): Promise<void> {}
  },
}));

vi.mock('@/00-storage/service/local-storage', () => ({
  LocalStorageProvider: class {},
}));

vi.mock('@/00-storage/service/memory-storage', () => ({
  MemoryStorageProvider: class {},
}));

vi.mock('@/utils/opfs-detection', () => ({
  checkOPFSSupport: vi.fn(async () => true),
}));

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn(),
    addInfoEvent: vi.fn(),
  }),
}));

function eventTargetHarness(): Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
}

describe('Developer OPFS interruption central reload receiving boundary', () => {
  const cleanups: Array<() => void> = [];

  function installCentralReloadOwner(): ReturnType<typeof vi.fn> {
    const reload = vi.fn();
    const guard = createOpfsTransitionReloadGuard({
      document: {
        ...eventTargetHarness(),
        visibilityState: 'visible',
      } as unknown as Document,
      window: {
        ...eventTargetHarness(),
        location: { reload },
      } as unknown as Window,
    });
    cleanups.push(() => guard.dispose());
    cleanups.push(registerOpfsStorageTransitionPreparation({
      externalTransitionSettled: () => undefined,
      externalTransitionStarting: async () => undefined,
      localTransitionSettled: () => guard.reloadAfterSettlement(),
      localTransitionStarting: () => guard.markTransitionStarted(),
      prepare: async () => undefined,
    }));
    return reload;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withLock.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => await fn());
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it.each([
    { boundary: 'pre_switch', phase: 'verifying' },
    { boundary: 'post_switch', phase: 'cleaning_source' },
  ] as const)('requests one central reload after an expected $boundary interruption', async ({ boundary, phase }) => {
    mocks.enableEncryption.mockImplementation(async ({ onProgress, signal }) => {
      onProgress({ progress: {
        completedBytes: 1,
        completedEntries: 1,
        operation: 'encrypting',
        percent: undefined,
        phase,
        totalBytes: 1,
        totalEntries: 1,
      } });
      signal.throwIfAborted();
    });
    const reload = installCentralReloadOwner();
    const service = new StorageService();
    await service.init({ type: 'opfs' });

    await expect(interruptOrdinaryOpfsEncryptionTransition({
      boundary,
      operation: 'enable',
      run: async ({ onProgress, signal }) => await service.enableOpfsEncryption({
        onProgress,
        passphrase: 'test passphrase',
        signal,
      }),
    })).resolves.toBeUndefined();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('requests one central reload after an unexpected started-transition failure', async () => {
    const failure = new Error('production transition failed');
    mocks.enableEncryption.mockRejectedValue(failure);
    const reload = installCentralReloadOwner();
    const service = new StorageService();
    await service.init({ type: 'opfs' });

    await expect(interruptOrdinaryOpfsEncryptionTransition({
      boundary: 'pre_switch',
      operation: 'enable',
      run: async ({ onProgress, signal }) => await service.enableOpfsEncryption({
        onProgress,
        passphrase: 'test passphrase',
        signal,
      }),
    })).rejects.toBe(failure);

    expect(reload).toHaveBeenCalledOnce();
  });
});
