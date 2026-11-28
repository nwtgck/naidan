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
  ExperimentalAttachmentDtoV1Schema,
  ExperimentalAttachmentDtoV2Schema,
  ExperimentalBinaryObjectDtoSchema,
  ExperimentalBinaryShardIndexDtoSchema,
  ExperimentalChatContentDtoSchema,
  ExperimentalChatGroupDtoSchema,
  ExperimentalChatMetaIndexDtoSchema,
  ExperimentalChatMetaDtoSchema,
  ExperimentalCompletedMigrationDtoSchema,
  ExperimentalExperimentalTypeEndpointDtoSchema,
  ExperimentalHierarchyChatGroupNodeDtoSchema,
  ExperimentalHierarchyChatNodeDtoSchema,
  ExperimentalHierarchyDtoSchema,
  ExperimentalHttpEndpointDtoSchema,
  ExperimentalLmParametersDtoSchema,
  ExperimentalLlamaCppBrowserEndpointDtoSchema,
  ExperimentalMessageBranchDtoSchema,
  ExperimentalMessageTextPartDtoSchema,
  ExperimentalMessageReasoningPartDtoSchema,
  ExperimentalMessageAttachmentPartDtoSchema,
  ExperimentalMessageToolCallPartDtoSchema,
  ExperimentalMessageToolResultPartDtoSchema,
  ExperimentalMessageInterruptionCancelledDtoSchema,
  ExperimentalMessageInterruptionErrorDtoSchema,
  ExperimentalMessageNodeAssistantDtoSchema,
  ExperimentalMessageNodeSystemDtoSchema,
  ExperimentalMessageNodeToolDtoSchema,
  ExperimentalMessageNodeUserDtoSchema,
  ExperimentalMigrationStateDtoSchema,
  ExperimentalMountVolumeDtoSchema,
  ExperimentalProviderProfileDtoSchema,
  ExperimentalReasoningDtoSchema,
  ExperimentalSettingsDtoSchema,
  ExperimentalSystemPromptAppendDtoSchema,
  ExperimentalSystemPromptOverrideDtoSchema,
  ExperimentalTextOrBinaryObjectBinaryObjectDtoSchema,
  ExperimentalTextOrBinaryObjectTextDtoSchema,
  ExperimentalToolCallFunctionDtoSchema,
  ExperimentalToolCallDtoSchema,
  ExperimentalToolExecutionResultErrorObjectDtoSchema,
  ExperimentalToolExecutionResultErrorDtoSchema,
  ExperimentalToolExecutionResultExecutingDtoSchema,
  ExperimentalToolExecutionResultSuccessDtoSchema,
  ExperimentalTransformersJsEndpointDtoSchema,
  ExperimentalVolumeBaseDtoSchema,
  ExperimentalVolumeIndexDtoSchema,
  optionalExperimentalFieldDtoSchema,
} from './experimental.dto';

export const RoleDtoSchema = dtozod.enum(['user', 'assistant', 'system', 'tool']);
export type RoleDto = dtozod.infer<typeof RoleDtoSchema>;

export const StorageTypeDtoSchema = dtozod.enum(['local', 'opfs', 'memory']);
export type StorageTypeDto = dtozod.infer<typeof StorageTypeDtoSchema>;

export const HttpHeaderDtoSchema = dtozod.tuple([dtozod.string(), dtozod.string()]);
export type HttpHeaderDto = dtozod.infer<typeof HttpHeaderDtoSchema>;

export const HttpEndpointDtoSchema = resolveMissingAsUndefined(dtozod.object({
  type: dtozod.enum(['openai', 'ollama']),
  url: dtozod.string(),
  httpHeaders: missingAsUndefined(dtozod.array(HttpHeaderDtoSchema)),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalHttpEndpointDtoSchema }),
}));

export const TransformersJsEndpointDtoSchema = dtozod.object({
  type: dtozod.literal('transformers_js'),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalTransformersJsEndpointDtoSchema }),
});

export const LlamaCppBrowserEndpointDtoSchema = dtozod.object({
  type: dtozod.literal('llama_cpp_browser'),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalLlamaCppBrowserEndpointDtoSchema }),
});

