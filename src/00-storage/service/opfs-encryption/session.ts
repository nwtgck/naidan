import type { OpfsEncryptionStateDto } from '@/00-storage/00-dto/opfs-encryption.dto';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import type { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';

export type StableOpfsEncryptionState = Extract<
  OpfsEncryptionStateDto,
  { state: 'encrypted' }
>;

export type TransitioningOpfsEncryptionState = Extract<
  OpfsEncryptionStateDto,
  { state: 'transitioning' }
>;

export interface UnlockedOpfsEncryptionSession {
  readonly state: StableOpfsEncryptionState;
  readonly storageUnlockKey: Uint8Array;
  readonly unlockedKeySlotId: string;
  readonly fileSystemSession: StorageFileSystemSession;
  readonly backend: NaidanOpfsStorageBackend;
}

export type EncryptionTransitionResult =
  | {
      readonly type: 'encrypted';
      readonly session: UnlockedOpfsEncryptionSession;
    }
  | {
      readonly type: 'plain';
      readonly fileSystemSession: StorageFileSystemSession;
      readonly backend: NaidanOpfsStorageBackend;
    };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
