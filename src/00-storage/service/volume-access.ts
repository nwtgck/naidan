import type { StorageDirectoryHandle } from './storage-file-system/types';
import { unwrapNativeOpfsDirectoryHandle } from './storage-file-system/native-opfs';

export type StorageVolumeAccess =
  | {
      readonly type: 'direct_directory';
      readonly handle: FileSystemDirectoryHandle;
    }
  | {
      readonly type: 'storage_directory';
      readonly handle: StorageDirectoryHandle;
    };

export function exposeStorageVolumeAccess({ access }: {
  access: StorageVolumeAccess | null;
}): StorageVolumeAccess | null {
  if (access === null) {
    return null;
  }
  switch (access.type) {
  case 'storage_directory': {
    const nativeHandle = unwrapNativeOpfsDirectoryHandle({ handle: access.handle });
    return nativeHandle === undefined
      ? access
      : { type: 'direct_directory', handle: nativeHandle };
  }
  case 'direct_directory':
    return access;
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
