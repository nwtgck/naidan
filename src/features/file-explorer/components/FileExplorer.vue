<script setup lang="ts">
import { onUnmounted, provide } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import FileExplorerToolbar from './FileExplorerToolbar.vue';
import FileExplorerListView from './FileExplorerListView.vue';
import FileExplorerIconView from './FileExplorerIconView.vue';
import FileExplorerColumnView from './FileExplorerColumnView.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import FileExplorerStatusBar from './FileExplorerStatusBar.vue';
import FileExplorerContextMenu from './FileExplorerContextMenu.vue';
import { useFileExplorer, FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { useFileExplorerKeyboard } from '@/features/file-explorer/composables/useFileExplorerKeyboard';
import type { ViewMode, PreviewVisibility } from '@/features/file-explorer/logic/types';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';

const props = defineProps<{
  root: FileExplorerRootDescriptor,
  initialViewMode: ViewMode,
  initialPreviewVisibility: PreviewVisibility,
  initialPath: string[] | undefined,
  /** When true, the explorer starts in locked mode (write operations disabled). */
  initialLocked: boolean,
}>();

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});

const { context, client, _viewMode, _preview } = await useFileExplorer({
  root: props.root,
  initialPath: props.initialPath,
  initialLocked: props.initialLocked,
});

// Apply initial values
_viewMode.value = props.initialViewMode;
_preview.previewState.value = { ..._preview.previewState.value, visibility: props.initialPreviewVisibility };

// Provide context for child components
provide(FILE_EXPLORER_INJECTION_KEY, context);

// Keyboard handler
const { handleKeyDown } = useFileExplorerKeyboard({ ctx: context });

onUnmounted(() => {
  _preview.dispose();
  void client.dispose();
});
</script>

<template>
  <div
    class="flex flex-col h-full bg-white dark:bg-gray-900 outline-none overflow-hidden"
    tabindex="0"
    data-testid="file-explorer"
    @keydown="handleKeyDown({ event: $event })"
  >
    <!-- Toolbar -->
    <FileExplorerToolbar />

    <!-- Main content area -->
    <div class="flex flex-1 overflow-hidden">
      <!-- Loading overlay -->
      <div
        v-if="context.isLoading"
        class="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-gray-900/50 z-10 pointer-events-none"
      >
        <Loader2Icon class="w-5 h-5 text-gray-400 animate-spin" />
      </div>

      <!-- Error banner -->
      <div
        v-if="context.loadError"
        class="absolute top-0 left-0 right-0 px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400 z-20"
      >
        {{ context.loadError }}
      </div>

      <!-- Column view has its own layout (includes preview panel) -->
      <FileExplorerColumnView v-if="context.viewMode === 'column'" />

      <!-- List + Icon view with optional preview panel -->
      <template v-else>
        <FileExplorerListView v-if="context.viewMode === 'list'" />
        <FileExplorerIconView v-else-if="context.viewMode === 'icon'" />

        <!-- Preview panel -->
        <FileExplorerPreviewPanel
          v-if="context.previewState.visibility === 'visible'"
        />
      </template>
    </div>

    <!-- Status bar -->
    <FileExplorerStatusBar />

    <!-- Context menu (teleported) -->
    <FileExplorerContextMenu />
  </div>
</template>
