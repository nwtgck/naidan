import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { EncryptionStateStore } from './encryption-state-store';
import {
  EncryptionTransitionCoordinator,
} from './encryption-transition-coordinator';
const navigatorStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
const navigatorLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');

function installOpfsRoot({ opfsRoot }: { opfsRoot: FileSystemDirectoryHandle }): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => opfsRoot,
    } satisfies Partial<StorageManager>,
  });
}

function installUncontendedWebLocks(): void {
  const request = vi.fn(async (
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>,
  ) => await callback({
    name,
    mode: options.mode ?? 'exclusive',
  } as Lock));

  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request } as unknown as LockManager,
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
  } else {
    Object.defineProperty(navigator, 'storage', navigatorStorageDescriptor);
  }
  if (navigatorLocksDescriptor === undefined) {
    Reflect.deleteProperty(navigator, 'locks');
  } else {
    Object.defineProperty(navigator, 'locks', navigatorLocksDescriptor);
  }
});

describe('OPFS encryption passphrase changes', () => {
  it('rewrites only the passphrase key slot and preserves the encrypted store bytes', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs' });
    installOpfsRoot({ opfsRoot });
    installUncontendedWebLocks();
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    const coordinator = new EncryptionTransitionCoordinator({
      storageRoot,
      nativeNamespaceRoot: opfsRoot,
      hostVolumeDB: new HostVolumeDB(),
      pbkdf2Iterations: 10,
    });
    const encryptionResult = await coordinator.enableEncryption({
      passphrase: 'old passphrase',
      signal: undefined,
    });
    if (encryptionResult.type !== 'encrypted') {
      throw new Error('Expected encrypted transition result');
    }
    await encryptionResult.session.fileSystemSession.close();
    encryptionResult.session.storageUnlockKey.fill(0);

    const storesDirectory = await storageRoot.getDirectoryHandle('encrypted-stores');
    const before = await snapshotDirectory({ directory: storesDirectory });
    const stateStore = new EncryptionStateStore({ storageRoot });
    const beforeInspection = await stateStore.inspect();
    if (beforeInspection.type !== 'encrypted' || beforeInspection.state.state !== 'encrypted') {
      throw new Error('Expected stable encrypted state before the passphrase change');
    }
    const sequenceBeforePassphraseChange = beforeInspection.state.sequence;
    const provider = new OPFSStorageProvider();
    await provider.unlockWithPassphrase({ passphrase: 'old passphrase' });
    // The provider deliberately requires cross-tab exclusion for the state rewrite.
    await provider.changePassphrase({ passphrase: 'new passphrase' });
    const after = await snapshotDirectory({ directory: storesDirectory });

    expect(after).toEqual(before);

    const inspection = await stateStore.inspect();
    expect(inspection.type).toBe('encrypted');
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'encrypted') {
      throw new Error('Expected stable encrypted state');
    }
    expect(inspection.state.sequence).toBe(sequenceBeforePassphraseChange + 1);
    expect(inspection.state.keySlots[0]?.keyDerivation.iterations).toBeGreaterThan(0);

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
