import * as dtozod from '@/utils/dtozod';

const BaseEntryDtoSchema = dtozod.object({
  mode: dtozod.number(),
  uid: dtozod.number().optional(),
  gid: dtozod.number().optional(),
  mtime: dtozod.number().optional(),
});

export const SymlinkEntryDtoSchema = BaseEntryDtoSchema.extend({
  type: dtozod.literal('symlink'),
  targetPath: dtozod.string(),
});

export const FifoEntryDtoSchema = BaseEntryDtoSchema.extend({
  type: dtozod.literal('fifo'),
});

export const CharDevEntryDtoSchema = BaseEntryDtoSchema.extend({
  type: dtozod.literal('chardev'),
});

export const WeshRegistryEntryDtoSchema = dtozod.discriminatedUnion('type', [
  SymlinkEntryDtoSchema,
  FifoEntryDtoSchema,
  CharDevEntryDtoSchema,
]);

export type WeshRegistryEntryDto = dtozod.infer<typeof WeshRegistryEntryDtoSchema>;

// Constants for system data
export const WESH_SYSTEM_DIR = '.wesh-system';
export const METADATA_DIR = 'metadata';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
