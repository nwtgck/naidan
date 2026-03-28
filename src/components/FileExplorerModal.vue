<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
import { useFileExplorerModal } from '@/composables/useFileExplorerModal';
import FileExplorer from './file-explorer/FileExplorer.vue';
import { FsExplorerDirectory } from './file-explorer/explorer-directory';
import type { ExplorerDirectory } from './file-explorer/explorer-directory';

const { closeFileExplorer, fileExplorerOptions, isFileExplorerOpen } = useFileExplorerModal();

const root = ref<ExplorerDirectory | undefined>(undefined);
const loadError = ref<string | undefined>(undefined);

const title = computed(() => {
  const opts = fileExplorerOptions.value;
  switch (opts.kind) {
  case 'explorer':
    return opts.title;
  case 'opfs-root':
    return 'File Explorer (OPFS)';
  default: {
    const _ex: never = opts;
    throw new Error(`Unhandled kind: ${JSON.stringify(_ex)}`);
  }
  }
});

const initialEntryName = computed(() => {
  const opts = fileExplorerOptions.value;
  switch (opts.kind) {
  case 'explorer':
    return opts.initialEntryName;
  case 'opfs-root':
    return undefined;
  default: {
    const _ex: never = opts;
    throw new Error(`Unhandled kind: ${JSON.stringify(_ex)}`);
  }
  }
});

async function loadRoot(): Promise<void> {
  const opts = fileExplorerOptions.value;
  root.value = undefined;
  loadError.value = undefined;

  switch (opts.kind) {
  case 'explorer':
    root.value = opts.root;
    return;
  case 'opfs-root':
    // opfs-root: load async
    try {
      const handle = await navigator.storage.getDirectory();
      root.value = new FsExplorerDirectory({ handle, readOnly: false });
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    }
    return;
  default: {
    const _ex: never = opts;
    throw new Error(`Unhandled kind: ${JSON.stringify(_ex)}`);
  }
  }
}

// Load on first mount (modal is rendered only when open, so isFileExplorerOpen is already true)
onMounted(() => void loadRoot());

// Reload root whenever the modal re-opens (e.g. different options)
watch(isFileExplorerOpen, (open) => {
  if (open) void loadRoot();
});

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      data-testid="file-explorer-modal"
      @click.self="closeFileExplorer()"
    >
      <!-- Dialog panel -->
      <div class="flex flex-col w-full max-w-5xl h-[680px] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">{{ title }}</span>
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
            v-if="!root && !loadError"
            class="flex items-center justify-center h-full gap-2 text-gray-400"
          >
            <Loader2 class="w-5 h-5 animate-spin" />
            <span class="text-sm">Loading…</span>
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
            v-else-if="root"
            :root="root"
            :initial-entry-name="initialEntryName"
            initial-view-mode="list"
            initial-preview-visibility="visible"
            class="h-full"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>
