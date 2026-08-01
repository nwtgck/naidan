import { describe, expect, it, vi } from 'vitest';
import { fileSystemIdToNaidanContainerToken } from '@/00-storage/service/naidan-persistence-control/00-format';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';

import { TEST_ONLY } from '@/00-storage/service/naidan-opfs/production-persistence-runtime';

function notFound({ message }: { message: string }): Error {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

function fileSystemId({ value }: { value: string }) {
  return RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: value }).mode.activeFileSystemId;
}

function nativeNamespace({ container, expectedFileSystemId }: {
  container: FileSystemDirectoryHandle | undefined;
  expectedFileSystemId: ReturnType<typeof fileSystemId>;
}) {
  const getContainer = vi.fn(async (name: string, options?: { create?: boolean }) => {
    expect(name).toBe(fileSystemIdToNaidanContainerToken({ id: expectedFileSystemId }));
    expect(options).toEqual({ create: false });
    if (container === undefined) throw notFound({ message: 'container missing' });
    return container;
  });
  const storage = {
    getDirectoryHandle: getContainer,
    async *keys() {
      yield 'settings.json';
    },
  } as unknown as FileSystemDirectoryHandle;
  const getStorage = vi.fn(async (name: string, options?: { create?: boolean }) => {
    expect(name).toBe(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME);
    expect(options).toEqual({ create: false });
    return storage;
  });
  return {
    getContainer,
    getStorage,
    root: { getDirectoryHandle: getStorage } as unknown as FileSystemDirectoryHandle,
  };
}

describe('native OPFS phase-specific endpoint inspection', () => {
  it('classifies a missing HizoFS container as absent without creating it', async () => {
    const expectedFileSystemId = fileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const namespace = nativeNamespace({ container: undefined, expectedFileSystemId });

    const openContainer = vi.fn(async () => {
      throw new Error('opener must not run for a missing container');
    });

    await expect(TEST_ONLY.inspectNativeHizoFSEndpointWith({
      fileSystemId: expectedFileSystemId,
      nativeNamespaceRoot: namespace.root,
      openContainer,
      openProfile: 'normal_read',
      passphrase: 'unused',
    })).resolves.toBe('absent');

    expect(openContainer).not.toHaveBeenCalled();
  });

  it('rejects a container whose authenticated File System ID does not match its path', async () => {
    const expectedFileSystemId = fileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
    const otherFileSystemId = fileSystemId({ value: 'ZYXWVUTSRQ_9876543210' });
    const container = Object.freeze({ name: 'container' }) as unknown as FileSystemDirectoryHandle;
    const namespace = nativeNamespace({ container, expectedFileSystemId });
    const releaseResources = vi.fn(async () => undefined);
    const openContainer = vi.fn(async ({ verifyProofAuthority }) => {
      await verifyProofAuthority({ fileSystemId: otherFileSystemId, rootKeyProof: Object.freeze({}) });
      return { authority: Object.freeze({}), releaseResources, type: 'opened' } as const;
    });

    await expect(TEST_ONLY.inspectNativeHizoFSEndpointWith({
      fileSystemId: expectedFileSystemId,
      nativeNamespaceRoot: namespace.root,
      openContainer,
      openProfile: 'normal_read',
      passphrase: 'correct horse battery staple',
    })).resolves.toBe('invalid');

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('preserves a secondary endpoint infrastructure failure', async () => {
    const expectedFileSystemId = fileSystemId({ value: 'abcdefghij_ABCDEFGHIJ' });
    const container = Object.freeze({ name: 'container' }) as unknown as FileSystemDirectoryHandle;
    const namespace = nativeNamespace({ container, expectedFileSystemId });
    const openContainer = vi.fn(async () => {
      throw new Error('OPFS read failed');
    });

    await expect(TEST_ONLY.inspectNativeHizoFSEndpointWith({
      fileSystemId: expectedFileSystemId,
      nativeNamespaceRoot: namespace.root,
      openContainer,
      openProfile: 'root_key_proof',
      passphrase: 'correct horse battery staple',
    })).rejects.toThrow('OPFS read failed');
  });

  it('verifies normal plain readiness by traversing the existing native namespace', async () => {
    const expectedFileSystemId = fileSystemId({ value: 'ABCDEFGHIJ_abcdefghij' });
    const namespace = nativeNamespace({ container: undefined, expectedFileSystemId });

    await expect(TEST_ONLY.inspectNativePlainEndpoint({
      nativeNamespaceRoot: namespace.root,
    })).resolves.toBe('fully_verified');

    expect(namespace.getStorage).toHaveBeenCalledOnce();
    expect(namespace.getContainer).not.toHaveBeenCalled();
  });

  it('fails closed when the plain namespace root is missing', async () => {
    const root = {
      getDirectoryHandle: vi.fn(async () => {
        throw notFound({ message: 'native storage missing' });
      }),
    } as unknown as FileSystemDirectoryHandle;

    await expect(TEST_ONLY.inspectNativePlainEndpoint({ nativeNamespaceRoot: root }))
      .resolves.toBe('invalid');
  });
});
