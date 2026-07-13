import { z } from 'zod';

export type EncryptedOpfsDescriptorDto = {
  readonly formatVersion: 1;
  readonly fileSystemId: string;
};

export const EncryptedOpfsDescriptorSchemaDto: z.ZodType<EncryptedOpfsDescriptorDto> = z.object({
  formatVersion: z.literal(1),
  fileSystemId: z.string(),
});

export type EncryptedOpfsSuperblockDto = {
  readonly sequence: number;
  readonly fileSystemId: string;
  readonly activeCommitObjectId: string;
};

export const EncryptedOpfsSuperblockSchemaDto: z.ZodType<EncryptedOpfsSuperblockDto> = z.object({
  sequence: z.number(),
  fileSystemId: z.string(),
  activeCommitObjectId: z.string(),
});

export type EncryptedOpfsCommitDto = {
  readonly revision: number;
  readonly rootDirectoryNodeId: string;
  readonly inodeIndexRootObjectId: string;
};

export const EncryptedOpfsCommitSchemaDto: z.ZodType<EncryptedOpfsCommitDto> = z.object({
  revision: z.number(),
  rootDirectoryNodeId: z.string(),
  inodeIndexRootObjectId: z.string(),
});

export type EncryptedOpfsNodeKindDto =
  | 'file'
  | 'directory'
  | 'symlink';

export const EncryptedOpfsNodeKindSchemaDto: z.ZodType<EncryptedOpfsNodeKindDto> = z.enum([
  'file',
  'directory',
  'symlink',
]);

export type EncryptedOpfsDirectoryEntryDto = {
  readonly name: string;
  readonly kind: EncryptedOpfsNodeKindDto;
  readonly nodeId: string;
};

export const EncryptedOpfsDirectoryEntrySchemaDto: z.ZodType<EncryptedOpfsDirectoryEntryDto> = z.object({
  name: z.string(),
  kind: EncryptedOpfsNodeKindSchemaDto,
  nodeId: z.string(),
});

export type EncryptedOpfsInlineFileStorageDto = {
  readonly type: 'inline';
};

export type EncryptedOpfsExtentFileStorageDto = {
  readonly type: 'extents';
  readonly chunkSize: number;
  readonly extentIndexRootObjectId: string;
};

export type EncryptedOpfsFileStorageDto =
  | EncryptedOpfsInlineFileStorageDto
  | EncryptedOpfsExtentFileStorageDto;

export const EncryptedOpfsFileStorageSchemaDto: z.ZodType<EncryptedOpfsFileStorageDto> =
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

export type EncryptedOpfsFileInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly size: number;
  readonly storage: EncryptedOpfsFileStorageDto;
};

export const EncryptedOpfsFileInodeSchemaDto: z.ZodType<EncryptedOpfsFileInodeDto> = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  size: z.number(),
  storage: EncryptedOpfsFileStorageSchemaDto,
});

export type EncryptedOpfsInlineDirectoryStorageDto = {
  readonly type: 'inline';
  readonly entries: readonly EncryptedOpfsDirectoryEntryDto[];
};

export type EncryptedOpfsIndexedDirectoryStorageDto = {
  readonly type: 'indexed';
  readonly directoryIndexRootObjectId: string;
};

export type EncryptedOpfsDirectoryStorageDto =
  | EncryptedOpfsInlineDirectoryStorageDto
  | EncryptedOpfsIndexedDirectoryStorageDto;

export const EncryptedOpfsDirectoryStorageSchemaDto: z.ZodType<EncryptedOpfsDirectoryStorageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('inline'),
      entries: z.array(EncryptedOpfsDirectoryEntrySchemaDto),
    }),
    z.object({
      type: z.literal('indexed'),
      directoryIndexRootObjectId: z.string(),
    }),
  ]);

export type EncryptedOpfsDirectoryInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly storage: EncryptedOpfsDirectoryStorageDto;
};

export const EncryptedOpfsDirectoryInodeSchemaDto: z.ZodType<EncryptedOpfsDirectoryInodeDto> =
  z.object({
    nodeId: z.string(),
    revision: z.number(),
    createdAt: z.number().nullable(),
    modifiedAt: z.number().nullable(),
    storage: EncryptedOpfsDirectoryStorageSchemaDto,
  });

export type EncryptedOpfsSymlinkInodeDto = {
  readonly nodeId: string;
  readonly revision: number;
  readonly createdAt: number | null;
  readonly modifiedAt: number | null;
  readonly target: string;
};

