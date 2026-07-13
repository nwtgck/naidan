/* eslint-disable local-rules/enforce-dependency-directions -- This read-only debug feature intentionally validates the exact persisted EncryptedOpfs DTO representation. Mapping through domain models could normalize, omit, or reinterpret fields and would make storage audits less reliable. */
import { z } from 'zod';
import {
  EncryptedOpfsCommitSchemaDto,
  EncryptedOpfsDescriptorSchemaDto,
  EncryptedOpfsDirectoryIndexPageSchemaDto,
  EncryptedOpfsDirectoryInodeSchemaDto,
  EncryptedOpfsFileChunkSchemaDto,
  EncryptedOpfsFileExtentPageSchemaDto,
  EncryptedOpfsFileInodeSchemaDto,
  EncryptedOpfsInodeIndexPageSchemaDto,
  EncryptedOpfsSuperblockSchemaDto,
  EncryptedOpfsSymlinkInodeSchemaDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import type {
  EncryptedOpfsInspectionReader,
  EncryptedOpfsInspectedObject,
} from '@/00-storage/service/encrypted-opfs';

const physicalPathSchema = z.array(z.string());

const superblockSlotSchema = z.discriminatedUnion('status', [
  z.object({
    slot: z.union([z.literal(0), z.literal(1)]),
    status: z.literal('missing'),
    selected: z.literal(false),
    physicalPath: physicalPathSchema,
  }),
  z.object({
    slot: z.union([z.literal(0), z.literal(1)]),
    status: z.literal('valid'),
    selected: z.boolean(),
    physicalPath: physicalPathSchema,
    value: EncryptedOpfsSuperblockSchemaDto,
  }),
  z.object({
    slot: z.union([z.literal(0), z.literal(1)]),
    status: z.union([z.literal('invalid'), z.literal('unsupported')]),
    selected: z.literal(false),
    physicalPath: physicalPathSchema,
    errorMessage: z.string(),
  }),
]);

export const encryptedOpfsInspectionOverviewSchema = z.object({
  descriptor: EncryptedOpfsDescriptorSchemaDto,
  superblockSlots: z.array(superblockSlotSchema),
  activeSuperblock: EncryptedOpfsSuperblockSchemaDto,
  activeCommitObjectId: z.string(),
  activeCommit: EncryptedOpfsCommitSchemaDto,
});

export const encryptedOpfsPhysicalObjectPageSchema = z.object({
  entries: z.array(z.object({
    objectId: z.string(),
    physicalPath: physicalPathSchema,
  })),
  nextCursor: z.union([z.string(), z.undefined()]),
  ignoredPhysicalPaths: z.array(z.string()),
});

const inspectedObjectSchema = z.object({
  objectId: z.string(),
  physicalPath: physicalPathSchema,
  physicalByteLength: z.number().int().nonnegative(),
  envelope: z.object({
    formatVersion: z.number().int().nonnegative(),
    nonceBytes: z.array(z.number().int().min(0).max(255)),
    ciphertextByteLength: z.number().int().nonnegative(),
  }),
  record: z.object({
    kind: z.string(),
    recordVersion: z.number().int().nonnegative(),
    metadata: z.unknown(),
    binaryPayloadByteLength: z.number().int().nonnegative(),
    binaryPayloadPreviewBytes: z.array(z.number().int().min(0).max(255)),
    binaryPayloadPreviewTruncated: z.boolean(),
  }),
});

export const encryptedOpfsObjectReferenceSchema = z.object({
  relation: z.string(),
  objectId: z.string(),
});

export const encryptedOpfsInspectedObjectViewSchema = z.object({
  object: inspectedObjectSchema,
  validation: z.discriminatedUnion('status', [
    z.object({ status: z.literal('valid'), persistedDto: z.unknown() }),
    z.object({ status: z.literal('invalid'), errorMessage: z.string() }),
  ]),
  references: z.array(encryptedOpfsObjectReferenceSchema),
});

export const encryptedOpfsNamespaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.union([z.literal('file'), z.literal('directory'), z.literal('symlink')]),
  nodeId: z.string(),
  inodeObjectId: z.string(),
  revision: z.number().int().nonnegative(),
  size: z.union([z.number().int().nonnegative(), z.undefined()]),
  storage: z.string(),
});

