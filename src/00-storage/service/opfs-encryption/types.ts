import type { PassphraseEncryptionKeySlotDto } from '@/00-storage/00-dto/encryption.dto';

export interface EncryptedStoreRuntimeKeys {
  readonly objectEncryptionKey: CryptoKey,
  readonly objectAddressKey: CryptoKey,
}

export interface CreatedEncryptionMaterial {
  readonly storageUnlockKey: Uint8Array,
  readonly storeRootKey: Uint8Array,
  readonly passphraseKeySlot: PassphraseEncryptionKeySlotDto,
}

export interface UnlockedEncryptionState {
  readonly storageUnlockKey: Uint8Array,
  readonly storeRootKey: Uint8Array,
  readonly storeKeys: EncryptedStoreRuntimeKeys,
}

export type PassphraseValidationResult =
  | { type: 'valid' }
  | { type: 'boundary_whitespace' }
  | { type: 'line_break' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
