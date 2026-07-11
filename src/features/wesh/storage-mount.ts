import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import type { WeshMount } from '@/features/wesh/types';

export function createWeshStorageMount({
  path,
  access,
  readOnly,
}: {
  path: string,
  access: StorageVolumeAccess,
  readOnly: boolean,
}): WeshMount {
  switch (access.type) {
  case 'direct_directory':
    return {
      type: 'directory',
      path,
      handle: access.handle,
      readOnly,
    };
  case 'encrypted_directory':
    return {
      type: 'encrypted_directory',
      path,
      storeDirectory: access.storeDirectory,
      rootDirectoryId: access.rootDirectoryId,
      objectEncryptionKey: access.objectEncryptionKey,
      objectAddressKey: access.objectAddressKey,
      readOnly,
    };
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled storage volume access: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
