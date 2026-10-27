import { computed, shallowRef } from 'vue';
import { llamaCppBrowserModelFiles, type ModelImportReceipt } from '@/features/llama-cpp-browser/model-files';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { localRepositories } from '@/features/llama-cpp-browser/runtime/local-repository-store';

type RecentModel = { model: LocalModel, publication: ModelImportReceipt['publication'] };
const entries = shallowRef<readonly RecentModel[]>([]);
let dismissedThrough = -1;
let latestGeneration = -1;
let subscribed = false;

function prune(): void {
  entries.value = entries.value.filter(({ model, publication }) => publication.isCurrent({ modelId: model.modelId }));
}

function publish({ receipt }: { receipt: ModelImportReceipt }): void {
  const { storage: _storage, models, publication, ...unhandledReceipt } = receipt;
  unhandledReceipt satisfies Record<PropertyKey, never>;
  if (publication.generation <= dismissedThrough) {
    return;
  }
  const confirmed = models.filter(model => publication.isCurrent({ modelId: model.modelId }));
  if (!confirmed.length) {
    return;
  }
  latestGeneration = Math.max(latestGeneration, publication.generation);
  const confirmedIds = new Set(confirmed.map(model => model.modelId));
  entries.value = [
    ...entries.value.filter(({ model, publication: previous }) => !confirmedIds.has(model.modelId) && previous.isCurrent({ modelId: model.modelId })),
    ...confirmed.map(model => ({ model, publication })),
  ];
}

const recentModels = computed(() => [...new Map(entries.value.filter(({ model, publication }) => publication.isCurrent({ modelId: model.modelId })).map(({ model }) => {
  const modelId = localRepositories.savedModelId({ modelId: model.modelId });
  return [modelId, modelId === model.modelId ? model : { ...model, modelId }] as const;
})).values()]);

function dismiss(): void {
  dismissedThrough = latestGeneration;
  entries.value = [];
}

/** All mounted libraries observe the same confirmed import receipts. */
export function useRecentModelImports() {
  if (!subscribed) {
    subscribed = true;
    // The service replays receipts so opening a library after an import still
    // shows it. Confirmation identity, deletion and storage guards stay there.
    llamaCppBrowserModelFiles.subscribeModelImports({ listener: publish });
    llamaCppBrowserModelFiles.subscribeModelList({ listener: prune });
  }
  return {
    recentModels,
    dismiss,
    prune,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
  publish,
  reset() {
    entries.value = [];
    dismissedThrough = -1;
    latestGeneration = -1;
  },
};
