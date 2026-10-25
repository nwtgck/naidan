<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangleIcon, DatabaseIcon, HardDriveIcon, ListTreeIcon, Loader2Icon, Trash2Icon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';
import {
  DATA_DELETION_OPTIONS,
  FACTORY_RESET_OPTION_IDS,
  createDataDeletionPreview,
  executeDataDeletion,
  getDataDeletionOptionSupport,
  getVisibleDataDeletionOptions,
  groupDataDeletionOptions,
  type DataDeletionGroup,
  type DataDeletionOptionSupport,
  type DataDeletionPreview,
} from '@/features/data-deletion/logic/data-deletion';

const props = defineProps<{
  storageType: string,
  reloadPage?: () => void,
}>();

const { showConfirm } = useConfirm();
const router = useRouter();
const advancedMode = ref(false);
const selectedOptionIds = ref<Set<string>>(new Set());
const preview = ref<DataDeletionPreview>({
  status: 'empty',
  entries: [],
  notes: [],
});
const previewStatus = ref<'idle' | 'scanning' | 'ready' | 'failed'>('idle');
const previewErrorMessage = ref<string | undefined>(undefined);
const executionMessage = ref<string | undefined>(undefined);
let previewRequestToken = 0;

const visibleGroups = computed(() => groupDataDeletionOptions({
  options: getVisibleDataDeletionOptions({ advancedMode: advancedMode.value }),
}));
const optionSupportById = computed<ReadonlyMap<string, DataDeletionOptionSupport>>(() => new Map(DATA_DELETION_OPTIONS.map(option => [
  option.id,
  getDataDeletionOptionSupport({ option }),
])));

const canDeleteSelectedData = computed(() => selectedOptionIds.value.size > 0);

function getGroupLabel({ group }: { group: DataDeletionGroup }): string {
  switch (group) {
  case 'localStorage':
    return 'Local Storage';
  case 'opfs':
    return 'OPFS';
  case 'indexedDb':
    return 'IndexedDB';
  case 'cacheStorage':
    return 'Cache Storage';
  default: {
    const _ex: never = group;
    return _ex;
  }
  }
}

function getGroupMeta({ group }: { group: DataDeletionGroup }): string {
  switch (group) {
  case 'localStorage':
    return 'prefix / key selectors';
  case 'opfs':
    return 'directory / file selectors';
  case 'indexedDb':
    return 'database selectors';
  case 'cacheStorage':
    return 'cache selectors';
  default: {
    const _ex: never = group;
    return _ex;
  }
  }
}

function isSelected({ id }: { id: string }): boolean {
  return selectedOptionIds.value.has(id);
}

function getOptionSupport({ id }: { id: string }): DataDeletionOptionSupport {
  return optionSupportById.value.get(id) ?? { status: 'available' };
}

function isOptionUnsupported({ id }: { id: string }): boolean {
  return getOptionSupport({ id }).status === 'unavailable';
}

function getOptionSupportMessage({ id }: { id: string }): string | undefined {
  const support = getOptionSupport({ id });
  switch (support.status) {
  case 'available':
    return undefined;
  case 'unavailable':
    return support.message;
  default: {
    const _ex: never = support;
    return _ex;
  }
  }
}

function setOptionSelected({ id, selected }: { id: string, selected: boolean }): void {
  const next = new Set(selectedOptionIds.value);
  if (selected) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selectedOptionIds.value = next;
}

function handleOptionToggle({ id, event }: { id: string, event: Event }): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  setOptionSelected({ id, selected: target.checked });
}

function handleGroupSelectionToggle({ group, event }: { group: DataDeletionGroup, event: Event }): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  // Select only the currently visible options. Hidden advanced selectors must
  // never become selected through a normal-mode group action.
  const options = visibleGroups.value.find(visibleGroup => visibleGroup.group === group)?.options;
  if (options === undefined) {
    return;
  }
  const next = new Set(selectedOptionIds.value);
  for (const option of options) {
    if (target.checked) {
      next.add(option.id);
    } else {
      next.delete(option.id);
    }
  }
  selectedOptionIds.value = next;
}

