import { z } from 'zod';
import type { BinaryObjectId } from '@/01-models/ids';
import type { ImageGenerationModelFile, ImageGenerationRecord } from '@/01-models/image-generation-history';
import { imageInputsSchema, loraFileSchema, modelFileSchema, parametersSchema, previewSettingsSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';
import type { ImageInputs, Request } from '@/features/stable-diffusion-cpp-browser/types';

type ReuseOptions = {
  record: Pick<ImageGenerationRecord, 'request'>,
  findFile: ({ location }: { location: ImageGenerationModelFile }) => File | undefined,
  getImage: ({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) => Promise<Blob | undefined>,
};
type ReusePurpose = { type: 'history' } | { type: 'draft', loraStates: { enabled: boolean, strength: number }[] };
const draftParametersSchema = parametersSchema.extend({
  prompt: z.string().max(4096),
  negativePrompt: z.string().max(4096),
  seed: z.string().max(20),
  width: z.number().finite(),
  height: z.number().finite(),
  steps: z.number().finite(),
  guidance: z.number().finite(),
  distilledGuidance: z.number().finite(),
  vaeTileSize: z.number().finite(),
  conditioningCacheSize: z.number().finite(),
});

export function prepareImageHistoryReuse({ record, findFile, getImage }: ReuseOptions) {
  return prepareImageRequestReuse({ record, findFile, getImage, purpose: { type: 'history' } });
}

export function prepareImageDraftReuse({ loraStates, ...options }: ReuseOptions & { loraStates: { enabled: boolean, strength: number }[] }) {
  return prepareImageRequestReuse({ ...options, purpose: { type: 'draft', loraStates } });
}

/** Resolve an entire edit before applying it; no network access or form mutation.
 * A draft need not yet be a valid generation request (e.g. an empty prompt). */
async function prepareImageRequestReuse({ record, findFile, getImage, purpose }: ReuseOptions & { purpose: ReusePurpose }) {
  const options = (() => {
    switch (purpose.type) {
    case 'draft': return { schema: draftParametersSchema, states: purpose.loraStates, draft: true };
    case 'history': return { schema: parametersSchema, states: undefined, draft: false };
    default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
    }
  })();
  const parameters = options.schema.parse(record.request.parameters);
  const preview = previewSettingsSchema.parse(record.request.preview);
  const missing: string[] = [];
  const missingInactive: string[] = [];
  const models: Request['models'] = [];
  for (const model of record.request.models) {
    const file = findFile({ location: model.file });
    const companions: { path: string, file: File }[] = [];
    if (!file) missing.push(model.file.name);
    for (const companion of model.companions) {
      const file = findFile({ location: companion.file });
      if (!file) missing.push(companion.file.name);
      else companions.push({ path: companion.path, file });
    }
    if (file) models.push(modelFileSchema.parse({ slot: model.slot, path: model.path, file, companions }));
  }
  const modelFilesMissing = missing.length > 0;
  const loras: ImageLoraSelection[] = [];
  for (const [index, lora] of record.request.loras.entries()) {
    const state = options.states?.[index];
    const enabled = state?.enabled ?? lora.strength !== 0, strength = state?.strength ?? lora.strength;
    const file = findFile({ location: lora.file });
    if (!file) {
      // An unavailable disabled adapter is informational. An enabled adapter
      // requires explicit re-selection or acknowledgement before generation.
      if (!enabled) missingInactive.push(lora.file.name);
      else missing.push(lora.file.name);
      continue;
    }
    // History represents disabled selections as zero strength. Restore the
    // choice even if its file is now invalid; only enabling it requires a
    // usable adapter. The persisted shape does not retain its former strength.
    const selection = { file, path: lora.path, strength };
    loras.push({ ...(!enabled || options.draft ? selection : loraFileSchema.parse(selection)), enabled, sourceLabel: lora.file.name });
  }
  async function input({ image }: { image: { binaryObjectId: BinaryObjectId, name: string } }): Promise<File> {
    const blob = await getImage({ binaryObjectId: image.binaryObjectId });
    if (!blob) throw new Error(`Image generation input is missing: ${image.name}`);
    return new File([blob], image.name, { type: blob.type });
  }
  const imageInputs: ImageInputs = {
    initImage: record.request.imageInputs.initImage ? await input({ image: record.request.imageInputs.initImage }) : undefined,
    strength: record.request.imageInputs.strength,
    referenceImages: [],
  };
  for (const image of record.request.imageInputs.referenceImages) imageInputs.referenceImages.push(await input({ image }));
  return { parameters, preview, models: modelFilesMissing ? [] : models, loras, imageInputs: imageInputsSchema.parse(imageInputs), missing, missingInactive };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
