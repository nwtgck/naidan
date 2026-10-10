import * as dtozod from '@/utils/dtozod';

const BaseEntrySchemaDto = dtozod.object({
  mode: dtozod.number(),
  uid: dtozod.number().optional(),
  gid: dtozod.number().optional(),
  mtime: dtozod.number().optional(),
});

export const SymlinkEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: dtozod.literal('symlink'),
  targetPath: dtozod.string(),
});

export const FifoEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: dtozod.literal('fifo'),
});

export const CharDevEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: dtozod.literal('chardev'),
});

export const WeshRegistryEntrySchemaDto = dtozod.discriminatedUnion('type', [
  SymlinkEntrySchemaDto,
  FifoEntrySchemaDto,
  CharDevEntrySchemaDto,
]);

export type WeshRegistryEntryDto = dtozod.infer<typeof WeshRegistryEntrySchemaDto>;

// Constants for system data
export const WESH_SYSTEM_DIR = '.wesh-system';
export const METADATA_DIR = 'metadata';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