/**
 * Persisted envelope for experimental endpoint implementations and older
 * llama_cpp_browser records. The concrete endpoint identifier belongs to
 * `experimental.endpoint.type` and is translated by the mapper into a domain
 * endpoint. New llama_cpp_browser records use their own top-level discriminator.
 */
export const ExperimentalTypeEndpointDtoSchema = dtozod.object({
  type: dtozod.literal('experimental_type'),

  experimental: optionalExperimentalFieldDtoSchema({
    schema: ExperimentalExperimentalTypeEndpointDtoSchema,
  }),
});

export const EndpointDtoSchema = resolveMissingAsUndefined(dtozod.discriminatedUnion('type', [
  HttpEndpointDtoSchema,
  TransformersJsEndpointDtoSchema,
  LlamaCppBrowserEndpointDtoSchema,
  ExperimentalTypeEndpointDtoSchema,
]));

export type EndpointDto = dtozod.infer<typeof EndpointDtoSchema>;
export type EndpointTypeDto = EndpointDto['type'];

// --- Language Model Parameters ---

export const ReasoningEffortDtoSchema = dtozod.enum(['none', 'low', 'medium', 'high']);
export type ReasoningEffortDto = dtozod.infer<typeof ReasoningEffortDtoSchema>;

export const ReasoningDtoSchema = resolveMissingAsUndefined(dtozod.object({
  effort: missingAsUndefined(ReasoningEffortDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalReasoningDtoSchema }),
}));
export type ReasoningDto = dtozod.infer<typeof ReasoningDtoSchema>;

export const LmParametersDtoSchema = resolveMissingAsUndefined(dtozod.object({
  temperature: missingAsUndefined(dtozod.number()),
  topP: missingAsUndefined(dtozod.number()),
  maxCompletionTokens: missingAsUndefined(dtozod.number()),
  presencePenalty: missingAsUndefined(dtozod.number()),
  frequencyPenalty: missingAsUndefined(dtozod.number()),
  stop: missingAsUndefined(dtozod.array(dtozod.string())),
  reasoning: missingAsUndefined(ReasoningDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalLmParametersDtoSchema }),
}));
export type LmParametersDto = dtozod.infer<typeof LmParametersDtoSchema>;

const SettingsTitleGenerationDtoSchema = dtozod.union([
  dtozod.literal('disabled'),
  dtozod.object({
    endpoint: dtozod.literal('same_scope'),
    model: dtozod.union([
      dtozod.literal('same_scope'),
      dtozod.object({ id: dtozod.string() }),
    ]),
    lmParameters: dtozod.union([
      dtozod.literal('same_scope'),
      LmParametersDtoSchema,
    ]),
  }),
  dtozod.object({
    endpoint: EndpointDtoSchema,
    model: dtozod.object({ id: dtozod.string() }),
    lmParameters: LmParametersDtoSchema,
  }),
]);

const ScopedTitleGenerationDtoSchema = dtozod.union([
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
      LmParametersDtoSchema,
    ]),
  }),
  dtozod.object({
    endpoint: EndpointDtoSchema,
    model: dtozod.object({ id: dtozod.string() }),
    lmParameters: LmParametersDtoSchema,
  }),
]);

export const SystemPromptDtoSchema = dtozod.discriminatedUnion('behavior', [
  dtozod.object({
    behavior: dtozod.literal('override'),
    content: dtozod.string().nullable(),

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalSystemPromptOverrideDtoSchema }),
  }),
  dtozod.object({
    behavior: dtozod.literal('append'),
    content: dtozod.string(),

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalSystemPromptAppendDtoSchema }),
  }),
]);
export type SystemPromptDto = dtozod.infer<typeof SystemPromptDtoSchema>;

// --- Volume Management & Mounts ---
// User-facing label: "Folder". All internal identifiers use "volume".

export const VolumeTypeDtoSchema = dtozod.enum(['opfs', 'host']);
export type VolumeTypeDto = dtozod.infer<typeof VolumeTypeDtoSchema>;

