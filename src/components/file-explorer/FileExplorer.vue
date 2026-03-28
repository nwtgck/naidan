<script setup lang="ts">
import { provide } from 'vue';
import { Loader2 } from 'lucide-vue-next';
import FileExplorerToolbar from './FileExplorerToolbar.vue';
import FileExplorerListView from './FileExplorerListView.vue';
import FileExplorerIconView from './FileExplorerIconView.vue';
import FileExplorerColumnView from './FileExplorerColumnView.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import FileExplorerStatusBar from './FileExplorerStatusBar.vue';
import FileExplorerContextMenu from './FileExplorerContextMenu.vue';
import { useFileExplorer, FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import { useFileExplorerKeyboard } from './useFileExplorerKeyboard';
import type { ViewMode, PreviewVisibility } from './types';
import type { ExplorerDirectory } from './explorer-directory';

const props = defineProps<{
  root: ExplorerDirectory;
  initialViewMode: ViewMode;
  initialPreviewVisibility: PreviewVisibility;
  /** Pre-built navigation stack (from root's children down to target). */
  initialStack: ExplorerDirectory[] | undefined;
}>();

const { context, _viewMode, _preview } = useFileExplorer({ root: props.root, initialStack: props.initialStack });

// Apply initial values
_viewMode.value = props.initialViewMode;
_preview.previewState.value = { ..._preview.previewState.value, visibility: props.initialPreviewVisibility };

// Provide context for child components
provide(FILE_EXPLORER_INJECTION_KEY, context);

// Keyboard handler
const { handleKeyDown } = useFileExplorerKeyboard({ ctx: context });

defineExpose({
  __testOnly: {
    context,
  },
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
        <Loader2 class="w-5 h-5 text-gray-400 animate-spin" />
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
