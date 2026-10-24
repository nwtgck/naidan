import { modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import { isModelSourceSegment } from '@/01-models/llama-cpp-browser-model-id';

/** Read a public selection; the variant is resolved to files separately. */
export function readModelLaunchReference({ modelId }: { modelId: string | undefined }): { repository: string, variant: string, modelId: string } | undefined {
  if (modelId === undefined || !modelId.startsWith('hf.co/') || modelId.length > 512) {
    return undefined;
  }
  const colon = modelId.indexOf(':');
  if (colon < 0) {
    return undefined;
  }
  const repository = modelSourceRepositorySchema.safeParse(modelId.slice(6, colon));
  const variant = modelId.slice(colon + 1);
  if (!repository.success || !variant.split('/').every(name => isModelSourceSegment({ name }))) {
    return undefined;
  }
  return { repository: repository.data, variant, modelId };
}

export const TEST_ONLY = {
};
