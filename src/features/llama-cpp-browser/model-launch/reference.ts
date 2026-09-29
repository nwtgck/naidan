import { modelSourceRepositorySchema, huggingFaceModelId } from '@/01-models/llama-cpp-browser-model-launch';

/** Parse an exact local identity, never a display label or quantization alias. */
export function readModelLaunchReference({ modelId }: { modelId: string | undefined }): { repository: string, mainFilePath: string, modelId: string } | undefined {
  if (modelId === undefined || !modelId.startsWith('hf.co/')) return undefined;
  const colon = modelId.indexOf(':');
  if (colon < 0) return undefined;
  try {
    const repository = modelSourceRepositorySchema.parse(modelId.slice(6, colon));
    const mainFilePath = decodeURIComponent(modelId.slice(colon + 1));
    if (huggingFaceModelId({ repository, modelPath: mainFilePath }) !== modelId) return undefined;
    return { repository, mainFilePath, modelId };
  } catch {
    return undefined;
  }
}
export const TEST_ONLY = {
};
