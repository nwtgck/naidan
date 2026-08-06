import { describe, expect, it, vi } from 'vitest';
import {
  decodePersistenceControl,
  encodePersistenceControl,
  persistenceControlAuthenticationFileSystemId,
  type NaidanPersistenceControlV1,
  type NaidanPersistenceModeV1,
  type PersistenceControlCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  createHizoFSControlProtection,
  createPlainControlProtection,
  type PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto';
import type {
  PersistenceControlPhysicalPort,
  PersistenceControlProofAuthority,
  PersistenceControlReadablePhysicalPort,
} from '@/00-storage/service/naidan-persistence-control/store';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  inspectCredentialAwarePersistenceRuntime,
  openCapturedCredentialRequiredPersistenceRuntime,
  registerCredentialBoundApplicationSession,
  TEST_ONLY as PRODUCTION_RUNTIME_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/production-persistence-runtime';
import { capturePersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import type { TransitionEndpointDriver } from '@/00-storage/service/naidan-persistence-control/transition/transition-provider-adapter';
import {
  convergeInterruptedPersistenceTransition,
  type TransitionSemanticState,
} from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';

function physical({ controls }: {
  controls: readonly [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];
}): PersistenceControlReadablePhysicalPort {
  return {
    async readFileBounded({ copy, maximumByteLength }) {
      const control = controls[copy];
      if (control === undefined) return undefined;
      const bytes = encodePersistenceControl({ control });
      if (bytes.byteLength > maximumByteLength) throw new RangeError('test control exceeds bound');
      return bytes;
    },
  };
}

async function plainControl({ copy, retiredFileSystemIds = [], sequence }: {
  copy: PersistenceControlCopy;
  retiredFileSystemIds?: readonly ReturnType<typeof testFileSystemId>[];
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  const core = {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { type: 'plain' },
    retiredFileSystemIds,
    sequence,
  } as const;
  return { ...core, protection: await createPlainControlProtection({ core }) };
}

function protectedControl({ copy, sequence }: {
  copy: PersistenceControlCopy;
  sequence: number;
}): NaidanPersistenceControlV1 {
  const base = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
    fileSystemId: 'protected-file-system',
  }).control;
  if (base.mode.type !== 'hizofs') {
    throw new Error('Expected HizoFS mode');
  }
  return {
    ...base,
    copy,
    protection: {
      authenticationFileSystemId: base.mode.activeFileSystemId,
      authenticatorTag: 'AAAAAAAAAAAAAAAAAAAAAA',
      nonce: 'AAAAAAAAAAAAAAAA',
      type: 'hizofs_aes_256_gcm',
    },
    sequence,
  };
}


function testFileSystemId({ value }: { value: string }) {
  const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({ fileSystemId: value });
  return inspection.mode.activeFileSystemId;
}

type FileSystemId = ReturnType<typeof testFileSystemId>;

function rootKey({ fill }: { fill: number }): PersistenceControlRootKeyDerivationCapability {
  return {
    async deriveAesGcmKey({ info }) {
      const material = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(fill), 'HKDF', false, ['deriveKey']);
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

async function authenticatedControlWithRetired({ copy, key, mode, retiredFileSystemIds, sequence }: {
  copy: PersistenceControlCopy;
  key: PersistenceControlRootKeyDerivationCapability;
  mode: NaidanPersistenceModeV1;
  retiredFileSystemIds: readonly FileSystemId[];
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode });
  if (authenticationFileSystemId === undefined) {
    throw new TypeError('test credential-bound control must have one authentication File System ID');
  }
  const core = {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode,
    retiredFileSystemIds,
    sequence,
  } as const;
  return {
    ...core,
    protection: await createHizoFSControlProtection({
      authenticationFileSystemId,
      core,
      randomSource: ({ bytes }) => bytes.fill(copy + sequence),
      rootKey: key,
    }),
  };
}

async function authenticatedControl({ copy, key, mode, sequence }: {
  copy: PersistenceControlCopy;
  key: PersistenceControlRootKeyDerivationCapability;
  mode: NaidanPersistenceModeV1;
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  return await authenticatedControlWithRetired({
    copy,
    key,
    mode,
    retiredFileSystemIds: [],
    sequence,
  });
}

async function authenticatedProtectedControl({ copy, fileSystemId, key, sequence }: {
  copy: PersistenceControlCopy;
  fileSystemId: ReturnType<typeof testFileSystemId>;
  key: PersistenceControlRootKeyDerivationCapability;
  sequence: number;
}): Promise<NaidanPersistenceControlV1> {
  return await authenticatedControl({
    copy,
    key,
    mode: { activeFileSystemId: fileSystemId, type: 'hizofs' },
    sequence,
  });
}

function testFileSystemSession({ close = async () => undefined }: {
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
    sync: async () => undefined,
  };
}

async function openedCredentialAuthority<Authority>({
  authority,
  control,
  expectedProfile,
  key,
  releaseResources,
}: {
  authority: Authority;
  control: NaidanPersistenceControlV1;
  expectedProfile: 'normal_read' | 'root_key_proof';
  key: PersistenceControlRootKeyDerivationCapability;
  releaseResources: () => Promise<void>;
}) {
  const physical = new MutablePhysical({ controls: [control, undefined] });
  const captured = await capturePersistenceControlAuthority({ physical });
  const authenticationFileSystemId = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
  if (authenticationFileSystemId === undefined) throw new TypeError('test control is not credential-bound');
  const opened = await openCapturedCredentialRequiredPersistenceRuntime({
    captured,
    openCandidate: async ({ fileSystemId, openProfile, verifyProofAuthority }) => {
      expect(fileSystemId).toBe(authenticationFileSystemId);
      expect(openProfile).toBe(expectedProfile);
      await verifyProofAuthority({ fileSystemId, rootKeyProof: key });
      return { authority, releaseResources, type: 'opened' };
    },
    passphrase: 'test-passphrase',
    physical,
    validateEndpointReadiness: async () => 'valid',
  });
  if (opened.type !== 'opened') throw new Error('expected credential authority to open');
  return { captured, opened, physical };
}

class MutablePhysical implements PersistenceControlPhysicalPort {
  public readonly controls: [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];

  public constructor({ controls }: {
    controls: readonly [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];
  }) {
    this.controls = [...controls];
  }

  public async publishWholeFileDurably({ bytes, copy }: {
    bytes: Uint8Array;
    copy: PersistenceControlCopy;
  }): Promise<void> {
    this.controls[copy] = decodePersistenceControl({ bytes });
  }

  public async readFileBounded({ copy, maximumByteLength }: {
    copy: PersistenceControlCopy;
    maximumByteLength: number;
  }): Promise<Uint8Array | undefined> {
    const control = this.controls[copy];
    if (control === undefined) return undefined;
    const bytes = encodePersistenceControl({ control });
    if (bytes.byteLength > maximumByteLength) throw new RangeError('test control exceeds bound');
    return bytes;
  }

  public async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    return await operation();
  }
}

class FaultInjectingMutablePhysical extends MutablePhysical {
  readonly #failure: Error;
  readonly #fault: 'after_first_publish' | 'before_first_publish';
  #publishCalls = 0;

  public constructor({ controls, failure, fault }: {
    controls: readonly [NaidanPersistenceControlV1 | undefined, NaidanPersistenceControlV1 | undefined];
    failure: Error;
    fault: 'after_first_publish' | 'before_first_publish';
  }) {
    super({ controls });
    this.#failure = failure;
    this.#fault = fault;
  }

  public override async publishWholeFileDurably({ bytes, copy }: {
    bytes: Uint8Array;
    copy: PersistenceControlCopy;
  }): Promise<void> {
    this.#publishCalls += 1;
    if (this.#publishCalls === 1 && this.#fault === 'before_first_publish') throw this.#failure;
    await super.publishWholeFileDurably({ bytes, copy });
    if (this.#publishCalls === 1 && this.#fault === 'after_first_publish') throw this.#failure;
  }
}

describe('native HizoFS graceful runtime shutdown result', () => {
  it('accepts shared-runtime retention while another application session remains', () => {
    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.acceptGracefulRuntimeShutdownResult({
      result: { blocker: 'session_attached', status: 'retained' },
    })).not.toThrow();
  });

  it('projects a retained dirty runtime as a typed shutdown blocker', () => {
    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.acceptGracefulRuntimeShutdownResult({
      result: { blocker: 'working_candidate_not_empty', status: 'retained' },
    })).toThrow(expect.objectContaining({
      blocker: 'working_candidate_not_empty',
      code: 'runtime_shutdown_blocked',
      name: 'NativeHizoFSRuntimeGracefulShutdownError',
    }));
  });
});

describe('createNativeHizoFSEnableTransitionTarget', () => {
  it('binds HizoFS target creation to the exact Naidan OPFS reservation', async () => {
    const fileSystemId = testFileSystemId({ value: 'enableTransition00001' });
    const containerRoot = Object.freeze({ name: 'target-root' }) as unknown as FileSystemDirectoryHandle;
    const nativeStorageRoot = {
      getDirectoryHandle: vi.fn(async (_name: string, options?: FileSystemGetDirectoryOptions) => {
        if (options?.create === false) throw new DOMException('missing', 'NotFoundError');
        return containerRoot;
      }),
      removeEntry: vi.fn(async () => undefined),
    } as unknown as FileSystemDirectoryHandle;
    const storageRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    let runExclusiveCalls = 0;
    const exclusiveGate = {
      async runExclusive<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
        runExclusiveCalls += 1;
        return await operation();
      },
    };
    const createTargetContainer = vi.fn(async ({ passphrases, reserveContainerRoot }) => {
      expect(passphrases).toEqual(['enable passphrase']);
      const reservation = await reserveContainerRoot({ fileSystemId });
      expect(reservation.type).toBe('reserved');
      if (reservation.type !== 'reserved') throw new Error('expected reserved transition target');
      expect(reservation.containerRoot).toBe(containerRoot);
      return fileSystemId;
    });

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSEnableTransitionTargetWith({
      exclusiveGate,
      passphrase: 'enable passphrase',
      runtime: { createTargetContainer },
      storageRoot,
    })).resolves.toBe(fileSystemId);

    expect(createTargetContainer).toHaveBeenCalledOnce();
    expect(runExclusiveCalls).toBe(1);
  });
});

