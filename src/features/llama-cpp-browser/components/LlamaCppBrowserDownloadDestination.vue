<script setup lang="ts">
import { computed, useId } from 'vue';
import { FolderPlusIcon } from 'lucide-vue-next';
import { hostModelDirectoryLabel } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';

const props = defineProps<{
  view: HostModelDirectoriesView,
  disabled: boolean,
  layoutFile?: { repository: string, path: string },
}>();
const id = useId();
const missingApis = computed(() => [
  ...(typeof window === 'undefined' || typeof Reflect.get(window, 'showDirectoryPicker') !== 'function' ? ['showDirectoryPicker'] : []),
  ...(typeof indexedDB === 'undefined' ? ['IndexedDB'] : []),
  ...(typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function' ? ['Web Locks'] : []),
]);
const { supported, entries, busy, destination } = props.view;
const unavailableReason = computed(() => !supported.value ? lazyStrings.LlamaCppBrowserDownloadDestination__linked_folders_unavailable({ apis: missingApis.value.join(', ') }) : undefined);
const destinationKind = computed(() => props.view.destinationKind?.value ?? (destination.value === 'opfs' ? 'opfs' : 'host'));

function hostChoiceValue({ id }: { id: string }): string {
  return `host:${id}`;
}

const selectedValue = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return 'opfs';
  case 'host': return hostChoiceValue({ id: destination.value });
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
});
const selected = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return undefined;
  case 'host': return entries.value.find(entry => entry.id === destination.value);
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
});
const missingDestination = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return false;
  case 'host': return selected.value === undefined;
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
});
const layout = computed(() => {
  const root = selected.value;
  const segments = props.layoutFile
    ? [...props.layoutFile.repository.split('/'), ...props.layoutFile.path.split('/')]
    : ['owner', 'repository', 'subdir', 'model.gguf'];
  return `${root?.name ?? 'root'}/\n${segments.map((segment, index) => `${'   '.repeat(index)}└─ ${segment}${index < segments.length - 1 ? '/' : ''}`).join('\n')}`;
});

function selectDestination({ event }: { event: Event }): void {
  if (props.disabled || busy.value || !(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  if (value === 'opfs') {
    props.view.selectDestination({ id: 'opfs', kind: 'opfs' }); return;
  }
  const entry = entries.value.find(entry => hostChoiceValue({ id: entry.id }) === value);
  if (entry) props.view.selectDestination({ id: entry.id, kind: 'host' });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="llama-host-model-directories" tw-class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    <label :for="id + '-destination'" tw-class="font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__download_to() }}</label>
    <select :id="id + '-destination'" :value="selectedValue" :disabled="disabled || busy" :title="unavailableReason" @change="selectDestination({ event: $event })" data-testid="llama-download-destination" tw-class="min-w-0 max-w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
      <option v-if="missingDestination" :value="selectedValue" disabled data-testid="llama-missing-download-destination">{{ lazyStrings.LlamaCppBrowserDownloadDestination__linked_folder() }} ({{ destination }}) · {{ lazyStrings.LlamaCppBrowserDownloadDestination__folder_access({ access: 'missing' }) }}</option>
      <option value="opfs">{{ lazyStrings.LlamaCppBrowserDownloadDestination__browser_storage() }}</option>
      <option v-if="!entries.length" value="" disabled>{{ lazyStrings.LlamaCppBrowserDownloadDestination__linked_folder() }} · {{ supported ? lazyStrings.LlamaCppBrowserDownloadDestination__not_linked() : lazyStrings.LlamaCppBrowserDownloadDestination__unavailable() }}</option>
      <option v-for="entry in entries" :key="entry.id" :value="hostChoiceValue({ id: entry.id })" :disabled="!supported || ['missing', 'error', 'unsupported'].includes(entry.access)">{{ hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries }) }}{{ entry.access === 'readwrite' ? '' : ' · ' + lazyStrings.LlamaCppBrowserDownloadDestination__folder_access({ access: entry.access }) }}</option>
    </select>
    <!-- Management stays collapsed so onboarding's first actions remain above the fold. -->
    <details data-testid="llama-model-directory-registrations" tw-class="max-w-full">
      <summary data-testid="llama-manage-model-directories" :title="unavailableReason" tw-class="cursor-pointer text-[11px] font-medium text-blue-600 dark:text-blue-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__link_folder() }}</summary>
      <div tw-class="mt-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 space-y-3 max-w-xl">
        <p v-if="!supported" data-testid="llama-host-folders-unavailable" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ unavailableReason }}</p>
        <p v-else-if="!entries.length" data-testid="llama-host-folders-unconfigured" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__link_folder_to_download() }}</p>
        <button type="button" :disabled="disabled || busy || !supported" @click="view.add()" data-testid="llama-add-model-directory" tw-class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"><FolderPlusIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />{{ lazyStrings.LlamaCppBrowserDownloadDestination__link_folder() }}</button>
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
              <button type="button" :disabled="disabled || busy || !supported" @click="view.reconnect({ id: entry.id })" :data-testid="'llama-reconnect-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium text-blue-600 dark:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.LlamaCppBrowserDownloadDestination__reconnect() }}</button>
              <button type="button" :disabled="disabled || busy || !supported" @click="view.remove({ id: entry.id })" :data-testid="'llama-unregister-model-directory-' + entry.id" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 font-medium disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.LlamaCppBrowserDownloadDestination__unlink() }}</button>
            </li>
          </ul>
        </template>
      </div>
    </details>
  </div>
</template>
