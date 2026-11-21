<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { lazyStrings } from '@/strings';
import { CheckIcon, ChevronDownIcon, CopyIcon } from 'lucide-vue-next';
import SettingsSelect from './SettingsSelect.vue';

const props = defineProps<{
  name: string,
  source: string,
  choices: readonly { id: string, modelId: string, label: string | undefined, title?: string }[],
  selectedId: string | undefined,
  disabled: boolean,
  popupTarget: HTMLElement | undefined,
  highlighted?: boolean,
  index?: number,
  configuration?: { open: boolean, id: string },
}>();
const emit = defineEmits<{ choose: [id: string], changeVariant: [id: string], toggleConfiguration: [{ id: string, event: MouseEvent }] }>();
const ownDetailsOpen = ref(false);
const detailsOpen = computed(() => props.configuration?.open ?? ownDetailsOpen.value);
const detailsId = useId();
const detailsControls = computed(() => [detailsId, props.configuration?.id].filter(Boolean).join(' '));
const detailsLabel = computed(() => props.configuration === undefined ? lazyStrings.ModelSelectorStoredVariantsRow__model_id() : lazyStrings.ModelSelectorRepositoryRow__configuration_for_model({ model: props.name }));
const copyResult = ref<{ modelId: string, status: 'copied' | 'failed' }>();
const selected = computed(() => props.choices.find(choice => choice.id === props.selectedId));
const current = computed(() => selected.value ?? props.choices[0]);
const options = computed(() => props.choices.map(choice => ({ value: choice.id, label: choice.label })));
const canChangeVariant = computed(() => !props.disabled && props.choices.length > 1);

function toggleDetails({ id, event }: { id: string, event: MouseEvent }): void {
  if (props.configuration === undefined) {
    ownDetailsOpen.value = !ownDetailsOpen.value;
  } else {
    emit('toggleConfiguration', { id, event });
  }
}

async function copyModelId(): Promise<void> {
  const modelId = current.value?.modelId;
  if (modelId === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(modelId);
    copyResult.value = { modelId, status: 'copied' };
  } catch {
    copyResult.value = { modelId, status: 'failed' };
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div v-if="current" data-testid="model-selector-stored-variant-group">
    <div :tw-class="['flex min-h-10 min-w-0 items-center gap-1 rounded-lg text-xs transition-colors focus-within:ring-1 focus-within:ring-inset focus-within:ring-gray-300 dark:focus-within:ring-gray-600 motion-reduce:transition-none', current.id === selectedId ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 text-blue-600 dark:bg-gray-700/50 dark:ring-gray-600 dark:text-blue-400' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50', highlighted && 'ring-1 ring-inset ring-gray-300 dark:ring-gray-600']">
      <button type="button" data-testid="model-selector-option" :data-index="index" :title="current.title ?? current.modelId" :aria-pressed="current.id === selectedId" :disabled="disabled" tw-class="min-w-0 flex-1 rounded-lg px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-blue-500" @click="emit('choose', current.id)">
        <span :title="name" data-testid="model-selector-option-name" tw-class="block truncate font-medium">{{ name }}</span>
        <span v-if="source" :title="source" tw-class="mt-0.5 block truncate text-[11px] text-gray-500 dark:text-gray-400">{{ source }}</span>
      </button>
      <SettingsSelect v-if="current.label !== undefined" data-testid="model-selector-stored-variant" :model-value="selected?.id" :placeholder="current.label" :options="options" :disabled="!canChangeVariant" :show-chevron="canChangeVariant" :label="lazyStrings.ModelSelectorStoredVariantsRow__model_configuration()" :popup-target="popupTarget" size="compact" presentation="inline" palette="neutral" tw-class="max-w-[43%] tabular-nums enabled:border-gray-200 enabled:bg-gray-50/80 dark:enabled:border-gray-600/70 dark:enabled:bg-gray-700/40 disabled:cursor-default" @update:model-value="emit('changeVariant', $event)" />
      <slot name="actions" :id="current.id" />
      <button type="button" :aria-expanded="detailsOpen" :aria-controls="detailsOpen ? detailsControls : undefined" :aria-label="detailsLabel" :title="detailsLabel" data-testid="model-selector-stored-variant-details" tw-class="mr-1 grid size-8 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-gray-200/60 focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-[-2px] dark:hover:bg-gray-700" @click="toggleDetails({ id: current.id, event: $event })">
        <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 transition-transform motion-reduce:transition-none', detailsOpen && 'rotate-180']" />
      </button>
    </div>
    <div v-if="detailsOpen" :id="detailsId" tw-class="flex min-w-0 items-start gap-2 px-2 pt-1 pb-2">
      <code tw-class="min-w-0 flex-1 break-all py-1.5 text-[11px] text-gray-500 dark:text-gray-400">{{ current.modelId }}</code>
      <button type="button" :aria-label="lazyStrings.ModelSelectorStoredVariantsRow__copy_model_id()" :title="lazyStrings.ModelSelectorStoredVariantsRow__copy_model_id()" data-testid="model-selector-copy-model-id" tw-class="grid size-7 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-700" @click="copyModelId">
        <CheckIcon v-if="copyResult?.modelId === current.modelId && copyResult.status === 'copied'" aria-hidden="true" tw-class="size-3.5" />
        <CopyIcon v-else aria-hidden="true" tw-class="size-3.5" />
      </button>
    </div>
    <p v-if="detailsOpen && copyResult?.modelId === current.modelId" role="status" tw-class="px-2 pb-2 text-[11px] text-gray-500 dark:text-gray-400">
      {{ copyResult.status === 'copied' ? lazyStrings.ModelSelectorStoredVariantsRow__model_id_copied() : lazyStrings.ModelSelectorStoredVariantsRow__could_not_copy_model_id() }}
    </p>
  </div>
</template>
