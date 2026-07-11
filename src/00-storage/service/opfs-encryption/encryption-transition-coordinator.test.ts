import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncryptionStateDto } from '@/00-storage/00-dto/encryption.dto';
import type { Chat, ChatGroup } from '@/01-models/types';
import {
  idToRaw,
  toBinaryObjectId,
  toChatGroupId,
  toChatId,
} from '@/01-models/ids';
import {
  MockFileSystemDirectoryHandle,
} from '@/utils/in-memory-file-system';
import type { EncryptedOPFSStorageBackend } from './encrypted-opfs-storage-backend';
import {
  EncryptionTransitionCoordinator,
  type EncryptionTransitionResult,
} from './encryption-transition-coordinator';
import { EncryptionStateStore } from './encryption-state-store';

const navigatorPropertyDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function installNavigatorMocks({
  opfsRoot,
}: {
  opfsRoot: FileSystemDirectoryHandle,
}): void {
  for (const property of ['storage', 'locks'] as const) {
    navigatorPropertyDescriptors.set(
      property,
      Object.getOwnPropertyDescriptor(navigator, property),
    );
  }

  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => opfsRoot,
    } satisfies Partial<StorageManager>,
  });

  const request = vi.fn(async (...arguments_: unknown[]) => {
    const callback = arguments_.at(-1);
    if (typeof callback !== 'function') {
      throw new Error('Web Locks callback is missing');
    }
    return await callback({
      name: 'naidan:sync:lock:opfs_encryption_transition',
      mode: 'exclusive',
    });
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request },
  });
}

function createTransitionState({
  operation,
}: {
  operation: Extract<EncryptionStateDto, { state: 'transitioning' }>['operation'],
}): Extract<EncryptionStateDto, { state: 'transitioning' }> {
  return {
    formatVersion: 1,
    sequence: 4,
    state: 'transitioning',
    keySlots: [{
      id: 'passphrase-slot',
      type: 'passphrase',
      kdf: {
        type: 'pbkdf2_sha256',
        salt: 'salt',
        iterations: 1,
      },
      wrappedStorageUnlockKey: {
        nonce: 'nonce',
        ciphertext: 'ciphertext',
      },
    }],
    operation,
  };
}

interface TestEncryptedOPFSStorageBackend {
  readonly objectStore: {
    delete({ locator }: {
      locator: { readonly namespace: string, readonly key: string },
    }): Promise<void>,
  },
  readonly fileStore: {
    delete({ fileId }: { fileId: string }): Promise<void>,
  },
  readonly fileSystemStore: {
    deleteFileSystem({ rootDirectoryId }: { rootDirectoryId: string }): Promise<void>,
  },
  loadManifest(): Promise<{
    fileSystems: Array<{
      readonly type: string,
      readonly sourceId?: string,
    }>,
  } | undefined>,
  saveVolumeShard(): Promise<void>,
}

interface TestEncryptionTransitionCoordinator {
  createEncryptedBackend({
    encryptedStoreId,
    storageUnlockKey,
    storeRootKey,
    replace,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
    storeRootKey: Uint8Array,
    replace: boolean,
  }): Promise<EncryptedOPFSStorageBackend>,

  removeEncryptedStoresExcept({
    retainedStoreIds,
  }: {
    retainedStoreIds: ReadonlySet<string>,
  }): Promise<void>,

  resume({
    state,
    storageUnlockKey,
    signal,
  }: {
    state: Extract<EncryptionStateDto, { state: 'transitioning' }>,
    storageUnlockKey: Uint8Array,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult>,
}

afterEach(() => {
  for (const [property, descriptor] of navigatorPropertyDescriptors) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(navigator, property);
      continue;
    }
    Object.defineProperty(navigator, property, descriptor);
  }
  navigatorPropertyDescriptors.clear();
  vi.restoreAllMocks();
});

