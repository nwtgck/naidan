/**
 * DTO (Data Transfer Objects) Definitions
 *
 * NOTE: Prefer explicit DTO keys with `T | undefined` output over optional output keys.
 * This ensures that when adding new properties, all call sites are forced to acknowledge them,
 * reducing the risk of missing updates. Use `missingAsUndefined(...)` for persisted fields
 * that must accept missing legacy JSON keys while materializing `key: undefined` after parse.
 * Alternatively, use .default() if a sensible non-undefined default exists.
 */
import { z } from 'zod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/lib/zod/missingAsUndefined';

export const RoleSchemaDto = z.enum(['user', 'assistant', 'system', 'tool']);
export type RoleDto = z.infer<typeof RoleSchemaDto>;

export const StorageTypeSchemaDto = z.enum(['local', 'opfs', 'memory']);
export type StorageTypeDto = z.infer<typeof StorageTypeSchemaDto>;

export const HttpHeaderSchemaDto = z.tuple([z.string(), z.string()]);
export type HttpHeaderDto = z.infer<typeof HttpHeaderSchemaDto>;

export const HttpEndpointSchemaDto = resolveMissingAsUndefined(z.object({
  type: z.enum(['openai', 'ollama']),
  url: z.string(),
  httpHeaders: missingAsUndefined(z.array(HttpHeaderSchemaDto)),
}));

export const TransformersJsEndpointSchemaDto = z.object({
  type: z.literal('transformers_js'),
});

export const EndpointSchemaDto = resolveMissingAsUndefined(z.discriminatedUnion('type', [
  HttpEndpointSchemaDto,
  TransformersJsEndpointSchemaDto,
]));

export type EndpointDto = z.infer<typeof EndpointSchemaDto>;
export type EndpointTypeDto = EndpointDto['type'];

// --- Language Model Parameters ---

export const ReasoningEffortSchemaDto = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningEffortDto = z.infer<typeof ReasoningEffortSchemaDto>;

export const ReasoningSchemaDto = resolveMissingAsUndefined(z.object({
  effort: missingAsUndefined(ReasoningEffortSchemaDto),
}));
export type ReasoningDto = z.infer<typeof ReasoningSchemaDto>;

export const LmParametersSchemaDto = resolveMissingAsUndefined(z.object({
  temperature: missingAsUndefined(z.number()),
  topP: missingAsUndefined(z.number()),
  maxCompletionTokens: missingAsUndefined(z.number()),
  presencePenalty: missingAsUndefined(z.number()),
  frequencyPenalty: missingAsUndefined(z.number()),
  stop: missingAsUndefined(z.array(z.string())),
  reasoning: missingAsUndefined(ReasoningSchemaDto),
}));
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

// --- Volume Management & Mounts ---
// User-facing label: "Folder". All internal identifiers use "volume".

export const VolumeTypeSchemaDto = z.enum(['opfs', 'host']);
export type VolumeTypeDto = z.infer<typeof VolumeTypeSchemaDto>;

const VolumeBaseSchemaDto = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
});

export const VolumeOpfsSchemaDto = VolumeBaseSchemaDto.extend({
  type: z.literal('opfs'),
});

export const VolumeHostSchemaDto = VolumeBaseSchemaDto.extend({
  type: z.literal('host'),
});

export const VolumeSchemaDto = z.discriminatedUnion('type', [
  VolumeOpfsSchemaDto,
  VolumeHostSchemaDto,
]);
export type VolumeDto = z.infer<typeof VolumeSchemaDto>;

export const VolumeIndexSchemaDto = z.object({
  volumes: z.record(z.string(), VolumeSchemaDto),
});
export type VolumeIndexDto = z.infer<typeof VolumeIndexSchemaDto>;

export const MountVolumeSchemaDto = z.object({
  type: z.literal('volume'),
  volumeId: z.string(),
  mountPath: z.string(),
  readOnly: z.boolean(),
});

export const MountSchemaDto = z.discriminatedUnion('type', [
  MountVolumeSchemaDto,
]);
export type MountDto = z.infer<typeof MountSchemaDto>;

// --- Grouping ---

export const ChatGroupSchemaDto = resolveMissingAsUndefined(z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.number(),
  isCollapsed: z.boolean().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(z.string()),
  autoTitleEnabled: missingAsUndefined(z.boolean()),
  titleModelId: missingAsUndefined(z.string()),
  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(z.array(MountSchemaDto)),
}));
export type ChatGroupDto = z.infer<typeof ChatGroupSchemaDto>;

