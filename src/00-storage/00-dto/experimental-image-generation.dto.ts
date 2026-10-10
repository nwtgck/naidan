import * as dtozod from '@/utils/dtozod';
import { EndpointSchemaDto, LmParametersSchemaDto } from './dto';
import {
  ExperimentalBrowserImageModelSelectionSchemaDto,
  ExperimentalImageGenerationPathSchemaDto,
  ExperimentalImageInferenceLocationPreferenceSchemaDto,
  ExperimentalRemoteImageModelEditorSchemaDto,
  ExperimentalRemoteImageModelFileSchemaDto,
} from './experimental.dto';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';

export const ExperimentalRemoteImageModelSelectionSchemaDto = dtozod.object({
  primary: dtozod.object({ slot: dtozod.enum(['model', 'diffusion']), file: ExperimentalRemoteImageModelFileSchemaDto }),
  components: dtozod.array(dtozod.object({ slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']), file: ExperimentalRemoteImageModelFileSchemaDto })),
  loras: dtozod.array(dtozod.object({ file: ExperimentalRemoteImageModelFileSchemaDto, strength: dtozod.number() })),
});
export const ExperimentalImageGenerationRuntimeSchemaDto = dtozod.union([
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
    modelSelection: missingAsUndefined(ExperimentalRemoteImageModelSelectionSchemaDto),
  })),
]);
export type ExperimentalImageGenerationRuntimeDto = dtozod.infer<typeof ExperimentalImageGenerationRuntimeSchemaDto>;

// Image history is deliberately independent of chat persistence and runtime
// transport defaults. Stored requests describe what was requested, not a
// guarantee that a future runtime can reproduce the same image.
const ImageHistoryRawIdSchemaDto = dtozod.string();
const ImageGenerationFileMetadataSchemaDto = {
  name: dtozod.string(),
  size: dtozod.number(),
  lastModified: dtozod.number(),
};
const ImageGenerationModelFileSchemaDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('opfs'), path: ExperimentalImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
  dtozod.object({ type: dtozod.literal('host'), directoryId: dtozod.string(), path: ExperimentalImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
  dtozod.object({ type: dtozod.literal('file'), ...ImageGenerationFileMetadataSchemaDto }),
]);
const ImageGenerationImageSchemaDto = dtozod.object({
  binaryObjectId: ImageHistoryRawIdSchemaDto,
  name: dtozod.string(),
});

export const ExperimentalImageGenerationSchemaDto = dtozod.object({
  id: ImageHistoryRawIdSchemaDto,
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
      bf16WeightType: dtozod.enum(['f32', 'f16']).optional(),
      qwenVaePolicy: dtozod.enum(['bounded', 'native']).optional(),
      conditioningCacheSize: dtozod.number().optional(),
      modelArguments: dtozod.string().optional(),
    }),
    models: dtozod.array(dtozod.object({
      slot: dtozod.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']),
      path: ExperimentalImageGenerationPathSchemaDto,
      file: ImageGenerationModelFileSchemaDto,
      companions: dtozod.array(dtozod.object({ path: ExperimentalImageGenerationPathSchemaDto, file: ImageGenerationModelFileSchemaDto })),
    })),
    loras: dtozod.array(dtozod.object({
      path: ExperimentalImageGenerationPathSchemaDto,
      file: ImageGenerationModelFileSchemaDto,
      strength: dtozod.number(),
    })),
    imageInputs: resolveMissingAsUndefined(dtozod.object({
      initImage: missingAsUndefined(ImageGenerationImageSchemaDto),
      strength: dtozod.number(),
      referenceImages: dtozod.array(ImageGenerationImageSchemaDto),
    })),
    preview: dtozod.object({
      enabled: dtozod.boolean(),
      interval: dtozod.number(),
      startStep: dtozod.number(),
      mode: dtozod.enum(['projection', 'vae']),
      maxEdge: dtozod.number(),
    }),
    runtime: ExperimentalImageGenerationRuntimeSchemaDto,
  }),
  result: dtozod.union([
    dtozod.object({
      binaryObjectId: ImageHistoryRawIdSchemaDto,
      width: dtozod.number(),
      height: dtozod.number(),
      elapsedMs: dtozod.number(),
      confirmation: dtozod.literal('confirmed').optional(),
      modelVersion: dtozod.string(),
      uniformOutput: dtozod.boolean(),
    }),
    dtozod.object({
      binaryObjectId: ImageHistoryRawIdSchemaDto,
      width: dtozod.number(),
      height: dtozod.number(),
      elapsedMs: dtozod.number(),
      confirmation: dtozod.literal('unconfirmed'),
      modelVersion: dtozod.string().optional(),
      uniformOutput: dtozod.boolean().optional(),
    }),
  ]),
  previews: dtozod.array(dtozod.object({
    binaryObjectId: ImageHistoryRawIdSchemaDto,
    step: dtozod.number(),
    steps: dtozod.number(),
    mode: dtozod.enum(['projection', 'vae']),
    width: dtozod.number(),
    height: dtozod.number(),
  })),
});
export type ExperimentalImageGenerationDto = dtozod.infer<typeof ExperimentalImageGenerationSchemaDto>;