describe('native disable source driver', () => {
  it('uses immutable read snapshots and narrows source readiness after the authority switch', async () => {
    const fileSystemId = testFileSystemId({ value: 'disableSource0000001' });
    const snapshotClose = vi.fn(async () => undefined);
    const snapshot = testFileSystemSession({ close: snapshotClose });
    const createReadSnapshot = vi.fn(async () => snapshot);
    const session = { ...testFileSystemSession(), createReadSnapshot };
    const binding = {
      operationId: 'disableOperation0001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId, type: 'hizofs' as const },
      target: { type: 'plain' as const },
    };
    const source = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSDisableSourceDriver({
      binding,
      exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      session,
    });

    await expect(source.driver.inspectEndpoint({ endpoint: binding.source })).resolves.toBe('fully_verified');
    const opened = await source.driver.openSourceEndpoint({ endpoint: binding.source });
    expect(opened.authorityIdentity).toBe(`hizofs-disable-source:${fileSystemId}`);
    expect(createReadSnapshot).toHaveBeenCalledOnce();
    await opened.close();
    expect(snapshotClose).toHaveBeenCalledOnce();

    source.markAuthoritySwitched();
    await expect(source.driver.inspectEndpoint({ endpoint: binding.source })).resolves.toBe('root_key_ready');
  });

  it('keeps post-switch cleanup proof scoped without reopening the source namespace', async () => {
    const fileSystemId = testFileSystemId({ value: 'disableCleanup000001' });
    const binding = {
      operationId: 'disableCleanupOp001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId, type: 'hizofs' as const },
      target: { type: 'plain' as const },
    };
    const source = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSDisableSourceDriver({
      binding,
      exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      session: undefined,
    });

    source.markAuthoritySwitched();
    await expect(source.driver.inspectEndpoint({ endpoint: binding.source })).resolves.toBe('root_key_ready');
    await expect(source.driver.openSourceEndpoint({ endpoint: binding.source }))
      .rejects.toThrow('source transition session is unavailable after authority switch');
  });
});

