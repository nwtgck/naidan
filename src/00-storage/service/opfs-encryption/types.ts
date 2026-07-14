import type { OpfsEncryptionKeySlotDto } from '@/00-storage/00-dto/opfs-encryption.dto';

export interface CreatedEncryptionMaterial {
  readonly storageUnlockKey: Uint8Array;
  readonly fileSystemRootKey: Uint8Array;
  readonly keySlots: readonly OpfsEncryptionKeySlotDto[];
}

export type PassphraseValidationResult =
  | { type: 'valid' }
  | { type: 'boundary_whitespace' }
  | { type: 'line_break' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
