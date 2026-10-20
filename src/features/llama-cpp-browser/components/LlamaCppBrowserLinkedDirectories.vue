<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { FolderPlusIcon } from 'lucide-vue-next';
import { hostModelDirectoryLabel } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';

const props = defineProps<{ view: HostModelDirectoriesView, disabled: boolean, layoutFile?: { repository: string, path: string } }>();
const { supported, entries, busy, destination } = props.view;
const unavailableReason = computed(() => lazyStrings.LlamaCppBrowserDownloadDestination__linked_folders_unavailable({ apis: missingHostModelDirectoryApis().join(', ') }));
const layout = computed(() => {
  const root = entries.value.find(entry => entry.id === destination.value);
  const segments = props.layoutFile
    ? [...props.layoutFile.repository.split('/'), ...props.layoutFile.path.split('/')]
    : ['owner', 'repository', 'subdir', 'model.gguf'];
  return `${root?.name ?? 'root'}/\n${segments.map((segment, index) => `${'   '.repeat(index)}└─ ${segment}${index < segments.length - 1 ? '/' : ''}`).join('\n')}`;
});
const dropping = ref(false);
const dropError = ref<'folder-only' | 'choose-folder'>();
const lifetime = new AbortController();
onUnmounted(() => lifetime.abort());

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = props.disabled || busy.value || dropping.value || !supported.value ? 'none' : 'link';
  }
}

async function dropDirectory({ event }: { event: DragEvent }): Promise<void> {
  if (props.disabled || busy.value || dropping.value || !supported.value || lifetime.signal.aborted) {
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
    if (lifetime.signal.aborted) {
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
  <div data-testid="llama-linked-folders-panel" @dragover.prevent.stop="dragOver({ event: $event })" @drop.prevent.stop="dropDirectory({ event: $event })" tw-class="mt-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 space-y-3 max-w-xl">
    <p v-if="dropError" role="alert" data-testid="llama-link-drop-error" tw-class="text-xs text-red-600 dark:text-red-400">{{ dropError === 'folder-only' ? lazyStrings.LlamaCppBrowserLinkedDirectories__choose_one_parent_folder_not_a_file() : lazyStrings.LlamaCppBrowserLinkedDirectories__use_the_folder_button_to_link_this_folder() }}</p>
    <p v-if="!supported" data-testid="llama-host-folders-unavailable" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ unavailableReason }}</p>
    <p v-else-if="!entries.length" data-testid="llama-host-folders-unconfigured" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__link_folder_to_download() }}</p>
    <button type="button" :disabled="disabled || busy || dropping || !supported" @click="view.add()" data-testid="llama-add-model-directory" tw-class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"><FolderPlusIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />{{ lazyStrings.LlamaCppBrowserDownloadDestination__link_folder() }}</button>
    <div data-testid="llama-host-folder-layout" tw-class="space-y-1">
      <p tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__choose_folder_above_owner() }}</p>
      <pre tw-class="overflow-x-auto text-[11px] text-gray-500 dark:text-gray-400">{{ layout }}</pre>
    </div>
    <template v-if="entries.length">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__unlink_keeps_files() }}</p>
      <ul tw-class="divide-y divide-gray-100 dark:divide-gray-800">
        <li v-for="entry in entries" :key="entry.id" :data-testid="'llama-model-directory-' + entry.id" tw-class="flex flex-wrap items-center gap-2 py-2 text-xs text-gray-600 dark:text-gray-300">
          <div tw-class="min-w-0 flex-1">
            <span tw-class="block break-all font-medium">{{ hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries }) }}</span>
            <span :data-testid="'llama-host-folder-permission-' + entry.id" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__folder_access({ access: entry.access }) }}</span>
            <p v-if="entry.error" tw-class="break-words text-[11px] text-red-600 dark:text-red-400">{{ entry.error }}</p>
          </div>
          <button type="button" :disabled="disabled || busy || dropping || !supported" @click="view.reconnect({ id: entry.id })" :data-testid="'llama-reconnect-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium text-blue-600 dark:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.LlamaCppBrowserDownloadDestination__reconnect() }}</button>
          <button type="button" :disabled="disabled || busy || dropping || !supported" @click="view.remove({ id: entry.id })" :data-testid="'llama-unregister-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.LlamaCppBrowserDownloadDestination__unlink() }}</button>
        </li>
      </ul>
    </template>
  </div>
</template>
