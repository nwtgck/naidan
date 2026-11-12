import type { ImageGenerationDraft } from '@/features/image-generation/generation-draft';
import type { ImageGenerationInput } from './input';
import { validateImageGenerationInput } from './input';

export type ImageModelConfiguration = import('@/01-models/image-generation').ImageModelConfiguration & {
  modelFiles: ImageGenerationDraft['modelFiles'],
};
export type ImageCompositionJob = { id: string, input: ImageGenerationInput };
export type ImageCompositionSlot = { name: string, configuration: ImageModelConfiguration };

/** Capture only model configuration. A slot must never copy a prompt, an input
 * image, a random-seed choice or an output-count preference into another job. */
export function captureImageModelConfiguration({ draft }: { draft: ImageGenerationDraft }): ImageModelConfiguration {
  const { request, modelFiles, inferenceLocation, layout, modelSelection, remoteModelEditor, loraStates } = draft;
  return {
    ...structuredClone({ request: { models: request.models, loras: request.loras, runtime: request.runtime }, inferenceLocation, layout, modelSelection, remoteModelEditor, loraStates }),
    modelFiles: modelFiles.map(entry => ({ location: structuredClone(entry.location), file: entry.file })),
  };
}

/** Resolve against ONE captured common draft. Omitted fields continue to
 * inherit while editing; only acceptance freezes the concrete generation plan. */
export function resolveImageCompositionDraft({ common, input, slots }: { common: ImageGenerationDraft, input: ImageGenerationInput, slots: ImageCompositionSlot[] }): ImageGenerationDraft {
  const accepted = validateImageGenerationInput({ value: input });
  const { uiModelConfigurationSlot, count: _count, seed, steps, guidance, vaeTileSize, ...parameters } = accepted;
  const configuration = uiModelConfigurationSlot === undefined ? undefined : slots.find(slot => slot.name === uiModelConfigurationSlot)?.configuration;
  if (uiModelConfigurationSlot !== undefined && !configuration) {
    throw new Error(`Assign the model configuration slot: ${uiModelConfigurationSlot}`);
  }
  // Do not structuredClone browser File/Blob handles or Vue proxies. Callers
  // capture the common draft once before passing it here.
  const { modelFiles, files, ...metadata } = common;
  const result = { ...structuredClone(metadata), files: files.map(file => ({ ...file })), modelFiles: modelFiles.map(file => ({ ...file })) };
  if (configuration) {
    const { request, modelFiles: slotFiles, ...preferences } = configuration;
    Object.assign(result, structuredClone(preferences));
    result.request = { ...result.request, ...structuredClone(request) };
    result.modelFiles = slotFiles.map(file => ({ ...file }));
  }
  if (result.inferenceLocation?.kind === 'naidan_rpc' || result.request.runtime?.profile === 'naidan-rpc') {
    // Receiver-owned/local-only controls must not silently disappear. The remote
    // protocol supports tile *size*, but not the local tiling/runtime switches.
    const unsupported = ['vaeTiling', 'flashAttention', 'bf16WeightType', 'qwenVaePolicy', 'conditioningCacheSize', 'modelArguments'] as const;
    const specified = unsupported.filter(key => accepted[key] !== undefined);
    if (specified.length) {
      throw new Error(`Remote image generation does not support these overrides: ${specified.join(', ')}`);
    }
  }
  result.request.parameters = { ...result.request.parameters, ...parameters };
  if (seed !== undefined) {
    result.seedMode = seed === null ? 'random' : 'fixed';
    if (seed !== null) {
      result.request.parameters.seed = seed;
    }
  }
  if (steps !== undefined) {
    result.stepsPreference = steps;
    if (steps !== 'auto') {
      result.request.parameters.steps = steps;
    }
  }
  if (guidance !== undefined) {
    result.guidancePreference = guidance;
    if (guidance !== 'auto') {
      result.request.parameters.guidance = guidance;
    }
  }
  if (vaeTileSize !== undefined) {
    result.vaeTileSizePreference = vaeTileSize;
    if (vaeTileSize !== 'auto') {
      result.request.parameters.vaeTileSize = vaeTileSize;
    }
  }
  return result;
}

export const TEST_ONLY = {
};
