import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import {
  createHizoFSInspectionReader,
  type HizoFSInspectionOverview,
  type HizoFSInspectionReader,
} from '@/00-storage/service/hizofs';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import { unwrapFileSystemRootKey } from './encryption-key-manager';
import type { UnlockedOpfsEncryptionSession } from './session';

export interface OpfsEncryptionDebugSession {
  readonly state: Extract<OpfsEncryptionStateDto, { readonly state: 'encrypted' }>;
  readonly header: OpfsEncryptedStoreHeaderDto;
  readonly hizoFS: HizoFSInspectionOverview;
  readonly hizoFSReader: HizoFSInspectionReader;
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
  const backingDirectory = await headerStore.getHizoFSBackingDirectory({
    encryptedStoreId,
    create: false,
  });
  const fileSystemRootKey = await unwrapFileSystemRootKey({
    storageUnlockKey: session.storageUnlockKey,
    header,
  });
  let hizoFSReader: HizoFSInspectionReader | undefined;
  try {
    hizoFSReader = await createHizoFSInspectionReader({
      backingDirectory,
      fileSystemRootKey,
    });
    const hizoFS = await hizoFSReader.readOverview();
    if (hizoFS.descriptor.fileSystemId !== header.fileSystemId) {
      throw new Error('Encrypted store header and HizoFS descriptor disagree');
    }
    let disposed = false;
    return {
      state: session.state,
      header,
      hizoFS,
      hizoFSReader,
      decryptedRoot: session.fileSystemSession.root,
      physicalPath: [
        'naidan-storage',
        'encrypted-stores',
        encryptedStoreId,
        'filesystem.hizofs',
      ],
      async dispose() {
        if (disposed) return;
        disposed = true;
        await hizoFSReader?.dispose();
      },
    };
  } catch (error) {
    await hizoFSReader?.dispose();
    throw error;
  } finally {
    fileSystemRootKey.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
