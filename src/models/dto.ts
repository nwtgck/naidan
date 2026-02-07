/**
 * DTO (Data Transfer Objects) Definitions
 */
import { z } from 'zod';

export const RoleSchemaDto = z.enum(['user', 'assistant', 'system']);
export type RoleDto = z.infer<typeof RoleSchemaDto>;

export const StorageTypeSchemaDto = z.enum(['local', 'opfs']);
export type StorageTypeDto = z.infer<typeof StorageTypeSchemaDto>;

export const HttpHeaderSchemaDto = z.tuple([z.string(), z.string()]);
export type HttpHeaderDto = z.infer<typeof HttpHeaderSchemaDto>;

export const HttpEndpointSchemaDto = z.object({
  type: z.enum(['openai', 'ollama']),
  url: z.string(),
  httpHeaders: z.array(HttpHeaderSchemaDto).optional(),
});

export const TransformersJsEndpointSchemaDto = z.object({
  type: z.literal('transformers_js'),
});

export const EndpointSchemaDto = z.discriminatedUnion('type', [
  HttpEndpointSchemaDto,
  TransformersJsEndpointSchemaDto,
]);

export type EndpointDto = z.infer<typeof EndpointSchemaDto>;
export type EndpointTypeDto = EndpointDto['type'];

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

export const SystemPromptSchemaDto = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('override'),
    content: z.string().nullable(),
  }),
  z.object({
    behavior: z.literal('append'),
    content: z.string(),
  }),
]);
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

export const BinaryObjectSchemaDto = z.object({
  id: z.string().uuid(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.number(),
  name: z.string().optional(),
});
export type BinaryObjectDto = z.infer<typeof BinaryObjectSchemaDto>;

/**
 * Shard Index
 * Stores metadata for all binary objects within a specific shard.
 */
export const BinaryShardIndexSchemaDto = z.object({
  objects: z.record(z.string().uuid(), BinaryObjectSchemaDto),
});
export type BinaryShardIndexDto = z.infer<typeof BinaryShardIndexSchemaDto>;

export const AttachmentSchemaDtoV1 = z.object({
  id: z.string().uuid(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.number(),
  status: AttachmentStatusSchemaDto,
});

export const AttachmentSchemaDtoV2 = z.object({
  id: z.string().uuid(),
  binaryObjectId: z.string().uuid(),
  name: z.string(),
  status: AttachmentStatusSchemaDto,
});

export const AttachmentSchemaDto = z.union([
  AttachmentSchemaDtoV2,
  AttachmentSchemaDtoV1,
]);
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
      type: 'binary_object'; 
      id: string; // The binaryObjectId
      name: string; 
      mimeType: string;
      size: number;
      createdAt: number;
      blob: Blob 
    };

/**
 * Migration State
 * Tracks completed data migrations to ensure they only run once.
 */
export const MigrationStateSchemaDto = z.object({
  completedMigrations: z.array(z.object({
    name: z.string(),
    completedAt: z.number(),
  })),
});
export type MigrationStateDto = z.infer<typeof MigrationStateSchemaDto>;