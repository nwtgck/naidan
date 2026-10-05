import { z } from 'zod';
import { EndpointSchemaDto } from './dto';
import {
  ExperimentalBrowserImageModelSelectionSchemaDto,
  ExperimentalImageGenerationPathSchemaDto,
  ExperimentalImageInferenceLocationPreferenceSchemaDto,
  ExperimentalRemoteImageModelEditorSchemaDto,
  ExperimentalRemoteImageModelFileSchemaDto,
} from './experimental.dto';
import { imageGenerationTagNameKey, imageGenerationTagNameSchema, normalizeImageGenerationTagName, planImageGenerationSeeds, IMAGE_GENERATION_MAX_RUN_IMAGES } from '@/01-models/image-generation';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

export const ExperimentalRemoteImageModelSelectionSchemaDto = z.object({
  primary: z.object({ slot: z.enum(['model', 'diffusion']), file: ExperimentalRemoteImageModelFileSchemaDto }),
  components: z.array(z.object({ slot: z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']), file: ExperimentalRemoteImageModelFileSchemaDto })).max(5)
    .refine(value => new Set(value.map(item => item.slot)).size === value.length),
  loras: z.array(z.object({ file: ExperimentalRemoteImageModelFileSchemaDto, strength: z.number().finite().min(-10).max(10) })).max(8),
});
export const ExperimentalImageGenerationRuntimeSchemaDto = z.union([
  resolveMissingAsUndefined(z.object({
    sourceCommit: z.string(),
    profile: z.enum(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']),
    weightResidency: z.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']),
    gpuBudgetMiB: missingAsUndefined(z.number().finite().nonnegative()),
  })),
  resolveMissingAsUndefined(z.object({
    profile: z.literal('naidan-rpc'),
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    peerId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    label: z.string().max(100),
    // An unfinished draft can exist before a model is selected. Actual
    // generation requires an explicit model selection at the RPC boundary.
    modelSelection: missingAsUndefined(ExperimentalRemoteImageModelSelectionSchemaDto),
  })),
]);
export type ExperimentalImageGenerationRuntimeDto = z.infer<typeof ExperimentalImageGenerationRuntimeSchemaDto>;

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
  z.object({ type: z.literal('opfs'), path: ExperimentalImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
  z.object({ type: z.literal('host'), directoryId: z.string().min(1), path: ExperimentalImageGenerationPathSchemaDto, ...ImageGenerationFileMetadataSchemaDto }),
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
      vaeTiling: z.boolean().optional(),
      vaeTileSize: z.number().int().positive().optional(),
      flashAttention: z.boolean().optional(),
      bf16WeightType: z.enum(['f32', 'f16']).optional(),
      qwenVaePolicy: z.enum(['bounded', 'native']).optional(),
      conditioningCacheSize: z.number().int().nonnegative().optional(),
      modelArguments: z.string().optional(),
    }),
    models: z.array(z.object({
      slot: z.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']),
      path: ExperimentalImageGenerationPathSchemaDto,
      file: ImageGenerationModelFileSchemaDto,
      companions: z.array(z.object({ path: ExperimentalImageGenerationPathSchemaDto, file: ImageGenerationModelFileSchemaDto })),
    })),
    loras: z.array(z.object({
      path: ExperimentalImageGenerationPathSchemaDto,
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
    runtime: ExperimentalImageGenerationRuntimeSchemaDto,
  }),
  result: z.union([
    z.object({
      binaryObjectId: ImageHistoryRawIdSchemaDto,
      width: z.number().int().positive(), height: z.number().int().positive(),
      elapsedMs: z.number().finite().nonnegative(),
      confirmation: z.literal('confirmed').optional(), modelVersion: z.string(), uniformOutput: z.boolean(),
    }),
    z.object({
      binaryObjectId: ImageHistoryRawIdSchemaDto,
      width: z.number().int().positive(), height: z.number().int().positive(),
      elapsedMs: z.number().finite().nonnegative(),
      confirmation: z.literal('unconfirmed'), modelVersion: z.string().optional(), uniformOutput: z.boolean().optional(),
    }),
  ]),
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

const ExperimentalImageGenerationIdSchemaDto = z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/);
const ExperimentalImageGenerationRevisionSchemaDto = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const ExperimentalImageGenerationTimestampSchemaDto = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ExperimentalImageGenerationTagNameSchemaDto = z.string().max(1024).refine(name =>
  imageGenerationTagNameSchema.safeParse(name).success && normalizeImageGenerationTagName({ name }) === name,
'Persisted tag names must be valid normalized labels.');

export const ExperimentalImageGenerationTagReferenceSchemaDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), key: z.literal('favorite') }).strict(),
  z.object({ type: z.literal('user'), tagId: ExperimentalImageGenerationIdSchemaDto }).strict(),
]);
export type ExperimentalImageGenerationTagReferenceDto = z.infer<typeof ExperimentalImageGenerationTagReferenceSchemaDto>;

