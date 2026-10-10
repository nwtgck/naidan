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
import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
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
  ExperimentalMessageTextPartSchemaDto,
  ExperimentalMessageReasoningPartSchemaDto,
  ExperimentalMessageAttachmentPartSchemaDto,
  ExperimentalMessageToolCallPartSchemaDto,
  ExperimentalMessageToolResultPartSchemaDto,
  ExperimentalMessageInterruptionCancelledSchemaDto,
  ExperimentalMessageInterruptionErrorSchemaDto,
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

export const RoleSchemaDto = dtozod.enum(['user', 'assistant', 'system', 'tool']);
export type RoleDto = dtozod.infer<typeof RoleSchemaDto>;

export const StorageTypeSchemaDto = dtozod.enum(['local', 'opfs', 'memory']);
export type StorageTypeDto = dtozod.infer<typeof StorageTypeSchemaDto>;

export const HttpHeaderSchemaDto = dtozod.tuple([dtozod.string(), dtozod.string()]);
export type HttpHeaderDto = dtozod.infer<typeof HttpHeaderSchemaDto>;

export const HttpEndpointSchemaDto = resolveMissingAsUndefined(dtozod.object({
  type: dtozod.enum(['openai', 'ollama']),
  url: dtozod.string(),
  httpHeaders: missingAsUndefined(dtozod.array(HttpHeaderSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHttpEndpointSchemaDto }),
}));

export const TransformersJsEndpointSchemaDto = dtozod.object({
  type: dtozod.literal('transformers_js'),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTransformersJsEndpointSchemaDto }),
});

/**
 * Stable persisted envelope for endpoint implementations whose identity and
 * settings are still experimental. The concrete endpoint identifier belongs
 * to `experimental.endpoint.type` and is translated by the mapper into a domain
 * endpoint. This prevents every experimental endpoint rename or addition from
 * becoming a new top-level persisted discriminator.
 */
export const ExperimentalTypeEndpointSchemaDto = dtozod.object({
  type: dtozod.literal('experimental_type'),

  experimental: optionalExperimentalFieldSchemaDto({
    schema: ExperimentalExperimentalTypeEndpointSchemaDto,
  }),
});

export const EndpointSchemaDto = resolveMissingAsUndefined(dtozod.discriminatedUnion('type', [
  HttpEndpointSchemaDto,
  TransformersJsEndpointSchemaDto,
  ExperimentalTypeEndpointSchemaDto,
]));

export type EndpointDto = dtozod.infer<typeof EndpointSchemaDto>;
export type EndpointTypeDto = EndpointDto['type'];

// --- Language Model Parameters ---

export const ReasoningEffortSchemaDto = dtozod.enum(['none', 'low', 'medium', 'high']);
export type ReasoningEffortDto = dtozod.infer<typeof ReasoningEffortSchemaDto>;

export const ReasoningSchemaDto = resolveMissingAsUndefined(dtozod.object({
  effort: missingAsUndefined(ReasoningEffortSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalReasoningSchemaDto }),
}));
export type ReasoningDto = dtozod.infer<typeof ReasoningSchemaDto>;

export const LmParametersSchemaDto = resolveMissingAsUndefined(dtozod.object({
  temperature: missingAsUndefined(dtozod.number()),
  topP: missingAsUndefined(dtozod.number()),
  maxCompletionTokens: missingAsUndefined(dtozod.number()),
  presencePenalty: missingAsUndefined(dtozod.number()),
  frequencyPenalty: missingAsUndefined(dtozod.number()),
  stop: missingAsUndefined(dtozod.array(dtozod.string())),
  reasoning: missingAsUndefined(ReasoningSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalLmParametersSchemaDto }),
}));
export type LmParametersDto = dtozod.infer<typeof LmParametersSchemaDto>;

const SettingsTitleGenerationSchemaDto = dtozod.union([
  dtozod.literal('disabled'),
  dtozod.object({
    endpoint: dtozod.literal('same_scope'),
    model: dtozod.union([
      dtozod.literal('same_scope'),
      dtozod.object({ id: dtozod.string() }),
    ]),
    lmParameters: dtozod.union([
      dtozod.literal('same_scope'),
      LmParametersSchemaDto,
    ]),
  }),
  dtozod.object({
    endpoint: EndpointSchemaDto,
    model: dtozod.object({ id: dtozod.string() }),
    lmParameters: LmParametersSchemaDto,
  }),
]);

