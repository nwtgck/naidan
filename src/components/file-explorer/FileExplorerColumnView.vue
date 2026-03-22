<script setup lang="ts">
import { inject, ref, watch, nextTick } from 'vue';
import FileExplorerColumnPane from './FileExplorerColumnPane.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';

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
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex flex-1 overflow-hidden">
    <!-- Column panes -->
    <div
      ref="scrollContainerRef"
      class="flex flex-1 overflow-x-auto overscroll-contain"
    >
      <FileExplorerColumnPane
        v-for="(pane, i) in ctx.columnPanes"
        :key="i"
        :pane="pane"
        :pane-index="i"
      />
    </div>

    <!-- Preview panel (always visible in column view if there's a selection) -->
    <FileExplorerPreviewPanel v-if="ctx.previewState.visibility === 'visible'" />
  </div>
</template>
