<script setup lang="ts">
import { computed, onUnmounted, provide } from 'vue';
import { FileArchiveIcon, Loader2Icon } from 'lucide-vue-next';
import FileExplorerToolbar from './FileExplorerToolbar.vue';
import FileExplorerListView from './FileExplorerListView.vue';
import FileExplorerIconView from './FileExplorerIconView.vue';
import FileExplorerColumnView from './FileExplorerColumnView.vue';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';
import FileExplorerStatusBar from './FileExplorerStatusBar.vue';
import FileExplorerContextMenu from './FileExplorerContextMenu.vue';
import FileExplorerDirectoryDownloadDialog from './FileExplorerDirectoryDownloadDialog.vue';
import FileExplorerZipUploadDialog from './FileExplorerZipUploadDialog.vue';
import { useFileExplorer, FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { useFileExplorerKeyboard } from '@/features/file-explorer/composables/useFileExplorerKeyboard';
import type { ViewMode, PreviewVisibility } from '@/features/file-explorer/logic/types';
import type { FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  root: FileExplorerRootDescriptor,
  initialViewMode: ViewMode,
  initialPreviewVisibility: PreviewVisibility,
  initialPath: string[] | undefined,
  /** When true, the explorer starts in locked mode (write operations disabled). */
  initialLocked: boolean,
}>();

let unmounted = false;
let disposeResources: (() => void) | undefined;
onUnmounted(() => {
  unmounted = true;
  disposeResources?.();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});

const { context, client, _viewMode, _preview } = await useFileExplorer({
  root: props.root,
  initialPath: props.initialPath,
  initialLocked: props.initialLocked,
});

disposeResources = () => {
  _preview.dispose();
  context.directoryDownload.dispose();
  context.upload.dispose();
  void client.dispose();
};
if (unmounted) {
  disposeResources();
}

// Apply initial values
_viewMode.value = props.initialViewMode;
_preview.previewState.value = { ..._preview.previewState.value, visibility: props.initialPreviewVisibility };

// Provide context for child components
provide(FILE_EXPLORER_INJECTION_KEY, context);

const isInsideArchive = computed(() => context.pathSegments.some(segment => segment.kind === 'archive'));

// Keyboard handler
const { handleKeyDown } = useFileExplorerKeyboard({ ctx: context });

</script>

<template>
  <div
    tw-class="flex flex-col h-full bg-white dark:bg-gray-900 outline-none overflow-hidden"
    tabindex="0"
    data-testid="file-explorer"
    @keydown="handleKeyDown({ event: $event })"
  >
    <!-- Toolbar -->
    <FileExplorerToolbar />

    <div
      v-if="isInsideArchive"
      data-testid="file-explorer-archive-location"
      tw-class="flex items-center gap-2 border-b border-gray-200/60 bg-gray-50/70 px-3 py-2 text-xs font-medium text-gray-500 dark:border-gray-700/50 dark:bg-gray-800/30 dark:text-gray-400"
    >
      <FileArchiveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
      <span>{{ lazyStrings.fileExplorer__zip_archive() }}</span>
      <span aria-hidden="true" tw-class="text-gray-300 dark:text-gray-600">·</span>
      <span>{{ lazyStrings.fileExplorer__read_only() }}</span>
    </div>

    <!-- Main content area -->
    <div tw-class="flex flex-1 overflow-hidden">
      <!-- Loading overlay -->
      <div
        v-if="context.isLoading"
        tw-class="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-gray-900/50 z-10 pointer-events-none"
      >
        <Loader2Icon tw-class="w-5 h-5 text-gray-400 animate-spin" />
      </div>

      <!-- Error banner -->
      <div
        v-if="context.loadError"
        tw-class="absolute top-0 left-0 right-0 px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400 z-20"
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

    <FileExplorerDirectoryDownloadDialog />
    <FileExplorerZipUploadDialog />
  </div>
</template>