export const ExperimentalImageGenerationTranslationOverrideSchemaDto = resolveMissingAsUndefined(z.object({
  endpoint: missingAsUndefined(EndpointSchemaDto),
  modelId: missingAsUndefined(z.string().min(1).max(4096)),
}).strict());
export type ExperimentalImageGenerationTranslationOverrideDto = z.infer<typeof ExperimentalImageGenerationTranslationOverrideSchemaDto>;

export const ExperimentalImageGenerationPreferencesSchemaDto = resolveMissingAsUndefined(z.object({
  assistantVisibility: missingAsUndefined(z.enum(['open', 'closed'])),
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideSchemaDto),
  experimentalNoticeDismissedAt: missingAsUndefined(ExperimentalImageGenerationTimestampSchemaDto),
  assistantLayout: z.enum(['floating', 'docked']),
}).strict());
export type ExperimentalImageGenerationPreferencesDto = z.infer<typeof ExperimentalImageGenerationPreferencesSchemaDto>;

export const ExperimentalImageGenerationCatalogSchemaDto = z.object({
  preferences: ExperimentalImageGenerationPreferencesSchemaDto,
  version: z.literal(1),
  id: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  tags: z.array(z.object({
    id: ExperimentalImageGenerationIdSchemaDto,
    name: ExperimentalImageGenerationTagNameSchemaDto,
    createdAt: ExperimentalImageGenerationTimestampSchemaDto,
    updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
    state: z.enum(['active', 'archived']),
  }).strict()).max(4096),
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  catalog.tags.forEach((tag, index) => {
    const key = imageGenerationTagNameKey({ name: tag.name });
    if (ids.has(tag.id) || names.has(key)) context.addIssue({ code: 'custom', path: ['tags', index], message: 'Tag IDs and normalized names must be unique, including archived tags.' });
    ids.add(tag.id); names.add(key);
  });
});
export type ExperimentalImageGenerationCatalogDto = z.infer<typeof ExperimentalImageGenerationCatalogSchemaDto>;

export const ExperimentalImageGenerationSessionSchemaDto = resolveMissingAsUndefined(z.object({
  translation: missingAsUndefined(ExperimentalImageGenerationTranslationOverrideSchemaDto),
  assistantChatId: missingAsUndefined(ExperimentalImageGenerationIdSchemaDto),
  id: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  title: z.string().min(1).max(512).refine(title => title.trim().length > 0, 'A session title must not be blank.'),
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
  state: z.enum(['active', 'archived', 'deleting', 'deleted']),
}).strict());
export type ExperimentalImageGenerationSessionDto = z.infer<typeof ExperimentalImageGenerationSessionSchemaDto>;