const ScopedTitleGenerationSchemaDto = dtozod.union([
  dtozod.literal('disabled'),
  dtozod.literal('inherit'),
  dtozod.object({
    endpoint: dtozod.literal('same_scope'),
    model: dtozod.union([
      dtozod.literal('same_scope'),
      dtozod.object({ id: dtozod.string() }),
    ]),
    lmParameters: dtozod.union([
      dtozod.literal('same_scope'),
      LmParametersSchemaDto,
    ]),
  }),
  dtozod.object({
    endpoint: EndpointSchemaDto,
    model: dtozod.object({ id: dtozod.string() }),
    lmParameters: LmParametersSchemaDto,
  }),
]);

export const SystemPromptSchemaDto = dtozod.discriminatedUnion('behavior', [
  dtozod.object({
    behavior: dtozod.literal('override'),
    content: dtozod.string().nullable(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSystemPromptOverrideSchemaDto }),
  }),
  dtozod.object({
    behavior: dtozod.literal('append'),
    content: dtozod.string(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSystemPromptAppendSchemaDto }),
  }),
]);
export type SystemPromptDto = dtozod.infer<typeof SystemPromptSchemaDto>;

// --- Volume Management & Mounts ---
// User-facing label: "Folder". All internal identifiers use "volume".

export const VolumeTypeSchemaDto = dtozod.enum(['opfs', 'host']);
export type VolumeTypeDto = dtozod.infer<typeof VolumeTypeSchemaDto>;

const VolumeBaseSchemaDto = dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  createdAt: dtozod.number(),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalVolumeBaseSchemaDto }),
});

export const VolumeOpfsSchemaDto = VolumeBaseSchemaDto.extend({
  type: dtozod.literal('opfs'),
});

export const VolumeHostSchemaDto = VolumeBaseSchemaDto.extend({
  type: dtozod.literal('host'),
});

export const VolumeSchemaDto = dtozod.discriminatedUnion('type', [
  VolumeOpfsSchemaDto,
  VolumeHostSchemaDto,
]);
export type VolumeDto = dtozod.infer<typeof VolumeSchemaDto>;

export const VolumeIndexSchemaDto = dtozod.object({
  volumes: dtozod.record(dtozod.string(), VolumeSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalVolumeIndexSchemaDto }),
});
export type VolumeIndexDto = dtozod.infer<typeof VolumeIndexSchemaDto>;

export const MountVolumeSchemaDto = dtozod.object({
  type: dtozod.literal('volume'),
  volumeId: dtozod.string(),
  mountPath: dtozod.string(),
  readOnly: dtozod.boolean(),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMountVolumeSchemaDto }),
});

export const MountSchemaDto = dtozod.discriminatedUnion('type', [
  MountVolumeSchemaDto,
]);
export type MountDto = dtozod.infer<typeof MountSchemaDto>;

// --- Grouping ---

export const ChatGroupSchemaDtoV1 = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  updatedAt: dtozod.number(),
  isCollapsed: dtozod.boolean().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: missingAsUndefined(dtozod.boolean()),
  titleModelId: missingAsUndefined(dtozod.string()),
  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(dtozod.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatGroupSchemaDto }),
}));
export type ChatGroupDtoV1 = dtozod.infer<typeof ChatGroupSchemaDtoV1>;

export const ChatGroupSchemaDtoV2 = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  updatedAt: dtozod.number(),
  isCollapsed: dtozod.boolean().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(dtozod.string()),
  titleGeneration: ScopedTitleGenerationSchemaDto,
  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(dtozod.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatGroupSchemaDto }),
}));
export type ChatGroupDtoV2 = dtozod.infer<typeof ChatGroupSchemaDtoV2>;

export const ChatGroupSchemaDto = dtozod.union([
  ChatGroupSchemaDtoV2,
  ChatGroupSchemaDtoV1,
]);
export type ChatGroupDto = dtozod.infer<typeof ChatGroupSchemaDto>;

// --- Hierarchy (Structural Source of Truth) ---

export const HierarchyChatNodeSchemaDto = dtozod.object({
  type: dtozod.literal('chat'),
  id: dtozod.string(),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchyChatNodeSchemaDto }),
});

export const HierarchyChatGroupNodeSchemaDto = dtozod.object({
  type: dtozod.literal('chat_group'),
  id: dtozod.string(),
  chat_ids: dtozod.array(dtozod.string()),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchyChatGroupNodeSchemaDto }),
});

