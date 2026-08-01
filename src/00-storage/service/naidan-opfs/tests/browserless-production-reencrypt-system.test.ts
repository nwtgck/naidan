import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
} from '@/00-storage/service/naidan-opfs/development-persistence-runtime';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from '@/00-storage/service/naidan-opfs/opfs-storage-location';
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import {
  createInMemoryOpfsStorageManager,
  InMemoryOpfsDirectoryHandle,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserless production HizoFS re-encrypt system', () => {
  it('rotates to a fresh container, retains the credential, writes, reopens, and removes the source', async () => {
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: 'window',
      name: 'opfs-root',
    });
    const locks = new InMemoryWebLockManager();
    vi.stubGlobal('navigator', {
      locks,
      storage: createInMemoryOpfsStorageManager({ root }),
    });
    const uninstallRuntime = installDevelopmentUnverifiedOpfsPersistenceRuntime({
      lockManager: locks,
    });

    try {
      const plain = new OPFSStorageProvider();
      await plain.init();
      await plain.saveSettings({
        settings: settings({ endpointUrl: 'http://plain-before-enable' }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: PASSPHRASE,
        signal: undefined,
      });

      const encryptedSource = new OPFSStorageProvider();
      await encryptedSource.unlockWithPassphrase({ passphrase: PASSPHRASE });
      await encryptedSource.saveSettings({
        settings: settings({ endpointUrl: 'http://encrypted-before-reencrypt' }),
      });

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

      const targetAfterReload = new OPFSStorageProvider();
      await expect(targetAfterReload.inspectEncryption()).resolves.toMatchObject({
        type: 'credential_required',
      });
      await targetAfterReload.unlockWithPassphrase({ passphrase: PASSPHRASE });
      expect(await targetAfterReload.loadSettings()).toMatchObject({
        endpoint: { url: 'http://encrypted-before-reencrypt' },
      });
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
});
