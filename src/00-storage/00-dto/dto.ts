/**
 * DTO (Data Transfer Objects) Definitions
 *
 * NOTE: Prefer explicit DTO keys with `T | undefined` output over optional output keys.
 * This ensures that when adding new properties, all call sites are forced to acknowledge them,
 * reducing the risk of missing updates. Use `missingAsUndefined(...)` for persisted fields
 * that must accept missing legacy JSON keys while materializing `key: undefined` after parse.
 * Alternatively, use .default() if a sensible non-undefined default exists.
 *
 * Add `experimental` as the final field in multiline DTO objects, separated
 * from the stable fields by a blank line. Keep existing compact one-line object
 * schemas on one line when adding or preserving their experimental field.
 */
import { z } from 'zod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';
import {
  ExperimentalAttachmentSchemaDtoV1,
  ExperimentalAttachmentSchemaDtoV2,
  ExperimentalBinaryObjectSchemaDto,
  ExperimentalBinaryShardIndexSchemaDto,
  ExperimentalChatContentSchemaDto,
  ExperimentalChatGroupSchemaDto,
  ExperimentalChatMetaIndexSchemaDto,
  ExperimentalChatMetaSchemaDto,
  ExperimentalCompletedMigrationSchemaDto,
  ExperimentalExperimentalTypeEndpointSchemaDto,
  ExperimentalHierarchyChatGroupNodeSchemaDto,
  ExperimentalHierarchyChatNodeSchemaDto,
  ExperimentalHierarchySchemaDto,
  ExperimentalHttpEndpointSchemaDto,
  ExperimentalLmParametersSchemaDto,
  ExperimentalMessageBranchSchemaDto,
  ExperimentalMessageNodeAssistantSchemaDto,
  ExperimentalMessageNodeSystemSchemaDto,
  ExperimentalMessageNodeToolSchemaDto,
  ExperimentalMessageNodeUserSchemaDto,
  ExperimentalMigrationStateSchemaDto,
  ExperimentalMountVolumeSchemaDto,
  ExperimentalProviderProfileSchemaDto,
  ExperimentalReasoningSchemaDto,
  ExperimentalSettingsSchemaDto,
  ExperimentalSystemPromptAppendSchemaDto,
  ExperimentalSystemPromptOverrideSchemaDto,
  ExperimentalTextOrBinaryObjectBinaryObjectSchemaDto,
  ExperimentalTextOrBinaryObjectTextSchemaDto,
  ExperimentalToolCallFunctionSchemaDto,
  ExperimentalToolCallSchemaDto,
  ExperimentalToolExecutionResultErrorObjectSchemaDto,
  ExperimentalToolExecutionResultErrorSchemaDto,
  ExperimentalToolExecutionResultExecutingSchemaDto,
  ExperimentalToolExecutionResultSuccessSchemaDto,
  ExperimentalTransformersJsEndpointSchemaDto,
  ExperimentalVolumeBaseSchemaDto,
  ExperimentalVolumeIndexSchemaDto,
  optionalExperimentalFieldSchemaDto,
} from './experimental.dto';

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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHttpEndpointSchemaDto }),
}));

export const TransformersJsEndpointSchemaDto = z.object({
  type: z.literal('transformers_js'),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTransformersJsEndpointSchemaDto }),
});

/**
 * Stable persisted envelope for endpoint implementations whose identity and
 * settings are still experimental. The concrete endpoint identifier belongs
 * to `experimental.type` and is translated by the mapper into a domain
 * endpoint. This prevents every experimental endpoint rename or addition from
 * becoming a new top-level persisted discriminator.
 */
export const ExperimentalTypeEndpointSchemaDto = z.object({
  type: z.literal('experimental_type'),

  experimental: optionalExperimentalFieldSchemaDto({
    schema: ExperimentalExperimentalTypeEndpointSchemaDto,
  }),
});

export const EndpointSchemaDto = resolveMissingAsUndefined(z.discriminatedUnion('type', [
  HttpEndpointSchemaDto,
  TransformersJsEndpointSchemaDto,
  ExperimentalTypeEndpointSchemaDto,
]));

