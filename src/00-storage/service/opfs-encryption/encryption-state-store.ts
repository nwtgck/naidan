import {
  EncryptionStateSchemaDto,
  type EncryptionStateDto,
} from '@/00-storage/00-dto/encryption.dto';
import { DualSlotJsonStore } from './dual-slot-json-store';
import { isNotFoundError } from './opfs-json-file';

export const ENCRYPTION_STATE_DIRECTORY_NAME = 'encryption-state';
export const ENCRYPTED_STORES_DIRECTORY_NAME = 'encrypted-stores';

export type EncryptionStateInspection =
  | { type: 'plain' }
  | { type: 'encrypted', state: EncryptionStateDto }
  | { type: 'invalid', error: unknown };

export class EncryptionStateStore {
  constructor({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }) {
    this.storageRoot = storageRoot;
  }

  private readonly storageRoot: FileSystemDirectoryHandle;

  async inspect(): Promise<EncryptionStateInspection> {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await this.storageRoot.getDirectoryHandle(ENCRYPTION_STATE_DIRECTORY_NAME);
    } catch (error) {
      if (isNotFoundError({ error })) {
        return { type: 'plain' };
      }
      return { type: 'invalid', error };
    }

    try {
      const state = await new DualSlotJsonStore({
        directory,
        filePrefix: 'state',
        schema: EncryptionStateSchemaDto,
      }).read();
      if (state === undefined) {
        return {
          type: 'invalid',
          error: new Error('Encryption state directory contains no valid state slot'),
        };
      }
      return { type: 'encrypted', state };
    } catch (error) {
      return { type: 'invalid', error };
    }
  }

  async writeState({ state }: { state: EncryptionStateDto }): Promise<void> {
    const directory = await this.storageRoot.getDirectoryHandle(
      ENCRYPTION_STATE_DIRECTORY_NAME,
      { create: true },
    );
    await new DualSlotJsonStore({
      directory,
      filePrefix: 'state',
      schema: EncryptionStateSchemaDto,
    }).write({ value: state });
  }

  async removeAll(): Promise<void> {
    try {
      await this.storageRoot.removeEntry(ENCRYPTION_STATE_DIRECTORY_NAME, { recursive: true });
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
