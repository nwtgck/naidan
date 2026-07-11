import { afterEach, describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { EncryptionStateStore } from './encryption-state-store';
import {
  createEncryptionMaterial,
} from './encryption-key-manager';
import {
  EncryptionTransitionCoordinator,
} from './encryption-transition-coordinator';
import type { EncryptedOPFSStorageBackend } from './encrypted-opfs-storage-backend';

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
}

const navigatorStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');

function installOpfsRoot({ opfsRoot }: { opfsRoot: FileSystemDirectoryHandle }): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => opfsRoot,
    } satisfies Partial<StorageManager>,
  });
}

async function snapshotDirectory({
  directory,
}: {
  directory: FileSystemDirectoryHandle,
}): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();

  async function visit({
    current,
    prefix,
  }: {
    current: FileSystemDirectoryHandle,
    prefix: string,
  }): Promise<void> {
    for await (const [name, handle] of current.entries()) {
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      switch (handle.kind) {
      case 'directory':
        await visit({ current: handle, prefix: path });
        break;
      case 'file': {
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        result.set(path, Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''));
        break;
      }
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled filesystem handle: ${String(_ex)}`);
      }
      }
    }
  }

  await visit({ current: directory, prefix: '' });
  return result;
}

afterEach(() => {
  if (navigatorStorageDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'storage');
    return;
  }
  Object.defineProperty(navigator, 'storage', navigatorStorageDescriptor);
});

describe('OPFS encryption passphrase changes', () => {
  it('rewrites only the passphrase key slot and preserves the encrypted store bytes', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installOpfsRoot({ opfsRoot });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const material = await createEncryptionMaterial({
      passphrase: 'old passphrase',
      pbkdf2Iterations: 10,
    });
    const encryptedStoreId = 'passphrase-test-store';
    const coordinator = new EncryptionTransitionCoordinator({ storageRoot });
    await (
      coordinator as unknown as TestEncryptionTransitionCoordinator
    ).createEncryptedBackend({
      encryptedStoreId,
      storageUnlockKey: material.storageUnlockKey,
      storeRootKey: material.storeRootKey,
      replace: true,
    });
    await new EncryptionStateStore({ storageRoot }).writeState({
      state: {
        formatVersion: 1,
        sequence: 0,
        state: 'encrypted',
        passphraseKeySlot: material.passphraseKeySlot,
        activeEncryptedStoreId: encryptedStoreId,
      },
    });

    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const before = await snapshotDirectory({ directory: storesDirectory });
    const provider = new OPFSStorageProvider();
    await provider.unlockWithPassphrase({ passphrase: 'old passphrase' });
    await provider.changePassphrase({ passphrase: 'new passphrase' });
    const after = await snapshotDirectory({ directory: storesDirectory });

    expect(after).toEqual(before);

    const inspection = await new EncryptionStateStore({ storageRoot }).inspect();
    expect(inspection.type).toBe('encrypted');
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'encrypted') {
      throw new Error('Expected stable encrypted state');
    }
    expect(inspection.state.sequence).toBe(1);
    expect(inspection.state.passphraseKeySlot.pbkdf2.iterations).toBeGreaterThan(0);

    await provider.lockEncryption();
    await expect(provider.unlockWithPassphrase({
      passphrase: 'old passphrase',
    })).rejects.toThrow('did not unlock');
    await expect(provider.unlockWithPassphrase({
      passphrase: 'new passphrase',
    })).resolves.toBeUndefined();
    await provider.lockEncryption();
  });
});
