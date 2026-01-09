/**
 * DTO (Data Transfer Objects) Definitions
 */
import { z } from 'zod';

export const RoleSchemaDto = z.enum(['user', 'assistant', 'system']);
export type RoleDto = z.infer<typeof RoleSchemaDto>;

export const StorageTypeSchemaDto = z.enum(['local', 'opfs']);
export type StorageTypeDto = z.infer<typeof StorageTypeSchemaDto>;

export const EndpointTypeSchemaDto = z.enum(['openai', 'ollama']);
export type EndpointTypeDto = z.infer<typeof EndpointTypeSchemaDto>;

// --- Grouping ---

export const ChatGroupSchemaDto = z.object({
  id: z.uuid(),
  name: z.string(),
  order: z.number(),
  updatedAt: z.number(),
  isCollapsed: z.boolean().default(false),
});
export type ChatGroupDto = z.infer<typeof ChatGroupSchemaDto>;

// --- Tree-based Message Structure (Recursive) ---

export const MessageNodeSchemaDto: z.ZodType<MessageNodeDto> = z.lazy(() => z.object({
  id: z.uuid(),
  role: RoleSchemaDto,
  content: z.string(),
  timestamp: z.number(),
  thinking: z.string().optional(),
  replies: MessageBranchSchemaDto,
}));

export const MessageBranchSchemaDto = z.object({
  items: z.array(MessageNodeSchemaDto),
});

export type MessageNodeDto = {
  id: string;
  role: RoleDto;
  content: string;
  timestamp: number;
  thinking?: string;
  replies: {
    items: MessageNodeDto[];
  };
};

export const ChatSchemaDto = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  groupId: z.uuid().nullable().optional(), // Link to a group
  order: z.number().default(0), // New: for manual sorting
  root: MessageBranchSchemaDto.optional().default({ items: [] }),
  currentLeafId: z.uuid().optional(),
  
  // Legacy support field
  messages: z.array(z.unknown()).optional(),

  modelId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),
  
  endpointType: EndpointTypeSchemaDto.optional(),
  endpointUrl: z.string().url().optional(),
  overrideModelId: z.string().optional(),
  originChatId: z.uuid().optional(),
  originMessageId: z.uuid().optional(),
});

export type ChatDto = z.infer<typeof ChatSchemaDto>;

export const SettingsSchemaDto = z.object({
  endpointType: EndpointTypeSchemaDto,
  endpointUrl: z.string().url(),
  defaultModelId: z.string().optional(),
  titleModelId: z.string().optional(),
  autoTitleEnabled: z.boolean().default(true),
  storageType: StorageTypeSchemaDto,
});
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;
