import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
  OpfsDevelopmentCredentialRejectedError,
} from '@/00-storage/service/naidan-opfs/development-persistence-runtime';
import { listNativePlainApplicationNamespaceEntryNames } from '@/00-storage/service/naidan-opfs/native-plain-application-namespace';
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

const OLD_PASSPHRASE = 'old correct horse battery staple';
const NEW_PASSPHRASE = 'new correct horse battery staple';

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

async function listContainerNames({ storageRoot }: {
  storageRoot: FileSystemDirectoryHandle;
}): Promise<readonly string[]> {
  const names: string[] = [];
  const persistenceControlDirectoryName =
    NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;
  for await (const [name] of storageRoot.entries()) {
    if (name !== persistenceControlDirectoryName) names.push(name);
  }
  return names.toSorted();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserless production HizoFS passphrase lifecycle', () => {
  it('resolves final-copy response loss, keeps the active session, and reopens only with the replacement', async () => {
    const responseLoss = new DOMException('credential publication response lost', 'UnknownError');
    let injectCredentialResponseLoss = false;
    let credentialPublicationFlushCount = 0;
    let credentialResponseLost = false;
    const root = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: 'worker',
      faultHooks: {
        afterSyncAccessHandleFlush: () => {
          if (!injectCredentialResponseLoss || credentialResponseLost) return;
          credentialPublicationFlushCount += 1;
          if (credentialPublicationFlushCount !== 4) return;
          credentialResponseLost = true;
          throw responseLoss;
        },
      },
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
        settings: settings({ endpointUrl: 'http://before-passphrase-change' }),
      });
      await plain.enableEncryption({
        onProgress: undefined,
        passphrase: OLD_PASSPHRASE,
        signal: undefined,
      });

      const encrypted = new OPFSStorageProvider();
      await encrypted.unlockWithPassphrase({ passphrase: OLD_PASSPHRASE });
      await vi.waitFor(async () => {
        await expect(listNativePlainApplicationNamespaceEntryNames({
          nativeNamespaceRoot: root as unknown as FileSystemDirectoryHandle,
        })).resolves.toEqual([]);
      });
      const storageRoot = await root.getDirectoryHandle(
        NAIDAN_OPFS_STORAGE_DIRECTORY_NAME,
        { create: false },
      );
      const containerNamesBefore = await listContainerNames({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      });
      expect(containerNamesBefore).toHaveLength(1);

      injectCredentialResponseLoss = true;
      await expect(encrypted.changePassphrase({
        passphrase: NEW_PASSPHRASE,
      })).resolves.toBeUndefined();
      expect(credentialResponseLost).toBe(true);
      expect(credentialPublicationFlushCount).toBe(4);
      await expect(encrypted.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://before-passphrase-change' },
      });
      await encrypted.saveSettings({
        settings: settings({ endpointUrl: 'http://after-passphrase-change' }),
      });
      await expect(listContainerNames({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual(containerNamesBefore);
      await encrypted.dispose();

      const oldCredential = new OPFSStorageProvider();
      await expect(oldCredential.unlockWithPassphrase({
        passphrase: OLD_PASSPHRASE,
      })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);

      const foreignCredential = new OPFSStorageProvider();
      await expect(foreignCredential.unlockWithPassphrase({
        passphrase: 'foreign credential',
      })).rejects.toBeInstanceOf(OpfsDevelopmentCredentialRejectedError);

      const reopened = new OPFSStorageProvider();
      await reopened.unlockWithPassphrase({ passphrase: NEW_PASSPHRASE });
      await expect(reopened.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://after-passphrase-change' },
      });
      await expect(listContainerNames({
        storageRoot: storageRoot as unknown as FileSystemDirectoryHandle,
      })).resolves.toEqual(containerNamesBefore);
      await reopened.dispose();

      const secondReopen = new OPFSStorageProvider();
      await secondReopen.unlockWithPassphrase({ passphrase: NEW_PASSPHRASE });
      await expect(secondReopen.loadSettings()).resolves.toMatchObject({
        endpoint: { url: 'http://after-passphrase-change' },
      });
      await secondReopen.dispose();
    } finally {
      uninstallRuntime();
    }
  }, 60_000);
});
