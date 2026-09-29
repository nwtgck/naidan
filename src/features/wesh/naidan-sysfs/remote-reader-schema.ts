import { z } from 'zod';
import { resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the DTO dependency with the storage service API.
import {
  BinaryObjectSchemaDto,
  ChatContentSchemaDto,
  ChatGroupSchemaDtoV2,
  ChatMetaSchemaDtoV2,
  MessageBranchSchemaDtoV2,
} from '@/00-storage/00-dto/dto';

// Sysfs exposes the current representation. Legacy persistence readers remain
// separate; transferring a chat does not rewrite its saved V1 record.
export const naidanSysfsRemoteChatContentPayloadSchema = resolveMissingAsUndefined(z.object({
  ...ChatContentSchemaDto.shape,
  root: MessageBranchSchemaDtoV2,
}));

/**
 * Persistence DTOs can carry forward-compatibility metadata on non-enumerable
 * `unreadable` properties. Structured clone does not copy those properties.
 * These types describe the value observable in the receiving realm without
 * changing persistence DTO contracts or adding a runtime projection/copy.
 */
type NaidanSysfsRemoteExperimentalValue<T> =
  T extends object
    ? {
      [TKey in keyof T as TKey extends 'unreadable' ? never : TKey]:
      NaidanSysfsRemoteValue<T[TKey]>
    }
    : T;

type NaidanSysfsRemoteValue<T> =
  T extends readonly unknown[]
    ? { [TKey in keyof T]: NaidanSysfsRemoteValue<T[TKey]> }
    : T extends object
      ? {
        [TKey in keyof T]: TKey extends 'experimental'
          ? NaidanSysfsRemoteExperimentalValue<T[TKey]>
          : NaidanSysfsRemoteValue<T[TKey]>
      }
      : T;

export type NaidanSysfsRemoteChatMetaValue = NaidanSysfsRemoteValue<z.output<typeof ChatMetaSchemaDtoV2>>;
export type NaidanSysfsRemoteChatContentValue = NaidanSysfsRemoteValue<z.output<typeof naidanSysfsRemoteChatContentPayloadSchema>>;
export type NaidanSysfsRemoteChatGroupValue = NaidanSysfsRemoteValue<z.output<typeof ChatGroupSchemaDtoV2>>;

export const naidanSysfsRemoteChatSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  updatedAt: z.number(),
  groupId: z.union([z.string().min(1), z.null(), z.undefined()]),
});

export const naidanSysfsRemoteChatSidebarItemSchema = z.object({
  id: z.string().min(1),
  type: z.literal('chat'),
  chat: naidanSysfsRemoteChatSummarySchema,
});

export const naidanSysfsRemoteChatGroupPayloadSchema = z.object({
  dto: ChatGroupSchemaDtoV2,
  items: z.array(naidanSysfsRemoteChatSidebarItemSchema),
});

export const naidanSysfsRemoteSidebarItemSchema = z.union([
  naidanSysfsRemoteChatSidebarItemSchema,
  z.object({
    id: z.string().min(1),
    type: z.literal('chat_group'),
    chatGroup: naidanSysfsRemoteChatGroupPayloadSchema,
  }),
]);

export const naidanSysfsRemoteChatMetaPayloadSchema = z.object({
  dto: ChatMetaSchemaDtoV2,
  groupId: z.union([z.string().min(1), z.null(), z.undefined()]),
});

export const naidanSysfsRemoteChatPayloadSchema = z.object({
  metadata: naidanSysfsRemoteChatMetaPayloadSchema,
  content: naidanSysfsRemoteChatContentPayloadSchema,
});

export const naidanSysfsRemoteBinaryObjectSchema = resolveMissingAsUndefined(z.object({
  ...BinaryObjectSchemaDto.shape,
  name: z.union([z.string(), z.null()]),
}));

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
