import {
  OpfsEncryptedStoreHeaderSchemaDto,
  type OpfsEncryptedStoreHeaderDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { ENCRYPTED_STORES_DIRECTORY_NAME } from './encryption-state-store';
import {
  isNotFoundError,
  readJsonFileIfPresent,
  removeDirectoryEntryIfPresent,
  writeJsonFile,
} from './opfs-json-file';
import {
  assertEncryptedStoreHeaderCanBeUsed,
  assertSafeOpfsPathSegment,
} from './encryption-semantic-validation';

const HEADER_FILE_NAME = 'header.json';
const ENCRYPTED_OPFS_DATA_DIRECTORY_NAME = 'data';


function encryptedStoreHeadersEqual({ left, right }: {
  left: OpfsEncryptedStoreHeaderDto;
  right: OpfsEncryptedStoreHeaderDto;
}): boolean {
  return (
    left.formatVersion === right.formatVersion
    && left.encryptedStoreId === right.encryptedStoreId
    && left.fileSystemId === right.fileSystemId
    && left.wrappedFileSystemRootKey.nonce === right.wrappedFileSystemRootKey.nonce
    && left.wrappedFileSystemRootKey.ciphertext
      === right.wrappedFileSystemRootKey.ciphertext
  );
}

export class EncryptedStoreHeaderStore {
  constructor({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }) {
    this.storageRoot = storageRoot;
  }

  private readonly storageRoot: FileSystemDirectoryHandle;

  async getStoreDirectory({
    encryptedStoreId,
    create,
  }: {
    encryptedStoreId: string;
    create: boolean;
  }): Promise<FileSystemDirectoryHandle> {
    assertSafeOpfsPathSegment({ value: encryptedStoreId, fieldName: 'Encrypted store ID' });
    const storesDirectory = await this.storageRoot.getDirectoryHandle(
      ENCRYPTED_STORES_DIRECTORY_NAME,
      { create },
    );
    return await storesDirectory.getDirectoryHandle(encryptedStoreId, { create });
  }

  async getEncryptedOpfsBackingDirectory({
    encryptedStoreId,
    create,
  }: {
    encryptedStoreId: string;
    create: boolean;
  }): Promise<FileSystemDirectoryHandle> {
    const storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create });
    return await storeDirectory.getDirectoryHandle(
      ENCRYPTED_OPFS_DATA_DIRECTORY_NAME,
      { create },
    );
  }

  async read({ encryptedStoreId }: {
    encryptedStoreId: string;
  }): Promise<OpfsEncryptedStoreHeaderDto | undefined> {
    let storeDirectory: FileSystemDirectoryHandle;
    try {
      storeDirectory = await this.getStoreDirectory({ encryptedStoreId, create: false });
    } catch (error) {
      if (isNotFoundError({ error })) {
        return undefined;
      }
      throw error;
    }
    const header = await readJsonFileIfPresent({
      directory: storeDirectory,
      name: HEADER_FILE_NAME,
      schema: OpfsEncryptedStoreHeaderSchemaDto,
    });
    if (header !== undefined) {
      assertEncryptedStoreHeaderCanBeUsed({ header });
    }
    return header;
  }

  async write({ header }: {
    header: OpfsEncryptedStoreHeaderDto;
  }): Promise<void> {
    assertEncryptedStoreHeaderCanBeUsed({ header });
    const storeDirectory = await this.getStoreDirectory({
      encryptedStoreId: header.encryptedStoreId,
      create: true,
    });
    const current = await readJsonFileIfPresent({
      directory: storeDirectory,
      name: HEADER_FILE_NAME,
      schema: OpfsEncryptedStoreHeaderSchemaDto,
    });
    if (current !== undefined) {
      if (encryptedStoreHeadersEqual({ left: current, right: header })) {
        return;
      }
      throw new Error('Encrypted store header is immutable');
    }
    await writeJsonFile({
      directory: storeDirectory,
      name: HEADER_FILE_NAME,
      value: header,
    });
  }

  async removeStore({ encryptedStoreId }: {
    encryptedStoreId: string;
  }): Promise<void> {
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
  ENCRYPTED_OPFS_DATA_DIRECTORY_NAME,
  HEADER_FILE_NAME,
};