export const ExperimentalImageGenerationRunExecutionSchemaDto = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued') }).strict(),
  z.object({ type: z.literal('running'), startedAt: ExperimentalImageGenerationTimestampSchemaDto }).strict(),
  z.object({ type: z.literal('completed'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }).strict(),
  z.object({ type: z.literal('cancelled'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }).strict(),
  z.object({ type: z.literal('failed'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto, message: z.string().min(1).max(32768) }).strict(),
  z.object({ type: z.literal('interrupted'), finishedAt: ExperimentalImageGenerationTimestampSchemaDto }).strict(),
]);

// Workspace is versioned independently. Unknown request fields must not be stripped
// when updating execution state; preserve unreadable files for raw export.
const ExperimentalImageGenerationLegacyRequestSchemaDto = ExperimentalImageGenerationSchemaDto.shape.request;
const ExperimentalImageGenerationFileVariantsDto = ExperimentalImageGenerationLegacyRequestSchemaDto.shape.models.element.shape.file.options;
const ExperimentalImageGenerationModelFileSchemaDto = z.discriminatedUnion('type', [
  ExperimentalImageGenerationFileVariantsDto[0].strict(),
  ExperimentalImageGenerationFileVariantsDto[1].strict(),
  ExperimentalImageGenerationFileVariantsDto[2].strict(),
]);
const ExperimentalImageGenerationInputImageSchemaDto = z.object({ binaryObjectId: ExperimentalImageGenerationIdSchemaDto, name: z.string().min(1) }).strict();
const ExperimentalImageGenerationRequestSchemaDto = ExperimentalImageGenerationLegacyRequestSchemaDto.extend({
  parameters: ExperimentalImageGenerationLegacyRequestSchemaDto.shape.parameters.strict(),
  preview: ExperimentalImageGenerationLegacyRequestSchemaDto.shape.preview.strict(),
  models: z.array(ExperimentalImageGenerationLegacyRequestSchemaDto.shape.models.element.extend({
    file: ExperimentalImageGenerationModelFileSchemaDto,
    companions: z.array(ExperimentalImageGenerationLegacyRequestSchemaDto.shape.models.element.shape.companions.element.extend({ file: ExperimentalImageGenerationModelFileSchemaDto }).strict()),
  }).strict()),
  loras: z.array(ExperimentalImageGenerationLegacyRequestSchemaDto.shape.loras.element.extend({ file: ExperimentalImageGenerationModelFileSchemaDto }).strict()),
  imageInputs: resolveMissingAsUndefined(z.object({
    initImage: missingAsUndefined(ExperimentalImageGenerationInputImageSchemaDto),
    strength: z.number().finite(),
    referenceImages: z.array(ExperimentalImageGenerationInputImageSchemaDto),
  }).strict()),
  runtime: ExperimentalImageGenerationRuntimeSchemaDto,
}).strict();

const ExperimentalImageGenerationDraftParametersSchemaDto = ExperimentalImageGenerationLegacyRequestSchemaDto.shape.parameters.extend({
  prompt: z.string().max(4096), negativePrompt: z.string().max(4096), seed: z.string().max(20),
  width: z.number().finite(), height: z.number().finite(), steps: z.number().finite(), guidance: z.number().finite(),
  vaeTileSize: z.number().finite().optional(), conditioningCacheSize: z.number().finite().optional(),
}).strict();

// The legacy preferences schema tolerates future fields. Workspace checkpoints
// must fail closed instead: a read-modify-write must never erase unknown data.
const ExperimentalImageGenerationSelectionLocationSchemaDto = z.discriminatedUnion('kind', [
  ExperimentalBrowserImageModelSelectionSchemaDto.shape.primary.shape.location.options[0].strict(),
  ExperimentalBrowserImageModelSelectionSchemaDto.shape.primary.shape.location.options[1].strict(),
]);
const ExperimentalImageGenerationSelectionComponentSchemaDto = ExperimentalBrowserImageModelSelectionSchemaDto.shape.components.element.extend({
  choice: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict(),
    z.object({ kind: z.literal('none') }).strict(),
  ]),
}).strict();
const ExperimentalImageGenerationModelSelectionSchemaDto = ExperimentalBrowserImageModelSelectionSchemaDto.extend({
  primary: ExperimentalBrowserImageModelSelectionSchemaDto.shape.primary.extend({ location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict(),
  components: z.array(ExperimentalImageGenerationSelectionComponentSchemaDto).max(5).refine(components => new Set(components.map(component => component.slot)).size === components.length),
  loras: z.array(ExperimentalBrowserImageModelSelectionSchemaDto.shape.loras.element.extend({ location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict()).max(16),
}).strict();

const ExperimentalImageGenerationDraftRequestSchemaDto = resolveMissingAsUndefined(ExperimentalImageGenerationRequestSchemaDto.extend({
  parameters: ExperimentalImageGenerationDraftParametersSchemaDto,
  runtime: missingAsUndefined(ExperimentalImageGenerationRuntimeSchemaDto),
}).strict());
export type ExperimentalImageGenerationDraftRequestDto = z.infer<typeof ExperimentalImageGenerationDraftRequestSchemaDto>;

export const ExperimentalImageGenerationDraftSchemaDto = resolveMissingAsUndefined(z.object({
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
  request: ExperimentalImageGenerationDraftRequestSchemaDto,
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceSchemaDto),
  layout: z.enum(['checkpoint', 'components']),
  modelSelection: missingAsUndefined(ExperimentalImageGenerationModelSelectionSchemaDto),
  remoteModelEditor: missingAsUndefined(ExperimentalRemoteImageModelEditorSchemaDto),
  loraStates: z.array(z.object({ enabled: z.boolean(), strength: z.number().finite() }).strict()),
  seedMode: z.enum(['random', 'fixed']),
  count: z.number().int().min(1).max(IMAGE_GENERATION_MAX_RUN_IMAGES),
  debug: z.enum(['on', 'off']),
  retainModel: z.boolean(),
  keepPreviews: z.boolean(),
  maxPreviews: z.number().int().min(1).max(100),
  maxResults: z.number().int().min(1).max(100),
}).strict()).refine(draft => draft.loraStates.length === draft.request.loras.length, 'Draft adapter state must match the saved adapter list.')
  .refine(draft => draft.request.runtime !== undefined || draft.inferenceLocation !== undefined, 'An unfinished draft must identify its inference location.');
export type ExperimentalImageGenerationDraftDto = z.infer<typeof ExperimentalImageGenerationDraftSchemaDto>;

export type ExperimentalImageGenerationRequestDto = z.infer<typeof ExperimentalImageGenerationRequestSchemaDto>;

export const ExperimentalImageGenerationRunSchemaDto = z.object({
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  // Reuse the saved-request contract, never the changing Worker transport schema.
  request: ExperimentalImageGenerationRequestSchemaDto,
  seeds: z.array(z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)).min(1).max(IMAGE_GENERATION_MAX_RUN_IMAGES),
  sources: z.array(z.object({
    role: z.enum(['settings', 'initial-image', 'reference-image']),
    sessionId: ExperimentalImageGenerationIdSchemaDto,
    assetId: ExperimentalImageGenerationIdSchemaDto,
  }).strict()).max(256),
  execution: ExperimentalImageGenerationRunExecutionSchemaDto,
}).strict().superRefine((run, context) => {
  try {
    const seeds = planImageGenerationSeeds({ baseSeed: run.request.parameters.seed, count: run.seeds.length });
    if (seeds.some((seed, index) => seed !== run.seeds[index])) throw new Error('Seed plan differs from the accepted base seed.');
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['seeds'], message: error instanceof Error ? error.message : String(error) });
  }
  const sources = new Set<string>();
  run.sources.forEach((source, index) => {
    const key = JSON.stringify(source);
    if (sources.has(key)) context.addIssue({ code: 'custom', path: ['sources', index], message: 'Duplicate lineage source.' });
    sources.add(key);
  });
});
export type ExperimentalImageGenerationRunDto = z.infer<typeof ExperimentalImageGenerationRunSchemaDto>;