describe('EncryptedOPFSStorageBackend special filesystems', () => {
  it('opens stable encrypted directory capabilities and removes logical subtrees', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'runtime-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });

    const created = await backend.openSpecialFileSystemDirectory({
      type: 'chat_wesh',
      path: '/global/home/user',
      create: true,
    });
    const reopened = await backend.openSpecialFileSystemDirectory({
      type: 'chat_wesh',
      path: '/global/home/user',
      create: false,
    });

    expect(created).toMatchObject({ type: 'encrypted_directory' });
    expect(reopened).toMatchObject({
      type: 'encrypted_directory',
      rootDirectoryId: created?.type === 'encrypted_directory'
        ? created.rootDirectoryId
        : undefined,
    });

    await backend.removeSpecialFileSystemEntry({
      type: 'chat_wesh',
      path: '/global/home',
      recursive: true,
    });

    await expect(backend.openSpecialFileSystemDirectory({
      type: 'chat_wesh',
      path: '/global/home/user',
      create: false,
    })).resolves.toBeNull();
  });

  it('rejects an existing encrypted store whose manifest is missing', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'missing-manifest-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const internal = backend as unknown as TestEncryptedOPFSStorageBackend;
    await internal.objectStore.delete({
      locator: { namespace: 'singleton', key: 'store_manifest' },
    });

    await expect(backend.init()).rejects.toThrow('Encrypted store manifest is missing');
  });

  it('hides binary metadata before failed payload cleanup', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'binary-delete-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const binaryObjectId = toBinaryObjectId({ raw: 'binary-delete-01' });
    const bytes = new TextEncoder().encode('binary payload');
    await backend.writeBinaryObject({
      source: {
        type: 'stream',
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      },
      binaryObjectId,
      name: 'payload.txt',
      mimeType: 'text/plain',
      size: bytes.byteLength,
      createdAt: 1,
      signal: undefined,
    });

    const internal = backend as unknown as TestEncryptedOPFSStorageBackend;
    vi.spyOn(internal.fileStore, 'delete').mockRejectedValueOnce(
      new Error('simulated payload cleanup failure'),
    );

    await expect(backend.deleteBinaryObject({ binaryObjectId })).rejects.toThrow(
      'simulated payload cleanup failure',
    );
    await expect(backend.getBinaryObject({ binaryObjectId })).resolves.toBeNull();
    const listed = [];
    for await (const binaryObject of backend.listBinaryObjects()) {
      listed.push(binaryObject);
    }
    expect(listed).toEqual([]);
  });

  it('hides volume metadata before failed filesystem cleanup', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'volume-delete-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const sourceHandle = new MockFileSystemDirectoryHandle({ name: 'source' });
    const volume = await backend.createVolume({
      name: 'Volume',
      type: 'opfs',
      sourceHandle,
    });

    const internal = backend as unknown as TestEncryptedOPFSStorageBackend;
    vi.spyOn(internal.fileSystemStore, 'deleteFileSystem').mockRejectedValueOnce(
      new Error('simulated filesystem cleanup failure'),
    );

    await expect(backend.deleteVolume({ volumeId: volume.id })).rejects.toThrow(
      'simulated filesystem cleanup failure',
    );
    await expect(backend.openVolume({ volumeId: volume.id })).resolves.toBeNull();
    const listed = [];
    for await (const candidate of backend.listVolumes()) {
      listed.push(candidate);
    }
    expect(listed).toEqual([]);
  });

  it('removes an encrypted volume descriptor when creation fails after manifest update', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'volume-create-failure-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const internal = backend as unknown as TestEncryptedOPFSStorageBackend;
    vi.spyOn(internal, 'saveVolumeShard').mockRejectedValueOnce(
      new Error('simulated volume index failure'),
    );

    await expect(backend.createVolume({
      name: 'Volume',
      type: 'opfs',
      sourceHandle: new MockFileSystemDirectoryHandle({ name: 'source' }),
    })).rejects.toThrow('simulated volume index failure');

    await expect(internal.loadManifest()).resolves.toMatchObject({
      fileSystems: [],
    });
  });

  it('enumerates chat DTOs independently of hierarchy visibility', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const backend = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId: 'raw-enumeration-store',
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const chat: Chat = {
      id: toChatId({ raw: 'orphan-chat-01' }),
      title: 'Orphan chat',
      root: { items: [] },
      createdAt: 1,
      updatedAt: 1,
      debugEnabled: false,
    };
    const chatGroup: ChatGroup = {
      id: toChatGroupId({ raw: 'orphan-group-01' }),
      name: 'Orphan group',
      isCollapsed: false,
      updatedAt: 1,
      items: [],
    };

    await backend.saveChatMeta({ meta: chat });
    await backend.saveChatGroup({ chatGroup });
    await backend.saveHierarchy({ hierarchy: { items: [] } });

    await expect(backend.listChatMetasRaw()).resolves.toEqual([
      expect.objectContaining({ id: idToRaw({ id: chat.id }) }),
    ]);
    await expect(backend.listChatGroupsRaw()).resolves.toEqual([
      expect.objectContaining({ id: idToRaw({ id: chatGroup.id }) }),
    ]);

    await backend.deleteChat({ id: chat.id });
    await backend.deleteChatGroup({ id: chatGroup.id });
    await expect(backend.listChatMetasRaw()).resolves.toEqual([]);
    await expect(backend.listChatGroupsRaw()).resolves.toEqual([]);
  });
});

