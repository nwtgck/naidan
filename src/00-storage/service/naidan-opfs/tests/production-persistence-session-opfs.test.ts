import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodePersistenceControl,
  fileSystemIdToNaidanContainerToken,
  persistenceControlAuthenticationFileSystemId,
  type NaidanPersistenceControlV1,
  type NaidanPersistenceModeV1,
  type PersistenceControlCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  createHizoFSControlProtection,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import type { PersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import { capturePersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
  naidanOpfsContainerOriginRelativePath,
} from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';

const workerMocks = {
  createScope: vi.fn(),
  createRuntimeHost: vi.fn(),
  openContainer: vi.fn(),
  transferSession: vi.fn(),
};

import {
  openNativeCredentialRequiredApplicationSession,
  TEST_ONLY as PRODUCTION_RUNTIME_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/production-persistence-runtime';

type NativeOpenOptions = Parameters<typeof openNativeCredentialRequiredApplicationSession>[0];
type NativeOpenWithOptions = Parameters<
  typeof PRODUCTION_RUNTIME_TEST_ONLY.openNativeCredentialRequiredApplicationSessionWith
>[0];

function fileSystemId({ value }: { value: string }) {
  return RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: value }).mode.activeFileSystemId;
}

function rootKey({ fill }: { fill: number }): PersistenceControlRootKeyDerivationCapability {
  return {
    async deriveAesGcmKey({ info }) {
      const material = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(32).fill(fill),
        'HKDF',
        false,
        ['deriveKey'],
      );
      return await crypto.subtle.deriveKey(
        { hash: 'SHA-256', info: new Uint8Array(info).buffer, name: 'HKDF', salt: new ArrayBuffer(0) },
        material,
        { length: 256, name: 'AES-GCM' },
        false,
        ['decrypt', 'encrypt'],
      );
    },
  };
}

async function authenticatedControl({ copy, key, mode, sequence }: {
  copy: PersistenceControlCopy;
  key: PersistenceControlRootKeyDerivationCapability;
  mode: NaidanPersistenceModeV1;
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode });
  if (authenticationFileSystemId === undefined) {
    throw new TypeError('test credential control requires one authentication File System ID');
  }
  const core = {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode,
    retiredFileSystemIds: [],
    sequence,
  } as const;
  return {
    ...core,
    protection: await createHizoFSControlProtection({
      authenticationFileSystemId,
      core,
      randomSource: ({ bytes }) => bytes.fill(sequence + copy),
      rootKey: key,
    }),
  };
}

class MutablePhysical implements PersistenceControlReadablePhysicalPort {
  public readonly controls: [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];

  public constructor({ controls }: {
    controls: readonly [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];
  }) {
    this.controls = [...controls];
  }

  public async readFileBounded({ copy, maximumByteLength }: {
    copy: PersistenceControlCopy;
    maximumByteLength: number;
  }): Promise<Uint8Array | undefined> {
    const control = this.controls[copy];
    if (control === undefined) return undefined;
    const bytes = encodePersistenceControl({ control });
    if (bytes.byteLength > maximumByteLength) throw new RangeError('test control exceeds read bound');
    return bytes;
  }
}

