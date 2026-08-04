import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
  OpfsDevelopmentCredentialRejectedError,
} from '@/00-storage/service/naidan-opfs/development-persistence-runtime';
import { listNativePlainApplicationNamespaceEntryNames } from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import { TEST_ONLY as RETIRED_PROGRESS_TEST_ONLY } from '@/00-storage/service/naidan-opfs/retired-local-transition-progress-cleanup';
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import type { OpfsSpecialFileSystemType } from '@/00-storage/service/opfs/opfs-special-file-system';
import {
  createInMemoryOpfsStorageManager,
  InMemoryOpfsDirectoryHandle,
  type InMemoryOpfsFaultHooks,
} from '@/00-storage/service/test-support/in-memory-opfs';
import { InMemoryWebLockManager } from '@/00-storage/service/test-support/in-memory-web-locks';

const PASSPHRASE = 'correct horse battery staple';

function settings({ endpointUrl }: { endpointUrl: string }): Settings {
  return {
    endpoint: { type: 'openai', url: endpointUrl },
    mounts: [],
    providerProfiles: [],
    storageType: 'opfs',
    titleGeneration: {
      endpoint: 'same_scope',
      lmParameters: {
        frequencyPenalty: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        reasoning: { effort: undefined },
        stop: undefined,
        temperature: undefined,
        topP: undefined,
      },
      model: 'same_scope',
    },
  };
}

async function listEntryNames({ directory }: {
  directory: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const names: string[] = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names.toSorted();
}

function containerEntryNames({ entries }: { entries: readonly string[] }): readonly string[] {
  const persistenceControlDirectoryName =
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;
  return entries.filter(name => name !== persistenceControlDirectoryName);
}

const MANAGED_SPECIAL_FILE_CASES = [
  { bytes: Uint8Array.of(71, 72), type: 'chat_wesh' },
  { bytes: Uint8Array.of(81, 82, 83), type: 'debug_wesh' },
  { bytes: Uint8Array.of(91, 92, 93, 94), type: 'tmp' },
] as const satisfies readonly Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  type: OpfsSpecialFileSystemType;
}>[];

async function openEncryptedManagedRoot({ create, provider, type }: {
  create: boolean;
  provider: OPFSStorageProvider;
  type: OpfsSpecialFileSystemType;
}) {
  const access = await provider.openSpecialFileSystemDirectory({
    create,
    path: '/',
    type,
  });
  if (access?.type !== 'storage_directory') {
    throw new Error('Expected encrypted managed root storage directory');
  }
  return access.handle;
}

async function writeEncryptedManagedRootFile({ bytes, provider, type }: {
  bytes: Uint8Array<ArrayBuffer>;
  provider: OPFSStorageProvider;
  type: OpfsSpecialFileSystemType;
}): Promise<void> {
  const directory = await openEncryptedManagedRoot({ create: true, provider, type });
  const file = await directory.getFileHandle({ create: true, name: 'transition-value.bin' });
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write({ data: bytes, position: 0 });
  await writable.close();
}

async function readEncryptedManagedRootFile({ provider, type }: {
  provider: OPFSStorageProvider;
  type: OpfsSpecialFileSystemType;
}): Promise<Uint8Array<ArrayBuffer>> {
  const directory = await openEncryptedManagedRoot({ create: false, provider, type });
  const file = await directory.getFileHandle({ create: false, name: 'transition-value.bin' });
  const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
  try {
    return new Uint8Array(await new Response(readable.stream({
      end: undefined,
      signal: undefined,
      start: 0,
    })).arrayBuffer());
  } finally {
    await readable.close();
  }
}

async function expectNoPersistentTransitionProgress({ storageRoot }: {
  storageRoot: FileSystemDirectoryHandle;
}): Promise<void> {
  const collection = await storageRoot.getDirectoryHandle(
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName,
    { create: false },
  );
  await expect(collection.getDirectoryHandle(
    RETIRED_PROGRESS_TEST_ONLY.directoryName,
    { create: false },
  )).rejects.toMatchObject({ name: 'NotFoundError' });
}

function installBrowserlessSystem({
  capabilityProfile,
  faultHooks,
}: {
  capabilityProfile: 'window' | 'worker';
  faultHooks: InMemoryOpfsFaultHooks | undefined;
}): Readonly<{
  root: InMemoryOpfsDirectoryHandle;
  uninstallRuntime: () => void;
}> {
  const root = new InMemoryOpfsDirectoryHandle({
    capabilityProfile,
    faultHooks,
    name: 'opfs-root',
  });
  const locks = new InMemoryWebLockManager();
  vi.stubGlobal('navigator', {
    locks,
    storage: createInMemoryOpfsStorageManager({ root }),
  });
  return {
    root,
    uninstallRuntime: installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    }),
  };
}

