import * as dtozod from '@/utils/dtozod';
import { resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { ExperimentalImageGenerationSchemaDto, ExperimentalImageGenerationDraftSchemaDto } from './experimental-image-generation.dto';

const parameters = ExperimentalImageGenerationSchemaDto.shape.request.shape.parameters.shape;

/** Both pasted documents and editable rows use explicit keys. Missing means
 * inherit, not a copy of the current shared value. No model file capabilities
 * are accepted from external text. */
export const ExperimentalImageGenerationInputSchemaDto = dtozod.object({
  prompt: parameters.prompt,
  negativePrompt: parameters.negativePrompt.optional(),
  width: parameters.width.optional(),
  height: parameters.height.optional(),
  steps: dtozod.union([parameters.steps, dtozod.literal('auto')]).optional(),
  guidance: dtozod.union([parameters.guidance, dtozod.literal('auto')]).optional(),
  seed: parameters.seed.nullable().optional(),
  sampler: parameters.sampler.optional(),
  scheduler: parameters.scheduler.optional(),
  distilledGuidance: parameters.distilledGuidance.optional(),
  vaeTiling: parameters.vaeTiling,
  vaeTileSize: dtozod.union([dtozod.number(), dtozod.literal('auto')]).optional(),
  flashAttention: parameters.flashAttention,
  bf16WeightType: parameters.bf16WeightType,
  qwenVaePolicy: parameters.qwenVaePolicy,
  conditioningCacheSize: parameters.conditioningCacheSize,
  modelArguments: parameters.modelArguments,
  count: dtozod.number().optional(),
  uiModelConfigurationSlot: dtozod.string().optional(),
});
export type ExperimentalImageGenerationInputDto = dtozod.infer<typeof ExperimentalImageGenerationInputSchemaDto>;

/** UI-only model assignment. Deliberately excludes prompt, seed, count and input
 * images. Locators are restored by existing draft/model resolution, not fetched
 * because pasted text claimed a file path. */
const draft = ExperimentalImageGenerationDraftSchemaDto.shape;
export const ExperimentalImageGenerationModelConfigurationSchemaDto = resolveMissingAsUndefined(dtozod.object({
  request: resolveMissingAsUndefined(dtozod.object({
    models: ExperimentalImageGenerationSchemaDto.shape.request.shape.models,
    loras: ExperimentalImageGenerationSchemaDto.shape.request.shape.loras,
    runtime: draft.request.shape.runtime,
  })),
  inferenceLocation: draft.inferenceLocation,
  layout: draft.layout,
  modelSelection: draft.modelSelection,
  remoteModelEditor: draft.remoteModelEditor,
  loraStates: draft.loraStates,
}));
export type ExperimentalImageGenerationModelConfigurationDto = dtozod.infer<typeof ExperimentalImageGenerationModelConfigurationSchemaDto>;

export const ExperimentalImageGenerationCompositionSchemaDto = dtozod.object({
  version: dtozod.literal(1),
  sessionId: dtozod.string(),
  mode: dtozod.enum(['single', 'multiple']),
  revision: dtozod.number(),
  updatedAt: dtozod.number(),
  jobs: dtozod.array(dtozod.object({ id: dtozod.string(), input: ExperimentalImageGenerationInputSchemaDto })),
  slots: dtozod.array(dtozod.object({ name: dtozod.string(), configuration: ExperimentalImageGenerationModelConfigurationSchemaDto })),
});
export type ExperimentalImageGenerationCompositionDto = dtozod.infer<typeof ExperimentalImageGenerationCompositionSchemaDto>;

export const TEST_ONLY = {
};
