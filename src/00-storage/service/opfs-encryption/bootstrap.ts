import type { OpfsEncryptionStateDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import {
  openHizoFS,
  deriveHizoFSFileSystemIdFromRawRootKey,
} from '@/00-storage/service/hizofs';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import {
  unlockStorageUnlockKeyWithPassphrase,
  unwrapFileSystemRootKey,
} from './encryption-key-manager';
import { EncryptionStateStore } from './encryption-state-store';
import type { UnlockedOpfsEncryptionSession } from './session';

export type OpfsEncryptionInspection =
  | { type: 'plain' }
  | {
      type: 'encrypted';
      state: Extract<OpfsEncryptionStateDto, { state: 'encrypted' }>;
    }
  | {
      type: 'transitioning';
      state: Extract<OpfsEncryptionStateDto, { state: 'transitioning' }>;
      operation: Extract<
        OpfsEncryptionStateDto,
        { state: 'transitioning' }
      >['operation'];
    }
  | { type: 'recovery_required'; error: unknown };

export async function inspectOpfsEncryption({
  storageRoot,
}: {
  storageRoot: FileSystemDirectoryHandle;
}): Promise<OpfsEncryptionInspection> {
  const inspection = await new EncryptionStateStore({ storageRoot }).inspect();
  switch (inspection.type) {
  case 'plain':
    return inspection;
  case 'invalid':
    return { type: 'recovery_required', error: inspection.error };
  case 'encrypted': {
    const { state } = inspection;
    switch (state.state) {
    case 'encrypted':
      return { type: 'encrypted', state };
    case 'transitioning':
      return { type: 'transitioning', state, operation: state.operation };
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled encryption state: ${String(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = inspection;
    throw new Error(`Unhandled encryption inspection: ${String(_ex)}`);
  }
  }
}

export async function createUnlockedOpfsEncryptionSession({
  storageRoot,
  state,
  storageUnlockKey,
  unlockedKeySlotId,
}: {
  storageRoot: FileSystemDirectoryHandle;
  state: Extract<OpfsEncryptionStateDto, { state: 'encrypted' }>;
  storageUnlockKey: Uint8Array;
  unlockedKeySlotId: string;
}): Promise<UnlockedOpfsEncryptionSession> {
  const headerStore = new EncryptedStoreHeaderStore({ storageRoot });
  const header = await headerStore.read({
    encryptedStoreId: state.activeEncryptedStoreId,
  });
  if (header === undefined) {
    throw new Error('Active encrypted store has no valid header');
  }
  if (header.encryptedStoreId !== state.activeEncryptedStoreId) {
    throw new Error('Encrypted store header ID does not match active state');
  }

  const fileSystemRootKey = await unwrapFileSystemRootKey({
    storageUnlockKey,
    header,
  });
  try {
    const backingDirectory = await headerStore.getHizoFSBackingDirectory({
      encryptedStoreId: state.activeEncryptedStoreId,
      create: false,
    });
    const fileSystemId = await deriveHizoFSFileSystemIdFromRawRootKey({
      fileSystemRootKey,
    });
    if (fileSystemId !== header.fileSystemId) {
      throw new Error('Encrypted store header file system ID does not match the HizoFS root key');
    }
    const fileSystemSession = await openHizoFS({
      backingDirectory,
      fileSystemRootKey,
    });
    const backend = new NaidanOpfsStorageBackend({
      namespaceRoot: fileSystemSession.root,
      hostVolumeDB: new HostVolumeDB(),
    });
    try {
      await backend.init();
    } catch (error) {
      await fileSystemSession.close();
      throw error;
    }
    return {
      state,
      storageUnlockKey,
      unlockedKeySlotId,
      fileSystemSession,
      backend,
    };
  } finally {
    fileSystemRootKey.fill(0);
  }
}

export async function unlockOpfsEncryptionWithPassphrase({
  storageRoot,
  state,
  passphrase,
}: {
  storageRoot: FileSystemDirectoryHandle;
  state: Extract<OpfsEncryptionStateDto, { state: 'encrypted' }>;
  passphrase: string;
}): Promise<UnlockedOpfsEncryptionSession> {
  const { storageUnlockKey, keySlotId } = await unlockStorageUnlockKeyWithPassphrase({
    keySlots: state.keySlots,
    passphrase,
  });
  try {
    return await createUnlockedOpfsEncryptionSession({
      storageRoot,
      state,
      storageUnlockKey,
      unlockedKeySlotId: keySlotId,
    });
  } catch (error) {
    storageUnlockKey.fill(0);
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
