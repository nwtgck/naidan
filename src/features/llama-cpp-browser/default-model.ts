import type { Endpoint } from '@/01-models/types';
import { hasLocalRepositoryReferencePrefix } from '@/01-models/llama-cpp-browser-model-id';
import type { LocalModel } from './types';

export type DefaultModelContext = { endpoint: Endpoint, modelId: string | undefined };
export type ApplyDefaultModel = ({ model, previous }: { model: LocalModel, previous: DefaultModelContext }) => Promise<'applied' | 'changed'>;

export function isDefaultLocalModel({ model, current }: { model: LocalModel, current: DefaultModelContext | undefined }): boolean {
  return current?.endpoint.type === 'llama_cpp_browser' && current.modelId === model.modelId;
}

/** Old single-model user/root references remain loadable. Show their current
 * inventory row as selected only while that root has one unambiguous variant;
 * this is presentation, never a migration or a guessed pending-source alias. */
export function displayedLocalModelDefault({ current, models }: { current: DefaultModelContext | undefined, models: readonly LocalModel[] }): DefaultModelContext | undefined {
  if (current?.endpoint.type !== 'llama_cpp_browser' || current.modelId === undefined
    || !hasLocalRepositoryReferencePrefix({ modelId: current.modelId, storage: 'saved' }) || current.modelId.split('/').length !== 2) {
    return current;
  }
  const candidates = models.filter(model => model.modelId.startsWith(`${current.modelId}/`));
  return candidates.length === 1 && candidates[0] ? { ...current, modelId: candidates[0].modelId } : current;
}

export const TEST_ONLY = {
};