export const ExperimentalImageGenerationSummarySchemaDto = dtozod.object({
  id: ImageHistoryRawIdSchemaDto,
  createdAt: dtozod.number(),
  prompt: dtozod.string(),
  modelName: dtozod.string(),
  binaryObjectId: ImageHistoryRawIdSchemaDto,
  width: dtozod.number(),
  height: dtozod.number(),
  previewCount: dtozod.number(),
});
export type ExperimentalImageGenerationSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationSummarySchemaDto>;

export const ExperimentalImageGenerationIndexSchemaDto = dtozod.object({
  generations: dtozod.record(ImageHistoryRawIdSchemaDto, ExperimentalImageGenerationSummarySchemaDto),
});
export type ExperimentalImageGenerationIndexDto = dtozod.infer<typeof ExperimentalImageGenerationIndexSchemaDto>;

const ExperimentalImageGenerationIdSchemaDto = dtozod.string();
const ExperimentalImageGenerationRevisionSchemaDto = dtozod.number();
const ExperimentalImageGenerationTimestampSchemaDto = dtozod.number();
const ExperimentalImageGenerationTagNameSchemaDto = dtozod.string();

export const ExperimentalImageGenerationTagReferenceSchemaDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('system'), key: dtozod.literal('favorite') }),
  dtozod.object({ type: dtozod.literal('user'), tagId: ExperimentalImageGenerationIdSchemaDto }),
]);
export type ExperimentalImageGenerationTagReferenceDto = dtozod.infer<typeof ExperimentalImageGenerationTagReferenceSchemaDto>;

// Use the same experimental recovery semantics as ordinary settings. A newer
// setting must not make an older workspace unreadable merely because resaving
// may discard fields it does not understand.
export const ExperimentalImageGenerationTranslationOverrideSchemaDto = resolveMissingAsUndefined(dtozod.object({
  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(dtozod.string()),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
}));
export type ExperimentalImageGenerationTranslationOverrideDto = dtozod.infer<typeof ExperimentalImageGenerationTranslationOverrideSchemaDto>;

export const ExperimentalImageGenerationPreferencesSchemaDto = resolveMissingAsUndefined(dtozod.object({
  generationMonitorPresentation: missingAsUndefined(dtozod.enum(['visual', 'compact-progress'])),
  assistantVisibility: missingAsUndefined(dtozod.enum(['open', 'closed'])),
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideSchemaDto),
  experimentalNoticeDismissedAt: missingAsUndefined(ExperimentalImageGenerationTimestampSchemaDto),
  assistantLayout: dtozod.enum(['floating', 'docked']),
}));
export type ExperimentalImageGenerationPreferencesDto = dtozod.infer<typeof ExperimentalImageGenerationPreferencesSchemaDto>;

export const ExperimentalImageGenerationCatalogSchemaDto = dtozod.object({
  preferences: ExperimentalImageGenerationPreferencesSchemaDto,
  version: dtozod.literal(1),
  id: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  tags: dtozod.array(dtozod.object({
    id: ExperimentalImageGenerationIdSchemaDto,
    name: ExperimentalImageGenerationTagNameSchemaDto,
    createdAt: ExperimentalImageGenerationTimestampSchemaDto,
    updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
    state: dtozod.enum(['active', 'archived']),
  })),
});
export type ExperimentalImageGenerationCatalogDto = dtozod.infer<typeof ExperimentalImageGenerationCatalogSchemaDto>;

export const ExperimentalImageGenerationActivityOrderSchemaDto = dtozod.number();

