import { z } from 'zod';

export type HizoFSDescriptorDto = {
  readonly format: 'hizofs';
  readonly formatVersion: 1;
  readonly fileSystemId: string;
};

export const HizoFSDescriptorSchemaDto: z.ZodType<HizoFSDescriptorDto> = z.object({
  format: z.literal('hizofs'),
  formatVersion: z.literal(1),
  fileSystemId: z.string(),
});

export type HizoFSSuperblockDto = {
  readonly sequence: number;
  readonly fileSystemId: string;
  readonly activeCommitObjectId: string;
};

export const HizoFSSuperblockSchemaDto: z.ZodType<HizoFSSuperblockDto> = z.object({
  sequence: z.number(),
  fileSystemId: z.string(),
  activeCommitObjectId: z.string(),
});

export type HizoFSCommitDto = {
  readonly revision: number;
  readonly rootDirectoryNodeId: string;
  readonly inodeIndexRootObjectId: string;
};

export const HizoFSCommitSchemaDto: z.ZodType<HizoFSCommitDto> = z.object({
  revision: z.number(),
  rootDirectoryNodeId: z.string(),
  inodeIndexRootObjectId: z.string(),
});

export type HizoFSNodeKindDto =
  | 'file'
  | 'directory'
  | 'symlink';

export const HizoFSNodeKindSchemaDto: z.ZodType<HizoFSNodeKindDto> = z.enum([
  'file',
  'directory',
  'symlink',
]);

export type HizoFSDirectoryEntryDto = {
  readonly name: string;
  readonly kind: HizoFSNodeKindDto;
  readonly nodeId: string;
};

export const HizoFSDirectoryEntrySchemaDto: z.ZodType<HizoFSDirectoryEntryDto> = z.object({
  name: z.string(),
  kind: HizoFSNodeKindSchemaDto,
  nodeId: z.string(),
});

export type HizoFSInlineFileStorageDto = {
  readonly type: 'inline';
};

export type HizoFSExtentFileStorageDto = {
  readonly type: 'extents';
  readonly chunkSize: number;
  readonly extentIndexRootObjectId: string;
};

export type HizoFSFileStorageDto =
  | HizoFSInlineFileStorageDto
  | HizoFSExtentFileStorageDto;

export const HizoFSFileStorageSchemaDto: z.ZodType<HizoFSFileStorageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('inline'),
    }),
    z.object({
      type: z.literal('extents'),
      chunkSize: z.number(),
      extentIndexRootObjectId: z.string(),
    }),
  ]);

export type HizoFSFileInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly size: number;
  readonly storage: HizoFSFileStorageDto;
};

export const HizoFSFileInodeSchemaDto: z.ZodType<HizoFSFileInodeDto> = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  size: z.number(),
  storage: HizoFSFileStorageSchemaDto,
});

export type HizoFSInlineDirectoryStorageDto = {
  readonly type: 'inline';
  readonly entries: readonly HizoFSDirectoryEntryDto[];
};

export type HizoFSIndexedDirectoryStorageDto = {
  readonly type: 'indexed';
  readonly directoryIndexRootObjectId: string;
};

export type HizoFSDirectoryStorageDto =
  | HizoFSInlineDirectoryStorageDto
  | HizoFSIndexedDirectoryStorageDto;

export const HizoFSDirectoryStorageSchemaDto: z.ZodType<HizoFSDirectoryStorageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('inline'),
      entries: z.array(HizoFSDirectoryEntrySchemaDto),
    }),
    z.object({
      type: z.literal('indexed'),
      directoryIndexRootObjectId: z.string(),
    }),
  ]);

export type HizoFSDirectoryInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly storage: HizoFSDirectoryStorageDto;
};

export const HizoFSDirectoryInodeSchemaDto: z.ZodType<HizoFSDirectoryInodeDto> =
  z.object({
    nodeId: z.string(),
    revision: z.number(),
    createdAt: z.number().nullable(),
    modifiedAt: z.number().nullable(),
    storage: HizoFSDirectoryStorageSchemaDto,
  });

