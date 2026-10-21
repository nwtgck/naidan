<script setup lang="ts">
import { computed, useId } from 'vue';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import { hostModelDirectoryLabel } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';

const props = defineProps<{
  view: HostModelDirectoriesView,
  disabled: boolean,
  management?: 'inline' | 'hidden',
  layoutFile?: { repository: string, path: string },
}>();
const id = useId();
const missingApis = computed(() => missingHostModelDirectoryApis());
const { supported, entries, busy, destination } = props.view;
const unavailableReason = computed(() => !supported.value ? lazyStrings.SHARED__model_folders_linked_folders_unavailable({ apis: missingApis.value.join(', ') }) : undefined);
const destinationKind = computed(() => props.view.destinationKind?.value ?? (destination.value === 'opfs' ? 'opfs' : 'host'));

function hostChoiceValue({ id }: { id: string }): string {
  return `host:${id}`;
}

const selectedValue = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return 'opfs';
  case 'host': return hostChoiceValue({ id: destination.value });
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
});
const selected = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return undefined;
  case 'host': return entries.value.find(entry => entry.id === destination.value);
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
});
const missingDestination = computed(() => {
  const kind = destinationKind.value;
  switch (kind) {
  case 'opfs': return false;
  case 'host': return selected.value === undefined;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
});

function selectDestination({ event }: { event: Event }): void {
  if (props.disabled || busy.value || !(event.target instanceof HTMLSelectElement)) {
    return;
  }
  const value = event.target.value;
  if (value === 'opfs') {
    props.view.selectDestination({ id: 'opfs', kind: 'opfs' });
    return;
  }
  const entry = entries.value.find(entry => hostChoiceValue({ id: entry.id }) === value);
  if (entry) {
    props.view.selectDestination({ id: entry.id, kind: 'host' });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="llama-host-model-directories" tw-class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    <label :for="id + '-destination'" tw-class="font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__download_to() }}</label>
    <select :id="id + '-destination'" :value="selectedValue" :disabled="disabled || busy" :title="unavailableReason" @change="selectDestination({ event: $event })" data-testid="llama-download-destination" tw-class="min-w-0 max-w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
      <option v-if="missingDestination" :value="selectedValue" disabled data-testid="llama-missing-download-destination">{{ lazyStrings.LlamaCppBrowserDownloadDestination__linked_folder() }} ({{ destination }}) · {{ lazyStrings.SHARED__model_folders_folder_access({ access: 'missing' }) }}</option>
      <option value="opfs">{{ lazyStrings.LlamaCppBrowserDownloadDestination__browser_storage() }}</option>
      <option v-if="!entries.length" value="" disabled>{{ lazyStrings.LlamaCppBrowserDownloadDestination__linked_folder() }} · {{ supported ? lazyStrings.LlamaCppBrowserDownloadDestination__not_linked() : lazyStrings.SHARED__model_import_unavailable() }}</option>
      <option v-for="entry in entries" :key="entry.id" :value="hostChoiceValue({ id: entry.id })" :disabled="!supported || ['missing', 'error', 'unsupported'].includes(entry.access)">{{ hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries }) }}{{ entry.access === 'readwrite' ? '' : ' · ' + lazyStrings.SHARED__model_folders_folder_access({ access: entry.access }) }}</option>
    </select>
    <!-- Management stays collapsed so onboarding's first actions remain above the fold. -->
    <details v-if="management !== 'hidden'" data-testid="llama-model-directory-registrations" tw-class="max-w-full">
      <summary data-testid="llama-manage-model-directories" :title="unavailableReason" tw-class="cursor-pointer text-[11px] font-medium text-blue-600 dark:text-blue-400">{{ lazyStrings.SHARED__model_import_link_folder() }}</summary>
      <LinkedModelDirectories :view="view" :disabled="disabled" :layout-file="layoutFile" />
    </details>
  </div>
</template>
