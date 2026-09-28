import { z } from 'zod';

import { UI_LOCALES } from '@/01-models/ui-locale';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

const EmptyExperimentalSchemaDto = resolveMissingAsUndefined(z.object({}));

export const ExperimentalCalculatorToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.calculator'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalChoicesToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.choices'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWikipediaToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wikipedia'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWeshNaidanSysfsAccessScopeSchemaDto = z.enum([
  'none',
  'current_chat_only',
  'current_chat_with_chat_group',
  'main_chats',
]);


export const ExperimentalWeshToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wesh'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
  naidanSysfs: resolveMissingAsUndefined(z.object({
    accessScope: ExperimentalWeshNaidanSysfsAccessScopeSchemaDto,
  })),
}));

export const ExperimentalToolConfigSchemaDto = z.discriminatedUnion('key', [
  ExperimentalCalculatorToolConfigSchemaDto,
  ExperimentalChoicesToolConfigSchemaDto,
  ExperimentalWikipediaToolConfigSchemaDto,
  ExperimentalWeshToolConfigSchemaDto,
]);
export type ExperimentalToolConfigDto = z.infer<typeof ExperimentalToolConfigSchemaDto>;

export const ExperimentalToolConfigsSchemaDto = z.array(ExperimentalToolConfigSchemaDto);
export type ExperimentalToolConfigsDto = z.infer<typeof ExperimentalToolConfigsSchemaDto>;


/**
 * Experimental payload owned by ExperimentalTypeEndpointSchemaDto.
 *
 * `experimental_type` is a stable DTO-only envelope. Its concrete endpoint
 * identity is stored in this payload and mapped to a normal domain endpoint;
 * `experimental_type` itself must not appear in the domain model.
 *
 * The shared experimental reader isolates unreadable endpoint settings while
 * allowing the containing settings to load with an unsupported endpoint.
 */
export const ExperimentalExperimentalTypeEndpointSchemaDto =
  resolveMissingAsUndefined(z.object({
    endpoint: missingAsUndefined(z.union([
      resolveMissingAsUndefined(z.object({
        type: z.literal('browser_provided_lm'),
      })),
      resolveMissingAsUndefined(z.object({
        type: z.literal('llama_cpp_browser'),
      })),
    ])),
  }));

export const ExperimentalHttpEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTransformersJsEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalReasoningSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalLmParametersSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptOverrideSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptAppendSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeBaseSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMountVolumeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatGroupSchemaDto = resolveMissingAsUndefined(z.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
}));
export const ExperimentalHierarchyChatNodeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalHierarchyChatGroupNodeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalHierarchySchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalBinaryObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalBinaryShardIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalAttachmentSchemaDtoV1 = EmptyExperimentalSchemaDto;
export const ExperimentalAttachmentSchemaDtoV2 = EmptyExperimentalSchemaDto;
export const ExperimentalToolCallSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolCallFunctionSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTextOrBinaryObjectTextSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTextOrBinaryObjectBinaryObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultExecutingSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultSuccessSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultErrorSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultErrorObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageTextPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageReasoningPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageAttachmentPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageToolCallPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageToolResultPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageInterruptionCancelledSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageInterruptionErrorSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeUserSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeAssistantSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeSystemSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeToolSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageBranchSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatMetaSchemaDto = resolveMissingAsUndefined(z.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
}));
export const ExperimentalChatMetaIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatContentSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalProviderProfileSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalCompletedMigrationSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMigrationStateSchemaDto = EmptyExperimentalSchemaDto;

export const ExperimentalSettingsLocaleSchemaDto = z.enum(UI_LOCALES);

