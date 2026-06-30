<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { ChevronRightIcon, FolderIcon } from 'lucide-vue-next';

import { lazyStrings } from '@/strings';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type {
  FileExplorerEntry,
  FileExplorerListEntryAppearance,
} from '@/features/file-explorer/logic/types';
import type {
  FileExplorerZipUploadPreviewAction,
  FileExplorerZipUploadPreviewEntry,
} from '@/features/file-explorer/worker/types';
import { formatSize } from '@/features/file-explorer/logic/utils';
import { LIST_ROW_HEIGHT, VIRTUAL_SCROLL_OVERSCAN } from '@/features/file-explorer/logic/constants';
import { useVirtualizedFileExplorerList } from '@/features/file-explorer/composables/useVirtualizedFileExplorerList';
import FileExplorerListEntryRow from './FileExplorerListEntryRow.vue';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const state = computed(() => ctx.upload.state);
const scrollContainerRef = ref<HTMLElement | undefined>(undefined);
const previewEntriesForVirtualization = computed(() =>
  state.value.previewEntries.map(previewEntry => toEntry({ entry: previewEntry })),
);
const {
  startIndex,
  endIndex,
  topSpacerHeight,
  bottomSpacerHeight,
} = useVirtualizedFileExplorerList({
  containerRef: scrollContainerRef,
  entries: previewEntriesForVirtualization,
  rowHeight: LIST_ROW_HEIGHT,
  overscan: VIRTUAL_SCROLL_OVERSCAN,
});
const visiblePreviewEntries = computed(() =>
  state.value.previewEntries.slice(startIndex.value, endIndex.value),
);

watch(
  () => state.value.previewRelativePath,
  () => {
    if (scrollContainerRef.value !== undefined) {
      scrollContainerRef.value.scrollTop = 0;
    }
  },
  { flush: 'post' },
);

function toEntry({ entry }: { entry: FileExplorerZipUploadPreviewEntry }): FileExplorerEntry {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    lastModified: entry.lastModified,
    extension: entry.extension,
    mimeCategory: entry.mimeCategory,
    readOnly: false,
    canNavigate: entry.canNavigate,
    canMutate: false,
  };
}

function getAppearance({ action }: { action: FileExplorerZipUploadPreviewAction }): FileExplorerListEntryAppearance {
  switch (action) {
  case 'existing':
    return 'default';
  case 'add':
  case 'merge':
    return 'planned';
  case 'replace':
    return 'warning';
  case 'blocked':
    return 'blocked';
  default: {
    const _exhaustiveCheck: never = action;
    throw new Error(`Unhandled ZIP preview action: ${String(_exhaustiveCheck)}`);
  }
  }
}

function getActionLabel({ action }: { action: FileExplorerZipUploadPreviewAction }): string | undefined {
  switch (action) {
  case 'existing':
    return lazyStrings.fileExplorer__existing();
  case 'add':
    return lazyStrings.fileExplorer__planned_addition();
  case 'merge':
    return lazyStrings.fileExplorer__planned_merge();
  case 'replace':
    return lazyStrings.fileExplorer__planned_overwrite();
  case 'blocked':
    return lazyStrings.fileExplorer__cannot_be_placed();
  default: {
    const _exhaustiveCheck: never = action;
    throw new Error(`Unhandled ZIP preview action: ${String(_exhaustiveCheck)}`);
  }
  }
}

function getActionBadgeClasses({ action }: { action: FileExplorerZipUploadPreviewAction }): string {
  switch (action) {
  case 'existing':
    return 'text-gray-500 bg-gray-100 dark:bg-gray-800';
  case 'add':
  case 'merge':
    return 'text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40';
  case 'replace':
    return 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40';
  case 'blocked':
    return 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40';
  default: {
    const _exhaustiveCheck: never = action;
    throw new Error(`Unhandled ZIP preview action: ${String(_exhaustiveCheck)}`);
  }
  }
}

async function openEntry({ entry }: { entry: FileExplorerZipUploadPreviewEntry }): Promise<void> {
  if (!entry.canNavigate) {
    return;
  }
  await ctx.upload.navigatePreview({ relativePath: entry.path });
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {})
});
</script>

