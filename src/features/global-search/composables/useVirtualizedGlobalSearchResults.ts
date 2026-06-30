import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Ref,
} from 'vue';
import type { FlatSearchResultItem } from '@/features/global-search/types';
import { getSearchResultKey } from '@/features/global-search/logic/result-key';

const RESULT_GAP = 4;

function estimatedResultHeight({ entry }: {
  entry: FlatSearchResultItem,
}): number {
  switch (entry.type) {
  case 'chat_group':
    return 56;
  case 'chat':
    return 72;
  case 'message':
    return entry.item.isCurrentThread ? 88 : 108;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled search result type: ${String(_ex)}`);
  }
  }
}

function firstIndexEndingAfter({
  offsets,
  position,
}: {
  offsets: readonly number[],
  position: number,
}): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const nextOffset = offsets[middle + 1];
    if (nextOffset !== undefined && nextOffset <= position) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

export interface VirtualizedGlobalSearchResult {
  entry: FlatSearchResultItem,
  index: number,
  key: string,
  top: number,
}

export function useVirtualizedGlobalSearchResults({
  containerRef,
  results,
  overscan,
}: {
  containerRef: Ref<HTMLElement | null>,
  results: Readonly<Ref<FlatSearchResultItem[]>>,
  overscan: number,
}) {
  const scrollTop = ref(0);
  const viewportHeight = ref(0);
  const measurementsRevision = ref(0);
  const measuredHeights = new Map<string, number>();
  const rowElements = new Map<string, HTMLElement>();
  let rowResizeObserver: ResizeObserver | undefined;
  let containerResizeObserver: ResizeObserver | undefined;

  const layout = computed(() => {
    void measurementsRevision.value;
    const offsets = new Array<number>(results.value.length + 1);
    offsets[0] = 0;

    for (let index = 0; index < results.value.length; index++) {
      const entry = results.value[index];
      if (entry === undefined) continue;
      const key = getSearchResultKey({ entry });
      const measuredHeight = measuredHeights.get(key);
      const height = measuredHeight ?? estimatedResultHeight({ entry });
      offsets[index + 1] = (offsets[index] ?? 0) + height + RESULT_GAP;
    }

    return {
      offsets,
      totalHeight: offsets[offsets.length - 1] ?? 0,
    };
  });

  const virtualizationEnabled = computed(() => viewportHeight.value > 0);

  const visibleResults = computed<VirtualizedGlobalSearchResult[]>(() => {
    if (results.value.length === 0) return [];

    let startIndex = 0;
    let endIndex = results.value.length;
    if (virtualizationEnabled.value) {
      startIndex = Math.max(
        0,
        firstIndexEndingAfter({ offsets: layout.value.offsets, position: scrollTop.value }) - overscan,
      );
      endIndex = Math.min(
        results.value.length,
        firstIndexEndingAfter({
          offsets: layout.value.offsets,
          position: scrollTop.value + viewportHeight.value,
        }) + overscan + 1,
      );
    }

    const visible: VirtualizedGlobalSearchResult[] = [];
    for (let index = startIndex; index < endIndex; index++) {
      const entry = results.value[index];
      if (entry === undefined) continue;
      visible.push({
        entry,
        index,
        key: getSearchResultKey({ entry }),
        top: layout.value.offsets[index] ?? 0,
      });
    }
    return visible;
  });

  function updateViewportMetrics(): void {
    const container = containerRef.value;
    if (container === null) {
      scrollTop.value = 0;
      viewportHeight.value = 0;
      return;
    }
    scrollTop.value = container.scrollTop;
    viewportHeight.value = container.clientHeight;
  }

  function handleScroll(): void {
    updateViewportMetrics();
  }

  function attachContainer({
    nextContainer,
    previousContainer,
  }: {
    nextContainer: HTMLElement | null,
    previousContainer: HTMLElement | null,
  }): void {
    previousContainer?.removeEventListener('scroll', handleScroll);
    containerResizeObserver?.disconnect();
    containerResizeObserver = undefined;

    if (nextContainer !== null) {
      nextContainer.addEventListener('scroll', handleScroll, { passive: true });
      if (typeof ResizeObserver !== 'undefined') {
        containerResizeObserver = new ResizeObserver(updateViewportMetrics);
        containerResizeObserver.observe(nextContainer);
      }
    }
    updateViewportMetrics();
  }

  function ensureRowResizeObserver(): ResizeObserver | undefined {
    if (rowResizeObserver !== undefined || typeof ResizeObserver === 'undefined') {
      return rowResizeObserver;
    }

    rowResizeObserver = new ResizeObserver(entries => {
      let changed = false;
      for (const resizeEntry of entries) {
        if (!(resizeEntry.target instanceof HTMLElement)) continue;
        const key = resizeEntry.target.dataset.searchResultKey;
        if (key === undefined) continue;
        const height = resizeEntry.borderBoxSize[0]?.blockSize ?? resizeEntry.contentRect.height;
        if (height <= 0 || measuredHeights.get(key) === height) continue;
        measuredHeights.set(key, height);
        changed = true;
      }
      if (changed) measurementsRevision.value++;
    });
    return rowResizeObserver;
  }

  function setResultElement({
    key,
    element,
  }: {
    key: string,
    element: Element | null,
  }): void {
    const previous = rowElements.get(key);
    if (previous !== undefined && previous !== element) {
      rowResizeObserver?.unobserve(previous);
      rowElements.delete(key);
    }

    if (!(element instanceof HTMLElement) || previous === element) return;
    element.dataset.searchResultKey = key;
    rowElements.set(key, element);
    ensureRowResizeObserver()?.observe(element);
  }

  function scrollResultIntoView({ index }: { index: number }): void {
    const container = containerRef.value;
    if (container === null || container.clientHeight <= 0) return;
    if (index < 0 || index >= results.value.length) return;

    const resultTop = layout.value.offsets[index] ?? 0;
    const resultBottom = layout.value.offsets[index + 1] ?? resultTop;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;

    if (resultTop < viewportTop) {
      container.scrollTop = resultTop;
      updateViewportMetrics();
    } else if (resultBottom > viewportBottom) {
      container.scrollTop = resultBottom - container.clientHeight;
      updateViewportMetrics();
    }
  }

  watch(
    () => containerRef.value,
    (nextContainer, previousContainer) => {
      attachContainer({ nextContainer, previousContainer });
    },
  );

  watch(
    results,
    async nextResults => {
      const currentKeys = new Set(nextResults.map(entry => getSearchResultKey({ entry })));
      for (const key of measuredHeights.keys()) {
        if (!currentKeys.has(key)) measuredHeights.delete(key);
      }
      measurementsRevision.value++;
      await nextTick();
      updateViewportMetrics();
    },
    { deep: false },
  );

  onMounted(() => {
    attachContainer({ nextContainer: containerRef.value, previousContainer: null });
  });

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', handleScroll);
    containerResizeObserver?.disconnect();
    rowResizeObserver?.disconnect();
    rowElements.clear();
  });

  return {
    totalHeight: computed(() => layout.value.totalHeight),
    visibleResults,
    virtualizationEnabled,
    setResultElement,
    scrollResultIntoView,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        updateViewportMetrics,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
