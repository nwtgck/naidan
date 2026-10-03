import { z } from 'zod';
import { EndpointSchemaDto } from './dto';
import { imageGenerationTagNameKey, imageGenerationTagNameSchema, normalizeImageGenerationTagName, planImageGenerationSeeds, IMAGE_GENERATION_MAX_RUN_IMAGES } from '@/01-models/image-generation';
import { ExperimentalImageGenerationSchemaDto, BrowserImageModelSelectionSchemaDto } from './experimental.dto';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

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
  runtime: resolveMissingAsUndefined(z.object({
    sourceCommit: z.string(),
    profile: z.enum(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']),
    weightResidency: z.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']),
    gpuBudgetMiB: missingAsUndefined(z.number().finite().nonnegative()),
  }).strict()),
}).strict();

const ExperimentalImageGenerationDraftParametersSchemaDto = ExperimentalImageGenerationLegacyRequestSchemaDto.shape.parameters.extend({
  prompt: z.string().max(4096), negativePrompt: z.string().max(4096), seed: z.string().max(20),
  width: z.number().finite(), height: z.number().finite(), steps: z.number().finite(), guidance: z.number().finite(),
  vaeTileSize: z.number().finite(), conditioningCacheSize: z.number().finite(),
}).strict();

// The legacy preferences schema tolerates future fields. Workspace checkpoints
// must fail closed instead: a read-modify-write must never erase unknown data.
const ExperimentalImageGenerationSelectionLocationSchemaDto = z.discriminatedUnion('kind', [
  BrowserImageModelSelectionSchemaDto.shape.primary.shape.location.options[0].strict(),
  BrowserImageModelSelectionSchemaDto.shape.primary.shape.location.options[1].strict(),
]);
const ExperimentalImageGenerationSelectionComponentSchemaDto = BrowserImageModelSelectionSchemaDto.shape.components.element.extend({
  choice: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict(),
    z.object({ kind: z.literal('none') }).strict(),
  ]),
}).strict();
const ExperimentalImageGenerationModelSelectionSchemaDto = BrowserImageModelSelectionSchemaDto.extend({
  primary: BrowserImageModelSelectionSchemaDto.shape.primary.extend({ location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict(),
  components: z.array(ExperimentalImageGenerationSelectionComponentSchemaDto).max(5).refine(components => new Set(components.map(component => component.slot)).size === components.length),
  loras: z.array(BrowserImageModelSelectionSchemaDto.shape.loras.element.extend({ location: ExperimentalImageGenerationSelectionLocationSchemaDto }).strict()).max(16),
}).strict();

export const ExperimentalImageGenerationDraftSchemaDto = resolveMissingAsUndefined(z.object({
  sessionId: ExperimentalImageGenerationIdSchemaDto,
  revision: ExperimentalImageGenerationRevisionSchemaDto,
  updatedAt: ExperimentalImageGenerationTimestampSchemaDto,
  request: ExperimentalImageGenerationRequestSchemaDto.extend({ parameters: ExperimentalImageGenerationDraftParametersSchemaDto }).strict(),
  layout: z.enum(['checkpoint', 'components']),
  modelSelection: missingAsUndefined(ExperimentalImageGenerationModelSelectionSchemaDto),
  loraStates: z.array(z.object({ enabled: z.boolean(), strength: z.number().finite() }).strict()),
  seedMode: z.enum(['random', 'fixed']),
  count: z.number().int().min(1).max(IMAGE_GENERATION_MAX_RUN_IMAGES),
  debug: z.enum(['on', 'off']),
  retainModel: z.boolean(),
  keepPreviews: z.boolean(),
  maxPreviews: z.number().int().min(1).max(100),
  maxResults: z.number().int().min(1).max(100),
}).strict()).refine(draft => draft.loraStates.length === draft.request.loras.length, 'Draft adapter state must match the saved adapter list.');
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
  result: ExperimentalImageGenerationSchemaDto.shape.result.strict(),
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