describe('native re-encrypt endpoint helpers', () => {
  it('opens the HizoFS source through immutable snapshots and keeps a distinct target binding', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptSource000001' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptTarget000001' });
    const snapshot = testFileSystemSession();
    const createReadSnapshot = vi.fn(async () => snapshot);
    const binding = {
      operationId: 'reencryptOperation001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const source = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptSourceDriver({
      binding,
      exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      session: { ...testFileSystemSession(), createReadSnapshot },
    });

    const opened = await source.driver.openSourceEndpoint({ endpoint: binding.source });
    expect(opened.authorityIdentity).toBe(`hizofs-reencrypt-source:${sourceFileSystemId}`);
    expect(createReadSnapshot).toHaveBeenCalledOnce();
    await opened.close();
    source.markAuthoritySwitched();
    await expect(source.driver.inspectEndpoint({ endpoint: binding.source })).resolves.toBe('root_key_ready');
    await expect(source.driver.inspectEndpoint({ endpoint: binding.target })).rejects.toThrow('another endpoint');
  });

  it('requires every retained passphrase to pass target normal-open verification', async () => {
    const targetFileSystemId = testFileSystemId({ value: 'reencryptVerify000001' });
    const binding = {
      operationId: 'reencryptVerifyOp0001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: testFileSystemId({ value: 'reencryptVerifySrc001' }), type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const containerRoot = {} as FileSystemDirectoryHandle;
    const verifyNormalOpen = vi.fn(async () => ({ credentialSlotCount: 2 }));
    const driver = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSEnableTransitionDriverWith({
      authorityIdentity: 'reencrypt-target:test',
      binding,
      exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
      initialOpenProfile: 'root_key_proof',
      importStatePort: {} as never,
      inspectTarget: async () => 'root_key_ready',
      limits: {
        directory: { maximumEntryMutationsPerBatch: 2 },
        file: { maximumExtentMutationsPerBatch: 2 },
      },
      normalOpenVerificationPassphrases: ['primary passphrase', 'recovery passphrase'],
      operationPassphrase: 'primary passphrase',
      recheckPublicationAllowed: async () => undefined,
      runtime: {
        openContainerRoot: async () => containerRoot,
        openTargetSession: vi.fn(),
        publishTarget: vi.fn(),
        removeContainerRoot: vi.fn(),
        verifyNormalOpen,
      },
      storageRoot: {} as FileSystemDirectoryHandle,
      verifyProofAuthority: async () => undefined,
    });

    await driver.verifyNormalOpen({ binding });
    expect(verifyNormalOpen).toHaveBeenNthCalledWith(1, expect.objectContaining({
      containerRoot,
      expectedFileSystemId: targetFileSystemId,
      passphrase: 'primary passphrase',
    }));
    expect(verifyNormalOpen).toHaveBeenNthCalledWith(2, expect.objectContaining({
      containerRoot,
      expectedFileSystemId: targetFileSystemId,
      passphrase: 'recovery passphrase',
    }));
  });

  it('rejects a retained credential set that does not cover every target Credential Slot', async () => {
    const targetFileSystemId = testFileSystemId({ value: 'reencryptSlots0000001' });
    const binding = {
      operationId: 'reencryptSlotsOp00001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: testFileSystemId({ value: 'reencryptSlotsSrc0001' }), type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const driver = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSEnableTransitionDriverWith({
      authorityIdentity: 'reencrypt-target:slot-coverage',
      binding,
      exclusiveGate: { runExclusive: async ({ operation }) => await operation() },
      initialOpenProfile: 'root_key_proof',
      importStatePort: {} as never,
      inspectTarget: async () => 'root_key_ready',
      limits: {
        directory: { maximumEntryMutationsPerBatch: 2 },
        file: { maximumExtentMutationsPerBatch: 2 },
      },
      normalOpenVerificationPassphrases: ['primary passphrase'],
      operationPassphrase: 'primary passphrase',
      recheckPublicationAllowed: async () => undefined,
      runtime: {
        openContainerRoot: async () => ({} as FileSystemDirectoryHandle),
        openTargetSession: vi.fn(),
        publishTarget: vi.fn(),
        removeContainerRoot: vi.fn(),
        verifyNormalOpen: vi.fn(async () => ({ credentialSlotCount: 2 })),
      },
      storageRoot: {} as FileSystemDirectoryHandle,
      verifyProofAuthority: async () => undefined,
    });

    await expect(driver.verifyNormalOpen({ binding }))
      .rejects.toThrow('Credential Slot set does not exactly match the retained credentials');
  });

  it('preserves the explicit Credential Slot binding for a fresh re-encrypt operation', () => {
    const retainedCredentials = [
      { passphrase: 'primary passphrase', sourceSlotId: 'source-slot-primary' },
      { passphrase: 'automation passphrase', sourceSlotId: 'source-slot-automation' },
    ] as const;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.normalizeNativeRetainedCredentials({ retainedCredentials })).toEqual(
      retainedCredentials,
    );
  });

  it('converges pre-switch re-encrypt interruption to the source without work-progress state', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptFinishSrc001' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptFinishDst001' });
    let state: TransitionSemanticState = {
      mode: {
        operation: 're_encrypt' as const,
        operationId: 'reencryptFinishOp0001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
        phase: {
          source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
          target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
          type: 'building_target' as const,
        },
        type: 'transitioning' as const,
      },
      retiredFileSystemIds: [],
    };

    const result = await convergeInterruptedPersistenceTransition({
      control: {
        publishState: async ({ state: nextState }) => {
          state = nextState;
        },
        readState: async () => state,
      },
      progressPort: undefined,
    });

    expect(result.authoritativeEndpoint).toBe('source');
    expect(result.stableState).toEqual({
      mode: { activeFileSystemId: sourceFileSystemId, type: 'hizofs' },
      retiredFileSystemIds: [targetFileSystemId],
    });
  });

  it('converges post-switch re-encrypt interruption to the target and defers source cleanup', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptStaleSrc0001' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptStaleDst0001' });
    let state: TransitionSemanticState = {
      mode: {
        operation: 're_encrypt' as const,
        operationId: 'reencryptStaleOp00001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
        phase: {
          source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
          target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
          type: 'cleaning_up_source' as const,
        },
        type: 'transitioning' as const,
      },
      retiredFileSystemIds: [],
    };

    const result = await convergeInterruptedPersistenceTransition({
      control: {
        publishState: async ({ state: nextState }) => {
          state = nextState;
        },
        readState: async () => state,
      },
      progressPort: undefined,
    });

    expect(result.authoritativeEndpoint).toBe('target');
    expect(result.stableState).toEqual({
      mode: { activeFileSystemId: targetFileSystemId, type: 'hizofs' },
      retiredFileSystemIds: [sourceFileSystemId],
    });
  });

  it('recovers target authority after first-copy response loss during re-encrypt switch', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptLossSource01' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptLossTarget01' });
    const sourceRootKey = rootKey({ fill: 51 });
    const targetRootKey = rootKey({ fill: 52 });
    const operationId = 'reencryptLossOp000001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId;
    const source = { fileSystemId: sourceFileSystemId, type: 'hizofs' as const };
    const target = { fileSystemId: targetFileSystemId, type: 'hizofs' as const };
    const building = {
      operation: 're_encrypt' as const,
      operationId,
      phase: { source, target, type: 'building_target' as const },
      type: 'transitioning' as const,
    };
    const cleaning = {
      ...building,
      phase: { source, target, type: 'cleaning_up_source' as const },
    };
    const endpointInspectionPort = {
      inspectHizoFSEndpoint: async ({ fileSystemId, openProfile }: {
        fileSystemId: FileSystemId;
        openProfile: 'normal_read' | 'root_key_proof';
      }) => {
        if (fileSystemId === sourceFileSystemId) return openProfile === 'normal_read' ? 'fully_verified' as const : 'root_key_ready' as const;
        if (fileSystemId === targetFileSystemId) return openProfile === 'normal_read' ? 'fully_verified' as const : 'root_key_ready' as const;
        return 'absent' as const;
      },
      inspectPlainEndpoint: async () => 'invalid' as const,
    };
    const targetProofScope = {
      withRootKeyProof: async ({ operation }: {
        operation: ({ rootKey }: { rootKey: PersistenceControlRootKeyDerivationCapability }) => Promise<unknown>;
      }) => await operation({ rootKey: targetRootKey }),
    } as Parameters<typeof PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptControl>[0]['targetProofScope'];
    const bootstrapPhysical = new MutablePhysical({
      controls: [
        await authenticatedProtectedControl({ copy: 0, fileSystemId: sourceFileSystemId, key: sourceRootKey, sequence: 1 }),
        undefined,
      ],
    });
    const bootstrap = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptControl({
      endpointInspectionPort,
      physical: bootstrapPhysical,
      sourceFileSystemId,
      sourceRootKeyProof: sourceRootKey,
      targetFileSystemId,
      targetProofScope,
    });
    await bootstrap.control.publishState({ state: { mode: building, retiredFileSystemIds: [] } });
    await expect(bootstrap.control.readState()).resolves.toMatchObject({ mode: building });

    const responseLoss = new Error('target authority publication response lost');
    const mutable = new FaultInjectingMutablePhysical({
      controls: bootstrapPhysical.controls,
      failure: responseLoss,
      fault: 'after_first_publish',
    });
    const subject = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptControl({
      endpointInspectionPort,
      physical: mutable,
      sourceFileSystemId,
      sourceRootKeyProof: sourceRootKey,
      targetFileSystemId,
      targetProofScope,
    });
    subject.markTargetNormalOpenVerified();

    await expect(subject.control.publishState({ state: { mode: cleaning, retiredFileSystemIds: [] } }))
      .rejects.toMatchObject({ code: 'authority_commit_failed' });
    expect(mutable.controls.map(control => control?.mode)).toContainEqual(building);
    expect(mutable.controls.map(control => control?.mode)).toContainEqual(cleaning);
    await expect(subject.control.readState()).resolves.toMatchObject({ mode: cleaning });

    await expect(subject.control.publishState({ state: { mode: cleaning, retiredFileSystemIds: [] } }))
      .resolves.toBeUndefined();
    await expect(subject.control.readState()).resolves.toMatchObject({ mode: cleaning });
    expect(mutable.controls.map(control => persistenceControlAuthenticationFileSystemId({ mode: control!.mode })))
      .toEqual([targetFileSystemId, targetFileSystemId]);
  });

  it('routes same-type source and target operations by exact endpoint identity', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptRouteSrc001' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptRouteDst001' });
    const binding = {
      operationId: 'reencryptRouteOp0001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const sourceCleanup = vi.fn(async () => undefined);
    const sourceOpen = vi.fn(async () => ({ authorityIdentity: 'source', close: async () => undefined, source: {} as never }));
    const targetPrepare = vi.fn(async () => undefined);
    const targetVerify = vi.fn(async () => undefined);
    const markTargetNormalOpenVerified = vi.fn();
    const source = {
      cleanupEndpoint: sourceCleanup,
      finalizeTarget: vi.fn(),
      inspectEndpoint: vi.fn(async () => 'fully_verified' as const),
      openSourceEndpoint: sourceOpen,
      openTargetEndpoint: vi.fn(),
      prepareTarget: vi.fn(),
      verifyNormalOpen: vi.fn(),
    } as unknown as TransitionEndpointDriver;
    const target = {
      cleanupEndpoint: vi.fn(),
      finalizeTarget: vi.fn(async () => undefined),
      inspectEndpoint: vi.fn(async () => 'root_key_ready' as const),
      openSourceEndpoint: vi.fn(),
      openTargetEndpoint: vi.fn(),
      prepareTarget: targetPrepare,
      verifyNormalOpen: targetVerify,
    } as unknown as TransitionEndpointDriver;
    const subject = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptTransitionDriver({
      binding,
      markTargetNormalOpenVerified,
      source,
      target,
    });

    await subject.cleanupEndpoint({ endpoint: binding.source });
    await subject.openSourceEndpoint({ endpoint: binding.source });
    await subject.prepareTarget({ binding });
    await subject.verifyNormalOpen({ binding });

    expect(sourceCleanup).toHaveBeenCalledWith({ endpoint: binding.source });
    expect(sourceOpen).toHaveBeenCalledWith({ endpoint: binding.source });
    expect(targetPrepare).toHaveBeenCalledWith({ binding });
    expect(targetVerify).toHaveBeenCalledWith({ binding });
    expect(markTargetNormalOpenVerified).toHaveBeenCalledOnce();
    await expect(subject.inspectEndpoint({
      endpoint: { fileSystemId: testFileSystemId({ value: 'reencryptRouteOther01' }), type: 'hizofs' },
    })).rejects.toThrow('unrelated endpoint');
  });

  it('does not authorize publication when target normal-open proof is interrupted', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptProofSrc001' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptProofDst001' });
    const binding = {
      operationId: 'reencryptProofOp0001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const proofInterrupted = new Error('injected target normal-open proof interruption');
    const markTargetNormalOpenVerified = vi.fn();
    const source = {
      cleanupEndpoint: vi.fn(),
      finalizeTarget: vi.fn(),
      inspectEndpoint: vi.fn(),
      openSourceEndpoint: vi.fn(),
      openTargetEndpoint: vi.fn(),
      prepareTarget: vi.fn(),
      verifyNormalOpen: vi.fn(),
    } as unknown as TransitionEndpointDriver;
    const targetVerify = vi.fn(async () => {
      throw proofInterrupted;
    });
    const target = {
      cleanupEndpoint: vi.fn(),
      finalizeTarget: vi.fn(),
      inspectEndpoint: vi.fn(),
      openSourceEndpoint: vi.fn(),
      openTargetEndpoint: vi.fn(),
      prepareTarget: vi.fn(),
      verifyNormalOpen: targetVerify,
    } as unknown as TransitionEndpointDriver;
    const subject = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptTransitionDriver({
      binding,
      markTargetNormalOpenVerified,
      source,
      target,
    });

    await expect(subject.verifyNormalOpen({ binding })).rejects.toBe(proofInterrupted);
    expect(targetVerify).toHaveBeenCalledWith({ binding });
    expect(markTargetNormalOpenVerified).not.toHaveBeenCalled();
  });

  it('removes an unreferenced target only while the exact source remains stable authority', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptSettleSrc01' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptSettleDst01' });
    const binding = {
      operationId: 'reencryptSettleOp001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId,
      source: { fileSystemId: sourceFileSystemId, type: 'hizofs' as const },
      target: { fileSystemId: targetFileSystemId, type: 'hizofs' as const },
    };
    const removeTarget = vi.fn(async () => undefined);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSReencryptTargetAfterStartFailure({
      binding,
      control: {
        publishState: vi.fn(),
        readState: async () => ({
          mode: { activeFileSystemId: sourceFileSystemId, type: 'hizofs' as const },
          retiredFileSystemIds: [],
        }),
      },
      removeTarget,
      targetFileSystemId,
    })).resolves.toBe('removed');
    expect(removeTarget).toHaveBeenCalledOnce();

    removeTarget.mockClear();
    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSReencryptTargetAfterStartFailure({
      binding,
      control: {
        publishState: vi.fn(),
        readState: async () => ({
          mode: {
            operation: 're_encrypt' as const,
            operationId: binding.operationId,
            phase: { source: binding.source, target: binding.target, type: 'building_target' as const },
            type: 'transitioning' as const,
          },
          retiredFileSystemIds: [],
        }),
      },
      removeTarget,
      targetFileSystemId,
    })).resolves.toBe('retained');
    expect(removeTarget).not.toHaveBeenCalled();
  });

  it('switches Persistence Control authentication only after target normal-open proof', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'reencryptControlSrc01' });
    const targetFileSystemId = testFileSystemId({ value: 'reencryptControlDst01' });
    const sourceRootKey = rootKey({ fill: 41 });
    const targetRootKey = rootKey({ fill: 42 });
    const initial = await authenticatedProtectedControl({
      copy: 0,
      fileSystemId: sourceFileSystemId,
      key: sourceRootKey,
      sequence: 1,
    });
    const mutable = new MutablePhysical({ controls: [initial, undefined] });
    const operationId = 'reencryptControlOp001' as import('@/00-storage/service/naidan-persistence-control/00-format').TransitionOperationId;
    const source = { fileSystemId: sourceFileSystemId, type: 'hizofs' as const };
    const target = { fileSystemId: targetFileSystemId, type: 'hizofs' as const };
    const endpointInspectionPort = {
      inspectHizoFSEndpoint: async ({ fileSystemId, openProfile }: {
        fileSystemId: FileSystemId;
        openProfile: 'normal_read' | 'root_key_proof';
      }) => {
        if (fileSystemId === sourceFileSystemId) return openProfile === 'normal_read' ? 'fully_verified' as const : 'root_key_ready' as const;
        if (fileSystemId === targetFileSystemId) return openProfile === 'normal_read' ? 'fully_verified' as const : 'root_key_ready' as const;
        return 'absent' as const;
      },
      inspectPlainEndpoint: async () => 'invalid' as const,
    };
    const targetProofCalls = vi.fn();
    const subject = PRODUCTION_RUNTIME_TEST_ONLY.createNativeHizoFSReencryptControl({
      endpointInspectionPort,
      physical: mutable,
      sourceFileSystemId,
      sourceRootKeyProof: sourceRootKey,
      targetFileSystemId,
      targetProofScope: {
        withRootKeyProof: async ({ fileSystemId, operation }) => {
          targetProofCalls(fileSystemId);
          return await operation({ rootKey: targetRootKey });
        },
      },
    });
    const building = {
      operation: 're_encrypt' as const,
      operationId,
      phase: { source, target, type: 'building_target' as const },
      type: 'transitioning' as const,
    };
    const cleaning = {
      ...building,
      phase: { source, target, type: 'cleaning_up_source' as const },
    };

    await expect(subject.control.readState()).resolves.toMatchObject({
      mode: { activeFileSystemId: sourceFileSystemId, type: 'hizofs' },
    });
    await subject.control.publishState({ state: { mode: building, retiredFileSystemIds: [] } });
    await expect(subject.control.readState()).resolves.toMatchObject({ mode: building });
    expect(targetProofCalls).not.toHaveBeenCalled();
    await expect(subject.control.publishState({ state: { mode: cleaning, retiredFileSystemIds: [] } }))
      .rejects.toThrow('target has not passed every retained-credential normal-open proof');

    subject.markTargetNormalOpenVerified();
    await subject.control.publishState({ state: { mode: cleaning, retiredFileSystemIds: [] } });
    await expect(subject.control.readState()).resolves.toMatchObject({ mode: cleaning });
    expect(targetProofCalls).toHaveBeenCalled();
  });
});

