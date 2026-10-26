<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { computed, ref, useId } from 'vue';
import { FolderIcon, FolderPlusIcon, HardDriveIcon } from 'lucide-vue-next';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import SettingsSelect from '@/components/SettingsSelect.vue';
import { hostModelDirectoryLabel } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { lazyStrings } from '@/strings';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';

const props = defineProps<{
  view: HostModelDirectoriesView,
  disabled: boolean,
  layout?: 'toolbar' | 'field',
  layoutFile?: { repository: string, path: string },
}>();
const id = useId();
const managementOpen = ref(false);
const { supported, entries, busy, destination } = props.view;
const unavailableReason = computed(() => !supported.value ? lazyStrings.SHARED__model_folders_linked_folders_unavailable() : undefined);
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

const choices = computed(() => {
  const linkedFolder = lazyStrings.LlamaCppBrowserDownloadDestination__linked_folder();
  return [
    ...(missingDestination.value ? [{
      value: selectedValue.value,
      label: linkedFolder === undefined ? undefined : `${linkedFolder} (${destination.value})`,
      detail: lazyStrings.SHARED__model_folders_folder_access({ access: 'missing' }),
      disabled: true,
    }] : []),
    { value: 'opfs', label: lazyStrings.LlamaCppBrowserDownloadDestination__browser_storage(), detail: undefined, disabled: false },
    ...(!entries.value.length ? [{
      value: '',
      label: linkedFolder,
      detail: supported.value ? lazyStrings.LlamaCppBrowserDownloadDestination__not_linked() : lazyStrings.SHARED__model_import_unavailable(),
      disabled: true,
    }] : []),
    ...entries.value.map(entry => {
      const access = entry.access;
      let detail: string | undefined;
      switch (access) {
      case 'readwrite': break;
      case 'read': case 'prompt': case 'missing': case 'error': case 'unsupported':
        detail = lazyStrings.SHARED__model_folders_folder_access({ access });
        break;
      default: {
        const exhaustive: never = access;
        throw new Error(String(exhaustive));
      }
      }
      return {
        value: hostChoiceValue({ id: entry.id }),
        label: hostModelDirectoryLabel({ id: entry.id, name: entry.name, entries: entries.value }),
        detail,
        disabled: !supported.value || ['missing', 'error', 'unsupported'].includes(access),
      };
    }),
  ];
});
const selectedNeedsAttention = computed(() => destinationKind.value === 'host' && (!supported.value || selected.value?.access !== 'readwrite'));

function selectDestination({ value }: { value: string }): void {
  if (props.disabled || busy.value || !choices.value.some(choice => choice.value === value && !choice.disabled)) {
    return;
  }
  if (value === 'opfs') {
    props.view.selectDestination({ id: 'opfs', kind: 'opfs' });
    return;
  }
  const entry = entries.value.find(entry => hostChoiceValue({ id: entry.id }) === value);
  if (entry) {
    props.view.selectDestination({ id: entry.id, kind: 'host' });
  }
}

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- The containing toolbar is a grid: controls share its heading row, while
       the management panel spans the following row without moving the heading. -->
  <div data-testid="llama-host-model-directories" tw-class="contents">
    <div :tw-class="['flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1', layout === 'field' ? 'w-full' : 'w-fit justify-end justify-self-end sm:col-start-2']">
      <label :for="`${id}-destination`" :tw-class="['shrink-0 whitespace-nowrap font-medium text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-[11px]']">{{ lazyStrings.LlamaCppBrowserDownloadDestination__download_to() }}</label>
      <div :tw-class="['flex min-w-0 max-w-full items-stretch rounded-lg border border-gray-200/80 bg-white/70 dark:border-gray-700/70 dark:bg-gray-800/50', layout === 'field' && 'flex-1']">
        <div :tw-class="['flex min-w-0 max-w-full overflow-hidden rounded-l-lg', layout === 'field' ? 'flex-1' : 'w-40']">
          <SettingsSelect :tw-class="[isSettingsTypography && '[&_.settings-select-value]:text-sm [&_.settings-select-value]:leading-5 dark:[&_.settings-select-value]:text-gray-300']" :id="`${id}-destination`" :model-value="selectedValue" :options="choices" :label="lazyStrings.LlamaCppBrowserDownloadDestination__download_to()" :disabled="disabled || busy" surface="embedded" presentation="toolbar" size="compact" :menu-width-rem="21" data-testid="llama-download-destination" @update:model-value="selectDestination({ value: $event })">
            <template #leading="{ option }"><HardDriveIcon v-if="option?.value === 'opfs'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><FolderIcon v-else aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0', selectedNeedsAttention ? 'text-amber-500 dark:text-amber-400' : 'text-blue-500 dark:text-blue-400']" /></template>
            <template #option="{ option }">
              <span tw-class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-50/70 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><HardDriveIcon v-if="option.value === 'opfs'" aria-hidden="true" tw-class="h-3.5 w-3.5" /><FolderIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" /></span>
              <span tw-class="min-w-0 flex-1"><span :tw-class="['block break-words font-medium leading-5', isSettingsTypography ? 'text-sm' : 'text-xs']">{{ option.label }}</span><span v-if="option.detail" :tw-class="['mt-0.5 block break-words leading-4 text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[11px]']">{{ option.detail }}</span></span>
            </template>
          </SettingsSelect>
        </div>
        <button type="button" :aria-expanded="managementOpen" :aria-controls="`${id}-registrations`" :title="unavailableReason" data-testid="llama-manage-model-directories" :tw-class="[['flex min-h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-r-lg border-l border-gray-200/80 px-2 py-1.5 font-medium text-gray-600 transition-colors duration-200 hover:bg-blue-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:border-gray-700/70 dark:text-gray-300 dark:hover:bg-blue-500/10 motion-reduce:transition-none', isSettingsTypography ? 'text-sm' : 'text-[11px]'], managementOpen && 'bg-blue-50/60 dark:bg-blue-500/10']" @click="managementOpen = !managementOpen"><FolderPlusIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.SHARED__model_import_link_folder() }}</button>
      </div>
    </div>
    <!-- Folder access remains available beside every download selector. Opening
         this panel only reveals controls; linking requires its own action. -->
    <div :id="`${id}-registrations`" class="destination-management" :class="{ 'destination-management-open': managementOpen }" :inert="managementOpen ? undefined : true" :aria-hidden="!managementOpen" data-testid="llama-model-directory-registrations" tw-class="col-span-full min-w-0">
      <div class="destination-management-inner"><LinkedModelDirectories :tw-class="[isSettingsTypography && '[&_.linked-model-directory-caption]:text-xs [&_.linked-model-directory-entry]:text-sm']" :view="view" :disabled="disabled" :layout-file="layoutFile" /></div>
    </div>
  </div>
</template>

<style scoped>
.destination-management {
  /* Let the compact toolbar determine width, even when the retained panel's
     folder names and layout example need more inline space. */
  contain: inline-size;
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 220ms ease, opacity 180ms ease;
}
.destination-management-open {
  grid-template-rows: 1fr;
  opacity: 1;
}
.destination-management-inner {
  min-height: 0;
  overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .destination-management {
    transition: none;
  }
}
</style>
