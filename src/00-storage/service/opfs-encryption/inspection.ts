import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import {
  createEncryptedOpfsInspectionReader,
  type EncryptedOpfsInspectionOverview,
  type EncryptedOpfsInspectionReader,
} from '@/00-storage/service/encrypted-opfs';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import { unwrapFileSystemRootKey } from './encryption-key-manager';
import type { UnlockedOpfsEncryptionSession } from './session';

export interface OpfsEncryptionDebugSession {
  readonly state: Extract<OpfsEncryptionStateDto, { readonly state: 'encrypted' }>;
  readonly header: OpfsEncryptedStoreHeaderDto;
  readonly encryptedOpfs: EncryptedOpfsInspectionOverview;
  readonly encryptedOpfsReader: EncryptedOpfsInspectionReader;
  readonly decryptedRoot: StorageDirectoryHandle;
  readonly physicalPath: readonly string[];

  dispose(): Promise<void>;
}

export async function createOpfsEncryptionDebugSession({
  storageRoot,
  session,
}: {
  storageRoot: FileSystemDirectoryHandle;
  session: UnlockedOpfsEncryptionSession;
}): Promise<OpfsEncryptionDebugSession> {
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
  let encryptedOpfsReader: EncryptedOpfsInspectionReader | undefined;
  try {
    encryptedOpfsReader = await createEncryptedOpfsInspectionReader({
      backingDirectory,
      fileSystemRootKey,
    });
    const encryptedOpfs = await encryptedOpfsReader.readOverview();
    if (encryptedOpfs.descriptor.fileSystemId !== header.fileSystemId) {
      throw new Error('Encrypted store header and EncryptedOpfs descriptor disagree');
    }
    let disposed = false;
    return {
      state: session.state,
      header,
      encryptedOpfs,
      encryptedOpfsReader,
      decryptedRoot: session.fileSystemSession.root,
      physicalPath: [
        'naidan-storage',
        'encrypted-stores',
        encryptedStoreId,
        'data',
      ],
      async dispose() {
        if (disposed) return;
        disposed = true;
        await encryptedOpfsReader?.dispose();
      },
    };
  } catch (error) {
    await encryptedOpfsReader?.dispose();
    throw error;
  } finally {
    fileSystemRootKey.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