function applyFactoryResetPreset(): void {
  selectedOptionIds.value = new Set(FACTORY_RESET_OPTION_IDS);
}

function clearAllSelections(): void {
  selectedOptionIds.value = new Set();
}

async function refreshPreview(): Promise<void> {
  const requestToken = previewRequestToken + 1;
  previewRequestToken = requestToken;
  previewStatus.value = 'scanning';
  previewErrorMessage.value = undefined;

  try {
    const nextPreview = await createDataDeletionPreview({
      selectedOptionIds: selectedOptionIds.value,
    });
    if (previewRequestToken !== requestToken) {
      return;
    }
    preview.value = nextPreview;
    previewStatus.value = 'ready';
  } catch (error) {
    if (previewRequestToken !== requestToken) {
      return;
    }
    previewStatus.value = 'failed';
    previewErrorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function handleDeleteSelectedData(): Promise<void> {
  executionMessage.value = undefined;
  if (selectedOptionIds.value.size === 0) {
    executionMessage.value = await ensureStrings.dataDeletion__select_at_least_one_deletion_selector();
    return;
  }

  const confirmed = await showConfirm({
    title: await ensureStrings.dataDeletion__delete_selected_data_question(),
    message: await ensureStrings.dataDeletion__delete_data_matched_by_selected_selectors({
      selectedCount: selectedOptionIds.value.size,
      storageType: props.storageType,
    }),
    confirmButtonText: await ensureStrings.dataDeletion__delete_selected_data(),
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) {
    return;
  }

  const result = await executeDataDeletion({
    selectedOptionIds: selectedOptionIds.value,
  });
  if (result.failedSelectors.length > 0) {
    executionMessage.value = result.failedSelectors
      .map(failure => `${failure.label}: ${failure.message}`)
      .join('\n');
    await refreshPreview();
    return;
  }

  try {
    await router.replace('/');
  } catch {
    window.location.hash = '#/';
  }
  if (props.reloadPage !== undefined) {
    props.reloadPage();
    return;
  }
  window.location.reload();
}

watch(selectedOptionIds, () => {
  void refreshPreview();
});

onMounted(() => {
  void refreshPreview();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      DATA_DELETION_OPTIONS,
      FACTORY_RESET_OPTION_IDS,
      applyFactoryResetPreset,
      selectedOptionIds,
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800">
    <h3 tw-class="text-sm font-medium text-red-600 dark:text-red-400">{{ lazyStrings.DeveloperTab__danger_zone() }}</h3>

    <div tw-class="space-y-4 rounded-xl border border-red-100 bg-red-50/30 p-4 dark:border-red-900/20 dark:bg-red-900/5">
      <div tw-class="flex items-start gap-3">
        <AlertTriangleIcon aria-hidden="true" tw-class="mt-0.5 h-5 w-5 shrink-0 text-red-500 dark:text-red-400" />
        <div tw-class="min-w-0">
          <h4 tw-class="text-sm font-semibold text-red-800 dark:text-red-400">{{ lazyStrings.dataDeletion__delete_application_data() }}</h4>
          <p tw-class="mt-1 text-xs leading-relaxed text-red-700/80 dark:text-red-300/70">
            {{ lazyStrings.dataDeletion__choose_a_preset_or_select_items_individually() }}
          </p>
        </div>
      </div>

      <div tw-class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] gap-4">
        <div tw-class="space-y-4 min-w-0">
          <fieldset tw-class="flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg border border-red-100 bg-white/70 p-3 dark:border-red-900/20 dark:bg-gray-900/40">
            <legend tw-class="px-1 text-[11px] font-semibold text-red-800 dark:text-red-300">{{ lazyStrings.dataDeletion__selection_presets() }}</legend>
            <ActionButton
              :disabled="false"
              appearance="primary"
              icon-tone="red"
              @click="applyFactoryResetPreset"
              data-testid="data-deletion-factory-reset-preset-button"
            >
              <ListTreeIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
              {{ lazyStrings.dataDeletion__select_factory_reset_items() }}
            </ActionButton>
            <ActionButton
              :icon-tone="undefined"
              :disabled="!canDeleteSelectedData"
              appearance="secondary"
              @click="clearAllSelections"
              data-testid="data-deletion-clear-all-selections-button"
            >
              {{ lazyStrings.dataDeletion__clear_all_selections() }}
            </ActionButton>
            <label tw-class="inline-flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300 sm:ml-auto">
              <SettingsChoiceControl presentation="checkbox" tone="red">
                <input v-model="advancedMode" type="checkbox" data-testid="data-deletion-advanced-mode-checkbox">
              </SettingsChoiceControl>
              <span>{{ lazyStrings.dataDeletion__advanced_mode() }}</span>
            </label>
          </fieldset>

          <section
            v-for="group in visibleGroups"
            :key="group.group"
            tw-class="overflow-hidden rounded-lg border border-red-100 dark:border-red-900/20 bg-white/80 dark:bg-gray-900/40"
          >
            <div tw-class="flex flex-wrap items-center justify-between gap-3 border-b border-red-100 dark:border-red-900/20 bg-red-50/40 dark:bg-red-900/10 px-3 py-2.5">
              <div tw-class="flex items-center gap-2 min-w-0">
                <DatabaseIcon v-if="group.group === 'indexedDb'" tw-class="w-4 h-4 text-red-500 shrink-0" />
                <HardDriveIcon v-else-if="group.group === 'opfs'" tw-class="w-4 h-4 text-red-500 shrink-0" />
                <ListTreeIcon v-else tw-class="w-4 h-4 text-red-500 shrink-0" />
                <h5 tw-class="truncate text-xs font-medium text-red-800 dark:text-red-300">
                  {{ getGroupLabel({ group: group.group }) }}
                </h5>
              </div>
              <div tw-class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                <span tw-class="text-[10px] font-medium text-red-500/70 dark:text-red-300/60">{{ getGroupMeta({ group: group.group }) }}</span>
                <label tw-class="inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-red-700 dark:text-red-300">
                  <SettingsChoiceControl presentation="checkbox" tone="red">
                    <input
                      type="checkbox"
                      :checked="group.options.every(option => isSelected({ id: option.id }))"
                      :indeterminate="group.options.some(option => isSelected({ id: option.id })) && !group.options.every(option => isSelected({ id: option.id }))"
                      :data-testid="`data-deletion-group-select-all-${group.group}`"
                      @change="handleGroupSelectionToggle({ group: group.group, event: $event })"
                    >
                  </SettingsChoiceControl>
                  {{ lazyStrings.dataDeletion__select_all() }}
                </label>
              </div>
            </div>

            <div tw-class="divide-y divide-red-100 dark:divide-red-900/20">
              <label
                v-for="option in group.options"
                :key="option.id"
                tw-class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2.5 transition-colors hover:bg-red-50/30 dark:hover:bg-red-900/5"
                :data-testid="`data-deletion-option-${option.id}`"
              >
                <SettingsChoiceControl presentation="checkbox" tone="red" tw-class="mt-0.5">
                  <input
                    type="checkbox"
                    :checked="isSelected({ id: option.id })"
                    :data-testid="`data-deletion-checkbox-${option.id}`"
                    @change="handleOptionToggle({ id: option.id, event: $event })"
                  >
                </SettingsChoiceControl>
                <span tw-class="min-w-0">
                  <span tw-class="block font-mono text-xs font-medium text-gray-800 dark:text-gray-100 break-words">
                    {{ option.label }}
                  </span>
                  <span tw-class="mt-0.5 block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                    {{ option.description }}
                  </span>
                  <span
                    v-if="isOptionUnsupported({ id: option.id })"
                    tw-class="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300"
                    :title="getOptionSupportMessage({ id: option.id })"
                    :data-testid="`data-deletion-option-warning-${option.id}`"
                  >
                    <AlertTriangleIcon tw-class="w-3 h-3" />
                    {{ lazyStrings.dataDeletion__not_available_in_this_runtime() }}
                  </span>
                </span>
                <span
                  v-if="option.advanced"
                  tw-class="mt-0.5 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[9px] font-medium text-gray-400 dark:text-gray-500"
                >
                  Advanced
                </span>
              </label>
            </div>
          </section>
        </div>

        <aside tw-class="space-y-3 min-w-0">
          <ActionButton
            :icon-tone="undefined"
            :disabled="!canDeleteSelectedData"
            appearance="danger-filled"
            @click="handleDeleteSelectedData"
            tw-class="w-full"
            data-testid="setting-reset-data-button"
          >
            <Trash2Icon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
            {{ lazyStrings.dataDeletion__delete_selected_data_and_reload() }}
          </ActionButton>

          <div v-if="executionMessage" role="alert" tw-class="whitespace-pre-wrap rounded-lg border border-red-100 dark:border-red-900/20 bg-red-50 dark:bg-red-900/10 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:text-red-300">
            {{ executionMessage }}
          </div>

          <div tw-class="rounded-lg border border-red-100 dark:border-red-900/20 bg-white/80 dark:bg-gray-900/40 overflow-hidden" data-testid="data-deletion-preview-panel">
            <div tw-class="border-b border-red-100 dark:border-red-900/20 bg-red-50/40 dark:bg-red-900/10 px-3 py-2.5">
              <h5 tw-class="text-xs font-semibold text-red-800 dark:text-red-300">{{ lazyStrings.dataDeletion__deletion_preview() }}</h5>
              <p tw-class="mt-1 text-[11px] leading-relaxed text-red-700/80 dark:text-red-300/70">
                {{ lazyStrings.dataDeletion__checked_selectors_matching_entries() }}
              </p>
            </div>

            <div tw-class="space-y-3 p-3">
              <div tw-class="space-y-2" aria-live="polite" :aria-busy="previewStatus === 'scanning'">
                <h6 tw-class="text-[11px] font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.dataDeletion__preview_entries() }}</h6>
                <div v-if="previewStatus === 'scanning'" tw-class="flex items-center gap-2 py-2 text-xs text-gray-500 dark:text-gray-400">
                  <Loader2Icon class="data-deletion-spinner" aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
                  <span>{{ lazyStrings.dataDeletion__scanning_storage() }}</span>
                </div>
                <div v-else-if="previewErrorMessage" role="alert" tw-class="whitespace-pre-wrap rounded-lg border border-red-100 dark:border-red-900/20 bg-red-50 dark:bg-red-900/10 px-3 py-2.5 text-xs leading-relaxed text-red-700 dark:text-red-300">
                  {{ previewErrorMessage }}
                </div>
                <div v-else-if="preview.entries.length === 0" tw-class="py-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {{ lazyStrings.dataDeletion__no_matching_entries() }}
                </div>
                <ul v-else tw-class="max-h-96 divide-y divide-red-100 overflow-auto dark:divide-red-900/20">
                  <li
                    v-for="entry in preview.entries"
                    :key="`${entry.location}:${entry.path}`"
                    tw-class="py-2"
                  >
                    <div tw-class="break-all font-mono text-[11px] text-gray-800 dark:text-gray-100">{{ entry.path }}</div>
                    <div tw-class="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                      {{ entry.location }}
                    </div>
                  </li>
                </ul>
              </div>

              <div v-if="preview.notes.length > 0" tw-class="space-y-2 border-t border-red-100 pt-3 dark:border-red-900/20">
                <div
                  v-for="note in preview.notes"
                  :key="note"
                  tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400"
                >
                  {{ note }}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.data-deletion-spinner {
  animation: data-deletion-spin 0.9s linear infinite;
}

@keyframes data-deletion-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .data-deletion-spinner {
    animation: none;
  }
}
</style>
