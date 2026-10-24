<script setup lang="ts">
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { computed, useId } from 'vue';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';

const props = defineProps<{
  view: HostModelDirectoriesView,
  opfsSupported: boolean,
  disabled: boolean,
  mutationDisabled: boolean,
  downloading: boolean,
  layoutFile: Pick<ImageRecipeFile, 'repository' | 'path'> | undefined,
}>();
const id = useId();
const { supported, entries, busy, destination } = props.view;
const selected = computed(() => entries.value.find(entry => entry.id === destination.value));
const missingDestination = computed(() => destination.value !== 'opfs' && selected.value === undefined);
const missingDestinationLabel = computed(() => {
  const folder = lazyStrings.ImageHostModelDirectories__linked_folder();
  const access = lazyStrings.ImageHostModelDirectories__folder_access({ access: 'error' });
  return folder === undefined || access === undefined ? undefined : `${folder} (${destination.value}) · ${access}`;
});
const layout = computed(() => {
  const root = selected.value;
  if (!root) {
    return undefined;
  }
  const segments = props.layoutFile
    ? [...props.layoutFile.repository.split('/'), ...props.layoutFile.path.split('/')]
    : ['owner', 'repository', 'model.gguf'];
  return `${root.name}/\n${segments.map((segment, index) => `${'   '.repeat(index)}└─ ${segment}${index < segments.length - 1 ? '/' : ''}`).join('\n')}`;
});

function selectDestination({ value }: { value: string }): void {
  if (props.disabled || busy.value) {
    return;
  }
  if (value === 'opfs' && !props.opfsSupported) {
    return;
  }
  props.view.selectDestination({ id: value });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="image-host-model-directories" tw-class="border-t border-gray-100 dark:border-gray-800 py-3 space-y-2">
    <div tw-class="flex flex-wrap items-center gap-2">
      <label :for="id + '-destination'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.ImageHostModelDirectories__download_to() }}</label>
      <span tw-class="min-w-0 flex-1"><SettingsFormSelect :id="id + '-destination'" :model-value="destination" :disabled="disabled || busy" @update:model-value="selectDestination({ value: $event })" data-testid="image-download-destination" :label="lazyStrings.ImageHostModelDirectories__download_to()" :options="[...(missingDestination ? [{ value: destination, label: missingDestinationLabel, disabled: true }] : []), { value: 'opfs', label: lazyStrings.ImageHostModelDirectories__browser_storage(), disabled: !opfsSupported }, ...(!entries.length ? [{ value: '', label: lazyStrings.ImageHostModelDirectories__linked_folder(), disabled: true }] : []), ...entries.map(entry => ({ value: entry.id, label: entry.name, disabled: !supported || ['missing', 'error', 'unsupported'].includes(entry.access) }))]" /></span>
    </div>
    <p v-if="!opfsSupported" tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="image-opfs-download-unavailable">{{ lazyStrings.ImageHostModelDirectories__browser_storage_unavailable() }}</p>
    <p v-if="!supported" tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="image-host-folders-unavailable">{{ lazyStrings.ImageHostModelDirectories__linked_folders_unavailable() }}</p>
    <div v-if="selected" tw-class="rounded-lg bg-gray-100/70 dark:bg-gray-900/50 px-3 py-2 space-y-1.5" data-testid="image-host-folder-layout">
      <p tw-class="text-[11px] text-gray-600 dark:text-gray-300">{{ lazyStrings.ImageHostModelDirectories__choose_folder_above_owner() }}</p>
      <pre tw-class="overflow-x-auto text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ layout }}</pre>
      <p v-if="!layoutFile" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageHostModelDirectories__example_folder_layout() }}</p>
    </div>
  </div>
</template>
