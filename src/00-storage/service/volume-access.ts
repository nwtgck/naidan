import type { StorageDirectoryHandle } from './storage-file-system/types';

export type StorageVolumeAccess =
  | {
      readonly type: 'direct_directory';
      readonly handle: FileSystemDirectoryHandle;
    }
  | {
      readonly type: 'storage_directory';
      readonly handle: StorageDirectoryHandle;
    };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
