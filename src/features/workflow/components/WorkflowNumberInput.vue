<script setup lang="ts">
import { ref, watch, inject, computed, onBeforeUnmount } from 'vue';
import { workflowInputDraftsKey } from '@/features/workflow/composables/input-drafts';
import { lazyStrings } from '@/strings';
const props = defineProps<{ value: number, disabled: boolean, label?: string }>();
const emit = defineEmits<{ change: [value: number] }>();
const text = ref(String(props.value)), invalid = ref(false);
const drafts = inject(workflowInputDraftsKey, undefined), owner = Symbol('workflow-number');
const locked = computed(() => props.disabled || (drafts?.hasOther({ owner }) ?? false));

function discard(): void {
  text.value = String(props.value);
  invalid.value = false;
  drafts?.update({ owner, text: undefined, discard });
}

watch(() => props.value, value => {
  if (!invalid.value) {
    text.value = String(value);
  }
});

function input({ event }: { event: Event }): void {
  if (locked.value || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  text.value = event.target.value;
  const value = Number(text.value);
  invalid.value = !text.value.trim() || !Number.isFinite(value);
  drafts?.update({ owner, text: invalid.value ? text.value : undefined, discard });
  if (!invalid.value) {
    emit('change', value);
  }
}

onBeforeUnmount(() => drafts?.update({ owner, text: undefined, discard }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-1">
    <input :value="text" :disabled="locked" :aria-label="label ?? lazyStrings.workflow__number()" :aria-invalid="invalid" inputmode="decimal" @input="input({ event: $event })" tw-class="w-full min-w-0 rounded-xl border border-gray-200/80 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors disabled:opacity-45" />
    <p v-if="invalid" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.workflow__incompatible_value() }}</p>
    <button v-if="invalid" type="button" @click="discard" tw-class="text-xs text-blue-600 dark:text-blue-400 hover:underline">{{ lazyStrings.workflow__discard() }}</button>
  </div>
</template>
