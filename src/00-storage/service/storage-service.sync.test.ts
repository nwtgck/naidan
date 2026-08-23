import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageService } from './index';
import { SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
import { toBinaryObjectId, toChatGroupId, toChatId } from '@/01-models/ids';

// We mock the synchronizer to track calls to withLock and notify
const {
  mockWithLock,
  mockNotify,
  mockSubscribe,
  mockLocalTransitionStarting,
  mockExternalTransitionStarting,
  mockPrepareExternalTransition,
  mockLocalTransitionSettled,
  mockExternalTransitionSettled,
  mockSuspendStorageSession,
} = vi.hoisted(() => ({
  mockWithLock: vi.fn().mockImplementation(({ fn }) => fn()),
  mockNotify: vi.fn(),
  mockSubscribe: vi.fn(),
  mockLocalTransitionStarting: vi.fn(),
  mockExternalTransitionStarting: vi.fn(async () => {}),
  mockPrepareExternalTransition: vi.fn(async () => {}),
  mockLocalTransitionSettled: vi.fn(),
  mockExternalTransitionSettled: vi.fn(),
  mockSuspendStorageSession: vi.fn(async () => {}),
}));

const mockAddErrorEvent = vi.fn();
const mockAddInfoEvent = vi.fn();
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the application event dependency with a storage service event API.
vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: mockAddErrorEvent,
    addInfoEvent: mockAddInfoEvent,
  }),
}));

vi.mock('./synchronizer', () => {
  return {
    StorageSynchronizer: class {
      withLock = mockWithLock;
      notify = mockNotify;
      subscribe = mockSubscribe;
    },
  };
});

vi.mock('./opfs/opfs-storage-transition-preparation', () => ({
  notifyRegisteredOpfsLocalTransitionStarting: mockLocalTransitionStarting,
  notifyRegisteredOpfsExternalTransitionStarting: mockExternalTransitionStarting,
  prepareRegisteredOpfsStorageTransition: mockPrepareExternalTransition,
  notifyRegisteredOpfsLocalTransitionSettled: mockLocalTransitionSettled,
  notifyRegisteredOpfsExternalTransitionSettled: mockExternalTransitionSettled,
}));

vi.mock('@/utils/opfs-detection', () => ({
  checkOPFSSupport: vi.fn(async () => true),
}));

// Mock providers to avoid real storage access
const mockProvider = {
  init: vi.fn().mockResolvedValue(undefined),
  saveChatMeta: vi.fn().mockResolvedValue(undefined),
  loadChatMeta: vi.fn().mockResolvedValue(null),
  saveChatContent: vi.fn().mockResolvedValue(undefined),
  loadChatContent: vi.fn().mockResolvedValue(null),
  deleteChat: vi.fn().mockResolvedValue(undefined),
  saveChatGroup: vi.fn().mockResolvedValue(undefined),
  loadChatGroup: vi.fn().mockResolvedValue(null),
  deleteChatGroup: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  clearAll: vi.fn().mockResolvedValue(undefined),
  saveFile: vi.fn().mockResolvedValue(undefined),
  loadChat: vi.fn().mockResolvedValue(null),
  listChats: vi.fn().mockResolvedValue([]),
  listChatGroups: vi.fn().mockResolvedValue([]),
  getSidebarStructure: vi.fn().mockResolvedValue([]),
  loadSettings: vi.fn().mockResolvedValue(null),
  getFile: vi.fn().mockResolvedValue(null),
  hasAttachments: vi.fn().mockResolvedValue(false),
  loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
  saveHierarchy: vi.fn().mockResolvedValue(undefined),
  dump: vi.fn(),
  restore: vi.fn(),
  dispose: vi.fn().mockResolvedValue(undefined),
  enableEncryption: vi.fn().mockResolvedValue(undefined),
  disableEncryption: vi.fn().mockResolvedValue(undefined),
  inspectDisableEncryptionConflict: vi.fn().mockResolvedValue({ type: 'clear' }),
  cleanupDisableEncryptionConflict: vi.fn().mockResolvedValue({ type: 'clear' }),
  reencrypt: vi.fn().mockResolvedValue(undefined),
  convergeTransitionWithPassphrase: vi.fn().mockResolvedValue(undefined),
  returnInterruptedEncryptionToPlain: vi.fn().mockResolvedValue(undefined),
};