export const ExperimentalImageGenerationAssetSchemaDto = z.object({
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  runId: ExperimentalImageGenerationIdSchemaDto,
  index: z.number().int().min(0).max(IMAGE_GENERATION_MAX_RUN_IMAGES - 1),
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  seed: z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= 9223372036854775807n),
  result: ExperimentalImageGenerationSchemaDto.shape.result,
  previews: z.array(ExperimentalImageGenerationSchemaDto.shape.previews.element.strict()).max(100),
}).strict();
export type ExperimentalImageGenerationAssetDto = z.infer<typeof ExperimentalImageGenerationAssetSchemaDto>;

export const ExperimentalImageGenerationAssetAnnotationsSchemaDto = z.object({
  state: z.enum(['active', 'archived', 'deleting', 'deleted']),
  assetId: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  tags: z.array(z.object({ tag: ExperimentalImageGenerationTagReferenceSchemaDto, assignedAt: ExperimentalImageGenerationTimestampSchemaDto }).strict()).max(256),
}).strict().superRefine((annotations, context) => {
  const keys = new Set<string>();
  annotations.tags.forEach(({ tag }, index) => {
    const key = JSON.stringify(tag);
    if (keys.has(key)) context.addIssue({ code: 'custom', path: ['tags', index], message: 'Duplicate asset tag.' });
    keys.add(key);
  });
});
export type ExperimentalImageGenerationAssetAnnotationsDto = z.infer<typeof ExperimentalImageGenerationAssetAnnotationsSchemaDto>;

