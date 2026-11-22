<script setup lang="ts">
import { inject, useTemplateRef, watch } from 'vue';
import FileExplorerColumnPane from './FileExplorerColumnPane.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { FILE_EXPLORER_FILE_VIEW_KEY } from '@/features/file-explorer/composables/file-explorer-file-view-context';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const fileView = inject(FILE_EXPLORER_FILE_VIEW_KEY, undefined);
const scrollContainer = useTemplateRef<HTMLElement>('scrollContainer');

// The columns can already exist when the scroller mounts or becomes visible again.
watch(
  [scrollContainer, () => ctx.columnPanes.at(-1)?.path, () => fileView?.isActive.value],
  ([container, , fileViewActive]) => {
    if (container && !fileViewActive) {
      container.scrollLeft = container.scrollWidth;
    }
  },
  { flush: 'post' },
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
      ref="scrollContainer"
      data-testid="file-explorer-column-scroll"
      tw-class="flex flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain"
    >
      <FileExplorerColumnPane
        v-for="(pane, i) in ctx.columnPanes"
        :key="pane.path"
        :pane="pane"
        :pane-index="i"
      />
    </div>

    <!-- Preview panel (always visible in column view if there's a selection) -->
    <FileExplorerPreviewPanel v-if="ctx.previewState.visibility === 'visible'" />
  </div>
</template>
