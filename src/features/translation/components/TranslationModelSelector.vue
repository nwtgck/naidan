<script setup lang="ts">
import { computed, defineAsyncComponent, onScopeDispose, ref, shallowRef, watch } from 'vue';
import ModelSelector from '@/components/ModelSelector.vue';
import type { ModelSelectorItem } from '@/components/model-selector-item';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import type { RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { translationModelSuggestions } from '@/features/translation/model-catalog';
import { lazyStrings } from '@/strings';
import { useRepositoryDownloadHint } from '@/composables/useRepositoryDownloadHint';

const RepositoryPicker = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue'));
const FileImport = defineAsyncComponent(() => import('@/components/ModelSelectorFileImport.vue'));

const props = defineProps<{
  modelId: string | undefined,
  disabled: boolean,
  selectionBlocked: boolean,
  pendingModel: RepositoryModelSelection | undefined,
  pendingDestination: string | undefined,
  inventoryEpoch: number,
  trackInventory: boolean,
  acquiring: boolean,
  confirmSelection: ({ modelId }: { modelId: string | undefined }) => Promise<boolean>,
}>();
const emit = defineEmits<{ openChange: [open: boolean], inventoryChanged: [], inventory: [models: readonly LocalModel[]], pendingSelection: [selection: RepositoryModelSelection] }>();
const selector = ref<InstanceType<typeof ModelSelector>>();
const open = ref(false);
const models = shallowRef<readonly LocalModel[]>([]);
const added = shallowRef<readonly LocalModel[]>([]);
const loading = ref(false);
const inventoryFailed = ref(false);
const hideFirstUseDownloadHint = useRepositoryDownloadHint({ selection: computed(() => props.pendingModel), usage: 'translation' });
let scan: AbortController | undefined;

const items = computed<ModelSelectorItem[]>(() => models.value.map(({ modelId }) => ({ id: modelId, label: modelId, description: undefined, availability: 'local' })));
const modelIds = computed(() => models.value.map(model => model.modelId));
const panels = computed(() => [
  { id: 'translation-catalog', label: lazyStrings.translation__candidate_models(), placement: 'before-models' as const },
  { id: 'hugging-face', label: 'Hugging Face' },
  { id: 'files', label: lazyStrings.ModelSelector__add_files() },
]);

async function refreshInventory(): Promise<void> {
  if (!open.value && !props.trackInventory) {
    return;
  }
  scan?.abort();
  const controller = new AbortController();
  scan = controller;
  loading.value = true;
  try {
    const inventory = await listModelInventory({ signal: controller.signal });
    if (!controller.signal.aborted) {
      models.value = inventory;
      inventoryFailed.value = false;
      emit('inventory', inventory);
    }
  } catch {
    if (!controller.signal.aborted) {
      inventoryFailed.value = true;
    }
  } finally {
    if (scan === controller) {
      scan = undefined;
      loading.value = false;
    }
  }
}

function updateOpen({ value }: { value: boolean }): void {
  open.value = value;
  emit('openChange', value);
  if (value) {
    void refreshInventory();
  } else if (!props.trackInventory) {
    scan?.abort();
  }
}

function selectPending({ selection, close }: { selection: RepositoryModelSelection, close: (() => void) | undefined }): void {
  if (!props.disabled && !props.selectionBlocked) {
    emit('pendingSelection', selection);
    close?.();
  }
}

async function confirmFromPanel({ model, close }: { model: LocalModel, close: (() => void) | undefined }): Promise<void> {
  if (await props.confirmSelection({ modelId: model.modelId })) {
    close?.();
  }
}

function closePicker(): void {
  if (open.value) {
    selector.value?.closeDropdown({ restoreFocus: true });
  }
}

function closeFromOutside(): void {
  selector.value?.closeFromOutside();
}

const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({
  listener: () => {
    emit('inventoryChanged');
    void refreshInventory();
  },
});
watch([() => props.trackInventory, () => props.inventoryEpoch], ([tracking]) => {
  if (tracking) {
    void refreshInventory();
  }
}, { immediate: true });
onScopeDispose(() => {
  unsubscribe();
  scan?.abort();
});
defineExpose({ closePicker, closeFromOutside, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ModelSelector
    ref="selector"
    data-testid="translation-model-selector"
    surface="settings"
    trigger-size="compact"
    :model-value="pendingModel?.modelId ?? modelId"
    :selection-availability="pendingModel ? 'download_required' : undefined"
    :hide-first-use-download-hint="acquiring || hideFirstUseDownloadHint"
    :first-use-download-destination="pendingDestination"
    :models="items"
    :models-label="lazyStrings.ModelSelector__models_on_this_device()"
    :placeholder="lazyStrings.ModelSelector__select_a_model()"
    :panels="panels"
    :initial-panel="pendingModel || modelId === undefined ? 'translation-catalog' : undefined"
    :disabled="disabled"
    :confirm-selection="confirmSelection"
    :loading="loading"
    @update:open="updateOpen({ value: $event })"
    @refresh="refreshInventory"
  >
    <template v-if="$slots.status || inventoryFailed" #toolbar>
      <slot name="status" />
      <p v-if="inventoryFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserSavedModelPicker__could_not_read_models() }}</p>
    </template>
    <template #panel="{ panel, active, close, popupTarget }">
      <FileImport
        v-if="panel === 'files'"
        v-model:added="added"
        :available-model-ids="modelIds"
        :selected-model-id="modelId"
        :disabled="!active || disabled || selectionBlocked"
        tw-class="pt-3"
        @choose="model => confirmFromPanel({ model, close })"
        @inventory-changed="refreshInventory"
      />
      <RepositoryPicker
        v-else
        :layout="panel === 'translation-catalog' ? 'candidate-results' : 'inline-results'"
        :suggestions="translationModelSuggestions"
        repository-usage="translation"
        selection-policy="first-use-download"
        :selected-for-first-use="pendingModel"
        :current-model-id="pendingModel ? undefined : modelId"
        :disabled="!active || disabled"
        :selection-blocked="selectionBlocked"
        :popup-target="popupTarget"
        :refresh-inventory="refreshInventory"
        @select-model="(model, presentation) => confirmFromPanel({ model, close: presentation === 'keep-open' ? undefined : close })"
        @select-for-first-use="(selection, presentation) => selectPending({ selection, close: presentation === 'keep-open' ? undefined : close })"
        @close="close()"
      />
    </template>
  </ModelSelector>
</template>