export const HierarchySchemaDto = dtozod.object({
  items: dtozod.array(dtozod.union([
    HierarchyChatNodeSchemaDto,
    HierarchyChatGroupNodeSchemaDto,
  ])),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalHierarchySchemaDto }),
});

export type HierarchyDto = dtozod.infer<typeof HierarchySchemaDto>;

// --- Tree-based Message Structure (Recursive) ---

export const AttachmentStatusSchemaDto = dtozod.enum(['persisted', 'memory', 'missing']);

export const BinaryObjectSchemaDto = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  mimeType: dtozod.string(),
  size: dtozod.number(),
  createdAt: dtozod.number(),
  name: missingAsUndefined(dtozod.string()),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalBinaryObjectSchemaDto }),
}));
export type BinaryObjectDto = dtozod.infer<typeof BinaryObjectSchemaDto>;

/**
 * Shard Index
 * Stores metadata for all binary objects within a specific shard.
 */
export const BinaryShardIndexSchemaDto = dtozod.object({
  objects: dtozod.record(dtozod.string(), BinaryObjectSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalBinaryShardIndexSchemaDto }),
});
export type BinaryShardIndexDto = dtozod.infer<typeof BinaryShardIndexSchemaDto>;

export const AttachmentSchemaDtoV1 = dtozod.object({
  id: dtozod.string(),
  originalName: dtozod.string(),
  mimeType: dtozod.string(),
  size: dtozod.number(),
  uploadedAt: dtozod.number(),
  status: AttachmentStatusSchemaDto,

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalAttachmentSchemaDtoV1 }),
});

export const AttachmentSchemaDtoV2 = dtozod.object({
  id: dtozod.string(),
  binaryObjectId: dtozod.string(),
  name: dtozod.string(),
  status: AttachmentStatusSchemaDto,

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalAttachmentSchemaDtoV2 }),
});

export const AttachmentSchemaDto = dtozod.union([
  AttachmentSchemaDtoV2,
  AttachmentSchemaDtoV1,
]);
export type AttachmentDto = dtozod.infer<typeof AttachmentSchemaDto>;

export const ToolCallSchemaDto = dtozod.object({
  id: dtozod.string(),
  type: dtozod.literal('function'),
  function: dtozod.object({
    name: dtozod.string(),
    arguments: dtozod.string(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolCallFunctionSchemaDto }),
  }),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolCallSchemaDto }),
});

export type ToolCallDto = dtozod.infer<typeof ToolCallSchemaDto>;

export const TextOrBinaryObjectSchemaDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('text'), text: dtozod.string(), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTextOrBinaryObjectTextSchemaDto }) }),
  dtozod.object({ type: dtozod.literal('binary_object'), id: dtozod.string(), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalTextOrBinaryObjectBinaryObjectSchemaDto }) }),
]);
export type TextOrBinaryObjectDto = dtozod.infer<typeof TextOrBinaryObjectSchemaDto>;

export const ToolExecutionResultSchemaDto = dtozod.discriminatedUnion('status', [
  dtozod.object({ toolCallId: dtozod.string(), status: dtozod.literal('executing'), experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultExecutingSchemaDto }) }),
  dtozod.object({
    toolCallId: dtozod.string(),
    status: dtozod.literal('success'),
    content: TextOrBinaryObjectSchemaDto,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultSuccessSchemaDto }),
  }),
  dtozod.object({
    toolCallId: dtozod.string(),
    status: dtozod.literal('error'),
    error: dtozod.object({
      code: dtozod.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']),
      message: TextOrBinaryObjectSchemaDto,

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultErrorObjectSchemaDto }),
    }),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalToolExecutionResultErrorSchemaDto }),
  }),
]);
export type ToolExecutionResultDto = dtozod.infer<typeof ToolExecutionResultSchemaDto>;

