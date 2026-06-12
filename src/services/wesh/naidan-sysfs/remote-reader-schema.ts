import { z } from 'zod'
import {
  BinaryObjectSchemaDto,
  ChatContentSchemaDto,
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
  EndpointSchemaDto,
  LmParametersSchemaDto,
  MountSchemaDto,
  SystemPromptSchemaDto,
} from '@/models/dto'

const orUndefined = <T extends z.ZodTypeAny>({ schema }: { schema: T }) => z.union([schema, z.undefined()])

export const naidanSysfsRemoteChatSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  updatedAt: z.number(),
  groupId: z.union([z.string().min(1), z.null(), z.undefined()]),
})

export const naidanSysfsRemoteChatSidebarItemSchema = z.object({
  id: z.string().min(1),
  type: z.literal('chat'),
  chat: naidanSysfsRemoteChatSummarySchema,
})

export const naidanSysfsRemoteChatGroupPayloadSchema = z.object({
  dto: ChatGroupSchemaDto.extend({
    endpoint: orUndefined({ schema: EndpointSchemaDto }),
    modelId: orUndefined({ schema: z.string() }),
    autoTitleEnabled: orUndefined({ schema: z.boolean() }),
    titleModelId: orUndefined({ schema: z.string() }),
    systemPrompt: orUndefined({ schema: SystemPromptSchemaDto }),
    lmParameters: orUndefined({ schema: LmParametersSchemaDto }),
    mounts: orUndefined({ schema: z.array(MountSchemaDto) }),
  }),
  items: z.array(naidanSysfsRemoteChatSidebarItemSchema),
})

export const naidanSysfsRemoteSidebarItemSchema = z.union([
  naidanSysfsRemoteChatSidebarItemSchema,
  z.object({
    id: z.string().min(1),
    type: z.literal('chat_group'),
    chatGroup: naidanSysfsRemoteChatGroupPayloadSchema,
  }),
])

export const naidanSysfsRemoteChatMetaPayloadSchema = z.object({
  dto: ChatMetaSchemaDto,
  groupId: z.union([z.string().min(1), z.null(), z.undefined()]),
})

export const naidanSysfsRemoteChatContentPayloadSchema = ChatContentSchemaDto

export const naidanSysfsRemoteBinaryObjectSchema = BinaryObjectSchemaDto.extend({
  name: z.union([z.string(), z.null()]),
})
