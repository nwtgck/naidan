<script setup lang="ts">
import { inject, ref } from 'vue';
import { LayoutGrid, List, Columns3, RefreshCw, Search, FilePlus, FolderPlus, Upload, Eye, EyeOff, X, Lock, LockOpen } from 'lucide-vue-next';
import FileExplorerBreadcrumbs from './FileExplorerBreadcrumbs.vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import type { ViewMode } from './types';
import { usePrompt } from '@/composables/usePrompt';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const { showPrompt } = usePrompt();

const isSearchOpen = ref(false);
const isRefreshing = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

function handleUploadClick(): void {
  fileInputRef.value?.click();
}

async function handleFileInputChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await ctx.uploadFiles({ files: input.files });
  }
  input.value = '';
}

const viewModes: Array<{ mode: ViewMode; icon: unknown; title: string }> = [
  { mode: 'icon', icon: LayoutGrid, title: 'Icon view' },
  { mode: 'list', icon: List, title: 'List view' },
  { mode: 'column', icon: Columns3, title: 'Column view' },
];

async function handleRefresh(): Promise<void> {
  isRefreshing.value = true;
  await ctx.refresh();
  isRefreshing.value = false;
}

async function handleNewFile(): Promise<void> {
  const name = await showPrompt({
    title: 'New File',
    message: 'Enter a name for the new file:',
    confirmButtonText: 'Create',
  });
  if (name) await ctx.createFile({ name });
}

async function handleNewFolder(): Promise<void> {
  const name = await showPrompt({
    title: 'New Folder',
    message: 'Enter a name for the new folder:',
    confirmButtonText: 'Create',
  });
  if (name) await ctx.createFolder({ name });
}

function toggleSearch(): void {
  isSearchOpen.value = !isSearchOpen.value;
  if (!isSearchOpen.value) {
    ctx.setFilterQuery({ query: '' });
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex flex-col border-b border-gray-100 dark:border-gray-800 shrink-0">
    <!-- Main toolbar row -->
    <div class="flex items-center gap-2 px-3 py-2">
      <FileExplorerBreadcrumbs />

      <!-- View mode toggles -->
      <div class="flex items-center border border-gray-100 dark:border-gray-700 rounded-lg overflow-hidden shrink-0">
        <button
          v-for="v in viewModes"
          :key="v.mode"
          :title="v.title"
          :data-testid="`view-${v.mode}`"
          class="p-1.5 transition-colors"
          :class="ctx.viewMode === v.mode
            ? 'bg-blue-500 text-white'
            : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'"
          @click="ctx.setViewMode({ mode: v.mode })"
        >
          <component :is="v.icon" class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Action buttons -->
      <button
        :title="ctx.previewState.visibility === 'visible' ? 'Hide preview' : 'Show preview'"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.previewState.visibility === 'visible'
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="ctx.togglePreviewVisibility()"
      >
        <component :is="ctx.previewState.visibility === 'visible' ? Eye : EyeOff" class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.isLocked ? 'Locked — click to unlock' : 'Unlocked — click to lock'"
        data-testid="lock-toggle"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.isLocked
          ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="ctx.toggleLock()"
      >
        <component :is="ctx.isLocked ? Lock : LockOpen" class="w-3.5 h-3.5" />
      </button>

      <button
        title="Search"
        data-testid="search-toggle"
        class="p-1.5 rounded-lg transition-colors"
        :class="isSearchOpen
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="toggleSearch"
      >
        <Search class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.readOnly ? 'Upload Files (unlock to enable)' : 'Upload Files'"
        data-testid="upload-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleUploadClick()"
      >
        <Upload class="w-3.5 h-3.5" />
      </button>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="hidden"
        data-testid="upload-input"
        @change="handleFileInputChange"
      />

      <button
        :title="ctx.readOnly ? 'New File (unlock to enable)' : 'New File'"
        data-testid="new-file-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleNewFile()"
      >
        <FilePlus class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.readOnly ? 'New Folder (unlock to enable)' : 'New Folder'"
        data-testid="new-folder-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleNewFolder()"
      >
        <FolderPlus class="w-3.5 h-3.5" />
      </button>

      <button
        title="Refresh"
        class="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="isRefreshing ? 'animate-spin' : ''"
        @click="handleRefresh"
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Search bar -->
    <div v-if="isSearchOpen" class="flex items-center gap-2 px-3 pb-2">
      <Search class="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <input
        :value="ctx.filterQuery"
        type="text"
        placeholder="Filter by name..."
        class="flex-1 text-xs bg-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
        data-testid="filter-input"
        @input="ctx.setFilterQuery({ query: ($event.target as HTMLInputElement).value })"
      />
      <button
        v-if="ctx.filterQuery"
        class="p-0.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
        @click="ctx.setFilterQuery({ query: '' })"
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
