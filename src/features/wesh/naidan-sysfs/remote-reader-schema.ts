import { z } from 'zod';
import { resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the DTO dependency with the storage service API.
import {
  BinaryObjectSchemaDto,
  ChatContentSchemaDto,
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
} from '@/00-storage/00-dto/dto';

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

export type NaidanSysfsRemoteChatMetaValue = NaidanSysfsRemoteValue<z.output<typeof ChatMetaSchemaDto>>;
export type NaidanSysfsRemoteChatContentValue = NaidanSysfsRemoteValue<z.output<typeof ChatContentSchemaDto>>;
export type NaidanSysfsRemoteChatGroupValue = NaidanSysfsRemoteValue<z.output<typeof ChatGroupSchemaDto>>;

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
  dto: ChatGroupSchemaDto,
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
  dto: ChatMetaSchemaDto,
  groupId: z.union([z.string().min(1), z.null(), z.undefined()]),
});

export const naidanSysfsRemoteChatContentPayloadSchema = ChatContentSchemaDto;

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
