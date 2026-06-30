import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';

export function useVirtualizedFileExplorerList({
  containerRef,
  entries,
  rowHeight,
  overscan,
}: {
  containerRef: Ref<HTMLElement | undefined>,
  entries: Ref<FileExplorerEntry[]>,
  rowHeight: number,
  overscan: number,
}) {
  const scrollTop = ref(0);
  const viewportHeight = ref(0);

  function updateViewportMetrics(): void {
    const container = containerRef.value;
    if (!container) {
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
    nextContainer: HTMLElement | undefined,
    previousContainer: HTMLElement | undefined,
  }): void {
    previousContainer?.removeEventListener('scroll', handleScroll);
    nextContainer?.addEventListener('scroll', handleScroll, { passive: true });
    updateViewportMetrics();
  }

  const virtualizationEnabled = computed(() => viewportHeight.value > 0);

  const startIndex = computed(() => {
    if (!virtualizationEnabled.value) {
      return 0;
    }
    return Math.max(0, Math.floor(scrollTop.value / rowHeight) - overscan);
  });

  const endIndex = computed(() => {
    if (!virtualizationEnabled.value) {
      return entries.value.length;
    }
    const visibleCount = Math.ceil(viewportHeight.value / rowHeight) + overscan * 2;
    return Math.min(entries.value.length, startIndex.value + visibleCount);
  });

  const visibleEntries = computed(() => {
    if (!virtualizationEnabled.value) {
      return entries.value;
    }
    return entries.value.slice(startIndex.value, endIndex.value);
  });

  const totalHeight = computed(() => entries.value.length * rowHeight);
  const topSpacerHeight = computed(() => startIndex.value * rowHeight);
  const bottomSpacerHeight = computed(() =>
    Math.max(0, totalHeight.value - topSpacerHeight.value - visibleEntries.value.length * rowHeight),
  );

  function scrollEntryIntoView({ entryName }: { entryName: string | undefined }): void {
    if (!entryName) {
      return;
    }
    const container = containerRef.value;
    if (!container || container.clientHeight <= 0) {
      return;
    }
    const index = entries.value.findIndex(entry => entry.name === entryName);
    if (index === -1) {
      return;
    }

    const entryTop = index * rowHeight;
    const entryBottom = entryTop + rowHeight;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;

    if (entryTop < viewportTop) {
      container.scrollTop = entryTop;
      updateViewportMetrics();
      return;
    }

    if (entryBottom > viewportBottom) {
      container.scrollTop = entryBottom - container.clientHeight;
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
    entries,
    async () => {
      await nextTick();
      updateViewportMetrics();
    },
    { deep: false },
  );

  useEventTargetListener(window, 'resize', updateViewportMetrics);

  onMounted(() => {
    attachContainer({ nextContainer: containerRef.value, previousContainer: undefined });
  });

  onUnmounted(() => {
    containerRef.value?.removeEventListener('scroll', handleScroll);
  });

  return {
    scrollTop,
    viewportHeight,
    startIndex,
    endIndex,
    visibleEntries,
    totalHeight,
    topSpacerHeight,
    bottomSpacerHeight,
    virtualizationEnabled,
    scrollEntryIntoView,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        updateViewportMetrics,
      },
    }) || {}),
  };
}
