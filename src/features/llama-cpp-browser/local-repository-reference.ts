import { hasLocalRepositoryReferencePrefix } from '@/01-models/llama-cpp-browser-model-id';
import { isTemporaryModelReference } from './temporary-model-reference';

export function isPendingLocalModelReference({ modelId }: { modelId: string }): boolean {
  return hasLocalRepositoryReferencePrefix({ modelId, storage: 'pending' }) || isTemporaryModelReference({ modelId });
}

export const TEST_ONLY = {
};
