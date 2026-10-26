import { describe, it, expect, vi, beforeEach } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only preload keeps real strings available without changing storage runtime dependencies.
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { ChatContentBindingChangedError, StorageService, type ChatContentWrite } from './index';
import { MemoryStorageProvider } from './memory-storage';
import { SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
import { toBinaryObjectId, toChatGroupId, toChatId, toVolumeId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type ChatMeta, type Hierarchy, type Settings, type StorageSnapshot } from '@/01-models/types';
import { formatHuggingFaceModelId } from '@/01-models/llama-cpp-browser-model-id';
import type { ChangeListener, StorageChangeEvent } from './synchronizer';

// We mock the synchronizer to track calls to withLock and notify
const { mockWithLock, mockNotify, mockSubscribe, mockSynchronizers } = vi.hoisted(() => ({
  mockWithLock: vi.fn().mockImplementation(({ fn }) => fn()),
  mockNotify: vi.fn(),
  mockSubscribe: vi.fn<({ listener }: { listener: ChangeListener }) => void>(),
  mockSynchronizers: [] as { receive({ event }: { event: StorageChangeEvent }): void }[],
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
      private listeners = new Set<ChangeListener>();

      constructor() {
        mockSynchronizers.push({ receive: ({ event }) => this.listeners.forEach(listener => listener({ event })) });
      }

      withLock = mockWithLock;
      notify = mockNotify;

      subscribe({ listener }: { listener: ChangeListener }) {
        mockSubscribe({ listener });
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
    },
  };
});

// Mock providers to avoid real storage access
const mockProvider = {
  init: vi.fn().mockResolvedValue(undefined),
  saveChatMeta: vi.fn().mockResolvedValue(undefined),
  loadChatMeta: vi.fn().mockResolvedValue(null),
  saveChatContent: vi.fn().mockResolvedValue(undefined),
  loadChatContent: vi.fn().mockResolvedValue(null),
  deleteChat: vi.fn().mockResolvedValue(undefined),
  deleteBinaryObject: vi.fn().mockResolvedValue(undefined),
  saveChatGroup: vi.fn().mockResolvedValue(undefined),
  loadChatGroup: vi.fn().mockResolvedValue(null),
  deleteChatGroup: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  clearAll: vi.fn().mockResolvedValue(undefined),
  saveFile: vi.fn().mockResolvedValue(undefined),
  loadChat: vi.fn().mockResolvedValue(null),
  listChats: vi.fn().mockResolvedValue([]),
  listChatGroups: vi.fn().mockResolvedValue([]),
  hasVolumeMountReference: vi.fn().mockResolvedValue(false),
  getVolumeDirectoryHandle: vi.fn().mockResolvedValue(null),
  deleteVolume: vi.fn().mockResolvedValue(undefined),
  getSidebarStructure: vi.fn().mockResolvedValue([]),
  loadSettings: vi.fn().mockResolvedValue(null),
  getFile: vi.fn().mockResolvedValue(null),
  hasAttachments: vi.fn().mockResolvedValue(false),
  loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
  saveHierarchy: vi.fn().mockResolvedValue(undefined),
  loadNaidanRpcRegistry: vi.fn().mockResolvedValue(undefined),
  saveNaidanRpcRegistry: vi.fn().mockResolvedValue(undefined),
  dump: vi.fn(),
  restore: vi.fn(),
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
      return mockProvider;
    }
  },
}));

const operationChatId = toChatId({ raw: 'operation-owner' });

function operationMeta({ title }: { title: string }): ChatMeta {
  return { id: operationChatId, title, createdAt: 1, updatedAt: 1, debugEnabled: false };
}

function restoredOwner({ meta }: { meta: ChatMeta }): StorageSnapshot {
  return { structure: { settings: { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } }, hierarchy: { items: [{ type: 'chat', id: meta.id }] }, chatMetas: [meta], chatGroups: [] }, contentStream: (async function* () {})() };
}

function serializeMockLocks() {
  const tails = new Map<string, Promise<void>>();
  mockWithLock.mockImplementation(async ({ lockKey, fn }: { lockKey: string, fn(): Promise<unknown> }) => {
    const previous = tails.get(lockKey) ?? Promise.resolve();
    const finished = Promise.withResolvers<void>();
    tails.set(lockKey, finished.promise);
    await previous;
    try {
      return await fn();
    } finally {
      finished.resolve();
    }
  });
}

