<script setup lang="ts">
import { computed } from 'vue';
import { XIcon } from 'lucide-vue-next';
import { useFileExplorerModal, mapFileExplorerModalOptionsToRootDescriptor } from '@/composables/useFileExplorerModal';
import FileExplorer from './file-explorer/FileExplorer.vue';

const { closeFileExplorer, fileExplorerOptions } = useFileExplorerModal();

const initialLocked = computed(() => fileExplorerOptions.value.kind === 'opfs-root');

const title = computed(() => {
  const options = fileExplorerOptions.value;
  switch (options.kind) {
  case 'opfs-root':
    return 'File Explorer (OPFS)';
  case 'native-directory':
  case 'wesh-mounts':
    return options.title;
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
});

const initialPath = computed(() => {
  const options = fileExplorerOptions.value;
  switch (options.kind) {
  case 'opfs-root':
    return undefined;
  case 'native-directory':
  case 'wesh-mounts':
    return options.initialPath;
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
});

const root = computed(() => mapFileExplorerModalOptionsToRootDescriptor({
  options: fileExplorerOptions.value,
}));


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      data-testid="file-explorer-modal"
      @click.self="closeFileExplorer()"
    >
      <div class="flex flex-col w-full max-w-5xl h-[95vh] md:h-[90vh] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700">
        <div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">{{ title }}</span>
          <button
            class="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Close"
            data-testid="file-explorer-modal-close"
            @click="closeFileExplorer()"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>

        <div class="flex-1 overflow-hidden">
          <Suspense>
            <FileExplorer
              :root="root"
              :initial-path="initialPath"
              :initial-locked="initialLocked"
              initial-view-mode="list"
              initial-preview-visibility="visible"
              class="h-full"
            />
          </Suspense>
        </div>
      </div>
    </div>
  </Teleport>
</template>
