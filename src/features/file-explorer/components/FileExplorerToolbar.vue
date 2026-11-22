<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { computed, inject, ref, useTemplateRef, watch } from 'vue';
import { LayoutGridIcon, ListIcon, Columns3Icon, PanelsTopLeftIcon, ChevronLeftIcon, ChevronRightIcon, InfoIcon, Maximize2Icon, Minimize2Icon, PanelLeftIcon, RefreshCwIcon, SearchIcon, FilePlusIcon, FolderPlusIcon, UploadIcon, EyeIcon, EyeOffIcon, XIcon, LockIcon, LockOpenIcon } from 'lucide-vue-next';
import FileExplorerBreadcrumbs from './FileExplorerBreadcrumbs.vue';
import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { FILE_EXPLORER_FILE_VIEW_KEY } from '@/features/file-explorer/composables/file-explorer-file-view-context';
import { getFileViewParentPath } from '@/features/file-explorer/logic/file-view';
import type { ViewMode } from '@/features/file-explorer/logic/types';
import { usePrompt } from '@/composables/usePrompt';

defineProps<{
  fileTreeVisible?: boolean,
  fileTreeId?: string,
  fileInformationVisible?: boolean,
  fileInformationId?: string,
  editorFocused?: boolean,
  canFocusEditor?: boolean,
}>();
const emit = defineEmits<{ 'toggle-tree': [], 'toggle-information': [], 'toggle-editor-focus': [] }>();

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const fileView = inject(FILE_EXPLORER_FILE_VIEW_KEY, undefined);
const isFileView = computed(() => fileView?.isActive.value === true);
const activeFile = computed(() => fileView?.activeFile.value);
const readOnlyLockSource = computed(() => isFileView.value ? fileView?.canUnlockFiles.value === false : ctx.readOnlyReason === 'source');
const breadcrumbScroller = useTemplateRef<HTMLElement>('breadcrumbScroller');
const fileBreadcrumbs = computed(() => {
  const entry = activeFile.value;
  const path = entry === undefined ? ctx.currentDirectoryPath : getFileViewParentPath({ path: entry.path });
  const segments = [{ name: ctx.pathSegments[0]?.name ?? '/', path: '/' }];
  let current = '';
  for (const name of path.split('/').filter(Boolean)) {
    current += `/${name}`;
    segments.push({ name, path: current });
  }
  return segments;
});

watch([breadcrumbScroller, () => activeFile.value?.path ?? ctx.currentDirectoryPath], ([element]) => {
  if (element) {
    element.scrollLeft = element.scrollWidth;
  }
}, { flush: 'post' });

function selectBrowserView({ mode }: { mode: ViewMode }): void {
  if (fileView) {
    void fileView.showBrowser({ mode, restoreFocus: false });
  } else {
    ctx.setViewMode({ mode });
  }
}

const { showPrompt } = usePrompt();

const isSearchOpen = ref(false);
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
  if (iconView === undefined || listView === undefined || columnView === undefined) {
    return [];
  }

  return [
    { mode: 'icon', icon: LayoutGridIcon, title: iconView },
    { mode: 'list', icon: ListIcon, title: listView },
    { mode: 'column', icon: Columns3Icon, title: columnView },
  ];
});

async function handleNewFolder(): Promise<void> {
  const name = await showPrompt({
    title: await ensureStrings.fileExplorer__new_folder(),
    message: await ensureStrings.fileExplorer__enter_a_name_for_the_new_folder(),
    confirmButtonText: await ensureStrings.fileExplorer__create(),
  });
  if (name) {
    await ctx.createFolder({ name });
  }
}

function toggleSearch(): void {
  isSearchOpen.value = !isSearchOpen.value;
  if (!isSearchOpen.value) {
    ctx.setFilterQuery({ query: '' });
  }
}

