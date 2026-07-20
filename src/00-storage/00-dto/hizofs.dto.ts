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

export const HizoFSDescriptorSchemaDto = z.object({
  format: z.literal('hizofs'),
  formatVersion: z.literal(1),
  instanceId: z.string(),
});

export type HizoFSDescriptorDto = z.infer<typeof HizoFSDescriptorSchemaDto>;

export const HizoFSSubvolumeAccessSchemaDto = z.enum(['read', 'read_write']);

export type HizoFSSubvolumeAccessDto = z.infer<
  typeof HizoFSSubvolumeAccessSchemaDto
>;

export const HizoFSSubvolumeDescriptorSchemaDto = z.discriminatedUnion(
  'access',
  [
    z.object({
      subvolumeId: z.string(),
      access: z.literal('read'),
      fixedCommitObjectId: z.string(),
    }),
    z.object({
      subvolumeId: z.string(),
      access: z.literal('read_write'),
    }),
  ],
);

export type HizoFSSubvolumeDescriptorDto = z.infer<
  typeof HizoFSSubvolumeDescriptorSchemaDto
>;

export const HizoFSSuperblockSchemaDto = z.object({
  sequence: z.number(),
  fileSystemId: z.string(),
  subvolumeDescriptorObjectId: z.string(),
  activeCommitObjectId: z.string(),
});

export type HizoFSSuperblockDto = z.infer<typeof HizoFSSuperblockSchemaDto>;

export const HizoFSCommitSchemaDto = z.object({
  revision: z.number(),
  publicationId: z.string(),
  subvolumeId: z.string(),
  rootDirectoryNodeId: z.string(),
  inodeIndexRootObjectId: z.string(),
  subvolumeMountIndexRootObjectId: z.string(),
});

export type HizoFSCommitDto = z.infer<typeof HizoFSCommitSchemaDto>;

export const HizoFSNodeKindSchemaDto = z.enum([
  'file',
  'directory',
  'symlink',
]);

export type HizoFSNodeKindDto = z.infer<typeof HizoFSNodeKindSchemaDto>;

const HizoFSFileDirectoryEntrySchemaDto = z.object({
  name: z.string(),
  kind: z.literal('file'),
  nodeId: z.string(),
});

const HizoFSDirectoryDirectoryEntrySchemaDto = z.object({
  name: z.string(),
  kind: z.literal('directory'),
  nodeId: z.string(),
});

const HizoFSSymlinkDirectoryEntrySchemaDto = z.object({
  name: z.string(),
  kind: z.literal('symlink'),
  nodeId: z.string(),
});

const HizoFSSubvolumeDirectoryEntrySchemaDto = z.object({
  name: z.string(),
  kind: z.literal('subvolume'),
  mountId: z.string(),
});

const HizoFSNodeDirectoryEntrySchemaDto = z.discriminatedUnion('kind', [
  HizoFSFileDirectoryEntrySchemaDto,
  HizoFSDirectoryDirectoryEntrySchemaDto,
  HizoFSSymlinkDirectoryEntrySchemaDto,
]);

export type HizoFSNodeDirectoryEntryDto = z.infer<
  typeof HizoFSNodeDirectoryEntrySchemaDto
>;

export type HizoFSSubvolumeDirectoryEntryDto = z.infer<
  typeof HizoFSSubvolumeDirectoryEntrySchemaDto
>;

export const HizoFSDirectoryEntrySchemaDto = z.discriminatedUnion('kind', [
  HizoFSFileDirectoryEntrySchemaDto,
  HizoFSDirectoryDirectoryEntrySchemaDto,
  HizoFSSymlinkDirectoryEntrySchemaDto,
  HizoFSSubvolumeDirectoryEntrySchemaDto,
]);

export type HizoFSDirectoryEntryDto = z.infer<
  typeof HizoFSDirectoryEntrySchemaDto
>;

const HizoFSInlineFileStorageSchemaDto = z.object({
  type: z.literal('inline'),
});

const HizoFSExtentFileStorageSchemaDto = z.object({
  type: z.literal('extents'),
  chunkSize: z.number(),
  extentIndexRootObjectId: z.string(),
});

export type HizoFSInlineFileStorageDto = z.infer<
  typeof HizoFSInlineFileStorageSchemaDto
>;

export type HizoFSExtentFileStorageDto = z.infer<
  typeof HizoFSExtentFileStorageSchemaDto
>;

export const HizoFSFileStorageSchemaDto = z.discriminatedUnion('type', [
  HizoFSInlineFileStorageSchemaDto,
  HizoFSExtentFileStorageSchemaDto,
]);

export type HizoFSFileStorageDto = z.infer<
  typeof HizoFSFileStorageSchemaDto
>;

export const HizoFSFileInodeSchemaDto = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  size: z.number(),
  storage: HizoFSFileStorageSchemaDto,
});

export type HizoFSFileInodeDto = z.infer<typeof HizoFSFileInodeSchemaDto>;

const HizoFSInlineDirectoryStorageSchemaDto = z.object({
  type: z.literal('inline'),
  entries: readonlyArraySchema({ elementSchema: HizoFSDirectoryEntrySchemaDto }),
});

const HizoFSIndexedDirectoryStorageSchemaDto = z.object({
  type: z.literal('indexed'),
  directoryIndexRootObjectId: z.string(),
});

export type HizoFSInlineDirectoryStorageDto = z.infer<
  typeof HizoFSInlineDirectoryStorageSchemaDto
