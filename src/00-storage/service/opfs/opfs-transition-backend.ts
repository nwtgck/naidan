import type { Volume } from '@/01-models/types';
import type { IStorageProvider } from '@/00-storage/service/interface';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import type {
  OpfsSpecialFileSystemBackend,
  OpfsSpecialFileSystemType,
} from './opfs-special-file-system';

export type { OpfsSpecialFileSystemType } from './opfs-special-file-system';

export interface OpfsTransitionStorageBackend extends IStorageProvider, OpfsSpecialFileSystemBackend {
  removeSettingsForTransition(): Promise<void>;

  importVolumeForTransition({
    volume,
    sourceAccess,
    signal,
  }: {
    volume: Volume,
    sourceAccess: StorageVolumeAccess,
    signal: AbortSignal | undefined,
  }): Promise<void>;

  openSpecialFileSystemForTransition({
    type,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    create: boolean,
  }): Promise<StorageVolumeAccess | null>;

  removeSpecialFileSystemForTransition({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void>;
}

export function isOpfsTransitionStorageBackend(
  provider: IStorageProvider,
): provider is OpfsTransitionStorageBackend {
  const candidate = provider as Partial<OpfsTransitionStorageBackend>;
  return typeof candidate.importVolumeForTransition === 'function'
    && typeof candidate.openSpecialFileSystemForTransition === 'function'
    && typeof candidate.removeSpecialFileSystemForTransition === 'function';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