describe('inspectCredentialAwarePersistenceRuntime', () => {
  it('returns credential-required without checking protected endpoint readiness', async () => {
    const validateEndpointReadiness = vi.fn(async () => 'valid' as const);

    const inspection = await inspectCredentialAwarePersistenceRuntime({
      physical: physical({ controls: [
        protectedControl({ copy: 0, sequence: 2 }),
        protectedControl({ copy: 1, sequence: 1 }),
      ] }),
      validateEndpointReadiness,
    });

    expect(inspection).toEqual({
      blockingReason: 'protection_unresolved',
      candidates: [
        { copy: 0, sequence: 2, state: 'protection_unresolved' },
        { copy: 1, sequence: 1, state: 'protection_unresolved' },
      ],
      requiredAction: 'unlock',
      type: 'credential_required',
    });
    expect(validateEndpointReadiness).not.toHaveBeenCalled();
  });

  it('selects stable plain only after endpoint readiness succeeds', async () => {
    const first = await plainControl({ copy: 0, sequence: 2 });
    const second = await plainControl({ copy: 1, sequence: 1 });
    const validateEndpointReadiness = vi.fn(async () => 'valid' as const);

    await expect(inspectCredentialAwarePersistenceRuntime({
      physical: physical({ controls: [first, second] }),
      validateEndpointReadiness,
    })).resolves.toEqual({ type: 'plain' });

    expect(validateEndpointReadiness).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a structurally valid plain endpoint is unavailable', async () => {
    const control = await plainControl({ copy: 0, sequence: 1 });

    const inspection = await inspectCredentialAwarePersistenceRuntime({
      physical: physical({ controls: [control, undefined] }),
      validateEndpointReadiness: async () => 'invalid',
    });

    expect(inspection.type).toBe('recovery_required');
  });

  it('preserves plain traversal and iterator cleanup failures together', async () => {
    const traversalFailure = new Error('plain traversal failed');
    const cleanupFailure = new Error('plain iterator cleanup failed');
    const next = vi.fn(async () => {
      throw traversalFailure;
    });
    const closeIterator = vi.fn(async () => {
      throw cleanupFailure;
    });

    const result = PRODUCTION_RUNTIME_TEST_ONLY.consumeOneNativePlainDirectoryKey({
      iterator: { next, return: closeIterator },
    });

    await expect(result).rejects.toMatchObject({
      errors: [traversalFailure, cleanupFailure],
      message: 'native plain endpoint traversal and iterator cleanup both failed',
      name: 'AggregateError',
    });
    expect(next).toHaveBeenCalledOnce();
    expect(closeIterator).toHaveBeenCalledOnce();
  });
});



describe('native enable start-failure target ownership', () => {
  function transitionBinding() {
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'startFailureTarget001',
    }).control;
    if (control.mode.type !== 'transitioning' || control.mode.phase.target.type !== 'hizofs') {
      throw new Error('expected native enable transition');
    }
    return {
      binding: {
        operationId: control.mode.operationId,
        source: control.mode.phase.source,
        target: control.mode.phase.target,
      },
      control,
      fileSystemId: control.mode.phase.target.fileSystemId,
    } as const;
  }

  it('emits a grep-stable development trace without secret material', () => {
    const expected = transitionBinding();
    const failure = new TypeError('directory.stat is not a function');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    PRODUCTION_RUNTIME_TEST_ONLY.reportNativeEnableTrialFailure({
      cause: failure,
      fileSystemId: expected.fileSystemId,
      operationId: expected.binding.operationId,
      stage: 'advance_transition',
    });

    expect(warn).toHaveBeenCalledWith('[HIZOFS_TRIAL_DEBUG_001]', {
      event: 'native_enable_failure',
      failure: {
        errorCode: undefined,
        errorMessage: 'directory.stat is not a function',
        errorName: 'TypeError',
        errorPath: undefined,
      },
      fileSystemId: expected.fileSystemId,
      operationId: expected.binding.operationId,
      stage: 'advance_transition',
    });
  });

  it('retains the exact target when authenticated read-back proves transition start committed', async () => {
    const expected = transitionBinding();
    const removeTarget = vi.fn(async () => undefined);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => ({ mode: expected.control.mode, retiredFileSystemIds: [] }),
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).resolves.toBe('retained');

    expect(removeTarget).not.toHaveBeenCalled();
  });

  it('removes the exact target only when authenticated stable plain proves it unreferenced', async () => {
    const expected = transitionBinding();
    const removeTarget = vi.fn(async () => undefined);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => ({ mode: { type: 'plain' }, retiredFileSystemIds: [] }),
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).resolves.toBe('removed');

    expect(removeTarget).toHaveBeenCalledOnce();
  });

  it('retains targets named by cleanup authority or any non-plain authenticated state', async () => {
    const expected = transitionBinding();
    const removeTarget = vi.fn(async () => undefined);
    const stableHizoFS = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: 'otherStableTarget001',
    }).control;

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => ({
          mode: { type: 'plain' },
          retiredFileSystemIds: [expected.fileSystemId],
        }),
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).resolves.toBe('retained');

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => ({ mode: stableHizoFS.mode, retiredFileSystemIds: [] }),
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).resolves.toBe('retained');

    expect(removeTarget).not.toHaveBeenCalled();
  });

  it('propagates exact target cleanup failure after stable plain proves removal authority', async () => {
    const expected = transitionBinding();
    const failure = new Error('target cleanup failed');
    const removeTarget = vi.fn(async () => {
      throw failure;
    });

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => ({ mode: { type: 'plain' }, retiredFileSystemIds: [] }),
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).rejects.toBe(failure);

    expect(removeTarget).toHaveBeenCalledOnce();
  });

  it('does not delete when authenticated ownership cannot be read', async () => {
    const expected = transitionBinding();
    const failure = new Error('control read failed');
    const removeTarget = vi.fn(async () => undefined);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: expected.binding,
      control: {
        publishState: async () => undefined,
        readState: async () => {
          throw failure;
        },
      },
      fileSystemId: expected.fileSystemId,
      removeTarget,
    })).rejects.toBe(failure);

    expect(removeTarget).not.toHaveBeenCalled();
  });
});

describe('native disable start-failure source authority', () => {
  function disableBinding() {
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableStartSource001',
      targetFileSystemId: undefined,
    }).control;
    if (control.mode.type !== 'transitioning') throw new Error('expected native disable transition');
    return {
      binding: {
        operationId: control.mode.operationId,
        source: control.mode.phase.source,
        target: control.mode.phase.target,
      },
      fileSystemId: 'disableStartSource001' as FileSystemId,
    } as const;
  }

  it('keeps the source session only when authenticated stable HizoFS still selects the exact source', () => {
    const expected = disableBinding();
    const stable = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: expected.fileSystemId,
    }).control;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
      actual: { mode: stable.mode, retiredFileSystemIds: stable.retiredFileSystemIds },
      binding: expected.binding,
    })).toBe(true);
  });

  it('closes the source session when authenticated transition start committed', () => {
    const expected = disableBinding();
    const transitioning = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: expected.fileSystemId,
      targetFileSystemId: undefined,
    }).control;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
      actual: { mode: transitioning.mode, retiredFileSystemIds: transitioning.retiredFileSystemIds },
      binding: expected.binding,
    })).toBe(false);
  });

  it('fails closed for plain authority or another stable HizoFS source', () => {
    const expected = disableBinding();
    const another = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
      fileSystemId: 'anotherDisableSource1',
    }).control;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
      actual: { mode: { type: 'plain' }, retiredFileSystemIds: [] },
      binding: expected.binding,
    })).toBe(false);
    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeHizoFSDisableSourceRemainsAuthoritativeAfterStartFailure({
      actual: { mode: another.mode, retiredFileSystemIds: another.retiredFileSystemIds },
      binding: expected.binding,
    })).toBe(false);
  });
});

describe('credential candidate open profiles', () => {
  it('allows root-key-only proof only for incomplete transition phases', () => {
    const stable = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'stableFileSystem00001' }).control;
    const encryptBuilding = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'targetFileSystem00001',
    }).control;
    const decryptCleaning = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: 'sourceFileSystem00001',
      targetFileSystemId: undefined,
    }).control;
    const reencryptBuilding = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 're_encrypt',
      phase: 'building_target',
      sourceFileSystemId: 'sourceFileSystem00002',
      targetFileSystemId: 'targetFileSystem00002',
    }).control;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.credentialCandidateOpenProfile({ control: stable })).toBe('normal_read');
    expect(PRODUCTION_RUNTIME_TEST_ONLY.credentialCandidateOpenProfile({ control: encryptBuilding })).toBe('root_key_proof');
    expect(PRODUCTION_RUNTIME_TEST_ONLY.credentialCandidateOpenProfile({ control: decryptCleaning })).toBe('root_key_proof');
    expect(PRODUCTION_RUNTIME_TEST_ONLY.credentialCandidateOpenProfile({ control: reencryptBuilding })).toBe('normal_read');
  });
});

