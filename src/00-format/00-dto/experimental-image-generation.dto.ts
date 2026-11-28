import * as dtozod from '@/utils/dtozod';
import { EndpointDtoSchema, LmParametersDtoSchema } from './dto';
import {
  ExperimentalBrowserImageModelSelectionDtoSchema,
  ExperimentalImageGenerationPathDtoSchema,
  ExperimentalImageInferenceLocationPreferenceDtoSchema,
  ExperimentalRemoteImageModelEditorDtoSchema,
  ExperimentalRemoteImageModelFileDtoSchema,
} from './experimental.dto';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';

export const ExperimentalRemoteImageModelSelectionDtoSchema = dtozod.object({
  primary: dtozod.object({ slot: dtozod.enum(['model', 'diffusion']), file: ExperimentalRemoteImageModelFileDtoSchema }),
  components: dtozod.array(dtozod.object({ slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']), file: ExperimentalRemoteImageModelFileDtoSchema })),
  loras: dtozod.array(dtozod.object({ file: ExperimentalRemoteImageModelFileDtoSchema, strength: dtozod.number() })),
});
export const ExperimentalImageGenerationRuntimeDtoSchema = dtozod.union([
  resolveMissingAsUndefined(dtozod.object({
    sourceCommit: dtozod.string(),
    profile: dtozod.enum(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']),
    weightResidency: dtozod.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']),
    gpuBudgetMiB: missingAsUndefined(dtozod.number()),
  })),
  resolveMissingAsUndefined(dtozod.object({
    profile: dtozod.literal('naidan-rpc'),
    registrationId: dtozod.string(),
    peerPublicKey: dtozod.string(),
    label: dtozod.string(),
    // An unfinished draft can exist before a model is selected. Actual
    // generation requires an explicit model selection at the RPC boundary.
    modelSelection: missingAsUndefined(ExperimentalRemoteImageModelSelectionDtoSchema),
  })),
]);
export type ExperimentalImageGenerationRuntimeDto = dtozod.infer<typeof ExperimentalImageGenerationRuntimeDtoSchema>;

// Image history is deliberately independent of chat persistence and runtime
// transport defaults. Stored requests describe what was requested, not a
// guarantee that a future runtime can reproduce the same image.
const ImageHistoryRawIdDtoSchema = dtozod.string();
const ImageGenerationFileMetadataDtoSchema = {
  name: dtozod.string(),
  size: dtozod.number(),
  lastModified: dtozod.number(),
};
const ImageGenerationModelFileDtoSchema = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('temp'), path: ExperimentalImageGenerationPathDtoSchema, ...ImageGenerationFileMetadataDtoSchema }),
  dtozod.object({ type: dtozod.literal('opfs'), path: ExperimentalImageGenerationPathDtoSchema, ...ImageGenerationFileMetadataDtoSchema }),
  dtozod.object({ type: dtozod.literal('host'), directoryId: dtozod.string(), path: ExperimentalImageGenerationPathDtoSchema, ...ImageGenerationFileMetadataDtoSchema }),
  dtozod.object({ type: dtozod.literal('file'), ...ImageGenerationFileMetadataDtoSchema }),
]);
const ImageGenerationImageDtoSchema = dtozod.object({
  binaryObjectId: ImageHistoryRawIdDtoSchema,
  name: dtozod.string(),
});

const ImageGenerationSamplingDtoSchema = dtozod.object({
  sampler: dtozod.object({ id: dtozod.number(), name: dtozod.string().optional() }),
  scheduler: dtozod.object({ id: dtozod.number(), name: dtozod.string().optional() }),
});

const ImageGenerationResolvedParametersDtoSchema = dtozod.object({
  steps: dtozod.number(),
  guidance: dtozod.number(),
  vaeTileSize: dtozod.number(),
});

