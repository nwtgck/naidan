import { z } from 'zod';

const BaseEntrySchemaDto = z.object({
  mode: z.number().int().min(0).max(0o7777),
  uid: z.number().optional(),
  gid: z.number().optional(),
  mtime: z.number().optional(),
});

export const SymlinkEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: z.literal('symlink'),
  targetPath: z.string(),
});

export const FifoEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: z.literal('fifo'),
});

export const CharDevEntrySchemaDto = BaseEntrySchemaDto.extend({
  type: z.literal('chardev'),
});

export const WeshRegistryEntrySchemaDto = z.discriminatedUnion('type', [
  SymlinkEntrySchemaDto,
  FifoEntrySchemaDto,
  CharDevEntrySchemaDto,
]);

export type WeshRegistryEntryDto = z.infer<typeof WeshRegistryEntrySchemaDto>;

// Constants for registry
export const REGISTRY_DIR_NAME = '.wesh-registry';