export const EncryptedOpfsSymlinkInodeSchemaDto: z.ZodType<EncryptedOpfsSymlinkInodeDto> = z.object({
  nodeId: z.string(),
  revision: z.number(),
  createdAt: z.number().nullable(),
  modifiedAt: z.number().nullable(),
  target: z.string(),
});

export type EncryptedOpfsInodeIndexLeafEntryDto = {
  readonly nodeId: string;
  readonly inodeObjectId: string;
};

export const EncryptedOpfsInodeIndexLeafEntrySchemaDto: z.ZodType<
  EncryptedOpfsInodeIndexLeafEntryDto
> = z.object({
  nodeId: z.string(),
  inodeObjectId: z.string(),
});

export type EncryptedOpfsInodeIndexBranchChildDto = {
  readonly upperBoundNodeId: string;
  readonly childPageObjectId: string;
};

export const EncryptedOpfsInodeIndexBranchChildSchemaDto: z.ZodType<
  EncryptedOpfsInodeIndexBranchChildDto
> = z.object({
  upperBoundNodeId: z.string(),
  childPageObjectId: z.string(),
});

export type EncryptedOpfsInodeIndexPageDto =
  | {
      readonly type: 'leaf';
      readonly entries: readonly EncryptedOpfsInodeIndexLeafEntryDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly EncryptedOpfsInodeIndexBranchChildDto[];
    };

export const EncryptedOpfsInodeIndexPageSchemaDto: z.ZodType<EncryptedOpfsInodeIndexPageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      entries: z.array(EncryptedOpfsInodeIndexLeafEntrySchemaDto),
    }),
    z.object({
      type: z.literal('branch'),
      children: z.array(EncryptedOpfsInodeIndexBranchChildSchemaDto),
    }),
  ]);

export type EncryptedOpfsDirectoryIndexBranchChildDto = {
  readonly upperBoundName: string;
  readonly childPageObjectId: string;
};

export const EncryptedOpfsDirectoryIndexBranchChildSchemaDto: z.ZodType<
  EncryptedOpfsDirectoryIndexBranchChildDto
> = z.object({
  upperBoundName: z.string(),
  childPageObjectId: z.string(),
});

export type EncryptedOpfsDirectoryIndexPageDto =
  | {
      readonly type: 'leaf';
      readonly entries: readonly EncryptedOpfsDirectoryEntryDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly EncryptedOpfsDirectoryIndexBranchChildDto[];
    };

export const EncryptedOpfsDirectoryIndexPageSchemaDto: z.ZodType<
  EncryptedOpfsDirectoryIndexPageDto
> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('leaf'),
    entries: z.array(EncryptedOpfsDirectoryEntrySchemaDto),
  }),
  z.object({
    type: z.literal('branch'),
    children: z.array(EncryptedOpfsDirectoryIndexBranchChildSchemaDto),
  }),
]);

export type EncryptedOpfsFileExtentDto = {
  readonly chunkIndex: number;
  readonly chunkObjectId: string;
};

export const EncryptedOpfsFileExtentSchemaDto: z.ZodType<EncryptedOpfsFileExtentDto> = z.object({
  chunkIndex: z.number(),
  chunkObjectId: z.string(),
});

export type EncryptedOpfsFileExtentBranchChildDto = {
  readonly upperBoundChunkIndex: number;
  readonly childPageObjectId: string;
};

export const EncryptedOpfsFileExtentBranchChildSchemaDto: z.ZodType<
  EncryptedOpfsFileExtentBranchChildDto
> = z.object({
  upperBoundChunkIndex: z.number(),
  childPageObjectId: z.string(),
});

export type EncryptedOpfsFileExtentPageDto =
  | {
      readonly type: 'leaf';
      readonly extents: readonly EncryptedOpfsFileExtentDto[];
    }
  | {
      readonly type: 'branch';
      readonly children: readonly EncryptedOpfsFileExtentBranchChildDto[];
    };

export const EncryptedOpfsFileExtentPageSchemaDto: z.ZodType<EncryptedOpfsFileExtentPageDto> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      extents: z.array(EncryptedOpfsFileExtentSchemaDto),
    }),
    z.object({
      type: z.literal('branch'),
      children: z.array(EncryptedOpfsFileExtentBranchChildSchemaDto),
    }),
  ]);

export type EncryptedOpfsFileChunkDto = {
  readonly nodeId: string;
  readonly chunkIndex: number;
};

export const EncryptedOpfsFileChunkSchemaDto: z.ZodType<EncryptedOpfsFileChunkDto> = z.object({
  nodeId: z.string(),
  chunkIndex: z.number(),
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
