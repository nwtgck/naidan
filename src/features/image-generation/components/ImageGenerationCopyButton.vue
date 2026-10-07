<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { CheckIcon, CopyIcon, AlertCircleIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
const props = defineProps<{ text: string | undefined, label: string | undefined, showLabel?: boolean }>();
defineOptions({ inheritAttrs: false });
const state = ref<'idle' | 'copying' | 'copied' | 'failed'>('idle');
let epoch = 0, disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.text, () => {
  epoch++; state.value = 'idle'; clearTimeout(timer);
}, { flush: 'sync' });
async function copy(): Promise<void> {
  const text = props.text;
  if (!text || state.value === 'copying') return;
  const token = ++epoch;
  clearTimeout(timer); state.value = 'copying';
  try {
    // Invoke before any other await to keep the user's clipboard activation.
    await navigator.clipboard.writeText(text);
    if (disposed || token !== epoch) return;
    state.value = 'copied';
    timer = setTimeout(() => {
      if (!disposed && token === epoch) state.value = 'idle';
    }, 1800);
  } catch {
    // A permission denial must not escape as an unhandled UI promise, nor
    // show success on a different prompt after the user changed sessions.
    if (!disposed && token === epoch) state.value = 'failed';
  }
}
onScopeDispose(() => {
  disposed = true; epoch++; clearTimeout(timer);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <span tw-class="inline-flex min-w-0 items-center gap-1">
    <button v-bind="$attrs" type="button" @click.stop="copy" :disabled="!text || state === 'copying'" :title="state === 'failed' ? lazyStrings.imageGeneration__copy_failed() : label" :aria-label="label" :tw-class="['shrink-0 inline-flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', state === 'failed' ? 'text-red-600 dark:text-red-400' : state === 'copied' ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400']">
      <CheckIcon v-if="state === 'copied'" aria-hidden="true" tw-class="w-3.5 h-3.5" />
      <AlertCircleIcon v-else-if="state === 'failed'" aria-hidden="true" tw-class="w-3.5 h-3.5" />
      <CopyIcon v-else aria-hidden="true" tw-class="w-3.5 h-3.5" />
      <span v-if="showLabel">{{ state === 'copied' ? lazyStrings.imageGeneration__copied() : label }}</span>
    </button>
    <span role="status" :tw-class="state === 'failed' ? 'max-w-64 text-xs text-red-600 dark:text-red-400' : 'sr-only'">{{ state === 'copied' ? lazyStrings.imageGeneration__copied() : state === 'failed' ? lazyStrings.imageGeneration__copy_failed() : '' }}</span>
  </span>
</template>
