<script setup lang="ts">
import { FileTextIcon } from 'lucide-vue-next';
import { useTemplateRef } from 'vue';
import { lazyStrings } from '@/strings';
import type { FileExplorerEntry, FileExplorerTreeMenuEvent } from '@/features/file-explorer/logic/types';
import { formatDate, formatSize } from '@/features/file-explorer/logic/utils';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import { useFileExplorerPaneWidth } from '@/features/file-explorer/composables/useFileExplorerPaneWidth';
import FileExplorerFileTree from './FileExplorerFileTree.vue';
import FileExplorerPaneResizeHandle from './FileExplorerPaneResizeHandle.vue';

defineProps<{
  entry: FileExplorerEntry | undefined,
  directoryPath: string,
  readDirectory: ({ path }: { path: string }) => ReturnType<FileExplorerWorkerClient['readDirectory']>,
  treeVisible: boolean,
  treeId: string,
  informationVisible: boolean,
  informationId: string,
  directoryRevision: number,
}>();

const emit = defineEmits<{
  open: [payload: { entry: FileExplorerEntry }],
  'entry-contextmenu': [payload: FileExplorerTreeMenuEvent],
}>();

const treePanel = useTemplateRef<HTMLElement>('treePanel');
const fileTree = useTemplateRef<InstanceType<typeof FileExplorerFileTree>>('fileTree');
const treeSize = useFileExplorerPaneWidth({ panel: treePanel, preference: 'treeWidthPx' });

function revealDirectory({ path, archive = false }: { path: string, archive?: boolean }): void {
  fileTree.value?.revealDirectory({ path, archive });
}

defineExpose({ revealDirectory, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="file-explorer-file-view" tw-class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sm:flex-row">
    <aside
      v-show="treeVisible"
      :inert="!treeVisible"
      :aria-label="lazyStrings.fileExplorer__file_tree()"
      :style="{ '--tree-width': treeSize.width.value + 'px' }"
      ref="treePanel"
      data-testid="file-explorer-tree-pane"
      tw-class="relative flex max-h-40 shrink-0 flex-col overflow-hidden border-b border-gray-100 sm:max-h-none sm:w-[var(--tree-width)] sm:border-r sm:border-b-0 dark:border-gray-800"
    >
      <div :id="treeId" tw-class="min-h-0 flex-1 overflow-auto overscroll-contain">
        <FileExplorerFileTree
          ref="fileTree"
          :active="treeVisible"
          :active-path="entry?.path"
          :directory-path="directoryPath"
          :read-directory="readDirectory"
          :directory-revision="directoryRevision"
          @open="emit('open', $event)"
          @entry-contextmenu="emit('entry-contextmenu', $event)"
        />
      </div>
      <FileExplorerPaneResizeHandle
        edge="right"
        :controls="treeId"
        :label="lazyStrings.FileExplorerFileView__resize_tree()"
        :resize="treeSize"
        wide-only
        data-testid="tree-resize-handle"
      />
    </aside>

    <div data-testid="file-explorer-file-view-content" tw-class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <slot>
        <div tw-class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-gray-400 dark:text-gray-500">
          <FileTextIcon aria-hidden="true" tw-class="h-8 w-8" />
          <span tw-class="text-xs">{{ lazyStrings.fileExplorer__select_a_file() }}</span>
        </div>
      </slot>
    </div>

    <aside
      v-show="informationVisible && entry !== undefined"
      :id="informationId"
      :aria-label="lazyStrings.fileExplorer__file_information()"
      data-testid="file-explorer-file-information"
      tw-class="max-h-40 shrink-0 overflow-auto overscroll-contain border-t border-gray-100 bg-gray-50/30 sm:max-h-none sm:w-56 sm:border-t-0 sm:border-l lg:w-72 dark:border-gray-800 dark:bg-black/20"
    >
      <template v-if="entry">
        <h2 tw-class="border-b border-gray-100 px-3 py-2 text-xs font-bold text-gray-700 dark:border-gray-800 dark:text-gray-300">{{ lazyStrings.fileExplorer__file_information() }}</h2>
        <dl tw-class="grid grid-cols-2 gap-x-2 gap-y-1 px-3 py-2 text-xs">
          <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__type() }}</dt>
          <dd tw-class="break-words">{{ entry.extension || lazyStrings.fileExplorer__file() }}</dd>
          <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__size() }}</dt>
          <dd>{{ formatSize({ bytes: entry.size }) }}</dd>
          <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.fileExplorer__modified() }}</dt>
          <dd>{{ formatDate({ timestamp: entry.lastModified }) }}</dd>
        </dl>
        <p v-if="entry.readOnly" tw-class="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400">
          {{ lazyStrings.fileExplorer__read_only() }}
        </p>
      </template>
    </aside>
  </div>
</template>