export const ExperimentalImageGenerationActivityJournalSchemaDto = dtozod.object({
  version: dtozod.literal(1),
  sequence: dtozod.number(),
  pending: dtozod.array(dtozod.object({
    sessionId: ExperimentalImageGenerationIdSchemaDto,
    runId: ExperimentalImageGenerationIdSchemaDto,
    order: ExperimentalImageGenerationActivityOrderSchemaDto,
  })),
});
export type ExperimentalImageGenerationActivityJournalDto = dtozod.infer<typeof ExperimentalImageGenerationActivityJournalSchemaDto>;

export const ExperimentalImageGenerationSessionSchemaDto = resolveMissingAsUndefined(dtozod.object({
  activityOrder: missingAsUndefined(ExperimentalImageGenerationActivityOrderSchemaDto),
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideSchemaDto),
  assistantChatId: missingAsUndefined(ExperimentalImageGenerationIdSchemaDto),
  id: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  title: dtozod.string(),
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
  state: dtozod.enum(['active', 'archived', 'deleting', 'deleted']),
}));
export type ExperimentalImageGenerationSessionDto = dtozod.infer<typeof ExperimentalImageGenerationSessionSchemaDto>;

export const ExperimentalImageGenerationRunExecutionSchemaDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('queued') }),
  dtozod.object({ type: dtozod.literal('running'), startedAt: ExperimentalImageGenerationTimestampSchemaDto }),
  dtozod.object({ type: dtozod.literal('completed'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }),
  dtozod.object({ type: dtozod.literal('cancelled'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }),
  dtozod.object({ type: dtozod.literal('failed'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto, message: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('interrupted'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }),
]);

// History and workspace requests now share their structural contract. Unknown
// fields are intentionally stripped, rather than rejecting downgrade loads.
const ExperimentalImageGenerationRequestSchemaDto = ExperimentalImageGenerationSchemaDto.shape.request;

const ExperimentalImageGenerationDraftRequestSchemaDto = resolveMissingAsUndefined(ExperimentalImageGenerationRequestSchemaDto.extend({
  parameters: ExperimentalImageGenerationRequestSchemaDto.shape.parameters,
  runtime: missingAsUndefined(ExperimentalImageGenerationRuntimeSchemaDto),
}));
export type ExperimentalImageGenerationDraftRequestDto = dtozod.infer<typeof ExperimentalImageGenerationDraftRequestSchemaDto>;

export const ExperimentalImageGenerationDraftSchemaDto = resolveMissingAsUndefined(dtozod.object({
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
  request: ExperimentalImageGenerationDraftRequestSchemaDto,
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceSchemaDto),
  layout: dtozod.enum(['checkpoint', 'components']),
  modelSelection: missingAsUndefined(ExperimentalBrowserImageModelSelectionSchemaDto),
  remoteModelEditor: missingAsUndefined(ExperimentalRemoteImageModelEditorSchemaDto),
  loraStates: dtozod.array(dtozod.object({ enabled: dtozod.boolean(), strength: dtozod.number() })),
  seedMode: dtozod.enum(['random', 'fixed']),
  count: dtozod.number(),
  debug: dtozod.enum(['on', 'off']),
  retainModel: dtozod.boolean(),
  keepPreviews: dtozod.boolean(),
  maxPreviews: dtozod.number(),
  maxResults: dtozod.number(),
}));
export type ExperimentalImageGenerationDraftDto = dtozod.infer<typeof ExperimentalImageGenerationDraftSchemaDto>;

export type ExperimentalImageGenerationRequestDto = dtozod.infer<typeof ExperimentalImageGenerationRequestSchemaDto>;

const ImageGenerationRunBaseSchemaDto = dtozod.object({
  acceptedOrder: missingAsUndefined(ExperimentalImageGenerationActivityOrderSchemaDto),
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  // Reuse the saved-request contract, never the changing Worker transport schema.
  request: ExperimentalImageGenerationRequestSchemaDto,
  seeds: dtozod.array(dtozod.string()),
  sources: dtozod.array(dtozod.object({
    role: dtozod.enum(['settings', 'initial-image', 'reference-image']),
    sessionId: ExperimentalImageGenerationIdSchemaDto,
    assetId: ExperimentalImageGenerationIdSchemaDto,
  })),
  execution: ExperimentalImageGenerationRunExecutionSchemaDto,
});


export const ExperimentalImageGenerationRunSchemaDto = resolveMissingAsUndefined(ImageGenerationRunBaseSchemaDto);
export type ExperimentalImageGenerationRunDto = dtozod.infer<typeof ExperimentalImageGenerationRunSchemaDto>;

const UnavailableRpcRuntimeCommonSchemaDto = resolveMissingAsUndefined(dtozod.object({
  profile: dtozod.literal('naidan-rpc'),
  label: dtozod.string(),
  modelSelection: missingAsUndefined(ExperimentalRemoteImageModelSelectionSchemaDto),
}));
const UnavailableDirectRecordSchemaDto = ExperimentalImageGenerationSchemaDto.extend({
  request: ExperimentalImageGenerationSchemaDto.shape.request.extend({ runtime: UnavailableRpcRuntimeCommonSchemaDto }),
});
const UnavailableRunRecordSchemaDto = resolveMissingAsUndefined(ImageGenerationRunBaseSchemaDto.extend({
  request: ExperimentalImageGenerationRequestSchemaDto.extend({ runtime: UnavailableRpcRuntimeCommonSchemaDto }),
}));

export function unavailableDirectRpcRecord({ raw }: { raw: unknown }): { id: string } | undefined {
  const result = UnavailableDirectRecordSchemaDto.safeParse(raw);
  if (!result.success || ExperimentalImageGenerationSchemaDto.safeParse(raw).success) return undefined;
  return { id: result.data.id };
}

export function unavailableRunRpcRecord({ raw }: { raw: unknown }): { id: string, sessionId: string } | undefined {
  const result = UnavailableRunRecordSchemaDto.safeParse(raw);
  if (!result.success || ExperimentalImageGenerationRunSchemaDto.safeParse(raw).success) return undefined;
  return { id: result.data.id, sessionId: result.data.sessionId };
}

export const ExperimentalImageGenerationAssetSchemaDto = dtozod.object({
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  runId: ExperimentalImageGenerationIdSchemaDto,
  index: dtozod.number(),
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  seed: dtozod.string(),
  result: ExperimentalImageGenerationSchemaDto.shape.result,
  previews: dtozod.array(ExperimentalImageGenerationSchemaDto.shape.previews.element),
});
export type ExperimentalImageGenerationAssetDto = dtozod.infer<typeof ExperimentalImageGenerationAssetSchemaDto>;

export const ExperimentalImageGenerationAssetAnnotationsSchemaDto = dtozod.object({
  state: dtozod.enum(['active', 'archived', 'deleting', 'deleted']),
  assetId: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  tags: dtozod.array(dtozod.object({ tag: ExperimentalImageGenerationTagReferenceSchemaDto, assignedAt: ExperimentalImageGenerationTimestampSchemaDto })),
});
export type ExperimentalImageGenerationAssetAnnotationsDto = dtozod.infer<typeof ExperimentalImageGenerationAssetAnnotationsSchemaDto>;

export const ExperimentalImageGenerationRunSummarySchemaDto = dtozod.object({
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  prompt: dtozod.string(),
  modelName: dtozod.string(),
  requestedCount: dtozod.number(),
  execution: ExperimentalImageGenerationRunExecutionSchemaDto,
});
export type ExperimentalImageGenerationRunSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationRunSummarySchemaDto>;

export const ExperimentalImageGenerationAssetSummarySchemaDto = ExperimentalImageGenerationAssetSchemaDto.omit({ result: true, previews: true }).extend({
  confirmation: dtozod.literal('unconfirmed').optional(),
  binaryObjectId: ExperimentalImageGenerationIdSchemaDto,
  width: dtozod.number(),
  height: dtozod.number(),
  previewCount: dtozod.number(),
});
export type ExperimentalImageGenerationAssetSummaryDto = dtozod.infer<typeof ExperimentalImageGenerationAssetSummarySchemaDto>;

// Indexes are derived, never the sole copy of names, curation, requests or outputs.
export const ExperimentalImageGenerationSessionIndexSchemaDto = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationSessionSchemaDto) });
export const ExperimentalImageGenerationRunIndexSchemaDto = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationRunSummarySchemaDto) });
export const ExperimentalImageGenerationAssetIndexSchemaDto = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationAssetSummarySchemaDto) });
export const ExperimentalImageGenerationAnnotationsIndexSchemaDto = dtozod.object({ items: dtozod.array(ExperimentalImageGenerationAssetAnnotationsSchemaDto) });

/** A durable deny-list prevents stale Workspace publications from recreating deleted bytes. */
export const ExperimentalImageGenerationBinaryDeletionSchemaDto = dtozod.object({
  binaryObjectId: ExperimentalImageGenerationIdSchemaDto,
});
export type ExperimentalImageGenerationBinaryDeletionDto = dtozod.infer<typeof ExperimentalImageGenerationBinaryDeletionSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
