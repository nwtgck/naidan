<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { FileIcon, FolderIcon, FolderPlusIcon } from 'lucide-vue-next';
import { hostModelDirectoryLabel } from '@/logic/host-model-directories';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';

const props = defineProps<{ view: HostModelDirectoriesView, disabled: boolean, reconnectDisabled?: boolean, layoutFile?: { repository: string, path: string } }>();
const { supported, entries, busy, destination } = props.view;
const unavailableReason = computed(() => lazyStrings.SHARED__model_folders_linked_folders_unavailable());
const layout = computed(() => {
  const root = entries.value.find(entry => entry.id === destination.value);
  const segments = props.layoutFile
    ? [...props.layoutFile.repository.split('/'), ...props.layoutFile.path.split('/')]
    : ['owner', 'repository', 'subdir', 'model.gguf'];
  return [
    { name: root?.name ?? 'root', kind: 'folder' as const },
    ...segments.map((name, index) => ({ name, kind: index < segments.length - 1 ? 'folder' as const : 'file' as const })),
  ];
});
const dropping = ref(false);
const dropError = ref<'folder-only' | 'choose-folder'>();
const lifetime = new AbortController();
onUnmounted(() => lifetime.abort());

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = props.disabled || props.reconnectDisabled || busy.value || dropping.value || !supported.value ? 'none' : 'link';
  }
}

async function dropDirectory({ event }: { event: DragEvent }): Promise<void> {
  if (props.disabled || props.reconnectDisabled || busy.value || dropping.value || !supported.value || lifetime.signal.aborted) {
    return;
  }
  const items = Array.from(event.dataTransfer?.items ?? []).filter(item => item.kind === 'file');
  if (items.length !== 1) {
    dropError.value = 'folder-only';
    return;
  }
  const item = items[0]! as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
  if (!item.getAsFileSystemHandle || !props.view.addDroppedDirectory) {
    dropError.value = 'choose-folder';
    return;
  }
  dropping.value = true;
  dropError.value = undefined;
  try {
    // Capture the durable handle during the drop dispatch, before the first
    // await. A File/legacy entry cannot be substituted for a persistent link.
    const handle = await item.getAsFileSystemHandle();
    // A download/editor operation may start while the browser obtains the
    // handle. Recheck admission after awaiting it, without registering late.
    if (lifetime.signal.aborted || props.disabled || props.reconnectDisabled || busy.value || !supported.value) {
      return;
    }
    if (!handle) {
      dropError.value = 'choose-folder';
      return;
    }
    const kind = handle.kind;
    switch (kind) {
    case 'file':
      dropError.value = 'folder-only';
      return;
    case 'directory':
      await props.view.addDroppedDirectory({ directory: handle as FileSystemDirectoryHandle, signal: lifetime.signal });
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  } catch {
    if (!lifetime.signal.aborted) {
      dropError.value = 'choose-folder';
    }
  } finally {
    dropping.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="linked-linked-folders-panel" @dragover.prevent.stop="dragOver({ event: $event })" @drop.prevent.stop="dropDirectory({ event: $event })" tw-class="mt-2 w-full max-w-xl space-y-4 rounded-xl border border-gray-200 bg-white p-4 text-left dark:border-gray-700 dark:bg-gray-900">
    <p v-if="dropError" role="alert" data-testid="linked-link-drop-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ dropError === 'folder-only' ? lazyStrings.SHARED__model_folders_choose_one_parent_folder_not_a_file() : lazyStrings.SHARED__model_folders_use_the_folder_button_to_link_this_folder() }}</p>
    <p v-if="!supported" data-testid="linked-host-folders-unavailable" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ unavailableReason }}</p>
    <p v-else data-testid="linked-host-folders-description" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.SHARED__model_folders_use_models_directly_from_your_device() }}</p>
    <LlamaCppBrowserModelActionButton :disabled="disabled || reconnectDisabled || busy || dropping || !supported" size="regular" @click="view.add()" data-testid="linked-add-model-directory"><FolderPlusIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.SHARED__model_import_link_folder() }}</LlamaCppBrowserModelActionButton>
    <div data-testid="linked-host-folder-layout" tw-class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] items-start gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
      <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.SHARED__model_folders_choose_folder_above_owner() }}</p>
      <ol tw-class="min-w-0 rounded-lg bg-gray-50 px-3 py-2.5 text-[11px] dark:bg-gray-800/50">
        <li v-for="(item, index) in layout" :key="index" class="folder-layout-item" :style="{ '--folder-depth': index }" tw-class="relative flex h-5 min-w-0 items-center gap-1.5">
          <span v-if="index > 0" aria-hidden="true" class="folder-layout-branch" tw-class="pointer-events-none absolute -top-1 h-3.5 w-1.5 rounded-es-sm border-s border-b border-gray-200 dark:border-gray-700" />
          <FolderIcon v-if="item.kind === 'folder'" aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0', index === 0 ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500']" />
          <FileIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
          <span :title="item.name" :tw-class="['min-w-0 truncate', item.kind === 'file' || index === 0 ? 'font-medium text-gray-600 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400']">{{ item.name }}{{ item.kind === 'folder' ? '/' : '' }}</span>
        </li>
      </ol>
    </div>
    <template v-if="entries.length">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.SHARED__model_folders_unlink_keeps_files() }}</p>
      <ul tw-class="divide-y divide-gray-100 text-left dark:divide-gray-800">
        <li v-for="entry in entries" :key="entry.id" :data-testid="'linked-model-directory-' + entry.id" tw-class="flex flex-wrap items-center gap-2 py-2 text-xs text-gray-600 dark:text-gray-300">
          <div tw-class="min-w-0 flex-1">
            <span tw-class="block break-all font-medium">{{ hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries }) }}</span>
            <span :data-testid="'linked-host-folder-permission-' + entry.id" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.SHARED__model_folders_folder_access({ access: entry.access }) }}</span>
            <p v-if="entry.error" tw-class="break-words text-[11px] text-red-600 dark:text-red-400">{{ entry.error }}</p>
          </div>
          <button type="button" :disabled="disabled || reconnectDisabled || busy || dropping || !supported" @click="view.reconnect({ id: entry.id })" :data-testid="'linked-reconnect-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium text-blue-600 dark:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.SHARED__model_folders_reconnect() }}</button>
          <button type="button" :disabled="disabled || busy || dropping || !supported" @click="view.remove({ id: entry.id })" :data-testid="'linked-unregister-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.SHARED__model_folders_unlink() }}</button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.folder-layout-item {
  padding-inline-start: calc(var(--folder-depth) * 1rem);
}
.folder-layout-branch {
  inset-inline-start: calc((var(--folder-depth) - 1) * 1rem + 0.4375rem);
}
</style>