// --- Hierarchy (Structural Source of Truth) ---

export const HierarchyChatNodeSchemaDto = z.object({
  type: z.literal('chat'),
  id: z.string(),
});

export const HierarchyChatGroupNodeSchemaDto = z.object({
  type: z.literal('chat_group'),
  id: z.string(),
  chat_ids: z.array(z.string()),
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

export const BinaryObjectSchemaDto = resolveMissingAsUndefined(z.object({
  id: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.number(),
  name: missingAsUndefined(z.string()),
}));
export type BinaryObjectDto = z.infer<typeof BinaryObjectSchemaDto>;

/**
 * Shard Index
 * Stores metadata for all binary objects within a specific shard.
 */
export const BinaryShardIndexSchemaDto = z.object({
  objects: z.record(z.string(), BinaryObjectSchemaDto),
});
export type BinaryShardIndexDto = z.infer<typeof BinaryShardIndexSchemaDto>;

export const AttachmentSchemaDtoV1 = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.number(),
  status: AttachmentStatusSchemaDto,
});

export const AttachmentSchemaDtoV2 = z.object({
  id: z.string(),
  binaryObjectId: z.string(),
  name: z.string(),
  status: AttachmentStatusSchemaDto,
});

export const AttachmentSchemaDto = z.union([
  AttachmentSchemaDtoV2,
  AttachmentSchemaDtoV1,
]);
export type AttachmentDto = z.infer<typeof AttachmentSchemaDto>;

export const ToolCallSchemaDto = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const TextOrBinaryObjectSchemaDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('binary_object'), id: z.string() }),
]);

export const ToolExecutionResultSchemaDto = z.discriminatedUnion('status', [
  z.object({ toolCallId: z.string(), status: z.literal('executing') }),
  z.object({
    toolCallId: z.string(),
    status: z.literal('success'),
    content: TextOrBinaryObjectSchemaDto,
  }),
  z.object({
    toolCallId: z.string(),
    status: z.literal('error'),
    error: z.object({
      code: z.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']),
      message: TextOrBinaryObjectSchemaDto,
    }),
  }),
]);

export const MessageNodeSchemaDto: z.ZodType<MessageNodeDto> = z.lazy(() =>
  resolveMissingAsUndefined(z.discriminatedUnion('role', [
    z.object({
      id: z.string(),
      role: z.literal('user'),
      content: z.string(),
      attachments: missingAsUndefined(z.array(AttachmentSchemaDto)),
      timestamp: z.number(),
      thinking: missingAsUndefined(z.undefined()),
      modelId: missingAsUndefined(z.undefined()),
      lmParameters: missingAsUndefined(LmParametersSchemaDto),
      toolCalls: missingAsUndefined(z.undefined()),
      results: missingAsUndefined(z.undefined()),
      replies: MessageBranchSchemaDto,
    }),
    z.object({
      id: z.string(),
      role: z.literal('assistant'),
      content: z.string(),
      attachments: missingAsUndefined(z.undefined()),
      timestamp: z.number(),
      thinking: missingAsUndefined(z.string()),
      modelId: missingAsUndefined(z.string()),
      lmParameters: missingAsUndefined(LmParametersSchemaDto),
      toolCalls: missingAsUndefined(z.array(ToolCallSchemaDto)),
      results: missingAsUndefined(z.undefined()),
      replies: MessageBranchSchemaDto,
    }),
    z.object({
      id: z.string(),
      role: z.literal('system'),
      content: z.string(),
      attachments: missingAsUndefined(z.undefined()),
      timestamp: z.number(),
      thinking: missingAsUndefined(z.undefined()),
      modelId: missingAsUndefined(z.undefined()),
      lmParameters: missingAsUndefined(z.undefined()),
      toolCalls: missingAsUndefined(z.undefined()),
      results: missingAsUndefined(z.undefined()),
      replies: MessageBranchSchemaDto,
    }),
    z.object({
      id: z.string(),
      role: z.literal('tool'),
      content: missingAsUndefined(z.undefined()),
      attachments: missingAsUndefined(z.undefined()),
      timestamp: z.number(),
      thinking: missingAsUndefined(z.undefined()),
      modelId: missingAsUndefined(z.undefined()),
      lmParameters: missingAsUndefined(z.undefined()),
      toolCalls: missingAsUndefined(z.undefined()),
      results: z.array(ToolExecutionResultSchemaDto),
      replies: MessageBranchSchemaDto,
    }),
  ]))
);

