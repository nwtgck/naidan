import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { settingsToDto } from '@/00-storage/mapper/mappers';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { EncryptionStateStore } from './encryption-state-store';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import {
  EncryptionTransitionCoordinator,
  TEST_ONLY,
} from './encryption-transition-coordinator';

const navigatorPropertyDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

function installNavigatorMocks({
  opfsRoot,
}: {
  opfsRoot: FileSystemDirectoryHandle;
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
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(async (...arguments_: unknown[]) => {
        const callback = arguments_.at(-1);
        if (typeof callback !== 'function') {
          throw new Error('Web Locks callback is missing');
        }
        return await callback({
          name: 'naidan:sync:lock:opfs_storage_session',
          mode: 'exclusive',
        });
      }),
    },
  });
}

function createTestSettings({ marker }: { marker: string }): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    endpoint: {
      type: 'openai',
      url: `https://${marker}.example.invalid`,
    },
    storageType: 'opfs',
  };
}

function expectSettingsEquivalent({
  actual,
  expected,
}: {
  actual: Settings | null;
  expected: Settings;
}): void {
  if (actual === null) {
    throw new Error('Expected persisted settings');
  }
  expect(JSON.parse(JSON.stringify(settingsToDto({ domain: actual }))))
    .toEqual(JSON.parse(JSON.stringify(settingsToDto({ domain: expected }))));
}

async function createPlainBackend({
  opfsRoot,
}: {
  opfsRoot: FileSystemDirectoryHandle;
}): Promise<{
  readonly fileSystemSession: StorageFileSystemSession;
  readonly backend: NaidanOpfsStorageBackend;
}> {
  const fileSystemSession = createNativeOpfsFileSystemSession({ root: opfsRoot });
  const backend = new NaidanOpfsStorageBackend({
    namespaceRoot: fileSystemSession.root,
    hostVolumeDB: new HostVolumeDB(),
  });
  await backend.init();
  return { fileSystemSession, backend };
}

