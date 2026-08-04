import type { IStorageProvider } from '@/00-storage/service/interface';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import type { OpfsSpecialFileSystemType } from './naidan-opfs-root-directory-registry';

export type { OpfsSpecialFileSystemType } from './naidan-opfs-root-directory-registry';

export interface OpfsSpecialFileSystemBackend extends IStorageProvider {
  openSpecialFileSystemDirectory({
    type,
    path,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    create: boolean,
  }): Promise<StorageVolumeAccess | null>;

  removeSpecialFileSystemEntry({
    type,
    path,
    recursive,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    recursive: boolean,
  }): Promise<void>;
}

export function isOpfsSpecialFileSystemBackend(
  provider: IStorageProvider,
): provider is OpfsSpecialFileSystemBackend {
  const candidate = provider as Partial<OpfsSpecialFileSystemBackend>;
  return typeof candidate.openSpecialFileSystemDirectory === 'function'
    && typeof candidate.removeSpecialFileSystemEntry === 'function';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