function nativeNamespace({ container, expectedFileSystemId }: {
  container: FileSystemDirectoryHandle;
  expectedFileSystemId: ReturnType<typeof fileSystemId>;
}) {
  const getContainer = vi.fn(async (name: string, options?: { create?: boolean }) => {
    expect(name).toBe(fileSystemIdToNaidanContainerToken({ id: expectedFileSystemId }));
    expect(options).toEqual({ create: false });
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

function fileSystemSession({ close = async () => undefined }: {
  close?: () => Promise<void>;
} = {}): StorageFileSystemSession {
  return {
    capabilities: {
      atomicMove: 'unsupported',
      directBlob: 'unsupported',
      symbolicLink: 'unsupported',
      wholeFileClone: 'unsupported',
    },
    close,
    root: Object.freeze({}) as StorageDirectoryHandle,
  };
}

const lockManager = {
  query: vi.fn(),
  request: vi.fn(),
} as unknown as NativeOpenOptions['lockManager'];

const runtimePolicy: NativeOpenOptions['runtimePolicy'] = {
  maxDirectoryIteratorEntries: 32,
  maxHeldLockNames: 64,
  maxReaderPins: 16,
  maxSegmentReferences: 16,
};

const hizofsRuntime = {
  createCoordinationScope: workerMocks.createScope,
  createRuntimeHost: workerMocks.createRuntimeHost,
  openApplicationSessionFromCapability: workerMocks.transferSession,
  openContainerCapability: workerMocks.openContainer,
} as unknown as NativeOpenWithOptions['hizofsRuntime'];

describe('native credential-required application session composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens stable HizoFS through the canonical location and final authority-bound session recheck', async () => {
    const activeFileSystemId = fileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 21 });
    const control = await authenticatedControl({
      copy: 0,
      key,
      mode: { activeFileSystemId, type: 'hizofs' },
      sequence: 4,
    });
    const physical = new MutablePhysical({ controls: [control, undefined] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const container = Object.freeze({ name: 'container' }) as unknown as FileSystemDirectoryHandle;
    const namespace = nativeNamespace({ container, expectedFileSystemId: activeFileSystemId });
    const authority = Object.freeze({ kind: 'opaque-authority' });
    const releaseResources = vi.fn(async () => undefined);
    const scope = Object.freeze({ kind: 'scope' });
    const runtimeHost = Object.freeze({ kind: 'runtime-host' });
    const session = fileSystemSession();

    workerMocks.openContainer.mockImplementation(async ({ containerRoot, openProfile, verifyProofAuthority }) => {
      expect(containerRoot).toBe(container);
      expect(openProfile).toBe('normal_read');
      await verifyProofAuthority({ fileSystemId: activeFileSystemId, rootKeyProof: key });
      return { authority, releaseResources, type: 'opened' };
    });
    workerMocks.createScope.mockResolvedValue(scope);
    workerMocks.createRuntimeHost.mockReturnValue(runtimeHost);
    workerMocks.transferSession.mockImplementation(async ({
      authority: receivedAuthority,
      recheckAuthority,
      runtimeHost: receivedRuntimeHost,
    }) => {
      expect(receivedAuthority).toBe(authority);
      expect(receivedRuntimeHost).toBe(runtimeHost);
      await recheckAuthority();
      return session;
    });

    const result = await PRODUCTION_RUNTIME_TEST_ONLY.openNativeCredentialRequiredApplicationSessionWith({
      captured,
      hizofsRuntime,
      lockManager,
      nativeNamespaceRoot: namespace.root,
      passphrase: 'correct horse battery staple',
      physical,
      runtimePolicy,
    });

    expect(result).toMatchObject({
      authoritativeEndpoint: { fileSystemId: activeFileSystemId, type: 'hizofs' },
      fileSystemId: activeFileSystemId,
      fileSystemSession: session,
      type: 'opened',
    });
    expect(workerMocks.createScope).toHaveBeenCalledWith({
      canonicalBackingLocation: naidanOpfsContainerOriginRelativePath({ fileSystemId: activeFileSystemId }),
    });
    expect(workerMocks.createRuntimeHost).toHaveBeenCalledWith({ lockManager, policy: runtimePolicy, scope });
    expect(workerMocks.transferSession).toHaveBeenCalledOnce();
    expect(releaseResources).not.toHaveBeenCalled();
    expect(namespace.getStorage).toHaveBeenCalledOnce();
    expect(namespace.getContainer).toHaveBeenCalledOnce();
  });

  it('registers plain authority for an encrypt building phase after releasing proof-only HizoFS', async () => {
    const targetFileSystemId = fileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
    const transition = RUNTIME_CONTRACT_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId,
    });
    const key = rootKey({ fill: 22 });
    const control = await authenticatedControl({ copy: 0, key, mode: transition.mode, sequence: 5 });
    const physical = new MutablePhysical({ controls: [control, undefined] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const container = Object.freeze({ name: 'container' }) as unknown as FileSystemDirectoryHandle;
    const namespace = nativeNamespace({ container, expectedFileSystemId: targetFileSystemId });
    const releaseResources = vi.fn(async () => undefined);

    workerMocks.openContainer.mockImplementation(async ({ openProfile, verifyProofAuthority }) => {
      expect(openProfile).toBe('root_key_proof');
      await verifyProofAuthority({ fileSystemId: targetFileSystemId, rootKeyProof: key });
      return { authority: Object.freeze({ kind: 'proof-only' }), releaseResources, type: 'opened' };
    });

    const result = await PRODUCTION_RUNTIME_TEST_ONLY.openNativeCredentialRequiredApplicationSessionWith({
      captured,
      hizofsRuntime,
      lockManager,
      nativeNamespaceRoot: namespace.root,
      passphrase: 'correct horse battery staple',
      physical,
      runtimePolicy,
    });

    expect(result).toMatchObject({
      authoritativeEndpoint: { type: 'plain' },
      fileSystemId: targetFileSystemId,
      type: 'opened',
    });
    if (result.type !== 'opened') throw new Error('expected plain authority session');
    expect(result.fileSystemSession.root.kind).toBe('directory');
    expect(releaseResources).toHaveBeenCalledOnce();
    expect(workerMocks.createScope).not.toHaveBeenCalled();
    expect(workerMocks.createRuntimeHost).not.toHaveBeenCalled();
    expect(workerMocks.transferSession).not.toHaveBeenCalled();
    expect(namespace.getStorage).toHaveBeenCalledTimes(2);
    expect(namespace.getContainer).toHaveBeenCalledOnce();
  });

  it('does not construct a runtime host when the credential is rejected', async () => {
    const activeFileSystemId = fileSystemId({ value: 'ZYXWVUTSRQ_9876543210' });
    const key = rootKey({ fill: 23 });
    const control = await authenticatedControl({
      copy: 0,
      key,
      mode: { activeFileSystemId, type: 'hizofs' },
      sequence: 6,
    });
    const physical = new MutablePhysical({ controls: [control, undefined] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const namespace = nativeNamespace({
      container: Object.freeze({}) as FileSystemDirectoryHandle,
      expectedFileSystemId: activeFileSystemId,
    });
    workerMocks.openContainer.mockResolvedValue({ type: 'credential_rejected' });

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.openNativeCredentialRequiredApplicationSessionWith({
      captured,
      hizofsRuntime,
      lockManager,
      nativeNamespaceRoot: namespace.root,
      passphrase: 'wrong passphrase',
      physical,
      runtimePolicy,
    })).resolves.toEqual({ type: 'credential_rejected' });

    expect(workerMocks.createScope).not.toHaveBeenCalled();
    expect(workerMocks.createRuntimeHost).not.toHaveBeenCalled();
    expect(workerMocks.transferSession).not.toHaveBeenCalled();
  });
});