export type EndpointDto = z.infer<typeof EndpointSchemaDto>;
export type EndpointTypeDto = EndpointDto['type'];

// --- Language Model Parameters ---

export const ReasoningEffortSchemaDto = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningEffortDto = z.infer<typeof ReasoningEffortSchemaDto>;

export const ReasoningSchemaDto = resolveMissingAsUndefined(z.object({
  effort: missingAsUndefined(ReasoningEffortSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalReasoningSchemaDto }),
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalLmParametersSchemaDto }),
}));
export type LmParametersDto = z.infer<typeof LmParametersSchemaDto>;

const SettingsTitleGenerationSchemaDto = z.union([
  z.literal('disabled'),
  z.object({
    endpoint: z.literal('same_scope'),
    model: z.union([
      z.literal('same_scope'),
      z.object({ id: z.string().min(1) }),
    ]),
    lmParameters: z.union([
      z.literal('same_scope'),
      LmParametersSchemaDto,
    ]),
  }),
  z.object({
    endpoint: EndpointSchemaDto,
    model: z.object({ id: z.string().min(1) }),
    lmParameters: LmParametersSchemaDto,
  }),
]);

const ScopedTitleGenerationSchemaDto = z.union([
  z.literal('disabled'),
  z.literal('inherit'),
  z.object({
    endpoint: z.literal('same_scope'),
    model: z.union([
      z.literal('same_scope'),
      z.object({ id: z.string().min(1) }),
    ]),
    lmParameters: z.union([
      z.literal('same_scope'),
      LmParametersSchemaDto,
    ]),
  }),
  z.object({
    endpoint: EndpointSchemaDto,
    model: z.object({ id: z.string().min(1) }),
    lmParameters: LmParametersSchemaDto,
  }),
]);

export const SystemPromptSchemaDto = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('override'),
    content: z.string().nullable(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSystemPromptOverrideSchemaDto }),
  }),
  z.object({
    behavior: z.literal('append'),
    content: z.string(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSystemPromptAppendSchemaDto }),
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalVolumeBaseSchemaDto }),
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalVolumeIndexSchemaDto }),
});
export type VolumeIndexDto = z.infer<typeof VolumeIndexSchemaDto>;

export const MountVolumeSchemaDto = z.object({
  type: z.literal('volume'),
  volumeId: z.string(),
  mountPath: z.string(),
  readOnly: z.boolean(),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMountVolumeSchemaDto }),
});

export const MountSchemaDto = z.discriminatedUnion('type', [
  MountVolumeSchemaDto,
]);
export type MountDto = z.infer<typeof MountSchemaDto>;

// --- Grouping ---

export const ChatGroupSchemaDtoV1 = resolveMissingAsUndefined(z.object({
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatGroupSchemaDto }),
}));
export type ChatGroupDtoV1 = z.infer<typeof ChatGroupSchemaDtoV1>;

export const ChatGroupSchemaDtoV2 = resolveMissingAsUndefined(z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.number(),
  isCollapsed: z.boolean().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(z.string()),
  titleGeneration: ScopedTitleGenerationSchemaDto,
  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(z.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatGroupSchemaDto }),
}));
export type ChatGroupDtoV2 = z.infer<typeof ChatGroupSchemaDtoV2>;

export const ChatGroupSchemaDto = z.union([
  ChatGroupSchemaDtoV2,
  ChatGroupSchemaDtoV1,
]);
export type ChatGroupDto = z.infer<typeof ChatGroupSchemaDto>;

// --- Hierarchy (Structural Source of Truth) ---

export const HierarchyChatNodeSchemaDto = z.object({
  type: z.literal('chat'),
  id: z.string(),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchyChatNodeSchemaDto }),
});

export const HierarchyChatGroupNodeSchemaDto = z.object({
  type: z.literal('chat_group'),
  id: z.string(),
  chat_ids: z.array(z.string()),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchyChatGroupNodeSchemaDto }),
});

export const HierarchySchemaDto = z.object({
  items: z.array(z.union([
    HierarchyChatNodeSchemaDto,
    HierarchyChatGroupNodeSchemaDto,
  ])),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchySchemaDto }),
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalBinaryObjectSchemaDto }),
}));
export type BinaryObjectDto = z.infer<typeof BinaryObjectSchemaDto>;

