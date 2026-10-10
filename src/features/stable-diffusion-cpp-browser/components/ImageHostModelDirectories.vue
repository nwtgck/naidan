<script setup lang="ts">
import { computed, useId } from 'vue';
import { FolderPlusIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { ImageRecipeFile } from '@/features/stable-diffusion-cpp-browser/model-recipes';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';

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
const layout = computed(() => {
  const root = selected.value;
  if (!root) return undefined;
  const segments = props.layoutFile
    ? [...props.layoutFile.repository.split('/'), ...props.layoutFile.path.split('/')]
    : ['owner', 'repository', 'model.gguf'];
  return `${root.name}/\n${segments.map((segment, index) => `${'   '.repeat(index)}└─ ${segment}${index < segments.length - 1 ? '/' : ''}`).join('\n')}`;
});

function selectDestination({ event }: { event: Event }): void {
  if (props.disabled || busy.value || !(event.target instanceof HTMLSelectElement)) return;
  if (event.target.value === 'opfs' && !props.opfsSupported) return;
  props.view.selectDestination({ id: event.target.value });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="image-host-model-directories" tw-class="border-t border-gray-100 dark:border-gray-800 py-3 space-y-2">
    <div tw-class="flex flex-wrap items-center gap-2">
      <label :for="id + '-destination'" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.ImageHostModelDirectories__download_to() }}</label>
      <select :id="id + '-destination'" :value="destination" :disabled="disabled || busy" @change="selectDestination({ event: $event })" data-testid="image-download-destination" tw-class="min-w-0 max-w-full flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-xs text-gray-700 dark:text-gray-200 shadow-sm transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 disabled:cursor-not-allowed">
        <option v-if="missingDestination" :value="destination" disabled data-testid="image-missing-download-destination">{{ lazyStrings.ImageHostModelDirectories__linked_folder() }} ({{ destination }}) · {{ lazyStrings.ImageHostModelDirectories__folder_access({ access: 'error' }) }}</option>
        <option value="opfs" :disabled="!opfsSupported">{{ lazyStrings.ImageHostModelDirectories__browser_storage() }}</option>
        <option v-if="!entries.length" value="" disabled>{{ lazyStrings.ImageHostModelDirectories__linked_folder() }}</option>
        <option v-for="entry in entries" :key="entry.id" :value="entry.id" :disabled="!supported || ['missing', 'error', 'unsupported'].includes(entry.access)">{{ entry.name }}</option>
      </select>
      <button type="button" :disabled="disabled || mutationDisabled || busy || downloading || !supported" @click="view.add()" data-testid="image-add-model-directory" tw-class="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
        <FolderPlusIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />{{ lazyStrings.ImageHostModelDirectories__link_folder() }}
      </button>
    </div>
    <p v-if="!opfsSupported" tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="image-opfs-download-unavailable">{{ lazyStrings.ImageHostModelDirectories__browser_storage_unavailable() }}</p>
    <p v-if="!supported" tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="image-host-folders-unavailable">{{ lazyStrings.ImageHostModelDirectories__linked_folders_unavailable() }}</p>
    <div v-if="selected" tw-class="rounded-lg bg-gray-100/70 dark:bg-gray-900/50 px-3 py-2 space-y-1.5" data-testid="image-host-folder-layout">
      <p tw-class="text-[11px] text-gray-600 dark:text-gray-300">{{ lazyStrings.ImageHostModelDirectories__choose_folder_above_owner() }}</p>
      <pre tw-class="overflow-x-auto text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ layout }}</pre>
      <p v-if="!layoutFile" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageHostModelDirectories__example_folder_layout() }}</p>
    </div>
    <ImageSettingsSection v-if="entries.length" :title="lazyStrings.ImageHostModelDirectories__linked_folders({ count: entries.length })" :summary="undefined" data-testid="image-model-directory-registrations">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageHostModelDirectories__unlink_keeps_files() }}</p>
      <ul tw-class="divide-y divide-gray-100 dark:divide-gray-800">
        <li v-for="entry in entries" :key="entry.id" :data-testid="'image-model-directory-' + entry.id" tw-class="flex flex-wrap items-center gap-2 py-2 text-xs text-gray-600 dark:text-gray-300">
          <div tw-class="min-w-0 flex-1">
            <span tw-class="block break-all font-medium text-gray-700 dark:text-gray-200">{{ entry.name }}</span>
            <span tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageHostModelDirectories__folder_access({ access: entry.access }) }}</span>
            <p v-if="entry.error" tw-class="break-words text-[11px] text-red-600 dark:text-red-400">{{ entry.error }}</p>
          </div>
          <button type="button" :disabled="disabled || mutationDisabled || busy || downloading || !supported" @click="view.reconnect({ id: entry.id })" :data-testid="'image-reconnect-model-directory-' + entry.id" tw-class="inline-flex min-h-9 items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 font-medium text-blue-600 dark:text-blue-400 transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageHostModelDirectories__reconnect() }}</button>
          <!-- Unregister owns cancellation of an in-flight download. It never removes files. -->
          <button type="button" :disabled="disabled || mutationDisabled || busy || !supported" @click="view.remove({ id: entry.id })" :data-testid="'image-unregister-model-directory-' + entry.id" tw-class="inline-flex min-h-9 items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageHostModelDirectories__unlink() }}</button>
        </li>
      </ul>
    </ImageSettingsSection>
  </div>
</template>