const ImageGenerationPathSchemaDto = z.string().min(1).refine(value =>
  !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const BrowserImageModelLocationSchemaDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opfs'), path: ImageGenerationPathSchemaDto.refine(path => path.startsWith('models/')) }),
  z.object({ kind: z.literal('host'), directoryId: z.string().min(1), path: ImageGenerationPathSchemaDto }),
]);
const BrowserImageModelSelectionSchemaDto = z.object({
  primary: z.object({
    slot: z.enum(['model', 'diffusion']),
    location: BrowserImageModelLocationSchemaDto,
  }),
  components: z.array(z.object({
    slot: z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    choice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('file'), location: BrowserImageModelLocationSchemaDto }),
      z.object({ kind: z.literal('none') }),
    ]),
  })).max(5).refine(components => new Set(components.map(component => component.slot)).size === components.length),
  loras: z.array(z.object({
    location: BrowserImageModelLocationSchemaDto,
    enabled: z.enum(['enabled', 'disabled']),
    strength: z.number().finite().min(-10).max(10),
  })).max(16),
});
const BrowserImageGenerationSchemaDto = resolveMissingAsUndefined(z.object({
  width: missingAsUndefined(z.number().int().min(128).max(2048).multipleOf(64)),
  height: missingAsUndefined(z.number().int().min(128).max(2048).multipleOf(64)),
  seedMode: missingAsUndefined(z.enum(['random', 'fixed'])),
  seed: missingAsUndefined(z.string().max(20).regex(/^-?(0|[1-9][0-9]*)$/).pipe(z.string().refine(value => BigInt(value) >= -1n && BigInt(value) <= 9223372036854775807n))),
  historyPersistence: missingAsUndefined(z.enum(['enabled', 'disabled'])),
  modelDownloadDestination: missingAsUndefined(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('opfs') }),
    z.object({ kind: z.literal('host'), directoryId: z.string().min(1) }),
  ])),
  imageDownload: missingAsUndefined(resolveMissingAsUndefined(z.object({
    format: missingAsUndefined(z.enum(['png', 'webp', 'jpeg'])),
    metadata: missingAsUndefined(z.enum(['include', 'omit'])),
  }))),
  modelSelection: missingAsUndefined(BrowserImageModelSelectionSchemaDto),
  preview: missingAsUndefined(resolveMissingAsUndefined(z.object({
    enabled: missingAsUndefined(z.enum(['enabled', 'disabled'])),
    mode: missingAsUndefined(z.enum(['projection', 'vae'])),
    interval: missingAsUndefined(z.number().int().min(1).max(100)),
    startStep: missingAsUndefined(z.number().int().min(1).max(100)),
    maxEdge: missingAsUndefined(z.union([z.literal(0), z.number().int().min(64).max(2048)])),
  }))),
  keepPreviews: missingAsUndefined(z.enum(['enabled', 'disabled'])),
  maxPreviews: missingAsUndefined(z.number().int().min(1).max(100)),
  maxResults: missingAsUndefined(z.number().int().min(1).max(100)),
  bf16WeightType: missingAsUndefined(z.enum(['f32', 'f16'])),
}));

export const ExperimentalSettingsSchemaDto = resolveMissingAsUndefined(z.object({
  locale: missingAsUndefined(ExperimentalSettingsLocaleSchemaDto),
  markdownRendering: missingAsUndefined(z.union([
    z.literal('block_markdown'),
    z.literal('monolithic_html'),
  ])),
  toolConfigPersistence: missingAsUndefined(z.literal('enabled')),
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
  fakeLm: missingAsUndefined(z.literal('enabled')),
  sidebarSendMessageReorder: missingAsUndefined(z.union([
    z.literal('disabled'),
    z.literal('move_sent_chat'),
  ])),
  globalSearch: missingAsUndefined(resolveMissingAsUndefined(z.object({
    scope: missingAsUndefined(z.enum(['all', 'current_thread', 'title_only'])),
    roleFilter: missingAsUndefined(z.enum(['all', 'user', 'assistant'])),
    previewMode: missingAsUndefined(z.enum(['always', 'peek', 'disabled'])),
    previewContextSize: missingAsUndefined(z.union([
      z.number(),
      z.literal('full'),
    ])),
  }))),
  browserImageGeneration: missingAsUndefined(BrowserImageGenerationSchemaDto),
  hostModelDirectories: missingAsUndefined(z.array(z.object({
    id: z.string(),
    name: z.string(),
  }))),
}));

const ExperimentalUnreadableRootKey = '_root';

type ExperimentalUnreadable = Readonly<Record<string, unknown>>;

type ExperimentalOutput<TSchema extends z.ZodObject> = z.output<TSchema> & {
  readonly unreadable?: ExperimentalUnreadable,
};

const attachUnreadable = <T extends object>({
  value,
  unreadable,
}: {
  value: T,
  unreadable: ExperimentalUnreadable,
}): T => {
  Object.defineProperty(value, 'unreadable', {
    value: unreadable,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return value;
};

export const optionalExperimentalFieldSchemaDto = <TSchema extends z.ZodObject>({
  schema,
}: {
  schema: TSchema,
}) => {
  // Experimental fields intentionally break the normal DTO rule that new optional
  // persisted fields should materialize as `key: undefined`. This helper is used
  // broadly across DTO objects, so emitting `experimental: undefined` everywhere
  // would add runtime overhead and review noise. The field itself is therefore
  // optional, while fields inside the experimental object still use normal DTO
  // schema rules.
  const transformed = z.unknown().transform((raw): ExperimentalOutput<TSchema> => {
    const empty = schema.parse({}) as ExperimentalOutput<TSchema>;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return attachUnreadable({
        value: empty,
        unreadable: { [ExperimentalUnreadableRootKey]: raw },
      });
    }

    const input = raw as Record<string, unknown>;
    const valueInput: Record<string, unknown> = {};
    const unreadable: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(input)) {
      const fieldSchema = schema.shape[key];

      if (fieldSchema === undefined) {
        unreadable[key] = rawValue;
        continue;
      }

      const result = fieldSchema.safeParse(rawValue);

      if (result.success) {
        valueInput[key] = result.data;
      } else {
        unreadable[key] = rawValue;
      }
    }

    const value = schema.parse(valueInput) as ExperimentalOutput<TSchema>;

    return Object.keys(unreadable).length === 0
      ? value
      : attachUnreadable({ value, unreadable });
  }) as z.ZodType<ExperimentalOutput<TSchema>, unknown>;

  return transformed.optional();
};


