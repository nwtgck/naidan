<script setup lang="ts">
import { ref, computed, watch, inject, onBeforeUnmount } from 'vue';
import type { JsonValue } from '@/01-models/lm';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
const props = defineProps<{ value: JsonValue, disabled: boolean, validate?: ({ value }: { value: JsonValue }) => void }>();
const emit = defineEmits<{ change: [value: JsonValue] }>();
const text = ref(JSON.stringify(props.value, null, 2)), error = ref('');
const drafts = inject(workflowInputDraftsKey, undefined);
const owner = Symbol('workflow-json-content');
const locked = computed(() => props.disabled || (drafts?.hasOther({ owner }) ?? false));
let published = JSON.stringify(props.value);

function discard(): void {
  text.value = JSON.stringify(props.value, null, 2);
  error.value = '';
  drafts?.update({ owner, text: undefined, discard });
}

watch(() => props.value, value => {
  if (JSON.stringify(value) !== published && !error.value) {
    text.value = JSON.stringify(value, null, 2);
  }
  published = JSON.stringify(value);
});

function change({ event }: { event: Event }): void {
  if (locked.value || !(event.target instanceof HTMLTextAreaElement)) {
    return;
  }
  text.value = event.target.value;
  try {
    const value = parseWorkflowJson({ text: text.value });
    props.validate?.({ value });
    published = JSON.stringify(value);
    error.value = '';
    drafts?.update({ owner, text: undefined, discard });
    emit('change', value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    drafts?.update({ owner, text: text.value, discard });
  }
}

onBeforeUnmount(() => drafts?.update({ owner, text: undefined, discard }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2">
    <textarea data-testid="workflow-json-content" :value="text" :disabled="locked" :aria-label="lazyStrings.workflow__literal_json()" :aria-invalid="!!error" @input="change({ event: $event })" :rows="Math.min(18, Math.max(4, text.split('\n').length))" spellcheck="false" tw-class="w-full min-w-0 resize-y rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-xs leading-relaxed font-mono text-gray-800 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ error }}</p>
    <button v-if="error" type="button" @click="discard" tw-class="text-xs text-blue-600 dark:text-blue-400 hover:underline">{{ lazyStrings.workflow__discard() }}</button>
  </div>
</template>