function receiveChange({ event }: { event: StorageChangeEvent }): void {
  const synchronizer = mockSynchronizers[0];
  if (synchronizer === undefined) {
    throw new Error('The test service synchronizer is missing');
  }
  synchronizer.receive({ event });
}

describe('StorageService Synchronization Wrapper', () => {
  let service: StorageService;

  beforeEach(async () => {
    vi.resetAllMocks();
    await ensureAllStringsForTest({ locale: 'en' });
    mockSynchronizers.length = 0;

    // Restore default mock implementations after reset
    mockWithLock.mockImplementation(({ fn }) => fn());
    mockProvider.saveChatMeta.mockResolvedValue(undefined);
    mockProvider.saveHierarchy.mockResolvedValue(undefined);
    mockProvider.loadChatMeta.mockResolvedValue(null);
    mockProvider.loadHierarchy.mockResolvedValue({ items: [] });
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
    mockProvider.listChatGroups.mockResolvedValue([]);
    mockProvider.hasVolumeMountReference.mockResolvedValue(false);
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue(null);
    mockProvider.deleteVolume.mockResolvedValue(undefined);

    service = new StorageService();
    await service.init({ type: 'local' });
  });

  it('performs a conditional metadata no-op without writing or notifying', async () => {
    const updater = vi.fn().mockResolvedValue(undefined);
    await service.updateChatMeta({ id: toChatId({ raw: 'deleted-chat' }), updater });
    expect(updater).toHaveBeenCalledExactlyOnceWith({ current: null });
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: LOCK_METADATA }));
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('invalidates content, defaults, and launch authority before UI listeners receive migration', async () => {
    await service.init({ type: 'memory' });
    const repository = 'owner/Model-GGUF';
    const mainFilePath = 'Model-Q4_K_M.gguf';
    const modelId = formatHuggingFaceModelId({ repository, mainFilePath });
    await service.prepareModelLaunchChat({
      request: {
        chatId: operationChatId,
        newChatGroupId: toChatGroupId({ raw: 'received-migration-launch' }),
        chatGroupName: 'Model',
        input: `hf.co/${repository}:Q4_K_M`,
        requestedVariant: 'Q4_K_M',
        target: { selection: { repository, revision: 'a'.repeat(40), files: [{ path: mainFilePath, size: 256 }] }, mainFilePath, modelId },
        destination: { kind: 'opfs' },
        effectiveModelId: modelId,
        titleGeneration: 'disabled',
        mode: 'create',
        expectedTarget: undefined,
      },
      signal: new AbortController().signal,
    });
    expect(service.getModelLaunch({ chatId: operationChatId })?.phase).toBe('active');
    const content = (await service.loadChatContent({ id: operationChatId }))!;
    const write = service.createChatContentWrite({ id: operationChatId, content, binding: undefined });
    const defaultsAreCurrent = service.captureSettingsStorage();
    const launchIsCurrent = service.captureModelLaunchStorage();
    expect(mockSubscribe).toHaveBeenCalledOnce();
    const uiListener = vi.fn(() => {
      expect(defaultsAreCurrent()).toBe(false);
      expect(launchIsCurrent()).toBe(false);
      expect(service.getModelLaunch({ chatId: operationChatId })).toBeUndefined();
    });
    service.subscribeToChanges({ listener: uiListener });

    receiveChange({ event: { type: 'migration', timestamp: 7 } });

    expect(uiListener).toHaveBeenCalledOnce();
    const oldUpdater = vi.fn(() => content);
    await expect(service.updateChatContent({ id: operationChatId, write, updater: oldUpdater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    await expect(service.updateChatMeta({ id: operationChatId, write, updater: () => operationMeta({ title: 'Old completion' }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(oldUpdater).not.toHaveBeenCalled();
    await expect(service.updateSettingsForStorage({ isCurrent: defaultsAreCurrent, updater: () => ({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' } }) })).resolves.toBe('changed');

    const nextWrite = service.createChatContentWrite({ id: operationChatId, content, binding: undefined });
    expect(service.captureSettingsStorage()()).toBe(true);
    expect(service.captureModelLaunchStorage()()).toBe(true);
    await service.updateChatContent({ id: operationChatId, write: nextWrite, updater: () => content });
    await service.updateChatMeta({ id: operationChatId, write: nextWrite, updater: ({ current }) => ({ ...current!, title: 'Current completion' }) });
    expect((await service.loadChatMeta({ id: operationChatId }))?.title).toBe('Current completion');
    expect(service.getModelLaunch({ chatId: operationChatId })).toBeUndefined();
  });

  it('does not invalidate current authority when an unrelated content hint arrives', async () => {
    const defaultsAreCurrent = service.captureSettingsStorage();
    const launchIsCurrent = service.captureModelLaunchStorage();
    const write = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    receiveChange({ event: { type: 'chat_content', id: 'another-chat', timestamp: 7 } });
    expect(defaultsAreCurrent()).toBe(true);
    expect(launchIsCurrent()).toBe(true);
    await service.updateChatContent({ id: operationChatId, write, updater: () => ({ root: { items: [] } }) });
    expect(mockProvider.saveChatContent).toHaveBeenCalledOnce();
    expect(mockSubscribe).toHaveBeenCalledOnce();
  });

  it('invalidates authority again for distinct migration hints with the same timestamp', () => {
    const first = service.captureSettingsStorage();
    receiveChange({ event: { type: 'migration', timestamp: 7 } });
    expect(first()).toBe(false);
    const betweenHints = service.captureSettingsStorage();
    expect(betweenHints()).toBe(true);
    receiveChange({ event: { type: 'migration', timestamp: 7 } });
    expect(betweenHints()).toBe(false);
  });

  it.each(['clear', 'restore'] as const)('rejects old post-content metadata after same-provider %s recreates its chat ID', async change => {
    await service.init({ type: 'memory' });
    await service.updateChatMeta({ id: operationChatId, updater: () => operationMeta({ title: 'Original owner' }) });
    const write = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    await service.updateChatContent({ id: operationChatId, write, updater: () => ({ root: { items: [] } }) });
    const restored = operationMeta({ title: 'New provider generation' });
    switch (change) {
    case 'clear':
      await service.clearAll();
      await service.updateChatMeta({ id: operationChatId, updater: () => restored });
      break;
    case 'restore':
      await service.restore({ snapshot: restoredOwner({ meta: restored }) });
      break;
    default: {
      const exhaustive: never = change;
      throw new Error(String(exhaustive));
    }
    }
    mockNotify.mockClear();
    const updater = vi.fn((): ChatMeta => ({ ...restored, title: 'Old completion', systemPrompt: { behavior: 'override', content: 'Old prompt' } }));
    await expect(service.updateChatMeta({ id: operationChatId, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(await service.loadChatMeta({ id: operationChatId })).toMatchObject({ title: restored.title, systemPrompt: undefined });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockAddErrorEvent).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'hierarchy'] as const)('rejects another service capability before its %s read', async operation => {
    const other = new StorageService();
    // Both services deliberately receive the same mocked provider instance.
    await other.init({ type: 'local' });
    const write = other.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    const updater = vi.fn(() => operationMeta({ title: 'Foreign operation' }));
    switch (operation) {
    case 'metadata':
      await expect(service.updateChatMeta({ id: operationChatId, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
      break;
    case 'hierarchy':
      await expect(service.updateHierarchy({ contentWrite: { id: operationChatId, write }, updater: () => ({ items: [] }) })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    expect(mockProvider.loadChatMeta).not.toHaveBeenCalled();
    expect(mockProvider.loadHierarchy).not.toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockProvider.saveHierarchy).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockAddErrorEvent).not.toHaveBeenCalled();
  });

  it('rejects an old final hierarchy update after its content and metadata were saved before restore', async () => {
    await service.init({ type: 'memory' });
    const write = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    await service.updateChatContent({ id: operationChatId, write, updater: () => ({ root: { items: [] } }) });
    await service.updateChatMeta({ id: operationChatId, write, updater: () => operationMeta({ title: 'Old creation' }) });
    await service.restore({ snapshot: restoredOwner({ meta: operationMeta({ title: 'Restored owner' }) }) });
    mockNotify.mockClear();
    const updater = vi.fn((): Hierarchy => ({ items: [{ type: 'chat', id: toChatId({ raw: 'old-created-chat' }) }] }));
    await expect(service.updateHierarchy({ contentWrite: { id: operationChatId, write }, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(await service.loadHierarchy()).toEqual({ items: [{ type: 'chat', id: operationChatId }] });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('rejects a metadata capability for a different chat ID before reading', async () => {
    const write = service.createChatContentWrite({ id: toChatId({ raw: 'another-owner' }), content: undefined, binding: undefined });
    const updater = vi.fn(() => operationMeta({ title: 'Wrong owner' }));
    await expect(service.updateChatMeta({ id: operationChatId, write, updater })).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(mockProvider.loadChatMeta).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'hierarchy'] as const)('checks operation ownership before the %s read after waiting for its lock', async operation => {
    const write = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    const waiting = Promise.withResolvers<void>();
    mockWithLock.mockImplementationOnce(async ({ fn }: { fn(): Promise<void> }) => {
      await waiting.promise;
      return fn();
    });
    let saving: Promise<void>;
    switch (operation) {
    case 'metadata': saving = service.updateChatMeta({ id: operationChatId, write, updater: () => operationMeta({ title: 'Old completion' }) });
      break;
    case 'hierarchy': saving = service.updateHierarchy({ contentWrite: { id: operationChatId, write }, updater: () => ({ items: [{ type: 'chat', id: operationChatId }] }) });
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    await service.init({ type: 'memory' });
    waiting.resolve();
    await expect(saving).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(mockProvider.loadChatMeta).not.toHaveBeenCalled();
    expect(mockProvider.loadHierarchy).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does not call the metadata updater when ownership changes during its read', async () => {
    const reading = Promise.withResolvers<ChatMeta | null>();
    const entered = Promise.withResolvers<void>();
    mockProvider.loadChatMeta.mockImplementationOnce(() => {
      entered.resolve();
      return reading.promise;
    });
    const updater = vi.fn(() => operationMeta({ title: 'Old completion' }));
    const saving = service.updateChatMeta({ id: operationChatId, updater });
    await entered.promise;
    await service.init({ type: 'memory' });
    reading.resolve(operationMeta({ title: 'Old read' }));
    await expect(saving).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
  });

  it('does not call the hierarchy updater when ownership changes during its read', async () => {
    const reading = Promise.withResolvers<Hierarchy>();
    const entered = Promise.withResolvers<void>();
    mockProvider.loadHierarchy.mockImplementationOnce(() => {
      entered.resolve();
      return reading.promise;
    });
    const updater = vi.fn(({ current }: { current: Hierarchy }) => current);
    const saving = service.updateHierarchy({ updater });
    await entered.promise;
    await service.init({ type: 'memory' });
    reading.resolve({ items: [] });
    await expect(saving).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(updater).not.toHaveBeenCalled();
    expect(mockProvider.saveHierarchy).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'hierarchy'] as const)('keeps ordinary %s updates on their captured generation across an async updater', async operation => {
    using metaSave = vi.spyOn(MemoryStorageProvider.prototype, 'saveChatMeta');
    using hierarchySave = vi.spyOn(MemoryStorageProvider.prototype, 'saveHierarchy');
    let saving: Promise<void>;
    switch (operation) {
    case 'metadata': saving = service.updateChatMeta({
      id: operationChatId,
      updater: async () => {
        await service.init({ type: 'memory' });
        return operationMeta({ title: 'Stale metadata' });
      },
    });
      break;
    case 'hierarchy': saving = service.updateHierarchy({
      updater: async () => {
        await service.init({ type: 'memory' });
        return { items: [{ type: 'chat', id: operationChatId }] };
      },
    });
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    await expect(saving).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockProvider.saveHierarchy).not.toHaveBeenCalled();
    expect(metaSave).not.toHaveBeenCalled();
    expect(hierarchySave).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'hierarchy'] as const)('rechecks generation after waiting for the %s commit lock', async operation => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    mockWithLock.mockImplementation(async ({ lockKey, fn }: { lockKey: string, fn(): Promise<unknown> }) => {
      if (lockKey === SYNC_LOCK_KEY && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return fn();
    });
    let saving: Promise<void>;
    switch (operation) {
    case 'metadata': saving = service.updateChatMeta({ id: operationChatId, updater: () => operationMeta({ title: 'Old completion' }) });
      break;
    case 'hierarchy': saving = service.updateHierarchy({ updater: () => ({ items: [{ type: 'chat', id: operationChatId }] }) });
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    await entered.promise;
    await service.clearAll();
    mockNotify.mockClear();
    release.resolve();
    await expect(saving).rejects.toBeInstanceOf(ChatContentBindingChangedError);
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockProvider.saveHierarchy).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'hierarchy'] as const)('serializes an in-flight %s save before same-provider restore', async operation => {
    await service.init({ type: 'memory' });
    const write = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    await service.updateChatContent({ id: operationChatId, write, updater: () => ({ root: { items: [] } }) });
    serializeMockLocks();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using _releaseOnExit = {
      [Symbol.dispose]() {
        release.resolve();
      },
    };
    const metaSave = MemoryStorageProvider.prototype.saveChatMeta;
    const hierarchySave = MemoryStorageProvider.prototype.saveHierarchy;
    using pausedMetaSave = vi.spyOn(MemoryStorageProvider.prototype, 'saveChatMeta');
    using pausedHierarchySave = vi.spyOn(MemoryStorageProvider.prototype, 'saveHierarchy');
    using restore = vi.spyOn(MemoryStorageProvider.prototype, 'restore');
    let saving: Promise<void>;
    switch (operation) {
    case 'metadata': {
      pausedMetaSave.mockImplementationOnce(async function (this: MemoryStorageProvider, args) {
        entered.resolve();
        await release.promise;
        return metaSave.call(this, args);
      });
      saving = service.updateChatMeta({ id: operationChatId, write, updater: () => operationMeta({ title: 'Old completion' }) });
      break;
    }
    case 'hierarchy': {
      pausedHierarchySave.mockImplementationOnce(async function (this: MemoryStorageProvider, args) {
        entered.resolve();
        await release.promise;
        return hierarchySave.call(this, args);
      });
      saving = service.updateHierarchy({ contentWrite: { id: operationChatId, write }, updater: () => ({ items: [{ type: 'chat', id: toChatId({ raw: 'old-created-chat' }) }] }) });
      break;
    }
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    await entered.promise;
    const restored = operationMeta({ title: 'Restored generation' });
    const restoring = service.restore({ snapshot: restoredOwner({ meta: restored }) });
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();
    release.resolve();
    await saving;
    await restoring;
    expect(await service.loadChatMeta({ id: operationChatId })).toMatchObject({ title: restored.title });
    expect(await service.loadHierarchy()).toEqual({ items: [{ type: 'chat', id: operationChatId }] });
  });

  it('does not hold the commit lock while an ordinary metadata updater changes settings', async () => {
    serializeMockLocks();
    const meta = operationMeta({ title: 'Ordinary update' });
    await service.updateChatMeta({
      id: meta.id,
      updater: async () => {
        await service.updateSettings({ updater: () => ({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } }) });
        return meta;
      },
    });
    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({ meta });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group' }) });
  });

  it('keeps a valid operation metadata no-op without advancing its content baseline', async () => {
    const write: ChatContentWrite = service.createChatContentWrite({ id: operationChatId, content: undefined, binding: undefined });
    await service.updateChatMeta({ id: operationChatId, write, updater: () => undefined });
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    await service.updateChatContent({ id: operationChatId, write, updater: () => ({ root: { items: [] } }) });
    expect(mockProvider.saveChatContent).toHaveBeenCalledOnce();
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

  it('keeps binary deletion on its original provider while waiting for the metadata lock', async () => {
    const ready = Promise.withResolvers<void>();
    mockWithLock.mockImplementationOnce(async ({ fn }: { fn: () => Promise<void> }) => {
      await ready.promise;
      return fn();
    });
    const memoryDelete = vi.spyOn(MemoryStorageProvider.prototype, 'deleteBinaryObject');
    const binaryObjectId = toBinaryObjectId({ raw: 'selected-image' });
    const deleting = service.deleteBinaryObject({ binaryObjectId });
    await service.init({ type: 'memory' });
    ready.resolve();
    await deleting;
    expect(mockProvider.deleteBinaryObject).toHaveBeenCalledExactlyOnceWith({ binaryObjectId });
    expect(memoryDelete).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledExactlyOnceWith({ event: expect.objectContaining({ type: 'binary_objects' }) });
    memoryDelete.mockRestore();
  });

  it('propagates a failed binary deletion without publishing success', async () => {
    mockProvider.deleteBinaryObject.mockRejectedValueOnce(new Error('Cannot remove image'));
    await expect(service.deleteBinaryObject({ binaryObjectId: toBinaryObjectId({ raw: 'selected-image' }) })).rejects.toThrow('Cannot remove image');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockAddErrorEvent).toHaveBeenCalled();
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

  it('rejects a settings owner captured before clearing the same provider', async () => {
    const isCurrent = service.captureSettingsStorage();
    await service.clearAll();
    const updater = vi.fn((): Settings => ({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } }));
    await expect(service.updateSettingsForStorage({ isCurrent, updater })).resolves.toBe('changed');
    expect(updater).not.toHaveBeenCalled();
    expect(mockProvider.saveSettings).not.toHaveBeenCalled();
  });

  it('checks settings ownership again after a delayed provider read', async () => {
    const isCurrent = service.captureSettingsStorage();
    const reading = Promise.withResolvers<Settings | null>();
    mockProvider.loadSettings.mockReturnValueOnce(reading.promise);
    const updater = vi.fn((): Settings => ({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' } }));
    const saving = service.updateSettingsForStorage({ isCurrent, updater });
    await vi.waitFor(() => expect(mockProvider.loadSettings).toHaveBeenCalledOnce());
    await service.init({ type: 'memory' });
    reading.resolve(null);
    await expect(saving).resolves.toBe('changed');
    expect(updater).not.toHaveBeenCalled();
    expect(mockProvider.saveSettings).not.toHaveBeenCalled();
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

  it('does not add a chat mount when its chat group already uses the same path', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const groupId = toChatGroupId({ raw: 'g1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, groupId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.loadChatGroup.mockResolvedValue({
      id: groupId,
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace', readOnly: false }],
    });
    mockWithLock.mockClear();
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: LOCK_METADATA }));
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: SYNC_LOCK_KEY }));
  });

  it('does not add a chat mount when global settings already use the same path', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace', readOnly: false }],
    });
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.loadChatGroup).not.toHaveBeenCalled();
    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
  });

  it('treats lexically equivalent inherited mount paths as occupied', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const groupId = toChatGroupId({ raw: 'g1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, groupId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.loadChatGroup.mockResolvedValue({
      id: groupId,
      mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'existing' }), mountPath: '/workspace/./', readOnly: false }],
    });
    mockProvider.saveChatMeta.mockClear();

    await expect(service.addMountToChatIfPathAvailable({
      chatId,
      mount: { type: 'volume', volumeId, mountPath: '/workspace', readOnly: false },
    })).resolves.toBe('path_occupied');

    expect(mockProvider.saveChatMeta).not.toHaveBeenCalled();
  });

  it('atomically adds a chat mount when the effective path is unused', async () => {
    const chatId = toChatId({ raw: 'c1' });
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.loadChatMeta.mockResolvedValue({ id: chatId, mounts: [] });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.saveChatMeta.mockClear();

    const mount = { type: 'volume' as const, volumeId, mountPath: '/workspace', readOnly: false };
    await expect(service.addMountToChatIfPathAvailable({ chatId, mount })).resolves.toBe('added');

    expect(mockProvider.saveChatMeta).toHaveBeenCalledWith({
      meta: expect.objectContaining({ mounts: [mount] }),
    });
    expect(mockNotify).toHaveBeenCalledWith({ event: expect.objectContaining({ type: 'chat_meta_and_chat_group', id: 'c1' }) });
  });

  it('skips volume reference locks when a detached volume is not empty', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue({
      async *values() {
        yield { kind: 'file', name: 'keep.txt' };
      },
    });
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('kept');

    expect(mockProvider.hasVolumeMountReference).not.toHaveBeenCalled();
    expect(mockProvider.deleteVolume).not.toHaveBeenCalled();
    expect(mockWithLock).not.toHaveBeenCalled();
  });

  it('rechecks volume references while holding metadata and settings locks before deletion', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    const emptyHandle = { async *values() {} };
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue(emptyHandle);
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockProvider.hasVolumeMountReference
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('kept');

    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: LOCK_METADATA }));
    expect(mockWithLock).toHaveBeenCalledWith(expect.objectContaining({ lockKey: SYNC_LOCK_KEY }));
    expect(mockProvider.deleteVolume).not.toHaveBeenCalled();
  });

  it('deletes an empty unreferenced volume after the locked final recheck', async () => {
    const volumeId = toVolumeId({ raw: 'v1' });
    mockProvider.getVolumeDirectoryHandle.mockResolvedValue({ async *values() {} });
    mockProvider.loadSettings.mockResolvedValue({ mounts: [] });
    mockWithLock.mockClear();

    await expect(service.deleteVolumeIfEmptyAndUnreferenced({ volumeId })).resolves.toBe('deleted');

    expect(mockProvider.deleteVolume).toHaveBeenCalledWith({ volumeId });
    expect(mockProvider.hasVolumeMountReference).toHaveBeenCalledTimes(2);
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
      message: 'An error occurred during a storage operation.',
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
    await service.updateChatContent({ id: toChatId({ raw: 'c1' }), write: service.createChatContentWrite({ id: toChatId({ raw: 'c1' }), content: undefined, binding: undefined }), updater: updater });

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
