/* eslint-disable local-rules/enforce-dependency-directions -- This read-only debug feature intentionally validates the exact persisted EncryptedOpfs DTO representation. Mapping through domain models could normalize, omit, or reinterpret fields and would make storage audits less reliable. */
import { z } from 'zod';
import {
  EncryptedOpfsCommitSchemaDto,
  EncryptedOpfsDescriptorSchemaDto,
  EncryptedOpfsDirectoryEntrySchemaDto,
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
  EncryptedOpfsBinaryRecordInspection,
  EncryptedOpfsBinarySlice,
  EncryptedOpfsDecodedBinaryField,
  EncryptedOpfsInspectionOverview,
  EncryptedOpfsInspectionReader,
  EncryptedOpfsInspectedObject,
  EncryptedOpfsSuperblockSlotInspection,
} from '@/00-storage/service/encrypted-opfs';

const physicalPathSchema = z.array(z.string());
const uint8ArraySchema = z.instanceof(Uint8Array);

const binarySliceSchema = z.object({
  offset: z.number().int().nonnegative(),
  regionByteLength: z.number().int().nonnegative(),
  bytes: uint8ArraySchema,
  truncatedAfter: z.boolean(),
});

const decodedBinaryFieldSchema = z.object({
  name: z.string(),
  offset: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  rawBytes: uint8ArraySchema,
  encoding: z.union([
    z.literal('ascii'),
    z.literal('bytes'),
    z.literal('uint8'),
    z.literal('uint16_be'),
    z.literal('uint32_be'),
    z.literal('uint64_be'),
  ]),
  interpretation: z.string(),
});

const binaryRecordInspectionSchema = z.object({
  persistedObject: z.object({
    bytes: binarySliceSchema,
    headerFields: z.array(decodedBinaryFieldSchema),
    ciphertextOffset: z.number().int().nonnegative(),
    ciphertextByteLength: z.number().int().nonnegative(),
  }),
  decryptedRecord: z.object({
    bytes: binarySliceSchema,
    headerFields: z.array(decodedBinaryFieldSchema),
    metadataJson: z.object({
      bytes: binarySliceSchema,
      utf8Text: z.union([z.string(), z.undefined()]),
    }),
    binaryPayload: binarySliceSchema,
  }),
});


export const encryptedOpfsSuperblockSlotSchema = z.discriminatedUnion('status', [
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
    persistedDto: z.unknown(),
    binary: binaryRecordInspectionSchema,
  }),
  z.object({
    slot: z.union([z.literal(0), z.literal(1)]),
    status: z.union([z.literal('invalid'), z.literal('unsupported')]),
    selected: z.literal(false),
    physicalPath: physicalPathSchema,
    physicalBytes: binarySliceSchema,
    errorMessage: z.string(),
  }),
]);

export const encryptedOpfsInspectionOverviewSchema = z.object({
  descriptor: EncryptedOpfsDescriptorSchemaDto,
  persistedDescriptorDto: z.unknown(),
  superblockSlots: z.array(encryptedOpfsSuperblockSlotSchema),
  activeSuperblock: EncryptedOpfsSuperblockSchemaDto,
  activeCommitObjectId: z.string(),
  activeCommit: EncryptedOpfsCommitSchemaDto,
  activeCommitPersistedDto: z.unknown(),
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
  binary: binaryRecordInspectionSchema,
  record: z.object({
    kind: z.string(),
    recordVersion: z.number().int().nonnegative(),
    metadata: z.unknown(),
    binaryPayloadByteLength: z.number().int().nonnegative(),
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
  rootDirectoryEntryPoint: z.union([
    z.object({
      commitObjectId: z.string(),
      revision: z.number().int().nonnegative(),
      rootDirectoryNodeId: z.string(),
      inodeIndexRootObjectId: z.string(),
    }),
    z.undefined(),
  ]),
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

export const encryptedOpfsResolvedNodeSchema = z.object({
  commitObjectId: z.string(),
  commitRevision: z.number().int().nonnegative(),
  rootDirectoryNodeId: z.string(),
  inodeIndexRootObjectId: z.string(),
  nodeId: z.string(),
  logicalPath: z.string(),
  inodeIndexLookup: z.array(z.discriminatedUnion('type', [
    z.object({
      type: z.literal('branch'),
      pageObjectId: z.string(),
      selectedChildPageObjectId: z.string(),
      selectedUpperBoundNodeId: z.string(),
    }),
    z.object({
      type: z.literal('leaf'),
      pageObjectId: z.string(),
      inodeObjectId: z.string(),
    }),
  ])),
  inodeObjectId: z.string(),
  inodeKind: z.union([z.literal('file'), z.literal('directory'), z.literal('symlink')]),
  inodePersistedDto: z.unknown(),
  binaryPayloadByteLength: z.number().int().nonnegative(),
  directory: z.union([
    z.object({
      storageType: z.union([z.literal('inline'), z.literal('indexed')]),
      directoryIndexRootObjectId: z.union([z.string(), z.undefined()]),
      entries: z.array(z.object({
        entry: EncryptedOpfsDirectoryEntrySchemaDto,
        source: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('inline'),
            directoryInodeObjectId: z.string(),
          }),
          z.object({
            type: z.literal('indexed'),
            directoryIndexPageObjectId: z.string(),
          }),
        ]),
      })),
      truncated: z.boolean(),
      issues: z.array(z.string()),
    }),
    z.undefined(),
  ]),
});

export const encryptedOpfsResolvedPathSchema = z.array(encryptedOpfsResolvedNodeSchema);

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

export type EncryptedOpfsBinarySliceView = EncryptedOpfsBinarySlice;
export type EncryptedOpfsBinaryRecordInspectionView = EncryptedOpfsBinaryRecordInspection;
export type EncryptedOpfsDecodedBinaryFieldView = EncryptedOpfsDecodedBinaryField;
export type EncryptedOpfsInspectionOverviewView = EncryptedOpfsInspectionOverview;
export type EncryptedOpfsSuperblockSlotView = EncryptedOpfsSuperblockSlotInspection;
export type EncryptedOpfsPhysicalObjectPageView = z.infer<typeof encryptedOpfsPhysicalObjectPageSchema>;
type ParsedEncryptedOpfsInspectedObjectView = z.infer<typeof encryptedOpfsInspectedObjectViewSchema>;
export type EncryptedOpfsInspectedObjectView = Omit<ParsedEncryptedOpfsInspectedObjectView, 'object'> & {
  readonly object: EncryptedOpfsInspectedObject;
};
export type EncryptedOpfsNamespaceResult = z.infer<typeof encryptedOpfsNamespaceResultSchema>;
export type EncryptedOpfsResolvedNodeView = z.infer<typeof encryptedOpfsResolvedNodeSchema>;
export type EncryptedOpfsResolvedPathView = z.infer<typeof encryptedOpfsResolvedPathSchema>;
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

  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined>;

  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsSuperblockSlotInspection>;

  readNode({ commitObjectId, nodeId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    nodeId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<EncryptedOpfsResolvedNodeView>;

  readPath({ commitObjectId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<EncryptedOpfsResolvedPathView>;

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
  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined>;
  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsSuperblockSlotView>;
  readNode({ commitObjectId, nodeId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    nodeId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<EncryptedOpfsResolvedNodeView>;
  readPath({ commitObjectId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<EncryptedOpfsResolvedPathView>;
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
