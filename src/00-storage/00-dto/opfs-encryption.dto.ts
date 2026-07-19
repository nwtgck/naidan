import { z } from 'zod';

function readonlyArraySchema<ElementSchema extends z.ZodType>({
  elementSchema,
}: {
  elementSchema: ElementSchema;
}) {
  return z.array(elementSchema).transform(
    (elements): readonly z.infer<ElementSchema>[] => elements,
  );
}

export const OpfsEncryptionKeyDerivationSchemaDto = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('pbkdf2_hmac_sha256'),
      salt: z.string(),
      iterations: z.number(),
    }),
  ],
);

export type OpfsEncryptionKeyDerivationDto = z.infer<
  typeof OpfsEncryptionKeyDerivationSchemaDto
>;

export const OpfsEncryptionWrappedStorageUnlockKeySchemaDto = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
});

export type OpfsEncryptionWrappedStorageUnlockKeyDto = z.infer<
  typeof OpfsEncryptionWrappedStorageUnlockKeySchemaDto
>;

export const OpfsEncryptionKeySlotSchemaDto = z.object({
  id: z.string(),
  keyDerivation: OpfsEncryptionKeyDerivationSchemaDto,
  wrappedStorageUnlockKey: OpfsEncryptionWrappedStorageUnlockKeySchemaDto,
});

export type OpfsEncryptionKeySlotDto = z.infer<
  typeof OpfsEncryptionKeySlotSchemaDto
>;

export const OpfsEncryptionWrappedFileSystemRootKeySchemaDto = z.object({
  nonce: z.string(),
  ciphertext: z.string(),
});

export type OpfsEncryptionWrappedFileSystemRootKeyDto = z.infer<
  typeof OpfsEncryptionWrappedFileSystemRootKeySchemaDto
>;

export const OpfsEncryptionOperationPhaseSchemaDto = z.enum([
  'building_target',
  'cleaning_up_source',
]);

export type OpfsEncryptionOperationPhaseDto = z.infer<
  typeof OpfsEncryptionOperationPhaseSchemaDto
>;

export const OpfsEncryptionOperationSchemaDto = z.discriminatedUnion('type', [
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

export type OpfsEncryptionOperationDto = z.infer<
  typeof OpfsEncryptionOperationSchemaDto
>;

export const OpfsEncryptionStateSchemaDto = z.discriminatedUnion('state', [
  z.object({
    formatVersion: z.literal(1),
    sequence: z.number(),
    state: z.literal('encrypted'),
    keySlots: readonlyArraySchema({ elementSchema: OpfsEncryptionKeySlotSchemaDto }),
    activeEncryptedStoreId: z.string(),
  }),
  z.object({
    formatVersion: z.literal(1),
    sequence: z.number(),
    state: z.literal('transitioning'),
    keySlots: readonlyArraySchema({ elementSchema: OpfsEncryptionKeySlotSchemaDto }),
    operation: OpfsEncryptionOperationSchemaDto,
  }),
]);

export type OpfsEncryptionStateDto = z.infer<
  typeof OpfsEncryptionStateSchemaDto
>;

export const OpfsEncryptedStoreHeaderSchemaDto = z.object({
  formatVersion: z.literal(1),
  encryptedStoreId: z.string(),
  fileSystemId: z.string(),
  wrappedFileSystemRootKey: OpfsEncryptionWrappedFileSystemRootKeySchemaDto,
});

export type OpfsEncryptedStoreHeaderDto = z.infer<
  typeof OpfsEncryptedStoreHeaderSchemaDto
>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
