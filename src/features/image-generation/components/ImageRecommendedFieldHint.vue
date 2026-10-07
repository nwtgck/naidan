<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import MessageActionsMenu from '@/components/MessageActionsMenu.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationRecommendation } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { differsFromImageRecommendation, imageRecommendedHint, type ImageRecommendedField } from '@/features/image-generation/recommended-fields';
const props = defineProps<{ recommendation: ImageGenerationRecommendation | undefined, field: ImageRecommendedField, current: unknown, inputId: string, context: string | undefined, disabled: boolean, busy: boolean }>();
const emit = defineEmits<{ apply: [{ field: ImageRecommendedField, recommendationId: ImageGenerationRecommendation['id'], context: string | undefined }] }>();
const open = ref(false), id = useId(), button = ref<HTMLButtonElement | null>(null), action = ref<HTMLButtonElement | null>(null);
const hint = computed(() => props.recommendation && imageRecommendedHint({ recommendation: props.recommendation, field: props.field }));
const different = computed(() => hint.value !== undefined && differsFromImageRecommendation({ current: props.current, hint: hint.value }));
const label = computed(() => {
  const origin = hint.value?.origin;
  switch (origin) {
  case 'recommended': return lazyStrings.imageGeneration__recommended_value();
  case undefined: case 'suggested': return lazyStrings.imageGeneration__suggested_value();
  default: { const exhaustive: never = origin; throw new Error(String(exhaustive)); }
  }
});
const display = computed(() => hint.value?.range ? `${hint.value.range.minimum}–${hint.value.range.maximum}` : String(hint.value?.value ?? ''));
watch(() => [props.context, props.recommendation?.id, props.field, hint.value?.value, props.disabled], () => {
  open.value = false;
}, { flush: 'sync' });
// The trigger's v-if can disappear without unmounting this component. Do not
// resurrect an old popup when the input later differs from the preset again.
watch(different, value => {
  if (!value) open.value = false;
}, { flush: 'sync' });
async function openWithKeyboard(): Promise<void> {
  if (props.disabled) return;
  open.value = true; await nextTick();
  if (open.value) action.value?.focus({ preventScroll: true });
}
async function toggle({ detail }: MouseEvent): Promise<void> {
  if (open.value) {
    open.value = false; return;
  }
  if (detail === 0) await openWithKeyboard();
  else open.value = true;
}
function close(): void {
  open.value = false; button.value?.focus({ preventScroll: true });
}
async function apply(): Promise<void> {
  if (props.disabled || !props.recommendation || !open.value) return;
  emit('apply', { field: props.field, recommendationId: props.recommendation.id, context: props.context });
  open.value = false; await nextTick(); document.getElementById(props.inputId)?.focus({ preventScroll: true });
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <span v-if="different" tw-class="shrink-0 inline-block text-xs font-normal" @keydown.esc.stop.prevent="close">
    <button ref="button" type="button" :disabled="disabled" :aria-expanded="open" :aria-controls="id" aria-haspopup="dialog" @click="toggle" @keydown.down.stop.prevent="openWithKeyboard" data-testid="recommended-field-hint" tw-class="rounded-md px-1.5 py-0.5 text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ label }} {{ display }}</button>
    <MessageActionsMenu v-if="hint" :is-open="open" :trigger-el="button" :width="256" @close="open = false">
      <div :id="id" role="dialog" :aria-label="`${label}: ${String(hint.value)}`" tw-class="p-3 space-y-2 text-xs font-normal" @keydown.esc.stop.prevent="close">
        <span tw-class="block text-gray-600 dark:text-gray-300">{{ lazyStrings.imageGeneration__current_value() }}: {{ String(current) }}</span>
        <span tw-class="block text-gray-600 dark:text-gray-300">{{ label }}: {{ String(hint.value) }} · {{ recommendation?.title }}</span>
        <span v-if="busy" tw-class="block text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__apply_to_next_run() }}</span>
        <button ref="action" type="button" @click="apply" :disabled="disabled" data-testid="recommended-field-apply" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-blue-600 dark:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__apply_this_setting() }}</button>
      </div>
    </MessageActionsMenu>
  </span>
</template>