async function writeFile({
  directory,
  name,
  text,
}: {
  directory: StorageDirectoryHandle;
  name: string;
  text: string;
}): Promise<void> {
  const handle = await directory.getFileHandle({ name, create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write({
    position: 0,
    data: new TextEncoder().encode(text),
  });
  await writable.close();
}

async function readFile({ file }: { file: StorageFileHandle }): Promise<string> {
  const readable = await file.openReadable({ mimeType: 'text/plain' });
  try {
    return await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).text();
  } finally {
    await readable.close();
  }
}

async function expectMissingDirectory({
  parent,
  name,
}: {
  parent: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  await expect(parent.getDirectoryHandle(name)).rejects.toMatchObject({
    name: 'NotFoundError',
  });
}

async function expectMissingFile({
  parent,
  name,
}: {
  parent: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  await expect(parent.getFileHandle(name)).rejects.toMatchObject({
    name: 'NotFoundError',
  });
}

afterEach(() => {
  for (const [property, descriptor] of navigatorPropertyDescriptors) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(navigator, property);
    } else {
      Object.defineProperty(navigator, property, descriptor);
    }
  }
  navigatorPropertyDescriptors.clear();
  vi.restoreAllMocks();
});

describe('EncryptionTransitionCoordinator', () => {
  it('encrypts the existing namespace byte-for-byte while recreating tmp empty', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'encrypted-copy' });
    await plain.backend.saveSettings({ settings });
    await writeFile({
      directory: await plain.fileSystemSession.root.getDirectoryHandle({
        name: 'naidan-storage',
        create: false,
      }),
      name: 'future-format.bin',
      text: 'unknown bytes survive',
    });
    await writeFile({
      directory: await plain.fileSystemSession.root.getDirectoryHandle({
        name: 'naidan-chat-wesh',
        create: true,
      }),
      name: 'history.txt',
      text: 'wesh history',
    });
    await writeFile({
      directory: await plain.fileSystemSession.root.getDirectoryHandle({
        name: 'naidan-tmp',
        create: true,
      }),
      name: 'discard-me.txt',
      text: 'temporary',
    });

    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const result = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
    });

    expect(result.type).toBe('encrypted');
    if (result.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }
    expectSettingsEquivalent({
      actual: await result.session.backend.loadSettings(),
      expected: settings,
    });
    const encryptedStorage = await result.session.fileSystemSession.root.getDirectoryHandle({
      name: 'naidan-storage',
      create: false,
    });
    expect(await readFile({
      file: await encryptedStorage.getFileHandle({
        name: 'future-format.bin',
        create: false,
      }),
    })).toBe('unknown bytes survive');
    const encryptedWesh = await result.session.fileSystemSession.root.getDirectoryHandle({
      name: 'naidan-chat-wesh',
      create: false,
    });
    expect(await readFile({
      file: await encryptedWesh.getFileHandle({
        name: 'history.txt',
        create: false,
      }),
    })).toBe('wesh history');
    const encryptedTmp = await result.session.fileSystemSession.root.getDirectoryHandle({
      name: 'naidan-tmp',
      create: false,
    });
    expect([...await Array.fromAsync(encryptedTmp.entries())]).toEqual([]);

    await expectMissingFile({ parent: storageRoot, name: 'settings.json' });
    await expectMissingDirectory({ parent: opfsRoot, name: 'naidan-chat-wesh' });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toMatchObject({
      type: 'encrypted',
      state: {
        state: 'encrypted',
        activeEncryptedStoreId: result.session.state.activeEncryptedStoreId,
      },
    });

    await plain.fileSystemSession.close();
    await result.session.fileSystemSession.close();
    result.session.storageUnlockKey.fill(0);
  });

  it('decrypts into the released plain namespace and removes encrypted control data', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'plain-target' });
    await plain.backend.saveSettings({ settings });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const encrypted = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
    });
    if (encrypted.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }

    const decrypted = await coordinator.disableEncryption({
      session: encrypted.session,
      signal: undefined,
    });

    expect(decrypted.type).toBe('plain');
    if (decrypted.type !== 'plain') {
      throw new Error('Expected plain transition result');
    }
    expectSettingsEquivalent({
      actual: await decrypted.backend.loadSettings(),
      expected: settings,
    });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });
    await expectMissingDirectory({ parent: storageRoot, name: 'encrypted-stores' });
    expect(JSON.parse(await (await storageRoot.getFileHandle('settings.json')).getFile().then(file => file.text())))
      .toMatchObject({ storageType: 'opfs' });

    await plain.fileSystemSession.close();
    await encrypted.session.fileSystemSession.close();
    await decrypted.fileSystemSession.close();
    encrypted.session.storageUnlockKey.fill(0);
  });

  it('re-encrypts through a new backing store without changing logical data', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'reencrypted' });
    await plain.backend.saveSettings({ settings });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const encrypted = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
    });
    if (encrypted.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }
    const previousStoreId = encrypted.session.state.activeEncryptedStoreId;

    const reencrypted = await coordinator.reencrypt({
      session: encrypted.session,
      signal: undefined,
    });

    expect(reencrypted.type).toBe('encrypted');
    if (reencrypted.type !== 'encrypted') {
      throw new Error('Expected re-encrypted transition result');
    }
    expect(reencrypted.session.state.activeEncryptedStoreId).not.toBe(previousStoreId);
    expectSettingsEquivalent({
      actual: await reencrypted.session.backend.loadSettings(),
      expected: settings,
    });
    const stores = await storageRoot.getDirectoryHandle('encrypted-stores');
    await expectMissingDirectory({ parent: stores, name: previousStoreId });

    await plain.fileSystemSession.close();
    await encrypted.session.fileSystemSession.close();
    await reencrypted.session.fileSystemSession.close();
    reencrypted.session.storageUnlockKey.fill(0);
  });

  it('rolls back an aborted encryption before the authority switch', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'rollback' });
    await plain.backend.saveSettings({ settings });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const controller = new AbortController();
    controller.abort(new Error('stop copy'));

    await expect(coordinator.enableEncryption({
      passphrase: 'q',
      signal: controller.signal,
    })).rejects.toThrow();

    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });
    await expectMissingDirectory({ parent: storageRoot, name: 'encrypted-stores' });
    expectSettingsEquivalent({
      actual: await plain.backend.loadSettings(),
      expected: settings,
    });
    await plain.fileSystemSession.close();
  });

  it('resumes target-authoritative decryption cleanup without rebuilding the target', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'resume-cleanup' });
    await plain.backend.saveSettings({ settings });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const encrypted = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
    });
    if (encrypted.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }
    vi.spyOn(EncryptedStoreHeaderStore.prototype, 'removeStore')
      .mockRejectedValueOnce(new Error('simulated source cleanup failure'));

    await expect(coordinator.disableEncryption({
      session: encrypted.session,
      signal: undefined,
    })).rejects.toThrow('simulated source cleanup failure');

    vi.restoreAllMocks();
    const inspection = await new EncryptionStateStore({ storageRoot }).inspect();
    expect(inspection).toMatchObject({
      type: 'encrypted',
      state: {
        state: 'transitioning',
        operation: {
          type: 'decrypting',
          phase: 'cleaning_up_source',
        },
      },
    });
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'transitioning') {
      throw new Error('Expected persisted transition state');
    }

    const resumed = await coordinator.resumeWithPassphrase({
      state: inspection.state,
      passphrase: 'q',
      signal: undefined,
    });

    expect(resumed.type).toBe('plain');
    if (resumed.type !== 'plain') {
      throw new Error('Expected resumed plain result');
    }
    expectSettingsEquivalent({
      actual: await resumed.backend.loadSettings(),
      expected: settings,
    });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });

    await plain.fileSystemSession.close();
    await encrypted.session.fileSystemSession.close();
    await resumed.fileSystemSession.close();
    encrypted.session.storageUnlockKey.fill(0);
  });

  it('returns an interrupted pre-authority encryption to the original plain namespace', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    const settings = createTestSettings({ marker: 'cancel-interrupted-encryption' });
    await plain.backend.saveSettings({ settings });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });

    const interrupted = await coordinator.createInterruptedEncryptionForDebug({
      passphrase: 'q',
      signal: undefined,
    });
    expect(interrupted.operation).toMatchObject({
      type: 'encrypting',
      phase: 'building_target',
    });

    const result = await coordinator.returnInterruptedEncryptionToPlain({
      state: interrupted,
      passphrase: undefined,
      signal: undefined,
    });

    expect(result.type).toBe('plain');
    if (result.type !== 'plain') {
      throw new Error('Expected plain result after cancelling interrupted encryption');
    }
    expectSettingsEquivalent({
      actual: await result.backend.loadSettings(),
      expected: settings,
    });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toEqual({
      type: 'plain',
    });
    await expectMissingDirectory({ parent: storageRoot, name: 'encrypted-stores' });

    await plain.fileSystemSession.close();
    await result.fileSystemSession.close();
  });

  it('creates a durable interrupted decryption state for Developer UI testing', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    await plain.backend.saveSettings({ settings: createTestSettings({ marker: 'interrupt-decryption' }) });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const encrypted = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
    });
    if (encrypted.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }

    const interrupted = await coordinator.createInterruptedDecryptionForDebug({
      session: encrypted.session,
      signal: undefined,
    });

    expect(interrupted.operation).toEqual({
      type: 'decrypting',
      phase: 'building_target',
      sourceEncryptedStoreId: encrypted.session.state.activeEncryptedStoreId,
    });
    await expect(new EncryptionStateStore({ storageRoot }).inspect()).resolves.toMatchObject({
      type: 'encrypted',
      state: interrupted,
    });

    await plain.fileSystemSession.close();
    await encrypted.session.fileSystemSession.close();
    encrypted.session.storageUnlockKey.fill(0);
  });

  it('reports best-effort copy progress without a separate measuring traversal', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigatorMocks({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const plain = await createPlainBackend({ opfsRoot });
    await plain.backend.saveSettings({ settings: createTestSettings({ marker: 'progress' }) });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const progress: Array<Parameters<NonNullable<Parameters<typeof coordinator.enableEncryption>[0]['onProgress']>>[0]['progress']> = [];

    const result = await coordinator.enableEncryption({
      passphrase: 'q',
      signal: undefined,
      onProgress: ({ progress: update }) => progress.push(update),
    });

    expect(progress.some(update => (
      update.phase === 'copying'
      && update.totalBytes === undefined
    ))).toBe(true);
    expect(progress.some(update => (
      update.phase === 'verifying'
      && update.totalBytes !== undefined
    ))).toBe(true);
    expect(progress.at(-1)?.percent).toBe(100);

    await plain.fileSystemSession.close();
    if (result.type === 'encrypted') {
      await result.session.fileSystemSession.close();
      result.session.storageUnlockKey.fill(0);
    }
  });

  it('rejects a stale transition state from another tab', () => {
    const base = {
      formatVersion: 1 as const,
      sequence: 1,
      state: 'transitioning' as const,
      keySlots: [],
      operation: {
        type: 'encrypting' as const,
        phase: 'building_target' as const,
        targetEncryptedStoreId: 'target',
      },
    };
    expect(() => TEST_ONLY.assertSameTransitionState({
      expected: base,
      actual: {
        ...base,
        sequence: 2,
      },
    })).toThrow('changed in another tab');
  });
});