const VolumeBaseDtoSchema = dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  createdAt: dtozod.number(),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalVolumeBaseDtoSchema }),
});

export const VolumeOpfsDtoSchema = VolumeBaseDtoSchema.extend({
  type: dtozod.literal('opfs'),
});

export const VolumeHostDtoSchema = VolumeBaseDtoSchema.extend({
  type: dtozod.literal('host'),
});

export const VolumeDtoSchema = dtozod.discriminatedUnion('type', [
  VolumeOpfsDtoSchema,
  VolumeHostDtoSchema,
]);
export type VolumeDto = dtozod.infer<typeof VolumeDtoSchema>;

export const VolumeIndexDtoSchema = dtozod.object({
  volumes: dtozod.record(dtozod.string(), VolumeDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalVolumeIndexDtoSchema }),
});
export type VolumeIndexDto = dtozod.infer<typeof VolumeIndexDtoSchema>;

export const MountVolumeDtoSchema = dtozod.object({
  type: dtozod.literal('volume'),
  volumeId: dtozod.string(),
  mountPath: dtozod.string(),
  readOnly: dtozod.boolean(),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMountVolumeDtoSchema }),
});

export const MountDtoSchema = dtozod.discriminatedUnion('type', [
  MountVolumeDtoSchema,
]);
export type MountDto = dtozod.infer<typeof MountDtoSchema>;

// --- Grouping ---

export const ChatGroupDtoV1Schema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  updatedAt: dtozod.number(),
  isCollapsed: dtozod.boolean().default(false),

  endpoint: missingAsUndefined(EndpointDtoSchema),
  modelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: missingAsUndefined(dtozod.boolean()),
  titleModelId: missingAsUndefined(dtozod.string()),
  systemPrompt: missingAsUndefined(SystemPromptDtoSchema),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
  mounts: missingAsUndefined(dtozod.array(MountDtoSchema)),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatGroupDtoSchema }),
}));
export type ChatGroupDtoV1 = dtozod.infer<typeof ChatGroupDtoV1Schema>;

export const ChatGroupDtoV2Schema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  updatedAt: dtozod.number(),
  isCollapsed: dtozod.boolean().default(false),

  endpoint: missingAsUndefined(EndpointDtoSchema),
  modelId: missingAsUndefined(dtozod.string()),
  titleGeneration: ScopedTitleGenerationDtoSchema,
  systemPrompt: missingAsUndefined(SystemPromptDtoSchema),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
  mounts: missingAsUndefined(dtozod.array(MountDtoSchema)),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatGroupDtoSchema }),
}));
export type ChatGroupDtoV2 = dtozod.infer<typeof ChatGroupDtoV2Schema>;

export const ChatGroupDtoSchema = dtozod.union([
  ChatGroupDtoV2Schema,
  ChatGroupDtoV1Schema,
]);
export type ChatGroupDto = dtozod.infer<typeof ChatGroupDtoSchema>;

// --- Hierarchy (Structural Source of Truth) ---

export const HierarchyChatNodeDtoSchema = dtozod.object({
  type: dtozod.literal('chat'),
  id: dtozod.string(),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalHierarchyChatNodeDtoSchema }),
});

export const HierarchyChatGroupNodeDtoSchema = dtozod.object({
  type: dtozod.literal('chat_group'),
  id: dtozod.string(),
  chat_ids: dtozod.array(dtozod.string()),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalHierarchyChatGroupNodeDtoSchema }),
});

export const HierarchyDtoSchema = dtozod.object({
  items: dtozod.array(dtozod.union([
    HierarchyChatNodeDtoSchema,
    HierarchyChatGroupNodeDtoSchema,
  ])),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalHierarchyDtoSchema }),
});

export type HierarchyDto = dtozod.infer<typeof HierarchyDtoSchema>;

// --- Tree-based Message Structure (Recursive) ---

export const AttachmentStatusDtoSchema = dtozod.enum(['persisted', 'memory', 'missing']);

export const BinaryObjectDtoSchema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  mimeType: dtozod.string(),
  size: dtozod.number(),
  createdAt: dtozod.number(),
  name: missingAsUndefined(dtozod.string()),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalBinaryObjectDtoSchema }),
}));
export type BinaryObjectDto = dtozod.infer<typeof BinaryObjectDtoSchema>;