>;

export type HizoFSIndexedDirectoryStorageDto = z.infer<
  typeof HizoFSIndexedDirectoryStorageSchemaDto
>;

export const HizoFSDirectoryStorageSchemaDto = z.discriminatedUnion('type', [
  HizoFSInlineDirectoryStorageSchemaDto,
  HizoFSIndexedDirectoryStorageSchemaDto,
]);

export type HizoFSDirectoryStorageDto = z.infer<
  typeof HizoFSDirectoryStorageSchemaDto
>;

export const HizoFSDirectoryInodeSchemaDto = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  storage: HizoFSDirectoryStorageSchemaDto,
});

export type HizoFSDirectoryInodeDto = z.infer<
  typeof HizoFSDirectoryInodeSchemaDto
>;

export const HizoFSSymlinkInodeSchemaDto = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  target: z.string(),
});

export type HizoFSSymlinkInodeDto = z.infer<
  typeof HizoFSSymlinkInodeSchemaDto
>;

export const HizoFSInodeIndexLeafEntrySchemaDto = z.object({
  nodeId: z.string(),
  inodeObjectId: z.string(),
});

export type HizoFSInodeIndexLeafEntryDto = z.infer<
  typeof HizoFSInodeIndexLeafEntrySchemaDto
>;

export const HizoFSInodeIndexBranchChildSchemaDto = z.object({
  upperBoundNodeId: z.string(),
  childPageObjectId: z.string(),
});

export type HizoFSInodeIndexBranchChildDto = z.infer<
  typeof HizoFSInodeIndexBranchChildSchemaDto
>;

export const HizoFSInodeIndexPageSchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('leaf'),
    entries: readonlyArraySchema({ elementSchema: HizoFSInodeIndexLeafEntrySchemaDto }),
  }),
  z.object({
    type: z.literal('branch'),
    children: readonlyArraySchema({ elementSchema: HizoFSInodeIndexBranchChildSchemaDto }),
  }),
]);

export type HizoFSInodeIndexPageDto = z.infer<
  typeof HizoFSInodeIndexPageSchemaDto
>;

export const HizoFSDirectoryIndexBranchChildSchemaDto = z.object({
  upperBoundName: z.string(),
  childPageObjectId: z.string(),
});

export type HizoFSDirectoryIndexBranchChildDto = z.infer<
  typeof HizoFSDirectoryIndexBranchChildSchemaDto
>;

export const HizoFSDirectoryIndexPageSchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('leaf'),
    entries: readonlyArraySchema({ elementSchema: HizoFSDirectoryEntrySchemaDto }),
  }),
  z.object({
    type: z.literal('branch'),
    children: readonlyArraySchema({ elementSchema: HizoFSDirectoryIndexBranchChildSchemaDto }),
  }),
]);

export type HizoFSDirectoryIndexPageDto = z.infer<
  typeof HizoFSDirectoryIndexPageSchemaDto
>;

export const HizoFSSubvolumeMountSchemaDto = z.object({
  mountId: z.string(),
  subvolumeDescriptorObjectId: z.string(),
  parentDirectoryNodeId: z.string(),
  entryName: z.string(),
});

export type HizoFSSubvolumeMountDto = z.infer<
  typeof HizoFSSubvolumeMountSchemaDto
>;

export const HizoFSSubvolumeMountIndexBranchChildSchemaDto = z.object({
  upperBoundMountId: z.string(),
  childPageObjectId: z.string(),
});

export type HizoFSSubvolumeMountIndexBranchChildDto = z.infer<
  typeof HizoFSSubvolumeMountIndexBranchChildSchemaDto
>;

export const HizoFSSubvolumeMountIndexPageSchemaDto = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('leaf'),
      mounts: readonlyArraySchema({ elementSchema: HizoFSSubvolumeMountSchemaDto }),
    }),
    z.object({
      type: z.literal('branch'),
      children: readonlyArraySchema({ elementSchema: HizoFSSubvolumeMountIndexBranchChildSchemaDto }),
    }),
  ],
);

export type HizoFSSubvolumeMountIndexPageDto = z.infer<
  typeof HizoFSSubvolumeMountIndexPageSchemaDto
>;

export const HizoFSFileExtentSchemaDto = z.object({
  chunkIndex: z.number(),
  chunkObjectId: z.string(),
});

export type HizoFSFileExtentDto = z.infer<typeof HizoFSFileExtentSchemaDto>;

export const HizoFSFileExtentBranchChildSchemaDto = z.object({
  upperBoundChunkIndex: z.number(),
  childPageObjectId: z.string(),
});

export type HizoFSFileExtentBranchChildDto = z.infer<
  typeof HizoFSFileExtentBranchChildSchemaDto
>;

export const HizoFSFileExtentPageSchemaDto = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('leaf'),
    extents: readonlyArraySchema({ elementSchema: HizoFSFileExtentSchemaDto }),
  }),
  z.object({
    type: z.literal('branch'),
    children: readonlyArraySchema({ elementSchema: HizoFSFileExtentBranchChildSchemaDto }),
  }),
]);

export type HizoFSFileExtentPageDto = z.infer<
  typeof HizoFSFileExtentPageSchemaDto
>;

export const HizoFSFileChunkSchemaDto = z.object({});

export type HizoFSFileChunkDto = z.infer<typeof HizoFSFileChunkSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