// Image history is deliberately independent of chat persistence and runtime
// transport defaults. Stored requests describe what was requested, not a
// guarantee that a future runtime can reproduce the same image.
const ImageHistoryRawIdSchemaDto = z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/);
const ImageGenerationFileMetadataSchemaDto = {
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  lastModified: z.number().finite().nonnegative(),
};
const ImageGenerationModelFileSchemaDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opfs'), path: ImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
  z.object({ type: z.literal('host'), directoryId: z.string().min(1), path: ImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
  z.object({ type: z.literal('file'), ...ImageGenerationFileMetadataSchemaDto }),
]);
const ImageGenerationImageSchemaDto = z.object({
  binaryObjectId: ImageHistoryRawIdSchemaDto,
  name: z.string().min(1),
});

export const ExperimentalImageGenerationSchemaDto = z.object({
  id: ImageHistoryRawIdSchemaDto,
  createdAt: z.number().finite().nonnegative(),
  request: z.object({
    parameters: z.object({
      prompt: z.string(),
      negativePrompt: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      steps: z.number().int().positive(),
      guidance: z.number().finite(),
      seed: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
      sampler: z.enum(['auto', 'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'lcm']),
      scheduler: z.enum(['auto', 'discrete', 'karras', 'exponential', 'simple', 'sgm_uniform']),
      distilledGuidance: z.number().finite(),
      vaeTiling: z.boolean(),
      vaeTileSize: z.number().int().positive(),
      flashAttention: z.boolean(),
      bf16WeightType: z.enum(['f32', 'f16']),
      qwenVaePolicy: z.enum(['bounded', 'native']),
      conditioningCacheSize: z.number().int().nonnegative(),
      modelArguments: z.string(),
    }),
    models: z.array(z.object({
      slot: z.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']),
      path: ImageGenerationPathSchemaDto,
      file: ImageGenerationModelFileSchemaDto,
      companions: z.array(z.object({ path: ImageGenerationPathSchemaDto, file: ImageGenerationModelFileSchemaDto })),
    })),
    loras: z.array(z.object({
      path: ImageGenerationPathSchemaDto,
      file: ImageGenerationModelFileSchemaDto,
      strength: z.number().finite(),
    })),
    imageInputs: resolveMissingAsUndefined(z.object({
      initImage: missingAsUndefined(ImageGenerationImageSchemaDto),
      strength: z.number().finite(),
      referenceImages: z.array(ImageGenerationImageSchemaDto),
    })),
    preview: z.object({
      enabled: z.boolean(),
      interval: z.number().int().positive(),
      startStep: z.number().int().positive(),
      mode: z.enum(['projection', 'vae']),
      maxEdge: z.number().int().nonnegative(),
    }),
    runtime: resolveMissingAsUndefined(z.object({
      sourceCommit: z.string(),
      profile: z.enum(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']),
      weightResidency: z.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']),
      gpuBudgetMiB: missingAsUndefined(z.number().finite().nonnegative()),
    })),
  }),
  result: z.object({
    binaryObjectId: ImageHistoryRawIdSchemaDto,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    modelVersion: z.string(),
    uniformOutput: z.boolean(),
    elapsedMs: z.number().finite().nonnegative(),
  }),
  previews: z.array(z.object({
    binaryObjectId: ImageHistoryRawIdSchemaDto,
    step: z.number().int().positive(),
    steps: z.number().int().positive(),
    mode: z.enum(['projection', 'vae']),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })),
});
export type ExperimentalImageGenerationDto = z.infer<typeof ExperimentalImageGenerationSchemaDto>;

export const ExperimentalImageGenerationSummarySchemaDto = z.object({
  id: ImageHistoryRawIdSchemaDto,
  createdAt: z.number().finite().nonnegative(),
  prompt: z.string(),
  modelName: z.string(),
  binaryObjectId: ImageHistoryRawIdSchemaDto,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  previewCount: z.number().int().nonnegative(),
});
export type ExperimentalImageGenerationSummaryDto = z.infer<typeof ExperimentalImageGenerationSummarySchemaDto>;

export const ExperimentalImageGenerationIndexSchemaDto = z.object({
  generations: z.record(ImageHistoryRawIdSchemaDto, ExperimentalImageGenerationSummarySchemaDto),
});
export type ExperimentalImageGenerationIndexDto = z.infer<typeof ExperimentalImageGenerationIndexSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