export const MessageBranchSchemaDto = z.object({
  items: z.array(MessageNodeSchemaDto),
});

type MessageNodeCommonDto = {
  id: string;
  content: string | undefined;
  timestamp: number;
  replies: {
    items: MessageNodeDto[];
  };
};

export type MessageNodeDto =
  | (MessageNodeCommonDto & {
      role: 'user';
      content: string;
      attachments: AttachmentDto[] | undefined;
      thinking: undefined;
      modelId: undefined;
      lmParameters: LmParametersDto | undefined;
      toolCalls: undefined;
      results: undefined;
    })
  | (MessageNodeCommonDto & {
      role: 'assistant';
      content: string;
      attachments: undefined;
      thinking: string | undefined;
      modelId: string | undefined;
      lmParameters: LmParametersDto | undefined;
      toolCalls: z.infer<typeof ToolCallSchemaDto>[] | undefined;
      results: undefined;
    })
  | (MessageNodeCommonDto & {
      role: 'system';
      content: string;
      attachments: undefined;
      thinking: undefined;
      modelId: undefined;
      lmParameters: undefined;
      toolCalls: undefined;
      results: undefined;
    })
  | (MessageNodeCommonDto & {
      role: 'tool';
      content: undefined;
      attachments: undefined;
      thinking: undefined;
      modelId: undefined;
      lmParameters: undefined;
      toolCalls: undefined;
      results: z.infer<typeof ToolExecutionResultSchemaDto>[];
    });

/**
 * Chat Metadata
 * Contains all attributes except the heavy message tree.
 */
export const ChatMetaSchemaDto = resolveMissingAsUndefined(z.object({
  id: z.string(),
  title: z.string().nullable(),
  currentLeafId: missingAsUndefined(z.string()),
  updatedAt: z.number(),
  createdAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(z.string()),
  autoTitleEnabled: missingAsUndefined(z.boolean()),
  titleModelId: missingAsUndefined(z.string()),
  originChatId: missingAsUndefined(z.string()),
  originMessageId: missingAsUndefined(z.string()),

  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(z.array(MountSchemaDto)),
}));

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
export const ChatContentSchemaDto = resolveMissingAsUndefined(z.object({
  root: MessageBranchSchemaDto,
  currentLeafId: missingAsUndefined(z.string()),
}));

export type ChatContentDto = z.infer<typeof ChatContentSchemaDto>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatSchemaDto = ChatMetaSchemaDto.safeExtend({
  root: missingAsUndefined(MessageBranchSchemaDto),
  currentLeafId: missingAsUndefined(z.string()),

  // Legacy support field
  messages: missingAsUndefined(z.array(z.unknown())),
});

export type ChatDto = z.infer<typeof ChatSchemaDto>;

// --- Provider Profiles ---

export const ProviderProfileSchemaDto = resolveMissingAsUndefined(z.object({
  id: z.string(),
  name: z.string(),
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(z.string()),
  titleModelId: missingAsUndefined(z.string()),
  systemPrompt: missingAsUndefined(z.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
}));
export type ProviderProfileDto = z.infer<typeof ProviderProfileSchemaDto>;

export const SettingsSchemaDto = resolveMissingAsUndefined(z.object({
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(z.string()),
  titleModelId: missingAsUndefined(z.string()),
  autoTitleEnabled: z.boolean().default(true),
  storageType: StorageTypeSchemaDto,
  providerProfiles: z.array(ProviderProfileSchemaDto).default([]),
  mounts: z.array(MountSchemaDto).default([]),
  heavyContentAlertDismissed: missingAsUndefined(z.boolean()),
  systemPrompt: missingAsUndefined(z.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  experimental: missingAsUndefined(resolveMissingAsUndefined(z.object({
    markdownRendering: missingAsUndefined(z.union([z.literal('block_markdown'), z.literal('monolithic_html')])),
    sidebarSendMessageReorder: missingAsUndefined(z.union([z.literal('disabled'), z.literal('move_sent_chat')])),
  }))),
}));
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
