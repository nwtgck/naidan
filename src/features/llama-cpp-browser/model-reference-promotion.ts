import type { Endpoint, ScopedTitleGeneration } from '@/01-models/types';
import type { LocalModelPromotion } from '@/00-storage/service';
import { localModelReferenceIds, savedLocalModelReferences } from '@/00-storage/service/local-model-references';

export type LocalModelPromotionFields = { modelId?: string, titleGeneration?: ScopedTitleGeneration };

/** Patch current model slots, preserving messages and all unrelated settings. */
export function applyLocalModelPromotion({ target, endpoint, changes }: {
  target: LocalModelPromotionFields, endpoint: Endpoint, changes: LocalModelPromotion['changes'],
}): void {
  for (const change of changes) {
    switch (change.slot) {
    case 'model':
      if (endpoint.type === 'llama_cpp_browser' && target.modelId === change.sourceModelId) {
        target.modelId = change.modelId;
      }
      break;
    case 'title_model': {
      const title = target.titleGeneration;
      if (title === undefined || title === 'inherit' || title === 'disabled' || title.model === 'same_scope') {
        break;
      }
      if ((title.endpoint === 'same_scope' ? endpoint : title.endpoint).type === 'llama_cpp_browser' && title.model.id === change.sourceModelId) {
        target.titleGeneration = { ...title, model: { ...title.model, id: change.modelId } };
      }
      break;
    }
    default: {
      const exhaustive: never = change.slot;
      throw new Error(String(exhaustive));
    }
    }
  }
}

/** A delayed ordinary settings write may still publish the old pending name. */
export function normalizeSavedLocalModelFields({ target, endpoint }: { target: LocalModelPromotionFields, endpoint: Endpoint }): void {
  const references = savedLocalModelReferences({ modelIds: localModelReferenceIds({ modelId: target.modelId, titleGeneration: target.titleGeneration }) });
  applyLocalModelPromotion({
    target,
    endpoint,
    changes: references.flatMap(reference => [
      { slot: 'model' as const, sourceModelId: reference.sourceModelId, modelId: reference.modelId },
      { slot: 'title_model' as const, sourceModelId: reference.sourceModelId, modelId: reference.modelId },
    ]),
  });
}

export const TEST_ONLY = {
};
