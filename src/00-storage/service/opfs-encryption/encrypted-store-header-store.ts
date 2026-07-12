import {
  EncryptedStoreHeaderSchemaDto,
  type EncryptedStoreHeaderDto,
} from '@/00-storage/00-dto/encryption.dto';
import { DualSlotJsonStore } from './dual-slot-json-store';
import { ENCRYPTED_STORES_DIRECTORY_NAME } from './encryption-state-store';
import { isNotFoundError, removeDirectoryEntryIfPresent } from './opfs-json-file';
import {
  assertEncryptedStoreHeaderCanBeUsed,
  assertSafeOpfsPathSegment,
} from './encryption-semantic-validation';

export class EncryptedStoreHeaderStore {
  constructor({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }) {
    this.storageRoot = storageRoot;
  }

  private readonly storageRoot: FileSystemDirectoryHandle;

  async getStoreDirectory({
    encryptedStoreId,
    create,
  }: {
    encryptedStoreId: string,
    create: boolean,
  }): Promise<FileSystemDirectoryHandle> {
    assertSafeOpfsPathSegment({ value: encryptedStoreId, fieldName: 'Encrypted store ID' });
    const storesDirectory = await this.storageRoot.getDirectoryHandle(
      ENCRYPTED_STORES_DIRECTORY_NAME,
      { create },
    );
    return await storesDirectory.getDirectoryHandle(encryptedStoreId, { create });
  }

  async read({ encryptedStoreId }: { encryptedStoreId: string }): Promise<EncryptedStoreHeaderDto | undefined> {
    const storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create: false });
    const headerDirectory = await storeDirectory.getDirectoryHandle('header');
    const header = await new DualSlotJsonStore({
      directory: headerDirectory,
      filePrefix: 'header',
      schema: EncryptedStoreHeaderSchemaDto,
    }).read();
    if (header !== undefined) {
      assertEncryptedStoreHeaderCanBeUsed({ header });
    }
    return header;
  }

  async write({ header }: { header: EncryptedStoreHeaderDto }): Promise<void> {
    assertEncryptedStoreHeaderCanBeUsed({ header });
    const storeDirectory = await this.getStoreDirectory({
      encryptedStoreId: header.encryptedStoreId,
      create: true,
    });
    const headerDirectory = await storeDirectory.getDirectoryHandle('header', { create: true });
    await new DualSlotJsonStore({
      directory: headerDirectory,
      filePrefix: 'header',
      schema: EncryptedStoreHeaderSchemaDto,
    }).write({ value: header });
  }

  async removeStore({ encryptedStoreId }: { encryptedStoreId: string }): Promise<void> {
    assertSafeOpfsPathSegment({ value: encryptedStoreId, fieldName: 'Encrypted store ID' });
    let storesDirectory: FileSystemDirectoryHandle;
    try {
      storesDirectory = await this.storageRoot.getDirectoryHandle(
        ENCRYPTED_STORES_DIRECTORY_NAME,
      );
    } catch (error) {
      if (isNotFoundError({ error })) {
        return;
      }
      throw error;
    }
    await removeDirectoryEntryIfPresent({
      directory: storesDirectory,
      name: encryptedStoreId,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