export const encryptedOpfsNamespaceResultSchema = z.object({
  entries: z.array(encryptedOpfsNamespaceEntrySchema),
  truncated: z.boolean(),
  issues: z.array(z.string()),
});

export const encryptedOpfsIntegrityScanResultSchema = z.object({
  activeCommitObjectId: z.string(),
  activeReachableObjectCount: z.number().int().nonnegative(),
  fallbackReachableObjectCount: z.number().int().nonnegative(),
  reachableObjectCount: z.number().int().nonnegative(),
  fallbackOnlyObjectIds: z.array(z.string()),
  physicalObjectCount: z.number().int().nonnegative(),
  orphanObjectIds: z.array(z.string()),
  ignoredPhysicalPaths: z.array(z.string()),
  recordKindCounts: z.record(z.string(), z.number().int().nonnegative()),
  totalBinaryPayloadBytes: z.number().int().nonnegative(),
  issues: z.array(z.string()),
});

export type EncryptedOpfsInspectionOverviewView = z.infer<typeof encryptedOpfsInspectionOverviewSchema>;
export type EncryptedOpfsPhysicalObjectPageView = z.infer<typeof encryptedOpfsPhysicalObjectPageSchema>;
export type EncryptedOpfsInspectedObjectView = z.infer<typeof encryptedOpfsInspectedObjectViewSchema>;
export type EncryptedOpfsNamespaceResult = z.infer<typeof encryptedOpfsNamespaceResultSchema>;
export type EncryptedOpfsIntegrityScanResult = z.infer<typeof encryptedOpfsIntegrityScanResultSchema>;

export interface IEncryptedOpfsInspectionWorker {
  // Comlink boundary: the proxied reader must be passed as a top-level argument.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy arguments cannot be nested in the request object.
  configure(reader: EncryptedOpfsInspectionReader): Promise<void>;

  readOverview(): Promise<EncryptedOpfsInspectionOverviewView>;

  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<EncryptedOpfsPhysicalObjectPageView>;

  inspectObject({ objectId, binaryPayloadPreviewByteLength }: {
    objectId: string;
    binaryPayloadPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined>;

  readNamespace({ maximumEntryCount }: {
    maximumEntryCount: number;
  }): Promise<EncryptedOpfsNamespaceResult>;

  runIntegrityScan(): Promise<EncryptedOpfsIntegrityScanResult>;

  cancelCurrentOperation(): Promise<void>;
}

export interface EncryptedOpfsInspectionWorkerClient {
  readOverview(): Promise<EncryptedOpfsInspectionOverviewView>;
  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<EncryptedOpfsPhysicalObjectPageView>;
  inspectObject({ objectId, binaryPayloadPreviewByteLength }: {
    objectId: string;
    binaryPayloadPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined>;
  readNamespace({ maximumEntryCount }: {
    maximumEntryCount: number;
  }): Promise<EncryptedOpfsNamespaceResult>;
  runIntegrityScan(): Promise<EncryptedOpfsIntegrityScanResult>;
  cancelCurrentOperation(): Promise<void>;
  dispose(): Promise<void>;
}

export type EncryptedOpfsInspectionReaderRemote = EncryptedOpfsInspectionReader;
export type EncryptedOpfsInspectionRawObject = EncryptedOpfsInspectedObject;

export const persistedDtoSchemasByRecordKind = {
  commit: EncryptedOpfsCommitSchemaDto,
  inode_index_page: EncryptedOpfsInodeIndexPageSchemaDto,
  file_inode: EncryptedOpfsFileInodeSchemaDto,
  directory_inode: EncryptedOpfsDirectoryInodeSchemaDto,
  symlink_inode: EncryptedOpfsSymlinkInodeSchemaDto,
  directory_index_page: EncryptedOpfsDirectoryIndexPageSchemaDto,
  file_extent_page: EncryptedOpfsFileExtentPageSchemaDto,
  file_chunk: EncryptedOpfsFileChunkSchemaDto,
  superblock: EncryptedOpfsSuperblockSchemaDto,
} as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
