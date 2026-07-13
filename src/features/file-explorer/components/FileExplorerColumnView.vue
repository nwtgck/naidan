<script setup lang="ts">
import { inject, ref, watch, nextTick } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import FileExplorerColumnPane from './FileExplorerColumnPane.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const scrollContainerRef = ref<HTMLElement | null>(null);

// Auto-scroll to rightmost pane when panes change
watch(
  () => ctx.columnPanes.length,
  async () => {
    await nextTick();
    if (scrollContainerRef.value) {
      scrollContainerRef.value.scrollLeft = scrollContainerRef.value.scrollWidth;
    }
  },
);


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex flex-1 overflow-hidden">
    <!-- Column panes -->
    <div
      ref="scrollContainerRef"
      tw-class="flex flex-1 overflow-x-auto overscroll-contain"
    >
      <FileExplorerColumnPane
        v-for="(pane, i) in ctx.columnPanes"
        :key="i"
        :pane="pane"
        :pane-index="i"
      />
      <div
        v-if="ctx.isLoading"
        data-testid="file-explorer-column-navigation-loading"
        tw-class="flex w-52 shrink-0 items-center justify-center border-r border-gray-100 py-8 dark:border-gray-800"
      >
        <Loader2Icon tw-class="h-4 w-4 animate-spin text-gray-400" />
      </div>
    </div>

    <!-- Preview panel (always visible in column view if there's a selection) -->
    <FileExplorerPreviewPanel v-if="ctx.previewState.visibility === 'visible'" />
  </div>
</template>