describe('EncryptionTransitionCoordinator recovery', () => {
  it('finishes decrypt cleanup after the encrypted source store was already removed', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const state = createTransitionState({
      operation: {
        type: 'decrypting',
        phase: 'cleaning_up_source',
        sourceEncryptedStoreId: 'removed-source',
      },
    });
    await new EncryptionStateStore({ storageRoot }).writeState({ state });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const result = await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).resume({
      state,
      storageUnlockKey: crypto.getRandomValues(new Uint8Array(32)),
      signal: undefined,
    });

    expect(result.type).toBe('plain');
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });
    await expect(storageRoot.getDirectoryHandle('encrypted-stores')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('finishes re-encryption cleanup after the encrypted source store was already removed', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    const testCoordinator = coordinator as unknown as TestEncryptionTransitionCoordinator;
    const storageUnlockKey = crypto.getRandomValues(new Uint8Array(32));
    await testCoordinator.createEncryptedBackend({
      encryptedStoreId: 'target-store',
      storageUnlockKey,
      storeRootKey: crypto.getRandomValues(new Uint8Array(32)),
      replace: true,
    });
    const state = createTransitionState({
      operation: {
        type: 'reencrypting',
        phase: 'cleaning_up_source',
        sourceEncryptedStoreId: 'removed-source',
        targetEncryptedStoreId: 'target-store',
      },
    });
    await new EncryptionStateStore({ storageRoot }).writeState({ state });

    const result = await testCoordinator.resume({
      state,
      storageUnlockKey,
      signal: undefined,
    });

    expect(result.type).toBe('encrypted');
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toMatchObject({
      type: 'encrypted',
      state: {
        state: 'encrypted',
        activeEncryptedStoreId: 'target-store',
      },
    });
    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const storeNames: string[] = [];
    for await (const name of storesDirectory.keys()) {
      storeNames.push(name);
    }
    expect(storeNames).toEqual(['target-store']);
  });

  it('removes orphan encrypted stores while retaining the active store', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    installNavigatorMocks({ opfsRoot });

    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores', { create: true });
    await storesDirectory.getDirectoryHandle('active-store', { create: true });
    await storesDirectory.getDirectoryHandle('orphan-a', { create: true });
    await storesDirectory.getDirectoryHandle('orphan-b', { create: true });

    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).removeEncryptedStoresExcept({
      retainedStoreIds: new Set(['active-store']),
    });

    const storeNames: string[] = [];
    for await (const name of storesDirectory.keys()) {
      storeNames.push(name);
    }
    expect(storeNames).toEqual(['active-store']);
  });
});