async function createEncryptedProvider({ endpointUrl, root }: {
  endpointUrl: string;
  root: InMemoryOpfsDirectoryHandle;
}): Promise<OPFSStorageProvider> {
  const plain = new OPFSStorageProvider();
  await plain.init();
  await plain.saveSettings({ settings: settings({ endpointUrl }) });
  await plain.enableEncryption({
    onProgress: undefined,
    passphrase: PASSPHRASE,
    signal: undefined,
  });

  const encrypted = new OPFSStorageProvider();
  await encrypted.unlockWithPassphrase({ passphrase: PASSPHRASE });
  await vi.waitFor(async () => {
    await expect(listNativePlainApplicationNamespaceEntryNames({
      nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
    })).resolves.toEqual([]);
  });
  return encrypted;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserless production HizoFS re-encrypt system', () => {
  it('rotates to a fresh container, retains the credential, writes, reopens, and removes the source', async () => {
    const { root, uninstallRuntime } = installBrowserlessSystem({
      capabilityProfile: 'window',
      faultHooks: undefined,
    });

    try {
      const encryptedSource = await createEncryptedProvider({
        endpointUrl: 'http://plain-before-enable',
        root,
      });
      await encryptedSource.saveSettings({
        settings: settings({ endpointUrl: 'http://encrypted-before-reencrypt' }),
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encryptedSource, type });
      }

      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const [sourceContainerName, ...unexpectedSourceContainers] = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(sourceContainerName).toBeDefined();
      expect(unexpectedSourceContainers).toEqual([]);

      const progressPhases: string[] = [];
      await encryptedSource.reencrypt({
        onProgress: ({ progress }) => {
          progressPhases.push(progress.phase);
        },
        retainedCredentials: [{ passphrase: PASSPHRASE }],
        signal: undefined,
      });
      await expectNoPersistentTransitionProgress({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });

      const targetAfterReload = new OPFSStorageProvider();
      await expect(targetAfterReload.inspectEncryption()).resolves.toMatchObject({
        type: 'credential_required',
      });
      await targetAfterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await targetAfterReload.loadSettings()).toMatchObject({
        endpoint: { url: 'http://encrypted-before-reencrypt' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: targetAfterReload, type })).resolves.toEqual(bytes);
      }
      await targetAfterReload.saveSettings({
        settings: settings({ endpointUrl: 'http://encrypted-after-reencrypt' }),
      });

      await vi.waitFor(async () => {
        const [targetContainerName, ...unexpectedTargetContainers] = containerEntryNames({
          entries: await listEntryNames({
            directory: storageRoot as unknown as FileSystemDirectoryHandle,
          }),
        });
        expect(targetContainerName).toBeDefined();
        expect(targetContainerName).not.toBe(sourceContainerName);
        expect(unexpectedTargetContainers).toEqual([]);
      });
      await targetAfterReload.dispose();

      const targetSecondReload = new OPFSStorageProvider();
      await targetSecondReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await targetSecondReload.loadSettings()).toMatchObject({
        endpoint: { url: 'http://encrypted-after-reencrypt' },
      });
      await targetSecondReload.dispose();

      expect(progressPhases).toContain('verifying');
      expect(progressPhases).toContain('cleaning_source');
      expect(progressPhases.at(-1)).toBe('finalizing');
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it('converges to the source after pre-switch interruption and retries from a fresh target', async () => {
    const { root, uninstallRuntime } = installBrowserlessSystem({
      capabilityProfile: 'window',
      faultHooks: undefined,
    });
    const controller = new AbortController();
    let interruptedDuringVerification = false;

    try {
      const encryptedSource = await createEncryptedProvider({
        endpointUrl: 'http://reencrypt-source-before-interruption',
        root,
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encryptedSource, type });
      }
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const [sourceContainerName, ...unexpectedSourceContainers] = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(sourceContainerName).toBeDefined();
      expect(unexpectedSourceContainers).toEqual([]);

      await expect(encryptedSource.reencrypt({
        onProgress: ({ progress }) => {
          if (progress.phase !== 'verifying' || interruptedDuringVerification) return;
          interruptedDuringVerification = true;
          controller.abort();
        },
        retainedCredentials: [{ passphrase: PASSPHRASE }],
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(interruptedDuringVerification).toBe(true);

      const interruptedContainers = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(interruptedContainers).toHaveLength(2);
      expect(interruptedContainers).toContain(sourceContainerName);
      const abandonedTargetName = interruptedContainers.find(name => name !== sourceContainerName);
      expect(abandonedTargetName).toBeDefined();

      const recovery = new OPFSStorageProvider();
      await expect(recovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: 'converge_transition',
        type: 'credential_required',
      });
      await recovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const sourceAfterRestart = new OPFSStorageProvider();
      await sourceAfterRestart.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(sourceAfterRestart.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://reencrypt-source-before-interruption' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: sourceAfterRestart, type })).resolves.toEqual(bytes);
      }
      await vi.waitFor(async () => {
        expect(containerEntryNames({
          entries: await listEntryNames({
            directory: storageRoot as unknown as FileSystemDirectoryHandle,
          }),
        })).toEqual([sourceContainerName]);
      });

      await sourceAfterRestart.reencrypt({
        onProgress: undefined,
        retainedCredentials: [{ passphrase: PASSPHRASE }],
        signal: undefined,
      });
      const targetAfterRetry = new OPFSStorageProvider();
      await targetAfterRetry.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(targetAfterRetry.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://reencrypt-source-before-interruption' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: targetAfterRetry, type })).resolves.toEqual(bytes);
      }
      await vi.waitFor(async () => {
        const [targetContainerName, ...unexpectedTargetContainers] = containerEntryNames({
          entries: await listEntryNames({
            directory: storageRoot as unknown as FileSystemDirectoryHandle,
          }),
        });
        expect(targetContainerName).toBeDefined();
        expect(targetContainerName).not.toBe(sourceContainerName);
        expect(targetContainerName).not.toBe(abandonedTargetName);
        expect(unexpectedTargetContainers).toEqual([]);
      });
      await expectNoPersistentTransitionProgress({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });
      await targetAfterRetry.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it('converges to the target and retries retired cleanup after post-switch interruption', async () => {
    const { root, uninstallRuntime } = installBrowserlessSystem({
      capabilityProfile: 'window',
      faultHooks: undefined,
    });
    const controller = new AbortController();
    let interruptedAfterAuthoritySwitch = false;

    try {
      const encryptedSource = await createEncryptedProvider({
        endpointUrl: 'http://reencrypt-target-after-post-switch-interruption',
        root,
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encryptedSource, type });
      }
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const [sourceContainerName, ...unexpectedSourceContainers] = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(sourceContainerName).toBeDefined();
      expect(unexpectedSourceContainers).toEqual([]);

      await expect(encryptedSource.reencrypt({
        onProgress: ({ progress }) => {
          if (progress.phase !== 'cleaning_source' || interruptedAfterAuthoritySwitch) return;
          interruptedAfterAuthoritySwitch = true;
          controller.abort(new DOMException('planned post-switch interruption', 'AbortError'));
        },
        retainedCredentials: [{ passphrase: PASSPHRASE }],
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(interruptedAfterAuthoritySwitch).toBe(true);
      expect(containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      })).toHaveLength(2);

      const recovery = new OPFSStorageProvider();
      await expect(recovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: 'converge_transition',
        type: 'credential_required',
      });
      await recovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const targetAfterReload = new OPFSStorageProvider();
      await targetAfterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(targetAfterReload.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://reencrypt-target-after-post-switch-interruption' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: targetAfterReload, type })).resolves.toEqual(bytes);
      }
      await vi.waitFor(async () => {
        const [targetContainerName, ...unexpectedTargetContainers] = containerEntryNames({
          entries: await listEntryNames({
            directory: storageRoot as unknown as FileSystemDirectoryHandle,
          }),
        });
        expect(targetContainerName).toBeDefined();
        expect(targetContainerName).not.toBe(sourceContainerName);
        expect(unexpectedTargetContainers).toEqual([]);
      });
      await expectNoPersistentTransitionProgress({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });
      await targetAfterReload.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);

  it('converges to the target after authority-switch response loss and retries retired-source cleanup', async () => {
    const responseLoss = new DOMException('authority publication response lost', 'UnknownError');
    const cleanupFailure = new DOMException('retired source cleanup failed', 'NoModificationAllowedError');
    let armAuthorityResponseLoss = false;
    let authorityResponseLost = false;
    let failRetiredSourceCleanup = false;
    let retiredSourceContainerName: string | undefined;
    let cleanupFaultCount = 0;
    const persistenceControlDirectoryName =
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;
    const [controlFile0, controlFile1] =
      NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.controlFiles;
    const { root, uninstallRuntime } = installBrowserlessSystem({
      capabilityProfile: 'window',
      faultHooks: {
        afterWritableStreamClose: async ({ directoryName, name }) => {
          if (!armAuthorityResponseLoss
            || authorityResponseLost
            || directoryName !== persistenceControlDirectoryName
            || (name !== controlFile0 && name !== controlFile1)) return;
          authorityResponseLost = true;
          throw responseLoss;
        },
        beforeRemoveEntry: async ({ name }) => {
          if (!failRetiredSourceCleanup || name !== retiredSourceContainerName) return;
          cleanupFaultCount += 1;
          throw cleanupFailure;
        },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const encryptedSource = await createEncryptedProvider({
        endpointUrl: 'http://reencrypt-before-authority-response-loss',
        root,
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await writeEncryptedManagedRootFile({ bytes, provider: encryptedSource, type });
      }
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      [retiredSourceContainerName] = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(retiredSourceContainerName).toBeDefined();

      await expect(encryptedSource.reencrypt({
        onProgress: ({ progress }) => {
          if (progress.phase === 'verifying') armAuthorityResponseLoss = true;
        },
        retainedCredentials: [{ passphrase: PASSPHRASE }],
        signal: undefined,
      })).rejects.toMatchObject({ code: 'authority_commit_failed' });
      expect(authorityResponseLost).toBe(true);
      const containersAfterResponseLoss = containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      });
      expect(containersAfterResponseLoss).toHaveLength(2);
      expect(containersAfterResponseLoss).toContain(retiredSourceContainerName);
      const activeTargetContainerName = containersAfterResponseLoss.find(
        name => name !== retiredSourceContainerName,
      );
      expect(activeTargetContainerName).toBeDefined();

      const recovery = new OPFSStorageProvider();
      await expect(recovery.inspectEncryption()).resolves.toMatchObject({
        requiredAction: 'converge_transition',
        type: 'credential_required',
      });
      await recovery.convergeTransitionWithPassphrase({
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      failRetiredSourceCleanup = true;
      const targetWithDeferredCleanup = new OPFSStorageProvider();
      await targetWithDeferredCleanup.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await expect(targetWithDeferredCleanup.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://reencrypt-before-authority-response-loss' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: targetWithDeferredCleanup, type })).resolves.toEqual(bytes);
      }
      await targetWithDeferredCleanup.saveSettings({
        settings: settings({ endpointUrl: 'http://reencrypt-target-after-cleanup-failure' }),
      });
      await vi.waitFor(() => {
        expect(cleanupFaultCount).toBeGreaterThan(0);
      });
      expect(containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      })).toEqual(containersAfterResponseLoss);
      await targetWithDeferredCleanup.dispose();

      failRetiredSourceCleanup = false;
      const targetAfterCleanupRetry = new OPFSStorageProvider();
      await targetAfterCleanupRetry.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await vi.waitFor(async () => {
        expect(containerEntryNames({
          entries: await listEntryNames({
            directory: storageRoot as unknown as FileSystemDirectoryHandle,
          }),
        })).toEqual([activeTargetContainerName]);
      });
      await expect(targetAfterCleanupRetry.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://reencrypt-target-after-cleanup-failure' },
      });
      for (const { bytes, type } of MANAGED_SPECIAL_FILE_CASES) {
        await expect(readEncryptedManagedRootFile({ provider: targetAfterCleanupRetry, type })).resolves.toEqual(bytes);
      }
      await targetAfterCleanupRetry.dispose();

      const rejectedForeignCredential = new OPFSStorageProvider();
      await expect(rejectedForeignCredential.unlockWithPassphrase({
        passphrase: 'foreign passphrase',
      })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);
      expect(containerEntryNames({
        entries: await listEntryNames({
          directory: storageRoot as unknown as FileSystemDirectoryHandle,
        }),
      })).toEqual([activeTargetContainerName]);
      expect(error).toHaveBeenCalledWith(
        '[opfs-encryption] unlocked persistence maintenance failed',
        cleanupFailure,
      );
    } finally {
      error.mockRestore();
      uninstallRuntime();
    }
  }, 60_000);
});