/**
 * Shard Index
 * Stores metadata for all binary objects within a specific shard.
 */
export const BinaryShardIndexDtoSchema = dtozod.object({
  objects: dtozod.record(dtozod.string(), BinaryObjectDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalBinaryShardIndexDtoSchema }),
});
export type BinaryShardIndexDto = dtozod.infer<typeof BinaryShardIndexDtoSchema>;

export const AttachmentDtoV1Schema = dtozod.object({
  id: dtozod.string(),
  originalName: dtozod.string(),
  mimeType: dtozod.string(),
  size: dtozod.number(),
  uploadedAt: dtozod.number(),
  status: AttachmentStatusDtoSchema,

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalAttachmentDtoV1Schema }),
});

export const AttachmentDtoV2Schema = dtozod.object({
  id: dtozod.string(),
  binaryObjectId: dtozod.string(),
  name: dtozod.string(),
  status: AttachmentStatusDtoSchema,

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalAttachmentDtoV2Schema }),
});

export const AttachmentDtoSchema = dtozod.union([
  AttachmentDtoV2Schema,
  AttachmentDtoV1Schema,
]);
export type AttachmentDto = dtozod.infer<typeof AttachmentDtoSchema>;

export const ToolCallDtoSchema = dtozod.object({
  id: dtozod.string(),
  type: dtozod.literal('function'),
  function: dtozod.object({
    name: dtozod.string(),
    arguments: dtozod.string(),

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolCallFunctionDtoSchema }),
  }),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolCallDtoSchema }),
});

export type ToolCallDto = dtozod.infer<typeof ToolCallDtoSchema>;

export const TextOrBinaryObjectDtoSchema = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('text'), text: dtozod.string(), experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalTextOrBinaryObjectTextDtoSchema }) }),
  dtozod.object({ type: dtozod.literal('binary_object'), id: dtozod.string(), experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalTextOrBinaryObjectBinaryObjectDtoSchema }) }),
]);
export type TextOrBinaryObjectDto = dtozod.infer<typeof TextOrBinaryObjectDtoSchema>;

export const ToolExecutionResultDtoSchema = dtozod.discriminatedUnion('status', [
  dtozod.object({ toolCallId: dtozod.string(), status: dtozod.literal('executing'), experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolExecutionResultExecutingDtoSchema }) }),
  dtozod.object({
    toolCallId: dtozod.string(),
    status: dtozod.literal('success'),
    content: TextOrBinaryObjectDtoSchema,

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolExecutionResultSuccessDtoSchema }),
  }),
  dtozod.object({
    toolCallId: dtozod.string(),
    status: dtozod.literal('error'),
    error: dtozod.object({
      code: dtozod.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']),
      message: TextOrBinaryObjectDtoSchema,

      experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolExecutionResultErrorObjectDtoSchema }),
    }),

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalToolExecutionResultErrorDtoSchema }),
  }),
]);
export type ToolExecutionResultDto = dtozod.infer<typeof ToolExecutionResultDtoSchema>;

