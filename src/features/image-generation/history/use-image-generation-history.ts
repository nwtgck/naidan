import { computed, ref, shallowRef } from 'vue';
import { storageService } from '@/00-storage/service';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationHistoryPage, ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';
import type { StorageType } from '@/01-models/types';
import { createImageHistoryClient } from '@/features/image-generation/history/worker/client';
import type { ImageHistoryClient } from './worker/types';

/** Caller-side owner; opening history performs only local OPFS operations,
 * independently of whether a native inference engine is distributed. */
export function useImageGenerationHistory({ getStorageType }: { getStorageType: () => StorageType }) {
  const pageSize = 40;
  const items = shallowRef<ImageGenerationSummary[]>([]);
  const total = ref(0);
  const currentPage = ref(1);
  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
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
  let requestedPage = 1;
  let queryGeneration = 0;
  let detailGeneration = 0;
  let pendingSelection: { id: ImageGenerationId, operation: Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let storageGeneration = 0;
  let imageRevision = 0;
  let runningQuery: Promise<void> | undefined;
  let queuedQuery: { page: number, generation: number, resolve: () => void } | undefined;

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
  async function executeQuery({ page, generation }: { page: number, generation: number }): Promise<void> {
    if (generation !== queryGeneration || disposed) return;
    if (!refreshAvailability()) {
      items.value = []; total.value = 0; loading.value = false;
      currentPage.value = 1; requestedPage = 1;
      warnings.value = []; warningCount.value = 0;
      return;
    }
    loading.value = true;
    error.value = '';
    try {
      client ??= createImageHistoryClient();
      let targetPage = page;
      for (;;) {
        const result = await client.query({ query: { text: queryText, offset: (targetPage - 1) * pageSize, limit: pageSize } });
        if (generation !== queryGeneration || !refreshAvailability()) return;
        const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
        if (targetPage > lastPage && result.total > 0) {
          // A deletion can remove the last page. Move only toward an existing
          // page and retain the displayed snapshot until that page is ready.
          targetPage = lastPage;
          requestedPage = targetPage;
          continue;
        }
        items.value = result.items;
        total.value = result.total;
        currentPage.value = result.total === 0 ? 1 : targetPage;
        requestedPage = currentPage.value;
        warnings.value = result.warnings;
        warningCount.value = result.warningCount;
        return;
      }
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
  function runQuery({ page, generation }: { page: number, generation: number }): Promise<void> {
    if (generation === queryGeneration) loading.value = refreshAvailability();
    return new Promise<void>(resolve => {
      queuedQuery?.resolve();
      queuedQuery = { page, generation, resolve };
      drainQueries();
    });
  }
  async function reload(): Promise<void> {
    await runQuery({ page: requestedPage, generation: invalidateQuery() });
  }
  function setQuery({ text }: { text: string }): void {
    queryText = text;
    requestedPage = 1;
    const generation = invalidateQuery();
    error.value = '';
    loading.value = refreshAvailability();
    if (!available.value) {
      items.value = []; total.value = 0;
      currentPage.value = 1;
      warnings.value = []; warningCount.value = 0;
      return;
    }
    // Keep the last completed result visible throughout debounce and the Worker
    // read. Its records, count and warnings are replaced together on success.
    timer = setTimeout(() => {
      timer = undefined;
      void runQuery({ page: 1, generation });
    }, 250);
  }
  async function goToPage({ page }: { page: number }): Promise<void> {
    // During a replacement or after failure, controls still describe the last
    // completed query. Reload retries the pending target without mixing pages.
    if (loading.value || error.value || !refreshAvailability() || !Number.isInteger(page) || page < 1 || page > pageCount.value || page === currentPage.value) return;
    requestedPage = page;
    await runQuery({ page, generation: invalidateQuery() });
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
    if (selected.value?.id === id) {
      // Deletion may finish while another detail is loading. Remove the deleted
      // snapshot without invalidating the user's newer selection.
      if (pendingSelection && pendingSelection.id !== id) selected.value = undefined;
      else clearSelection();
    } else if (pendingSelection?.id === id) {
      // A late read must not redisplay the deleted record over another detail.
      detailGeneration++;
      pendingSelection = undefined;
      detailLoading.value = false;
      detailError.value = '';
    }
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
  const unsubscribe = storageService.subscribeToChanges({
    listener: ({ event }) => {
    switch (event.type) {
    case 'migration': break;
    case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'naidan_rpc_registry': case 'binary_objects': return;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
    invalidateQuery();
    storageGeneration++;
    imageInvalidation.value = undefined;
    clearSelection();
    items.value = [];
    total.value = 0;
    currentPage.value = 1;
    requestedPage = 1;
    loading.value = false;
    error.value = '';
    warnings.value = [];
    warningCount.value = 0;
    refreshAvailability();
  },
  });
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
  return {
    items,
    total,
    currentPage,
    pageCount,
    loading,
    error,
    warnings,
    warningCount,
    selected,
    detailLoading,
    detailError,
    imageInvalidation,
    available,
    setQuery,
    reload,
    goToPage,
    select,
    remove,
    removeImage,
    getImage,
    clearSelection,
    dispose,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
