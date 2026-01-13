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

// --- Language Model Parameters ---

export const LmParametersSchemaDto = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxCompletionTokens: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  stop: z.array(z.string()).optional(),
});
export type LmParametersDto = z.infer<typeof LmParametersSchemaDto>;

export const SystemPromptSchemaDto = z.object({
  content: z.string(),
  behavior: z.enum(['override', 'append']),
});
export type SystemPromptDto = z.infer<typeof SystemPromptSchemaDto>;

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
  modelId: z.string().optional(),
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
  modelId?: string;
  replies: {
    items: MessageNodeDto[];
  };
};

/**
 * Chat Metadata
 * Contains all attributes except the heavy message tree.
 * Stored in a bundled file for fast sidebar rendering.
 */
export const ChatMetaSchemaDto = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  groupId: z.uuid().nullable().optional(),
  order: z.number().default(0),
  updatedAt: z.number(),
  createdAt: z.number(),
  modelId: z.string(),
  debugEnabled: z.boolean().optional().default(false),
  
  endpointType: EndpointTypeSchemaDto.optional(),
  endpointUrl: z.string().url().optional(),
  overrideModelId: z.string().optional(),
  originChatId: z.uuid().optional(),
  originMessageId: z.uuid().optional(),

  systemPrompt: SystemPromptSchemaDto.optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});

export type ChatMetaDto = z.infer<typeof ChatMetaSchemaDto>;

/**
 * Chat Meta Index
 * The top-level object stored in chat_metas.json.
 * Uses an object wrapper for better extensibility.
 */
export const ChatMetaIndexSchemaDto = z.object({
  entries: z.array(ChatMetaSchemaDto),
});

export type ChatMetaIndexDto = z.infer<typeof ChatMetaIndexSchemaDto>;

/**
 * Chat Content
 * Contains the heavy message tree structure.
 * Stored in individual files to scale.
 */
export const ChatContentSchemaDto = z.object({
  root: MessageBranchSchemaDto,
  currentLeafId: z.uuid().optional(),
});

export type ChatContentDto = z.infer<typeof ChatContentSchemaDto>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatSchemaDto = ChatMetaSchemaDto.extend({
  root: MessageBranchSchemaDto.optional(),
  currentLeafId: z.uuid().optional(),
  
  // Legacy support field
  messages: z.array(z.unknown()).optional(),
});

export type ChatDto = z.infer<typeof ChatSchemaDto>;

// --- Provider Profiles ---

export const ProviderProfileSchemaDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  endpointType: EndpointTypeSchemaDto,
  endpointUrl: z.string().optional(),
  defaultModelId: z.string().optional(),
  titleModelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});
export type ProviderProfileDto = z.infer<typeof ProviderProfileSchemaDto>;

export const SettingsSchemaDto = z.object({
  endpointType: EndpointTypeSchemaDto,
  endpointUrl: z.string().optional(),
  defaultModelId: z.string().optional(),
  titleModelId: z.string().optional(),
  autoTitleEnabled: z.boolean().default(true),
  storageType: StorageTypeSchemaDto,
  providerProfiles: z.array(ProviderProfileSchemaDto).optional().default([]),
  systemPrompt: z.string().optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;

/**
 * Migration Data Chunk
 * 
 * Represents a single unit of data during storage migration.
 * Still uses ChatDto (Combined) for simplicity during export/import processes.
 */
export type MigrationChunkDto =
  | { type: 'settings'; data: SettingsDto }
  | { type: 'group'; data: ChatGroupDto }
  | { type: 'chat'; data: ChatDto };