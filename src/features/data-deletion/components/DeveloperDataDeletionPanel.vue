<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangleIcon, DatabaseIcon, HardDriveIcon, ListTreeIcon, Loader2Icon, Trash2Icon } from 'lucide-vue-next';
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
  if (!(target instanceof HTMLInputElement)) return;
  setOptionSelected({ id, selected: target.checked });
}

function applyFactoryResetPreset(): void {
  selectedOptionIds.value = new Set(FACTORY_RESET_OPTION_IDS);
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
    if (previewRequestToken !== requestToken) return;
    preview.value = nextPreview;
    previewStatus.value = 'ready';
  } catch (error) {
    if (previewRequestToken !== requestToken) return;
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
  if (!confirmed) return;

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
  <div tw-class="pt-8 border-t border-gray-100 dark:border-gray-800 space-y-5">
    <h3 tw-class="text-sm font-bold text-red-500 uppercase tracking-widest ml-1">{{ lazyStrings.DeveloperTab__danger_zone() }}</h3>

    <div tw-class="p-5 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-5">
      <div tw-class="flex items-start gap-3">
        <div tw-class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-100 dark:border-red-900/20">
          <AlertTriangleIcon tw-class="w-6 h-6 text-red-500 shrink-0" />
        </div>
        <div tw-class="min-w-0">
          <h4 tw-class="font-bold text-red-800 dark:text-red-400 text-sm">{{ lazyStrings.dataDeletion__delete_application_data() }}</h4>
          <p tw-class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
            {{ lazyStrings.dataDeletion__developer_focused_deletion_controls_for_naidan_storage_selectors() }}
          </p>
        </div>
      </div>

      <div tw-class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] gap-4">
        <div tw-class="space-y-4 min-w-0">
          <div tw-class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-3 rounded-2xl border border-red-100 dark:border-red-900/20 bg-white/70 dark:bg-gray-900/40">
            <button
              type="button"
              @click="applyFactoryResetPreset"
              tw-class="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-700 shadow-sm transition-all hover:bg-red-50 active:scale-95 dark:border-red-900/30 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-red-900/10"
              data-testid="data-deletion-factory-reset-preset-button"
            >
              <Trash2Icon tw-class="w-4 h-4" />
              {{ lazyStrings.dataDeletion__factory_reset() }}
            </button>

            <label tw-class="inline-flex items-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-300 select-none">
              <input
                v-model="advancedMode"
                type="checkbox"
                tw-class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                data-testid="data-deletion-advanced-mode-checkbox"
              >
              <span>{{ lazyStrings.dataDeletion__advanced_mode() }}</span>
            </label>
          </div>

          <section
            v-for="group in visibleGroups"
            :key="group.group"
            tw-class="overflow-hidden rounded-2xl border border-red-100 dark:border-red-900/20 bg-white/80 dark:bg-gray-900/40"
          >
            <div tw-class="flex items-center justify-between gap-3 border-b border-red-100 dark:border-red-900/20 bg-red-50/40 dark:bg-red-900/10 px-4 py-3">
              <div tw-class="flex items-center gap-2 min-w-0">
                <DatabaseIcon v-if="group.group === 'indexedDb'" tw-class="w-4 h-4 text-red-500 shrink-0" />
                <HardDriveIcon v-else-if="group.group === 'opfs'" tw-class="w-4 h-4 text-red-500 shrink-0" />
                <ListTreeIcon v-else tw-class="w-4 h-4 text-red-500 shrink-0" />
                <h5 tw-class="text-xs font-black uppercase tracking-widest text-red-800 dark:text-red-300 truncate">
                  {{ getGroupLabel({ group: group.group }) }}
                </h5>
              </div>
              <span tw-class="text-[10px] font-bold text-red-500/70 dark:text-red-300/60 whitespace-nowrap">
                {{ getGroupMeta({ group: group.group }) }}
              </span>
            </div>

            <div tw-class="divide-y divide-red-100 dark:divide-red-900/20">
              <label
                v-for="option in group.options"
                :key="option.id"
                tw-class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 transition-colors hover:bg-red-50/30 dark:hover:bg-red-900/5"
                :data-testid="`data-deletion-option-${option.id}`"
              >
                <input
                  type="checkbox"
                  :checked="isSelected({ id: option.id })"
                  tw-class="mt-1 w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  :data-testid="`data-deletion-checkbox-${option.id}`"
                  @change="handleOptionToggle({ id: option.id, event: $event })"
                >
                <span tw-class="min-w-0">
                  <span tw-class="block font-mono text-[12px] font-bold text-gray-800 dark:text-gray-100 break-words">
                    {{ option.label }}
                  </span>
                  <span tw-class="mt-0.5 block text-[11px] font-medium text-gray-500 dark:text-gray-400 leading-snug">
                    {{ option.description }}
                  </span>
                  <span
                    v-if="isOptionUnsupported({ id: option.id })"
                    tw-class="mt-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-black text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300"
                    :title="getOptionSupportMessage({ id: option.id })"
                    :data-testid="`data-deletion-option-warning-${option.id}`"
                  >
                    <AlertTriangleIcon tw-class="w-3 h-3" />
                    {{ lazyStrings.dataDeletion__not_available_in_this_runtime() }}
                  </span>
                </span>
                <span
                  v-if="option.advanced"
                  tw-class="mt-0.5 rounded-full border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-gray-400 dark:text-gray-500"
                >
                  Advanced
                </span>
              </label>
            </div>
          </section>
        </div>

        <aside tw-class="space-y-3 min-w-0">
          <button
            type="button"
            :disabled="!canDeleteSelectedData"
            @click="handleDeleteSelectedData"
            tw-class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="setting-reset-data-button"
          >
            <Trash2Icon tw-class="w-4 h-4" />
            {{ lazyStrings.dataDeletion__delete_selected_data_and_reload() }}
          </button>

          <div v-if="executionMessage" tw-class="whitespace-pre-wrap rounded-xl border border-red-100 dark:border-red-900/20 bg-red-50 dark:bg-red-900/10 px-3 py-3 text-xs font-bold text-red-700 dark:text-red-300">
            {{ executionMessage }}
          </div>

          <div tw-class="rounded-2xl border border-red-100 dark:border-red-900/20 bg-white/80 dark:bg-gray-900/40 overflow-hidden" data-testid="data-deletion-preview-panel">
            <div tw-class="border-b border-red-100 dark:border-red-900/20 bg-red-50/40 dark:bg-red-900/10 px-4 py-3">
              <h5 tw-class="text-sm font-black text-red-800 dark:text-red-300">{{ lazyStrings.dataDeletion__deletion_preview() }}</h5>
              <p tw-class="mt-1 text-[11px] font-medium text-red-600/70 dark:text-red-300/60 leading-snug">
                {{ lazyStrings.dataDeletion__checked_selectors_matching_entries() }}
              </p>
            </div>

            <div tw-class="p-4 space-y-4">
              <div tw-class="space-y-2">
                <h6 tw-class="text-[10px] font-black uppercase tracking-widest text-gray-400">{{ lazyStrings.dataDeletion__preview_entries() }}</h6>
                <div v-if="previewStatus === 'scanning'" tw-class="flex items-center gap-3 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 px-3 py-3 text-xs font-bold text-gray-500 dark:text-gray-300">
                  <Loader2Icon class="data-deletion-spinner" tw-class="w-4 h-4 text-red-500" />
                  <span>{{ lazyStrings.dataDeletion__scanning_storage() }}</span>
                </div>
                <div v-else-if="previewErrorMessage" tw-class="whitespace-pre-wrap rounded-xl border border-red-100 dark:border-red-900/20 bg-red-50 dark:bg-red-900/10 px-3 py-3 text-xs font-bold text-red-700 dark:text-red-300">
                  {{ previewErrorMessage }}
                </div>
                <div v-else-if="preview.entries.length === 0" tw-class="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 px-3 py-3 text-xs font-bold text-gray-500">
                  {{ lazyStrings.dataDeletion__no_matching_entries() }}
                </div>
                <ul v-else tw-class="max-h-96 overflow-auto rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-800/60 divide-y divide-gray-100 dark:divide-gray-700">
                  <li
                    v-for="entry in preview.entries"
                    :key="`${entry.location}:${entry.path}`"
                    tw-class="px-3 py-2"
                  >
                    <div tw-class="font-mono text-[11px] font-bold text-gray-800 dark:text-gray-100 break-words">{{ entry.path }}</div>
                    <div tw-class="mt-1 text-[10px] font-bold text-gray-400">
                      {{ entry.location }}
                    </div>
                  </li>
                </ul>
              </div>

              <div v-if="preview.notes.length > 0" tw-class="space-y-1">
                <div
                  v-for="note in preview.notes"
                  :key="note"
                  tw-class="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-[11px] font-medium text-gray-500 dark:text-gray-400"
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
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
