<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
import { useFileExplorerModal } from '@/composables/useFileExplorerModal';
import FileExplorer from './file-explorer/FileExplorer.vue';

const { closeFileExplorer } = useFileExplorerModal();

const rootHandle = ref<FileSystemDirectoryHandle | undefined>(undefined);
const loadError = ref<string | undefined>(undefined);

onMounted(async () => {
  try {
    rootHandle.value = await navigator.storage.getDirectory();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-900"
      data-testid="file-explorer-modal"
    >
      <!-- Modal header -->
      <div class="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">File Explorer (OPFS)</span>
        <button
          class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Close"
          data-testid="file-explorer-modal-close"
          @click="closeFileExplorer()"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-hidden">
        <!-- Loading -->
        <div
          v-if="!rootHandle && !loadError"
          class="flex items-center justify-center h-full gap-2 text-gray-400"
        >
          <Loader2 class="w-5 h-5 animate-spin" />
          <span class="text-sm">Loading OPFS…</span>
        </div>

        <!-- Error -->
        <div
          v-else-if="loadError"
          class="flex items-center justify-center h-full text-red-500 text-sm px-8 text-center"
        >
          {{ loadError }}
        </div>

        <!-- Explorer -->
        <FileExplorer
          v-else-if="rootHandle"
          :root="rootHandle"
          initial-view-mode="list"
          initial-preview-visibility="visible"
          class="h-full"
        />
      </div>
    </div>
  </Teleport>
</template>
