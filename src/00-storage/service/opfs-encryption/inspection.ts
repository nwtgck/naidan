import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import {
  inspectEncryptedOpfs,
  type EncryptedOpfsInspection,
} from '@/00-storage/service/encrypted-opfs';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import { unwrapFileSystemRootKey } from './encryption-key-manager';
import type { UnlockedOpfsEncryptionSession } from './session';

export interface EncryptedStorageDebugSession {
  readonly state: Extract<OpfsEncryptionStateDto, { readonly state: 'encrypted' }>;
  readonly header: OpfsEncryptedStoreHeaderDto;
  readonly encryptedOpfs: EncryptedOpfsInspection;
  readonly decryptedRoot: StorageDirectoryHandle;
  readonly physicalPath: readonly string[];
}

export async function createEncryptedStorageDebugSession({
  storageRoot,
  session,
}: {
  storageRoot: FileSystemDirectoryHandle;
  session: UnlockedOpfsEncryptionSession;
}): Promise<EncryptedStorageDebugSession> {
  const encryptedStoreId = session.state.activeEncryptedStoreId;
  const headerStore = new EncryptedStoreHeaderStore({ storageRoot });
  const header = await headerStore.read({ encryptedStoreId });
  if (header === undefined) {
    throw new Error(`Encrypted store header is missing: ${encryptedStoreId}`);
  }
  const backingDirectory = await headerStore.getEncryptedOpfsBackingDirectory({
    encryptedStoreId,
    create: false,
  });
  const fileSystemRootKey = await unwrapFileSystemRootKey({
    storageUnlockKey: session.storageUnlockKey,
    header,
  });
  try {
    const encryptedOpfs = await inspectEncryptedOpfs({
      backingDirectory,
      fileSystemRootKey,
    });
    if (encryptedOpfs.descriptor.fileSystemId !== header.fileSystemId) {
      throw new Error('Encrypted store header and EncryptedOpfs descriptor disagree');
    }
    return {
      state: session.state,
      header,
      encryptedOpfs,
      decryptedRoot: session.fileSystemSession.root,
      physicalPath: [
        'naidan-storage',
        'encrypted-stores',
        encryptedStoreId,
        'data',
      ],
    };
  } finally {
    fileSystemRootKey.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