export const MessageNodeDtoV1Schema = resolveMissingAsUndefined(
  dtozod.discriminatedUnion('role', [
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('user'),
      content: dtozod.string(),
      attachments: missingAsUndefined(dtozod.array(AttachmentDtoSchema)),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.undefined()),
      modelId: missingAsUndefined(dtozod.undefined()),
      lmParameters: missingAsUndefined(LmParametersDtoSchema),
      toolCalls: missingAsUndefined(dtozod.undefined()),
      results: missingAsUndefined(dtozod.undefined()),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchDtoV1Schema {
        return MessageBranchDtoV1Schema;
      },

      experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeUserDtoSchema }),
    }),
    dtozod.object({
      id: dtozod.string(),
      role: dtozod.literal('assistant'),
      content: dtozod.string(),
      attachments: missingAsUndefined(dtozod.undefined()),
      timestamp: dtozod.number(),
      thinking: missingAsUndefined(dtozod.string()),
      modelId: missingAsUndefined(dtozod.string()),
      lmParameters: missingAsUndefined(LmParametersDtoSchema),
      toolCalls: missingAsUndefined(dtozod.array(ToolCallDtoSchema)),
      results: missingAsUndefined(dtozod.undefined()),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchDtoV1Schema {
        return MessageBranchDtoV1Schema;
      },

      experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeAssistantDtoSchema }),
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
      get replies(): typeof MessageBranchDtoV1Schema {
        return MessageBranchDtoV1Schema;
      },

      experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeSystemDtoSchema }),
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
      results: dtozod.array(ToolExecutionResultDtoSchema),
      // This key belongs to V2 and must be absent in a V1 record.
      parts: dtozod.never().exactOptional(),
      get replies(): typeof MessageBranchDtoV1Schema {
        return MessageBranchDtoV1Schema;
      },

      experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeToolDtoSchema }),
    }),
  ]),
);
export type MessageNodeDtoV1 = dtozod.infer<typeof MessageNodeDtoV1Schema>;

// A named interface anchors mutual recursion; a type alias reintroduces TS2502/TS7022.
// These interfaces are part of the exported schemas' inferred types. Keep them
// exported so downstream schema compositions can emit named declarations,
// without widening the recursive branches or exposing native Zod methods.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- This identity is required for recursive schema inference.
export interface MessageBranchSchemaTypeDtoV1 extends dtozod.DtoObject<{
  items: dtozod.DtoArray<typeof MessageNodeDtoV1Schema>;
  experimental: ReturnType<typeof optionalExperimentalFieldDtoSchema<typeof ExperimentalMessageBranchDtoSchema>>;
}> {}

export const MessageBranchDtoV1Schema: MessageBranchSchemaTypeDtoV1 = dtozod.object({
  get items(): dtozod.DtoArray<typeof MessageNodeDtoV1Schema> {
    return dtozod.array(MessageNodeDtoV1Schema);
  },

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageBranchDtoSchema }),
});
export type MessageBranchDtoV1 = dtozod.infer<typeof MessageBranchDtoV1Schema>;

// A named interface anchors mutual recursion; a type alias reintroduces TS2502/TS7022.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- This identity is required for recursive schema inference.
export interface MessageBranchSchemaTypeDtoV2 extends dtozod.DtoObject<{
  items: dtozod.DtoArray<typeof MessageNodeDtoV2Schema>;
  experimental: ReturnType<typeof optionalExperimentalFieldDtoSchema<typeof ExperimentalMessageBranchDtoSchema>>;
}> {}

export const MessageBranchDtoV2Schema: MessageBranchSchemaTypeDtoV2 = dtozod.object({
  get items(): dtozod.DtoArray<typeof MessageNodeDtoV2Schema> {
    return dtozod.array(MessageNodeDtoV2Schema);
  },

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageBranchDtoSchema }),
});
export type MessageBranchDtoV2 = dtozod.infer<typeof MessageBranchDtoV2Schema>;

