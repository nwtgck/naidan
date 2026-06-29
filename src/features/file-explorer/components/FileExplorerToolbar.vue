<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, inject, ref } from 'vue';
import { LayoutGridIcon, ListIcon, Columns3Icon, RefreshCwIcon, SearchIcon, FilePlusIcon, FolderPlusIcon, UploadIcon, EyeIcon, EyeOffIcon, XIcon, LockIcon, LockOpenIcon } from 'lucide-vue-next';
import FileExplorerBreadcrumbs from './FileExplorerBreadcrumbs.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type { ViewMode } from '@/features/file-explorer/logic/types';
import { usePrompt } from '@/composables/usePrompt';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const { showPrompt } = usePrompt();

const isSearchOpen = ref(false);
const isRefreshing = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

function handleUploadClick(): void {
  fileInputRef.value?.click();
}

async function handleFileInputChange({ event }: { event: Event }): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await ctx.uploadFiles({ files: input.files });
  }
  input.value = '';
}

type ViewModeOption = { readonly mode: ViewMode, readonly icon: unknown, readonly title: string };

const viewModes = computed<ViewModeOption[]>(() => {
  const iconView = lazyStrings.fileExplorer__icon_view();
  const listView = lazyStrings.fileExplorer__list_view();
  const columnView = lazyStrings.fileExplorer__column_view();
  if (iconView === undefined || listView === undefined || columnView === undefined) return [];

  return [
    { mode: 'icon', icon: LayoutGridIcon, title: iconView },
    { mode: 'list', icon: ListIcon, title: listView },
    { mode: 'column', icon: Columns3Icon, title: columnView },
  ];
});

async function handleRefresh(): Promise<void> {
  isRefreshing.value = true;
  await ctx.refresh();
  isRefreshing.value = false;
}

async function handleNewFile(): Promise<void> {
  const name = await showPrompt({
    title: await ensureStrings.fileExplorer__new_file(),
    message: await ensureStrings.fileExplorer__enter_a_name_for_the_new_file(),
    confirmButtonText: await ensureStrings.fileExplorer__create(),
  });
  if (name) await ctx.createFile({ name });
}

async function handleNewFolder(): Promise<void> {
  const name = await showPrompt({
    title: await ensureStrings.fileExplorer__new_folder(),
    message: await ensureStrings.fileExplorer__enter_a_name_for_the_new_folder(),
    confirmButtonText: await ensureStrings.fileExplorer__create(),
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
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
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
        :title="ctx.previewState.visibility === 'visible' ? lazyStrings.fileExplorer__hide_preview() : lazyStrings.fileExplorer__show_preview()"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.previewState.visibility === 'visible'
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="ctx.togglePreviewVisibility()"
      >
        <component :is="ctx.previewState.visibility === 'visible' ? EyeIcon : EyeOffIcon" class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.isLocked ? lazyStrings.fileExplorer__locked_click_to_unlock() : lazyStrings.fileExplorer__unlocked_click_to_lock()"
        data-testid="lock-toggle"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.isLocked
          ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="ctx.toggleLock()"
      >
        <component :is="ctx.isLocked ? LockIcon : LockOpenIcon" class="w-3.5 h-3.5" />
      </button>

      <button
        :title="lazyStrings.fileExplorer__search()"
        data-testid="search-toggle"
        class="p-1.5 rounded-lg transition-colors"
        :class="isSearchOpen
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        @click="toggleSearch"
      >
        <SearchIcon class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.readOnly ? lazyStrings.fileExplorer__upload_files_unlock_to_enable() : lazyStrings.fileExplorer__upload_files()"
        data-testid="upload-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleUploadClick()"
      >
        <UploadIcon class="w-3.5 h-3.5" />
      </button>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="hidden"
        data-testid="upload-input"
        @change="handleFileInputChange({ event: $event })"
      />

      <button
        :title="ctx.readOnly ? lazyStrings.fileExplorer__new_file_unlock_to_enable() : lazyStrings.fileExplorer__new_file()"
        data-testid="new-file-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleNewFile()"
      >
        <FilePlusIcon class="w-3.5 h-3.5" />
      </button>

      <button
        :title="ctx.readOnly ? lazyStrings.fileExplorer__new_folder_unlock_to_enable() : lazyStrings.fileExplorer__new_folder()"
        data-testid="new-folder-button"
        class="p-1.5 rounded-lg transition-colors"
        :class="ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleNewFolder()"
      >
        <FolderPlusIcon class="w-3.5 h-3.5" />
      </button>

      <button
        :title="lazyStrings.fileExplorer__refresh()"
        class="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="isRefreshing ? 'animate-spin' : ''"
        @click="handleRefresh"
      >
        <RefreshCwIcon class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- Search bar -->
    <div v-if="isSearchOpen" class="flex items-center gap-2 px-3 pb-2">
      <SearchIcon class="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <input
        :value="ctx.filterQuery"
        type="text"
        :placeholder="lazyStrings.fileExplorer__filter_by_name()"
        class="flex-1 text-xs bg-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
        data-testid="filter-input"
        @input="ctx.setFilterQuery({ query: ($event.target as HTMLInputElement).value })"
      />
      <button
        v-if="ctx.filterQuery"
        class="p-0.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
        @click="ctx.setFilterQuery({ query: '' })"
      >
        <XIcon class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
