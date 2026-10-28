// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- Test-only preload keeps real strings available without changing storage runtime dependencies.
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { StorageService } from './index';
import { createLazyVolumeTestHarness, type MemoryFile } from './lazy-volumes.test-support';
import { createRemoteDirectoryHandle } from '@/utils/remote-directory-handle';
import type { IStorageProvider } from './interface';
import type { StoredVolumeAccess } from '@/01-models/volume-access';
import type { ChangeListener, StorageChangeEvent } from './synchronizer';
import type { VolumeId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type StorageSnapshot, type Volume } from '@/01-models/types';

const controls = vi.hoisted(() => ({
  provider: undefined as IStorageProvider | undefined,
  events: [] as string[],
  notifications: [] as StorageChangeEvent[],
  synchronizers: [] as { receive({ event }: { event: StorageChangeEvent }): void }[],
  errorEvent: vi.fn(),
  infoEvent: vi.fn(),
}));

vi.mock('./opfs-storage', () => ({
  OPFSStorageProvider: class {
    constructor() {
      if (controls.provider === undefined) {
        throw new Error('The test provider must be configured before initialization');
      }
      return controls.provider;
    }
  },
}));

vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: async () => true }));

vi.mock('./synchronizer', () => ({
  StorageSynchronizer: class {
    private listeners = new Set<ChangeListener>();

    constructor() {
      controls.synchronizers.push({
        receive: ({ event }) => {
          for (const listener of this.listeners) {
            void listener({ event });
          }
        },
      });
    }

    async withLock<T>({ lockKey, fn }: { lockKey: string, fn(): Promise<T> }): Promise<T> {
      controls.events.push(`lock:${lockKey}`);
      return await fn();
    }

    notify({ event }: { event: StorageChangeEvent }): void {
      controls.notifications.push(event);
    }

    subscribe({ listener }: { listener: ChangeListener }): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }
  },
}));

// eslint-disable-next-line local-rules/enforce-dependency-directions -- Mirrors the existing StorageService application-event boundary for an isolated storage lifecycle test.
vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({ addErrorEvent: controls.errorEvent, addInfoEvent: controls.infoEvent }),
}));

const cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  controls.provider = undefined;
  controls.events.length = 0;
  controls.notifications.length = 0;
  controls.synchronizers.length = 0;
  controls.errorEvent.mockClear();
  controls.infoEvent.mockClear();
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

function snapshot(): StorageSnapshot {
  return {
    structure: { settings: { ...DEFAULT_SETTINGS, storageType: 'opfs', endpoint: { type: 'openai', url: '' } }, hierarchy: { items: [] }, chatMetas: [], chatGroups: [] },
    contentStream: (async function* () {})(),
  };
}

async function harness({ beforeOpen, beforeWrite }: {
  beforeOpen: Parameters<typeof createLazyVolumeTestHarness>[0]['beforeOpen'],
  beforeWrite: Parameters<typeof createLazyVolumeTestHarness>[0]['beforeWrite'],
}) {
  const h = createLazyVolumeTestHarness({ beforeOpen, beforeWrite });
  const published = new Map<VolumeId, Volume>();
  const created = new Set<VolumeId>();
  vi.mocked(h.provider.ensureVolumeDirectory).mockImplementation(async ({ volumeId }) => {
    created.add(volumeId);
    return h.root.handle;
  });
  vi.mocked(h.provider.publishVolume).mockImplementation(async ({ volume }) => {
    published.set(volume.id, volume);
  });
  const backend = {
    init: vi.fn(async () => {}),
    async *listVolumes() {
      yield* published.values();
    },
    probeVolumeAccess: vi.fn(async ({ volumeId }: { volumeId: VolumeId }): Promise<StoredVolumeAccess> => {
      const volume = published.get(volumeId);
      if (volume !== undefined) {
        return { kind: 'native', volume, handle: h.root.handle };
      }
      return created.has(volumeId) ? { kind: 'incomplete', volumeId, handle: h.root.handle } : { kind: 'missing', volumeId };
    }),
    deleteVolume: vi.fn(async ({ volumeId }: { volumeId: VolumeId }) => {
      published.delete(volumeId);
      created.delete(volumeId);
    }),
    clearAll: vi.fn(async () => {
      controls.events.push('backend:clear');
      h.root.children.clear();
      published.clear();
      created.clear();
    }),
    restore: vi.fn(async ({ snapshot: _snapshot }: { snapshot: StorageSnapshot }) => {
      controls.events.push('backend:restore');
    }),
    dump: vi.fn(async () => snapshot()),
    loadNaidanRpcRegistry: vi.fn(async () => undefined),
  };
  Object.assign(h.provider, backend);
  controls.provider = h.provider;
  const service = new StorageService();
  await service.init({ type: 'opfs' });
  controls.events.length = 0;
  cleanup.push(async () => {
    await service.clearAll();
    await h.manager.dispose();
    await h.dispose();
  });
  async function attach({ file }: { file: File }) {
    const volume = await service.registerLazyVolume({ name: 'Documents', entries: [{ file, relativePath: file.name }], signal: undefined });
    const connection = await service.createManagedVolumeAccess({ reference: { volumeId: volume.id }, readOnly: false });
    return { volume, connection, handle: createRemoteDirectoryHandle({ access: connection.access, root: connection.root }) };
  }
  return { ...h, backend, service, attach };
}