function readOnlyActionTitle({ unlockedTitle, lockedTitle }: { unlockedTitle: string | undefined, lockedTitle: string | undefined }): string | undefined {
  switch (ctx.readOnlyReason) {
  case 'source':
    return lazyStrings.fileExplorer__read_only();
  case 'lock':
    return lockedTitle;
  case undefined:
    return unlockedTitle;
  default: {
    const _exhaustiveCheck: never = ctx.readOnlyReason;
    throw new Error(`Unhandled read-only reason: ${_exhaustiveCheck}`);
  }
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex flex-col border-b border-gray-100 dark:border-gray-800 shrink-0">
    <!-- Main toolbar row -->
    <div tw-class="flex items-center gap-2 px-3 py-2">
      <FileExplorerBreadcrumbs v-if="!isFileView" />
      <div v-else tw-class="flex min-w-0 flex-1 items-center gap-1">
        <button
          type="button"
          :title="lazyStrings.fileExplorer__go_back()"
          :aria-label="lazyStrings.fileExplorer__go_back()"
          data-testid="file-explorer-file-view-back"
          tw-class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors shrink-0"
          @click="fileView?.showBrowser({ mode: ctx.viewMode, restoreFocus: true })"
        >
          <ChevronLeftIcon aria-hidden="true" tw-class="w-3.5 h-3.5 text-gray-500" />
        </button>
        <div ref="breadcrumbScroller" :title="activeFile?.path ?? ctx.currentDirectoryPath" data-testid="file-view-path" tw-class="flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain scrollbar-thin">
          <template v-for="(segment, index) in fileBreadcrumbs" :key="segment.path">
            <button
              type="button"
              :title="segment.name"
              :data-testid="`file-view-breadcrumb-${index}`"
              tw-class="max-w-[120px] shrink-0 truncate rounded px-1.5 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              @click="fileView?.revealFolder({ path: segment.path })"
            >{{ segment.name }}</button>
            <ChevronRightIcon v-if="index < fileBreadcrumbs.length - 1 || activeFile" aria-hidden="true" tw-class="h-3 w-3 shrink-0 text-gray-300 dark:text-gray-600" />
          </template>
          <template v-if="activeFile">
            <FileExplorerEntryIcon
              aria-hidden="true"
              :kind="activeFile.kind"
              :extension="activeFile.extension"
              :mime-category="activeFile.mimeCategory"
              size="sm"
            />
            <span aria-current="page" tw-class="max-w-48 shrink-0 truncate text-[11px] font-bold text-gray-800 dark:text-gray-200">{{ activeFile.name }}</span>
          </template>
        </div>
      </div>

      <!-- View mode toggles -->
      <div tw-class="flex items-center border border-gray-100 dark:border-gray-700 rounded-lg overflow-hidden shrink-0">
        <button
          v-for="v in viewModes"
          :key="v.mode"
          type="button"
          :title="v.title"
          :aria-label="v.title"
          :aria-pressed="!isFileView && ctx.viewMode === v.mode"
          :data-testid="`view-${v.mode}`"
          :tw-class="['p-1.5 transition-colors', !isFileView && ctx.viewMode === v.mode
            ? 'bg-blue-500 text-white'
            : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="selectBrowserView({ mode: v.mode })"
        >
          <component :is="v.icon" tw-class="w-3.5 h-3.5" />
        </button>
        <button
          v-if="fileView"
          type="button"
          :title="lazyStrings.fileExplorer__file_view()"
          :aria-label="lazyStrings.fileExplorer__file_view()"
          :aria-pressed="isFileView"
          data-testid="file-view-open-toolbar"
          :tw-class="['p-1.5 transition-colors', isFileView
            ? 'bg-blue-500 text-white'
            : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="fileView.activate()"
        >
          <PanelsTopLeftIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
      </div>

      <template v-if="isFileView">
        <button
          v-if="!editorFocused"
          type="button"
          :title="lazyStrings.fileExplorer__file_tree()"
          :aria-label="lazyStrings.fileExplorer__file_tree()"
          :aria-expanded="fileTreeVisible"
          :aria-controls="fileTreeId"
          data-testid="file-explorer-toggle-file-tree"
          :tw-class="['p-1.5 rounded-lg transition-colors', fileTreeVisible
            ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="emit('toggle-tree')"
        >
          <PanelLeftIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
        <button
          v-if="activeFile && !editorFocused"
          type="button"
          :title="lazyStrings.fileExplorer__file_information()"
          :aria-label="lazyStrings.fileExplorer__file_information()"
          :aria-expanded="fileInformationVisible"
          :aria-controls="fileInformationId"
          data-testid="file-explorer-toggle-file-information"
          :tw-class="['p-1.5 rounded-lg transition-colors', fileInformationVisible
            ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="emit('toggle-information')"
        >
          <InfoIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
        <button
          v-if="canFocusEditor"
          type="button"
          :title="editorFocused ? lazyStrings.fileExplorer__restore_editor_size() : lazyStrings.fileExplorer__maximize_editor()"
          :aria-label="editorFocused ? lazyStrings.fileExplorer__restore_editor_size() : lazyStrings.fileExplorer__maximize_editor()"
          :aria-pressed="editorFocused"
          data-testid="file-explorer-maximize-editor"
          :tw-class="['p-1.5 rounded-lg transition-colors', editorFocused
            ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
          @click="emit('toggle-editor-focus')"
        >
          <component :is="editorFocused ? Minimize2Icon : Maximize2Icon" aria-hidden="true" tw-class="w-3.5 h-3.5" />
        </button>
      </template>

      <!-- Action buttons -->
      <button
        v-if="!isFileView"
        :title="ctx.previewState.visibility === 'visible' ? lazyStrings.fileExplorer__hide_preview() : lazyStrings.fileExplorer__show_preview()"
        :tw-class="['p-1.5 rounded-lg transition-colors', ctx.previewState.visibility === 'visible'
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        @click="ctx.togglePreviewVisibility()"
      >
        <component :is="ctx.previewState.visibility === 'visible' ? EyeIcon : EyeOffIcon" tw-class="w-3.5 h-3.5" />
      </button>

      <button
        :title="readOnlyLockSource ? lazyStrings.fileExplorer__read_only() : (ctx.isLocked ? lazyStrings.fileExplorer__locked_click_to_unlock() : lazyStrings.fileExplorer__unlocked_click_to_lock())"
        data-testid="lock-toggle"
        :tw-class="['p-1.5 rounded-lg transition-colors', readOnlyLockSource
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : ctx.isLocked
            ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20'
            : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        :disabled="readOnlyLockSource"
        @click="!readOnlyLockSource && ctx.toggleLock()"
      >
        <component :is="readOnlyLockSource || ctx.isLocked ? LockIcon : LockOpenIcon" tw-class="w-3.5 h-3.5" />
      </button>

      <button
        v-if="!isFileView"
        :title="lazyStrings.fileExplorer__search()"
        data-testid="search-toggle"
        :tw-class="['p-1.5 rounded-lg transition-colors', isSearchOpen
          ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        @click="toggleSearch"
      >
        <SearchIcon tw-class="w-3.5 h-3.5" />
      </button>

      <button
        v-if="!isFileView && !ctx.isDeletionOnly({ path: ctx.currentDirectoryPath })"
        :title="readOnlyActionTitle({ unlockedTitle: lazyStrings.fileExplorer__upload_files(), lockedTitle: lazyStrings.fileExplorer__upload_files_unlock_to_enable() })"
        data-testid="upload-button"
        :tw-class="['p-1.5 rounded-lg transition-colors', ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleUploadClick()"
      >
        <UploadIcon tw-class="w-3.5 h-3.5" />
      </button>
      <input
        ref="fileInputRef"
        type="file"
        multiple
        tw-class="hidden"
        data-testid="upload-input"
        @change="handleFileInputChange({ event: $event })"
      />

      <button
        v-if="!isFileView && !ctx.isDeletionOnly({ path: ctx.currentDirectoryPath })"
        :title="readOnlyActionTitle({ unlockedTitle: lazyStrings.fileExplorer__new_file(), lockedTitle: lazyStrings.fileExplorer__new_file_unlock_to_enable() })"
        data-testid="new-file-button"
        :tw-class="['p-1.5 rounded-lg transition-colors', ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        :disabled="ctx.readOnly"
        @click="ctx.openNewFile()"
      >
        <FilePlusIcon tw-class="w-3.5 h-3.5" />
      </button>

      <button
        v-if="!isFileView && !ctx.isDeletionOnly({ path: ctx.currentDirectoryPath })"
        :title="readOnlyActionTitle({ unlockedTitle: lazyStrings.fileExplorer__new_folder(), lockedTitle: lazyStrings.fileExplorer__new_folder_unlock_to_enable() })"
        data-testid="new-folder-button"
        :tw-class="['p-1.5 rounded-lg transition-colors', ctx.readOnly
          ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
        :disabled="ctx.readOnly"
        @click="!ctx.readOnly && handleNewFolder()"
      >
        <FolderPlusIcon tw-class="w-3.5 h-3.5" />
      </button>

      <button
        v-if="!isFileView"
        :title="lazyStrings.fileExplorer__refresh()"
        tw-class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        @click="ctx.refresh()"
      >
        <RefreshCwIcon :tw-class="['w-3.5 h-3.5', ctx.isLoading && 'motion-safe:animate-spin']" />
      </button>
    </div>

    <!-- Search bar -->
    <div v-if="!isFileView && isSearchOpen" tw-class="flex items-center gap-2 px-3 pb-2">
      <SearchIcon tw-class="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <input
        :value="ctx.filterQuery"
        type="text"
        :placeholder="lazyStrings.fileExplorer__filter_by_name()"
        tw-class="flex-1 text-xs bg-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400"
        data-testid="filter-input"
        @input="ctx.setFilterQuery({ query: ($event.target as HTMLInputElement).value })"
      />
      <button
        v-if="ctx.filterQuery"
        tw-class="p-0.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
        @click="ctx.setFilterQuery({ query: '' })"
      >
        <XIcon tw-class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
