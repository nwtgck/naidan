<script setup lang="ts">
import { computed, inject, ref, shallowRef } from 'vue';
import type { WorkflowValue } from '@/01-models/workflow';
import { useImageLibrary, rawConfiguration } from '@/features/image-generation/providers/local-environment';
import { configurationSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';
import { captureWorkflowImageSelection } from '@/features/workflow/logic/image-selection';
import { workflowImageModelSchema, workflowImageLocationLabel } from '@/features/workflow/logic/image-model-schema';
import { workflowImageModelReviewKey } from '@/features/workflow/composables/model-review';
import ImageModelPicker from '@/features/stable-diffusion-cpp-browser/components/ImageModelPicker.vue';
import ImageModelConfiguration from '@/features/stable-diffusion-cpp-browser/components/ImageModelConfiguration.vue';
import ImageLoraControls from '@/features/stable-diffusion-cpp-browser/components/ImageLoraControls.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{ value: WorkflowValue, disabled: boolean }>();
const emit = defineEmits<{ change: [value: WorkflowValue] }>();
const review = inject(workflowImageModelReviewKey, undefined);
const available = configurationSchema.parse(rawConfiguration).kind === 'available';
const library = useImageLibrary({ blocked: () => props.disabled || !available, downloadsBlocked: () => true, onSelection: () => undefined, dependencies: undefined });
const loras = shallowRef<ImageLoraSelection[]>([]);
const failure = ref('');
const selection = computed(() => {
  const value = props.value;
  switch (value.type) {
  case 'literal': return workflowImageModelSchema.safeParse(value.value);
  case 'arithmetic': case 'compare': case 'all': case 'any': case 'not': case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state': case 'array': case 'object': case 'concat': case 'path': case 'get': case 'filename': case 'format_number': case 'equals': case 'not_empty': case 'conversation': case 'range': case 'json_compose': return undefined;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});
const selected = computed(() => selection.value?.success ? selection.value.data : undefined);
const locked = computed(() => props.disabled || !available || library.scanState.value === 'scanning');

async function refresh(): Promise<void> {
  if (locked.value) {
    return;
  }
  failure.value = '';
  const before = props.value;
  await library.refresh();
  if (props.disabled || props.value !== before) {
    return;
  }
  if (selected.value) {
    const restored = library.restoreModelSelection({ selection: selected.value });
    loras.value = restored.loras;
  }
}

function apply(): void {
  if (locked.value) {
    return;
  }
  try {
    const selection = captureWorkflowImageSelection({ library, loras: loras.value });
    emit('change', { type: 'literal', value: selection });
    review?.({ selection });
    failure.value = '';
  } catch (reason) {
    failure.value = reason instanceof Error ? reason.message : String(reason);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3" data-testid="workflow-image-model-editor">
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__image_model_selection_help() }}</p>
    <p v-if="selected" data-testid="workflow-image-current-model" tw-class="text-xs font-mono whitespace-pre-wrap break-all">{{ workflowImageLocationLabel({ location: selected.primary.location }) }}</p>
    <p v-if="!available" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.workflow__local_image_unavailable() }}</p>
    <button type="button" :disabled="locked" @click="refresh" data-testid="workflow-image-refresh" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__refresh_image_models() }}</button>
    <ImageModelPicker :model-value="library.selectedCandidateKey.value" :choices="library.models.value" :required="true" :label="lazyStrings.workflow__model()" :disabled="locked" :active="true" @update:model-value="library.chooseMain({ candidateKey: $event })" data-testid="workflow-image-primary" />
    <ImageModelConfiguration :view="library" :disabled="locked" :active="true" />
    <ImageLoraControls :model-value="loras" :saved="library.savedLoras.value" :disabled="locked" :active="true" sources="library" embedded @update:model-value="loras = $event" />
    <button type="button" :disabled="locked || !library.ready.value" @click="apply" data-testid="workflow-image-apply-model" tw-class="rounded-xl bg-blue-600 px-3 py-2 text-xs text-white disabled:opacity-40">{{ lazyStrings.workflow__apply_image_model_selection() }}</button>
    <p v-if="failure || library.failure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ failure || library.failure.value }}</p>
  </div>
</template>