/**
 * Shard Index
 * Stores metadata for all binary objects within a specific shard.
 */
export const BinaryShardIndexSchemaDto = z.object({
  objects: z.record(z.string(), BinaryObjectSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalBinaryShardIndexSchemaDto }),
});
export type BinaryShardIndexDto = z.infer<typeof BinaryShardIndexSchemaDto>;

export const AttachmentSchemaDtoV1 = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  uploadedAt: z.number(),
  status: AttachmentStatusSchemaDto,

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalAttachmentSchemaDtoV1 }),
});

export const AttachmentSchemaDtoV2 = z.object({
  id: z.string(),
  binaryObjectId: z.string(),
  name: z.string(),
  status: AttachmentStatusSchemaDto,

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalAttachmentSchemaDtoV2 }),
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

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolCallFunctionSchemaDto }),
  }),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolCallSchemaDto }),
});

export type ToolCallDto = z.infer<typeof ToolCallSchemaDto>;

export const TextOrBinaryObjectSchemaDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTextOrBinaryObjectTextSchemaDto }) }),
  z.object({ type: z.literal('binary_object'), id: z.string(), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTextOrBinaryObjectBinaryObjectSchemaDto }) }),
]);
export type TextOrBinaryObjectDto = z.infer<typeof TextOrBinaryObjectSchemaDto>;

export const ToolExecutionResultSchemaDto = z.discriminatedUnion('status', [
  z.object({ toolCallId: z.string(), status: z.literal('executing'), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultExecutingSchemaDto }) }),
  z.object({
    toolCallId: z.string(),
    status: z.literal('success'),
    content: TextOrBinaryObjectSchemaDto,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultSuccessSchemaDto }),
  }),
  z.object({
    toolCallId: z.string(),
    status: z.literal('error'),
    error: z.object({
      code: z.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']),
      message: TextOrBinaryObjectSchemaDto,

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultErrorObjectSchemaDto }),
    }),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultErrorSchemaDto }),
  }),
]);
export type ToolExecutionResultDto = z.infer<typeof ToolExecutionResultSchemaDto>;

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

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeUserSchemaDto }),
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

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeAssistantSchemaDto }),
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

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeSystemSchemaDto }),
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

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeToolSchemaDto }),
    }),
  ])),
);

export const MessageBranchSchemaDto = z.object({
  items: z.array(MessageNodeSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageBranchSchemaDto }),
});

type MessageNodeCommonDto = {
  id: string,
  content: string | undefined,
  timestamp: number,
  replies: {
    items: MessageNodeDto[],
  },
};

export type MessageNodeDto =
  | (MessageNodeCommonDto & {
      role: 'user',
      content: string,
      attachments: AttachmentDto[] | undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: LmParametersDto | undefined,
      toolCalls: undefined,
      results: undefined,
    })
  | (MessageNodeCommonDto & {
      role: 'assistant',
      content: string,
      attachments: undefined,
      thinking: string | undefined,
      modelId: string | undefined,
      lmParameters: LmParametersDto | undefined,
      toolCalls: z.infer<typeof ToolCallSchemaDto>[] | undefined,
      results: undefined,
    })
  | (MessageNodeCommonDto & {
      role: 'system',
      content: string,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    })
  | (MessageNodeCommonDto & {
      role: 'tool',
      content: undefined,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: z.infer<typeof ToolExecutionResultSchemaDto>[],
    });

/**
 * Chat Metadata
 * Contains all attributes except the heavy message tree.
 */
export const ChatMetaSchemaDtoV1 = resolveMissingAsUndefined(z.object({
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaSchemaDto }),
}));
export type ChatMetaDtoV1 = z.infer<typeof ChatMetaSchemaDtoV1>;

export const ChatMetaSchemaDtoV2 = resolveMissingAsUndefined(z.object({
  id: z.string(),
  title: z.string().nullable(),
  currentLeafId: missingAsUndefined(z.string()),
  updatedAt: z.number(),
  createdAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(z.string()),
  titleGeneration: ScopedTitleGenerationSchemaDto,
  originChatId: missingAsUndefined(z.string()),
  originMessageId: missingAsUndefined(z.string()),

  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(z.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaSchemaDto }),
}));
export type ChatMetaDtoV2 = z.infer<typeof ChatMetaSchemaDtoV2>;

