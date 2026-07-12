import { EncryptedStorageDebugReader } from '@/00-storage/service/opfs-encryption/debug/encrypted-storage-debug-reader';
import type { EncryptedStorageDebugCapability } from '@/00-storage/service/opfs-encryption/debug/encrypted-storage-debug-types';
import type { IDebugEncryptedStorageWorker } from './types';

export function createDebugEncryptedStorageWorker(): IDebugEncryptedStorageWorker {
  let reader: EncryptedStorageDebugReader | undefined;

  function requireReader(): EncryptedStorageDebugReader {
    if (reader === undefined) {
      throw new Error('Encrypted Storage Inspector worker has not been configured');
    }
    return reader;
  }

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the positional Comlink boundary declared by IDebugEncryptedStorageWorker.
    async configure(capability: EncryptedStorageDebugCapability) {
      if (reader !== undefined) {
        throw new Error('Encrypted Storage Inspector worker is already configured');
      }
      if (capability.encryptedStoreId.length === 0) {
        throw new Error('Encrypted Storage Inspector received an empty store ID');
      }
      reader = new EncryptedStorageDebugReader({ capability });
    },

    async loadNode({ ref }) {
      return await requireReader().loadNode({ ref });
    },

    async search({ query }) {
      return await requireReader().search({ query });
    },

    async scanIntegrity() {
      return await requireReader().scanIntegrity();
    },

    async dispose() {
      // CryptoKey objects are non-extractable. Dropping the reader is the only
      // explicit lifetime operation available to JavaScript before terminating
      // the Worker and prevents the debug capability from outliving the modal.
      reader = undefined;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
