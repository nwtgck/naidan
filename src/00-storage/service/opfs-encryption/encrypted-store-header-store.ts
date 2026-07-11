import {
  EncryptedStoreHeaderSchemaDto,
  type EncryptedStoreHeaderDto,
} from '@/00-storage/00-dto/encryption.dto';
import { DualSlotJsonStore } from './dual-slot-json-store';
import { ENCRYPTED_STORES_DIRECTORY_NAME } from './encryption-state-store';
import { isNotFoundError } from './opfs-json-file';

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
    const storesDirectory = await this.storageRoot.getDirectoryHandle(
      ENCRYPTED_STORES_DIRECTORY_NAME,
      { create },
    );
    return await storesDirectory.getDirectoryHandle(encryptedStoreId, { create });
  }

  async read({ encryptedStoreId }: { encryptedStoreId: string }): Promise<EncryptedStoreHeaderDto | undefined> {
    const storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create: false });
    const headerDirectory = await storeDirectory.getDirectoryHandle('header');
    return await new DualSlotJsonStore({
      directory: headerDirectory,
      filePrefix: 'header',
      schema: EncryptedStoreHeaderSchemaDto,
    }).read();
  }

  async write({ header }: { header: EncryptedStoreHeaderDto }): Promise<void> {
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
    try {
      const storesDirectory = await this.storageRoot.getDirectoryHandle(
        ENCRYPTED_STORES_DIRECTORY_NAME,
      );
      await storesDirectory.removeEntry(encryptedStoreId, { recursive: true });
    } catch (error) {
      if (!isNotFoundError({ error })) {
        throw error;
      }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