describe('StorageService lazy volume lifetime', () => {
  it('uses backend existence after saving instead of reviving a volume deleted by a peer', async () => {
    const h = await harness({ beforeOpen: undefined, beforeWrite: undefined });
    const { volume } = await h.attach({ file: new File(['saved'], 'notes.txt') });
    await vi.waitFor(() => expect(h.service.getLazyVolumeState({ volumeId: volume.id })?.phase).toBe('saved'));
    expect(await Array.fromAsync(h.service.listVolumes())).toEqual([volume]);
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('managed');

    // Another provider updates the persisted index without going through this
    // page's manager or broadcasting a whole-storage clear event.
    await h.backend.deleteVolume({ volumeId: volume.id });

    expect(await Array.fromAsync(h.service.listVolumes())).toEqual([]);
    expect(await h.service.resolveVolumeAccess({ volumeId: volume.id })).toEqual({ kind: 'missing', volumeId: volume.id });
    await expect(h.service.createManagedVolumeAccess({ reference: { volumeId: volume.id }, readOnly: false })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(h.provider.deleteUnpublishedVolumeDirectory).not.toHaveBeenCalled();
  });

  it('does not bind a saved manager to another native root at the same volume id', async () => {
    const h = await harness({ beforeOpen: undefined, beforeWrite: undefined });
    const { volume } = await h.attach({ file: new File(['original'], 'notes.txt') });
    await vi.waitFor(() => expect(h.service.getLazyVolumeState({ volumeId: volume.id })?.phase).toBe('saved'));
    const replacement = createLazyVolumeTestHarness({ beforeOpen: undefined, beforeWrite: undefined });
    cleanup.push(() => replacement.dispose());
    const native: StoredVolumeAccess = { kind: 'native', volume: { ...volume, name: 'Replacement' }, handle: replacement.root.handle };
    h.backend.probeVolumeAccess.mockResolvedValue(native);

    expect(await h.service.resolveVolumeAccess({ volumeId: volume.id })).toEqual(native);
    await expect(h.service.createManagedVolumeAccess({ reference: { volumeId: volume.id }, readOnly: false })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    expect(h.provider.deleteUnpublishedVolumeDirectory).not.toHaveBeenCalled();
  });

  it('invalidates and drains a running copy before clearing backend data or taking its global lock', async () => {
    const copy = Promise.withResolvers<void>();
    using _releaseCopy = {
      [Symbol.dispose]() {
        copy.resolve();
      },
    };
    const h = await harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await copy.promise;
      },
    });
    const { volume, handle } = await h.attach({ file: new File(['original'], 'notes.txt') });
    const notes = await handle.getFileHandle('notes.txt');
    await vi.waitFor(() => expect(h.root.children.has('notes.txt')).toBe(true));
    const clearing = h.service.clearAll();

    await vi.waitFor(async () => {
      await expect(notes.getFile()).rejects.toMatchObject({ name: 'InvalidStateError' });
    });
    expect(h.backend.clearAll).not.toHaveBeenCalled();
    expect(controls.events).toEqual([]);
    await expect(h.service.registerLazyVolume({ name: 'Late', entries: [], signal: undefined })).rejects.toMatchObject({ name: 'InvalidStateError' });

    copy.resolve();
    await clearing;
    expect(h.backend.clearAll).toHaveBeenCalledOnce();
    expect(controls.events.at(-1)).toBe('backend:clear');
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })).toBeUndefined();
    expect(await Array.fromAsync(h.service.listVolumes())).toEqual([]);
    expect(h.publish).not.toHaveBeenCalled();
    expect(controls.notifications).toContainEqual({ type: 'migration', timestamp: expect.any(Number), volumeFilesRemoved: true });
    await expect(h.service.createManagedVolumeAccess({ reference: { volumeId: volume.id }, readOnly: true })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps paused source Files and their managed access through metadata restore', async () => {
    const copy = Promise.withResolvers<void>();
    using _releaseCopy = {
      [Symbol.dispose]() {
        copy.resolve();
      },
    };
    const h = await harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await copy.promise;
      },
    });
    const file = new File(['original'], 'notes.txt');
    const { volume, handle } = await h.attach({ file });
    await vi.waitFor(() => expect(h.root.children.has('notes.txt')).toBe(true));
    h.service.pauseLazyVolumeCopy({ volumeId: volume.id });

    await h.service.restore({ snapshot: snapshot() });

    expect(h.backend.restore).toHaveBeenCalledOnce();
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    expect(h.provider.deleteUnpublishedVolumeDirectory).not.toHaveBeenCalled();
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('managed');
    expect(await (await (await handle.getFileHandle('notes.txt')).getFile()).text()).toBe('original');
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })?.phase).toBe('paused');
    expect(controls.notifications.filter(event => event.type === 'migration')).toEqual([{ type: 'migration', timestamp: expect.any(Number) }]);
  });

  it('rejects a provider switch with unsaved source Files and leaves the existing access usable', async () => {
    const copy = Promise.withResolvers<void>();
    using _releaseCopy = {
      [Symbol.dispose]() {
        copy.resolve();
      },
    };
    const h = await harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await copy.promise;
      },
    });
    const file = new File(['still available'], 'notes.txt');
    const { volume, handle } = await h.attach({ file });
    await vi.waitFor(() => expect(h.root.children.has('notes.txt')).toBe(true));

    await expect(h.service.switchProvider({ type: 'local' })).rejects.toThrow('Finish saving attached folders');

    expect(h.service.getCurrentType()).toBe('opfs');
    expect(h.backend.dump).not.toHaveBeenCalled();
    expect(h.backend.restore).not.toHaveBeenCalled();
    expect(h.backend.clearAll).not.toHaveBeenCalled();
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('managed');
    expect(await (await (await handle.getFileHandle('notes.txt')).getFile()).text()).toBe('still available');
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })).toBeDefined();
    expect(controls.errorEvent).toHaveBeenCalledOnce();
  });

  it('retires an old manager before repeated initialization and never revives its pending list entry', async () => {
    const copy = Promise.withResolvers<void>();
    using _releaseCopy = {
      [Symbol.dispose]() {
        copy.resolve();
      },
    };
    const h = await harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await copy.promise;
      },
    });
    const { volume, handle } = await h.attach({ file: new File(['original'], 'notes.txt') });
    await vi.waitFor(() => expect(h.root.children.has('notes.txt')).toBe(true));
    const initializing = h.service.init({ type: 'opfs' });
    await vi.waitFor(async () => {
      await expect(handle.getFileHandle('notes.txt')).rejects.toMatchObject({ name: 'InvalidStateError' });
    });
    expect(h.backend.init).toHaveBeenCalledOnce();

    copy.resolve();
    await initializing;
    expect(h.backend.init).toHaveBeenCalledTimes(2);
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })).toBeUndefined();
    expect(await Array.fromAsync(h.service.listVolumes())).toEqual([]);
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('incomplete');
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    expect(h.provider.deleteUnpublishedVolumeDirectory).not.toHaveBeenCalled();
    await expect(h.service.createManagedVolumeAccess({ reference: { volumeId: volume.id }, readOnly: true })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('keeps paused source Files usable after an external metadata-only migration hint', async () => {
    const copy = Promise.withResolvers<void>();
    using _releaseCopy = {
      [Symbol.dispose]() {
        copy.resolve();
      },
    };
    const h = await harness({
      beforeOpen: undefined,
      beforeWrite: async () => {
        await copy.promise;
      },
    });
    const { volume, handle } = await h.attach({ file: new File(['original'], 'notes.txt') });
    await vi.waitFor(() => expect(h.root.children.has('notes.txt')).toBe(true));
    h.service.pauseLazyVolumeCopy({ volumeId: volume.id });
    const synchronizer = controls.synchronizers.at(-1);
    if (synchronizer === undefined) {
      throw new Error('The service synchronizer is missing');
    }

    synchronizer.receive({ event: { type: 'migration', timestamp: 1 } });

    expect(await (await (await handle.getFileHandle('notes.txt')).getFile()).text()).toBe('original');
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })?.phase).toBe('paused');
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('managed');
    expect(h.backend.clearAll).not.toHaveBeenCalled();
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
  });

  it('rejects a registration still loading its manager when clear starts', async () => {
    const h = await harness({ beforeOpen: undefined, beforeWrite: undefined });
    const registration = h.service.registerLazyVolume({ name: 'Late', entries: [{ file: new File(['original'], 'notes.txt'), relativePath: 'notes.txt' }], signal: undefined });
    const rejected = expect(registration).rejects.toMatchObject({ name: 'InvalidStateError' });
    const clearing = h.service.clearAll();

    await Promise.all([rejected, clearing]);

    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(await Array.fromAsync(h.service.listVolumes())).toEqual([]);
  });

  it('does not reject manager loading merely because metadata is restored', async () => {
    const h = await harness({ beforeOpen: undefined, beforeWrite: undefined });
    const registration = h.service.registerLazyVolume({ name: 'Documents', entries: [{ file: new File(['original'], 'notes.txt'), relativePath: 'notes.txt' }], signal: undefined });
    const restored = h.service.restore({ snapshot: snapshot() });
    const volume = await registration;
    await restored;
    await h.service.retryLazyVolumeCopy({ volumeId: volume.id });

    expect(h.service.getLazyVolumeState({ volumeId: volume.id })?.phase).toBe('saved');
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('managed');
  });

  it('does not announce physical folder removal when backend clearing fails', async () => {
    const h = await harness({ beforeOpen: undefined, beforeWrite: undefined });
    const { volume, handle } = await h.attach({ file: new File(['original'], 'notes.txt') });
    await h.service.retryLazyVolumeCopy({ volumeId: volume.id });
    h.backend.clearAll.mockRejectedValueOnce(new Error('Clear failed'));

    await expect(h.service.clearAll()).rejects.toThrow('Clear failed');

    expect(controls.notifications.filter(event => event.type === 'migration')).toEqual([]);
    expect(h.service.getLazyVolumeState({ volumeId: volume.id })).toBeUndefined();
    await expect(handle.getFileHandle('notes.txt')).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('native');
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
  });

  it('invalidates access on an external migration hint and drains a writer that finishes opening later', async () => {
    const opened = Promise.withResolvers<void>();
    using _releaseOpen = {
      [Symbol.dispose]() {
        opened.resolve();
      },
    };
    const h = await harness({
      beforeOpen: async ({ keepExistingData }) => {
        if (keepExistingData) {
          await opened.promise;
        }
      },
      beforeWrite: undefined,
    });
    const { volume, handle } = await h.attach({ file: new File(['original'], 'notes.txt') });
    await h.service.retryLazyVolumeCopy({ volumeId: volume.id });
    const notes = await handle.getFileHandle('notes.txt');
    const opening = notes.createWritable({ keepExistingData: true });
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    const native = h.root.children.get('notes.txt') as MemoryFile;
    await vi.waitFor(() => expect(native.opens).toBe(2));
    const synchronizer = controls.synchronizers.at(-1);
    if (synchronizer === undefined) {
      throw new Error('The service synchronizer is missing');
    }
    synchronizer.receive({ event: { type: 'migration', timestamp: 1, volumeFilesRemoved: true } });
    await expect(notes.getFile()).rejects.toMatchObject({ name: 'InvalidStateError' });

    opened.resolve();
    await rejected;
    await vi.waitFor(() => expect(h.service.getLazyVolumeState({ volumeId: volume.id })).toBeUndefined());
    expect(native.aborts).toBe(1);
    expect(h.backend.clearAll).not.toHaveBeenCalled();
    expect(h.backend.restore).not.toHaveBeenCalled();
    expect(h.provider.deleteVolume).not.toHaveBeenCalled();
    expect((await h.service.resolveVolumeAccess({ volumeId: volume.id })).kind).toBe('native');
  });
});