export const MessageNodeDtoV2Schema = resolveMissingAsUndefined(dtozod.discriminatedUnion('role', [
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('user'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.undefined()),
    lmParameters: missingAsUndefined(LmParametersDtoSchema),
    parts: dtozod.array(
      dtozod.discriminatedUnion('type', [
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('text'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageTextPartDtoSchema }),
        })),
        dtozod.object({
          type: dtozod.literal('attachment'),
          attachment: AttachmentDtoV2Schema,

          experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageAttachmentPartDtoSchema }),
        }),
      ]),
    ),
    replies: MessageBranchDtoV2Schema,

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeUserDtoSchema }),
  }),
  dtozod.object({
    id: dtozod.string(),
    role: dtozod.literal('assistant'),
    createdAt: dtozod.number(),
    modelId: missingAsUndefined(dtozod.string()),
    lmParameters: missingAsUndefined(LmParametersDtoSchema),
    parts: dtozod.array(
      dtozod.discriminatedUnion('type', [
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('reasoning'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageReasoningPartDtoSchema }),
        })),
        resolveMissingAsUndefined(dtozod.object({
          type: dtozod.literal('text'),
          text: dtozod.string(),
          completeness: missingAsUndefined(dtozod.literal('partial')),

          experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageTextPartDtoSchema }),
        })),
        dtozod.object({
          type: dtozod.literal('tool_call'),
          toolCall: ToolCallDtoSchema,

          experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageToolCallPartDtoSchema }),
        }),
      ]),
    ),
    interruption: missingAsUndefined(dtozod.discriminatedUnion('type', [
      dtozod.object({
        type: dtozod.literal('cancelled'),

        experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageInterruptionCancelledDtoSchema }),
      }),
      dtozod.object({
        type: dtozod.literal('error'),
        // This message may contain text localized when the error was recorded.
        // Later locale changes do not retranslate this persisted text.
        message: dtozod.string(),

        experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageInterruptionErrorDtoSchema }),
      }),
    ])),
    replies: MessageBranchDtoV2Schema,

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeAssistantDtoSchema }),
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

        experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageTextPartDtoSchema }),
      })),
    ),
    replies: MessageBranchDtoV2Schema,

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeSystemDtoSchema }),
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
        result: ToolExecutionResultDtoSchema,

        experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageToolResultPartDtoSchema }),
      }),
    ),
    replies: MessageBranchDtoV2Schema,

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageNodeToolDtoSchema }),
  }),
]));
export type MessageNodeDtoV2 = dtozod.infer<typeof MessageNodeDtoV2Schema>;

export const MessageNodeDtoSchema = dtozod.union([
  MessageNodeDtoV2Schema,
  MessageNodeDtoV1Schema,
]);
export type MessageNodeDto = dtozod.infer<typeof MessageNodeDtoSchema>;

export const MessageBranchDtoSchema = dtozod.object({
  items: dtozod.array(MessageNodeDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMessageBranchDtoSchema }),
});

/**
 * Chat Metadata
 * Contains all attributes except the heavy message tree.
 */
export const ChatMetaDtoV1Schema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  title: dtozod.string().nullable(),
  currentLeafId: missingAsUndefined(dtozod.string()),
  updatedAt: dtozod.number(),
  createdAt: dtozod.number(),
  debugEnabled: dtozod.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointDtoSchema),
  modelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: missingAsUndefined(dtozod.boolean()),
  titleModelId: missingAsUndefined(dtozod.string()),
  originChatId: missingAsUndefined(dtozod.string()),
  originMessageId: missingAsUndefined(dtozod.string()),

  systemPrompt: missingAsUndefined(SystemPromptDtoSchema),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
  mounts: missingAsUndefined(dtozod.array(MountDtoSchema)),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatMetaDtoSchema }),
}));
export type ChatMetaDtoV1 = dtozod.infer<typeof ChatMetaDtoV1Schema>;

export const ChatMetaDtoV2Schema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  title: dtozod.string().nullable(),
  currentLeafId: missingAsUndefined(dtozod.string()),
  updatedAt: dtozod.number(),
  createdAt: dtozod.number(),
  debugEnabled: dtozod.boolean().optional().default(false),

  endpoint: missingAsUndefined(EndpointDtoSchema),
  modelId: missingAsUndefined(dtozod.string()),
  titleGeneration: ScopedTitleGenerationDtoSchema,
  originChatId: missingAsUndefined(dtozod.string()),
  originMessageId: missingAsUndefined(dtozod.string()),

  systemPrompt: missingAsUndefined(SystemPromptDtoSchema),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
  mounts: missingAsUndefined(dtozod.array(MountDtoSchema)),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatMetaDtoSchema }),
}));
export type ChatMetaDtoV2 = dtozod.infer<typeof ChatMetaDtoV2Schema>;

export const ChatMetaDtoSchema = dtozod.union([
  ChatMetaDtoV2Schema,
  ChatMetaDtoV1Schema,
]);

export type ChatMetaDto = dtozod.infer<typeof ChatMetaDtoSchema>;

/**
 * Chat Meta Index (Legacy/Bulk operations)
 */
