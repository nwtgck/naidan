import { z } from 'zod';

export const PassphraseEncryptionKeySlotSchemaDto = z.object({
  pbkdf2: z.object({
    salt: z.string(),
    iterations: z.number(),
  }),
  wrappedStorageUnlockKey: z.object({
    nonce: z.string(),
    ciphertext: z.string(),
  }),
});
export type PassphraseEncryptionKeySlotDto = z.infer<
  typeof PassphraseEncryptionKeySlotSchemaDto
>;

export const EncryptionOperationPhaseSchemaDto = z.enum([
  'building_target',
  'cleaning_up_source',
]);
export type EncryptionOperationPhaseDto = z.infer<typeof EncryptionOperationPhaseSchemaDto>;

export const EncryptionOperationSchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('encrypting'),
    phase: EncryptionOperationPhaseSchemaDto,
    targetEncryptedStoreId: z.string(),
  }),
  z.object({
    type: z.literal('decrypting'),
    phase: EncryptionOperationPhaseSchemaDto,
    sourceEncryptedStoreId: z.string(),
  }),
  z.object({
    type: z.literal('reencrypting'),
    phase: EncryptionOperationPhaseSchemaDto,
    sourceEncryptedStoreId: z.string(),
    targetEncryptedStoreId: z.string(),
  }),
]);
export type EncryptionOperationDto = z.infer<typeof EncryptionOperationSchemaDto>;

export const EncryptionStateSchemaDto = z.discriminatedUnion('state', [
  z.object({
    formatVersion: z.literal(1),
    sequence: z.number(),
    state: z.literal('encrypted'),
    passphraseKeySlot: PassphraseEncryptionKeySlotSchemaDto,
    activeEncryptedStoreId: z.string(),
  }),
  z.object({
    formatVersion: z.literal(1),
    sequence: z.number(),
    state: z.literal('transitioning'),
    passphraseKeySlot: PassphraseEncryptionKeySlotSchemaDto,
    operation: EncryptionOperationSchemaDto,
  }),
]);
export type EncryptionStateDto = z.infer<typeof EncryptionStateSchemaDto>;

export const EncryptedStoreHeaderSchemaDto = z.object({
  formatVersion: z.literal(1),
  sequence: z.number(),
  encryptedStoreId: z.string(),
  encryptionSuite: z.literal('aes_256_gcm_chunked_v1'),
  wrappedStoreRootKey: z.object({
    nonce: z.string(),
    ciphertext: z.string(),
  }),
});
export type EncryptedStoreHeaderDto = z.infer<typeof EncryptedStoreHeaderSchemaDto>;

export const EncryptedStoreManifestSchemaDto = z.object({
  chatMetaShardIds: z.array(z.string()),
  chatGroupShardIds: z.array(z.string()),
  binaryObjectShardIds: z.array(z.string()),
  volumeShardIds: z.array(z.string()),
  fileSystems: z.array(z.discriminatedUnion('type', [
    z.object({
      id: z.string(),
      type: z.literal('opfs_volume'),
      sourceId: z.string(),
      rootDirectoryId: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal('chat_wesh'),
      rootDirectoryId: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal('debug_wesh'),
      rootDirectoryId: z.string(),
    }),
    z.object({
      id: z.string(),
      type: z.literal('tmp'),
      rootDirectoryId: z.string(),
    }),
  ])),
});
export type EncryptedStoreManifestDto = z.infer<typeof EncryptedStoreManifestSchemaDto>;

export const EncryptedChatMetaShardIndexSchemaDto = z.object({
  chatIds: z.array(z.string()),
});
export type EncryptedChatMetaShardIndexDto = z.infer<typeof EncryptedChatMetaShardIndexSchemaDto>;

export const EncryptedChatGroupShardIndexSchemaDto = z.object({
  chatGroupIds: z.array(z.string()),
});
export type EncryptedChatGroupShardIndexDto = z.infer<typeof EncryptedChatGroupShardIndexSchemaDto>;

export const EncryptedFileManifestSchemaDto = z.object({
  fileId: z.string(),
  logicalSize: z.number(),
  logicalChunkSize: z.number(),
  modifiedAt: z.number(),
  chunkIds: z.array(z.string().nullable()),
});
export type EncryptedFileManifestDto = z.infer<typeof EncryptedFileManifestSchemaDto>;

export const EncryptedFileSystemEntrySchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file'),
    name: z.string(),
    fileId: z.string(),
  }),
  z.object({
    type: z.literal('directory'),
    name: z.string(),
    directoryId: z.string(),
  }),
  z.object({
    type: z.literal('symlink'),
    name: z.string(),
    targetPath: z.string(),
    modifiedAt: z.number(),
  }),
]);
export type EncryptedFileSystemEntryDto = z.infer<typeof EncryptedFileSystemEntrySchemaDto>;

export const EncryptedDirectoryManifestSchemaDto = z.object({
  directoryId: z.string(),
  modifiedAt: z.number(),
  shardIds: z.array(z.string()),
});
export type EncryptedDirectoryManifestDto = z.infer<typeof EncryptedDirectoryManifestSchemaDto>;

export const EncryptedDirectoryShardContentsSchemaDto = z.object({
  entries: z.record(z.string(), EncryptedFileSystemEntrySchemaDto),
});
export type EncryptedDirectoryShardContentsDto = z.infer<typeof EncryptedDirectoryShardContentsSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