export type HizoFSSymlinkInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly target: string;
};

export const HizoFSSymlinkInodeSchemaDto: z.ZodType<HizoFSSymlinkInodeDto> = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  target: z.string(),
});

export type HizoFSInodeIndexLeafEntryDto = {
  readonly nodeId: string;
  readonly inodeObjectId: string;
};

export const HizoFSInodeIndexLeafEntrySchemaDto: z.ZodType<
  HizoFSInodeIndexLeafEntryDto
> = z.object({
  nodeId: z.string(),
  inodeObjectId: z.string(),
});

export type HizoFSInodeIndexBranchChildDto = {
  readonly upperBoundNodeId: string;
  readonly childPageObjectId: string;
};

export const HizoFSInodeIndexBranchChildSchemaDto: z.ZodType<
  HizoFSInodeIndexBranchChildDto
> = z.object({
  upperBoundNodeId: z.string(),
  childPageObjectId: z.string(),
});

export type HizoFSInodeIndexPageDto =
  | {
      readonly type: 'leaf';
      readonly entries: readonly HizoFSInodeIndexLeafEntryDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly HizoFSInodeIndexBranchChildDto[];
    };

export const HizoFSInodeIndexPageSchemaDto: z.ZodType<HizoFSInodeIndexPageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      entries: z.array(HizoFSInodeIndexLeafEntrySchemaDto),
    }),
    z.object({
      type: z.literal('branch'),
      children: z.array(HizoFSInodeIndexBranchChildSchemaDto),
    }),
  ]);

export type HizoFSDirectoryIndexBranchChildDto = {
  readonly upperBoundName: string;
  readonly childPageObjectId: string;
};

export const HizoFSDirectoryIndexBranchChildSchemaDto: z.ZodType<
  HizoFSDirectoryIndexBranchChildDto
> = z.object({
  upperBoundName: z.string(),
  childPageObjectId: z.string(),
});

export type HizoFSDirectoryIndexPageDto =
  | {
      readonly type: 'leaf';
      readonly entries: readonly HizoFSDirectoryEntryDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly HizoFSDirectoryIndexBranchChildDto[];
    };

export const HizoFSDirectoryIndexPageSchemaDto: z.ZodType<
  HizoFSDirectoryIndexPageDto
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('leaf'),
    entries: z.array(HizoFSDirectoryEntrySchemaDto),
  }),
  z.object({
    type: z.literal('branch'),
    children: z.array(HizoFSDirectoryIndexBranchChildSchemaDto),
  }),
]);

export type HizoFSFileExtentDto = {
  readonly chunkIndex: number;
  readonly chunkObjectId: string;
};

export const HizoFSFileExtentSchemaDto: z.ZodType<HizoFSFileExtentDto> = z.object({
  chunkIndex: z.number(),
  chunkObjectId: z.string(),
});

export type HizoFSFileExtentBranchChildDto = {
  readonly upperBoundChunkIndex: number;
  readonly childPageObjectId: string;
};

export const HizoFSFileExtentBranchChildSchemaDto: z.ZodType<
  HizoFSFileExtentBranchChildDto
> = z.object({
  upperBoundChunkIndex: z.number(),
  childPageObjectId: z.string(),
});

export type HizoFSFileExtentPageDto =
  | {
      readonly type: 'leaf';
      readonly extents: readonly HizoFSFileExtentDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly HizoFSFileExtentBranchChildDto[];
    };

export const HizoFSFileExtentPageSchemaDto: z.ZodType<HizoFSFileExtentPageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      extents: z.array(HizoFSFileExtentSchemaDto),
    }),
    z.object({
      type: z.literal('branch'),
      children: z.array(HizoFSFileExtentBranchChildSchemaDto),
    }),
  ]);

export type HizoFSFileChunkDto = Record<string, never>;

export const HizoFSFileChunkSchemaDto: z.ZodType<HizoFSFileChunkDto> =
  z.object({}).strict();

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