export const ExperimentalImageGenerationDtoSchema = dtozod.object({
  id: ImageHistoryRawIdDtoSchema,
  createdAt: dtozod.number(),
  request: dtozod.object({
    parameters: dtozod.object({
      prompt: dtozod.string(),
      negativePrompt: dtozod.string(),
      width: dtozod.number(),
      height: dtozod.number(),
      steps: dtozod.number(),
      guidance: dtozod.number(),
      seed: dtozod.string(),
      sampler: dtozod.enum(['auto', 'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'lcm']),
      scheduler: dtozod.enum(['auto', 'discrete', 'karras', 'exponential', 'simple', 'sgm_uniform']),
      distilledGuidance: dtozod.number(),
      vaeTiling: dtozod.boolean().optional(),
      vaeTileSize: dtozod.number().optional(),
      flashAttention: dtozod.boolean().optional(),
      bf16WeightType: dtozod.enum(['f32', 'f16', 'bf16']).optional(),
      qwenVaePolicy: dtozod.enum(['bounded', 'native']).optional(),
      conditioningCacheSize: dtozod.number().optional(),
      modelArguments: dtozod.string().optional(),
    }),
    models: dtozod.array(dtozod.object({
      slot: dtozod.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']),
      path: ExperimentalImageGenerationPathDtoSchema,
      file: ImageGenerationModelFileDtoSchema,
      companions: dtozod.array(dtozod.object({ path: ExperimentalImageGenerationPathDtoSchema, file: ImageGenerationModelFileDtoSchema })),
    })),
    loras: dtozod.array(dtozod.object({
      path: ExperimentalImageGenerationPathDtoSchema,
      file: ImageGenerationModelFileDtoSchema,
      strength: dtozod.number(),
    })),
    imageInputs: resolveMissingAsUndefined(dtozod.object({
      initImage: missingAsUndefined(ImageGenerationImageDtoSchema),
      strength: dtozod.number(),
      referenceImages: dtozod.array(ImageGenerationImageDtoSchema),
    })),
    preview: dtozod.object({
      enabled: dtozod.boolean(),
      interval: dtozod.number(),
      startStep: dtozod.number(),
      mode: dtozod.enum(['projection', 'vae']),
      maxEdge: dtozod.number(),
    }),
    runtime: ExperimentalImageGenerationRuntimeDtoSchema,
  }),
  result: dtozod.union([
    dtozod.object({
      binaryObjectId: ImageHistoryRawIdDtoSchema,
      width: dtozod.number(),
      height: dtozod.number(),
      elapsedMs: dtozod.number(),
      confirmation: dtozod.literal('confirmed').optional(),
      modelVersion: dtozod.string(),
      uniformOutput: dtozod.boolean(),
      sampling: ImageGenerationSamplingDtoSchema.optional(),
      resolvedParameters: ImageGenerationResolvedParametersDtoSchema.optional(),
    }),
    dtozod.object({
      binaryObjectId: ImageHistoryRawIdDtoSchema,
      width: dtozod.number(),
      height: dtozod.number(),
      elapsedMs: dtozod.number(),
      confirmation: dtozod.literal('unconfirmed'),
      modelVersion: dtozod.string().optional(),
      uniformOutput: dtozod.boolean().optional(),
      sampling: ImageGenerationSamplingDtoSchema.optional(),
      resolvedParameters: ImageGenerationResolvedParametersDtoSchema.optional(),
    }),
  ]),
  previews: dtozod.array(dtozod.object({
    binaryObjectId: ImageHistoryRawIdDtoSchema,
    step: dtozod.number(),
    steps: dtozod.number(),
    mode: dtozod.enum(['projection', 'vae']),
    width: dtozod.number(),
    height: dtozod.number(),
  })),
});
export type ExperimentalImageGenerationDto = dtozod.infer<typeof ExperimentalImageGenerationDtoSchema>;

export const ExperimentalImageGenerationSummaryDtoSchema = dtozod.object({
  id: ImageHistoryRawIdDtoSchema,
  createdAt: dtozod.number(),
  prompt: dtozod.string(),
  modelName: dtozod.string(),
  binaryObjectId: ImageHistoryRawIdDtoSchema,
  width: dtozod.number(),
  height: dtozod.number(),
  previewCount: dtozod.number(),
});
export type ExperimentalImageGenerationSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationSummaryDtoSchema>;

export const ExperimentalImageGenerationIndexDtoSchema = dtozod.object({
  generations: dtozod.record(ImageHistoryRawIdDtoSchema, ExperimentalImageGenerationSummaryDtoSchema),
});
export type ExperimentalImageGenerationIndexDto = dtozod.infer<typeof ExperimentalImageGenerationIndexDtoSchema>;

const ExperimentalImageGenerationIdDtoSchema = dtozod.string();
const ExperimentalImageGenerationRevisionDtoSchema = dtozod.number();
const ExperimentalImageGenerationTimestampDtoSchema = dtozod.number();
const ExperimentalImageGenerationTagNameDtoSchema = dtozod.string();

export const ExperimentalImageGenerationTagReferenceDtoSchema = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('system'), key: dtozod.literal('favorite') }),
  dtozod.object({ type: dtozod.literal('user'), tagId: ExperimentalImageGenerationIdDtoSchema }),
]);
export type ExperimentalImageGenerationTagReferenceDto = dtozod.infer<typeof ExperimentalImageGenerationTagReferenceDtoSchema>;

