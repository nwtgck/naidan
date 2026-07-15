/* eslint-disable local-rules/enforce-dependency-directions -- This read-only debug feature intentionally validates the exact persisted HizoFS DTO representation. Mapping through domain models could normalize, omit, or reinterpret fields and would make storage audits less reliable. */
import { z } from 'zod';
import {
  HizoFSCommitSchemaDto,
  HizoFSDescriptorSchemaDto,
  HizoFSDirectoryEntrySchemaDto,
  HizoFSDirectoryIndexPageSchemaDto,
  HizoFSDirectoryInodeSchemaDto,
  HizoFSFileChunkSchemaDto,
  HizoFSFileExtentPageSchemaDto,
  HizoFSFileInodeSchemaDto,
  HizoFSInodeIndexPageSchemaDto,
  HizoFSSuperblockSchemaDto,
  HizoFSSymlinkInodeSchemaDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type {
  HizoFSBinaryRecordInspection,
  HizoFSBinarySlice,
  HizoFSDecodedBinaryField,
  HizoFSInspectionOverview,
  HizoFSInspectionReader,
  HizoFSInspectedObject,
  HizoFSSuperblockSlotInspection,
} from '@/00-storage/service/hizofs';

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


export const hizoFSSuperblockSlotSchema = z.discriminatedUnion('status', [
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
    value: HizoFSSuperblockSchemaDto,
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

export const hizoFSInspectionOverviewSchema = z.object({
  activeMode: z.union([z.literal('current'), z.literal('fallback_read_only')]),
  descriptor: HizoFSDescriptorSchemaDto,
  fileSystemId: z.string(),
  persistedDescriptorDto: z.unknown(),
  descriptorValidationError: z.union([z.string(), z.undefined()]),
  superblockSlots: z.array(hizoFSSuperblockSlotSchema),
  activeSuperblock: HizoFSSuperblockSchemaDto,
  activeCommitObjectId: z.string(),
  activeCommit: HizoFSCommitSchemaDto,
  activeCommitPersistedDto: z.unknown(),
});

export const hizoFSPhysicalObjectPageSchema = z.object({
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

export const hizoFSObjectReferenceSchema = z.object({
  relation: z.string(),
  objectId: z.string(),
});

export const hizoFSInspectedObjectViewSchema = z.object({
  object: inspectedObjectSchema,
  validation: z.discriminatedUnion('status', [
    z.object({ status: z.literal('valid'), persistedDto: z.unknown() }),
    z.object({ status: z.literal('invalid'), errorMessage: z.string() }),
  ]),
  references: z.array(hizoFSObjectReferenceSchema),
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

export const hizoFSNamespaceEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.union([z.literal('file'), z.literal('directory'), z.literal('symlink')]),
  nodeId: z.string(),
  inodeObjectId: z.string(),
  revision: z.number().int().nonnegative(),
  size: z.union([z.number().int().nonnegative(), z.undefined()]),
  storage: z.string(),
});

export const hizoFSNamespaceResultSchema = z.object({
  entries: z.array(hizoFSNamespaceEntrySchema),
  truncated: z.boolean(),
  issues: z.array(z.string()),
});

export const hizoFSResolvedNodeSchema = z.object({
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
        entry: HizoFSDirectoryEntrySchemaDto,
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

export const hizoFSResolvedPathSchema = z.array(hizoFSResolvedNodeSchema);

export const hizoFSIntegrityScanResultSchema = z.object({
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

export type HizoFSBinarySliceView = HizoFSBinarySlice;
export type HizoFSBinaryRecordInspectionView = HizoFSBinaryRecordInspection;
export type HizoFSDecodedBinaryFieldView = HizoFSDecodedBinaryField;
export type HizoFSInspectionOverviewView = HizoFSInspectionOverview;
export type HizoFSSuperblockSlotView = HizoFSSuperblockSlotInspection;
export type HizoFSPhysicalObjectPageView = z.infer<typeof hizoFSPhysicalObjectPageSchema>;
type ParsedHizoFSInspectedObjectView = z.infer<typeof hizoFSInspectedObjectViewSchema>;
export type HizoFSInspectedObjectView = Omit<ParsedHizoFSInspectedObjectView, 'object'> & {
  readonly object: HizoFSInspectedObject;
};
export type HizoFSNamespaceResult = z.infer<typeof hizoFSNamespaceResultSchema>;
export type HizoFSResolvedNodeView = z.infer<typeof hizoFSResolvedNodeSchema>;
export type HizoFSResolvedPathView = z.infer<typeof hizoFSResolvedPathSchema>;
export type HizoFSIntegrityScanResult = z.infer<typeof hizoFSIntegrityScanResultSchema>;

export interface IHizoFSInspectionWorker {
  // Comlink boundary: the proxied reader must be passed as a top-level argument.
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink proxy arguments cannot be nested in the request object.
  configure(reader: HizoFSInspectionReader): Promise<void>;

  readOverview(): Promise<HizoFSInspectionOverviewView>;

  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<HizoFSPhysicalObjectPageView>;

  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSInspectedObjectView | undefined>;

  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSSuperblockSlotInspection>;

  readNode({ commitObjectId, nodeId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    nodeId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<HizoFSResolvedNodeView>;

  readPath({ commitObjectId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<HizoFSResolvedPathView>;

  readNamespace({ maximumEntryCount }: {
    maximumEntryCount: number;
  }): Promise<HizoFSNamespaceResult>;

  runIntegrityScan(): Promise<HizoFSIntegrityScanResult>;

  cancelCurrentOperation(): Promise<void>;
}

export interface HizoFSInspectionWorkerClient {
  readOverview(): Promise<HizoFSInspectionOverviewView>;
  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<HizoFSPhysicalObjectPageView>;
  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSInspectedObjectView | undefined>;
  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSSuperblockSlotView>;
  readNode({ commitObjectId, nodeId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    nodeId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<HizoFSResolvedNodeView>;
  readPath({ commitObjectId, logicalPath, maximumDirectoryEntryCount }: {
    commitObjectId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<HizoFSResolvedPathView>;
  readNamespace({ maximumEntryCount }: {
    maximumEntryCount: number;
  }): Promise<HizoFSNamespaceResult>;
  runIntegrityScan(): Promise<HizoFSIntegrityScanResult>;
  cancelCurrentOperation(): Promise<void>;
  dispose(): Promise<void>;
}

export type HizoFSInspectionReaderRemote = HizoFSInspectionReader;
export type HizoFSInspectionRawObject = HizoFSInspectedObject;

export const persistedDtoSchemasByRecordKind = {
  commit: HizoFSCommitSchemaDto,
  inode_index_page: HizoFSInodeIndexPageSchemaDto,
  file_inode: HizoFSFileInodeSchemaDto,
  directory_inode: HizoFSDirectoryInodeSchemaDto,
  symlink_inode: HizoFSSymlinkInodeSchemaDto,
  directory_index_page: HizoFSDirectoryIndexPageSchemaDto,
  file_extent_page: HizoFSFileExtentPageSchemaDto,
  file_chunk: HizoFSFileChunkSchemaDto,
  superblock: HizoFSSuperblockSchemaDto,
} as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
