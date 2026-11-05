<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import { lazyStrings } from '@/strings';
const props = defineProps<{ frame: PreviewFrame | undefined }>();
const url = ref('');

function clear(): void {
  if (url.value) {
    URL.revokeObjectURL(url.value);
    url.value = '';
  }
}

watch(() => props.frame, frame => {
  clear();
  if (frame) {
    try {
      url.value = URL.createObjectURL(frame.png);
    } catch {
      // An optional preview must not fail the generation or replace its output.
      url.value = '';
    }
  }
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(clear);


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
  <section v-if="frame && url" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
    <h3 tw-class="text-sm font-medium">{{ lazyStrings.workflow__live_image_preview() }} · {{ frame.step }}/{{ frame.steps }}</h3>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__preview_notice() }}</p>
    <img :src="url" :alt="lazyStrings.workflow__live_image_preview()" tw-class="max-w-full max-h-80 object-contain rounded-lg" />
  </section>
</template>