// Use the same experimental recovery semantics as ordinary settings. A newer
// setting must not make an older workspace unreadable merely because resaving
// may discard fields it does not understand.
export const ExperimentalImageGenerationTranslationOverrideDtoSchema = resolveMissingAsUndefined(dtozod.object({
  endpoint: missingAsUndefined(EndpointDtoSchema),
  modelId: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
}));
export type ExperimentalImageGenerationTranslationOverrideDto = dtozod.infer<typeof ExperimentalImageGenerationTranslationOverrideDtoSchema>;

export const ExperimentalImageGenerationPreferencesDtoSchema = resolveMissingAsUndefined(dtozod.object({
  generationMonitorPresentation: missingAsUndefined(dtozod.enum(['visual', 'compact-progress'])),
  assistantVisibility: missingAsUndefined(dtozod.enum(['open', 'closed'])),
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideDtoSchema),
  experimentalNoticeDismissedAt: missingAsUndefined(ExperimentalImageGenerationTimestampDtoSchema),
  assistantLayout: dtozod.enum(['floating', 'docked']),
}));
export type ExperimentalImageGenerationPreferencesDto = dtozod.infer<typeof ExperimentalImageGenerationPreferencesDtoSchema>;

export const ExperimentalImageGenerationCatalogDtoSchema = dtozod.object({
  preferences: ExperimentalImageGenerationPreferencesDtoSchema,
  version: dtozod.literal(1),
  id: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  tags: dtozod.array(dtozod.object({
    id: ExperimentalImageGenerationIdDtoSchema,
    name: ExperimentalImageGenerationTagNameDtoSchema,
    createdAt: ExperimentalImageGenerationTimestampDtoSchema,
    updatedAt: ExperimentalImageGenerationTimestampDtoSchema,
    state: dtozod.enum(['active', 'archived']),
  })),
});
export type ExperimentalImageGenerationCatalogDto = dtozod.infer<typeof ExperimentalImageGenerationCatalogDtoSchema>;

export const ExperimentalImageGenerationActivityOrderDtoSchema = dtozod.number();

export const ExperimentalImageGenerationActivityJournalDtoSchema = dtozod.object({
  version: dtozod.literal(1),
  sequence: dtozod.number(),
  pending: dtozod.array(dtozod.object({
    sessionId: ExperimentalImageGenerationIdDtoSchema,
    runId: ExperimentalImageGenerationIdDtoSchema,
    order: ExperimentalImageGenerationActivityOrderDtoSchema,
  })),
});
export type ExperimentalImageGenerationActivityJournalDto = dtozod.infer<typeof ExperimentalImageGenerationActivityJournalDtoSchema>;

export const ExperimentalImageGenerationSessionDtoSchema = resolveMissingAsUndefined(dtozod.object({
  activityOrder: missingAsUndefined(ExperimentalImageGenerationActivityOrderDtoSchema),
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideDtoSchema),
  assistantChatId: missingAsUndefined(ExperimentalImageGenerationIdDtoSchema),
  id: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  title: dtozod.string(),
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  updatedAt: ExperimentalImageGenerationTimestampDtoSchema,
  state: dtozod.enum(['active', 'archived', 'deleting', 'deleted']),
}));
export type ExperimentalImageGenerationSessionDto = dtozod.infer<typeof ExperimentalImageGenerationSessionDtoSchema>;

export const ExperimentalImageGenerationRunExecutionDtoSchema = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('queued') }),
  dtozod.object({ type: dtozod.literal('running'), startedAt: ExperimentalImageGenerationTimestampDtoSchema }),
  dtozod.object({ type: dtozod.literal('completed'), finishedAt: ExperimentalImageGenerationTimestampDtoSchema }),
  dtozod.object({ type: dtozod.literal('cancelled'), finishedAt: ExperimentalImageGenerationTimestampDtoSchema }),
  dtozod.object({ type: dtozod.literal('failed'), finishedAt: ExperimentalImageGenerationTimestampDtoSchema, message: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('interrupted'), finishedAt: ExperimentalImageGenerationTimestampDtoSchema }),
]);