export const ChatMetaSchemaDto = z.union([
  ChatMetaSchemaDtoV2,
  ChatMetaSchemaDtoV1,
]);

export type ChatMetaDto = z.infer<typeof ChatMetaSchemaDto>;

/**
 * Chat Meta Index (Legacy/Bulk operations)
 */
export const ChatMetaIndexSchemaDto = z.object({
  entries: z.array(ChatMetaSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaIndexSchemaDto }),
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatContentSchemaDto }),
}));

export type ChatContentDto = z.infer<typeof ChatContentSchemaDto>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatSchemaDtoV1 = ChatMetaSchemaDtoV1.safeExtend({
  root: missingAsUndefined(MessageBranchSchemaDto),
  currentLeafId: missingAsUndefined(z.string()),

  // Legacy support field
  messages: missingAsUndefined(z.array(z.unknown())),
});
export type ChatDtoV1 = z.infer<typeof ChatSchemaDtoV1>;

export const ChatSchemaDtoV2 = ChatMetaSchemaDtoV2.safeExtend({
  root: missingAsUndefined(MessageBranchSchemaDto),
  currentLeafId: missingAsUndefined(z.string()),

  // Legacy support field
  messages: missingAsUndefined(z.array(z.unknown())),
});
export type ChatDtoV2 = z.infer<typeof ChatSchemaDtoV2>;

export const ChatSchemaDto = z.union([
  ChatSchemaDtoV2,
  ChatSchemaDtoV1,
]);

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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalProviderProfileSchemaDto }),
}));
export type ProviderProfileDto = z.infer<typeof ProviderProfileSchemaDto>;

export const SettingsSchemaDtoV1 = resolveMissingAsUndefined(z.object({
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

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto }),
}));
export type SettingsDtoV1 = z.infer<typeof SettingsSchemaDtoV1>;

export const SettingsSchemaDtoV2 = resolveMissingAsUndefined(z.object({
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(z.string()),
  titleGeneration: SettingsTitleGenerationSchemaDto,
  storageType: StorageTypeSchemaDto,
  providerProfiles: z.array(ProviderProfileSchemaDto).default([]),
  mounts: z.array(MountSchemaDto).default([]),
  heavyContentAlertDismissed: missingAsUndefined(z.boolean()),
  systemPrompt: missingAsUndefined(z.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto }),
}));
export type SettingsDtoV2 = z.infer<typeof SettingsSchemaDtoV2>;

export const SettingsSchemaDto = z.union([
  SettingsSchemaDtoV2,
  SettingsSchemaDtoV1,
]);
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;

/**
 * Migration Data Chunk
 *
 * Represents a single unit of heavy data during storage migration.
 * Structural metadata (Settings, Hierarchy, Groups) are handled as
 * complete domain objects during the restoration process.
 */
export type StorageBinaryObjectWriteSource =
  | {
      type: 'direct_blob',

      /**
       * The Blob must already be directly available without reading,
       * decrypting, decompressing, or copying the complete payload.
       *
       * A Blob materialized from a stream or reader must never be represented
       * by this branch.
       */
      blob: Blob,
    }
  | {
      type: 'stream',
      stream: ReadableStream<Uint8Array>,
    };

export type MigrationChunkDto =
  | { type: 'chat', data: ChatDto }
  | {
      type: 'binary_object',
      id: string, // The binaryObjectId
      name: string,
      mimeType: string,
      size: number,
      createdAt: number,
      source: StorageBinaryObjectWriteSource,
    };

/**
 * Migration State
 * Tracks completed data migrations to ensure they only run once.
 */
export const MigrationStateSchemaDto = z.object({
  completedMigrations: z.array(z.object({
    name: z.string(),
    completedAt: z.number(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalCompletedMigrationSchemaDto }),
  })),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMigrationStateSchemaDto }),
});
export type MigrationStateDto = z.infer<typeof MigrationStateSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
