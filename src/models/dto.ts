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

export const HttpHeaderSchemaDto = z.tuple([z.string(), z.string()]);
export type HttpHeaderDto = z.infer<typeof HttpHeaderSchemaDto>;

export const EndpointSchemaDto = z.object({
  type: EndpointTypeSchemaDto,
  url: z.string().optional(),
  httpHeaders: z.array(HttpHeaderSchemaDto).optional(),
});
export type EndpointDto = z.infer<typeof EndpointSchemaDto>;

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
  id: z.string().uuid(),
  name: z.string(),
  updatedAt: z.number(),
  isCollapsed: z.boolean().default(false),

  endpoint: EndpointSchemaDto.optional(),
  modelId: z.string().optional(),
  systemPrompt: SystemPromptSchemaDto.optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});
export type ChatGroupDto = z.infer<typeof ChatGroupSchemaDto>;

// --- Hierarchy (Structural Source of Truth) ---

export const HierarchyChatNodeSchemaDto = z.object({
  type: z.literal('chat'),
  id: z.string().uuid(),
});

export const HierarchyChatGroupNodeSchemaDto = z.object({
  type: z.literal('chat_group'),
  id: z.string().uuid(),
  chat_ids: z.array(z.string().uuid()),
});

export const HierarchySchemaDto = z.object({
  items: z.array(z.union([
    HierarchyChatNodeSchemaDto,
    HierarchyChatGroupNodeSchemaDto
  ])),
});

export type HierarchyDto = z.infer<typeof HierarchySchemaDto>;

// --- Tree-based Message Structure (Recursive) ---

export const AttachmentStatusSchemaDto = z.enum(['persisted', 'memory', 'missing']);

export const AttachmentSchemaDto = z.object({
  id: z.string().uuid(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.number(),
  status: z.enum(['persisted', 'memory', 'missing']),
});
export type AttachmentDto = z.infer<typeof AttachmentSchemaDto>;

export const MessageNodeSchemaDto: z.ZodType<MessageNodeDto> = z.lazy(() => z.object({
  id: z.string().uuid(),
  role: RoleSchemaDto,
  content: z.string(),
  attachments: z.array(AttachmentSchemaDto).optional(),
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
  attachments?: AttachmentDto[];
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
 */
export const ChatMetaSchemaDto = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  currentLeafId: z.string().uuid().optional(),
  updatedAt: z.number(),
  createdAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),
  
  endpoint: EndpointSchemaDto.optional(),
  modelId: z.string().optional(),
  originChatId: z.string().uuid().optional(),
  originMessageId: z.string().uuid().optional(),

  systemPrompt: SystemPromptSchemaDto.optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});

export type ChatMetaDto = z.infer<typeof ChatMetaSchemaDto>;

/**
 * Chat Meta Index (Legacy/Bulk operations)
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
  currentLeafId: z.string().uuid().optional(),
});

export type ChatContentDto = z.infer<typeof ChatContentSchemaDto>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatSchemaDto = ChatMetaSchemaDto.extend({
  root: MessageBranchSchemaDto.optional(),
  currentLeafId: z.string().uuid().optional(),
  
  // Legacy support field
  messages: z.array(z.unknown()).optional(),
});

export type ChatDto = z.infer<typeof ChatSchemaDto>;

// --- Provider Profiles ---

export const ProviderProfileSchemaDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  endpoint: EndpointSchemaDto,
  defaultModelId: z.string().optional(),
  titleModelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});
export type ProviderProfileDto = z.infer<typeof ProviderProfileSchemaDto>;

export const SettingsSchemaDto = z.object({
  endpoint: EndpointSchemaDto,
  defaultModelId: z.string().optional(),
  titleModelId: z.string().optional(),
  autoTitleEnabled: z.boolean().default(true),
  storageType: StorageTypeSchemaDto,
  providerProfiles: z.array(ProviderProfileSchemaDto).optional().default([]),
  heavyContentAlertDismissed: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  lmParameters: LmParametersSchemaDto.optional(),
});
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;

/**
 * Migration Data Chunk
 * 
 * Represents a single unit of heavy data during storage migration.
 * Structural metadata (Settings, Hierarchy, Groups) are handled as 
 * complete domain objects during the restoration process.
 */
export type MigrationChunkDto = 
  | { type: 'chat'; data: ChatDto }
  | { 
      type: 'attachment'; 
      chatId: string; 
      attachmentId: string; 
      originalName: string; 
      mimeType: string;
      size: number;
      uploadedAt: number;
      blob: Blob 
    };