// History and workspace requests now share their structural contract. Unknown
// fields are intentionally stripped, rather than rejecting downgrade loads.
const ExperimentalImageGenerationRequestDtoSchema = ExperimentalImageGenerationDtoSchema.shape.request;

const ExperimentalImageGenerationDraftRequestDtoSchema = resolveMissingAsUndefined(ExperimentalImageGenerationRequestDtoSchema.extend({
  parameters: ExperimentalImageGenerationRequestDtoSchema.shape.parameters,
  runtime: missingAsUndefined(ExperimentalImageGenerationRuntimeDtoSchema),
}));
export type ExperimentalImageGenerationDraftRequestDto = dtozod.infer<typeof ExperimentalImageGenerationDraftRequestDtoSchema>;

export const ExperimentalImageGenerationDraftDtoSchema = resolveMissingAsUndefined(dtozod.object({
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  updatedAt: ExperimentalImageGenerationTimestampDtoSchema,
  request: ExperimentalImageGenerationDraftRequestDtoSchema,
  vaeTileSizePreference: dtozod.union([dtozod.literal('auto'), dtozod.number()]).optional(),
  stepsPreference: dtozod.union([dtozod.literal('auto'), dtozod.number()]).optional(),
  guidancePreference: dtozod.union([dtozod.literal('auto'), dtozod.number()]).optional(),
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceDtoSchema),
  layout: dtozod.enum(['checkpoint', 'components']),
  modelSelection: missingAsUndefined(ExperimentalBrowserImageModelSelectionDtoSchema),
  remoteModelEditor: missingAsUndefined(ExperimentalRemoteImageModelEditorDtoSchema),
  loraStates: dtozod.array(dtozod.object({ enabled: dtozod.boolean(), strength: dtozod.number() })),
  seedMode: dtozod.enum(['random', 'fixed']),
  count: dtozod.number(),
  debug: dtozod.enum(['on', 'off']),
  retainModel: dtozod.boolean(),
  keepPreviews: dtozod.boolean(),
  maxPreviews: dtozod.number(),
  maxResults: dtozod.number(),
}));
export type ExperimentalImageGenerationDraftDto = dtozod.infer<typeof ExperimentalImageGenerationDraftDtoSchema>;

const compositionParameters = ExperimentalImageGenerationDtoSchema.shape.request.shape.parameters.shape;

/** Both pasted documents and editable rows use explicit keys. Missing means
 * inherit, not a copy of the current shared value. No model file capabilities
 * are accepted from external text. */
export const ExperimentalImageGenerationInputDtoSchema = dtozod.object({
  prompt: compositionParameters.prompt,
  negativePrompt: compositionParameters.negativePrompt.optional(),
  width: compositionParameters.width.optional(),
  height: compositionParameters.height.optional(),
  steps: dtozod.union([compositionParameters.steps, dtozod.literal('auto')]).optional(),
  guidance: dtozod.union([compositionParameters.guidance, dtozod.literal('auto')]).optional(),
  seed: compositionParameters.seed.nullable().optional(),
  sampler: compositionParameters.sampler.optional(),
  scheduler: compositionParameters.scheduler.optional(),
  distilledGuidance: compositionParameters.distilledGuidance.optional(),
  vaeTiling: compositionParameters.vaeTiling,
  vaeTileSize: dtozod.union([dtozod.number(), dtozod.literal('auto')]).optional(),
  flashAttention: compositionParameters.flashAttention,
  bf16WeightType: compositionParameters.bf16WeightType,
  qwenVaePolicy: compositionParameters.qwenVaePolicy,
  conditioningCacheSize: compositionParameters.conditioningCacheSize,
  modelArguments: compositionParameters.modelArguments,
  count: dtozod.number().optional(),
  uiModelConfigurationSlot: dtozod.string().optional(),
});
export type ExperimentalImageGenerationInputDto = dtozod.infer<typeof ExperimentalImageGenerationInputDtoSchema>;