describe('native transition convergence authority', () => {
  it('reconstructs one operation binding across building and cleanup phases', () => {
    const building = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'convergeTarget0000001',
    }).control;
    const cleaning = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'convergeTarget0000001',
    }).control;
    if (building.mode.type !== 'transitioning' || cleaning.mode.type !== 'transitioning') {
      throw new Error('expected transitioning controls');
    }
    const cleaningForSameOperation: NaidanPersistenceControlV1 = {
      ...cleaning,
      mode: { ...cleaning.mode, operationId: building.mode.operationId },
    };

    const binding = PRODUCTION_RUNTIME_TEST_ONLY.nativeEncryptTransitionBinding({ control: building });
    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeEncryptTransitionBinding({ control: cleaningForSameOperation })).toEqual(binding);
    expect(PRODUCTION_RUNTIME_TEST_ONLY.sameNativeEncryptTransition({
      actual: { mode: cleaningForSameOperation.mode, retiredFileSystemIds: [] },
      binding,
    })).toBe(true);
  });

  it('reconstructs interrupted disable binding and credential profile across phases', () => {
    const building = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000001',
      targetFileSystemId: undefined,
    }).control;
    const cleaning = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: 'disableSource0000001',
      targetFileSystemId: undefined,
    }).control;
    if (building.mode.type !== 'transitioning' || cleaning.mode.type !== 'transitioning') {
      throw new Error('expected transitioning controls');
    }
    const cleaningForSameOperation: NaidanPersistenceControlV1 = {
      ...cleaning,
      mode: { ...cleaning.mode, operationId: building.mode.operationId },
    };
    const binding = PRODUCTION_RUNTIME_TEST_ONLY.nativeDecryptTransitionBinding({ control: building });

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: building,
      fileSystemId: 'disableSource0000001' as FileSystemId,
    })).toMatchObject({ binding, openProfile: 'normal_read', operation: 'decrypt', phase: 'building_target' });
    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: cleaningForSameOperation,
      fileSystemId: 'disableSource0000001' as FileSystemId,
    })).toMatchObject({ binding, openProfile: 'root_key_proof', operation: 'decrypt', phase: 'cleaning_up_source' });
    expect(PRODUCTION_RUNTIME_TEST_ONLY.sameNativeDecryptTransition({
      actual: { mode: cleaningForSameOperation.mode, retiredFileSystemIds: [] },
      binding,
    })).toBe(true);
  });

  it('reconstructs interrupted re-encrypt authority from the phase authentication endpoint', () => {
    const building = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 're_encrypt',
      phase: 'building_target',
      sourceFileSystemId: 'reencryptSource00001',
      targetFileSystemId: 'reencryptTarget00001',
    }).control;
    const cleaning = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 're_encrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: 'reencryptSource00001',
      targetFileSystemId: 'reencryptTarget00001',
    }).control;
    if (building.mode.type !== 'transitioning' || cleaning.mode.type !== 'transitioning') {
      throw new Error('expected transitioning controls');
    }
    const cleaningForSameOperation: NaidanPersistenceControlV1 = {
      ...cleaning,
      mode: { ...cleaning.mode, operationId: building.mode.operationId },
    };
    const binding = PRODUCTION_RUNTIME_TEST_ONLY.nativeReencryptTransitionBinding({ control: building });

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: building,
      fileSystemId: 'reencryptSource00001' as FileSystemId,
    })).toMatchObject({ binding, openProfile: 'normal_read', operation: 're_encrypt', phase: 'building_target' });
    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: cleaningForSameOperation,
      fileSystemId: 'reencryptTarget00001' as FileSystemId,
    })).toMatchObject({ binding, openProfile: 'normal_read', operation: 're_encrypt', phase: 'cleaning_up_source' });
    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: building,
      fileSystemId: 'reencryptTarget00001' as FileSystemId,
    })).toThrow('another native re-encrypt authentication endpoint');
  });

  it('converges interrupted enable before authority switch to stable plain', async () => {
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'enableConvergeTarget01',
    }).control;
    let state: TransitionSemanticState = {
      mode: control.mode,
      retiredFileSystemIds: control.retiredFileSystemIds,
    };

    const result = await convergeInterruptedPersistenceTransition({
      control: {
        publishState: async ({ state: nextState }) => {
          state = nextState;
        },
        readState: async () => state,
      },
      progressPort: undefined,
    });

    expect(result).toEqual({
      authoritativeEndpoint: 'source',
      stableState: { mode: { type: 'plain' }, retiredFileSystemIds: [
        testFileSystemId({ value: 'enableConvergeTarget01' }),
      ] },
    });
  });

  it('converges interrupted disable before authority switch to its encrypted source', async () => {
    const sourceFileSystemId = testFileSystemId({ value: 'disableConvergeSrc01' });
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId,
      targetFileSystemId: undefined,
    }).control;
    let state: TransitionSemanticState = {
      mode: control.mode,
      retiredFileSystemIds: control.retiredFileSystemIds,
    };

    const result = await convergeInterruptedPersistenceTransition({
      control: {
        publishState: async ({ state: nextState }) => {
          state = nextState;
        },
        readState: async () => state,
      },
      progressPort: undefined,
    });

    expect(result.stableState).toEqual({
      mode: { activeFileSystemId: sourceFileSystemId, type: 'hizofs' },
      retiredFileSystemIds: [],
    });
  });

  it('converges interrupted enable after authority switch to its encrypted target', async () => {
    const targetFileSystemId = testFileSystemId({ value: 'enableConvergeTarget02' });
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: undefined,
      targetFileSystemId,
    }).control;
    let state: TransitionSemanticState = {
      mode: control.mode,
      retiredFileSystemIds: control.retiredFileSystemIds,
    };

    const result = await convergeInterruptedPersistenceTransition({
      control: {
        publishState: async ({ state: nextState }) => {
          state = nextState;
        },
        readState: async () => state,
      },
      progressPort: undefined,
    });

    expect(result).toEqual({
      authoritativeEndpoint: 'target',
      stableState: {
        mode: { activeFileSystemId: targetFileSystemId, type: 'hizofs' },
        retiredFileSystemIds: [],
      },
    });
  });

  it('rejects stable mode instead of inventing a convergence binding', () => {
    const stable = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({ fileSystemId: 'stableConverge000001' }).control;
    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.nativeEncryptTransitionBinding({ control: stable })).toThrow('active Persistence Control transition');
    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.nativeReencryptTransitionBinding({ control: stable })).toThrow('active Persistence Control transition');
  });

  it('bootstraps initial enable only while both Persistence Control copies are absent', async () => {
    const key = rootKey({ fill: 19 });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'bootstrapTarget000001',
    });
    if (inspection.control.mode.type !== 'transitioning') throw new Error('expected transitioning control');
    const mode = inspection.control.mode;
    const fileSystemId = persistenceControlAuthenticationFileSystemId({ mode });
    if (fileSystemId === undefined) throw new Error('expected authenticated transition');
    const physicalPort = new MutablePhysical({ controls: [undefined, undefined] });
    const port = PRODUCTION_RUNTIME_TEST_ONLY.createCallbackScopedPersistenceControlTransitionPort({
      bootstrapAuthorization: 'verified_plain_namespace',
      endpointInspectionPort: {
        inspectHizoFSEndpoint: async () => 'fully_verified',
        inspectPlainEndpoint: async () => 'fully_verified',
      },
      fileSystemId,
      initialOpenProfile: 'root_key_proof',
      physical: physicalPort,
      proofScopeForProfile: () => ({
        withRootKeyProof: async ({ operation }) => await operation({ rootKey: key }),
      }),
    });

    await expect(port.readState()).resolves.toEqual({ mode: { type: 'plain' }, retiredFileSystemIds: [] });
    await port.publishState({ state: { mode, retiredFileSystemIds: [] } });
    await expect(port.readState()).resolves.toMatchObject({ mode: { operation: 'encrypt', type: 'transitioning' } });

    physicalPort.controls[0] = undefined;
    physicalPort.controls[1] = undefined;
    await expect(port.readState()).rejects.toMatchObject({ name: 'PersistenceControlSelectionError' });
  });

  it('does not bootstrap when either Persistence Control copy contains non-missing bytes', async () => {
    const key = rootKey({ fill: 21 });
    const fileSystemId = testFileSystemId({ value: 'bootstrapReject000001' });
    const physicalPort: PersistenceControlPhysicalPort = {
      publishWholeFileDurably: async () => undefined,
      readFileBounded: async ({ copy }) => copy === 0 ? Uint8Array.of(0xff) : undefined,
      runExclusive: async ({ operation }) => await operation(),
    };
    const port = PRODUCTION_RUNTIME_TEST_ONLY.createCallbackScopedPersistenceControlTransitionPort({
      bootstrapAuthorization: 'verified_plain_namespace',
      endpointInspectionPort: {
        inspectHizoFSEndpoint: async () => 'fully_verified',
        inspectPlainEndpoint: async () => 'fully_verified',
      },
      fileSystemId,
      initialOpenProfile: 'root_key_proof',
      physical: physicalPort,
      proofScopeForProfile: () => ({
        withRootKeyProof: async ({ operation }) => await operation({ rootKey: key }),
      }),
    });

    await expect(port.readState()).rejects.toMatchObject({ name: 'PersistenceControlSelectionError' });
  });

  it('removes an unreferenced enable target when bootstrap publication fails before its commit point', async () => {
    const key = rootKey({ fill: 23 });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'bootstrapCleanup00001',
    });
    if (inspection.control.mode.type !== 'transitioning') throw new Error('expected transitioning control');
    const mode = inspection.control.mode;
    const fileSystemId = persistenceControlAuthenticationFileSystemId({ mode });
    if (fileSystemId === undefined) throw new Error('expected authenticated transition');
    const publicationFailure = new Error('first control copy was not written');
    const physicalPort = new FaultInjectingMutablePhysical({
      controls: [undefined, undefined],
      failure: publicationFailure,
      fault: 'before_first_publish',
    });
    const port = PRODUCTION_RUNTIME_TEST_ONLY.createCallbackScopedPersistenceControlTransitionPort({
      bootstrapAuthorization: 'verified_plain_namespace',
      endpointInspectionPort: {
        inspectHizoFSEndpoint: async () => 'fully_verified',
        inspectPlainEndpoint: async () => 'fully_verified',
      },
      fileSystemId,
      initialOpenProfile: 'root_key_proof',
      physical: physicalPort,
      proofScopeForProfile: () => ({
        withRootKeyProof: async ({ operation }) => await operation({ rootKey: key }),
      }),
    });
    const removeTarget = vi.fn(async () => undefined);

    await expect(port.publishState({ state: { mode, retiredFileSystemIds: [] } })).rejects.toMatchObject({
      code: 'authority_commit_failed',
    });
    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: { operationId: mode.operationId, source: mode.phase.source, target: mode.phase.target },
      control: port,
      fileSystemId,
      removeTarget,
    })).resolves.toBe('removed');
    expect(removeTarget).toHaveBeenCalledOnce();
  });

  it('retains an enable target when the first authenticated control copy committed before response loss', async () => {
    const key = rootKey({ fill: 29 });
    const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'bootstrapRetain000001',
    });
    if (inspection.control.mode.type !== 'transitioning') throw new Error('expected transitioning control');
    const mode = inspection.control.mode;
    const fileSystemId = persistenceControlAuthenticationFileSystemId({ mode });
    if (fileSystemId === undefined) throw new Error('expected authenticated transition');
    const responseLoss = new Error('first control copy response was lost');
    const physicalPort = new FaultInjectingMutablePhysical({
      controls: [undefined, undefined],
      failure: responseLoss,
      fault: 'after_first_publish',
    });
    const port = PRODUCTION_RUNTIME_TEST_ONLY.createCallbackScopedPersistenceControlTransitionPort({
      bootstrapAuthorization: 'verified_plain_namespace',
      endpointInspectionPort: {
        inspectHizoFSEndpoint: async () => 'fully_verified',
        inspectPlainEndpoint: async () => 'fully_verified',
      },
      fileSystemId,
      initialOpenProfile: 'root_key_proof',
      physical: physicalPort,
      proofScopeForProfile: () => ({
        withRootKeyProof: async ({ operation }) => await operation({ rootKey: key }),
      }),
    });
    const removeTarget = vi.fn(async () => undefined);

    await expect(port.publishState({ state: { mode, retiredFileSystemIds: [] } })).rejects.toMatchObject({
      code: 'authority_commit_failed',
    });
    await expect(PRODUCTION_RUNTIME_TEST_ONLY.settleNativeHizoFSEnableTargetAfterStartFailure({
      binding: { operationId: mode.operationId, source: mode.phase.source, target: mode.phase.target },
      control: port,
      fileSystemId,
      removeTarget,
    })).resolves.toBe('retained');
    expect(removeTarget).not.toHaveBeenCalled();
  });

  it('switches the callback-scoped proof from root-key to normal-read after authority switch', async () => {
    const key = rootKey({ fill: 17 });
    const buildingInspection = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'proofProfile000000001',
    });
    const cleaningInspection = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'proofProfile000000001',
    });
    if (buildingInspection.control.mode.type !== 'transitioning'
      || cleaningInspection.control.mode.type !== 'transitioning') {
      throw new Error('expected transitioning controls');
    }
    const buildingMode = buildingInspection.control.mode;
    const cleaningMode = {
      ...cleaningInspection.control.mode,
      operationId: buildingMode.operationId,
    } as const;
    const fileSystemId = persistenceControlAuthenticationFileSystemId({ mode: buildingMode });
    if (fileSystemId === undefined) throw new Error('expected authenticated transition');
    const physicalPort = new MutablePhysical({ controls: [
      await authenticatedControl({ copy: 0, key, mode: buildingMode, sequence: 2 }),
      await authenticatedControl({ copy: 1, key, mode: buildingMode, sequence: 1 }),
    ] });
    const openedProfiles: Array<'normal_read' | 'root_key_proof'> = [];
    const port = PRODUCTION_RUNTIME_TEST_ONLY.createCallbackScopedPersistenceControlTransitionPort({
      bootstrapAuthorization: undefined,
      endpointInspectionPort: {
        inspectHizoFSEndpoint: async () => 'fully_verified',
        inspectPlainEndpoint: async () => 'fully_verified',
      },
      fileSystemId,
      initialOpenProfile: 'root_key_proof',
      physical: physicalPort,
      proofScopeForProfile: ({ openProfile }) => ({
        withRootKeyProof: async ({ operation }) => {
          openedProfiles.push(openProfile);
          return await operation({ rootKey: key });
        },
      }),
    });

    await expect(port.readState()).resolves.toMatchObject({ mode: { phase: { type: 'building_target' } } });
    await port.publishState({ state: { mode: cleaningMode, retiredFileSystemIds: [] } });
    await expect(port.readState()).resolves.toMatchObject({ mode: { phase: { type: 'cleaning_up_source' } } });
    await port.publishState({ state: { mode: { activeFileSystemId: fileSystemId, type: 'hizofs' }, retiredFileSystemIds: [] } });
    await expect(port.readState()).resolves.toMatchObject({ mode: { type: 'hizofs' } });

    expect(openedProfiles).toEqual(['root_key_proof', 'normal_read', 'normal_read', 'normal_read', 'normal_read']);
  });

  it('releases the opened authority even when convergence binding validation fails', async () => {
    const releaseResources = vi.fn(async () => undefined);
    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runWithCredentialAuthorityRelease({
      failureMessage: 'convergence validation and release both failed',
      operation: async () => {
        throw new TypeError('invalid convergence binding');
      },
      releaseResources,
    })).rejects.toThrow('invalid convergence binding');
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('preserves callback and release failures from an asynchronous credential proof scope', async () => {
    const operationFailure = new Error('proof operation failed');
    const releaseFailure = new Error('proof release failed');
    const releaseResources = vi.fn(async () => {
      throw releaseFailure;
    });

    const result = PRODUCTION_RUNTIME_TEST_ONLY.runWithCredentialAuthorityRelease({
      failureMessage: 'proof operation and release both failed',
      operation: async () => {
        throw operationFailure;
      },
      releaseResources,
    });

    await expect(result).rejects.toMatchObject({
      errors: [operationFailure, releaseFailure],
      message: 'proof operation and release both failed',
      name: 'AggregateError',
    });
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('preserves endpoint proof and release failures during authenticated inspection', async () => {
    const fileSystemId = testFileSystemId({ value: 'inspectionRelease0001' });
    const releaseFailure = new Error('inspection release failed');
    const containerRoot = Object.freeze({}) as FileSystemDirectoryHandle;
    const nativeStorageRoot = {
      getDirectoryHandle: vi.fn(async () => containerRoot),
    } as unknown as FileSystemDirectoryHandle;
    const nativeNamespaceRoot = {
      getDirectoryHandle: vi.fn(async () => nativeStorageRoot),
    } as unknown as FileSystemDirectoryHandle;
    const releaseResources = vi.fn(async () => {
      throw releaseFailure;
    });

    const result = PRODUCTION_RUNTIME_TEST_ONLY.inspectNativeHizoFSEndpointWith({
      fileSystemId,
      nativeNamespaceRoot,
      openContainer: async () => ({ releaseResources, type: 'opened' }),
      openProfile: 'normal_read',
      passphrase: 'passphrase',
    });

    await expect(result).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining('without exposing callback-scoped identity proof') }), releaseFailure],
      message: 'HizoFS endpoint inspection and credential authority release both failed',
      name: 'AggregateError',
    });
    expect(releaseResources).toHaveBeenCalledOnce();
  });
});