vi.mock('./local-storage', () => ({
  LocalStorageProvider: class {
    constructor() {
      return mockProvider;
    }
  },
}));

vi.mock('./opfs-storage', () => ({
  OPFSStorageProvider: class {
    constructor() {
      Object.assign(this, mockProvider);
    }

    suspendStorageSession = mockSuspendStorageSession;
  },
}));

describe('StorageService Synchronization Wrapper', () => {
  let service: StorageService;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Restore default mock implementations after reset
    mockWithLock.mockImplementation(({ fn }) => fn());
    mockProvider.saveChatMeta.mockResolvedValue(undefined);
    mockProvider.loadChatMeta.mockResolvedValue(null);
    mockProvider.saveChatContent.mockResolvedValue(undefined);
    mockProvider.loadChatContent.mockResolvedValue(null);
    mockProvider.deleteChat.mockResolvedValue(undefined);
    mockProvider.saveChatGroup.mockResolvedValue(undefined);
    mockProvider.loadChatGroup.mockResolvedValue(null);
    mockProvider.deleteChatGroup.mockResolvedValue(undefined);
    mockProvider.saveSettings.mockResolvedValue(undefined);
    mockProvider.clearAll.mockResolvedValue(undefined);
    mockProvider.saveFile.mockResolvedValue(undefined);
    mockProvider.init.mockResolvedValue(undefined);
    mockProvider.loadSettings.mockResolvedValue(null);
    mockProvider.enableEncryption.mockResolvedValue(undefined);
    mockProvider.disableEncryption.mockResolvedValue(undefined);
    mockProvider.inspectDisableEncryptionConflict.mockResolvedValue({ type: 'clear' });
    mockProvider.cleanupDisableEncryptionConflict.mockResolvedValue({ type: 'clear' });
    mockProvider.reencrypt.mockResolvedValue(undefined);
    mockProvider.convergeTransitionWithPassphrase.mockResolvedValue(undefined);
    mockProvider.returnInterruptedEncryptionToPlain.mockResolvedValue(undefined);
    mockExternalTransitionStarting.mockResolvedValue(undefined);
    mockPrepareExternalTransition.mockResolvedValue(undefined);
    mockSuspendStorageSession.mockResolvedValue(undefined);

    service = new StorageService();
    await service.init({ type: 'local' });
  });

  it('should wrap deleteChat with lock and notify after success', async () => {
    await service.deleteChat({ id: toChatId({ raw: 'c1' }) });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChat).toHaveBeenCalledWith({ id: 'c1' });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });

  it('should wrap updateChatGroup with lock and notify after success', async () => {
    const group = { id: 'g1' } as any;
    const updater = vi.fn().mockResolvedValue(group);
    await service.updateChatGroup({ id: toChatGroupId({ raw: 'g1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatGroup).toHaveBeenCalledWith({ chatGroup: group });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'g1' }) });
  });

  it('should wrap deleteChatGroup with lock and notify after success', async () => {
    await service.deleteChatGroup({ id: toChatGroupId({ raw: 'g1' }) });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.deleteChatGroup).toHaveBeenCalledWith({ id: 'g1' });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'g1' }) });
  });

  it('announces an OPFS encryption transition only after acquiring the global storage lock', async () => {
    const run = vi.fn(async () => 'completed');
    mockWithLock.mockImplementationOnce(async ({ fn, lockKey }) => {
      expect(lockKey).toBe(SYNC_LOCK_KEY);
      expect(mockNotify).not.toHaveBeenCalledWith({
        event: expect.objectContaining({
          type: 'opfs_encryption',
          status: 'transition_started',
        }),
      });
      return await fn();
    });

    const result = await (
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run });

    expect(result).toBe('completed');
    expect(run).toHaveBeenCalledOnce();
    expect(mockLocalTransitionStarting).toHaveBeenCalledOnce();
    expect(mockLocalTransitionSettled).toHaveBeenCalledWith({ settlement: 'completed' });
    expect(mockNotify).toHaveBeenNthCalledWith(1, {
      event: expect.objectContaining({
        type: 'opfs_encryption',
        status: 'transition_started',
      }),
    });
    expect(mockNotify).toHaveBeenNthCalledWith(2, {
      event: expect.objectContaining({
        type: 'opfs_encryption',
        status: 'transition_completed',
      }),
    });
    const startedEvent = mockNotify.mock.calls[0]?.[0]?.event;
    const completedEvent = mockNotify.mock.calls[1]?.[0]?.event;
    expect(startedEvent).toEqual(expect.objectContaining({
      operationId: expect.any(String),
      initiatorTabId: expect.any(String),
    }));
    expect(completedEvent).toEqual(expect.objectContaining({
      operationId: startedEvent.operationId,
      initiatorTabId: startedEvent.initiatorTabId,
    }));
  });

  it('does not broadcast or mutate when local application preflight fails', async () => {
    const failure = new Error('local worker cleanup failed');
    mockPrepareExternalTransition.mockRejectedValueOnce(failure);
    const run = vi.fn(async () => undefined);

    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run })).rejects.toBe(failure);

    expect(mockLocalTransitionStarting).toHaveBeenCalledOnce();
    expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({ type: 'opfs_encryption' }),
    });
    expect(mockLocalTransitionSettled).toHaveBeenCalledOnce();
    expect(mockLocalTransitionSettled).toHaveBeenCalledWith({ settlement: 'preparation_failed' });
  });

  it('runs local safety preparation after a local start callback fails', async () => {
    const failure = new Error('local transition presentation failed');
    mockLocalTransitionStarting.mockImplementationOnce(() => {
      throw failure;
    });
    const run = vi.fn(async () => undefined);

    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run })).rejects.toBe(failure);

    expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({ type: 'opfs_encryption' }),
    });
    expect(mockLocalTransitionSettled).toHaveBeenCalledWith({ settlement: 'preparation_failed' });
  });

  it('inspects and cleans disable conflicts without starting transition settlement', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const conflict = {
      entries: [{ entryKind: 'file' as const, relativePath: 'naidan-storage/settings.json' }],
      inspectionId: 'conflict-1',
      totalEntryCount: 1,
      truncated: false,
      type: 'conflict' as const,
    };
    mockProvider.inspectDisableEncryptionConflict.mockResolvedValue(conflict);
    mockProvider.cleanupDisableEncryptionConflict.mockResolvedValue({ type: 'clear' });

    await expect(service.inspectOpfsEncryptionDisableConflict()).resolves.toEqual(conflict);
    await expect(service.cleanupOpfsEncryptionDisableConflict({ inspectionId: 'conflict-1' }))
      .resolves.toEqual({ type: 'clear' });

    expect(mockProvider.cleanupDisableEncryptionConflict).toHaveBeenCalledWith({ inspectionId: 'conflict-1' });
    expect(mockLocalTransitionStarting).not.toHaveBeenCalled();
    expect(mockPrepareExternalTransition).not.toHaveBeenCalled();
    expect(mockLocalTransitionSettled).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({ type: 'opfs_encryption' }),
    });
  });

  it.each([
    {
      invoke: async ({ service }: { service: StorageService }) => await service.enableOpfsEncryption({
        onProgress: undefined,
        passphrase: 'passphrase',
        signal: undefined,
      }),
      name: 'enable',
      providerMethod: mockProvider.enableEncryption,
    },
    {
      invoke: async ({ service }: { service: StorageService }) => await service.disableOpfsEncryption({
        onProgress: undefined,
        signal: undefined,
      }),
      name: 'disable',
      providerMethod: mockProvider.disableEncryption,
    },
    {
      invoke: async ({ service }: { service: StorageService }) => await service.reencryptOpfsEncryption({
        onProgress: undefined,
        passphrase: 'passphrase',
        signal: undefined,
      }),
      name: 're-encrypt',
      providerMethod: mockProvider.reencrypt,
    },
    {
      invoke: async ({ service }: { service: StorageService }) => (
        await service.convergeOpfsEncryptionTransitionWithPassphrase({
          passphrase: 'passphrase',
          signal: undefined,
        })
      ),
      name: 'converge',
      providerMethod: mockProvider.convergeTransitionWithPassphrase,
    },
    {
      invoke: async ({ service }: { service: StorageService }) => (
        await service.returnInterruptedOpfsEncryptionToPlain({
          onProgress: undefined,
          passphrase: 'passphrase',
          signal: undefined,
        })
      ),
      name: 'return-to-plain',
      providerMethod: mockProvider.returnInterruptedEncryptionToPlain,
    },
  ])('runs registered preflight for the public $name transition API', async ({ invoke, providerMethod }) => {
    service = new StorageService();
    await service.init({ type: 'opfs' });

    await invoke({ service });

    expect(mockLocalTransitionStarting).toHaveBeenCalledOnce();
    expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
    expect(providerMethod).toHaveBeenCalledOnce();
    expect(mockLocalTransitionSettled).toHaveBeenCalledWith({ settlement: 'completed' });
  });

  it('does not report a completed transition as failed when reload settlement throws', async () => {
    const settlementFailure = new Error('reload settlement failed');
    mockLocalTransitionSettled.mockImplementationOnce(() => {
      throw settlementFailure;
    });

    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run: async () => 'completed' })).rejects.toBe(settlementFailure);

    expect(mockLocalTransitionSettled).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith({
      event: expect.objectContaining({ status: 'transition_completed', type: 'opfs_encryption' }),
    });
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({ status: 'transition_failed', type: 'opfs_encryption' }),
    });
  });


  it('reports a failed local transition with stable diagnostic fields before propagating its error', async () => {
    const failure = Object.assign(new Error('transition failed'), {
      code: 'sync_access_unavailable',
      name: 'PhysicalStoreError',
      path: 'segments/segment.enc',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect((
        service as unknown as {
          runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
        }
      ).runOpfsEncryptionTransition({ run: async () => {
        throw failure;
      } })).rejects.toBe(failure);

      expect(consoleError).toHaveBeenCalledWith('[opfs-encryption]', expect.objectContaining({
        error: failure,
        errorCauses: [],
        errorCode: 'sync_access_unavailable',
        errorMessage: 'transition failed',
        errorName: 'PhysicalStoreError',
        errorPath: 'segments/segment.enc',
        event: 'transition_failed',
      }));
      expect(mockLocalTransitionStarting).toHaveBeenCalledOnce();
      expect(mockLocalTransitionSettled).toHaveBeenCalledWith({ settlement: 'failed' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports direct AggregateError causes with stable diagnostic fields', async () => {
    const startFailure = Object.assign(new Error('no Persistence Control authority'), {
      code: 'no_proof_valid_authority',
      name: 'PersistenceControlSelectionError',
    });
    const cleanupFailure = Object.assign(new Error('cleanup ownership remained unknown'), {
      code: 'higher_protection_unresolved',
      name: 'PersistenceControlSelectionError',
    });
    const failure = new AggregateError([startFailure, cleanupFailure], 'enable start and cleanup both failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect((
        service as unknown as {
          runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
        }
      ).runOpfsEncryptionTransition({ run: async () => {
        throw failure;
      } })).rejects.toBe(failure);

      expect(consoleError).toHaveBeenCalledWith('[opfs-encryption]', expect.objectContaining({
        error: failure,
        errorCauses: [
          {
            errorCode: 'no_proof_valid_authority',
            errorMessage: 'no Persistence Control authority',
            errorName: 'PersistenceControlSelectionError',
            errorPath: undefined,
          },
          {
            errorCode: 'higher_protection_unresolved',
            errorMessage: 'cleanup ownership remained unknown',
            errorName: 'PersistenceControlSelectionError',
            errorPath: undefined,
          },
        ],
        errorMessage: 'enable start and cleanup both failed',
        errorName: 'AggregateError',
        event: 'transition_failed',
      }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not start a stale local transition after another tab wins the global lock', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }

    const lockRequest = Promise.withResolvers<unknown>();
    let executeAfterLockAcquired: (() => Promise<void>) | undefined;
    mockWithLock.mockImplementationOnce(({ fn }) => {
      executeAfterLockAcquired = async () => {
        try {
          lockRequest.resolve(await fn());
        } catch (error) {
          lockRequest.reject(error);
        }
      };
      return lockRequest.promise;
    });
    const run = vi.fn(async () => undefined);
    const localTransition = (
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run });

    listener({
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: 'winning-external-operation',
        initiatorTabId: 'external-tab',
        timestamp: 1,
      },
    });
    await vi.waitFor(() => {
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
    });

    if (executeAfterLockAcquired === undefined) {
      throw new Error('Expected a pending local global-lock request');
    }
    await executeAfterLockAcquired();

    await expect(localTransition).rejects.toThrow(
      'OPFS encryption transition was superseded by another tab',
    );
    expect(run).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({
        type: 'opfs_encryption',
        status: 'transition_started',
      }),
    });
  });

  it('rejects a local transition created after successful external safety preparation', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) throw new Error('Expected storage synchronization listener');

    listener({ event: {
      type: 'opfs_encryption',
      status: 'transition_started',
      operationId: 'external-before-new-local-request',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    } });
    await vi.waitFor(() => {
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
    });

    const run = vi.fn(async () => undefined);
    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run })).rejects.toThrow(
      'OPFS encryption transition requires this page to reload',
    );
    expect(run).not.toHaveBeenCalled();
    expect(mockLocalTransitionStarting).not.toHaveBeenCalled();
  });

  it('keeps the reload-required latch when external safety preparation fails', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    mockPrepareExternalTransition.mockRejectedValueOnce(new Error('worker cleanup failed'));
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) throw new Error('Expected storage synchronization listener');

    listener({ event: {
      type: 'opfs_encryption',
      status: 'transition_started',
      operationId: 'external-failed-before-new-local-request',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    } });
    await vi.waitFor(() => {
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({ settlement: 'preparation_failed' });
    });

    const run = vi.fn(async () => undefined);
    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run })).rejects.toThrow(
      'OPFS encryption transition requires this page to reload',
    );
    expect(run).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalledWith({
      event: expect.objectContaining({ type: 'opfs_encryption' }),
    });
  });

  it('ignores OPFS transition events emitted by the same tab', async () => {
    const listener = mockSubscribe.mock.calls[0]?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }

    await (
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run: async () => undefined });
    const ownStartedEvent = mockNotify.mock.calls.find(
      ([{ event }]) => event.type === 'opfs_encryption' && event.status === 'transition_started',
    )?.[0].event;
    if (ownStartedEvent === undefined) {
      throw new Error('Expected local transition start event');
    }

    listener({ event: ownStartedEvent });
    await vi.waitFor(() => {
      expect(mockExternalTransitionStarting).not.toHaveBeenCalled();
    });
  });

  it('suspends an external OPFS session and reloads only after settlement', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started' | 'transition_completed',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }
    const baseEvent = {
      type: 'opfs_encryption' as const,
      operationId: 'external-operation',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    };

    listener({
      event: {
        ...baseEvent,
        status: 'transition_started',
      },
    });
    await vi.waitFor(() => {
      expect(mockExternalTransitionStarting).toHaveBeenCalledOnce();
      expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
    });
    expect(mockExternalTransitionSettled).not.toHaveBeenCalled();

    listener({
      event: {
        ...baseEvent,
        status: 'transition_completed',
      },
    });
    await vi.waitFor(() => {
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({
        settlement: 'completed',
      });
    });
  });

  it('settles a follower for reload after an external transition failure', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started' | 'transition_failed',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }
    const baseEvent = {
      type: 'opfs_encryption' as const,
      operationId: 'external-failed-operation',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    };

    listener({ event: { ...baseEvent, status: 'transition_started' } });
    await vi.waitFor(() => {
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
    });
    listener({ event: { ...baseEvent, status: 'transition_failed' } });

    await vi.waitFor(() => {
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({ settlement: 'failed' });
    });
  });

  it('ignores a delayed duplicate start after the same external operation settled', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started' | 'transition_completed',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }
    const baseEvent = {
      type: 'opfs_encryption' as const,
      operationId: 'reordered-external-operation',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    };

    listener({ event: { ...baseEvent, status: 'transition_started' } });
    await vi.waitFor(() => {
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
    });
    listener({ event: { ...baseEvent, status: 'transition_completed' } });
    await vi.waitFor(() => {
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({
        settlement: 'completed',
      });
    });

    listener({ event: { ...baseEvent, status: 'transition_started' } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockExternalTransitionStarting).toHaveBeenCalledOnce();
    expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
    expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
  });

  it('prepares a safe reload when settlement arrives before its start event', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started' | 'transition_completed',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }
    const baseEvent = {
      type: 'opfs_encryption' as const,
      operationId: 'settlement-before-start',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    };

    listener({ event: { ...baseEvent, status: 'transition_completed' } });
    await vi.waitFor(() => {
      expect(mockExternalTransitionStarting).toHaveBeenCalledOnce();
      expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({
        settlement: 'completed',
      });
    });

    listener({ event: { ...baseEvent, status: 'transition_started' } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockExternalTransitionStarting).toHaveBeenCalledOnce();
    expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
    expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
  });

  it('does not reload a provider initialized after an observed external transition started', async () => {
    service = new StorageService();
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started' | 'transition_completed',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }
    const baseEvent = {
      type: 'opfs_encryption' as const,
      operationId: 'transition-before-provider-init',
      initiatorTabId: 'external-tab',
      timestamp: 1,
    };

    listener({ event: { ...baseEvent, status: 'transition_started' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockExternalTransitionStarting).not.toHaveBeenCalled();
    expect(mockSuspendStorageSession).not.toHaveBeenCalled();

    // init() acquires the same global lock as the transition. Once it returns,
    // this provider was necessarily created from the operation's stable result.
    await service.init({ type: 'opfs' });
    listener({ event: { ...baseEvent, status: 'transition_completed' } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockExternalTransitionStarting).not.toHaveBeenCalled();
    expect(mockPrepareExternalTransition).not.toHaveBeenCalled();
    expect(mockSuspendStorageSession).not.toHaveBeenCalled();
    expect(mockExternalTransitionSettled).not.toHaveBeenCalled();

    const run = vi.fn(async () => undefined);
    await expect((
      service as unknown as {
        runOpfsEncryptionTransition<T>({ run }: { run: () => Promise<T> }): Promise<T>,
      }
    ).runOpfsEncryptionTransition({ run })).rejects.toThrow(
      'OPFS encryption transition requires this page to reload',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the external OPFS shared session when application safety preflight fails', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    mockPrepareExternalTransition.mockRejectedValueOnce(new Error('worker cleanup failed'));
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }

    listener({
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: 'external-failed-preflight',
        initiatorTabId: 'external-tab',
        timestamp: 1,
      },
    });

    await vi.waitFor(() => {
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({
        settlement: 'preparation_failed',
      });
    });
    expect(mockSuspendStorageSession).not.toHaveBeenCalled();
  });

  it('runs external safety preparation and suspends after a presentation-only failure', async () => {
    service = new StorageService();
    await service.init({ type: 'opfs' });
    mockExternalTransitionStarting.mockRejectedValueOnce(new Error('overlay import failed'));
    const listener = mockSubscribe.mock.calls.at(-1)?.[0]?.listener as ((args: {
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: string,
        initiatorTabId: string,
        timestamp: number,
      },
    }) => void) | undefined;
    if (listener === undefined) {
      throw new Error('Expected storage synchronization listener');
    }

    listener({
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        operationId: 'external-presentation-failure',
        initiatorTabId: 'external-tab',
        timestamp: 1,
      },
    });

    await vi.waitFor(() => {
      expect(mockPrepareExternalTransition).toHaveBeenCalledOnce();
      expect(mockSuspendStorageSession).toHaveBeenCalledOnce();
      expect(mockExternalTransitionSettled).toHaveBeenCalledWith({
        settlement: 'preparation_failed',
      });
    });
  });

  it('should wrap updateSettings with lock and notify after success', async () => {
    const settings = { endpoint: { type: 'openai', url: 'test' } } as any;
    const updater = vi.fn().mockResolvedValue(settings);
    await service.updateSettings({ updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveSettings).toHaveBeenCalledWith({ settings });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'settings' }) });
  });

  it('should wrap clearAll with lock and notify migration', async () => {
    await service.clearAll();

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: SYNC_LOCK_KEY,
    }));
    expect(mockProvider.clearAll).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'migration' }) });
  });

  it('should wrap saveFile with lock but not notify (tied to chat)', async () => {
    const blob = new Blob(['test']);
    await service.saveFile({ blob, binaryObjectId: toBinaryObjectId({ raw: 'a1' }), name: 'test.txt' });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveFile).toHaveBeenCalledWith({
      blob,
      binaryObjectId: 'a1',
      name: 'test.txt',
      mimeType: undefined,
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should NOT notify if the operation inside lock fails', async () => {
    mockProvider.saveChatMeta.mockRejectedValue(new Error('Failed'));

    await expect(service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => ({} as any) })).rejects.toThrow('Failed');

    expect(mockWithLock).toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('should trigger info events via callbacks from withLock', async () => {
    const meta = { id: 'c1' } as any;

    // Extract the callbacks passed to withLock
    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => meta });
    const options = mockWithLock.mock.calls.find(([options]) => options?.lockKey === LOCK_METADATA)?.[0] as {
      onLockWait: () => void,
      onTaskSlow: () => void,
      onFinalize: () => void,
    };

    options.onLockWait();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('busy') }));

    options.onTaskSlow();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('longer than expected') }));

    options.onFinalize();
    expect(mockAddInfoEvent).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('completed') }));
  });

  it('should notify migration after switchProvider with custom lock options', async () => {
    mockProvider.dump.mockImplementation(async function* () {});

    await service.switchProvider({ type: 'opfs' });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      notifyLockWaitAfterMs: 5000,
    }));
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'migration' }) });
  });

  it('should report generic storage error via addErrorEvent', async () => {
    const diskError = new Error('Disk full');
    mockProvider.saveChatMeta.mockRejectedValueOnce(diskError);

    await expect(service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => ({} as any) })).rejects.toThrow(diskError);

    expect(mockAddErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('An error occurred'),
      details: diskError,
    }));
  });

  // --- New Atomic APIs (Granular Locking) ---

  it('should wrap updateChatMeta with metadata lock and notify', async () => {
    const meta = { id: 'c1' } as any;
    const updater = vi.fn().mockResolvedValue(meta);
    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({ meta });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });



  it('should preserve saved tool configs during ordinary chat meta updates regardless of the UI persistence mode', async () => {
    const meta = {
      id: 'c1',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    } as any;

    await service.updateChatMeta({ id: toChatId({ raw: 'c1' }), updater: () => meta });

    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({ meta });
    expect(mockProvider.loadSettings).not.toHaveBeenCalled();
  });

  it('should not gate restore snapshots by the tool config persistence setting', async () => {
    const snapshot = {
      structure: {
        settings: {
          experimental: {
            toolConfigPersistence: 'disabled',
          },
        },
        hierarchy: { items: [] },
        chatMetas: [{ id: 'c1', toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }] }],
        chatGroups: [],
      },
      contentStream: (async function* () {})(),
    } as any;

    await service.restore({ snapshot });

    expect(mockProvider.restore).toHaveBeenCalledWith({ snapshot });
  });

  it('should wrap updateChatContent with specific chat lock and notify', async () => {
    const content = { root: { items: [] } } as any;
    const updater = vi.fn().mockResolvedValue(content);
    await service.updateChatContent({ id: toChatId({ raw: 'c1' }), updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: `${LOCK_CHAT_CONTENT_PREFIX}c1`,
    }));
    expect(updater).toHaveBeenCalled();
    expect(mockProvider.saveChatContent).toHaveBeenCalledWith({ id: 'c1', content });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_content', id: 'c1' }) });
  });

  it('should wrap updateHierarchy with metadata lock and notify', async () => {
    const updater = ({ current }: { current: any }) => current;
    await service.updateHierarchy({ updater: updater });

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({
      fn: expect.any(Function),
      lockKey: LOCK_METADATA,
    }));
    expect(mockProvider.saveHierarchy).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group' }) });
  });
});