export const MessageNodeSchemaDtoV1 = resolveMissingAsUndefined(
  dtozod.discriminatedUnion('role', [
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('user'),
      content: dtozod.string(),
      attachments: missingAsUndefined(dtozod.array(AttachmentSchemaDto)),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.undefined()),
      modelId: missingAsUndefined(dtozod.undefined()),
      lmParameters: missingAsUndefined(LmParametersSchemaDto),
      toolCalls: missingAsUndefined(dtozod.undefined()),
      results: missingAsUndefined(dtozod.undefined()),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchSchemaDtoV1 {
        return MessageBranchSchemaDtoV1;
      },

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeUserSchemaDto }),
    }),
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('assistant'),
      content: dtozod.string(),
      attachments: missingAsUndefined(dtozod.undefined()),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.string()),
      modelId: missingAsUndefined(dtozod.string()),
      lmParameters: missingAsUndefined(LmParametersSchemaDto),
      toolCalls: missingAsUndefined(dtozod.array(ToolCallSchemaDto)),
      results: missingAsUndefined(dtozod.undefined()),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchSchemaDtoV1 {
        return MessageBranchSchemaDtoV1;
      },

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeAssistantSchemaDto }),
    }),
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('system'),
      content: dtozod.string(),
      attachments: missingAsUndefined(dtozod.undefined()),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.undefined()),
      modelId: missingAsUndefined(dtozod.undefined()),
      lmParameters: missingAsUndefined(dtozod.undefined()),
      toolCalls: missingAsUndefined(dtozod.undefined()),
      results: missingAsUndefined(dtozod.undefined()),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchSchemaDtoV1 {
        return MessageBranchSchemaDtoV1;
      },

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeSystemSchemaDto }),
    }),
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('tool'),
      content: missingAsUndefined(dtozod.undefined()),
      attachments: missingAsUndefined(dtozod.undefined()),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.undefined()),
      modelId: missingAsUndefined(dtozod.undefined()),
      lmParameters: missingAsUndefined(dtozod.undefined()),
      toolCalls: missingAsUndefined(dtozod.undefined()),
      results: dtozod.array(ToolExecutionResultSchemaDto),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchSchemaDtoV1 {
        return MessageBranchSchemaDtoV1;
      },

      experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeToolSchemaDto }),
    }),
  ]),
);
export type MessageNodeDtoV1 = dtozod.infer<typeof MessageNodeSchemaDtoV1>;

// A named interface anchors mutual recursion; a type alias reintroduces TS2502/TS7022.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- This identity is required for recursive schema inference.
interface MessageBranchSchemaTypeDtoV1 extends dtozod.DtoObject<{
  items: dtozod.DtoArray<typeof MessageNodeSchemaDtoV1>;
  experimental: ReturnType<typeof optionalExperimentalFieldSchemaDto<typeof ExperimentalMessageBranchSchemaDto>>;
}> {}

export const MessageBranchSchemaDtoV1: MessageBranchSchemaTypeDtoV1 = dtozod.object({
  get items(): dtozod.DtoArray<typeof MessageNodeSchemaDtoV1> {
    return dtozod.array(MessageNodeSchemaDtoV1);
  },

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageBranchSchemaDto }),
});
export type MessageBranchDtoV1 = dtozod.infer<typeof MessageBranchSchemaDtoV1>;

// A named interface anchors mutual recursion; a type alias reintroduces TS2502/TS7022.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- This identity is required for recursive schema inference.
interface MessageBranchSchemaTypeDtoV2 extends dtozod.DtoObject<{
  items: dtozod.DtoArray<typeof MessageNodeSchemaDtoV2>;
  experimental: ReturnType<typeof optionalExperimentalFieldSchemaDto<typeof ExperimentalMessageBranchSchemaDto>>;
}> {}

export const MessageBranchSchemaDtoV2: MessageBranchSchemaTypeDtoV2 = dtozod.object({
  get items(): dtozod.DtoArray<typeof MessageNodeSchemaDtoV2> {
    return dtozod.array(MessageNodeSchemaDtoV2);
  },

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageBranchSchemaDto }),
});
export type MessageBranchDtoV2 = dtozod.infer<typeof MessageBranchSchemaDtoV2>;

