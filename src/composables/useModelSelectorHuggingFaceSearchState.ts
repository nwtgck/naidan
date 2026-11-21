import { inject, provide, ref, shallowRef, type InjectionKey } from 'vue';
import type { ModelSearchResult } from '@/features/llama-cpp-browser/hugging-face/catalog';

function createSearchState() {
  return {
    query: ref(''),
    results: shallowRef<ModelSearchResult[]>([]),
    resultSearch: ref<{ query: string, numParameters: string | undefined }>(),
    nextCursor: ref<string>(),
    latestBatchStartId: ref<string>(),
    visitedCursors: new Set<string>(),
    filtersOpen: ref(false),
    minimumBillions: ref(''),
    maximumBillions: ref(''),
  };
}

const searchStateKey: InjectionKey<ReturnType<typeof createSearchState>> = Symbol('model-selector-hugging-face-search');

export function provideModelSelectorHuggingFaceSearchState() {
  const state = createSearchState();
  provide(searchStateKey, state);
  return state;
}

export function useModelSelectorHuggingFaceSearchState() {
  return inject(searchStateKey, createSearchState, true);
}

export const TEST_ONLY = {
};
