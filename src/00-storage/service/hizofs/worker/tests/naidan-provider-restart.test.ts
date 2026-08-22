import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY } from "@/00-storage/service/hizofs/runtime/runtime-policy";
import { createFeatureBits, createSubvolumeId, createTimestampMilliseconds } from '@/00-storage/service/hizofs/00-format';
import { createEmptyEncryptedContainer, openEmptyEncryptedContainer } from '@/00-storage/service/hizofs/authenticated-store/empty-container-store';
import type { AuthenticatedHizoFSPhysicalBytes } from '@/00-storage/service/hizofs/authenticated-store/physical-bytes';
import type { RandomByteSource } from '@/00-storage/service/hizofs/01-crypto';
import type {
  HizoFSDevelopmentWritableBackend,
  HizoFSPhysicalWriteBackend,
} from '@/00-storage/service/hizofs/physical-store/backend';
import { InMemoryCrashDurabilityBackend } from '@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend';
import { createContainerCoordinationScope, parseContainerCoordinationScopeToken } from '@/00-storage/service/hizofs/runtime/container-coordination-scope';
import { InMemoryCrossRealmLockPort } from '@/00-storage/service/hizofs/runtime/testing/in-memory-cross-realm-lock-port';
import { openAuthenticatedReadWriteApplicationSession } from '@/00-storage/service/hizofs/worker/composition-root';
import { HizoFSWorkerRuntimeHost } from '@/00-storage/service/hizofs/worker/runtime-host';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { TEST_ONLY as DEVELOPMENT_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/development-persistence-runtime';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  installOpfsPersistenceRuntimeFactory,
  TEST_ONLY as RUNTIME_REGISTRY_TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-registry';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { CapturedPersistenceControlAuthority } from '@/00-storage/service/naidan-persistence-control/store/persistence-control-authority-handshake';
import type { PersistenceControlReadablePhysicalPort } from '@/00-storage/service/naidan-persistence-control/store';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';

type DevelopmentRuntimeOptions = Parameters<
  typeof DEVELOPMENT_RUNTIME_TEST_ONLY.createDevelopmentOpfsPersistenceRuntimeWith
>[0];
type DevelopmentRuntimePort = DevelopmentRuntimeOptions['port'];

const PASSPHRASE = 'correct horse battery staple';
const SUPPORTED_FEATURE_BITS = createFeatureBits({ value: 0n });

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function developmentBackend({ backend }: {
  backend: HizoFSPhysicalWriteBackend<AuthenticatedHizoFSPhysicalBytes>;
}): HizoFSDevelopmentWritableBackend<AuthenticatedHizoFSPhysicalBytes> {
  return {
    capabilities: {
      directoryEntryDurability: 'not-demonstrated',
      fileDataDurability: 'not-demonstrated',
    },
    closeFile: async ({ file }) => await backend.closeFile({ file }),
    createDirectoryExclusive: async ({ path }) => await backend.createDirectoryExclusive({ path }),
    createFileExclusive: async ({ path }) => await backend.createFileExclusive({ path }),
    getFileSize: async ({ path }) => await backend.getFileSize({ path }),
    getOpenFileSize: async ({ file }) => await backend.getOpenFileSize({ file }),
    list: async ({ directory }) => await backend.list({ directory }),
    syncDirectoryEntries: async ({ parent }) => await backend.syncDirectoryEntries({ parent }),
    syncFileData: async ({ file }) => await backend.syncFileData({ file }),
    openFileForUpdate: async ({ path }) => await backend.openFileForUpdate({ path }),
    readExact: async ({ length, offset, path }) => await backend.readExact({ length, offset, path }),
    readExactWithFileSize: async ({ length, offset, path }) => (
      await backend.readExactWithFileSize({ length, offset, path })
    ),
    readFileBounded: async ({ maximumByteLength, path }) => (
      await backend.readFileBounded({ maximumByteLength, path })
    ),
    removeFile: async ({ path }) => await backend.removeFile({ path }),
    truncate: async ({ file, length }) => await backend.truncate({ file, length }),
    writeAt: async ({ bytes, file, offset }) => await backend.writeAt({ bytes, file, offset }),
  };
}

function runtimeHost(): HizoFSWorkerRuntimeHost {
  return new HizoFSWorkerRuntimeHost({
    crossRealmLockPort: new InMemoryCrossRealmLockPort(),
    policy: {
      lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
      maxDirectoryIteratorEntries: 4_096,
      maxHeldLockNames: 1_024,
      maxMaintenanceRootRegistrations: 1_024,
      maxReaderPins: 256,
      maxSegmentReferences: 4_096,
    },
    scope: createContainerCoordinationScope({
      token: parseContainerCoordinationScopeToken({
        value: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
      }),
    }),
  });
}

async function openApplicationSession({
  backend,
  operationTimestamp,
  passphrase,
  randomSource,
}: {
  backend: HizoFSPhysicalWriteBackend<AuthenticatedHizoFSPhysicalBytes>;
  operationTimestamp: () => bigint;
  passphrase: string;
  randomSource: RandomByteSource;
}): Promise<Readonly<{
  fileSystemSession: StorageFileSystemSession;
  runtimeHost: HizoFSWorkerRuntimeHost;
}>> {
  const opened = await openEmptyEncryptedContainer({
    backend,
    passphrase,
    supportedFeatureBits: SUPPORTED_FEATURE_BITS,
  });
  const host = runtimeHost();
  const fileSystemSession = await openAuthenticatedReadWriteApplicationSession({
    captureAuthority: async () => ({ revision: 1 }),
    recheckAuthority: async () => undefined,
    rootName: 'development.hizofs',
    runtimeHost: host,
    verifyCapturedAuthority: async () => ({
      backend: developmentBackend({ backend }),
      canonicalBackingLocation: 'development.hizofs',
      explicitBulkLimits: {
        candidate: { maxEntries: 100_000, maxInlineFileBytesTotal: 16 * 1024 * 1024 },
        directoryImport: { maximumEntryMutationsPerBatch: 64 },
      },

      fileMutationLimits: { maximumExtentMutationsPerBatch: 64 },
      opened,
      operationTimestamp: () => createTimestampMilliseconds({ value: operationTimestamp() }),
      randomSource,
      removalLimits: { deleteBatchSize: 64 },
      recheckDurableGenerationAuthority: async () => undefined,
      rootSubvolumeId: createSubvolumeId({ value: 1n }),
      supportedFeatureBits: SUPPORTED_FEATURE_BITS,
      writableProfile: 'development-unverified',
    }),
  });
  return { fileSystemSession, runtimeHost: host };
}

async function createTestRuntimePort({
  backend,
  fileSystemId,
  opfsRoot,
  randomSource,
}: {
  backend: HizoFSPhysicalWriteBackend<AuthenticatedHizoFSPhysicalBytes>;
  fileSystemId: Extract<
    Awaited<ReturnType<DevelopmentRuntimePort['openApplicationSession']>>,
    { readonly type: 'opened' }
  >['fileSystemId'];
  opfsRoot: FileSystemDirectoryHandle;
  randomSource: RandomByteSource;
}): Promise<DevelopmentRuntimePort> {
  let nextTimestamp = 1_700_000_000_000n;
  return {
    captureAuthority: async () => ({} as CapturedPersistenceControlAuthority),
    changeSessionPassphrase: async () => {
      throw new Error('passphrase change is not used by the restart fixture');
    },
    createBackend: async ({ fileSystemSession }) => {
      const applicationBackend = new NaidanOpfsStorageBackend({
        hostVolumeDB: new HostVolumeDB(),
        namespaceRoot: fileSystemSession.root,
      });
      await applicationBackend.init();
      return applicationBackend;
    },
    createPhysical: () => ({} as PersistenceControlReadablePhysicalPort),
    getNativeNamespaceRoot: async () => opfsRoot,
    inspect: async () => RUNTIME_CONTRACT_TEST_ONLY.createCredentialRequiredInspection({
      firstSequence: 1,
      secondSequence: 1,
    }),
    runConvergeTransition: async () => {
      throw new Error('converge transition is not used by the restart fixture');
    },
    runDisableTransition: async () => {
      throw new Error('disable transition is not used by the restart fixture');
    },
    runEnableTransition: async () => {
      throw new Error('enable transition is not used by the restart fixture');
    },
    runReencryptTransition: async () => {
      throw new Error('re-encrypt transition is not used by the restart fixture');
    },
    runReturnToPlainTransition: async () => {
      throw new Error('return-to-plain transition is not used by the restart fixture');
    },
    runStableHizoFSRetiredContainerCleanup: async () => {
      throw new Error('stable-HizoFS retired-container cleanup is not used by the restart fixture');
    },
    runStablePlainRetiredCleanup: async () => {
      throw new Error('stable-plain cleanup is not used by the restart fixture');
    },
    openApplicationSession: async ({ passphrase }) => {
      const { fileSystemSession, runtimeHost } = await openApplicationSession({
        backend,
        operationTimestamp: () => {
          const current = nextTimestamp;
          nextTimestamp += 1n;
          return current;
        },
        passphrase,
        randomSource,
      });
      return {
        authoritativeEndpoint: { fileSystemId, type: 'hizofs' },
        fileSystemId,
        fileSystemSession,
        gracefullyShutdownRuntime: async () => {
          const barrier = runtimeHost.openManagementCleanHeadBarrier({});
          await barrier.flushAndCaptureCleanGeneration();
          barrier.release();
          await fileSystemSession.close();
        },
        openManagementCleanHeadBarrier: () => {
          const barrier = runtimeHost.openManagementCleanHeadBarrier({});
          return {
            ensureCleanHead: async () => {
              await barrier.flushAndCaptureCleanGeneration();
            },
            release: barrier.release,
          };
        },
        selected: {} as never,
        type: 'opened',
      };
    },
  };
}

describe('development HizoFS normal provider restart', () => {
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
  const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
  const randomSource = deterministicRandomSource();
  let uninstallRuntime: (() => void) | undefined;

  beforeEach(async () => {
    RUNTIME_REGISTRY_TEST_ONLY.reset();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => opfsRoot },
    });
    const storageRoot = await opfsRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: true });
    await storageRoot.getDirectoryHandle(
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
      { create: true },
    );
    const created = await createEmptyEncryptedContainer({
      backend,
      passphrase: PASSPHRASE,
      randomSource,
      supportedFeatureBits: SUPPORTED_FEATURE_BITS,
    });
    const fileSystemId = created.fileSystemId;
    created.rootKey.destroy();
    const runtimePort = await createTestRuntimePort({
      backend,
      fileSystemId,
      opfsRoot,
      randomSource,
    });
    uninstallRuntime = installOpfsPersistenceRuntimeFactory({
      factory: async () => DEVELOPMENT_RUNTIME_TEST_ONLY.createDevelopmentOpfsPersistenceRuntimeWith({
        lockManager: {} as DevelopmentRuntimeOptions['lockManager'],
        port: runtimePort,
        runtimePolicy: {
          lazyDurability: DEFAULT_HIZOFS_LAZY_DURABILITY_POLICY,
          maxDirectoryIteratorEntries: 4_096,
          maxHeldLockNames: 1_024,
          maxMaintenanceRootRegistrations: 1_024,
          maxReaderPins: 256,
          maxSegmentReferences: 4_096,
        },
      }),
    });
  });

  afterEach(() => {
    uninstallRuntime?.();
    uninstallRuntime = undefined;
    RUNTIME_REGISTRY_TEST_ONLY.reset();
    vi.unstubAllGlobals();
  });

  it('creates, mutates, closes, restarts, and reopens through OPFSStorageProvider', async () => {
    const first = new OPFSStorageProvider();
    await expect(first.init()).rejects.toThrow('must be unlocked');
    await first.unlockWithPassphrase({ passphrase: PASSPHRASE });

    await first.saveHierarchy({ hierarchy: { items: [] } });
    await first.saveHierarchy({
      hierarchy: {
        items: [{ id: 'development-restart-chat', type: 'chat' }],
      },
    });
    await expect(first.loadHierarchy()).resolves.toEqual({
      items: [{ id: 'development-restart-chat', type: 'chat' }],
    });
    await first.dispose();

    const restarted = new OPFSStorageProvider();
    await expect(restarted.init()).rejects.toThrow('must be unlocked');
    await restarted.unlockWithPassphrase({ passphrase: PASSPHRASE });
    await expect(restarted.loadHierarchy()).resolves.toEqual({
      items: [{ id: 'development-restart-chat', type: 'chat' }],
    });
    await restarted.dispose();
  });
});
