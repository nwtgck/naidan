import { ref, shallowRef } from 'vue';
import { storageService } from '@/00-storage/service';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationHistoryPage, ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';
import type { StorageType } from '@/01-models/types';
import { createImageHistoryClient } from './worker/client-hosted';
import type { ImageHistoryClient } from './worker/types';

/** Hosted-only owner; opening history performs only local OPFS operations. */
export function useImageGenerationHistory({ getStorageType }: { getStorageType: () => StorageType }) {
  const items = shallowRef<ImageGenerationSummary[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const error = ref('');
  const warnings = shallowRef<ImageGenerationHistoryPage['warnings']>([]);
  const warningCount = ref(0);
  const selected = shallowRef<ImageGenerationRecord>();
  const detailLoading = ref(false);
  const detailError = ref('');
  const imageInvalidation = shallowRef<{ binaryObjectId: BinaryObjectId, revision: number }>();
  const available = ref(getStorageType() === 'opfs');
  let client: ImageHistoryClient | undefined;
  let queryText = '';
  let queryGeneration = 0;
  let detailGeneration = 0;
  let pendingSelection: { id: ImageGenerationId, operation: Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let storageGeneration = 0;
  let imageRevision = 0;
  let runningQuery: Promise<void> | undefined;
  let queuedQuery: { append: boolean, generation: number, resolve: () => void } | undefined;

  function invalidateQuery(): number {
    clearTimeout(timer);
    timer = undefined;
    queuedQuery?.resolve();
    queuedQuery = undefined;
    return ++queryGeneration;
  }
  function refreshAvailability(): boolean {
    available.value = !disposed && getStorageType() === 'opfs';
    return available.value;
  }
  async function executeQuery({ append, generation }: { append: boolean, generation: number }): Promise<void> {
    if (generation !== queryGeneration || disposed) return;
    if (!refreshAvailability()) {
      items.value = []; total.value = 0; loading.value = false;
      warnings.value = []; warningCount.value = 0;
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      client ??= createImageHistoryClient();
      const page = await client.query({ query: { text: queryText, offset: append ? items.value.length : 0, limit: 40 } });
      if (generation !== queryGeneration || !refreshAvailability()) return;
      items.value = append ? [...items.value, ...page.items] : page.items;
      total.value = page.total;
      warnings.value = page.warnings;
      warningCount.value = page.warningCount;
    } catch (cause) {
      if (generation === queryGeneration && !disposed) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === queryGeneration) loading.value = false;
    }
  }
  function drainQueries(): void {
    if (runningQuery) return;
    runningQuery = (async () => {
      // Keep only one active read and the latest pending request. Finishing
      // recovery safely is preferable to terminating a Worker mid-write.
      while (queuedQuery) {
        const next = queuedQuery;
        queuedQuery = undefined;
        await executeQuery(next);
        next.resolve();
      }
    })().finally(() => {
      runningQuery = undefined;
      if (queuedQuery) drainQueries();
    });
  }
  function runQuery({ append, generation }: { append: boolean, generation: number }): Promise<void> {
    if (generation === queryGeneration) loading.value = refreshAvailability();
    return new Promise<void>(resolve => {
      queuedQuery?.resolve();
      queuedQuery = { append, generation, resolve };
      drainQueries();
    });
  }
  async function reload(): Promise<void> {
    await runQuery({ append: false, generation: invalidateQuery() });
  }
  function setQuery({ text }: { text: string }): void {
    queryText = text;
    const generation = invalidateQuery();
    error.value = '';
    loading.value = refreshAvailability();
    if (!available.value) {
      items.value = []; total.value = 0;
      warnings.value = []; warningCount.value = 0;
      return;
    }
    // Keep the last completed result visible throughout debounce and the Worker
    // read. Its records, count and warnings are replaced together on success.
    timer = setTimeout(() => {
      timer = undefined;
      void runQuery({ append: false, generation });
    }, 250);
  }
  async function loadMore(): Promise<void> {
    // After a failed replacement, the retained page belongs to the old query.
    // Retry that query from the beginning rather than appending at its old offset.
    if (loading.value || error.value || !refreshAvailability() || items.value.length >= total.value) return;
    await runQuery({ append: true, generation: invalidateQuery() });
  }
  function clearSelection(): void {
    detailGeneration++;
    pendingSelection = undefined;
    selected.value = undefined;
    detailLoading.value = false;
    detailError.value = '';
  }
  function select({ id }: { id: ImageGenerationId }): Promise<void> {
    if (!refreshAvailability()) {
      clearSelection();
      return Promise.resolve();
    }
    if (selected.value?.id === id) {
      // Selecting the displayed record also cancels a pending switch away from it.
      detailGeneration++;
      pendingSelection = undefined;
      detailLoading.value = false;
      detailError.value = '';
      return Promise.resolve();
    }
    if (pendingSelection?.id === id) return pendingSelection.operation;
    const generation = ++detailGeneration;
    detailLoading.value = true;
    detailError.value = '';
    // Keep the displayed snapshot and the two-column layout until its replacement
    // is ready. Image, settings and action targets must change together.
    const operation = (async () => {
      try {
        const record = await storageService.loadImageGeneration({ id });
        if (generation !== detailGeneration || !refreshAvailability()) return;
        if (!record) throw new Error('Image generation history record is missing');
        selected.value = record;
      } catch (cause) {
        if (generation === detailGeneration && !disposed) detailError.value = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (generation === detailGeneration) {
          detailLoading.value = false;
          pendingSelection = undefined;
        }
      }
    })();
    pendingSelection = { id, operation };
    return operation;
  }
  async function remove({ id }: { id: ImageGenerationId }): Promise<void> {
    if (!refreshAvailability()) throw new Error('Image generation history requires OPFS storage');
    await storageService.deleteImageGeneration({ id });
    if (selected.value?.id === id) clearSelection();
    await reload();
  }
  async function getImage({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | undefined> {
    if (!refreshAvailability()) return undefined;
    const blob = await storageService.getFile({ binaryObjectId });
    return refreshAvailability() ? blob ?? undefined : undefined;
  }
  async function removeImage({ id, binaryObjectId }: { id: ImageGenerationId, binaryObjectId: BinaryObjectId }): Promise<void> {
    if (!refreshAvailability()) throw new Error('Image generation history requires OPFS storage');
    if (detailLoading.value || selected.value?.id !== id || selected.value.result.binaryObjectId !== binaryObjectId) {
      throw new Error('The selected image has changed');
    }
    const generation = storageGeneration;
    await storageService.deleteBinaryObject({ binaryObjectId });
    // Keep records and unrelated Object URLs intact; only this binary was deleted.
    if (generation === storageGeneration && refreshAvailability()) {
      imageInvalidation.value = { binaryObjectId, revision: ++imageRevision };
    }
  }
  const unsubscribe = storageService.subscribeToChanges({ listener: ({ event }) => {
    switch (event.type) {
    case 'migration': break;
    case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'binary_objects': return;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
    invalidateQuery();
    storageGeneration++;
    imageInvalidation.value = undefined;
    clearSelection();
    items.value = [];
    total.value = 0;
    loading.value = false;
    error.value = '';
    warnings.value = [];
    warningCount.value = 0;
    refreshAvailability();
  } });
  async function dispose(): Promise<void> {
    unsubscribe();
    disposed = true;
    invalidateQuery();
    clearSelection();
    loading.value = false;
    available.value = false;
    const ownedClient = client;
    client = undefined;
    await runningQuery;
    await ownedClient?.dispose();
  }
  return { items, total, loading, error, warnings, warningCount, selected, detailLoading, detailError, imageInvalidation, available, setQuery, reload, loadMore, select, remove, removeImage, getImage, clearSelection, dispose,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}), };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