/** UI-only model assignment. Deliberately excludes prompt, seed, count and input
 * images. Locators are restored by existing draft/model resolution, not fetched
 * because pasted text claimed a file path. */
const compositionDraft = ExperimentalImageGenerationDraftDtoSchema.shape;
export const ExperimentalImageGenerationModelConfigurationDtoSchema = resolveMissingAsUndefined(dtozod.object({
  request: resolveMissingAsUndefined(dtozod.object({
    models: ExperimentalImageGenerationDtoSchema.shape.request.shape.models,
    loras: ExperimentalImageGenerationDtoSchema.shape.request.shape.loras,
    runtime: compositionDraft.request.shape.runtime,
  })),
  inferenceLocation: compositionDraft.inferenceLocation,
  layout: compositionDraft.layout,
  modelSelection: compositionDraft.modelSelection,
  remoteModelEditor: compositionDraft.remoteModelEditor,
  loraStates: compositionDraft.loraStates,
}));
export type ExperimentalImageGenerationModelConfigurationDto = dtozod.infer<typeof ExperimentalImageGenerationModelConfigurationDtoSchema>;

export const ExperimentalImageGenerationCompositionDtoSchema = dtozod.object({
  version: dtozod.literal(1),
  sessionId: dtozod.string(),
  mode: dtozod.enum(['single', 'multiple']),
  revision: dtozod.number(),
  updatedAt: dtozod.number(),
  jobs: dtozod.array(dtozod.object({ id: dtozod.string(), input: ExperimentalImageGenerationInputDtoSchema })),
  slots: dtozod.array(dtozod.object({ name: dtozod.string(), configuration: ExperimentalImageGenerationModelConfigurationDtoSchema })),
});
export type ExperimentalImageGenerationCompositionDto = dtozod.infer<typeof ExperimentalImageGenerationCompositionDtoSchema>;

export type ExperimentalImageGenerationRequestDto = dtozod.infer<typeof ExperimentalImageGenerationRequestDtoSchema>;

const ImageGenerationRunBaseDtoSchema = dtozod.object({
  operationId: ExperimentalImageGenerationIdDtoSchema.optional(),
  acceptedOrder: missingAsUndefined(ExperimentalImageGenerationActivityOrderDtoSchema),
  id: ExperimentalImageGenerationIdDtoSchema,
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  // Reuse the saved-request contract, never the changing Worker transport schema.
  request: ExperimentalImageGenerationRequestDtoSchema,
  seeds: dtozod.array(dtozod.string()),
  sources: dtozod.array(dtozod.object({
    role: dtozod.enum(['settings', 'initial-image', 'reference-image']),
    sessionId: ExperimentalImageGenerationIdDtoSchema,
    assetId: ExperimentalImageGenerationIdDtoSchema,
  })),
  execution: ExperimentalImageGenerationRunExecutionDtoSchema,
});


/** A generation operation is independent of single/bulk input UI. */
export const ExperimentalImageGenerationOperationDtoSchema = dtozod.object({
  version: dtozod.literal(1),
  id: ExperimentalImageGenerationIdDtoSchema,
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  runIds: dtozod.array(ExperimentalImageGenerationIdDtoSchema),
});
export type ExperimentalImageGenerationOperationDto = dtozod.infer<typeof ExperimentalImageGenerationOperationDtoSchema>;
export const ExperimentalImageGenerationOperationIndexDtoSchema = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationOperationDtoSchema) });

export const ExperimentalImageGenerationRunDtoSchema = resolveMissingAsUndefined(ImageGenerationRunBaseDtoSchema);
export type ExperimentalImageGenerationRunDto = dtozod.infer<typeof ExperimentalImageGenerationRunDtoSchema>;

const UnavailableRpcRuntimeCommonDtoSchema = resolveMissingAsUndefined(dtozod.object({
  profile: dtozod.literal('naidan-rpc'),
  label: dtozod.string(),
  modelSelection: missingAsUndefined(ExperimentalRemoteImageModelSelectionDtoSchema),
}));
const UnavailableDirectRecordDtoSchema = ExperimentalImageGenerationDtoSchema.extend({
  request: ExperimentalImageGenerationDtoSchema.shape.request.extend({ runtime: UnavailableRpcRuntimeCommonDtoSchema }),
});
const UnavailableRunRecordDtoSchema = resolveMissingAsUndefined(ImageGenerationRunBaseDtoSchema.extend({
  request: ExperimentalImageGenerationRequestDtoSchema.extend({ runtime: UnavailableRpcRuntimeCommonDtoSchema }),
}));