export const ChatMetaIndexDtoSchema = dtozod.object({
  entries: dtozod.array(ChatMetaDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatMetaIndexDtoSchema }),
});

export type ChatMetaIndexDto = dtozod.infer<typeof ChatMetaIndexDtoSchema>;

/**
 * Chat Content
 * Contains the heavy message tree structure.
 * Stored in individual files to scale.
 */
export const ChatContentDtoSchema = resolveMissingAsUndefined(dtozod.object({
  root: MessageBranchDtoSchema,
  currentLeafId: missingAsUndefined(dtozod.string()),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalChatContentDtoSchema }),
}));

export type ChatContentDto = dtozod.infer<typeof ChatContentDtoSchema>;

/**
 * Combined Chat DTO
 * Used for memory handling and migration (full data export).
 */
export const ChatDtoV1Schema = ChatMetaDtoV1Schema.safeExtend({
  root: missingAsUndefined(MessageBranchDtoSchema),
  currentLeafId: missingAsUndefined(dtozod.string()),

  // Legacy support field
  messages: missingAsUndefined(dtozod.array(dtozod.unknown())),
});
export type ChatDtoV1 = dtozod.infer<typeof ChatDtoV1Schema>;

export const ChatDtoV2Schema = ChatMetaDtoV2Schema.safeExtend({
  root: missingAsUndefined(MessageBranchDtoSchema),
  currentLeafId: missingAsUndefined(dtozod.string()),

  // Legacy support field
  messages: missingAsUndefined(dtozod.array(dtozod.unknown())),
});
export type ChatDtoV2 = dtozod.infer<typeof ChatDtoV2Schema>;

export const ChatDtoSchema = dtozod.union([
  ChatDtoV2Schema,
  ChatDtoV1Schema,
]);

export type ChatDto = dtozod.infer<typeof ChatDtoSchema>;

// --- Provider Profiles ---

export const ProviderProfileDtoSchema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  name: dtozod.string(),
  endpoint: EndpointDtoSchema,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleModelId: missingAsUndefined(dtozod.string()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalProviderProfileDtoSchema }),
}));
export type ProviderProfileDto = dtozod.infer<typeof ProviderProfileDtoSchema>;

export const SettingsDtoV1Schema = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointDtoSchema,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleModelId: missingAsUndefined(dtozod.string()),
  autoTitleEnabled: dtozod.boolean().default(true),
  storageType: StorageTypeDtoSchema,
  providerProfiles: dtozod.array(ProviderProfileDtoSchema).default([]),
  mounts: dtozod.array(MountDtoSchema).default([]),
  heavyContentAlertDismissed: missingAsUndefined(dtozod.boolean()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalSettingsDtoSchema }),
}));
export type SettingsDtoV1 = dtozod.infer<typeof SettingsDtoV1Schema>;

export const SettingsDtoV2Schema = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointDtoSchema,
  defaultModelId: missingAsUndefined(dtozod.string()),
  titleGeneration: SettingsTitleGenerationDtoSchema,
  storageType: StorageTypeDtoSchema,
  providerProfiles: dtozod.array(ProviderProfileDtoSchema).default([]),
  mounts: dtozod.array(MountDtoSchema).default([]),
  heavyContentAlertDismissed: missingAsUndefined(dtozod.boolean()),
  systemPrompt: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalSettingsDtoSchema }),
}));
export type SettingsDtoV2 = dtozod.infer<typeof SettingsDtoV2Schema>;

export const SettingsDtoSchema = dtozod.union([
  SettingsDtoV2Schema,
  SettingsDtoV1Schema,
]);
export type SettingsDto = dtozod.infer<typeof SettingsDtoSchema>;

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
export const MigrationStateDtoSchema = dtozod.object({
  completedMigrations: dtozod.array(dtozod.object({
    name: dtozod.string(),
    completedAt: dtozod.number(),

    experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalCompletedMigrationDtoSchema }),
  })),

  experimental: optionalExperimentalFieldDtoSchema({ schema: ExperimentalMigrationStateDtoSchema }),
});
export type MigrationStateDto = dtozod.infer<typeof MigrationStateDtoSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