export const MessageNodeSchemaDtoV2 = resolveMissingAsUndefined(dtozod.discriminatedUnion('role', [
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('user'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.undefined()),
    lmParameters: missingAsUndefined(LmParametersSchemaDto),
    parts: dtozod.array(
      dtozod.discriminatedUnion('type', [
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('text'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageTextPartSchemaDto }),
        })),
        dtozod.object({
          type: dtozod.literal('attachment'),
          attachment: AttachmentSchemaDtoV2,

          experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageAttachmentPartSchemaDto }),
        }),
      ]),
    ),
    replies: MessageBranchSchemaDtoV2,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeUserSchemaDto }),
  }),
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('assistant'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.string()),
    lmParameters: missingAsUndefined(LmParametersSchemaDto),
    parts: dtozod.array(
      dtozod.discriminatedUnion('type', [
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('reasoning'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageReasoningPartSchemaDto }),
        })),
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('text'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageTextPartSchemaDto }),
        })),
        dtozod.object({
          type: dtozod.literal('tool_call'),
          toolCall: ToolCallSchemaDto,

          experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageToolCallPartSchemaDto }),
        }),
      ]),
    ),
    interruption: missingAsUndefined(dtozod.discriminatedUnion('type', [
      dtozod.object({
        type: dtozod.literal('cancelled'),

        experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageInterruptionCancelledSchemaDto }),
      }),
      dtozod.object({
        type: dtozod.literal('error'),
        // This message may contain text localized when the error was recorded.
        // Later locale changes do not retranslate this persisted text.
        message: dtozod.string(),

        experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageInterruptionErrorSchemaDto }),
      }),
    ])),
    replies: MessageBranchSchemaDtoV2,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeAssistantSchemaDto }),
  }),
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('system'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.undefined()),
    lmParameters: missingAsUndefined(dtozod.undefined()),
    parts: dtozod.array(
      resolveMissingAsUndefined(dtozod.object({
        type: dtozod.literal('text'),
        text: dtozod.string(),
        completeness: missingAsUndefined(dtozod.literal('partial')),

        experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageTextPartSchemaDto }),
      })),
    ),
    replies: MessageBranchSchemaDtoV2,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeSystemSchemaDto }),
  }),
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('tool'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.undefined()),
    lmParameters: missingAsUndefined(dtozod.undefined()),
    parts: dtozod.array(
      dtozod.object({
        type: dtozod.literal('tool_result'),
        result: ToolExecutionResultSchemaDto,

        experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageToolResultPartSchemaDto }),
      }),
    ),
    replies: MessageBranchSchemaDtoV2,

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageNodeToolSchemaDto }),
  }),
]));
export type MessageNodeDtoV2 = dtozod.infer<typeof MessageNodeSchemaDtoV2>;

export const MessageNodeSchemaDto = dtozod.union([
  MessageNodeSchemaDtoV2,
  MessageNodeSchemaDtoV1,
]);
export type MessageNodeDto = dtozod.infer<typeof MessageNodeSchemaDto>;

export const MessageBranchSchemaDto = dtozod.object({
  items: dtozod.array(MessageNodeSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMessageBranchSchemaDto }),
});

/**
 * Chat Metadata
 * Contains all attributes except the heavy message tree.
 */
export const ChatMetaSchemaDtoV1 = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  title: dtozod.string().nullable(),
  currentLeafId: missingAsUndefined(dtozod.string()),
  updatedAt: dtozod.number(),
  createdAt: dtozod.number(),
  debugEnabled: dtozod.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: missingAsUndefined(dtozod.boolean()),
  titleModelId: missingAsUndefined(dtozod.string()),
  originChatId: missingAsUndefined(dtozod.string()),
  originMessageId: missingAsUndefined(dtozod.string()),

  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(dtozod.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaSchemaDto }),
}));
export type ChatMetaDtoV1 = dtozod.infer<typeof ChatMetaSchemaDtoV1>;

export const ChatMetaSchemaDtoV2 = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  title: dtozod.string().nullable(),
  currentLeafId: missingAsUndefined(dtozod.string()),
  updatedAt: dtozod.number(),
  createdAt: dtozod.number(),
  debugEnabled: dtozod.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(dtozod.string()),
  titleGeneration: ScopedTitleGenerationSchemaDto,
  originChatId: missingAsUndefined(dtozod.string()),
  originMessageId: missingAsUndefined(dtozod.string()),

  systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
  mounts: missingAsUndefined(dtozod.array(MountSchemaDto)),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaSchemaDto }),
}));
export type ChatMetaDtoV2 = dtozod.infer<typeof ChatMetaSchemaDtoV2>;

export const ChatMetaSchemaDto = dtozod.union([
  ChatMetaSchemaDtoV2,
  ChatMetaSchemaDtoV1,
]);

export type ChatMetaDto = dtozod.infer<typeof ChatMetaSchemaDto>;

/**
 * Chat Meta Index (Legacy/Bulk operations)
 */