export function unavailableDirectRpcRecord({ raw }: { raw: unknown }): { id: string } | undefined {
  const result = UnavailableDirectRecordDtoSchema.safeParse(raw);
  if (!result.success || ExperimentalImageGenerationDtoSchema.safeParse(raw).success) {
    return undefined;
  }
  return { id: result.data.id };
}

export function unavailableRunRpcRecord({ raw }: { raw: unknown }): { id: string, sessionId: string } | undefined {
  const result = UnavailableRunRecordDtoSchema.safeParse(raw);
  if (!result.success || ExperimentalImageGenerationRunDtoSchema.safeParse(raw).success) {
    return undefined;
  }
  return { id: result.data.id, sessionId: result.data.sessionId };
}

export const ExperimentalImageGenerationAssetDtoSchema = dtozod.object({
  id: ExperimentalImageGenerationIdDtoSchema,
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  runId: ExperimentalImageGenerationIdDtoSchema,
  index: dtozod.number(),
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  seed: dtozod.string(),
  result: ExperimentalImageGenerationDtoSchema.shape.result,
  previews: dtozod.array(ExperimentalImageGenerationDtoSchema.shape.previews.element),
});
export type ExperimentalImageGenerationAssetDto = dtozod.infer<typeof ExperimentalImageGenerationAssetDtoSchema>;

export const ExperimentalImageGenerationAssetAnnotationsDtoSchema = dtozod.object({
  state: dtozod.enum(['active', 'archived', 'deleting', 'deleted']),
  assetId: ExperimentalImageGenerationIdDtoSchema,
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  tags: dtozod.array(dtozod.object({ tag: ExperimentalImageGenerationTagReferenceDtoSchema, assignedAt: ExperimentalImageGenerationTimestampDtoSchema })),
});
export type ExperimentalImageGenerationAssetAnnotationsDto = dtozod.infer<typeof ExperimentalImageGenerationAssetAnnotationsDtoSchema>;

export const ExperimentalImageGenerationRunSummaryDtoSchema = dtozod.object({
  operationId: ExperimentalImageGenerationIdDtoSchema.optional(),
  id: ExperimentalImageGenerationIdDtoSchema,
  sessionId: ExperimentalImageGenerationIdDtoSchema,
  revision: ExperimentalImageGenerationRevisionDtoSchema,
  createdAt: ExperimentalImageGenerationTimestampDtoSchema,
  prompt: dtozod.string(),
  modelName: dtozod.string(),
  requestedCount: dtozod.number(),
  execution: ExperimentalImageGenerationRunExecutionDtoSchema,
});
export type ExperimentalImageGenerationRunSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationRunSummaryDtoSchema>;

export const ExperimentalImageGenerationAssetSummaryDtoSchema = ExperimentalImageGenerationAssetDtoSchema.omit({ result: true, previews: true }).extend({
  confirmation: dtozod.literal('unconfirmed').optional(),
  binaryObjectId: ExperimentalImageGenerationIdDtoSchema,
  width: dtozod.number(),
  height: dtozod.number(),
  previewCount: dtozod.number(),
});
export type ExperimentalImageGenerationAssetSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationAssetSummaryDtoSchema>;

// Indexes are derived, never the sole copy of names, curation, requests or outputs.
export const ExperimentalImageGenerationSessionIndexDtoSchema = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationSessionDtoSchema) });
export const ExperimentalImageGenerationRunIndexDtoSchema = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationRunSummaryDtoSchema) });
export const ExperimentalImageGenerationAssetIndexDtoSchema = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationAssetSummaryDtoSchema) });
export const ExperimentalImageGenerationAnnotationsIndexDtoSchema = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationAssetAnnotationsDtoSchema) });

/** A durable deny-list prevents stale Workspace publications from recreating deleted bytes. */
export const ExperimentalImageGenerationBinaryDeletionDtoSchema = dtozod.object({
  binaryObjectId: ExperimentalImageGenerationIdDtoSchema,
});
export type ExperimentalImageGenerationBinaryDeletionDto = dtozod.infer<typeof ExperimentalImageGenerationBinaryDeletionDtoSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
