import { z } from 'zod';
import { BinaryObjectSchemaDto } from './dto';

export const EncryptionKeyDerivationSchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pbkdf2_sha256'),
    salt: z.string(),
    iterations: z.number(),
  }),
]);
export type EncryptionKeyDerivationDto = z.infer<typeof EncryptionKeyDerivationSchemaDto>;

export const EncryptionKeySlotSchemaDto = z.object({
  id: z.string(),
  keyDerivation: EncryptionKeyDerivationSchemaDto,
  wrappedStorageUnlockKey: z.object({
    nonce: z.string(),
    ciphertext: z.string(),
  }),
});
export type EncryptionKeySlotDto = z.infer<typeof EncryptionKeySlotSchemaDto>;

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
    keySlots: z.array(EncryptionKeySlotSchemaDto),
    activeEncryptedStoreId: z.string(),
  }),
  z.object({
    formatVersion: z.literal(1),
    sequence: z.number(),
    state: z.literal('transitioning'),
    keySlots: z.array(EncryptionKeySlotSchemaDto),
    operation: EncryptionOperationSchemaDto,
  }),
]);
export type EncryptionStateDto = z.infer<typeof EncryptionStateSchemaDto>;

export const EncryptedStoreHeaderSchemaDto = z.object({
  formatVersion: z.literal(1),
  sequence: z.number(),
  encryptedStoreId: z.string(),
  wrappedStoreRootKey: z.object({
    nonce: z.string(),
    ciphertext: z.string(),
  }),
});
export type EncryptedStoreHeaderDto = z.infer<typeof EncryptedStoreHeaderSchemaDto>;

export const NaidanEncryptedCollectionTypeSchemaDto = z.enum([
  'chat_meta',
  'chat_group',
  'binary_object',
  'volume',
]);
export type NaidanEncryptedCollectionTypeDto = z.infer<
  typeof NaidanEncryptedCollectionTypeSchemaDto
>;

export const NaidanEncryptedStoreManifestSchemaDto = z.object({
  collections: z.array(z.object({
    type: NaidanEncryptedCollectionTypeSchemaDto,
    shardIds: z.array(z.string()),
  })),
});
export type NaidanEncryptedStoreManifestDto = z.infer<
  typeof NaidanEncryptedStoreManifestSchemaDto
>;

export const EncryptedChatMetaShardIndexSchemaDto = z.object({
  chatIds: z.array(z.string()),
});
export type EncryptedChatMetaShardIndexDto = z.infer<
  typeof EncryptedChatMetaShardIndexSchemaDto
>;

export const EncryptedChatGroupShardIndexSchemaDto = z.object({
  chatGroupIds: z.array(z.string()),
});
export type EncryptedChatGroupShardIndexDto = z.infer<
  typeof EncryptedChatGroupShardIndexSchemaDto
>;

export const EncryptedBinaryShardIndexSchemaDto = z.object({
  objects: z.record(z.string(), z.object({
    metadata: BinaryObjectSchemaDto,
    fileId: z.string(),
  })),
});
export type EncryptedBinaryShardIndexDto = z.infer<
  typeof EncryptedBinaryShardIndexSchemaDto
>;

export const EncryptedFileSystemDescriptorSchemaDto = z.object({
  id: z.string(),
  rootDirectoryId: z.string(),
  createdAt: z.number(),
});
export type EncryptedFileSystemDescriptorDto = z.infer<
  typeof EncryptedFileSystemDescriptorSchemaDto
>;

export const EncryptedFileManifestSchemaDto = z.object({
  fileId: z.string(),
  revision: z.number(),
  size: z.number(),
  chunkSize: z.number(),
  chunkMapPageSize: z.number(),
  chunkMapPageIds: z.array(z.string()),
  createdAt: z.number().nullable(),
  modifiedAt: z.number(),
});
export type EncryptedFileManifestDto = z.infer<typeof EncryptedFileManifestSchemaDto>;

export const EncryptedFileChunkMapPageSchemaDto = z.object({
  pageId: z.string(),
  fileId: z.string(),
  pageIndex: z.number(),
  chunkIds: z.array(z.string().nullable()),
});
export type EncryptedFileChunkMapPageDto = z.infer<
  typeof EncryptedFileChunkMapPageSchemaDto
>;

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
    createdAt: z.number().nullable(),
    modifiedAt: z.number(),
  }),
]);
export type EncryptedFileSystemEntryDto = z.infer<typeof EncryptedFileSystemEntrySchemaDto>;

export const EncryptedDirectoryManifestSchemaDto = z.object({
  directoryId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number(),
  shards: z.array(z.object({
    shardId: z.string(),
    objectId: z.string(),
  })),
});
export type EncryptedDirectoryManifestDto = z.infer<
  typeof EncryptedDirectoryManifestSchemaDto
>;

export const EncryptedDirectoryShardContentsSchemaDto = z.object({
  objectId: z.string(),
  directoryId: z.string(),
  shardId: z.string(),
  entries: z.record(z.string(), EncryptedFileSystemEntrySchemaDto),
});
export type EncryptedDirectoryShardContentsDto = z.infer<
  typeof EncryptedDirectoryShardContentsSchemaDto
>;

export const EncryptedObjectTransactionSchemaDto = z.object({
  id: z.string(),
  scopeId: z.string(),
  operations: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('write'),
      namespace: z.string(),
      key: z.string(),
      plaintextBase64Url: z.string(),
    }),
    z.object({
      type: z.literal('delete'),
      namespace: z.string(),
      key: z.string(),
    }),
  ])),
});
export type EncryptedObjectTransactionDto = z.infer<
  typeof EncryptedObjectTransactionSchemaDto
>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