describe('openCapturedCredentialRequiredPersistenceRuntime', () => {
  it('proves the highest unresolved candidate and rechecks exact A/B authority before returning it', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 7 });
    const physical = new MutablePhysical({ controls: [
      await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 2 }),
      await authenticatedProtectedControl({ copy: 1, fileSystemId, key, sequence: 1 }),
    ] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const authority = Object.freeze({ name: 'opened-authority' });
    const releaseResources = vi.fn(async () => undefined);
    const validateEndpointReadiness = vi.fn(async () => 'valid' as const);

    const result = await openCapturedCredentialRequiredPersistenceRuntime({
      captured,
      openCandidate: async ({ fileSystemId: requestedFileSystemId, passphrase, verifyProofAuthority }) => {
        expect(requestedFileSystemId).toBe(fileSystemId);
        expect(passphrase).toBe('correct horse battery staple');
        await verifyProofAuthority({ fileSystemId, rootKeyProof: key });
        return { authority, releaseResources, type: 'opened' };
      },
      passphrase: 'correct horse battery staple',
      physical,
      validateEndpointReadiness,
    });

    expect(result).toMatchObject({ authority, fileSystemId, type: 'opened' });
    if (result.type !== 'opened') throw new Error('expected opened result');
    expect(result.selected.control.sequence).toBe(2);
    expect(validateEndpointReadiness).toHaveBeenCalledTimes(2);
    expect(releaseResources).not.toHaveBeenCalled();
  });

  it('does not fall back to an older candidate when the highest candidate rejects the credential', async () => {
    const higherFileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const lowerFileSystemId = testFileSystemId({ value: 'ZYXWVUTSRQ_9876543210' });
    const physical = new MutablePhysical({ controls: [
      await authenticatedProtectedControl({
        copy: 0,
        fileSystemId: higherFileSystemId,
        key: rootKey({ fill: 3 }),
        sequence: 9,
      }),
      await authenticatedProtectedControl({
        copy: 1,
        fileSystemId: lowerFileSystemId,
        key: rootKey({ fill: 4 }),
        sequence: 8,
      }),
    ] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const requested = vi.fn();

    await expect(openCapturedCredentialRequiredPersistenceRuntime({
      captured,
      openCandidate: async ({ fileSystemId }) => {
        requested(fileSystemId);
        return { type: 'credential_rejected' };
      },
      passphrase: 'wrong-passphrase',
      physical,
      validateEndpointReadiness: async () => 'valid',
    })).resolves.toEqual({ type: 'credential_rejected' });

    expect(requested).toHaveBeenCalledOnce();
    expect(requested).toHaveBeenCalledWith(higherFileSystemId);
  });

  it('releases the opened authority when A/B bytes change before registration', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 5 });
    const physical = new MutablePhysical({ controls: [
      await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 2 }),
      await authenticatedProtectedControl({ copy: 1, fileSystemId, key, sequence: 1 }),
    ] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const releaseResources = vi.fn(async () => undefined);

    await expect(openCapturedCredentialRequiredPersistenceRuntime({
      captured,
      openCandidate: async ({ verifyProofAuthority }) => {
        await verifyProofAuthority({ fileSystemId, rootKeyProof: key });
        physical.controls[1] = undefined;
        return { authority: Object.freeze({}), releaseResources, type: 'opened' };
      },
      passphrase: 'valid-passphrase',
      physical,
      validateEndpointReadiness: async () => 'valid',
    })).rejects.toMatchObject({ name: 'PersistenceControlAuthorityChangedError' });

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('releases and rejects an opener that returns authority without proof verification', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 6 });
    const physical = new MutablePhysical({ controls: [
      await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 2 }),
      undefined,
    ] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const releaseResources = vi.fn(async () => undefined);

    await expect(openCapturedCredentialRequiredPersistenceRuntime({
      captured,
      openCandidate: async () => ({ authority: Object.freeze({}), releaseResources, type: 'opened' }),
      passphrase: 'valid-passphrase',
      physical,
      validateEndpointReadiness: async () => 'valid',
    })).rejects.toThrow('without proving Persistence Control authority');

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('propagates infrastructure failures instead of reporting credential rejection', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 8 });
    const physical = new MutablePhysical({ controls: [
      await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 2 }),
      undefined,
    ] });
    const captured = await capturePersistenceControlAuthority({ physical });

    await expect(openCapturedCredentialRequiredPersistenceRuntime({
      captured,
      openCandidate: async () => {
        throw new Error('native OPFS unavailable');
      },
      passphrase: 'valid-passphrase',
      physical,
      validateEndpointReadiness: async () => 'valid',
    })).rejects.toThrow('native OPFS unavailable');
  });
});