export const ExperimentalImageGenerationRunSummarySchemaDto = z.object({
  id: ExperimentalImageGenerationIdSchemaDto,
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  createdAt: ExperimentalImageGenerationTimestampSchemaDto,
  prompt: z.string(),
  modelName: z.string(),
  requestedCount: z.number().int().min(1).max(IMAGE_GENERATION_MAX_RUN_IMAGES),
  execution: ExperimentalImageGenerationRunExecutionSchemaDto,
}).strict();
export type ExperimentalImageGenerationRunSummaryDto = z.infer<typeof ExperimentalImageGenerationRunSummarySchemaDto>;

export const ExperimentalImageGenerationAssetSummarySchemaDto = ExperimentalImageGenerationAssetSchemaDto.omit({ result: true, previews: true }).extend({
  confirmation: z.literal('unconfirmed').optional(),
  binaryObjectId: ExperimentalImageGenerationIdSchemaDto,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  previewCount: z.number().int().min(0).max(100),
}).strict();
export type ExperimentalImageGenerationAssetSummaryDto = z.infer<typeof ExperimentalImageGenerationAssetSummarySchemaDto>;

// Indexes are derived, never the sole copy of names, curation, requests or outputs.
export const ExperimentalImageGenerationSessionIndexSchemaDto = z.object({ items: z.array(ExperimentalImageGenerationSessionSchemaDto) }).strict();
export const ExperimentalImageGenerationRunIndexSchemaDto = z.object({ items: z.array(ExperimentalImageGenerationRunSummarySchemaDto) }).strict();
export const ExperimentalImageGenerationAssetIndexSchemaDto = z.object({ items: z.array(ExperimentalImageGenerationAssetSummarySchemaDto) }).strict();
export const ExperimentalImageGenerationAnnotationsIndexSchemaDto = z.object({ items: z.array(ExperimentalImageGenerationAssetAnnotationsSchemaDto) }).strict();

/** A durable deny-list prevents stale Workspace publications from recreating deleted bytes. */
export const ExperimentalImageGenerationBinaryDeletionSchemaDto = z.object({
  binaryObjectId: ExperimentalImageGenerationIdSchemaDto,
}).strict();
export type ExperimentalImageGenerationBinaryDeletionDto = z.infer<typeof ExperimentalImageGenerationBinaryDeletionSchemaDto>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
