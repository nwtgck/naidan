import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import {
  inspectOpfsEncryption,
  unlockOpfsEncryptionWithPassphrase,
} from '@/00-storage/service/opfs-encryption/bootstrap';
import { createOpfsEncryptionWorker } from './impl';

const navigatorStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
const navigatorLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');

function installNavigator({
  opfsRoot,
}: {
  opfsRoot: FileSystemDirectoryHandle;
}): void {
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
          name: String(arguments_[0]),
          mode: 'exclusive',
        } as Lock);
      }),
    } as unknown as LockManager,
  });
}

afterEach(() => {
  if (navigatorStorageDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
  } else {
    Object.defineProperty(navigator, 'storage', navigatorStorageDescriptor);
  }
  if (navigatorLocksDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'locks');
  } else {
    Object.defineProperty(navigator, 'locks', navigatorLocksDescriptor);
  }
});

describe('OPFS encryption Worker implementation', () => {
  it('runs encryption and decryption without returning file payloads to the caller realm', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installNavigator({ opfsRoot });
    const plainSession = createNativeOpfsFileSystemSession({ root: opfsRoot });
    const plainBackend = new NaidanOpfsStorageBackend({
      namespaceRoot: plainSession.root,
      hostVolumeDB: new HostVolumeDB(),
    });
    await plainBackend.init();
    await plainBackend.saveSettings({
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        endpoint: {
          type: 'openai',
          url: 'https://worker.example.invalid',
        },
        storageType: 'opfs',
      },
    });
    await plainSession.close();

    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', {
      create: true,
    });
    const worker = createOpfsEncryptionWorker();
    await expect(worker.run({
      request: {
        operation: 'enable',
        storageRoot,
        nativeNamespaceRoot: opfsRoot,
        passphrase: 'worker passphrase',
      },
    })).resolves.toEqual({ type: 'encrypted' });

    const inspection = await inspectOpfsEncryption({ storageRoot });
    if (inspection.type !== 'encrypted') {
      throw new Error('Expected encrypted state after Worker transition');
    }
    const unlocked = await unlockOpfsEncryptionWithPassphrase({
      storageRoot,
      state: inspection.state,
      passphrase: 'worker passphrase',
    });
    expect((await unlocked.backend.loadSettings())?.storageType).toBe('opfs');

    await expect(worker.run({
      request: {
        operation: 'disable',
        storageRoot,
        nativeNamespaceRoot: opfsRoot,
        state: unlocked.state,
        storageUnlockKey: unlocked.storageUnlockKey.slice(),
        unlockedKeySlotId: unlocked.unlockedKeySlotId,
      },
    })).resolves.toEqual({ type: 'plain' });

    await unlocked.fileSystemSession.close();
    unlocked.storageUnlockKey.fill(0);
    expect(await inspectOpfsEncryption({ storageRoot })).toEqual({ type: 'plain' });
    const restoredSession = createNativeOpfsFileSystemSession({ root: opfsRoot });
    const restoredBackend = new NaidanOpfsStorageBackend({
      namespaceRoot: restoredSession.root,
      hostVolumeDB: new HostVolumeDB(),
    });
    await restoredBackend.init();
    expect((await restoredBackend.loadSettings())?.storageType).toBe('opfs');
    await restoredSession.close();
  });
});