<template>
  <section class="min-w-0 flex flex-col bg-white dark:bg-gray-900" data-testid="zip-upload-preview">
    <header class="flex items-center justify-between gap-3 min-h-[52px] px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
      <h3 class="text-xs font-bold text-gray-800 dark:text-gray-200">
        {{ lazyStrings.fileExplorer__placement_preview() }}
      </h3>
      <span class="px-2 py-1 text-[9px] font-bold text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 rounded-full">
        {{ lazyStrings.fileExplorer__not_changed_yet() }}
      </span>
    </header>

    <nav class="flex items-center gap-1.5 min-h-10 px-3 py-1.5 bg-gray-50 dark:bg-gray-950/30 border-b border-gray-200 dark:border-gray-700 text-[10px] font-mono text-gray-500">
      <button
        type="button"
        class="inline-flex items-center gap-1 hover:text-blue-500"
        data-testid="zip-preview-root"
        @click="ctx.upload.navigatePreview({ relativePath: '' })"
      >
        <FolderIcon class="w-3.5 h-3.5 text-yellow-500" />
        {{ state.targetDirectoryPath }}
      </button>
      <template v-for="segment in state.previewPathSegments" :key="segment.relativePath">
        <ChevronRightIcon class="w-3 h-3 text-gray-400" />
        <button
          type="button"
          class="hover:text-blue-500 truncate"
          @click="ctx.upload.navigatePreview({ relativePath: segment.relativePath })"
        >
          {{ segment.name }}
        </button>
      </template>
    </nav>

    <div class="grid grid-cols-[minmax(150px,1fr)_64px_104px] items-center gap-2 min-h-[29px] px-3 text-[9px] font-bold uppercase tracking-wide text-gray-400 bg-gray-50 dark:bg-gray-950/30 border-b border-gray-200 dark:border-gray-700">
      <span>{{ lazyStrings.fileExplorer__name() }}</span>
      <span class="text-right">{{ lazyStrings.fileExplorer__size() }}</span>
      <span class="text-right">{{ lazyStrings.fileExplorer__status() }}</span>
    </div>

    <div ref="scrollContainerRef" class="min-h-[230px] flex-1 overflow-y-auto p-1.5">
      <div v-if="topSpacerHeight > 0" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true" />
      <FileExplorerListEntryRow
        v-for="previewEntry in visiblePreviewEntries"
        :key="`${previewEntry.path}:${previewEntry.action}`"
        :entry="toEntry({ entry: previewEntry })"
        :appearance="getAppearance({ action: previewEntry.action })"
        class="cursor-default"
        :class="previewEntry.canNavigate ? 'cursor-pointer' : ''"
        :data-testid="`zip-preview-entry-${previewEntry.name}`"
        @dblclick="openEntry({ entry: previewEntry })"
      >
        <template #trailing>
          <span class="text-[10px] font-mono w-16 text-right text-gray-400 dark:text-gray-500">
            {{ previewEntry.kind === 'file' ? formatSize({ bytes: previewEntry.size }) : '' }}
          </span>
          <span
            class="justify-self-end px-2 py-1 text-[8px] font-bold rounded-full whitespace-nowrap"
            :class="getActionBadgeClasses({ action: previewEntry.action })"
          >
            {{ getActionLabel({ action: previewEntry.action }) }}
          </span>
        </template>
      </FileExplorerListEntryRow>
      <div v-if="bottomSpacerHeight > 0" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true" />
    </div>

    <footer class="flex items-center flex-wrap gap-1.5 min-h-11 px-3 py-2 bg-gray-50 dark:bg-gray-950/30 border-t border-gray-200 dark:border-gray-700">
      <span v-if="state.previewSummary.addedCount > 0" class="px-2 py-1 text-[9px] font-bold text-blue-600 bg-blue-50 dark:bg-blue-950/40 rounded-full">
        {{ lazyStrings.fileExplorer__addition_count({ count: state.previewSummary.addedCount }) }}
      </span>
      <span v-if="state.previewSummary.mergedCount > 0" class="px-2 py-1 text-[9px] font-bold text-blue-600 bg-blue-50 dark:bg-blue-950/40 rounded-full">
        {{ lazyStrings.fileExplorer__merge_count({ count: state.previewSummary.mergedCount }) }}
      </span>
      <span v-if="state.previewSummary.replacedCount > 0" class="px-2 py-1 text-[9px] font-bold text-amber-700 bg-amber-50 dark:bg-amber-950/40 rounded-full">
        {{ lazyStrings.fileExplorer__overwrite_count({ count: state.previewSummary.replacedCount }) }}
      </span>
      <span v-if="state.previewSummary.blockedCount > 0" class="px-2 py-1 text-[9px] font-bold text-red-700 bg-red-50 dark:bg-red-950/40 rounded-full">
        {{ lazyStrings.fileExplorer__blocked_count({ count: state.previewSummary.blockedCount }) }}
      </span>
    </footer>
  </section>
</template>
