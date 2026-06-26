import { z } from 'zod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/lib/zod/missingAsUndefined';
import {
  BinaryObjectSchemaDto,
  ChatContentSchemaDto,
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
  EndpointSchemaDto,
  LmParametersSchemaDto,
  MountSchemaDto,
  SystemPromptSchemaDto,
} from '@/models/dto';

// Keep the existing local helper name so this remote schema diff stays focused
// on the Zod 4.4 missing-key semantics rather than a broad rename.
const orUndefined = missingAsUndefined;

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
  dto: ChatGroupSchemaDto.safeExtend({
    endpoint: orUndefined(EndpointSchemaDto),
    modelId: orUndefined(z.string()),
    autoTitleEnabled: orUndefined(z.boolean()),
    titleModelId: orUndefined(z.string()),
    systemPrompt: orUndefined(SystemPromptSchemaDto),
    lmParameters: orUndefined(LmParametersSchemaDto),
    mounts: orUndefined(z.array(MountSchemaDto)),
  }),
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
