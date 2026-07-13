import { z } from 'zod';

export type OpfsEncryptionKeyDerivationDto = {
  readonly type: 'pbkdf2_hmac_sha256';
  readonly salt: string;
  readonly iterations: number;
};

export const OpfsEncryptionKeyDerivationSchemaDto: z.ZodType<
  OpfsEncryptionKeyDerivationDto
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pbkdf2_hmac_sha256'),
    salt: z.string(),
    iterations: z.number(),
  }),
]);

export type OpfsEncryptionWrappedStorageUnlockKeyDto = {
  readonly nonce: string;
  readonly ciphertext: string;
};

export const OpfsEncryptionWrappedStorageUnlockKeySchemaDto: z.ZodType<
  OpfsEncryptionWrappedStorageUnlockKeyDto
> = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
});

export type OpfsEncryptionKeySlotDto = {
  readonly id: string;
  readonly keyDerivation: OpfsEncryptionKeyDerivationDto;
  readonly wrappedStorageUnlockKey: OpfsEncryptionWrappedStorageUnlockKeyDto;
};

export const OpfsEncryptionKeySlotSchemaDto: z.ZodType<
  OpfsEncryptionKeySlotDto
> = z.object({
  id: z.string(),
  keyDerivation: OpfsEncryptionKeyDerivationSchemaDto,
  wrappedStorageUnlockKey: OpfsEncryptionWrappedStorageUnlockKeySchemaDto,
});

export type OpfsEncryptionWrappedFileSystemRootKeyDto = {
  readonly nonce: string;
  readonly ciphertext: string;
};

export const OpfsEncryptionWrappedFileSystemRootKeySchemaDto: z.ZodType<
  OpfsEncryptionWrappedFileSystemRootKeyDto
> = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
});

export type OpfsEncryptionOperationPhaseDto =
  | 'building_target'
  | 'cleaning_up_source';

export const OpfsEncryptionOperationPhaseSchemaDto: z.ZodType<
  OpfsEncryptionOperationPhaseDto
> = z.enum([
  'building_target',
  'cleaning_up_source',
]);

export type OpfsEncryptionOperationDto =
  | {
      readonly type: 'encrypting';
      readonly phase: OpfsEncryptionOperationPhaseDto;
      readonly targetEncryptedStoreId: string;
    }
  | {
      readonly type: 'decrypting';
      readonly phase: OpfsEncryptionOperationPhaseDto;
      readonly sourceEncryptedStoreId: string;
    }
  | {
      readonly type: 'reencrypting';
      readonly phase: OpfsEncryptionOperationPhaseDto;
      readonly sourceEncryptedStoreId: string;
      readonly targetEncryptedStoreId: string;
    };

export const OpfsEncryptionOperationSchemaDto: z.ZodType<
  OpfsEncryptionOperationDto
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('encrypting'),
    phase: OpfsEncryptionOperationPhaseSchemaDto,
    targetEncryptedStoreId: z.string(),
  }),
  z.object({
    type: z.literal('decrypting'),
    phase: OpfsEncryptionOperationPhaseSchemaDto,
    sourceEncryptedStoreId: z.string(),
  }),
  z.object({
    type: z.literal('reencrypting'),
    phase: OpfsEncryptionOperationPhaseSchemaDto,
    sourceEncryptedStoreId: z.string(),
    targetEncryptedStoreId: z.string(),
  }),
]);

export type OpfsEncryptionStateDto =
  | {
      readonly formatVersion: 1;
      readonly sequence: number;
      readonly state: 'encrypted';
      readonly keySlots: readonly OpfsEncryptionKeySlotDto[];
      readonly activeEncryptedStoreId: string;
    }
  | {
      readonly formatVersion: 1;
      readonly sequence: number;
      readonly state: 'transitioning';
      readonly keySlots: readonly OpfsEncryptionKeySlotDto[];
      readonly operation: OpfsEncryptionOperationDto;
    };

export const OpfsEncryptionStateSchemaDto: z.ZodType<OpfsEncryptionStateDto> =
  z.discriminatedUnion('state', [
    z.object({
      formatVersion: z.literal(1),
      sequence: z.number(),
      state: z.literal('encrypted'),
      keySlots: z.array(OpfsEncryptionKeySlotSchemaDto),
      activeEncryptedStoreId: z.string(),
    }),
    z.object({
      formatVersion: z.literal(1),
      sequence: z.number(),
      state: z.literal('transitioning'),
      keySlots: z.array(OpfsEncryptionKeySlotSchemaDto),
      operation: OpfsEncryptionOperationSchemaDto,
    }),
  ]);

export type OpfsEncryptedStoreHeaderDto = {
  readonly formatVersion: 1;
  readonly encryptedStoreId: string;
  readonly fileSystemId: string;
  readonly wrappedFileSystemRootKey: OpfsEncryptionWrappedFileSystemRootKeyDto;
};

export const OpfsEncryptedStoreHeaderSchemaDto: z.ZodType<
  OpfsEncryptedStoreHeaderDto
> = z.object({
  formatVersion: z.literal(1),
  encryptedStoreId: z.string(),
  fileSystemId: z.string(),
  wrappedFileSystemRootKey: OpfsEncryptionWrappedFileSystemRootKeySchemaDto,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
