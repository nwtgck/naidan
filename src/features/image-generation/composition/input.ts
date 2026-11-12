import * as dtozod from '@/utils/dtozod';
import type { ImageCompositionInput } from '@/01-models/image-generation';
import { parametersSchema } from '@/features/stable-diffusion-cpp-browser/types';
import { IMAGE_GENERATION_MAX_RUN_IMAGES, planImageGenerationSeeds } from '@/01-models/image-generation';

export type ImageGenerationInput = ImageCompositionInput;

// This is the external paste boundary, not a dependency on the storage DTO.
// Persisted checkpoints have an independent schema and service-owned mapping.
const inputSchema = dtozod.object({
  prompt: dtozod.string(),
  negativePrompt: dtozod.string().optional(),
  width: dtozod.number().optional(),
  height: dtozod.number().optional(),
  steps: dtozod.union([dtozod.number(), dtozod.literal('auto')]).optional(),
  guidance: dtozod.union([dtozod.number(), dtozod.literal('auto')]).optional(),
  seed: dtozod.string().nullable().optional(),
  sampler: dtozod.enum(['auto', 'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'lcm']).optional(),
  scheduler: dtozod.enum(['auto', 'discrete', 'karras', 'exponential', 'simple', 'sgm_uniform']).optional(),
  distilledGuidance: dtozod.number().optional(),
  vaeTiling: dtozod.boolean().optional(),
  vaeTileSize: dtozod.union([dtozod.number(), dtozod.literal('auto')]).optional(),
  flashAttention: dtozod.boolean().optional(),
  bf16WeightType: dtozod.enum(['f32', 'f16', 'bf16']).optional(),
  qwenVaePolicy: dtozod.enum(['bounded', 'native']).optional(),
  conditioningCacheSize: dtozod.number().optional(),
  modelArguments: dtozod.string().optional(),
  count: dtozod.number().optional(),
  uiModelConfigurationSlot: dtozod.string().optional(),
});
export const IMAGE_COMPOSITION_MAX_JOBS = 128;
export const IMAGE_COMPOSITION_MAX_IMAGES = 512;
export const IMAGE_COMPOSITION_MAX_TEXT_BYTES = 1024 * 1024;
export const imageGenerationInputKeys = Object.keys(inputSchema.shape);

/** dtozod strips unknown keys for persistence compatibility. Pasted text needs
 * a separate allowlist so a misspelled parameter never silently disappears. */
export function validateImageGenerationInput({ value }: { value: unknown }): ImageGenerationInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Each request must be an object with an explicit prompt field.');
  }
  for (const key of Object.keys(value)) {
    if (!imageGenerationInputKeys.includes(key)) {
      throw new Error(`Unknown image generation parameter: ${key}`);
    }
  }
  const input = inputSchema.parse(value);
  for (const key of Object.keys(parametersSchema.shape) as (keyof typeof parametersSchema.shape)[]) {
    if (!(key in input)) {
      continue;
    }
    const field = input[key];
    if (field === undefined || key === 'seed' && field === null || (key === 'steps' || key === 'guidance' || key === 'vaeTileSize') && field === 'auto') {
      continue;
    }
    const parsed = parametersSchema.shape[key].safeParse(field);
    if (!parsed.success) {
      throw new Error(`${key}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    }
  }
  if (input.seed !== undefined && input.seed !== null) {
    // The native API also accepts -1; this editor makes random explicit as null.
    planImageGenerationSeeds({ baseSeed: input.seed, count: input.count ?? 1 });
  }
  if (input.count !== undefined && (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > IMAGE_GENERATION_MAX_RUN_IMAGES)) {
    throw new Error(`count must be an integer from 1 to ${IMAGE_GENERATION_MAX_RUN_IMAGES}.`);
  }
  if (input.uiModelConfigurationSlot !== undefined && (!input.uiModelConfigurationSlot.trim() || input.uiModelConfigurationSlot.length > 128 || /[\p{Cc}\p{Cs}]/u.test(input.uiModelConfigurationSlot))) {
    throw new Error('uiModelConfigurationSlot must contain 1–128 characters without control characters.');
  }
  return input;
}

export function validateImageGenerationInputs({ inputs, defaultCount }: { inputs: readonly ImageGenerationInput[], defaultCount: number }): { inputs: ImageGenerationInput[], totalImages: number } {
  if (!Number.isSafeInteger(defaultCount) || defaultCount < 1 || defaultCount > IMAGE_GENERATION_MAX_RUN_IMAGES) {
    throw new Error('Invalid shared image count.');
  }
  if (!inputs.length || inputs.length > IMAGE_COMPOSITION_MAX_JOBS) {
    throw new Error(`Use 1–${IMAGE_COMPOSITION_MAX_JOBS} requests per generation operation.`);
  }
  const validated = inputs.map((input, index) => {
    try {
      return validateImageGenerationInput({ value: input });
    } catch (error) {
      throw new Error(`Request ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const totalImages = validated.reduce((sum, input) => sum + (input.count ?? defaultCount), 0);
  if (totalImages > IMAGE_COMPOSITION_MAX_IMAGES) {
    throw new Error(`A generation operation can request at most ${IMAGE_COMPOSITION_MAX_IMAGES} images.`);
  }
  return { inputs: validated, totalImages };
}

export async function parseImageGenerationInput({ text }: { text: string }): Promise<{ format: 'YAML' | 'JSONL', inputs: ImageGenerationInput[] }> {
  if (text.length > IMAGE_COMPOSITION_MAX_TEXT_BYTES || new TextEncoder().encode(text).byteLength > IMAGE_COMPOSITION_MAX_TEXT_BYTES) {
    throw new Error('Pasted input must not exceed 1 MiB.');
  }
  if (!text.trim()) {
    throw new Error('Paste at least one request.');
  }
  // Keep the parser out of the ordinary single-image editor's initial bundle.
  const { parseAllDocuments, isMap, isScalar } = await import('yaml');
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u).map((line, index) => ({ line, index })).filter(item => item.line.trim());
  let jsonLines: unknown[] | undefined;
  try {
    jsonLines = lines.map(({ line }) => JSON.parse(line) as unknown);
  } catch { /* Pretty JSON and YAML use the document parser below. */ }
  const format = jsonLines ? 'JSONL' as const : 'YAML' as const;
  const units = jsonLines ? lines.map(({ line, index }) => ({ text: line, location: `Line ${index + 1}` })) : [{ text, location: 'YAML' }];
  const inputs: ImageGenerationInput[] = [];
  for (const unit of units) {
    const documents = parseAllDocuments(unit.text, { version: '1.2', uniqueKeys: true, prettyErrors: true });
    for (const doc of documents) {
      if (inputs.length >= IMAGE_COMPOSITION_MAX_JOBS) {
        throw new Error(`Use at most ${IMAGE_COMPOSITION_MAX_JOBS} requests.`);
      }
      try {
        if (doc.errors.length || doc.warnings.length) {
          throw new Error([...doc.errors, ...doc.warnings].map(error => error.message).join('\n'));
        }
        const version = doc.directives?.yaml.version;
        switch (version) {
        case '1.2': break;
        case '1.1': case 'next': case undefined: throw new Error('Only YAML 1.2 is supported.');
        default: {
          const exhaustive: never = version;
          throw new Error(String(exhaustive));
        }
        }
        const root = doc.contents;
        if (!isMap(root) || root.tag || root.anchor) {
          throw new Error('Each document must be a plain object with an explicit prompt field.');
        }
        for (const { key, value } of root.items) {
          if (!isScalar(key) || typeof key.value !== 'string' || key.tag || key.anchor || value !== null && (!isScalar(value) || value.tag || value.anchor)) {
            throw new Error('Nested values, tags, anchors and aliases are not supported in generation requests.');
          }
        }
        // Parsing JSONL with YAML as well detects duplicate and escaped keys;
        // JSON.parse alone would silently retain only the last occurrence.
        const raw: unknown = jsonLines ? jsonLines[inputs.length] : doc.toJS({ maxAliasCount: 0 });
        inputs.push(validateImageGenerationInput({ value: raw }));
      } catch (error) {
        throw new Error(`${unit.location}, request ${inputs.length + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!inputs.length) {
    throw new Error('Paste at least one request.');
  }
  return { format, inputs };
}

export const TEST_ONLY = {
};