describe('registerCredentialBoundApplicationSession', () => {
  it('transfers stable HizoFS authority only after the session opener awaits exact A/B recheck', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 10 });
    const authority = Object.freeze({ kind: 'opaque-authority' });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 4 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority,
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    const events: string[] = [];
    const session = testFileSystemSession();
    const openPlainApplicationSession = vi.fn();

    const result = await registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: async ({ authority: received, fileSystemId: receivedId, recheckAuthority }) => {
        expect(received).toBe(authority);
        expect(receivedId).toBe(fileSystemId);
        events.push('open');
        await recheckAuthority();
        events.push('rechecked');
        return session;
      },
      openPlainApplicationSession,
      physical,
    });

    expect(result).toMatchObject({
      authoritativeEndpoint: { fileSystemId, type: 'hizofs' },
      fileSystemId,
      fileSystemSession: session,
      type: 'opened',
    });
    expect(events).toEqual(['open', 'rechecked']);
    expect(openPlainApplicationSession).not.toHaveBeenCalled();
    expect(releaseResources).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: 'encrypt' as const,
      phase: 'building_target' as const,
      sourceFileSystemId: undefined,
      targetFileSystemId: 'targetFileSystem00001',
    },
    {
      operation: 'decrypt' as const,
      phase: 'cleaning_up_source' as const,
      sourceFileSystemId: 'sourceFileSystem00001',
      targetFileSystemId: undefined,
    },
  ])('releases proof-only HizoFS authority before registering authoritative plain storage ($operation/$phase)', async ({
    operation,
    phase,
    sourceFileSystemId,
    targetFileSystemId,
  }) => {
    const transition = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation,
      phase,
      sourceFileSystemId,
      targetFileSystemId,
    });
    const key = rootKey({ fill: 11 });
    const control = await authenticatedControl({ copy: 0, key, mode: transition.mode, sequence: 5 });
    const events: string[] = [];
    const releaseResources = vi.fn(async () => {
      events.push('release-proof');
    });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({ kind: 'proof-only-authority' }),
      control,
      expectedProfile: 'root_key_proof',
      key,
      releaseResources,
    });
    const session = testFileSystemSession();
    const openHizoFSApplicationSession = vi.fn();

    const result = await registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession,
      openPlainApplicationSession: async ({ recheckAuthority }) => {
        events.push('open-plain');
        await recheckAuthority();
        events.push('rechecked');
        return session;
      },
      physical,
    });

    expect(result).toMatchObject({
      authoritativeEndpoint: { type: 'plain' },
      fileSystemSession: session,
      type: 'opened',
    });
    expect(events).toEqual(['release-proof', 'open-plain', 'rechecked']);
    expect(openHizoFSApplicationSession).not.toHaveBeenCalled();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('rejects and closes a session opener that omits the final authority recheck', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 12 });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 6 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    const close = vi.fn(async () => undefined);

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: async () => testFileSystemSession({ close }),
      openPlainApplicationSession: vi.fn(),
      physical,
    })).rejects.toThrow('without rechecking Persistence Control authority');

    expect(close).toHaveBeenCalledOnce();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('rejects an opener that swallows an A/B recheck failure and closes its returned session', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 13 });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 7 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    physical.controls[0] = undefined;
    const close = vi.fn(async () => undefined);

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: async ({ recheckAuthority }) => {
        try {
          await recheckAuthority();
        } catch {
          // Simulates a broken composition adapter that suppresses the race.
        }
        return testFileSystemSession({ close });
      },
      openPlainApplicationSession: vi.fn(),
      physical,
    })).rejects.toThrow('returned after Persistence Control authority recheck failed');

    expect(close).toHaveBeenCalledOnce();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('rejects repeated authority rechecks even if the opener suppresses the second failure', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 14 });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 8 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    const close = vi.fn(async () => undefined);

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: async ({ recheckAuthority }) => {
        await recheckAuthority();
        try {
          await recheckAuthority();
        } catch {
          // Simulates a broken composition adapter that suppresses misuse.
        }
        return testFileSystemSession({ close });
      },
      openPlainApplicationSession: vi.fn(),
      physical,
    })).rejects.toThrow('violated the one-shot authority recheck contract');

    expect(close).toHaveBeenCalledOnce();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('preserves invalid when concurrent recheck invocations race', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 16 });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 10 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    const originalRead = physical.readFileBounded.bind(physical);
    let unblockFirstRead: (() => void) | undefined;
    const firstReadBlocked = new Promise<void>((resolve) => {
      unblockFirstRead = resolve;
    });
    let shouldBlock = true;
    vi.spyOn(physical, 'readFileBounded').mockImplementation(async (input) => {
      if (shouldBlock) {
        shouldBlock = false;
        await firstReadBlocked;
      }
      return await originalRead(input);
    });
    const close = vi.fn(async () => undefined);

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: async ({ recheckAuthority }) => {
        const first = recheckAuthority();
        await Promise.resolve();
        try {
          await recheckAuthority();
        } catch {
          // Simulates a broken adapter that suppresses the concurrent misuse.
        }
        unblockFirstRead?.();
        await first;
        return testFileSystemSession({ close });
      },
      openPlainApplicationSession: vi.fn(),
      physical,
    })).rejects.toThrow('violated the one-shot authority recheck contract');

    expect(close).toHaveBeenCalledOnce();
    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('releases authority when selected control cannot describe a credential-bound endpoint', async () => {
    const fileSystemId = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const key = rootKey({ fill: 17 });
    const releaseResources = vi.fn(async () => undefined);
    const control = await authenticatedProtectedControl({ copy: 0, fileSystemId, key, sequence: 11 });
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'normal_read',
      key,
      releaseResources,
    });
    const inconsistentOpened = {
      ...opened,
      selected: {
        ...opened.selected,
        control: { ...opened.selected.control, mode: { type: 'plain' as const } },
      },
    };

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened: inconsistentOpened,
      openHizoFSApplicationSession: vi.fn(),
      openPlainApplicationSession: vi.fn(),
      physical,
    })).rejects.toThrow('credential-bound Persistence Control cannot authorize plain stable mode');

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('does not release a proof-only capability twice when plain authority recheck fails', async () => {
    const transition = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'encrypt',
      phase: 'building_target',
      sourceFileSystemId: undefined,
      targetFileSystemId: 'targetFileSystem00001',
    });
    const key = rootKey({ fill: 18 });
    const control = await authenticatedControl({ copy: 0, key, mode: transition.mode, sequence: 12 });
    const releaseResources = vi.fn(async () => undefined);
    const { captured, opened, physical } = await openedCredentialAuthority({
      authority: Object.freeze({}),
      control,
      expectedProfile: 'root_key_proof',
      key,
      releaseResources,
    });
    physical.controls[0] = undefined;

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened,
      openHizoFSApplicationSession: vi.fn(),
      openPlainApplicationSession: async ({ recheckAuthority }) => {
        await recheckAuthority();
        return testFileSystemSession();
      },
      physical,
    })).rejects.toMatchObject({ name: 'PersistenceControlAuthorityChangedError' });

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it('passes credential rejection through without attempting session registration', async () => {
    const control = await authenticatedProtectedControl({
      copy: 0,
      fileSystemId: testFileSystemId({ value: '0123456789_ABCDEFGHIJ' }),
      key: rootKey({ fill: 15 }),
      sequence: 9,
    });
    const physical = new MutablePhysical({ controls: [control, undefined] });
    const captured = await capturePersistenceControlAuthority({ physical });
    const openHizoFSApplicationSession = vi.fn();
    const openPlainApplicationSession = vi.fn();

    await expect(registerCredentialBoundApplicationSession({
      captured,
      opened: { type: 'credential_rejected' },
      openHizoFSApplicationSession,
      openPlainApplicationSession,
      physical,
    })).resolves.toEqual({ type: 'credential_rejected' });

    expect(openHizoFSApplicationSession).not.toHaveBeenCalled();
    expect(openPlainApplicationSession).not.toHaveBeenCalled();
  });

  it('removes stable plain retired containers one at a time and republishes the remaining authority', async () => {
    const firstRetired = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const secondRetired = testFileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
    const physical = new MutablePhysical({ controls: [
      await plainControl({ copy: 0, retiredFileSystemIds: [firstRetired, secondRetired], sequence: 4 }),
      await plainControl({ copy: 1, retiredFileSystemIds: [firstRetired, secondRetired], sequence: 3 }),
    ] });
    const removed: ReturnType<typeof testFileSystemId>[] = [];
    const exclusiveGate = {
      runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
    };

    await PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith({
      exclusiveGate,
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      runtime: {
        createControlPhysical: () => physical,
        inspectPlainEndpoint: async () => 'fully_verified',
        removeRetiredContainer: async ({ fileSystemId }) => {
          removed.push(fileSystemId);
        },
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    });

    expect(removed).toEqual([firstRetired, secondRetired]);
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('removes stable HizoFS retired containers one at a time under the active authority proof', async () => {
    const active = testFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const firstRetired = testFileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
    const secondRetired = testFileSystemId({ value: 'KLMNOPQRST_UVWXYZ0123' });
    const key = rootKey({ fill: 25 });
    const mode = { activeFileSystemId: active, type: 'hizofs' } as const;
    const mutablePhysical = new MutablePhysical({ controls: [
      await authenticatedControlWithRetired({
        copy: 0,
        key,
        mode,
        retiredFileSystemIds: [firstRetired, secondRetired],
        sequence: 6,
      }),
      await authenticatedControlWithRetired({
        copy: 1,
        key,
        mode,
        retiredFileSystemIds: [firstRetired, secondRetired],
        sequence: 5,
      }),
    ] });
    const removed: FileSystemId[] = [];
    const proofAuthority: PersistenceControlProofAuthority = {
      resolveRootKey: async ({ fileSystemId }) => fileSystemId === active
        ? { rootKey: key, state: 'resolved' }
        : { state: 'unresolved' },
      validateEndpointReadiness: async ({ control }) => control.mode.type === 'hizofs'
        && control.mode.activeFileSystemId === active
        ? 'valid'
        : 'invalid',
    };

    await PRODUCTION_RUNTIME_TEST_ONLY.runNativeStableHizoFSRetiredContainerCleanupWith({
      activeFileSystemId: active,
      exclusiveGate: {
        runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
      },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      proofAuthority,
      runtime: {
        createControlPhysical: () => mutablePhysical,
        removeRetiredContainer: async ({ fileSystemId }) => {
          removed.push(fileSystemId);
        },
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    });

    expect(removed).toEqual([firstRetired, secondRetired]);
    expect(mutablePhysical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(mutablePhysical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('repairs degraded stable plain control after cleanup publication response loss', async () => {
    const physical = new MutablePhysical({ controls: [
      await plainControl({ copy: 0, sequence: 12 }),
      undefined,
    ] });
    const exclusiveGate = {
      runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
    };

    await PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith({
      exclusiveGate,
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      runtime: {
        createControlPhysical: () => physical,
        inspectPlainEndpoint: async () => 'fully_verified',
        removeRetiredContainer: vi.fn(),
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    });

    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('keeps the failed and later retired IDs authenticated for a restart retry', async () => {
    const firstRetired = testFileSystemId({ value: 'KLMNOPQRST_UVWXYZ0123' });
    const secondRetired = testFileSystemId({ value: 'UVWXYZ0123_KLMNOPQRST' });
    const physical = new MutablePhysical({ controls: [
      await plainControl({ copy: 0, retiredFileSystemIds: [firstRetired, secondRetired], sequence: 8 }),
      await plainControl({ copy: 1, retiredFileSystemIds: [firstRetired, secondRetired], sequence: 7 }),
    ] });
    const failure = new Error('remove failed');
    const exclusiveGate = {
      runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
    };
    let calls = 0;
    const input = {
      exclusiveGate,
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      runtime: {
        createControlPhysical: () => physical,
        inspectPlainEndpoint: async () => 'fully_verified' as const,
        removeRetiredContainer: async () => {
          calls += 1;
          if (calls === 2) throw failure;
        },
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    };

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input))
      .rejects.toBe(failure);
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([secondRetired]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([secondRetired]);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input))
      .resolves.toBeUndefined();
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('retries the same exact retired ID after deletion succeeds but publication commits nothing', async () => {
    const retired = testFileSystemId({ value: 'BCDEFGHIJK_LMNOPQRSTU' });
    const failure = new Error('publication failed before commit');
    const physical = new FaultInjectingMutablePhysical({
      controls: [
        await plainControl({ copy: 0, retiredFileSystemIds: [retired], sequence: 14 }),
        await plainControl({ copy: 1, retiredFileSystemIds: [retired], sequence: 13 }),
      ],
      failure,
      fault: 'before_first_publish',
    });
    const removed: ReturnType<typeof testFileSystemId>[] = [];
    const input = {
      exclusiveGate: {
        runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
      },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      runtime: {
        createControlPhysical: () => physical,
        inspectPlainEndpoint: async () => 'fully_verified' as const,
        removeRetiredContainer: async ({ fileSystemId }: { fileSystemId: ReturnType<typeof testFileSystemId> }) => {
          removed.push(fileSystemId);
        },
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    };

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input)).rejects.toMatchObject({
      code: 'authority_commit_failed',
    });
    expect(removed).toEqual([retired]);
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([retired]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([retired]);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input)).resolves.toBeUndefined();
    expect(removed).toEqual([retired, retired]);
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('does not delete the retired ID again after first-copy commit response loss', async () => {
    const retired = testFileSystemId({ value: 'CDEFGHIJKL_MNOPQRSTUV' });
    const failure = new Error('publication response lost after first copy');
    const physical = new FaultInjectingMutablePhysical({
      controls: [
        await plainControl({ copy: 0, retiredFileSystemIds: [retired], sequence: 18 }),
        await plainControl({ copy: 1, retiredFileSystemIds: [retired], sequence: 17 }),
      ],
      failure,
      fault: 'after_first_publish',
    });
    const removed: ReturnType<typeof testFileSystemId>[] = [];
    const input = {
      exclusiveGate: {
        runExclusive: async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => await operation(),
      },
      nativeNamespaceRoot: {} as FileSystemDirectoryHandle,
      runtime: {
        createControlPhysical: () => physical,
        inspectPlainEndpoint: async () => 'fully_verified' as const,
        removeRetiredContainer: async ({ fileSystemId }: { fileSystemId: ReturnType<typeof testFileSystemId> }) => {
          removed.push(fileSystemId);
        },
      },
      storageRoot: {} as FileSystemDirectoryHandle,
    };

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input)).rejects.toMatchObject({
      code: 'authority_commit_failed',
    });
    expect(removed).toEqual([retired]);
    expect(physical.controls.map(control => control?.retiredFileSystemIds)).toContainEqual([]);
    expect(physical.controls.map(control => control?.retiredFileSystemIds)).toContainEqual([retired]);

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.runNativeStablePlainRetiredCleanupWith(input)).resolves.toBeUndefined();
    expect(removed).toEqual([retired]);
    expect(physical.controls[0]?.retiredFileSystemIds).toEqual([]);
    expect(physical.controls[1]?.retiredFileSystemIds).toEqual([]);
  });

  it('closes a transient session that does not match the converged encrypted authority', async () => {
    const convergedFileSystemId = testFileSystemId({ value: 'DEFGHIJKLM_NOPQRSTUVW' });
    const reopenedFileSystemId = testFileSystemId({ value: 'EFGHIJKLMN_OPQRSTUVWX' });
    const close = vi.fn(async () => undefined);
    const gracefullyShutdownRuntime = vi.fn(async () => undefined);
    const runDisable = vi.fn();

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.completeNativeHizoFSReturnToPlainWith({
      opened: {
        authoritativeEndpoint: { fileSystemId: reopenedFileSystemId, type: 'hizofs' },
        fileSystemId: reopenedFileSystemId,
        fileSystemSession: testFileSystemSession({ close }),
        gracefullyShutdownRuntime,
      },
      convergedFileSystemId,
      runDisable,
    })).rejects.toThrow('return-to-plain reopened a different encrypted authority');

    expect(close).toHaveBeenCalledOnce();
    expect(gracefullyShutdownRuntime).toHaveBeenCalledOnce();
    expect(runDisable).not.toHaveBeenCalled();
  });

  it('preserves authority rejection when closing a mismatched reopened session also fails', async () => {
    const convergedFileSystemId = testFileSystemId({ value: 'FGHIJKLMNO_PQRSTUVWXY' });
    const reopenedFileSystemId = testFileSystemId({ value: 'GHIJKLMNOP_QRSTUVWXYZ' });
    const closeFailure = new Error('close failed');

    const result = PRODUCTION_RUNTIME_TEST_ONLY.completeNativeHizoFSReturnToPlainWith({
      opened: {
        authoritativeEndpoint: { fileSystemId: reopenedFileSystemId, type: 'hizofs' },
        fileSystemId: reopenedFileSystemId,
        fileSystemSession: testFileSystemSession({
          close: async () => {
            throw closeFailure;
          },
        }),
        gracefullyShutdownRuntime: vi.fn(async () => undefined),
      },
      convergedFileSystemId,
      runDisable: vi.fn(),
    });

    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [expect.any(TypeError), closeFailure] });
  });

  it('closes the transient encrypted session exactly once after disable failure', async () => {
    const fileSystemId = testFileSystemId({ value: 'HIJKLMNOP_QRSTUVWXYZ0' });
    const close = vi.fn(async () => undefined);
    const disableFailure = new Error('disable failed');

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.completeNativeHizoFSReturnToPlainWith({
      opened: {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' },
        fileSystemId,
        fileSystemSession: testFileSystemSession({ close }),
        gracefullyShutdownRuntime: vi.fn(async () => undefined),
      },
      convergedFileSystemId: fileSystemId,
      runDisable: async ({ session }) => {
        await session.close();
        throw disableFailure;
      },
    })).rejects.toBe(disableFailure);

    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves disable and encrypted-session cleanup failures together', async () => {
    const fileSystemId = testFileSystemId({ value: 'IJKLMNOPQ_RSTUVWXYZ01' });
    const disableFailure = new Error('disable failed');
    const closeFailure = new Error('close failed');
    const result = PRODUCTION_RUNTIME_TEST_ONLY.completeNativeHizoFSReturnToPlainWith({
      opened: {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' },
        fileSystemId,
        fileSystemSession: testFileSystemSession({
          close: async () => {
            throw closeFailure;
          },
        }),
        gracefullyShutdownRuntime: vi.fn(async () => undefined),
      },
      convergedFileSystemId: fileSystemId,
      runDisable: async () => {
        throw disableFailure;
      },
    });

    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [disableFailure, closeFailure] });
  });

  it('does not construct a post-transition application session after successful disable', async () => {
    const fileSystemId = testFileSystemId({ value: 'JKLMNOPQR_STUVWXYZ012' });
    const close = vi.fn(async () => undefined);
    const gracefullyShutdownRuntime = vi.fn(async () => undefined);
    await expect(PRODUCTION_RUNTIME_TEST_ONLY.completeNativeHizoFSReturnToPlainWith({
      opened: {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' },
        fileSystemId,
        fileSystemSession: testFileSystemSession({ close }),
        gracefullyShutdownRuntime,
      },
      convergedFileSystemId: fileSystemId,
      runDisable: async ({ session }) => await session.close(),
    })).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
    expect(gracefullyShutdownRuntime).toHaveBeenCalledOnce();
  });


  it('rejects changed decrypt bindings without reopening a source session', () => {
    const building = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000001',
      targetFileSystemId: undefined,
    }).control;
    const changed = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000002',
      targetFileSystemId: undefined,
    }).control;
    const binding = PRODUCTION_RUNTIME_TEST_ONLY.nativeDecryptTransitionBinding({ control: building });

    expect(PRODUCTION_RUNTIME_TEST_ONLY.sameNativeDecryptTransition({
      actual: { mode: changed.mode, retiredFileSystemIds: changed.retiredFileSystemIds },
      binding,
    })).toBe(false);
  });

  it('does not delete plain bytes when the authenticated convergence binding changed', async () => {
    const authenticated = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000001',
      targetFileSystemId: undefined,
    }).control;
    const changed = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000002',
      targetFileSystemId: undefined,
    }).control;
    const authority = PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control: authenticated,
      fileSystemId: testFileSystemId({ value: 'disableSource0000001' }),
    });
    const removeEntry = vi.fn(async () => undefined);
    const getDirectoryHandle = vi.fn(async () => ({
      keys: async function* () {
        yield 'settings.json';
      },
      removeEntry,
    }) as unknown as FileSystemDirectoryHandle);
    const lockManager = {
      request: async <T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>): Promise<T> => (
        await callback({ mode: 'exclusive', name } as Lock)
      ),
    } as LockManager;

    await expect(PRODUCTION_RUNTIME_TEST_ONLY.convergeNativePersistenceTransition({
      authority,
      control: {
        publishState: vi.fn(async () => undefined),
        readState: async () => ({
          mode: changed.mode,
          retiredFileSystemIds: changed.retiredFileSystemIds,
        }),
      },
      expectedPhase: 'building_target',
      lockManager,
      nativeNamespaceRoot: { getDirectoryHandle } as unknown as FileSystemDirectoryHandle,
      signal: undefined,
    })).rejects.toThrow('changed after convergence credential proof');
    expect(getDirectoryHandle).not.toHaveBeenCalled();
    expect(removeEntry).not.toHaveBeenCalled();
  });

  it('rejects a convergence credential proven by the wrong decrypt endpoint', () => {
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'disableSource0000001',
      targetFileSystemId: undefined,
    }).control;

    expect(() => PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control,
      fileSystemId: testFileSystemId({ value: 'disableSource0000002' }),
    })).toThrow('another native disable source');
  });

  it('derives decrypt convergence from Persistence Control without work-progress input', () => {
    const sourceFileSystemId = testFileSystemId({ value: 'disableSource0000001' });
    const control = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'cleaning_up_source',
      sourceFileSystemId,
      targetFileSystemId: undefined,
    }).control;

    expect(PRODUCTION_RUNTIME_TEST_ONLY.nativeConvergenceAuthority({
      control,
      fileSystemId: sourceFileSystemId,
    })).toMatchObject({
      fileSystemId: sourceFileSystemId,
      operation: 'decrypt',
      phase: 'cleaning_up_source',
    });
  });
});