export const ChatMetaIndexSchemaDto = dtozod.object({
  entries: dtozod.array(ChatMetaSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatMetaIndexSchemaDto }),
});

export type ChatMetaIndexDto = dtozod.infer<typeof ChatMetaIndexSchemaDto>;

/**
 * Chat Content
 * Contains the heavy message tree structure.
 * Stored in individual files to scale.
 */
export const ChatContentSchemaDto = resolveMissingAsUndefined(dtozod.object({
  root: MessageBranchSchemaDto,
  currentLeafId: missingAsUndefined(dtozod.string()),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalChatContentSchemaDto }),
}));

export type ChatContentDto = dtozod.infer<typeof ChatContentSchemaDto>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatSchemaDtoV1 = ChatMetaSchemaDtoV1.safeExtend({
  root: missingAsUndefined(MessageBranchSchemaDto),
  currentLeafId: missingAsUndefined(dtozod.string()),

  // Legacy support field
  messages: missingAsUndefined(dtozod.array(dtozod.unknown())),
});
export type ChatDtoV1 = dtozod.infer<typeof ChatSchemaDtoV1>;

export const ChatSchemaDtoV2 = ChatMetaSchemaDtoV2.safeExtend({
  root: missingAsUndefined(MessageBranchSchemaDto),
  currentLeafId: missingAsUndefined(dtozod.string()),

  // Legacy support field
  messages: missingAsUndefined(dtozod.array(dtozod.unknown())),
});
export type ChatDtoV2 = dtozod.infer<typeof ChatSchemaDtoV2>;

export const ChatSchemaDto = dtozod.union([
  ChatSchemaDtoV2,
  ChatSchemaDtoV1,
]);

export type ChatDto = dtozod.infer<typeof ChatSchemaDto>;

// --- Provider Profiles ---

export const ProviderProfileSchemaDto = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleModelId: missingAsUndefined(dtozod.string()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalProviderProfileSchemaDto }),
}));
export type ProviderProfileDto = dtozod.infer<typeof ProviderProfileSchemaDto>;

export const SettingsSchemaDtoV1 = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleModelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: dtozod.boolean().default(true),
  storageType: StorageTypeSchemaDto,
  providerProfiles: dtozod.array(ProviderProfileSchemaDto).default([]),
  mounts: dtozod.array(MountSchemaDto).default([]),
  heavyContentAlertDismissed: missingAsUndefined(dtozod.boolean()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto }),
}));
export type SettingsDtoV1 = dtozod.infer<typeof SettingsSchemaDtoV1>;

export const SettingsSchemaDtoV2 = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointSchemaDto,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleGeneration: SettingsTitleGenerationSchemaDto,
  storageType: StorageTypeSchemaDto,
  providerProfiles: dtozod.array(ProviderProfileSchemaDto).default([]),
  mounts: dtozod.array(MountSchemaDto).default([]),
  heavyContentAlertDismissed: missingAsUndefined(dtozod.boolean()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalSettingsSchemaDto }),
}));
export type SettingsDtoV2 = dtozod.infer<typeof SettingsSchemaDtoV2>;

export const SettingsSchemaDto = dtozod.union([
  SettingsSchemaDtoV2,
  SettingsSchemaDtoV1,
]);
export type SettingsDto = dtozod.infer<typeof SettingsSchemaDto>;

/**
 * Migration Data Chunk
 *
 * Represents a single unit of heavy data during storage migration.
 * Structural metadata (Settings, Hierarchy, Groups) are handled as
 * complete domain objects during the restoration process.
 */
export type MigrationChunkDto =
  | { type: 'chat', data: ChatDto }
  | {
      type: 'binary_object',
      id: string, // The binaryObjectId
      name: string,
      mimeType: string,
      size: number,
      createdAt: number,
      blob: Blob,
    };

/**
 * Migration State
 * Tracks completed data migrations to ensure they only run once.
 */
export const MigrationStateSchemaDto = dtozod.object({
  completedMigrations: dtozod.array(dtozod.object({
    name: dtozod.string(),
    completedAt: dtozod.number(),

    experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalCompletedMigrationSchemaDto }),
  })),

  experimental: optionalExperimentalFieldSchemaDto({ schema: ExperimentalMigrationStateSchemaDto }),
});
export type MigrationStateDto = dtozod.infer<typeof MigrationStateSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
